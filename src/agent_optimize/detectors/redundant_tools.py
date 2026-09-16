"""Leak detector: redundant tool usage.

Tool calls can be semantically duplicated even when query strings differ.
This detector clusters similar tool calls within a trace using input hashes,
detects repeated retrieval of equivalent information, and attributes both
direct tool cost and downstream LLM-processing cost.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from typing import Any

from agent_optimize.detectors.base import BaseDetector
from agent_optimize.models.traces import NormalizedSpan, NormalizedTrace, SpanKind
from agent_optimize.models.waste import ConfidenceLevel, WasteCategory, WasteDetection


class RedundantToolsDetector(BaseDetector):
    name = "redundant_tools"
    version = "0.1.0"
    category = WasteCategory.REDUNDANT_TOOL_CALLS

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        super().__init__(config)
        self._similarity_threshold = self._config.get("similarity_threshold", 0.85)

    def detect(self, trace: NormalizedTrace) -> list[WasteDetection]:
        detections: list[WasteDetection] = []

        tool_spans = [
            s for s in trace.spans
            if s.span_kind == SpanKind.TOOL_CALL and s.tool_call
        ]

        if len(tool_spans) < 2:
            return []

        # Group by tool name
        by_tool: dict[str, list[NormalizedSpan]] = defaultdict(list)
        for span in tool_spans:
            tool_name = span.tool_call.tool_name if span.tool_call else ""
            by_tool[tool_name].append(span)

        for tool_name, spans in by_tool.items():
            if len(spans) < 2:
                continue

            # Check for exact duplicate inputs (same hash)
            duplicate_groups = self._find_duplicate_inputs(spans)
            for group in duplicate_groups:
                detection = self._build_detection(trace, tool_name, group, exact=True)
                if detection:
                    detections.append(detection)

            # Check for high call count even without exact duplicates
            if len(spans) >= 4 and not duplicate_groups:
                detection = self._flag_excessive_calls(trace, tool_name, spans)
                if detection:
                    detections.append(detection)

        return detections

    def _find_duplicate_inputs(self, spans: list[NormalizedSpan]) -> list[list[NormalizedSpan]]:
        """Group spans by input hash to find exact duplicates."""
        by_hash: dict[str, list[NormalizedSpan]] = defaultdict(list)
        for span in spans:
            h = span.tool_call.tool_input_hash if span.tool_call else None
            if h:
                by_hash[h].append(span)

        return [group for group in by_hash.values() if len(group) > 1]

    def _build_detection(
        self,
        trace: NormalizedTrace,
        tool_name: str,
        duplicates: list[NormalizedSpan],
        exact: bool,
    ) -> WasteDetection | None:
        """Build a detection for a group of redundant tool calls."""
        # First call is necessary, rest are waste
        waste_spans = duplicates[1:]
        direct_tool_cost = sum(s.cost.total_cost for s in waste_spans)

        # Estimate downstream LLM processing cost: the model has to process
        # redundant tool results, expanding context unnecessarily
        estimated_llm_overhead = direct_tool_cost * 2.0  # Rough multiplier

        total_waste = direct_tool_cost + estimated_llm_overhead
        if total_waste < 0.0001:
            return None

        total_cost = sum(s.cost.total_cost for s in duplicates) + estimated_llm_overhead

        return WasteDetection(
            detection_id=str(uuid.uuid4()),
            trace_id=trace.trace_id,
            category=WasteCategory.REDUNDANT_TOOL_CALLS,
            confidence=ConfidenceLevel.HIGH if exact else ConfidenceLevel.MEDIUM,
            span_ids=[s.span_id for s in duplicates],
            estimated_waste_cost=round(total_waste, 6),
            current_cost=round(total_cost, 6),
            projected_cost=round(total_cost - total_waste, 6),
            savings_pct=round((total_waste / total_cost) * 100, 1) if total_cost > 0 else 0.0,
            title=f"Redundant '{tool_name}' calls: {len(duplicates)} calls, {len(waste_spans)} duplicates",
            description=(
                f"Tool '{tool_name}' was called {len(duplicates)} times with "
                f"{'identical' if exact else 'similar'} inputs. "
                f"{len(waste_spans)} calls appear redundant. "
                f"Direct tool waste: ${direct_tool_cost:.4f}, "
                f"estimated LLM processing overhead: ${estimated_llm_overhead:.4f}."
            ),
            evidence=(
                f"Tool: {tool_name}. Total calls: {len(duplicates)}. "
                f"Duplicate input hashes detected: {exact}. "
                f"Span IDs: {[s.span_id for s in duplicates]}."
            ),
            recommendation=(
                f"Cache results for '{tool_name}' calls with identical or equivalent inputs. "
                f"Implement a tool result cache at the agent level to avoid redundant API calls "
                f"and the associated LLM context processing."
            ),
            estimated_quality_impact=0.0,
            quality_risk=ConfidenceLevel.LOW,
            detector_name=self.name,
        )

    def _flag_excessive_calls(
        self,
        trace: NormalizedTrace,
        tool_name: str,
        spans: list[NormalizedSpan],
    ) -> WasteDetection | None:
        """Flag tools called an unusually high number of times even without exact duplicates."""
        # Conservative: only flag if call count is ≥4
        if len(spans) < 4:
            return None

        # Estimate that ~half the calls might be reducible
        redundant_count = len(spans) // 2
        redundant_spans = spans[len(spans) - redundant_count :]
        waste_cost = sum(s.cost.total_cost for s in redundant_spans)
        total_cost = sum(s.cost.total_cost for s in spans)

        if waste_cost < 0.001:
            return None

        return WasteDetection(
            detection_id=str(uuid.uuid4()),
            trace_id=trace.trace_id,
            category=WasteCategory.REDUNDANT_TOOL_CALLS,
            confidence=ConfidenceLevel.LOW,
            span_ids=[s.span_id for s in spans],
            estimated_waste_cost=round(waste_cost, 6),
            current_cost=round(total_cost, 6),
            projected_cost=round(total_cost - waste_cost, 6),
            savings_pct=round((waste_cost / total_cost) * 100, 1) if total_cost > 0 else 0.0,
            title=f"High call volume for tool '{tool_name}': {len(spans)} calls",
            description=(
                f"Tool '{tool_name}' was called {len(spans)} times in a single run. "
                f"Review whether all calls retrieve distinct, necessary information."
            ),
            evidence=f"Tool: {tool_name}. Call count: {len(spans)}.",
            recommendation=(
                f"Review the {len(spans)} calls to '{tool_name}' for semantic overlap. "
                f"Consider batching, caching, or restructuring the agent's retrieval strategy."
            ),
            estimated_quality_impact=0.0,
            quality_risk=ConfidenceLevel.LOW,
            detector_name=self.name,
        )
