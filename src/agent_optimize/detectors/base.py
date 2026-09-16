"""Base class for all waste detectors.

Every detector follows the same contract: accept a trace (or batch of traces),
return a list of WasteDetection instances with evidence, confidence, and recommendations.
"""

from __future__ import annotations

import abc
from typing import Any

from agent_optimize.models.traces import NormalizedTrace
from agent_optimize.models.waste import WasteDetection


class BaseDetector(abc.ABC):
    """Abstract base for money-leak detectors."""

    name: str = "base"
    version: str = "0.1.0"
    category: str = "unknown"

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        self._config = config or {}
        self._enabled = self._config.get("enabled", True)

    @property
    def enabled(self) -> bool:
        return self._enabled

    @abc.abstractmethod
    def detect(self, trace: NormalizedTrace) -> list[WasteDetection]:
        """Analyze a single trace and return any waste detections."""
        ...

    def detect_batch(self, traces: list[NormalizedTrace]) -> list[WasteDetection]:
        """Analyze a batch of traces. Default implementation iterates one by one.

        Detectors that need cross-trace analysis (e.g., routing patterns)
        should override this method.
        """
        detections: list[WasteDetection] = []
        for trace in traces:
            detections.extend(self.detect(trace))
        return detections
