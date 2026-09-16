"""Detector registry — discovers and manages all waste detectors."""

from __future__ import annotations

from typing import Any

import structlog

from agent_optimize.detectors.base import BaseDetector
from agent_optimize.models.traces import NormalizedTrace
from agent_optimize.models.waste import WasteDetection, WasteReport

logger = structlog.get_logger()


class DetectorRegistry:
    """Central registry that runs all enabled detectors against traces."""

    def __init__(self) -> None:
        self._detectors: list[BaseDetector] = []

    def register(self, detector: BaseDetector) -> None:
        self._detectors.append(detector)
        logger.info("detector.registered", name=detector.name, enabled=detector.enabled)

    def get_detector(self, name: str) -> BaseDetector | None:
        return next((d for d in self._detectors if d.name == name), None)

    def list_detectors(self) -> list[dict[str, Any]]:
        return [
            {"name": d.name, "version": d.version, "category": d.category, "enabled": d.enabled}
            for d in self._detectors
        ]

    def analyze_trace(self, trace: NormalizedTrace) -> WasteReport:
        """Run all enabled detectors on a single trace and return an aggregated report."""
        all_detections: list[WasteDetection] = []

        for detector in self._detectors:
            if not detector.enabled:
                continue
            try:
                detections = detector.detect(trace)
                all_detections.extend(detections)
            except Exception:
                logger.exception("detector.error", detector=detector.name, trace_id=trace.trace_id)

        report = WasteReport(
            trace_id=trace.trace_id,
            total_cost=trace.total_cost,
            detections=all_detections,
        )
        report.recompute()
        return report

    def analyze_batch(self, traces: list[NormalizedTrace]) -> WasteReport:
        """Run all enabled detectors across a batch and return an aggregated report."""
        all_detections: list[WasteDetection] = []

        for detector in self._detectors:
            if not detector.enabled:
                continue
            try:
                detections = detector.detect_batch(traces)
                all_detections.extend(detections)
            except Exception:
                logger.exception("detector.batch_error", detector=detector.name)

        total_cost = sum(t.total_cost for t in traces)

        report = WasteReport(
            total_cost=total_cost,
            traces_analyzed=len(traces),
            detections=all_detections,
        )
        report.recompute()
        return report
