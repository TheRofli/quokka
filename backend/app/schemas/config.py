from __future__ import annotations

from pydantic import BaseModel, Field, field_validator

from app.domain.enums import ProviderType


class ProfileConfig(BaseModel):
    id: str
    name: str
    model_path: str | None = None
    context_size: int = Field(default=8192, ge=256)
    batch_size: int = Field(default=512, ge=1)
    ubatch_size: int = Field(default=128, ge=1)
    n_gpu_layers: int | None = Field(default=None, ge=0)
    parallel: int | None = Field(default=None, ge=1)
    cache_ram: int | None = Field(default=None, ge=0)
    repeat_penalty: float | None = Field(default=None, ge=0.0)
    threads: int | None = Field(default=None, ge=1)
    threads_batch: int | None = Field(default=None, ge=1)
    api_default_completion_max_tokens: int | None = Field(default=None, ge=1)
    temperature: float = Field(default=0.2, ge=0.0, le=2.0)
    top_p: float = Field(default=0.95, ge=0.0, le=1.0)
    top_k: int = Field(default=40, ge=1)
    min_p: float = Field(default=0.05, ge=0.0, le=1.0)
    cache_prompt: bool = True
    cache_reuse: int | None = Field(default=256, ge=0)
    cache_type_k: str | None = "q8_0"
    cache_type_v: str | None = "q8_0"
    flash_attn: bool | None = None
    jinja: bool = False
    no_mmap: bool = False
    mlock: bool = False
    override_tensor: str | None = None
    reasoning_format: str | None = None
    extra_args: list[str] = Field(default_factory=list)


class LaunchConfig(BaseModel):
    managed: bool = True
    command: list[str] = Field(default_factory=list)
    stop_command: list[str] | None = None
    restart_command: list[str] | None = None
    working_dir: str | None = None
    environment: dict[str, str] = Field(default_factory=dict)
    shell: bool = False
    ready_timeout_seconds: int = Field(default=120, ge=5)


class ModelSettings(BaseModel):
    allow_start_stop: bool = True
    auto_restart: bool = False
    health_enabled: bool = True
    health_interval_seconds: int = Field(default=10, ge=2)
    startup_grace_seconds: int = Field(default=20, ge=0)
    request_timeout_seconds: int = Field(default=5, ge=1)
    log_tail_lines: int = Field(default=200, ge=20)
    keep_alive: str | None = "15m"


class ModelConfig(BaseModel):
    id: str
    name: str
    provider: ProviderType
    modality: str = Field(default="llm")
    description: str = ""
    endpoint: str
    health_url: str | None = None
    metadata: dict[str, str | int | float | bool | list[str]] = Field(default_factory=dict)
    launch: LaunchConfig = Field(default_factory=LaunchConfig)
    profiles: list[ProfileConfig] = Field(default_factory=list)
    active_profile_id: str | None = None
    settings: ModelSettings = Field(default_factory=ModelSettings)
    log_path: str | None = None

    @field_validator("modality")
    @classmethod
    def validate_modality(cls, value: str) -> str:
        supported = {"llm", "vlm"}
        normalized = value.lower().strip()
        if normalized not in supported:
            raise ValueError(f"Unsupported modality '{value}'. Expected one of {sorted(supported)}.")
        return normalized

    def get_active_profile(self) -> ProfileConfig | None:
        if not self.profiles:
            return None

        requested_id = self.active_profile_id or self.profiles[0].id
        for profile in self.profiles:
            if profile.id == requested_id:
                return profile
        return self.profiles[0]


class AppConfig(BaseModel):
    app_name: str = "Quokka"
    version: str = "0.2.0"
    refresh_interval_seconds: int = Field(default=5, ge=2)
    models: list[ModelConfig] = Field(default_factory=list)
