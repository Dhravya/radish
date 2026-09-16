"""Normalize raw OTel spans into the AgentOptimize internal schema.

This is the bridge between framework-specific telemetry and our stable analysis models.
Handles GenAI semantic conventions (gen_ai.*), framework detection, and span classification.
"""

from __future__ import annotations

import hashlib
import uuid
from datetime import UTC, datetime
from typing import Any

import structlog

from agent_optimize.models.traces import (
    ModelCallSpan,
    NormalizedSpan,
    NormalizedTrace,
    SpanKind,
    SpanStatus,
    TokenUsage,
    ToolCallSpan,
)

logger = structlog.get_logger()

# ---------------------------------------------------------------------------
# OTel GenAI semantic convention attribute keys
# See: https://opentelemetry.io/docs/specs/semconv/gen-ai/
# ---------------------------------------------------------------------------

_GENAI_SYSTEM = "gen_ai.system"
_GENAI_MODEL = "gen_ai.request.model"
_GENAI_TEMPERATURE = "gen_ai.request.temperature"
_GENAI_MAX_TOKENS = "gen_ai.request.max_tokens"
_GENAI_INPUT_TOKENS = "gen_ai.usage.input_tokens"
_GENAI_OUTPUT_TOKENS = "gen_ai.usage.output_tokens"
_GENAI_STOP_REASON = "gen_ai.response.finish_reasons"
_GENAI_OPERATION = "gen_ai.operation.name"

# Tool-related
_TOOL_NAME = "tool.name"
_TOOL_CALL_ID = "tool.call.id"

# Framework hints
_FRAMEWORK_KEY = "agent.framework"
_AGENT_NAME_KEY = "agent.name"

# Span kind mappings from OTel string values
_SPAN_KIND_MAP: dict[str, SpanKind] = {
    "chat": SpanKind.MODEL_CALL,
    "text_completion": SpanKind.MODEL_CALL,
    "embeddings": SpanKind.MODEL_CALL,
    "tool": SpanKind.TOOL_CALL,
    "function": SpanKind.TOOL_CALL,
    "agent": SpanKind.AGENT_STEP,
    "chain": SpanKind.AGENT_STEP,
    "retrieval": SpanKind.RETRIEVAL,
    "verify": SpanKind.VERIFICATION,
    "plan": SpanKind.PLANNER,
    "handoff": SpanKind.HANDOFF,
}


def _classify_span_kind(attrs: dict[str, Any], span_name: str) -> SpanKind:
    """Determine what kind of work this span represents."""
    # Check explicit gen_ai operation
    op = attrs.get(_GENAI_OPERATION, "")
    if op and op in _SPAN_KIND_MAP:
        return _SPAN_KIND_MAP[op]

    # Check if it has gen_ai model attributes -> model call
    if attrs.get(_GENAI_MODEL):
        return SpanKind.MODEL_CALL

    # Check if it has tool attributes -> tool call
    if attrs.get(_TOOL_NAME):
        return SpanKind.TOOL_CALL

    # Heuristic: name-based classification
    name_lower = span_name.lower()
    for keyword, kind in [
        ("verify", SpanKind.VERIFICATION),
        ("critic", SpanKind.VERIFICATION),
        ("review", SpanKind.VERIFICATION),
        ("plan", SpanKind.PLANNER),
        ("retriev", SpanKind.RETRIEVAL),
        ("search", SpanKind.RETRIEVAL),
        ("tool", SpanKind.TOOL_CALL),
        ("handoff", SpanKind.HANDOFF),
        ("agent", SpanKind.AGENT_STEP),
    ]:
        if keyword in name_lower:
            return kind

    return SpanKind.OTHER


def _detect_framework(attrs: dict[str, Any]) -> str:
    """Try to identify the source agent framework from span attributes."""
    fw = attrs.get(_FRAMEWORK_KEY, "")
    if fw:
        return str(fw)

    system = attrs.get(_GENAI_SYSTEM, "")
    if system:
        return str(system)

    # Check for framework-specific attributes
    for key in attrs:
        if "langchain" in key or "langgraph" in key:
            return "langchain"
        if "crewai" in key:
            return "crewai"
        if "openai.agents" in key:
            return "openai-agents"

    return "unknown"


def _hash_content(content: str | None) -> str | None:
    """SHA-256 hash of content for privacy-safe deduplication detection."""
    if not content:
        return None
    return hashlib.sha256(content.encode()).hexdigest()[:16]


def _to_float(val: Any, default: float = 0.0) -> float:
    try:
        return float(val)
    except (TypeError, ValueError):
        return default


def _to_int(val: Any, default: int = 0) -> int:
    try:
        return int(val)
    except (TypeError, ValueError):
        return default


def _ns_to_datetime(ns: int) -> datetime:
    """Convert nanosecond epoch to datetime."""
    return datetime.fromtimestamp(ns / 1e9, tz=UTC)


class TraceNormalizer:
    """Converts raw OTel span dicts into NormalizedSpan / NormalizedTrace models."""

    def __init__(self, capture_content: bool = False) -> None:
        self._capture_content = capture_content

    def normalize_span(self, raw: dict[str, Any]) -> NormalizedSpan:
        """Normalize a single raw OTel span dict into our internal model."""
        attrs = raw.get("attributes", {})
        span_name = raw.get("name", "")

        span_kind = _classify_span_kind(attrs, span_name)

        # Timestamps
        start_ns = raw.get("start_time_unix_nano", 0) or raw.get("startTimeUnixNano", 0)
        end_ns = raw.get("end_time_unix_nano", 0) or raw.get("endTimeUnixNano", 0)
        start_time = _ns_to_datetime(start_ns) if start_ns else datetime.now(tz=UTC)
        end_time = _ns_to_datetime(end_ns) if end_ns else start_time

        # Status
        raw_status = raw.get("status", {})
        status_code = raw_status.get("code", raw_status.get("statusCode", "UNSET"))
        if isinstance(status_code, int):
            status = {0: SpanStatus.UNSET, 1: SpanStatus.OK, 2: SpanStatus.ERROR}.get(
                status_code, SpanStatus.UNSET
            )
        else:
            status = SpanStatus(str(status_code).lower()) if status_code else SpanStatus.UNSET

        # Build type-specific payloads
        model_call: ModelCallSpan | None = None
        tool_call: ToolCallSpan | None = None

        if span_kind == SpanKind.MODEL_CALL:
            model_call = ModelCallSpan(
                provider=str(attrs.get(_GENAI_SYSTEM, "")),
                model=str(attrs.get(_GENAI_MODEL, "")),
                temperature=_to_float(attrs.get(_GENAI_TEMPERATURE), default=0.0) or None,
                max_tokens=_to_int(attrs.get(_GENAI_MAX_TOKENS)) or None,
                tokens=TokenUsage(
                    input_tokens=_to_int(attrs.get(_GENAI_INPUT_TOKENS)),
                    output_tokens=_to_int(attrs.get(_GENAI_OUTPUT_TOKENS)),
                ),
                stop_reason=str(attrs.get(_GENAI_STOP_REASON, "")) or None,
            )

        if span_kind == SpanKind.TOOL_CALL:
            tool_name = str(attrs.get(_TOOL_NAME, "") or span_name)
            tool_call = ToolCallSpan(
                tool_name=tool_name,
                tool_input_hash=_hash_content(str(attrs.get("tool.input", ""))),
                tool_success=status != SpanStatus.ERROR,
                tool_error=str(attrs.get("exception.message", "")) or None,
            )

        # Retry detection
        is_retry = bool(attrs.get("retry.number", 0))
        retry_number = _to_int(attrs.get("retry.number", 0))

        # Content hashing for privacy-safe deduplication
        input_hash = _hash_content(str(attrs.get("gen_ai.content.prompt", "")))
        output_hash = _hash_content(str(attrs.get("gen_ai.content.completion", "")))

        return NormalizedSpan(
            span_id=raw.get("span_id", raw.get("spanId", str(uuid.uuid4()))),
            trace_id=raw.get("trace_id", raw.get("traceId", "")),
            parent_span_id=raw.get("parent_span_id", raw.get("parentSpanId")),
            span_kind=span_kind,
            name=span_name,
            status=status,
            start_time=start_time,
            end_time=end_time,
            source_framework=_detect_framework(attrs),
            agent_name=str(attrs.get(_AGENT_NAME_KEY, "")) or None,
            model_call=model_call,
            tool_call=tool_call,
            is_retry=is_retry,
            retry_number=retry_number,
            raw_attributes=attrs if self._capture_content else _strip_content(attrs),
            input_content_hash=input_hash,
            output_content_hash=output_hash,
        )

    def normalize_trace(self, raw_spans: list[dict[str, Any]]) -> NormalizedTrace | None:
        """Normalize a list of raw spans belonging to the same trace into a NormalizedTrace."""
        if not raw_spans:
            return None

        spans = [self.normalize_span(raw) for raw in raw_spans]
        trace_id = spans[0].trace_id

        start_time = min(s.start_time for s in spans)
        end_time = max(s.end_time for s in spans)

        # Detect success: if any span has ERROR status, trace is considered failed
        has_error = any(s.status == SpanStatus.ERROR for s in spans)
        error_msg = next(
            (s.raw_attributes.get("exception.message", "") for s in spans if s.status == SpanStatus.ERROR),
            None,
        )

        trace = NormalizedTrace(
            trace_id=trace_id,
            start_time=start_time,
            end_time=end_time,
            spans=spans,
            success=not has_error,
            error_message=str(error_msg) if error_msg else None,
            source_framework=spans[0].source_framework,
        )
        trace.recompute_aggregates()
        return trace


def _strip_content(attrs: dict[str, Any]) -> dict[str, Any]:
    """Remove prompt/completion content from attributes for privacy."""
    sensitive_prefixes = ("gen_ai.content.", "tool.input", "tool.output")
    return {k: v for k, v in attrs.items() if not any(k.startswith(p) for p in sensitive_prefixes)}
