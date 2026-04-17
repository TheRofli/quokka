from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

from app.domain.enums import ModelStatus, ProviderType
from app.schemas.config import LaunchConfig, ModelSettings, ProfileConfig


class RuntimeStateResponse(BaseModel):
    status: ModelStatus
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
    details: dict[str, str] = Field(default_factory=dict)


class ModelView(BaseModel):
    id: str
    name: str
    provider: ProviderType
    modality: str
    description: str
    endpoint: str
    health_url: str | None = None
    metadata: dict[str, Any]
    launch: LaunchConfig
    profiles: list[ProfileConfig]
    active_profile_id: str | None = None
    active_profile: ProfileConfig | None = None
    settings: ModelSettings
    log_path: str | None = None
    runtime: RuntimeStateResponse
    supported_actions: list[str]


class GpuDeviceMetrics(BaseModel):
    index: int
    name: str
    usage_percent: float | None = None
    memory_used_mb: float | None = None
    memory_total_mb: float | None = None
    temperature_c: float | None = None


class SystemMetricsResponse(BaseModel):
    timestamp: datetime
    cpu_usage_percent: float
    ram_used_gb: float
    ram_total_gb: float
    ram_usage_percent: float
    gpu_usage_percent: float | None = None
    gpu_memory_used_mb: float | None = None
    gpu_memory_total_mb: float | None = None
    gpu_temperature_c: float | None = None
    gpu_devices: list[GpuDeviceMetrics] = Field(default_factory=list)
    active_models: int


class LogResponse(BaseModel):
    model_id: str
    path: str
    lines: list[str]


class HealthCheckResponse(BaseModel):
    model_id: str
    ok: bool
    status_code: int | None = None
    detail: str
    latency_ms: float | None = None
    checked_at: datetime


class ApiMessage(BaseModel):
    message: str

