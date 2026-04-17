export type ProviderType = "wsl_llama_cpp" | "ollama" | "openai_compatible";
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
  context_size: number;
  batch_size: number;
  ubatch_size: number;
  temperature: number;
  top_p: number;
  top_k: number;
  min_p: number;
  cache_prompt: boolean;
  cache_reuse: number | null;
  cache_type_k: string | null;
  cache_type_v: string | null;
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
  details: Record<string, string>;
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
  supported_actions: string[];
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
  memory_total_mb?: number | null;
  temperature_c?: number | null;
}

export interface SystemMetricsResponse {
  timestamp: string;
  cpu_usage_percent: number;
  ram_used_gb: number;
  ram_total_gb: number;
  ram_usage_percent: number;
  gpu_usage_percent?: number | null;
  gpu_memory_used_mb?: number | null;
  gpu_memory_total_mb?: number | null;
  gpu_temperature_c?: number | null;
  gpu_devices: GpuDeviceMetrics[];
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
