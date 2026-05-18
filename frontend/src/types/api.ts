export type ProviderType = "wsl_llama_cpp" | "windows_llama_cpp" | "ollama" | "openai_compatible";
export type ModelProvider = ProviderType;
export type ModelStatus =
  | "stopped"
  | "starting"
  | "running"
  | "warming"
  | "stopping"
  | "unhealthy"
  | "crashed"
  | "error";

export interface ProfileConfig {
  id: string;
  name: string;
  model_path?: string | null;
  context_size: number;
  batch_size: number;
  ubatch_size: number;
  n_gpu_layers?: number | null;
  parallel?: number | null;
  cache_ram?: number | null;
  repeat_penalty?: number | null;
  threads?: number | null;
  threads_batch?: number | null;
  api_default_completion_max_tokens?: number | null;
  temperature: number;
  top_p: number;
  top_k: number;
  min_p: number;
  cache_prompt: boolean;
  cache_reuse: number | null;
  cache_type_k: string | null;
  cache_type_v: string | null;
  flash_attn?: boolean | null;
  jinja?: boolean;
  no_mmap?: boolean;
  mlock?: boolean;
  override_tensor?: string | null;
  reasoning_format?: string | null;
  extra_args: string[];
}

export interface LaunchConfig {
  managed: boolean;
  command: string[];
  stop_command?: string[] | null;
  restart_command?: string[] | null;
  working_dir?: string | null;
  environment: Record<string, string>;
  shell: boolean;
  ready_timeout_seconds: number;
}

export interface ModelSettings {
  allow_start_stop: boolean;
  auto_restart: boolean;
  health_enabled: boolean;
  health_interval_seconds: number;
  startup_grace_seconds: number;
  request_timeout_seconds: number;
  log_tail_lines: number;
  keep_alive?: string | null;
}

export interface ModelResourceUsage {
  attribution: string;
  confidence: string;
  cpu_percent?: number | null;
  ram_mb?: number | null;
  memory_percent?: number | null;
  vram_mb?: number | null;
  gpu_percent?: number | null;
  disk_read_mb_s?: number | null;
  disk_write_mb_s?: number | null;
  process_count: number;
  pids: number[];
  note?: string | null;
  updated_at?: string | null;
}

export interface ModelArtifactInfo {
  file_name?: string | null;
  path?: string | null;
  family?: string | null;
  quantization?: string | null;
  format?: string | null;
  source: string;
}

export interface DiscoveredModelArtifact {
  provider: ProviderType;
  source: string;
  path: string;
  launch_path: string;
  file_name: string;
  family?: string | null;
  size_label?: string | null;
  quantization?: string | null;
  format: string;
  size_bytes?: number | null;
  suggested_id: string;
  suggested_name: string;
}

export interface RuntimeSetupCheck {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail" | "info";
  detail: string;
}

export interface RuntimeSetupCheckResponse {
  os: string;
  models_dir: string;
  llama_server_candidates: string[];
  path_has_llama_server: boolean;
  checks: RuntimeSetupCheck[];
}

export interface CreateModelRequest {
  provider: ProviderType;
  name: string;
  model_path: string;
  llama_server_path?: string | null;
  port: number;
  host: string;
  modality: "llm" | "vlm";
  family?: string | null;
  size_label?: string | null;
  quantization?: string | null;
  wsl_distro: string;
  description?: string | null;
  context_size: number;
  batch_size: number;
  ubatch_size: number;
  temperature: number;
  top_p: number;
  top_k: number;
  min_p: number;
  cache_type_k?: string | null;
  cache_type_v?: string | null;
  extra_args: string[];
}

export interface BulkImportModelsRequest {
  query?: string | null;
  limit?: number;
  provider?: ProviderType | null;
  llama_server_path?: string | null;
  host?: string;
  start_port?: number;
  context_size?: number;
  batch_size?: number;
  ubatch_size?: number;
}

export interface BulkImportModelsResponse {
  scanned: number;
  created: ModelView[];
  skipped: DiscoveredModelArtifact[];
  errors: Array<{ path: string; message: string }>;
}

export interface AppUpdateResponse {
  current_version: string;
  latest_version?: string | null;
  update_available: boolean;
  release_url?: string | null;
  installer_url?: string | null;
  source_install: boolean;
  checked_at: string;
  message: string;
}

export interface LlamaCppInstallRequest {
  variant?: "cpu" | "cuda";
  force?: boolean;
}

export interface LlamaCppRuntimeStatus {
  status: "idle" | "queued" | "downloading" | "extracting" | "installed" | "failed";
  variant: "cpu" | "cuda";
  version?: string | null;
  install_dir?: string | null;
  llama_server_path?: string | null;
  progress_percent: number;
  message: string;
  error?: string | null;
  updated_at: string;
}

export interface ModelDoctorCheck {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail" | "info";
  detail: string;
  action?: string | null;
  fix_summary?: string | null;
  undo_hint?: string | null;
  confidence?: "low" | "medium" | "high";
}

export interface ModelDoctorResponse {
  model_id: string;
  status: "ready" | "attention" | "blocked";
  summary: string;
  checks: ModelDoctorCheck[];
  recommended_actions: string[];
}

export interface ModelDoctorFixRequest {
  action: "change_port" | "switch_windows_runtime" | "switch_wsl_runtime" | "set_llama_server_path" | "set_model_path";
  value?: string | number | null;
}

export interface TestLaunchResponse {
  ok: boolean;
  summary: string;
  checks: RuntimeSetupCheck[];
  llama_server_path?: string | null;
}

export interface AutopilotReadinessItem {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail" | "info";
  detail: string;
  fix_action?: string | null;
}

export interface AutopilotReadinessResponse {
  score_percent: number;
  summary: string;
  hardware_class: string;
  recommended_runtime: ModelProvider;
  recommended_profile: string;
  bottlenecks: string[];
  items: AutopilotReadinessItem[];
}

export interface AutopilotStarterPlanRequest {
  use_case: "chat" | "coding" | "small_fast";
  runtime?: ModelProvider | null;
}

export interface AutopilotStarterPlanResponse {
  name: string;
  repo_id: string;
  filename: string;
  download_url: string;
  size_bytes?: number | null;
  quantization?: string | null;
  why: string;
  create_model: CreateModelRequest;
}

export interface AutopilotActionLogEntry {
  id: string;
  timestamp: string;
  action: string;
  status: "planned" | "running" | "completed" | "failed";
  summary: string;
  details: string[];
  undo_hint?: string | null;
  confidence: "low" | "medium" | "high";
}

export interface AutopilotActionLogRequest {
  action: string;
  status: "planned" | "running" | "completed" | "failed";
  summary: string;
  details: string[];
  undo_hint?: string | null;
  confidence: "low" | "medium" | "high";
}

export interface AutopilotSmokeTestResponse {
  model_id: string;
  ok: boolean;
  summary: string;
  latency_ms?: number | null;
  tokens_per_second?: number | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  error?: string | null;
}

export interface ModelLibraryFile {
  filename: string;
  size_bytes?: number | null;
  quantization?: string | null;
  download_url: string;
}

export interface ModelLibraryEntry {
  id: string;
  name: string;
  repo_id: string;
  description?: string | null;
  tags: string[];
  likes?: number | null;
  downloads?: number | null;
  files: ModelLibraryFile[];
}

export interface ModelLibrarySearchResponse {
  query: string;
  entries: ModelLibraryEntry[];
}

export interface ResolveModelReferenceRequest {
  reference: string;
}

export interface ModelDownloadRequest {
  url?: string | null;
  repo_id?: string | null;
  filename?: string | null;
  revision?: string;
  target_dir?: string | null;
  name?: string | null;
}

export interface ModelDownloadStatus {
  id: string;
  status: "queued" | "downloading" | "completed" | "cancelled" | "failed";
  label: string;
  url: string;
  file_name: string;
  target_path: string;
  bytes_downloaded: number;
  total_bytes?: number | null;
  progress_percent: number;
  error?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApplyBenchmarkProfileRequest {
  name?: string | null;
  launch_params: Record<string, unknown>;
  final_recommended_launch?: string | null;
  activate?: boolean;
}

export interface ModelResourceHistoryPoint {
  timestamp: string;
  model_id: string;
  model_name: string;
  status: ModelStatus;
  cpu_percent?: number | null;
  ram_mb?: number | null;
  memory_percent?: number | null;
  vram_mb?: number | null;
  gpu_percent?: number | null;
  disk_read_mb_s?: number | null;
  disk_write_mb_s?: number | null;
  attribution: string;
  confidence: string;
}

export interface RuntimeState {
  status: ModelStatus;
  pid?: number | null;
  managed: boolean;
  started_at?: string | null;
  stopped_at?: string | null;
  exit_code?: number | null;
  last_error?: string | null;
  last_health_check?: string | null;
  health_ok?: boolean | null;
  health_latency_ms?: number | null;
  crash_count: number;
  last_transition_reason?: string | null;
  details: Record<string, unknown>;
  resource_usage: ModelResourceUsage;
}

export interface ModelPricing {
  input: number; // Price per million input tokens
  output: number; // Price per million output tokens
}

export interface ModelView {
  id: string;
  name: string;
  provider: ProviderType;
  modality: "llm" | "vlm";
  description: string;
  endpoint: string;
  health_url?: string | null;
  metadata: Record<string, string | number | boolean | string[]>;
  launch: LaunchConfig;
  profiles: ProfileConfig[];
  active_profile_id?: string | null;
  active_profile?: ProfileConfig | null;
  settings: ModelSettings;
  log_path?: string | null;
  runtime: RuntimeState;
  artifact: ModelArtifactInfo;
  supported_actions: string[];
  pricing?: ModelPricing;
}

export interface ConfigModel {
  id: string;
  name: string;
  provider: ProviderType;
  modality: "llm" | "vlm";
  description: string;
  endpoint: string;
  health_url?: string | null;
  metadata: Record<string, string | number | boolean | string[]>;
  launch: LaunchConfig;
  profiles: ProfileConfig[];
  active_profile_id?: string | null;
  settings: ModelSettings;
  log_path?: string | null;
}

export interface GpuDeviceMetrics {
  index: number;
  name: string;
  usage_percent?: number | null;
  memory_used_mb?: number | null;
  memory_free_mb?: number | null;
  memory_total_mb?: number | null;
  temperature_c?: number | null;
  fan_speed_percent?: number | null;
  power_draw_w?: number | null;
  power_limit_w?: number | null;
}

export interface CpuCoreMetrics {
  index: number;
  usage_percent: number;
  frequency_mhz?: number | null;
}

export interface CpuCacheMetrics {
  l1d?: string | null;
  l1i?: string | null;
  l2?: string | null;
  l3?: string | null;
}

export interface MemoryBreakdown {
  total_gb: number;
  used_gb: number;
  available_gb: number;
  free_gb: number;
  buffers_gb?: number | null;
  cached_gb?: number | null;
  shared_gb?: number | null;
  slab_gb?: number | null;
  usage_percent: number;
}

export interface DiskPartitionMetrics {
  device: string;
  mountpoint: string;
  fstype: string;
  total_gb: number;
  used_gb: number;
  free_gb: number;
  usage_percent: number;
}

export interface NetworkInterfaceMetrics {
  name: string;
  is_up: boolean;
  speed_mbps?: number | null;
  addresses: string[];
}

export interface ProcessMetric {
  pid: number;
  name: string;
  cpu_percent: number;
  memory_percent: number;
  memory_mb: number;
  status?: string | null;
  command?: string | null;
}

export interface MetricHistoryPoint {
  timestamp: string;
  cpu_usage_percent: number;
  ram_usage_percent: number;
  gpu_usage_percent?: number | null;
  gpu_memory_used_mb?: number | null;
  disk_read_mb_s: number;
  disk_write_mb_s: number;
  network_rx_mbps: number;
  network_tx_mbps: number;
}

export interface SystemMetricsResponse {
  timestamp: string;
  cpu_usage_percent: number;
  cpu_physical_cores?: number | null;
  cpu_logical_cores?: number | null;
  cpu_hyper_threading_enabled?: boolean | null;
  cpu_frequency_mhz?: number | null;
  cpu_temperature_c?: number | null;
  cpu_cores: CpuCoreMetrics[];
  cpu_cache: CpuCacheMetrics;
  ram_used_gb: number;
  ram_total_gb: number;
  ram_usage_percent: number;
  memory: MemoryBreakdown;
  gpu_usage_percent?: number | null;
  gpu_memory_used_mb?: number | null;
  gpu_memory_free_mb?: number | null;
  gpu_memory_total_mb?: number | null;
  gpu_temperature_c?: number | null;
  gpu_devices: GpuDeviceMetrics[];
  disk_read_mb_s: number;
  disk_write_mb_s: number;
  disk_partitions: DiskPartitionMetrics[];
  network_rx_mbps: number;
  network_tx_mbps: number;
  active_tcp_connections: number;
  network_interfaces: NetworkInterfaceMetrics[];
  top_processes: ProcessMetric[];
  model_processes: ProcessMetric[];
  history: MetricHistoryPoint[];
  active_models: number;
}

export interface LogResponse {
  model_id: string;
  path: string;
  lines: string[];
}

export interface HealthCheckResponse {
  model_id: string;
  ok: boolean;
  status_code?: number | null;
  detail: string;
  latency_ms?: number | null;
  checked_at: string;
}

export interface AppConfig {
  app_name: string;
  version: string;
  refresh_interval_seconds: number;
  models: ConfigModel[];
}

export interface ChatAttachment {
  name: string;
  mime_type: string;
  data_url?: string | null;
  text?: string | null;
}

export interface ChatMessagePayload {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionRequest {
  model_id: string;
  messages: ChatMessagePayload[];
  attachments: ChatAttachment[];
  temperature?: number | null;
  top_p?: number | null;
  max_tokens?: number;
  timeout_seconds?: number;
  enable_web_search?: boolean;
  web_search_provider?: "duckduckgo" | "tavily";
  web_search_results?: number;
}

export interface ChatCompletionResponse {
  model_id: string;
  model_name: string;
  content: string;
  thinking_content?: string | null;
  thinking_tokens_estimate?: number | null;
  created_at: string;
  finish_reason?: string | null;
  truncated: boolean;
  max_tokens: number;
}

export type ChatStreamEvent =
  | { type: "delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "done"; response: ChatCompletionResponse }
  | { type: "error"; detail: string };

export type BenchmarkWorkflowMode = "single" | "smart_auto" | "exhaustive" | "compare";
export type BenchmarkSuite = "quick" | "full" | "stress" | "short_chat" | "coding" | "long_reasoning" | "mixed" | "vision";
export type BenchmarkOptimizeFor = "max_toks" | "lowest_ttft" | "balanced" | "long_context" | "coding" | "vision";

export interface BenchmarkRunRequest {
  mode: "quick" | "full" | "autotune";
  workflow_mode?: BenchmarkWorkflowMode | null;
  suite?: BenchmarkSuite | null;
  optimize_for?: BenchmarkOptimizeFor;
  max_tokens: number;
  timeout_seconds: number;
  repetitions: number;
  startup_wait_seconds?: number;
  stop_after?: boolean;
  autotune_max_configs?: number;
  max_tests?: number;
  max_time_minutes?: number;
  repeats_per_config?: number;
  warmup_runs?: number;
  ctx_values?: number[];
  batch_values?: number[];
  ubatch_values?: number[];
  cache_type_modes?: string[];
  flash_attn_modes?: string[];
  threads_values?: number[];
  threads_batch_values?: number[];
  compare_run_ids?: string[];
}

export interface BenchmarkStageResult {
  name: string;
  ok: boolean;
  duration_ms: number;
  ttft_ms?: number | null;
  generated_tokens_estimate?: number | null;
  tokens_per_second?: number | null;
  prompt_tokens_estimate?: number | null;
  prompt_tokens_per_second?: number | null;
  thinking_tokens_estimate?: number | null;
  answer_tokens_estimate?: number | null;
  thinking_ratio_percent?: number | null;
  error?: string | null;
  response_text?: string | null;
}

export interface BenchmarkEvent {
  timestamp: string;
  level: "info" | "warning" | "error" | string;
  stage: string;
  message: string;
}

export interface BenchmarkRecommendation {
  id: string;
  title: string;
  category: string;
  severity: "info" | "warning" | "danger" | string;
  summary: string;
  rationale: string;
  changes: string[];
  expected_impact?: string | null;
  confidence: string;
}

export interface BenchmarkCandidate {
  index?: number | null;
  label?: string | null;
  change?: string | null;
  probe_ok?: boolean | null;
  probe_error?: string | null;
  decode_tokens_per_second?: number | null;
  prefill_tokens_per_second?: number | null;
  ttft_ms?: number | null;
  generated_tokens_estimate?: number | null;
  command?: string | null;
  score?: number | null;
  selected?: boolean;
  [key: string]: unknown;
}

export interface BenchmarkCandidateGroup {
  id: string;
  title: string;
  selected?: string | null;
  candidates: BenchmarkCandidate[];
  [key: string]: unknown;
}

export interface BenchmarkSummaryCard {
  id: string;
  label: string;
  value?: string | number | boolean | null;
  unit?: string;
  [key: string]: unknown;
}

export interface BenchmarkRunStatus {
  id: string;
  model_id: string;
  model_name: string;
  mode: "quick" | "full" | "autotune";
  workflow_mode?: BenchmarkWorkflowMode | string;
  suite?: BenchmarkSuite | string;
  optimize_for?: BenchmarkOptimizeFor | string;
  status?: "queued" | "running" | "completed" | "failed" | "cancelled" | "cancelling" | string;
  progress_percent?: number;
  current_stage?: string;
  started_at: string;
  finished_at?: string | null;
  stable?: boolean | null;
  score_percent?: number | null;
  verdict?: string | null;
  summary: string;
  endpoint: string;
  model_file?: string | null;
  quantization?: string | null;
  launch_params: Record<string, unknown>;
  server_checks: Record<string, boolean>;
  nvidia_smi?: string | null;
  metrics_before: Record<string, unknown>;
  metrics_current?: Record<string, unknown>;
  metrics_after: Record<string, unknown>;
  stages: BenchmarkStageResult[];
  events?: BenchmarkEvent[];
  recommendations?: BenchmarkRecommendation[];
  report_path?: string | null;
  cancel_requested?: boolean;
  terminal_lines?: string[];
  run_log_lines?: string[];
  candidate_groups?: BenchmarkCandidateGroup[];
  selected_values?: Record<string, unknown>;
  leaderboard?: BenchmarkCandidate[];
  artifacts?: Record<string, unknown>;
  final_recommended_launch?: string | null;
  summary_cards?: BenchmarkSummaryCard[];
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinkingContent?: string | null;
  thinkingTokens?: number | null;
  thinkingMs?: number | null;
  createdAt: string;
  attachments?: ChatAttachment[];
  finishReason?: string | null;
  truncated?: boolean;
  maxTokens?: number;
}

export interface ChatSession {
  id: string;
  title: string;
  mode?: "chat";
  modelId: string | null;
  messages: ChatMessage[];
  updatedAt: string;
}

export type BenchmarkRunResponse = BenchmarkRunStatus;
