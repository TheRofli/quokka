from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

from app.domain.enums import ModelStatus, ProviderType
from app.schemas.config import LaunchConfig, ModelSettings, ProfileConfig


class ModelResourceUsage(BaseModel):
    attribution: str = "unavailable"
    confidence: str = "none"
    cpu_percent: float | None = None
    ram_mb: float | None = None
    memory_percent: float | None = None
    vram_mb: float | None = None
    gpu_percent: float | None = None
    disk_read_mb_s: float | None = None
    disk_write_mb_s: float | None = None
    process_count: int = 0
    pids: list[int] = Field(default_factory=list)
    note: str | None = None
    updated_at: datetime | None = None


class ModelArtifactInfo(BaseModel):
    file_name: str | None = None
    path: str | None = None
    family: str | None = None
    quantization: str | None = None
    format: str | None = None
    source: str = "unknown"


class DiscoveredModelArtifact(BaseModel):
    provider: ProviderType = ProviderType.WINDOWS_LLAMA_CPP
    source: str
    path: str
    launch_path: str
    file_name: str
    family: str | None = None
    size_label: str | None = None
    quantization: str | None = None
    format: str = "gguf"
    size_bytes: int | None = None
    suggested_id: str
    suggested_name: str


class CreateModelRequest(BaseModel):
    provider: ProviderType = ProviderType.WINDOWS_LLAMA_CPP
    name: str
    model_path: str
    llama_server_path: str | None = None
    port: int = Field(default=8080, ge=1, le=65535)
    host: str = "127.0.0.1"
    modality: str = "llm"
    family: str | None = None
    size_label: str | None = None
    quantization: str | None = None
    wsl_distro: str = "Ubuntu"
    description: str | None = None
    context_size: int = Field(default=8192, ge=256)
    batch_size: int = Field(default=512, ge=1)
    ubatch_size: int = Field(default=128, ge=1)
    temperature: float = Field(default=0.15, ge=0.0, le=2.0)
    top_p: float = Field(default=0.9, ge=0.0, le=1.0)
    top_k: int = Field(default=30, ge=1)
    min_p: float = Field(default=0.02, ge=0.0, le=1.0)
    cache_type_k: str | None = "q4_0"
    cache_type_v: str | None = "q4_0"
    extra_args: list[str] = Field(
        default_factory=lambda: [
            "--jinja",
            "--n-gpu-layers",
            "999",
            "--flash-attn",
            "on",
            "--parallel",
            "1",
            "--cache-ram",
            "0",
            "--no-mmap",
        ]
    )


class RenameModelRequest(BaseModel):
    name: str = Field(min_length=1, max_length=140)


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
    details: dict[str, Any] = Field(default_factory=dict)
    resource_usage: ModelResourceUsage = Field(default_factory=ModelResourceUsage)


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
    artifact: ModelArtifactInfo = Field(default_factory=ModelArtifactInfo)
    supported_actions: list[str]


class ChatAttachment(BaseModel):
    name: str
    mime_type: str
    data_url: str | None = None
    text: str | None = None


class ChatMessagePayload(BaseModel):
    role: str
    content: str


class ChatCompletionRequest(BaseModel):
    model_id: str
    messages: list[ChatMessagePayload]
    attachments: list[ChatAttachment] = Field(default_factory=list)
    temperature: float | None = None
    top_p: float | None = None
    max_tokens: int = Field(default=2048, ge=16, le=32768)
    timeout_seconds: float = Field(default=180, ge=5, le=1200)
    enable_web_search: bool = False
    web_search_provider: str = Field(default="duckduckgo", pattern="^(duckduckgo|tavily)$")
    web_search_results: int = Field(default=3, ge=1, le=10)


class ChatCompletionResponse(BaseModel):
    model_id: str
    model_name: str
    content: str
    thinking_content: str | None = None
    thinking_tokens_estimate: int | None = None
    created_at: datetime
    finish_reason: str | None = None
    truncated: bool = False
    max_tokens: int


class AgentSettings(BaseModel):
    agent_max_tokens: int = Field(default=4096, ge=256, le=32768)
    patch_max_tokens: int = Field(default=4096, ge=512, le=32768)
    context_budget_percent: int = Field(default=70, ge=10, le=95)
    auto_compact: bool = True
    keep_last_messages: int = Field(default=12, ge=2, le=80)
    file_context_limit_kb: int = Field(default=4096, ge=64, le=16384)
    approval_mode: str = Field(default="review", pattern="^(review|auto_readonly|manual)$")


class AgentRunRequest(BaseModel):
    model_id: str
    workspace_path: str
    prompt: str = Field(min_length=1, max_length=12000)
    attachments: list[ChatAttachment] = Field(default_factory=list)
    settings: AgentSettings = Field(default_factory=AgentSettings)


class AgentWorkspaceFile(BaseModel):
    path: str
    size_bytes: int
    included: bool = False
    reason: str | None = None


class AgentRunStep(BaseModel):
    title: str
    status: str = "completed"
    detail: str | None = None


class AgentRunResponse(BaseModel):
    id: str
    model_id: str
    model_name: str
    workspace_path: str
    created_at: datetime
    content: str
    thinking_content: str | None = None
    thinking_tokens_estimate: int | None = None
    used_context_tokens_estimate: int = 0
    context_budget_tokens: int = 0
    inspected_files: list[AgentWorkspaceFile] = Field(default_factory=list)
    included_files: list[AgentWorkspaceFile] = Field(default_factory=list)
    steps: list[AgentRunStep] = Field(default_factory=list)
    settings: AgentSettings = Field(default_factory=AgentSettings)
    warning: str | None = None


class AgentPlanItem(BaseModel):
    id: str
    title: str
    status: str = "queued"
    detail: str | None = None


class AgentRunEvent(BaseModel):
    id: str
    index: int
    timestamp: datetime
    type: str
    title: str
    detail: str | None = None
    status: str = "info"
    metadata: dict[str, Any] = Field(default_factory=dict)


class AgentRunMessage(BaseModel):
    id: str
    timestamp: datetime
    type: str
    content: str
    metadata: dict[str, Any] = Field(default_factory=dict)


class AgentApprovalRequest(BaseModel):
    action: str = Field(default="approve", pattern="^(approve|reject|generate_patch|apply|retry_patch)$")
    note: str | None = Field(default=None, max_length=2000)


class AgentWorkspaceReviewRequest(BaseModel):
    workspace_path: str


class AgentDiffFile(BaseModel):
    path: str
    status: str
    additions: int = 0
    deletions: int = 0
    binary: bool = False


class AgentWorkspaceReviewResponse(BaseModel):
    workspace_path: str
    is_git_repo: bool
    summary: str
    files: list[AgentDiffFile] = Field(default_factory=list)
    diff: str = ""
    status_lines: list[str] = Field(default_factory=list)
    insertions: int = 0
    deletions: int = 0
    error: str | None = None


class AgentRunStatusResponse(BaseModel):
    id: str
    status: str = "queued"
    prompt: str
    model_id: str
    model_name: str | None = None
    workspace_path: str
    created_at: datetime
    updated_at: datetime
    finished_at: datetime | None = None
    plan: list[AgentPlanItem] = Field(default_factory=list)
    events: list[AgentRunEvent] = Field(default_factory=list)
    messages: list[AgentRunMessage] = Field(default_factory=list)
    edits: list[AgentDiffFile] = Field(default_factory=list)
    patch_preview: AgentWorkspaceReviewResponse | None = None
    pending_patch_operations: list[dict[str, Any]] = Field(default_factory=list, exclude=True)
    result: AgentRunResponse | None = None
    review: AgentWorkspaceReviewResponse | None = None
    error: str | None = None
    approval_required: bool = False
    approval_status: str = "not_required"
    live_thinking: str | None = None
    live_content: str | None = None


class GpuDeviceMetrics(BaseModel):
    index: int
    name: str
    usage_percent: float | None = None
    memory_used_mb: float | None = None
    memory_free_mb: float | None = None
    memory_total_mb: float | None = None
    temperature_c: float | None = None
    fan_speed_percent: float | None = None
    power_draw_w: float | None = None
    power_limit_w: float | None = None


class CpuCoreMetrics(BaseModel):
    index: int
    usage_percent: float
    frequency_mhz: float | None = None


class CpuCacheMetrics(BaseModel):
    l1d: str | None = None
    l1i: str | None = None
    l2: str | None = None
    l3: str | None = None


class MemoryBreakdown(BaseModel):
    total_gb: float
    used_gb: float
    available_gb: float
    free_gb: float
    buffers_gb: float | None = None
    cached_gb: float | None = None
    shared_gb: float | None = None
    slab_gb: float | None = None
    usage_percent: float


class DiskPartitionMetrics(BaseModel):
    device: str
    mountpoint: str
    fstype: str
    total_gb: float
    used_gb: float
    free_gb: float
    usage_percent: float


class NetworkInterfaceMetrics(BaseModel):
    name: str
    is_up: bool
    speed_mbps: int | None = None
    addresses: list[str] = Field(default_factory=list)


class ProcessMetric(BaseModel):
    pid: int
    name: str
    cpu_percent: float
    memory_percent: float
    memory_mb: float
    status: str | None = None
    command: str | None = None


class MetricHistoryPoint(BaseModel):
    timestamp: datetime
    cpu_usage_percent: float
    ram_usage_percent: float
    gpu_usage_percent: float | None = None
    gpu_memory_used_mb: float | None = None
    disk_read_mb_s: float = 0.0
    disk_write_mb_s: float = 0.0
    network_rx_mbps: float = 0.0
    network_tx_mbps: float = 0.0


class SystemMetricsResponse(BaseModel):
    timestamp: datetime
    cpu_usage_percent: float
    cpu_physical_cores: int | None = None
    cpu_logical_cores: int | None = None
    cpu_hyper_threading_enabled: bool | None = None
    cpu_frequency_mhz: float | None = None
    cpu_temperature_c: float | None = None
    cpu_cores: list[CpuCoreMetrics] = Field(default_factory=list)
    cpu_cache: CpuCacheMetrics = Field(default_factory=CpuCacheMetrics)
    ram_used_gb: float
    ram_total_gb: float
    ram_usage_percent: float
    memory: MemoryBreakdown
    gpu_usage_percent: float | None = None
    gpu_memory_used_mb: float | None = None
    gpu_memory_free_mb: float | None = None
    gpu_memory_total_mb: float | None = None
    gpu_temperature_c: float | None = None
    gpu_devices: list[GpuDeviceMetrics] = Field(default_factory=list)
    disk_read_mb_s: float = 0.0
    disk_write_mb_s: float = 0.0
    disk_partitions: list[DiskPartitionMetrics] = Field(default_factory=list)
    network_rx_mbps: float = 0.0
    network_tx_mbps: float = 0.0
    active_tcp_connections: int = 0
    network_interfaces: list[NetworkInterfaceMetrics] = Field(default_factory=list)
    top_processes: list[ProcessMetric] = Field(default_factory=list)
    model_processes: list[ProcessMetric] = Field(default_factory=list)
    history: list[MetricHistoryPoint] = Field(default_factory=list)
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


class BenchmarkRunRequest(BaseModel):
    mode: str = Field(default="quick", pattern="^(quick|full|autotune)$")
    workflow_mode: str | None = Field(default=None, pattern="^(single|smart_auto|exhaustive|compare)$")
    suite: str | None = Field(default=None, pattern="^(quick|full|stress|short_chat|coding|long_reasoning|mixed|vision)$")
    optimize_for: str = Field(default="balanced", pattern="^(max_toks|lowest_ttft|balanced|long_context|coding|vision)$")
    max_tokens: int = Field(default=256, ge=16, le=4096)
    timeout_seconds: float = Field(default=180, ge=10, le=43200)
    repetitions: int = Field(default=5, ge=1, le=20)
    startup_wait_seconds: int = Field(default=900, ge=5, le=3600)
    stop_after: bool = True
    autotune_max_configs: int = Field(default=32, ge=1, le=240)
    max_tests: int = Field(default=40, ge=1, le=240)
    max_time_minutes: int = Field(default=15, ge=1, le=720)
    repeats_per_config: int = Field(default=3, ge=1, le=20)
    warmup_runs: int = Field(default=1, ge=0, le=10)
    ctx_values: list[int] = Field(default_factory=list)
    batch_values: list[int] = Field(default_factory=list)
    ubatch_values: list[int] = Field(default_factory=list)
    cache_type_modes: list[str] = Field(default_factory=list)
    flash_attn_modes: list[str] = Field(default_factory=list)
    threads_values: list[int] = Field(default_factory=list)
    threads_batch_values: list[int] = Field(default_factory=list)
    compare_run_ids: list[str] = Field(default_factory=list)


class BenchmarkStageResult(BaseModel):
    name: str
    ok: bool
    duration_ms: float
    ttft_ms: float | None = None
    generated_tokens_estimate: int | None = None
    tokens_per_second: float | None = None
    prompt_tokens_estimate: int | None = None
    prompt_tokens_per_second: float | None = None
    thinking_tokens_estimate: int | None = None
    answer_tokens_estimate: int | None = None
    thinking_ratio_percent: float | None = None
    error: str | None = None
    response_text: str | None = None


class BenchmarkEvent(BaseModel):
    timestamp: datetime
    level: str = "info"
    stage: str
    message: str


class BenchmarkRecommendation(BaseModel):
    id: str
    title: str
    category: str
    severity: str = "info"
    summary: str
    rationale: str
    changes: list[str] = Field(default_factory=list)
    expected_impact: str | None = None
    confidence: str = "medium"


class BenchmarkRunStatus(BaseModel):
    id: str
    model_id: str
    model_name: str
    mode: str
    workflow_mode: str = "single"
    suite: str = "quick"
    optimize_for: str = "balanced"
    status: str = "queued"
    progress_percent: float = 0.0
    current_stage: str = "Queued"
    started_at: datetime
    finished_at: datetime | None = None
    stable: bool | None = None
    score_percent: float | None = None
    verdict: str | None = None
    summary: str = "Benchmark is queued."
    endpoint: str
    model_file: str | None = None
    quantization: str | None = None
    launch_params: dict[str, Any] = Field(default_factory=dict)
    server_checks: dict[str, bool] = Field(default_factory=dict)
    nvidia_smi: str | None = None
    metrics_before: dict[str, Any] = Field(default_factory=dict)
    metrics_current: dict[str, Any] = Field(default_factory=dict)
    metrics_after: dict[str, Any] = Field(default_factory=dict)
    stages: list[BenchmarkStageResult] = Field(default_factory=list)
    events: list[BenchmarkEvent] = Field(default_factory=list)
    recommendations: list[BenchmarkRecommendation] = Field(default_factory=list)
    report_path: str | None = None
    cancel_requested: bool = False
    terminal_lines: list[str] = Field(default_factory=list)
    run_log_lines: list[str] = Field(default_factory=list)
    candidate_groups: list[dict[str, Any]] = Field(default_factory=list)
    selected_values: dict[str, Any] = Field(default_factory=dict)
    leaderboard: list[dict[str, Any]] = Field(default_factory=list)
    artifacts: dict[str, Any] = Field(default_factory=dict)
    final_recommended_launch: str | None = None
    summary_cards: list[dict[str, Any]] = Field(default_factory=list)


class BenchmarkRunResponse(BaseModel):
    id: str
    model_id: str
    model_name: str
    mode: str
    workflow_mode: str = "single"
    suite: str = "quick"
    optimize_for: str = "balanced"
    started_at: datetime
    finished_at: datetime
    stable: bool
    score_percent: float | None = None
    verdict: str | None = None
    summary: str
    endpoint: str
    model_file: str | None = None
    quantization: str | None = None
    launch_params: dict[str, Any] = Field(default_factory=dict)
    server_checks: dict[str, bool] = Field(default_factory=dict)
    nvidia_smi: str | None = None
    metrics_before: dict[str, Any] = Field(default_factory=dict)
    metrics_after: dict[str, Any] = Field(default_factory=dict)
    stages: list[BenchmarkStageResult] = Field(default_factory=list)
    recommendations: list[BenchmarkRecommendation] = Field(default_factory=list)
    report_path: str | None = None
    terminal_lines: list[str] = Field(default_factory=list)
    run_log_lines: list[str] = Field(default_factory=list)
    candidate_groups: list[dict[str, Any]] = Field(default_factory=list)
    selected_values: dict[str, Any] = Field(default_factory=dict)
    leaderboard: list[dict[str, Any]] = Field(default_factory=list)
    artifacts: dict[str, Any] = Field(default_factory=dict)
    final_recommended_launch: str | None = None
    summary_cards: list[dict[str, Any]] = Field(default_factory=list)


class ApiMessage(BaseModel):
    message: str
