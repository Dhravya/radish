"""Application configuration loaded from YAML or environment."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field


class ServerConfig(BaseModel):
    host: str = "0.0.0.0"
    port: int = 8080


class IngestionConfig(BaseModel):
    grpc_port: int = 4317
    http_port: int = 4318
    max_batch_size: int = 512
    flush_interval_seconds: int = 5


class WarehouseConfig(BaseModel):
    backend: str = "memory"
    retention_hours: int = 168


class ModelPricing(BaseModel):
    input_cost_per_1m: float = 0.0
    output_cost_per_1m: float = 0.0


class ProviderConfig(BaseModel):
    models: dict[str, ModelPricing] = Field(default_factory=dict)


class CostCatalogConfig(BaseModel):
    providers: dict[str, ProviderConfig] = Field(default_factory=dict)


class DetectorThresholds(BaseModel):
    enabled: bool = True


class ModelOverprovisioningConfig(DetectorThresholds):
    quality_tolerance: float = 0.02
    min_sample_size: int = 50


class ContextDuplicationConfig(DetectorThresholds):
    novelty_threshold: float = 0.30


class RetryWasteConfig(DetectorThresholds):
    max_retries_before_flag: int = 2


class UnnecessaryVerificationConfig(DetectorThresholds):
    quality_delta_threshold: float = 0.005


class RedundantToolsConfig(DetectorThresholds):
    similarity_threshold: float = 0.85


class BadRoutingConfig(DetectorThresholds):
    pass


class SerializationWasteConfig(DetectorThresholds):
    pass


class DetectorsConfig(BaseModel):
    model_overprovisioning: ModelOverprovisioningConfig = Field(default_factory=ModelOverprovisioningConfig)
    context_duplication: ContextDuplicationConfig = Field(default_factory=ContextDuplicationConfig)
    retry_waste: RetryWasteConfig = Field(default_factory=RetryWasteConfig)
    unnecessary_verification: UnnecessaryVerificationConfig = Field(default_factory=UnnecessaryVerificationConfig)
    redundant_tools: RedundantToolsConfig = Field(default_factory=RedundantToolsConfig)
    bad_routing: BadRoutingConfig = Field(default_factory=BadRoutingConfig)
    serialization_waste: SerializationWasteConfig = Field(default_factory=SerializationWasteConfig)


class PrivacyConfig(BaseModel):
    capture_prompts: bool = False
    capture_completions: bool = False
    redact_pii: bool = True
    hash_content: bool = True


class AppConfig(BaseModel):
    server: ServerConfig = Field(default_factory=ServerConfig)
    ingestion: IngestionConfig = Field(default_factory=IngestionConfig)
    warehouse: WarehouseConfig = Field(default_factory=WarehouseConfig)
    cost_catalog: CostCatalogConfig = Field(default_factory=CostCatalogConfig)
    detectors: DetectorsConfig = Field(default_factory=DetectorsConfig)
    privacy: PrivacyConfig = Field(default_factory=PrivacyConfig)


def load_config(path: str | Path | None = None) -> AppConfig:
    """Load configuration from a YAML file, falling back to defaults."""
    if path is None:
        candidates = [Path("config.yaml"), Path("config.example.yaml")]
        for candidate in candidates:
            if candidate.exists():
                path = candidate
                break

    if path is not None:
        raw: dict[str, Any] = yaml.safe_load(Path(path).read_text()) or {}
        return AppConfig.model_validate(raw)

    return AppConfig()
