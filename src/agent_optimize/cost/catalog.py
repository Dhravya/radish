"""Cost catalog — maps provider/model/tool usage to dollar costs at execution time.

Prices are per 1M tokens. The catalog is loaded from config and can be updated at runtime
as providers change pricing.
"""

from __future__ import annotations

import structlog

from agent_optimize.config import CostCatalogConfig, ModelPricing, ProviderConfig
from agent_optimize.models.traces import CostBreakdown, NormalizedSpan, SpanKind

logger = structlog.get_logger()

# Fallback pricing when model isn't in the catalog (conservative estimates)
_FALLBACK_PRICING = ModelPricing(input_cost_per_1m=5.0, output_cost_per_1m=15.0)


class CostCatalog:
    """Lookup and compute costs for model and tool usage."""

    def __init__(self, config: CostCatalogConfig | None = None) -> None:
        self._providers: dict[str, ProviderConfig] = {}
        if config:
            self._providers = config.providers

    def get_model_pricing(self, provider: str, model: str) -> ModelPricing:
        """Look up pricing for a specific provider/model combination."""
        provider_cfg = self._providers.get(provider.lower())
        if provider_cfg:
            # Try exact match first
            pricing = provider_cfg.models.get(model)
            if pricing:
                return pricing

            # Try prefix match (e.g., "gpt-4o-2024-11-20" matches "gpt-4o")
            for model_key, pricing in provider_cfg.models.items():
                if model.startswith(model_key) or model_key.startswith(model):
                    return pricing

        # Try matching across all providers
        for prov in self._providers.values():
            for model_key, pricing in prov.models.items():
                if model == model_key or model.startswith(model_key):
                    return pricing

        logger.warning("cost_catalog.unknown_model", provider=provider, model=model)
        return _FALLBACK_PRICING

    def compute_span_cost(self, span: NormalizedSpan) -> CostBreakdown:
        """Compute the dollar cost for a single span."""
        if span.span_kind == SpanKind.MODEL_CALL and span.model_call:
            mc = span.model_call
            pricing = self.get_model_pricing(mc.provider, mc.model)

            input_cost = (mc.tokens.input_tokens / 1_000_000) * pricing.input_cost_per_1m
            output_cost = (mc.tokens.output_tokens / 1_000_000) * pricing.output_cost_per_1m

            return CostBreakdown(
                input_cost=round(input_cost, 6),
                output_cost=round(output_cost, 6),
            )

        if span.span_kind == SpanKind.TOOL_CALL:
            # Tool costs are typically external API costs — placeholder for V0
            # Customers will configure per-tool pricing later
            return CostBreakdown(tool_cost=0.0)

        return CostBreakdown()

    def register_provider(self, name: str, config: ProviderConfig) -> None:
        """Add or update a provider's pricing at runtime."""
        self._providers[name.lower()] = config
        logger.info("cost_catalog.provider_registered", provider=name, models=len(config.models))

    def list_providers(self) -> list[str]:
        return list(self._providers.keys())

    def list_models(self, provider: str | None = None) -> list[str]:
        if provider:
            prov = self._providers.get(provider.lower())
            return list(prov.models.keys()) if prov else []
        return [
            f"{pname}/{mname}"
            for pname, prov in self._providers.items()
            for mname in prov.models
        ]
