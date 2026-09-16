"""Shared application state — decoupled from app.py to avoid circular imports."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from agent_optimize.api.app import AppState

_state: AppState | None = None


def set_state(state: AppState | None) -> None:
    global _state
    _state = state


def get_state() -> AppState:
    assert _state is not None, "App not initialized. Call set_state() during startup."
    return _state  # type: ignore[return-value]
