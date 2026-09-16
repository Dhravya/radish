"""Leak detector: retry waste.

Retries are economic behavior, not just reliability behavior. Repeated identical
tool failures generate extra LLM reasoning, context expansion, tool charges, and latency.
This detector identifies retry sequences and computes the cost of failed retries
versus the expected cost of alternative recovery strategies.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from typing import Any

from agent_optimize.detectors.base import BaseDetector
from agent_optimize.models.traces import NormalizedSpan, NormalizedTrace, SpanKind, SpanStatus
from agent_optimize.models.waste import ConfidenceLevel, WasteCategory, WasteDetection


class RetryWasteDetector(BaseDetector):
    name = "retry_waste"
    version = "0.1.0"
    category = WasteCategory.RETRY_WASTE

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        super().__init__(config)
        self._max_retries_before_flag = self._config.get("max_retries_before_flag", 2)

    def detect(self, trace: NormalizedTrace) -> list[WasteDetection]:
        detections: list[WasteDetection] = []

        # Strategy 1: Detect spans explicitly marked as retries
        retry_groups = _group_retries_by_parent(trace.spans)
        for parent_id, retries in retry_groups.items():
            if len(retries) < self._max_retries_before_flag:
                continue

            detection = self._analyze_retry_group(trace, parent_id, retries)
            if detection:
                detections.append(detection)

        # Strategy 2: Detect repeated failed tool calls (same tool, sequential failures)
        tool_failure_sequences = _find_repeated_tool_failures(trace.spans)
        for tool_name, failures in tool_failure_sequences.items():
            if len(failures) < self._max_retries_before_flag:
                continue

            detection = self._analyze_tool_failure_sequence(trace, tool_name, failures)
            if detection:
                detections.append(detection)

        return detections

    def _analyze_retry_group(
        self, trace: NormalizedTrace, parent_id: str, retries: list[NormalizedSpan]
    ) -> WasteDetection | None:
        """Analyze a group of retries stemming from the same parent."""
        failed_retries = [r for r in retries if r.status == SpanStatus.ERROR]
        if not failed_retries:
            return None

        waste_cost = sum(r.cost.total_cost for r in failed_retries)
        total_retry_cost = sum(r.cost.total_cost for r in retries)

        if waste_cost < 0.0001:
            return None

        # Also estimate the LLM reasoning cost between retries
        # (the model calls that happen while the agent decides to retry)
        retry_span_ids = {r.span_id for r in retries}
        reasoning_cost = sum(
            s.cost.total_cost
            for s in trace.spans
            if s.span_kind == SpanKind.MODEL_CALL
            and s.parent_span_id in retry_span_ids
        )
        total_waste = waste_cost + reasoning_cost

        return WasteDetection(
            detection_id=str(uuid.uuid4()),
            trace_id=trace.trace_id,
            category=WasteCategory.RETRY_WASTE,
            confidence=ConfidenceLevel.HIGH,
            span_ids=[r.span_id for r in retries],
            estimated_waste_cost=round(total_waste, 6),
            current_cost=round(total_retry_cost + reasoning_cost, 6),
            projected_cost=round(total_retry_cost - total_waste, 6),
            savings_pct=round((total_waste / (total_retry_cost + reasoning_cost)) * 100, 1)
            if (total_retry_cost + reasoning_cost) > 0
            else 0.0,
            title=f"Excessive retries: {len(failed_retries)} failed attempts",
            description=(
                f"{len(retries)} retries attempted, {len(failed_retries)} failed. "
                f"Failed retries cost ${waste_cost:.4f} in direct execution plus "
                f"${reasoning_cost:.4f} in associated LLM reasoning."
            ),
            evidence=(
                f"Retry group under parent span {parent_id}. "
                f"Total retries: {len(retries)}, failures: {len(failed_retries)}. "
                f"Max retry number: {max(r.retry_number for r in retries)}."
            ),
            recommendation=(
                "Consider a fallback strategy instead of repeated retries. "
                "Historical data suggests fallback tools typically have higher success rates "
                "than retrying the same approach. Implement retry budgets and "
                "early fallback triggers."
            ),
            estimated_quality_impact=0.0,
            quality_risk=ConfidenceLevel.LOW,
            detector_name=self.name,
        )

    def _analyze_tool_failure_sequence(
        self, trace: NormalizedTrace, tool_name: str, failures: list[NormalizedSpan]
    ) -> WasteDetection | None:
        """Analyze a sequence of repeated failures of the same tool."""
        waste_cost = sum(f.cost.total_cost for f in failures[1:])  # First attempt is not waste

        # Estimate associated model call costs between failures
        failure_window_start = failures[0].start_time
        failure_window_end = failures[-1].end_time
        model_cost_in_window = sum(
            s.cost.total_cost
            for s in trace.spans
            if s.span_kind == SpanKind.MODEL_CALL
            and s.start_time >= failure_window_start
            and s.end_time <= failure_window_end
        )
        # Attribute a fraction of the model cost to retry reasoning
        retry_reasoning_cost = model_cost_in_window * 0.5 if len(failures) > 2 else 0.0
        total_waste = waste_cost + retry_reasoning_cost

        if total_waste < 0.0001:
            return None

        total_cost = sum(f.cost.total_cost for f in failures) + retry_reasoning_cost

        return WasteDetection(
            detection_id=str(uuid.uuid4()),
            trace_id=trace.trace_id,
            category=WasteCategory.RETRY_WASTE,
            confidence=ConfidenceLevel.MEDIUM,
            span_ids=[f.span_id for f in failures],
            estimated_waste_cost=round(total_waste, 6),
            current_cost=round(total_cost, 6),
            projected_cost=round(total_cost - total_waste, 6),
            savings_pct=round((total_waste / total_cost) * 100, 1) if total_cost > 0 else 0.0,
            title=f"Repeated failures of tool '{tool_name}'",
            description=(
                f"Tool '{tool_name}' failed {len(failures)} times sequentially. "
                f"After the first failure, subsequent attempts cost ${waste_cost:.4f} "
                f"with an estimated ${retry_reasoning_cost:.4f} in LLM reasoning overhead."
            ),
            evidence=(
                f"Tool: {tool_name}. Sequential failures: {len(failures)}. "
                f"Error span IDs: {[f.span_id for f in failures]}."
            ),
            recommendation=(
                f"Implement a fallback strategy for '{tool_name}' failures. "
                f"After {self._max_retries_before_flag} failures, switch to an alternative "
                f"tool or approach rather than continuing to retry."
            ),
            estimated_quality_impact=0.0,
            quality_risk=ConfidenceLevel.LOW,
            detector_name=self.name,
        )


def _group_retries_by_parent(spans: list[NormalizedSpan]) -> dict[str, list[NormalizedSpan]]:
    """Group retry spans by their original parent span."""
    groups: dict[str, list[NormalizedSpan]] = defaultdict(list)
    for span in spans:
        if span.is_retry and span.retry_of_span_id:
            groups[span.retry_of_span_id].append(span)
        elif span.is_retry and span.parent_span_id:
            groups[span.parent_span_id].append(span)
    return dict(groups)


def _find_repeated_tool_failures(spans: list[NormalizedSpan]) -> dict[str, list[NormalizedSpan]]:
    """Find sequences of the same tool failing consecutively."""
    tool_spans = sorted(
        [s for s in spans if s.span_kind == SpanKind.TOOL_CALL and s.tool_call],
        key=lambda s: s.start_time,
    )

    sequences: dict[str, list[NormalizedSpan]] = defaultdict(list)
    current_tool: str | None = None
    current_failures: list[NormalizedSpan] = []

    for span in tool_spans:
        tool_name = span.tool_call.tool_name if span.tool_call else ""
        is_failure = span.status == SpanStatus.ERROR or (span.tool_call and not span.tool_call.tool_success)

        if is_failure and tool_name == current_tool:
            current_failures.append(span)
        else:
            if current_tool and len(current_failures) >= 2:
                sequences[current_tool] = current_failures
            if is_failure:
                current_tool = tool_name
                current_failures = [span]
            else:
                current_tool = None
                current_failures = []

    # Flush last group
    if current_tool and len(current_failures) >= 2:
        sequences[current_tool] = current_failures

    return dict(sequences)
