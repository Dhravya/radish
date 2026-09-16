"""Health and status endpoints."""

from __future__ import annotations

from fastapi import APIRouter

from agent_optimize.api.state import get_state

router = APIRouter(tags=["health"])


@router.get("/health")
async def health_check() -> dict:
    return {"status": "healthy", "version": "0.1.0"}


@router.get("/status")
async def status() -> dict:
    state = get_state()
    return {
        "status": "running",
        "version": "0.1.0",
        "traces_stored": state.warehouse.trace_count,
        "detectors": state.detector_registry.list_detectors(),
        "providers": state.cost_catalog.list_providers(),
        "models": state.cost_catalog.list_models(),
    }
