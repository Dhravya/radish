"""Normalized trace and span models — the stable internal schema that all analyses operate on.

These models are independent of the source agent framework (OpenAI Agents, LangGraph, CrewAI, etc.).
OTel spans are normalized into this schema by the ingestion layer.
"""

from __future__ import annotations

import enum
from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


class SpanKind(str, enum.Enum):
    """Categorizes what a span represents in an agent execution."""

    MODEL_CALL = "model_call"
    TOOL_CALL = "tool_call"
    AGENT_STEP = "agent_step"
    VERIFICATION = "verification"
    PLANNER = "planner"
    RETRIEVAL = "retrieval"
    RETRY = "retry"
    HANDOFF = "handoff"
    OTHER = "other"


class SpanStatus(str, enum.Enum):
    OK = "ok"
    ERROR = "error"
    UNSET = "unset"


# ---------------------------------------------------------------------------
# Span-level models
# ---------------------------------------------------------------------------


class TokenUsage(BaseModel):
    """Token counts for a single model call."""

    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0

    def model_post_init(self, __context: Any) -> None:
        if self.total_tokens == 0:
            self.total_tokens = self.input_tokens + self.output_tokens


class CostBreakdown(BaseModel):
    """Dollar cost attributed to a single span."""

    input_cost: float = 0.0
    output_cost: float = 0.0
    tool_cost: float = 0.0
    total_cost: float = 0.0

    def model_post_init(self, __context: Any) -> None:
        if self.total_cost == 0.0:
            self.total_cost = self.input_cost + self.output_cost + self.tool_cost


class ModelCallSpan(BaseModel):
    """Extra attributes when span_kind == MODEL_CALL."""

    provider: str = ""
    model: str = ""
    temperature: float | None = None
    max_tokens: int | None = None
    tokens: TokenUsage = Field(default_factory=TokenUsage)
    stop_reason: str | None = None


class ToolCallSpan(BaseModel):
    """Extra attributes when span_kind == TOOL_CALL."""

    tool_name: str = ""
    tool_input_hash: str | None = None  # For redundancy detection without storing content
    tool_success: bool = True
    tool_error: str | None = None


class NormalizedSpan(BaseModel):
    """A single unit of work inside an agent run, normalized from an OTel span.

    This is the primary record that detectors and analyzers operate on.
    """

    span_id: str
    trace_id: str
    parent_span_id: str | None = None

    span_kind: SpanKind = SpanKind.OTHER
    name: str = ""
    status: SpanStatus = SpanStatus.UNSET

    start_time: datetime
    end_time: datetime
    duration_ms: float = 0.0

    # Framework/source metadata
    source_framework: str = ""  # e.g. "openai-agents", "langgraph", "crewai"
    agent_name: str | None = None

    # Cost attribution
    cost: CostBreakdown = Field(default_factory=CostBreakdown)

    # Type-specific payloads
    model_call: ModelCallSpan | None = None
    tool_call: ToolCallSpan | None = None

    # Whether this span is the Nth retry of a prior span
    is_retry: bool = False
    retry_of_span_id: str | None = None
    retry_number: int = 0

    # Dependency graph
    depends_on: list[str] = Field(default_factory=list)  # span_ids this span waited for

    # OTel attributes preserved as-is for drill-down
    raw_attributes: dict[str, Any] = Field(default_factory=dict)

    # Privacy: content hashes instead of raw prompts/completions
    input_content_hash: str | None = None
    output_content_hash: str | None = None

    def model_post_init(self, __context: Any) -> None:
        if self.duration_ms == 0.0 and self.start_time and self.end_time:
            delta = (self.end_time - self.start_time).total_seconds() * 1000
            self.duration_ms = round(delta, 2)


# ---------------------------------------------------------------------------
# Trace-level (run-level) models
# ---------------------------------------------------------------------------


class NormalizedTrace(BaseModel):
    """A complete agent run composed of normalized spans.

    This is the primary unit of analysis — one trace = one agent invocation.
    """

    trace_id: str
    tenant_id: str | None = None  # Multi-tenant isolation
    task_class: str | None = None  # For per-task-class analytics

    start_time: datetime
    end_time: datetime
    duration_ms: float = 0.0

    spans: list[NormalizedSpan] = Field(default_factory=list)

    # Aggregated run-level metrics (computed after ingestion)
    total_cost: float = 0.0
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    model_call_count: int = 0
    tool_call_count: int = 0
    retry_count: int = 0
    unique_models: list[str] = Field(default_factory=list)
    unique_tools: list[str] = Field(default_factory=list)

    # Outcome
    success: bool = True
    error_message: str | None = None

    # Source metadata
    source_framework: str = ""
    raw_attributes: dict[str, Any] = Field(default_factory=dict)

    def model_post_init(self, __context: Any) -> None:
        if self.duration_ms == 0.0 and self.start_time and self.end_time:
            delta = (self.end_time - self.start_time).total_seconds() * 1000
            self.duration_ms = round(delta, 2)

    def recompute_aggregates(self) -> None:
        """Recalculate run-level aggregates from spans. Called after all spans are added."""
        self.total_cost = sum(s.cost.total_cost for s in self.spans)
        self.total_input_tokens = sum(
            s.model_call.tokens.input_tokens for s in self.spans if s.model_call
        )
        self.total_output_tokens = sum(
            s.model_call.tokens.output_tokens for s in self.spans if s.model_call
        )
        self.model_call_count = sum(1 for s in self.spans if s.span_kind == SpanKind.MODEL_CALL)
        self.tool_call_count = sum(1 for s in self.spans if s.span_kind == SpanKind.TOOL_CALL)
        self.retry_count = sum(1 for s in self.spans if s.is_retry)
        self.unique_models = sorted(
            {s.model_call.model for s in self.spans if s.model_call and s.model_call.model}
        )
        self.unique_tools = sorted(
            {s.tool_call.tool_name for s in self.spans if s.tool_call and s.tool_call.tool_name}
        )


# ---------------------------------------------------------------------------
# Summary view (for dashboard)
# ---------------------------------------------------------------------------


class RunSummary(BaseModel):
    """Lightweight per-run summary for the opportunity dashboard."""

    trace_id: str
    task_class: str | None = None
    start_time: datetime
    duration_ms: float
    total_cost: float
    useful_work_cost: float = 0.0
    estimated_waste: float = 0.0
    efficiency_score: float = 0.0  # useful_work / total_cost
    model_call_count: int = 0
    tool_call_count: int = 0
    retry_count: int = 0
    success: bool = True
    top_waste_category: str | None = None
