"""Counterfactual replay — validate optimization recommendations against historical workloads.

The product should never jump directly from recommendation to production change.
The safe workflow: detect -> recommend -> replay -> evaluate -> compare -> canary -> monitor -> rollout.

V0 provides the replay framework and evaluation scaffolding. Actual model-call
replay requires integration with provider APIs (V3).
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from enum import Enum
from typing import Any

import structlog
from pydantic import BaseModel, Field

logger = structlog.get_logger()


class ReplayStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class CandidateConfig(BaseModel):
    """A candidate configuration to evaluate against the current setup."""

    config_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str = ""
    description: str = ""

    # What changes this candidate makes
    model_overrides: dict[str, str] = Field(default_factory=dict)  # old_model -> new_model
    remove_verification: bool = False
    enable_caching: bool = False
    enable_parallelization: bool = False
    retry_budget: int | None = None
    fallback_tools: dict[str, str] = Field(default_factory=dict)  # tool -> fallback_tool

    # Expected impact (from detector estimates)
    expected_cost_reduction_pct: float = 0.0
    expected_quality_impact: float = 0.0
    expected_latency_impact_pct: float = 0.0


class ReplayResult(BaseModel):
    """Result of replaying a candidate configuration against historical traces."""

    result_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    config_id: str = ""
    config_name: str = ""

    # Evaluation metrics
    quality_score: float = 0.0
    cost: float = 0.0
    p50_latency_ms: float = 0.0
    p95_latency_ms: float = 0.0
    reliability: float = 0.0

    # Comparison to baseline
    quality_delta: float = 0.0
    cost_delta: float = 0.0
    cost_reduction_pct: float = 0.0
    latency_delta_pct: float = 0.0

    # Evidence
    traces_replayed: int = 0
    evaluations_run: int = 0


class ReplayExperiment(BaseModel):
    """A complete replay experiment comparing configurations."""

    experiment_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    status: ReplayStatus = ReplayStatus.PENDING
    created_at: datetime = Field(default_factory=lambda: datetime.now(tz=UTC))

    # Inputs
    baseline_config: CandidateConfig = Field(default_factory=CandidateConfig)
    candidate_configs: list[CandidateConfig] = Field(default_factory=list)
    trace_ids: list[str] = Field(default_factory=list)

    # Results
    baseline_result: ReplayResult | None = None
    candidate_results: list[ReplayResult] = Field(default_factory=list)
    recommended_config_id: str | None = None

    # Confidence
    confidence_pct: float = 0.0
    quality_regression_risk: str = "unknown"


class ReplayEngine:
    """Manages counterfactual replay experiments.

    V0: Provides the experiment framework and cost-projection replay
    (estimates results from trace data without making actual API calls).
    V3: Will add live replay with actual model API calls.
    """

    def __init__(self) -> None:
        self._experiments: dict[str, ReplayExperiment] = {}

    def create_experiment(
        self,
        candidate_configs: list[CandidateConfig],
        trace_ids: list[str],
    ) -> ReplayExperiment:
        """Create a new replay experiment."""
        experiment = ReplayExperiment(
            baseline_config=CandidateConfig(name="current", description="Current production configuration"),
            candidate_configs=candidate_configs,
            trace_ids=trace_ids,
        )
        self._experiments[experiment.experiment_id] = experiment
        logger.info(
            "replay.experiment_created",
            experiment_id=experiment.experiment_id,
            candidates=len(candidate_configs),
            traces=len(trace_ids),
        )
        return experiment

    def run_projection_replay(
        self,
        experiment: ReplayExperiment,
        traces: list[Any],
    ) -> ReplayExperiment:
        """Run a cost-projection replay (no actual API calls).

        Estimates what each candidate configuration would cost based on
        the trace data and detector analysis. This is the V0 approach —
        fast, safe, and useful for ranking candidates before live replay.
        """
        experiment.status = ReplayStatus.RUNNING

        # Baseline: aggregate actual costs from traces
        baseline_cost = sum(getattr(t, "total_cost", 0.0) for t in traces)
        baseline_success = sum(1 for t in traces if getattr(t, "success", True))
        baseline_reliability = baseline_success / len(traces) if traces else 0.0

        experiment.baseline_result = ReplayResult(
            config_id=experiment.baseline_config.config_id,
            config_name="current",
            quality_score=baseline_reliability,
            cost=round(baseline_cost, 4),
            reliability=round(baseline_reliability, 4),
            traces_replayed=len(traces),
        )

        # Candidates: project costs based on expected reductions
        for candidate in experiment.candidate_configs:
            projected_cost = baseline_cost * (1 - candidate.expected_cost_reduction_pct / 100)
            projected_quality = baseline_reliability + candidate.expected_quality_impact

            result = ReplayResult(
                config_id=candidate.config_id,
                config_name=candidate.name,
                quality_score=round(max(0.0, projected_quality), 4),
                cost=round(projected_cost, 4),
                reliability=round(max(0.0, projected_quality), 4),
                traces_replayed=len(traces),
                quality_delta=round(candidate.expected_quality_impact, 4),
                cost_delta=round(projected_cost - baseline_cost, 4),
                cost_reduction_pct=round(candidate.expected_cost_reduction_pct, 1),
                latency_delta_pct=round(candidate.expected_latency_impact_pct, 1),
            )
            experiment.candidate_results.append(result)

        # Pick recommendation: best cost reduction with acceptable quality
        viable = [
            r
            for r in experiment.candidate_results
            if r.quality_delta >= -0.02  # Max 2% quality regression
        ]
        if viable:
            best = min(viable, key=lambda r: r.cost)
            experiment.recommended_config_id = best.config_id
            experiment.confidence_pct = 70.0  # Projection-based = moderate confidence
            experiment.quality_regression_risk = "LOW" if best.quality_delta >= -0.005 else "MEDIUM"
        else:
            experiment.confidence_pct = 0.0
            experiment.quality_regression_risk = "HIGH"

        experiment.status = ReplayStatus.COMPLETED

        logger.info(
            "replay.projection_complete",
            experiment_id=experiment.experiment_id,
            recommended=experiment.recommended_config_id,
            confidence=experiment.confidence_pct,
        )

        self._experiments[experiment.experiment_id] = experiment
        return experiment

    def get_experiment(self, experiment_id: str) -> ReplayExperiment | None:
        return self._experiments.get(experiment_id)

    def list_experiments(self) -> list[ReplayExperiment]:
        return list(self._experiments.values())
