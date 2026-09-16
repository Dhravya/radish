"""Opportunity dashboard API — the headline product experience.

The executive landing page leads with economic opportunity, not raw traces.
Engineers can drill down from each opportunity into spans, evidence, and replay results.
"""

from __future__ import annotations

from fastapi import APIRouter, Query

from agent_optimize.api.state import get_state

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])


@router.get("/opportunities")
async def get_opportunities(
    tenant_id: str | None = None,
    window_days: int = Query(default=7, ge=1, le=90),
) -> dict:
    """Generate the executive opportunity dashboard.

    Returns headline metrics (AI spend, identified waste, optimization potential)
    and ranked opportunities with dollars, evidence, and confidence.
    """
    state = get_state()

    # Get traces in the window
    traces = state.warehouse.query_traces(tenant_id=tenant_id, limit=10000)

    if not traces:
        return {
            "total_ai_spend_monthly": 0.0,
            "identified_waste_monthly": 0.0,
            "optimization_potential_pct": 0.0,
            "potential_optimized_spend": 0.0,
            "estimated_annual_savings": 0.0,
            "opportunities": [],
            "traces_analyzed": 0,
            "time_window_days": window_days,
        }

    # Run waste detection across all traces
    report = state.detector_registry.analyze_batch(traces)

    # Generate opportunity dashboard
    dashboard = state.optimization_engine.generate_opportunities(
        reports=[report],
        traces=traces,
        window_days=window_days,
    )

    return {
        "computed_at": dashboard.computed_at.isoformat(),
        "total_ai_spend_monthly": dashboard.total_ai_spend_monthly,
        "identified_waste_monthly": dashboard.identified_waste_monthly,
        "optimization_potential_pct": dashboard.optimization_potential_pct,
        "potential_optimized_spend": dashboard.potential_optimized_spend,
        "estimated_annual_savings": dashboard.estimated_annual_savings,
        "traces_analyzed": dashboard.traces_analyzed,
        "time_window_days": dashboard.time_window_days,
        "opportunities": [
            {
                "opportunity_id": o.opportunity_id,
                "category": o.category.value,
                "confidence": o.confidence.value,
                "estimated_monthly_waste": o.estimated_monthly_waste,
                "estimated_annual_savings": o.estimated_annual_savings,
                "affected_traces_pct": o.affected_traces_pct,
                "estimated_quality_impact": o.estimated_quality_impact,
                "title": o.title,
                "description": o.description,
                "recommendation": o.recommendation,
                "evidence_summary": o.evidence_summary,
                "total_detections": o.total_detections,
            }
            for o in dashboard.opportunities
        ],
    }


@router.get("/stats")
async def get_aggregate_stats(
    tenant_id: str | None = None,
    window_hours: int = Query(default=168, ge=1, le=2160),
) -> dict:
    """Get aggregate statistics over a time window."""
    state = get_state()
    return state.warehouse.get_aggregate_stats(
        tenant_id=tenant_id,
        window_hours=window_hours,
    )


@router.get("/runs")
async def get_run_summaries(
    tenant_id: str | None = None,
    limit: int = Query(default=100, le=1000),
) -> dict:
    """Get lightweight run summaries for the dashboard list view."""
    state = get_state()
    summaries = state.warehouse.get_run_summaries(tenant_id=tenant_id, limit=limit)
    return {
        "count": len(summaries),
        "runs": [s.model_dump() for s in summaries],
    }


@router.get("/models")
async def get_models() -> dict:
    """List all models seen in stored traces."""
    state = get_state()
    return {
        "models": list(state.warehouse.get_unique_models()),
        "catalog_models": state.cost_catalog.list_models(),
    }


@router.get("/tools")
async def get_tools() -> dict:
    """List all tools seen in stored traces."""
    state = get_state()
    return {"tools": list(state.warehouse.get_unique_tools())}
