"""Cost analyzer — attributes costs to spans and computes run-level cost metrics.

This is the first analysis pass after ingestion: every span gets a dollar cost,
and every trace gets total/per-component cost attribution.
"""

from __future__ import annotations

import structlog

from agent_optimize.cost.catalog import CostCatalog
from agent_optimize.models.traces import NormalizedTrace, SpanKind

logger = structlog.get_logger()


class CostAnalyzer:
    """Attributes dollar costs to every span in a trace using the cost catalog."""

    def __init__(self, catalog: CostCatalog) -> None:
        self._catalog = catalog

    def analyze_trace(self, trace: NormalizedTrace) -> NormalizedTrace:
        """Compute and attach costs to every span in a trace, then update aggregates."""
        for span in trace.spans:
            if span.cost.total_cost == 0.0:
                span.cost = self._catalog.compute_span_cost(span)

        trace.recompute_aggregates()

        logger.debug(
            "cost_analyzer.analyzed",
            trace_id=trace.trace_id,
            total_cost=trace.total_cost,
            model_calls=trace.model_call_count,
        )
        return trace

    def get_cost_by_model(self, trace: NormalizedTrace) -> dict[str, float]:
        """Break down trace cost by model."""
        by_model: dict[str, float] = {}
        for span in trace.spans:
            if span.span_kind == SpanKind.MODEL_CALL and span.model_call:
                model = span.model_call.model or "unknown"
                by_model[model] = by_model.get(model, 0.0) + span.cost.total_cost
        return {k: round(v, 6) for k, v in by_model.items()}

    def get_cost_by_component(self, trace: NormalizedTrace) -> dict[str, float]:
        """Break down trace cost by span kind (model calls, tools, verification, etc.)."""
        by_kind: dict[str, float] = {}
        for span in trace.spans:
            kind = span.span_kind.value
            by_kind[kind] = by_kind.get(kind, 0.0) + span.cost.total_cost
        return {k: round(v, 6) for k, v in by_kind.items()}

    def get_cost_by_agent(self, trace: NormalizedTrace) -> dict[str, float]:
        """Break down trace cost by agent name."""
        by_agent: dict[str, float] = {}
        for span in trace.spans:
            agent = span.agent_name or "default"
            by_agent[agent] = by_agent.get(agent, 0.0) + span.cost.total_cost
        return {k: round(v, 6) for k, v in by_agent.items()}
