"""Leak detector: bad routing.

Detects when all tasks are routed to the same premium model regardless of complexity.
A cost-aware routing policy should match model tier to task difficulty.
This detector identifies traces where a single expensive model handles all calls,
including simple ones that a cheaper model could handle.
"""

from __future__ import annotations

import uuid
from collections import Counter

from agent_optimize.detectors.base import BaseDetector
from agent_optimize.models.traces import NormalizedTrace, SpanKind
from agent_optimize.models.waste import ConfidenceLevel, WasteCategory, WasteDetection

# Models considered "premium" — high cost per token
_PREMIUM_MODELS = {
    "gpt-4o", "gpt-4-turbo", "gpt-4", "o1", "o1-pro",
    "claude-opus-4-20250514", "claude-3-opus", "claude-sonnet-4-20250514",
    "gemini-2.5-pro",
}


class BadRoutingDetector(BaseDetector):
    name = "bad_routing"
    version = "0.1.0"
    category = WasteCategory.BAD_ROUTING

    def detect(self, trace: NormalizedTrace) -> list[WasteDetection]:
        model_spans = [
            s for s in trace.spans if s.span_kind == SpanKind.MODEL_CALL and s.model_call
        ]

        if len(model_spans) < 3:
            return []

        # Count models used
        model_counts = Counter(
            s.model_call.model for s in model_spans if s.model_call
        )

        # Check for single-model anti-pattern
        if len(model_counts) > 1:
            # Already using multiple models — routing exists
            return []

        model_name = next(iter(model_counts.keys()))
        if not _is_premium(model_name):
            # Single model, but it's cheap — no issue
            return []

        # All calls go to a single premium model
        total_cost = sum(s.cost.total_cost for s in model_spans)

        # Estimate how many calls could use a cheaper model
        # (low output token calls are likely simpler tasks)
        simple_spans = [
            s for s in model_spans
            if s.model_call and s.model_call.tokens.output_tokens < 300
        ]
        complex_spans = [
            s for s in model_spans
            if s.model_call and s.model_call.tokens.output_tokens >= 300
        ]

        if len(simple_spans) < 2:
            return []

        simple_cost = sum(s.cost.total_cost for s in simple_spans)
        # A cheaper model would cost roughly 10-15% of the premium model
        projected_simple_cost = simple_cost * 0.12
        waste = simple_cost - projected_simple_cost

        if waste < 0.001:
            return []

        return [WasteDetection(
            detection_id=str(uuid.uuid4()),
            trace_id=trace.trace_id,
            category=WasteCategory.BAD_ROUTING,
            confidence=ConfidenceLevel.MEDIUM,
            span_ids=[s.span_id for s in model_spans],
            estimated_waste_cost=round(waste, 6),
            current_cost=round(total_cost, 6),
            projected_cost=round(total_cost - waste, 6),
            savings_pct=round((waste / total_cost) * 100, 1) if total_cost > 0 else 0.0,
            title=f"All {len(model_spans)} calls routed to premium model '{model_name}'",
            description=(
                f"Every model call in this trace uses '{model_name}'. "
                f"{len(simple_spans)} of {len(model_spans)} calls appear to be low-complexity "
                f"(output < 300 tokens) and could likely use a cheaper model. "
                f"{len(complex_spans)} calls may genuinely require a premium model."
            ),
            evidence=(
                f"Model: {model_name}. Total calls: {len(model_spans)}. "
                f"Low-complexity calls: {len(simple_spans)}. "
                f"Simple call cost: ${simple_cost:.4f} / ${total_cost:.4f} total."
            ),
            recommendation=(
                f"Implement a complexity/risk router: route low-complexity requests to a "
                f"smaller model (e.g., gpt-4o-mini, gemini-flash) and reserve '{model_name}' "
                f"for high-complexity tasks. Expected savings: ~{round((waste / total_cost) * 100)}% "
                f"with minimal quality impact."
            ),
            estimated_quality_impact=-0.002,
            quality_risk=ConfidenceLevel.LOW,
            detector_name=self.name,
        )]

    def detect_batch(self, traces: list[NormalizedTrace]) -> list[WasteDetection]:
        """Cross-trace analysis: identify systematic single-model routing patterns."""
        detections = super().detect_batch(traces)

        # Aggregate: check if the same model dominates across all traces
        all_model_spans = []
        for trace in traces:
            all_model_spans.extend(
                s for s in trace.spans if s.span_kind == SpanKind.MODEL_CALL and s.model_call
            )

        if not all_model_spans:
            return detections

        model_counts = Counter(
            s.model_call.model for s in all_model_spans if s.model_call
        )

        if len(model_counts) <= 1:
            dominant_model = next(iter(model_counts.keys())) if model_counts else "unknown"
            if _is_premium(dominant_model):
                total_cost = sum(s.cost.total_cost for s in all_model_spans)
                estimated_savings = total_cost * 0.30  # Conservative: 30% savings with routing

                if estimated_savings > 0.01:
                    detections.append(WasteDetection(
                        detection_id=str(uuid.uuid4()),
                        trace_id="batch",
                        category=WasteCategory.BAD_ROUTING,
                        confidence=ConfidenceLevel.HIGH,
                        estimated_waste_cost=round(estimated_savings, 4),
                        current_cost=round(total_cost, 4),
                        projected_cost=round(total_cost - estimated_savings, 4),
                        savings_pct=30.0,
                        title=f"Systematic single-model routing to '{dominant_model}'",
                        description=(
                            f"Across {len(traces)} traces, all {len(all_model_spans)} model calls "
                            f"use '{dominant_model}'. Implementing cost-aware routing could save "
                            f"an estimated 30% on model costs."
                        ),
                        evidence=(
                            f"Traces: {len(traces)}. Model calls: {len(all_model_spans)}. "
                            f"Unique models: {list(model_counts.keys())}."
                        ),
                        recommendation=(
                            "Deploy a complexity/risk router that matches model tier to task difficulty. "
                            "Use task class, input complexity, and risk score to route between "
                            "small, medium, and frontier models."
                        ),
                        estimated_quality_impact=-0.005,
                        quality_risk=ConfidenceLevel.MEDIUM,
                        detector_name=self.name,
                    ))

        return detections


def _is_premium(model: str) -> bool:
    model_lower = model.lower()
    return any(p in model_lower for p in _PREMIUM_MODELS)
