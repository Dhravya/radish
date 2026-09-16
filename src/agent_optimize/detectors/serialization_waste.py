"""Leak detector: latency and serialization waste.

If two spans have no true data dependency but run serially, parallel execution
could reduce latency without changing model selection or output quality.
This detector identifies independent spans that were serialized unnecessarily.
"""

from __future__ import annotations

import uuid

from agent_optimize.detectors.base import BaseDetector
from agent_optimize.models.traces import NormalizedSpan, NormalizedTrace, SpanKind
from agent_optimize.models.waste import ConfidenceLevel, WasteCategory, WasteDetection


class SerializationWasteDetector(BaseDetector):
    name = "serialization_waste"
    version = "0.1.0"
    category = WasteCategory.SERIALIZATION_WASTE

    def detect(self, trace: NormalizedTrace) -> list[WasteDetection]:
        detections: list[WasteDetection] = []

        # Find sibling spans (same parent) that ran serially
        sibling_groups = _group_siblings(trace.spans)

        for parent_id, siblings in sibling_groups.items():
            if len(siblings) < 2:
                continue

            # Sort by start time
            siblings.sort(key=lambda s: s.start_time)

            # Find sequential pairs that don't have a data dependency
            serial_pairs = _find_serial_independent_pairs(siblings)

            if not serial_pairs:
                continue

            # Calculate potential latency savings
            serial_duration = sum(s.duration_ms for s in siblings)
            # If parallelized, duration = max(durations) instead of sum
            parallel_duration = max(s.duration_ms for s in siblings)
            latency_saving_ms = serial_duration - parallel_duration
            latency_saving_pct = (latency_saving_ms / serial_duration * 100) if serial_duration > 0 else 0

            if latency_saving_pct < 15:
                # Less than 15% improvement — not worth flagging
                continue

            detections.append(WasteDetection(
                detection_id=str(uuid.uuid4()),
                trace_id=trace.trace_id,
                category=WasteCategory.SERIALIZATION_WASTE,
                confidence=ConfidenceLevel.MEDIUM,
                span_ids=[s.span_id for s in siblings],
                estimated_waste_cost=0.0,  # Serialization waste is about latency, not cost
                current_cost=0.0,
                projected_cost=0.0,
                savings_pct=0.0,
                title=f"Serialized independent spans under '{parent_id}': {len(serial_pairs)} parallelizable pairs",
                description=(
                    f"{len(siblings)} sibling spans ran serially (total {serial_duration:.0f}ms). "
                    f"If parallelized, estimated duration: {parallel_duration:.0f}ms "
                    f"(~{latency_saving_pct:.0f}% latency reduction). "
                    f"No model change required."
                ),
                evidence=(
                    f"Parent span: {parent_id}. Sibling count: {len(siblings)}. "
                    f"Serial duration: {serial_duration:.0f}ms. "
                    f"Max single span: {parallel_duration:.0f}ms. "
                    f"Parallelizable pairs: {len(serial_pairs)}."
                ),
                recommendation=(
                    "Execute independent spans in parallel. This reduces latency without "
                    "changing model selection or output quality. "
                    f"Expected latency reduction: ~{latency_saving_pct:.0f}%."
                ),
                estimated_quality_impact=0.0,
                estimated_latency_impact_pct=round(-latency_saving_pct, 1),
                quality_risk=ConfidenceLevel.LOW,
                detector_name=self.name,
            ))

        return detections


def _group_siblings(spans: list[NormalizedSpan]) -> dict[str, list[NormalizedSpan]]:
    """Group spans by parent_span_id to find sibling sets."""
    groups: dict[str, list[NormalizedSpan]] = {}
    for span in spans:
        parent = span.parent_span_id or "root"
        groups.setdefault(parent, []).append(span)
    return groups


def _find_serial_independent_pairs(
    siblings: list[NormalizedSpan],
) -> list[tuple[NormalizedSpan, NormalizedSpan]]:
    """Find pairs of sibling spans that ran sequentially but have no declared dependency.

    Two spans are considered serial if one starts after the other ends (or nearly so).
    They are independent if neither declares a dependency on the other.
    """
    pairs: list[tuple[NormalizedSpan, NormalizedSpan]] = []

    for i in range(len(siblings) - 1):
        a = siblings[i]
        b = siblings[i + 1]

        # Check if B started after A ended (serial execution)
        gap_ms = (b.start_time - a.end_time).total_seconds() * 1000
        if gap_ms < -100:
            # Overlapping by more than 100ms — already parallel
            continue

        # Check for declared dependencies
        if b.span_id in a.depends_on or a.span_id in b.depends_on:
            continue

        # These two spans ran serially without a declared dependency
        # Heuristic: skip if they're both model calls to the same model
        # (likely intentionally sequential conversation turns)
        if (
            a.span_kind == SpanKind.MODEL_CALL
            and b.span_kind == SpanKind.MODEL_CALL
            and a.model_call
            and b.model_call
            and a.model_call.model == b.model_call.model
        ):
            continue

        pairs.append((a, b))

    return pairs
