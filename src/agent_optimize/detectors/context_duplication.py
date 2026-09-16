"""Leak detector: context inflation and duplication.

Agent workflows often resend growing histories on every call. This detector
identifies sequences of model calls with monotonically increasing input tokens
and low novelty ratios, estimating how much spend goes to repeated context.
"""

from __future__ import annotations

import uuid
from typing import Any

from agent_optimize.detectors.base import BaseDetector
from agent_optimize.models.traces import NormalizedTrace, SpanKind
from agent_optimize.models.waste import ConfidenceLevel, WasteCategory, WasteDetection


class ContextDuplicationDetector(BaseDetector):
    name = "context_duplication"
    version = "0.1.0"
    category = WasteCategory.CONTEXT_DUPLICATION

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        super().__init__(config)
        self._novelty_threshold = self._config.get("novelty_threshold", 0.30)

    def detect(self, trace: NormalizedTrace) -> list[WasteDetection]:
        # Get model call spans sorted by time
        model_spans = sorted(
            [s for s in trace.spans if s.span_kind == SpanKind.MODEL_CALL and s.model_call],
            key=lambda s: s.start_time,
        )

        if len(model_spans) < 3:
            return []

        # Analyze input token growth pattern
        input_token_sequence = [
            s.model_call.tokens.input_tokens for s in model_spans if s.model_call
        ]

        # Check for monotonically increasing pattern (context accumulation)
        if not _is_growing_sequence(input_token_sequence):
            return []

        # Estimate novelty: what fraction of each subsequent call is actually new?
        total_input = sum(input_token_sequence)
        first_call_tokens = input_token_sequence[0]

        # Rough estimate: if perfectly deduplicated, each call would only send new tokens.
        # The incremental tokens between calls represent actual new context.
        incremental_tokens = sum(
            max(0, input_token_sequence[i] - input_token_sequence[i - 1])
            for i in range(1, len(input_token_sequence))
        )
        estimated_unique_tokens = first_call_tokens + incremental_tokens
        novelty_ratio = estimated_unique_tokens / total_input if total_input > 0 else 1.0

        if novelty_ratio >= self._novelty_threshold:
            return []

        # Compute cost of duplicated context
        duplicate_token_ratio = 1.0 - novelty_ratio
        total_input_cost = sum(s.cost.input_cost for s in model_spans)
        waste_cost = total_input_cost * duplicate_token_ratio

        if waste_cost < 0.001:
            return []

        # Determine confidence based on pattern strength
        confidence = ConfidenceLevel.HIGH if novelty_ratio < 0.20 else ConfidenceLevel.MEDIUM

        span_ids = [s.span_id for s in model_spans]
        growth_factor = round(input_token_sequence[-1] / first_call_tokens, 1) if first_call_tokens > 0 else 0

        return [WasteDetection(
            detection_id=str(uuid.uuid4()),
            trace_id=trace.trace_id,
            category=WasteCategory.CONTEXT_DUPLICATION,
            confidence=confidence,
            span_ids=span_ids,
            estimated_waste_cost=round(waste_cost, 6),
            current_cost=round(total_input_cost, 6),
            projected_cost=round(total_input_cost - waste_cost, 6),
            savings_pct=round(duplicate_token_ratio * 100, 1),
            title="Context inflation detected across model calls",
            description=(
                f"Across {len(model_spans)} model calls, input tokens grew from "
                f"{first_call_tokens:,} to {input_token_sequence[-1]:,} ({growth_factor}x). "
                f"Estimated {round(novelty_ratio * 100, 1)}% useful new context / "
                f"{round(duplicate_token_ratio * 100, 1)}% repeated or low-novelty context."
            ),
            evidence=(
                f"Token sequence: {input_token_sequence}. "
                f"Total input: {total_input:,} tokens. "
                f"Estimated unique: {estimated_unique_tokens:,} tokens. "
                f"Novelty ratio: {round(novelty_ratio, 3)}."
            ),
            recommendation=(
                "Consider summarization, state compression, prompt restructuring, "
                "or provider-side caching to reduce repeated context. "
                f"Potential reduction: {total_input:,} → ~{estimated_unique_tokens:,} total input tokens "
                f"(-{round(duplicate_token_ratio * 100)}%)."
            ),
            estimated_quality_impact=0.0,
            quality_risk=ConfidenceLevel.LOW,
            detector_name=self.name,
        )]


def _is_growing_sequence(seq: list[int], tolerance: int = 2) -> bool:
    """Check if a sequence is mostly monotonically increasing.

    Allows a few dips (tolerance) to handle minor variations.
    """
    if len(seq) < 3:
        return False
    decreases = sum(1 for i in range(1, len(seq)) if seq[i] < seq[i - 1])
    return decreases <= tolerance and seq[-1] > seq[0] * 1.5
