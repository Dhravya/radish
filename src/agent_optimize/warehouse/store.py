"""In-memory trace warehouse for V0.

Supports span-level, run-level, task-class, tenant, and time-window queries.
Will be replaced with a persistent backend (e.g., ClickHouse, DuckDB) in later phases.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta

import structlog

from agent_optimize.models.traces import NormalizedSpan, NormalizedTrace, RunSummary, SpanKind

logger = structlog.get_logger()


class TraceWarehouse:
    """In-memory store for normalized traces with query support."""

    def __init__(self, retention_hours: int = 168) -> None:
        self._retention_hours = retention_hours
        self._traces: dict[str, NormalizedTrace] = {}  # trace_id -> trace
        self._by_tenant: dict[str, set[str]] = defaultdict(set)  # tenant_id -> trace_ids
        self._by_task_class: dict[str, set[str]] = defaultdict(set)  # task_class -> trace_ids

    @property
    def trace_count(self) -> int:
        return len(self._traces)

    async def store(self, trace: NormalizedTrace) -> None:
        """Store a normalized trace, indexing by tenant and task class."""
        self._traces[trace.trace_id] = trace

        if trace.tenant_id:
            self._by_tenant[trace.tenant_id].add(trace.trace_id)
        if trace.task_class:
            self._by_task_class[trace.task_class].add(trace.trace_id)

        logger.debug(
            "warehouse.stored",
            trace_id=trace.trace_id,
            spans=len(trace.spans),
            cost=trace.total_cost,
        )

    def get_trace(self, trace_id: str) -> NormalizedTrace | None:
        return self._traces.get(trace_id)

    def get_all_traces(self) -> list[NormalizedTrace]:
        return list(self._traces.values())

    def query_traces(
        self,
        *,
        tenant_id: str | None = None,
        task_class: str | None = None,
        start_time: datetime | None = None,
        end_time: datetime | None = None,
        min_cost: float | None = None,
        success_only: bool | None = None,
        limit: int = 1000,
    ) -> list[NormalizedTrace]:
        """Query traces with optional filters."""
        # Start with candidate set
        if tenant_id and tenant_id in self._by_tenant:
            candidate_ids = self._by_tenant[tenant_id]
        elif task_class and task_class in self._by_task_class:
            candidate_ids = self._by_task_class[task_class]
        else:
            candidate_ids = set(self._traces.keys())

        results: list[NormalizedTrace] = []
        for tid in candidate_ids:
            trace = self._traces.get(tid)
            if trace is None:
                continue

            if tenant_id and trace.tenant_id != tenant_id:
                continue
            if task_class and trace.task_class != task_class:
                continue
            if start_time and trace.start_time < start_time:
                continue
            if end_time and trace.end_time > end_time:
                continue
            if min_cost is not None and trace.total_cost < min_cost:
                continue
            if success_only is not None and trace.success != success_only:
                continue

            results.append(trace)
            if len(results) >= limit:
                break

        return results

    def get_spans_by_kind(self, kind: SpanKind, trace_id: str | None = None) -> list[NormalizedSpan]:
        """Retrieve all spans of a given kind, optionally within a single trace."""
        if trace_id:
            trace = self._traces.get(trace_id)
            if not trace:
                return []
            return [s for s in trace.spans if s.span_kind == kind]

        spans: list[NormalizedSpan] = []
        for trace in self._traces.values():
            spans.extend(s for s in trace.spans if s.span_kind == kind)
        return spans

    def get_model_call_spans(self, model: str | None = None) -> list[NormalizedSpan]:
        """Get all model call spans, optionally filtered by model name."""
        spans = self.get_spans_by_kind(SpanKind.MODEL_CALL)
        if model:
            spans = [s for s in spans if s.model_call and s.model_call.model == model]
        return spans

    def get_run_summaries(
        self,
        *,
        tenant_id: str | None = None,
        limit: int = 100,
    ) -> list[RunSummary]:
        """Generate lightweight run summaries for the dashboard."""
        traces = self.query_traces(tenant_id=tenant_id, limit=limit)
        return [_trace_to_summary(t) for t in traces]

    def get_aggregate_stats(
        self,
        *,
        tenant_id: str | None = None,
        window_hours: int = 168,
    ) -> dict:
        """Compute aggregate statistics over a time window."""
        cutoff = datetime.now(tz=UTC) - timedelta(hours=window_hours)
        traces = self.query_traces(tenant_id=tenant_id, start_time=cutoff)

        if not traces:
            return {
                "traces": 0,
                "total_cost": 0.0,
                "total_input_tokens": 0,
                "total_output_tokens": 0,
                "model_calls": 0,
                "tool_calls": 0,
                "retries": 0,
                "avg_cost": 0.0,
                "avg_duration_ms": 0.0,
                "success_rate": 0.0,
            }

        total_cost = sum(t.total_cost for t in traces)
        successes = sum(1 for t in traces if t.success)

        return {
            "traces": len(traces),
            "total_cost": round(total_cost, 4),
            "total_input_tokens": sum(t.total_input_tokens for t in traces),
            "total_output_tokens": sum(t.total_output_tokens for t in traces),
            "model_calls": sum(t.model_call_count for t in traces),
            "tool_calls": sum(t.tool_call_count for t in traces),
            "retries": sum(t.retry_count for t in traces),
            "avg_cost": round(total_cost / len(traces), 4),
            "avg_duration_ms": round(sum(t.duration_ms for t in traces) / len(traces), 2),
            "success_rate": round(successes / len(traces), 4),
        }

    def evict_expired(self) -> int:
        """Remove traces older than the retention window. Returns count removed."""
        cutoff = datetime.now(tz=UTC) - timedelta(hours=self._retention_hours)
        expired = [tid for tid, t in self._traces.items() if t.end_time < cutoff]

        for tid in expired:
            trace = self._traces.pop(tid, None)
            if trace:
                if trace.tenant_id and trace.tenant_id in self._by_tenant:
                    self._by_tenant[trace.tenant_id].discard(tid)
                if trace.task_class and trace.task_class in self._by_task_class:
                    self._by_task_class[trace.task_class].discard(tid)

        if expired:
            logger.info("warehouse.evicted", count=len(expired))

        return len(expired)

    def get_unique_models(self) -> Sequence[str]:
        """Return all unique model names seen across stored traces."""
        models: set[str] = set()
        for trace in self._traces.values():
            models.update(trace.unique_models)
        return sorted(models)

    def get_unique_tools(self) -> Sequence[str]:
        """Return all unique tool names seen across stored traces."""
        tools: set[str] = set()
        for trace in self._traces.values():
            tools.update(trace.unique_tools)
        return sorted(tools)


def _trace_to_summary(trace: NormalizedTrace) -> RunSummary:
    """Convert a full trace to a lightweight summary."""
    return RunSummary(
        trace_id=trace.trace_id,
        task_class=trace.task_class,
        start_time=trace.start_time,
        duration_ms=trace.duration_ms,
        total_cost=trace.total_cost,
        model_call_count=trace.model_call_count,
        tool_call_count=trace.tool_call_count,
        retry_count=trace.retry_count,
        success=trace.success,
    )
