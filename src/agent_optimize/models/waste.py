"""Waste detection models — categories, detections, and reports.

Every waste detection must include confidence, evidence, and a recommended action.
The product principle: don't merely report cost — explain *why*, quantify the unnecessary
portion, and suggest a change that preserves quality.
"""

from __future__ import annotations

import enum
from datetime import datetime

from pydantic import BaseModel, Field


class WasteCategory(str, enum.Enum):
    """The types of economically unnecessary behavior AgentOptimize can detect."""

    MODEL_OVERPROVISIONING = "model_overprovisioning"
    CONTEXT_DUPLICATION = "context_duplication"
    RETRY_WASTE = "retry_waste"
    UNNECESSARY_VERIFICATION = "unnecessary_verification"
    REDUNDANT_TOOL_CALLS = "redundant_tool_calls"
    BAD_ROUTING = "bad_routing"
    SERIALIZATION_WASTE = "serialization_waste"


class ConfidenceLevel(str, enum.Enum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class WasteDetection(BaseModel):
    """A single detected instance of waste in a trace.

    Each detection is evidence-backed: it points to specific spans,
    quantifies the cost, and states how confident the detector is.
    """

    detection_id: str
    trace_id: str
    category: WasteCategory
    confidence: ConfidenceLevel

    # What spans are involved
    span_ids: list[str] = Field(default_factory=list)

    # Dollars
    estimated_waste_cost: float = 0.0
    current_cost: float = 0.0
    projected_cost: float = 0.0
    savings_pct: float = 0.0

    # Human-readable explanation
    title: str = ""
    description: str = ""
    evidence: str = ""
    recommendation: str = ""

    # Quality impact assessment
    estimated_quality_impact: float = 0.0  # Negative = quality loss, e.g., -0.002
    quality_risk: ConfidenceLevel = ConfidenceLevel.LOW

    # Detector metadata
    detector_name: str = ""
    detector_version: str = "0.1.0"
    detected_at: datetime = Field(default_factory=datetime.utcnow)


class WasteReport(BaseModel):
    """Aggregated waste report for a single trace or across a time window."""

    trace_id: str | None = None  # None when aggregated across traces
    tenant_id: str | None = None
    time_window_start: datetime | None = None
    time_window_end: datetime | None = None

    # Totals
    total_cost: float = 0.0
    total_waste: float = 0.0
    useful_work_cost: float = 0.0
    efficiency_score: float = 0.0  # useful_work / total_cost (0.0 - 1.0)

    # Breakdown by category
    waste_by_category: dict[WasteCategory, float] = Field(default_factory=dict)

    # Individual detections
    detections: list[WasteDetection] = Field(default_factory=list)

    # Aggregate counts
    traces_analyzed: int = 0
    detections_count: int = 0

    def recompute(self) -> None:
        """Recalculate aggregates from detections."""
        self.total_waste = sum(d.estimated_waste_cost for d in self.detections)
        self.useful_work_cost = max(0.0, self.total_cost - self.total_waste)
        self.efficiency_score = (
            self.useful_work_cost / self.total_cost if self.total_cost > 0 else 0.0
        )
        self.detections_count = len(self.detections)

        by_cat: dict[WasteCategory, float] = {}
        for d in self.detections:
            by_cat[d.category] = by_cat.get(d.category, 0.0) + d.estimated_waste_cost
        self.waste_by_category = by_cat


# ---------------------------------------------------------------------------
# Opportunity models (for the dashboard)
# ---------------------------------------------------------------------------


class Opportunity(BaseModel):
    """A ranked optimization opportunity surfaced to the dashboard.

    This is the executive-facing unit: dollars, category, confidence, and action.
    """

    opportunity_id: str
    category: WasteCategory
    confidence: ConfidenceLevel

    # Financial
    estimated_monthly_waste: float = 0.0
    estimated_annual_savings: float = 0.0

    # Impact
    affected_traces_pct: float = 0.0
    estimated_quality_impact: float = 0.0
    estimated_latency_impact_pct: float = 0.0

    # Explanation
    title: str = ""
    description: str = ""
    recommendation: str = ""
    evidence_summary: str = ""

    # Underlying detections
    sample_detection_ids: list[str] = Field(default_factory=list)
    total_detections: int = 0


class OpportunityDashboard(BaseModel):
    """Top-level view for the executive opportunity dashboard."""

    tenant_id: str | None = None
    computed_at: datetime = Field(default_factory=datetime.utcnow)

    # Headline metrics
    total_ai_spend_monthly: float = 0.0
    identified_waste_monthly: float = 0.0
    optimization_potential_pct: float = 0.0
    potential_optimized_spend: float = 0.0
    estimated_annual_savings: float = 0.0

    # Ranked opportunities
    opportunities: list[Opportunity] = Field(default_factory=list)

    # Volume
    traces_analyzed: int = 0
    time_window_days: int = 7
