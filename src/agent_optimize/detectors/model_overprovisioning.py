"""Leak detector: model overprovisioning.

Detects when a frontier model is used for tasks that a smaller, cheaper model
could handle at acceptable quality. Classifies workload complexity by token
counts and span characteristics, then flags expensive model calls on low-complexity work.
"""

from __future__ import annotations

import uuid
from typing import Any

from agent_optimize.detectors.base import BaseDetector
from agent_optimize.models.traces import NormalizedTrace, SpanKind
from agent_optimize.models.waste import ConfidenceLevel, WasteCategory, WasteDetection

# Heuristic tier classification based on known model pricing patterns
_FRONTIER_MODELS = {
    "gpt-4o", "gpt-4-turbo", "gpt-4", "o1", "o1-pro",
    "claude-opus-4-20250514", "claude-3-opus",
    "gemini-2.5-pro",
}

_SMALL_MODELS = {
    "gpt-4o-mini", "gpt-3.5-turbo", "o1-mini",
    "claude-haiku-3-20240307", "claude-3-haiku",
    "gemini-2.0-flash", "gemini-1.5-flash",
}

# Simple complexity thresholds
_LOW_COMPLEXITY_MAX_OUTPUT_TOKENS = 500
_LOW_COMPLEXITY_MAX_INPUT_TOKENS = 4000


class ModelOverprovisioningDetector(BaseDetector):
    name = "model_overprovisioning"
    version = "0.1.0"
    category = WasteCategory.MODEL_OVERPROVISIONING

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        super().__init__(config)
        self._quality_tolerance = self._config.get("quality_tolerance", 0.02)

    def detect(self, trace: NormalizedTrace) -> list[WasteDetection]:
        detections: list[WasteDetection] = []

        for span in trace.spans:
            if span.span_kind != SpanKind.MODEL_CALL or not span.model_call:
                continue

            model = span.model_call.model
            if not _is_frontier(model):
                continue

            # Classify complexity based on token usage
            tokens = span.model_call.tokens
            is_low_complexity = (
                tokens.output_tokens <= _LOW_COMPLEXITY_MAX_OUTPUT_TOKENS
                and tokens.input_tokens <= _LOW_COMPLEXITY_MAX_INPUT_TOKENS
            )

            if not is_low_complexity:
                continue

            # Estimate savings: frontier -> small model cost ratio is typically 7-15x
            current_cost = span.cost.total_cost
            estimated_small_cost = current_cost * 0.15  # Conservative estimate
            waste = current_cost - estimated_small_cost

            if waste < 0.0001:
                continue

            detections.append(WasteDetection(
                detection_id=str(uuid.uuid4()),
                trace_id=trace.trace_id,
                category=WasteCategory.MODEL_OVERPROVISIONING,
                confidence=ConfidenceLevel.MEDIUM,
                span_ids=[span.span_id],
                estimated_waste_cost=round(waste, 6),
                current_cost=round(current_cost, 6),
                projected_cost=round(estimated_small_cost, 6),
                savings_pct=round((waste / current_cost) * 100, 1) if current_cost > 0 else 0.0,
                title="Frontier model used for low-complexity call",
                description=(
                    f"Model '{model}' was used for a call with {tokens.input_tokens} input "
                    f"and {tokens.output_tokens} output tokens. A smaller model could likely "
                    f"handle this at ~{round((1 - 0.15) * 100)}% lower cost."
                ),
                evidence=(
                    f"Input tokens: {tokens.input_tokens}, output tokens: {tokens.output_tokens}. "
                    f"Both below low-complexity thresholds ({_LOW_COMPLEXITY_MAX_INPUT_TOKENS} / "
                    f"{_LOW_COMPLEXITY_MAX_OUTPUT_TOKENS})."
                ),
                recommendation=(
                    f"Route low-complexity requests to a smaller model (e.g., gpt-4o-mini, "
                    f"claude-haiku, gemini-flash). Expected quality impact: <{self._quality_tolerance * 100}%."
                ),
                estimated_quality_impact=-0.002,
                quality_risk=ConfidenceLevel.LOW,
                detector_name=self.name,
            ))

        return detections


def _is_frontier(model: str) -> bool:
    """Check if a model name corresponds to a frontier-tier model."""
    model_lower = model.lower()
    return any(f in model_lower for f in _FRONTIER_MODELS)
