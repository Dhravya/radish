"""OTLP HTTP receiver — accepts trace exports and feeds them into the normalization pipeline.

This provides an HTTP endpoint compatible with the OTLP/HTTP protocol so customers can
point their OTel collector (or direct SDK exporter) at AgentOptimize.
"""

from __future__ import annotations

import uuid
from typing import Any

import structlog
from fastapi import APIRouter, Request, Response

from agent_optimize.ingestion.normalizer import TraceNormalizer

logger = structlog.get_logger()

router = APIRouter(prefix="/v1", tags=["otlp"])


def _extract_spans_from_otlp(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Flatten the nested OTLP ExportTraceServiceRequest into a list of span dicts.

    OTLP format:
      resourceSpans[] -> scopeSpans[] -> spans[]

    Each span gets the resource and scope attributes merged in.
    """
    all_spans: list[dict[str, Any]] = []

    for resource_span in payload.get("resourceSpans", []):
        resource_attrs = _flatten_attrs(
            resource_span.get("resource", {}).get("attributes", [])
        )

        for scope_span in resource_span.get("scopeSpans", []):
            scope_attrs = _flatten_attrs(
                scope_span.get("scope", {}).get("attributes", [])
            )

            for span in scope_span.get("spans", []):
                # Merge resource + scope + span attributes
                span_attrs = _flatten_attrs(span.get("attributes", []))
                merged_attrs = {**resource_attrs, **scope_attrs, **span_attrs}

                all_spans.append({
                    "traceId": span.get("traceId", ""),
                    "spanId": span.get("spanId", str(uuid.uuid4())),
                    "parentSpanId": span.get("parentSpanId"),
                    "name": span.get("name", ""),
                    "startTimeUnixNano": _parse_nano(span.get("startTimeUnixNano", 0)),
                    "endTimeUnixNano": _parse_nano(span.get("endTimeUnixNano", 0)),
                    "status": span.get("status", {}),
                    "attributes": merged_attrs,
                })

    return all_spans


def _flatten_attrs(attrs: list[dict[str, Any]] | dict[str, Any]) -> dict[str, Any]:
    """Convert OTel attribute array format [{key, value}] to a flat dict.

    Also handles the case where attributes are already a dict (some SDKs do this).
    """
    if isinstance(attrs, dict):
        return attrs

    result: dict[str, Any] = {}
    for attr in attrs:
        key = attr.get("key", "")
        value_obj = attr.get("value", {})
        if isinstance(value_obj, dict):
            # OTel value types: stringValue, intValue, doubleValue, boolValue, arrayValue
            for vtype in ("stringValue", "intValue", "doubleValue", "boolValue"):
                if vtype in value_obj:
                    result[key] = value_obj[vtype]
                    break
            else:
                # arrayValue or kvlistValue
                if "arrayValue" in value_obj:
                    result[key] = [
                        v.get("stringValue", v) for v in value_obj["arrayValue"].get("values", [])
                    ]
                else:
                    result[key] = value_obj
        else:
            result[key] = value_obj
    return result


def _parse_nano(val: Any) -> int:
    """Parse nanosecond timestamps that may come as strings or ints."""
    try:
        return int(val)
    except (TypeError, ValueError):
        return 0


# ---------------------------------------------------------------------------
# Singleton normalizer instance — injected with app state at startup
# ---------------------------------------------------------------------------

_normalizer = TraceNormalizer(capture_content=False)
_on_trace_callback: Any = None


def set_trace_callback(callback: Any) -> None:
    """Register a callback that receives each NormalizedTrace after ingestion."""
    global _on_trace_callback
    _on_trace_callback = callback


def set_normalizer(normalizer: TraceNormalizer) -> None:
    """Replace the default normalizer (e.g., to enable content capture)."""
    global _normalizer
    _normalizer = normalizer


# ---------------------------------------------------------------------------
# OTLP/HTTP endpoint
# ---------------------------------------------------------------------------


@router.post("/traces")
async def receive_traces(request: Request) -> Response:
    """OTLP/HTTP trace receiver endpoint.

    Accepts ExportTraceServiceRequest in JSON format and normalizes into
    AgentOptimize internal schema.
    """
    try:
        payload = await request.json()
    except Exception:
        logger.warning("otlp_receiver.invalid_json")
        return Response(status_code=400, content='{"error": "invalid JSON"}')

    raw_spans = _extract_spans_from_otlp(payload)
    if not raw_spans:
        return Response(status_code=200, content="{}")

    # Group spans by trace_id
    traces_map: dict[str, list[dict[str, Any]]] = {}
    for span in raw_spans:
        tid = span.get("traceId", "unknown")
        traces_map.setdefault(tid, []).append(span)

    ingested_count = 0
    for trace_id, spans in traces_map.items():
        trace = _normalizer.normalize_trace(spans)
        if trace and _on_trace_callback:
            try:
                await _on_trace_callback(trace)
            except Exception:
                logger.exception("otlp_receiver.callback_error", trace_id=trace_id)
        if trace:
            ingested_count += 1

    logger.info(
        "otlp_receiver.ingested",
        spans=len(raw_spans),
        traces=ingested_count,
    )

    return Response(status_code=200, content="{}")
