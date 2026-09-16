"""FastAPI application factory and global state management."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from agent_optimize.api.state import get_state, set_state
from agent_optimize.config import AppConfig, load_config
from agent_optimize.cost.analyzer import CostAnalyzer
from agent_optimize.cost.catalog import CostCatalog
from agent_optimize.detectors import create_default_registry
from agent_optimize.ingestion.normalizer import TraceNormalizer
from agent_optimize.ingestion.otlp_receiver import router as otlp_router
from agent_optimize.ingestion.otlp_receiver import set_normalizer, set_trace_callback
from agent_optimize.models.traces import NormalizedTrace
from agent_optimize.optimization.engine import OptimizationEngine
from agent_optimize.optimization.replay import ReplayEngine
from agent_optimize.warehouse.store import TraceWarehouse

logger = structlog.get_logger()


class AppState:
    """Holds all shared application state — warehouse, analyzers, detectors, etc."""

    def __init__(self, config: AppConfig) -> None:
        self.config = config
        self.warehouse = TraceWarehouse(retention_hours=config.warehouse.retention_hours)
        self.cost_catalog = CostCatalog(config.cost_catalog)
        self.cost_analyzer = CostAnalyzer(self.cost_catalog)
        self.detector_registry = create_default_registry(
            config.detectors.model_dump() if config.detectors else None
        )
        self.optimization_engine = OptimizationEngine()
        self.replay_engine = ReplayEngine()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Application startup/shutdown lifecycle."""
    config = load_config()
    state = AppState(config)
    set_state(state)

    # Wire up the ingestion pipeline
    normalizer = TraceNormalizer(capture_content=config.privacy.capture_prompts)
    set_normalizer(normalizer)
    set_trace_callback(_on_trace_ingested)

    logger.info(
        "app.started",
        warehouse_backend=config.warehouse.backend,
        detectors=len(state.detector_registry.list_detectors()),
        providers=state.cost_catalog.list_providers(),
    )

    yield

    logger.info("app.shutdown", traces_stored=state.warehouse.trace_count)
    set_state(None)


async def _on_trace_ingested(trace: NormalizedTrace) -> None:
    """Pipeline callback: cost-analyze and store each ingested trace."""
    state = get_state()

    # Step 1: Attribute costs
    trace = state.cost_analyzer.analyze_trace(trace)

    # Step 2: Store in warehouse
    await state.warehouse.store(trace)

    # Step 3: Run waste detection
    report = state.detector_registry.analyze_trace(trace)

    logger.info(
        "pipeline.processed",
        trace_id=trace.trace_id,
        cost=trace.total_cost,
        waste=report.total_waste,
        efficiency=f"{report.efficiency_score:.0%}",
        detections=report.detections_count,
    )


def create_app(config: AppConfig | None = None) -> FastAPI:
    """Create and configure the FastAPI application."""
    app = FastAPI(
        title="AgentOptimize",
        description="AI-agent FinOps: waste attribution, counterfactual optimization, and quality preservation.",
        version="0.1.0",
        lifespan=lifespan,
    )

    # CORS for dashboard frontend
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Mount routes — imported here to avoid circular imports
    from agent_optimize.api.routes import dashboard, health, traces

    app.include_router(health.router)
    app.include_router(otlp_router)
    app.include_router(traces.router)
    app.include_router(dashboard.router)

    return app
