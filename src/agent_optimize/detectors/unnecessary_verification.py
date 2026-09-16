"""Leak detector: unnecessary agent or verifier calls.

Multi-agent workflows often contain planner, researcher, critic, verifier, and writer
stages on every request regardless of task risk. This detector identifies verification
and critic spans that are invoked unconditionally and estimates whether they materially
change outcomes enough to justify their cost.
"""

from __future__ import annotations

import uuid
from typing import Any

from agent_optimize.detectors.base import BaseDetector
from agent_optimize.models.traces import NormalizedTrace, SpanKind
from agent_optimize.models.waste import ConfidenceLevel, WasteCategory, WasteDetection


class UnnecessaryVerificationDetector(BaseDetector):
    name = "unnecessary_verification"
    version = "0.1.0"
    category = WasteCategory.UNNECESSARY_VERIFICATION

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        super().__init__(config)
        self._quality_delta_threshold = self._config.get("quality_delta_threshold", 0.005)

    def detect(self, trace: NormalizedTrace) -> list[WasteDetection]:
        detections: list[WasteDetection] = []

        # Find verification/critic spans
        verification_spans = [
            s for s in trace.spans if s.span_kind == SpanKind.VERIFICATION
        ]

        if not verification_spans:
            return []

        # Calculate total trace cost and verification cost
        total_cost = trace.total_cost
        verification_cost = sum(s.cost.total_cost for s in verification_spans)
        verification_pct = (verification_cost / total_cost * 100) if total_cost > 0 else 0.0

        # For single-trace analysis, we can't do full ablation.
        # Instead, flag verifiers that are disproportionately expensive relative to the work.
        # Full ablation analysis requires batch/historical data (detect_batch override).
        if verification_pct < 10:
            # Verification is <10% of cost — probably fine
            return []

        # Flag when verification is a large fraction of cost on what appears to be
        # a straightforward run (few retries, successful outcome)
        is_simple_run = trace.retry_count == 0 and trace.success and trace.model_call_count <= 5

        if not is_simple_run:
            return []

        for span in verification_spans:
            span_cost = span.cost.total_cost
            if span_cost < 0.001:
                continue

            detections.append(WasteDetection(
                detection_id=str(uuid.uuid4()),
                trace_id=trace.trace_id,
                category=WasteCategory.UNNECESSARY_VERIFICATION,
                confidence=ConfidenceLevel.MEDIUM,
                span_ids=[span.span_id],
                estimated_waste_cost=round(span_cost, 6),
                current_cost=round(span_cost, 6),
                projected_cost=0.0,
                savings_pct=100.0,
                title="Verification step on low-risk successful run",
                description=(
                    f"Verification span '{span.name}' cost ${span_cost:.4f} "
                    f"({verification_pct:.1f}% of trace cost) on a simple, successful run "
                    f"with {trace.model_call_count} model calls and 0 retries."
                ),
                evidence=(
                    f"Trace success: {trace.success}, retries: {trace.retry_count}, "
                    f"model calls: {trace.model_call_count}. "
                    f"Verification cost: ${verification_cost:.4f} / ${total_cost:.4f} total."
                ),
                recommendation=(
                    "Invoke verification conditionally — for example, when risk_score > 0.7 "
                    "or confidence < 0.8 — instead of on every request. "
                    "Run ablation analysis across historical traces to confirm whether "
                    "the verifier materially changes outcomes."
                ),
                estimated_quality_impact=-self._quality_delta_threshold,
                quality_risk=ConfidenceLevel.MEDIUM,
                detector_name=self.name,
            ))

        return detections

    def detect_batch(self, traces: list[NormalizedTrace]) -> list[WasteDetection]:
        """Cross-trace ablation analysis: check if verification changes outcomes at scale."""
        detections: list[WasteDetection] = []

        # Single-trace detections first
        for trace in traces:
            detections.extend(self.detect(trace))

        # Batch-level analysis: compute verification stats
        traces_with_verification = [
            t for t in traces
            if any(s.span_kind == SpanKind.VERIFICATION for s in t.spans)
        ]

        if len(traces_with_verification) < 10:
            return detections

        # Compare success rates: runs with vs without verification
        # (Approximate: compare traces that have verification spans vs those that don't)
        with_v = [t for t in traces if any(s.span_kind == SpanKind.VERIFICATION for s in t.spans)]
        without_v = [t for t in traces if not any(s.span_kind == SpanKind.VERIFICATION for s in t.spans)]

        if not without_v:
            return detections

        success_with = sum(1 for t in with_v if t.success) / len(with_v) if with_v else 0
        success_without = sum(1 for t in without_v if t.success) / len(without_v) if without_v else 0

        quality_delta = success_with - success_without

        if abs(quality_delta) < self._quality_delta_threshold:
            total_verification_cost = sum(
                sum(s.cost.total_cost for s in t.spans if s.span_kind == SpanKind.VERIFICATION)
                for t in with_v
            )

            if total_verification_cost > 0.01:
                detections.append(WasteDetection(
                    detection_id=str(uuid.uuid4()),
                    trace_id="batch",
                    category=WasteCategory.UNNECESSARY_VERIFICATION,
                    confidence=ConfidenceLevel.HIGH,
                    estimated_waste_cost=round(total_verification_cost, 4),
                    current_cost=round(total_verification_cost, 4),
                    projected_cost=0.0,
                    savings_pct=100.0,
                    title="Verification has minimal impact on success rate",
                    description=(
                        f"Across {len(traces)} traces, success rate with verification: "
                        f"{success_with:.1%}, without: {success_without:.1%} "
                        f"(delta: {quality_delta:.3%}). Verification costs "
                        f"${total_verification_cost:.2f} across analyzed traces."
                    ),
                    evidence=(
                        f"Traces with verification: {len(with_v)}, without: {len(without_v)}. "
                        f"Quality delta: {quality_delta:.4f} (threshold: {self._quality_delta_threshold})."
                    ),
                    recommendation=(
                        "Verification appears to have minimal impact on outcomes. "
                        "Consider making it conditional on risk score or confidence level."
                    ),
                    estimated_quality_impact=round(quality_delta, 4),
                    quality_risk=ConfidenceLevel.LOW,
                    detector_name=self.name,
                ))

        return detections
