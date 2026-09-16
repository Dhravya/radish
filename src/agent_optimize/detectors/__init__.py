"""Money leak detectors: identify economically unnecessary behavior in agent traces."""

from agent_optimize.detectors.bad_routing import BadRoutingDetector
from agent_optimize.detectors.base import BaseDetector
from agent_optimize.detectors.context_duplication import ContextDuplicationDetector
from agent_optimize.detectors.model_overprovisioning import ModelOverprovisioningDetector
from agent_optimize.detectors.redundant_tools import RedundantToolsDetector
from agent_optimize.detectors.registry import DetectorRegistry
from agent_optimize.detectors.retry_waste import RetryWasteDetector
from agent_optimize.detectors.serialization_waste import SerializationWasteDetector
from agent_optimize.detectors.unnecessary_verification import UnnecessaryVerificationDetector

__all__ = [
    "BadRoutingDetector",
    "BaseDetector",
    "ContextDuplicationDetector",
    "DetectorRegistry",
    "ModelOverprovisioningDetector",
    "RedundantToolsDetector",
    "RetryWasteDetector",
    "SerializationWasteDetector",
    "UnnecessaryVerificationDetector",
    "create_default_registry",
]


def create_default_registry(config: dict | None = None) -> DetectorRegistry:
    """Create a registry with all built-in detectors, configured from the app config."""
    config = config or {}
    registry = DetectorRegistry()

    registry.register(ModelOverprovisioningDetector(config.get("model_overprovisioning")))
    registry.register(ContextDuplicationDetector(config.get("context_duplication")))
    registry.register(RetryWasteDetector(config.get("retry_waste")))
    registry.register(UnnecessaryVerificationDetector(config.get("unnecessary_verification")))
    registry.register(RedundantToolsDetector(config.get("redundant_tools")))
    registry.register(BadRoutingDetector(config.get("bad_routing")))
    registry.register(SerializationWasteDetector(config.get("serialization_waste")))

    return registry
