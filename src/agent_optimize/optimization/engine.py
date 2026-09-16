"""Optimization engine: takes waste detections and generates ranked recommendations.

The engine aggregates per-trace detections into monthly opportunity estimates,
ranks them by expected annualized savings, and generates candidate configurations
for counterfactual replay.

The safe workflow: detect -> recommend -> replay -> evaluate -> compare -> canary -> rollout.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from datetime import UTC, datetime

import structlog

from agent_optimize.models.traces import NormalizedTrace
from agent_optimize.models.waste import (
    ConfidenceLevel,
    Opportunity,
    OpportunityDashboard,
    WasteCategory,
    WasteDetection,
    WasteReport,
)

logger = structlog.get_logger()

# Map categories to human-readable titles
_CATEGORY_TITLES: dict[WasteCategory, str] = {
    WasteCategory.MODEL_OVERPROVISIONING: "Model Overprovisioning",
    WasteCategory.CONTEXT_DUPLICATION: "Context Duplication",
    WasteCategory.RETRY_WASTE: "Retry Inefficiency",
    WasteCategory.UNNECESSARY_VERIFICATION: "Unnecessary Verification",
    WasteCategory.REDUNDANT_TOOL_CALLS: "Redundant Tool Calls",
    WasteCategory.BAD_ROUTING: "Bad Routing",
    WasteCategory.SERIALIZATION_WASTE: "Serialization / Latency Waste",
}

_CATEGORY_RECOMMENDATIONS: dict[WasteCategory, str] = {
    WasteCategory.MODEL_OVERPROVISIONING: (
        "Route low-complexity requests to smaller models. "
        "Replay representative inputs against candidate models to validate quality."
    ),
    WasteCategory.CONTEXT_DUPLICATION: (
        "Implement summarization, state compression, or provider-side caching "
        "to reduce repeated context in multi-turn workflows."
    ),
    WasteCategory.RETRY_WASTE: (
        "Implement fallback strategies and retry budgets. "
        "Switch to alternative tools or approaches after initial failures."
    ),
    WasteCategory.UNNECESSARY_VERIFICATION: (
        "Invoke verification conditionally based on risk score or confidence. "
        "Run ablation analysis to confirm verifier impact on outcomes."
    ),
    WasteCategory.REDUNDANT_TOOL_CALLS: (
        "Cache tool results for equivalent inputs. "
        "Restructure the agent's retrieval strategy to avoid redundant calls."
    ),
    WasteCategory.BAD_ROUTING: (
        "Deploy a complexity/risk router that matches model tier to task difficulty. "
        "Use task class and input characteristics for routing decisions."
    ),
    WasteCategory.SERIALIZATION_WASTE: (
        "Execute independent workflow stages in parallel. "
        "This reduces latency without changing model selection."
    ),
}


class OptimizationEngine:
    """Aggregates waste detections into ranked optimization opportunities."""

    def __init__(self, traces_per_day_estimate: float = 0.0) -> None:
        self._traces_per_day = traces_per_day_estimate

    def generate_opportunities(
        self,
        reports: list[WasteReport],
        traces: list[NormalizedTrace],
        window_days: int = 7,
    ) -> OpportunityDashboard:
        """Generate the executive opportunity dashboard from waste reports."""
        now = datetime.now(tz=UTC)

        # Collect all detections
        all_detections: list[WasteDetection] = []
        for report in reports:
            all_detections.extend(report.detections)

        # Aggregate by category
        by_category: dict[WasteCategory, list[WasteDetection]] = defaultdict(list)
        for d in all_detections:
            by_category[d.category].append(d)

        # Compute totals
        total_cost = sum(r.total_cost for r in reports)
        total_waste = sum(d.estimated_waste_cost for d in all_detections)
        traces_analyzed = sum(r.traces_analyzed for r in reports) or len(traces)

        # Extrapolate to monthly
        daily_multiplier = 30.0 / window_days if window_days > 0 else 1.0
        monthly_cost = total_cost * daily_multiplier
        monthly_waste = total_waste * daily_multiplier

        # Build ranked opportunities
        opportunities: list[Opportunity] = []
        for category, detections in by_category.items():
            opportunity = self._build_opportunity(
                category=category,
                detections=detections,
                traces=traces,
                daily_multiplier=daily_multiplier,
            )
            opportunities.append(opportunity)

        # Sort by estimated monthly waste (highest first)
        opportunities.sort(key=lambda o: o.estimated_monthly_waste, reverse=True)

        optimization_pct = (monthly_waste / monthly_cost * 100) if monthly_cost > 0 else 0.0

        return OpportunityDashboard(
            computed_at=now,
            total_ai_spend_monthly=round(monthly_cost, 2),
            identified_waste_monthly=round(monthly_waste, 2),
            optimization_potential_pct=round(optimization_pct, 1),
            potential_optimized_spend=round(monthly_cost - monthly_waste, 2),
            estimated_annual_savings=round(monthly_waste * 12, 2),
            opportunities=opportunities,
            traces_analyzed=traces_analyzed,
            time_window_days=window_days,
        )

    def _build_opportunity(
        self,
        category: WasteCategory,
        detections: list[WasteDetection],
        traces: list[NormalizedTrace],
        daily_multiplier: float,
    ) -> Opportunity:
        """Build a single opportunity from a group of same-category detections."""
        total_waste = sum(d.estimated_waste_cost for d in detections)
        monthly_waste = total_waste * daily_multiplier

        # Determine affected traces
        affected_trace_ids = {d.trace_id for d in detections}
        affected_pct = (len(affected_trace_ids) / len(traces) * 100) if traces else 0.0

        # Aggregate quality impact (take worst case)
        quality_impacts = [d.estimated_quality_impact for d in detections if d.estimated_quality_impact != 0]
        avg_quality_impact = (
            sum(quality_impacts) / len(quality_impacts) if quality_impacts else 0.0
        )

        # Determine confidence (take the most common)
        confidence_counts: dict[ConfidenceLevel, int] = defaultdict(int)
        for d in detections:
            confidence_counts[d.confidence] += 1
        overall_confidence = (
            max(confidence_counts, key=confidence_counts.get)
            if confidence_counts
            else ConfidenceLevel.LOW
        )

        # Sample detections for drill-down
        sample_ids = [d.detection_id for d in detections[:5]]

        return Opportunity(
            opportunity_id=str(uuid.uuid4()),
            category=category,
            confidence=overall_confidence,
            estimated_monthly_waste=round(monthly_waste, 2),
            estimated_annual_savings=round(monthly_waste * 12, 2),
            affected_traces_pct=round(affected_pct, 1),
            estimated_quality_impact=round(avg_quality_impact, 4),
            title=_CATEGORY_TITLES.get(category, category.value),
            description=self._generate_description(category, detections, monthly_waste),
            recommendation=_CATEGORY_RECOMMENDATIONS.get(category, "Review and optimize."),
            evidence_summary=f"{len(detections)} detections across {len(affected_trace_ids)} traces.",
            sample_detection_ids=sample_ids,
            total_detections=len(detections),
        )

    def _generate_description(
        self,
        category: WasteCategory,
        detections: list[WasteDetection],
        monthly_waste: float,
    ) -> str:
        """Generate a human-readable description for an opportunity."""
        count = len(detections)
        return (
            f"Detected {count} instance{'s' if count != 1 else ''} of "
            f"{_CATEGORY_TITLES.get(category, category.value).lower()}. "
            f"Estimated monthly waste: ${monthly_waste:,.2f}."
        )
