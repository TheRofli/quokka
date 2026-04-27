from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from app.domain.enums import ModelStatus


@dataclass
class RuntimeState:
    status: ModelStatus = ModelStatus.STOPPED
    pid: int | None = None
    managed: bool = False
    started_at: datetime | None = None
    stopped_at: datetime | None = None
    exit_code: int | None = None
    last_error: str | None = None
    last_health_check: datetime | None = None
    health_ok: bool | None = None
    health_latency_ms: float | None = None
    crash_count: int = 0
    last_transition_reason: str | None = None
    details: dict[str, Any] = field(default_factory=dict)
