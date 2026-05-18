import type {
  AppConfig,
  AppUpdateResponse,
  ApplyBenchmarkProfileRequest,
  AutopilotActionLogEntry,
  AutopilotActionLogRequest,
  AutopilotReadinessResponse,
  AutopilotSmokeTestResponse,
  AutopilotStarterPlanRequest,
  AutopilotStarterPlanResponse,
  BenchmarkRunRequest,
  BenchmarkRunResponse,
  BulkImportModelsRequest,
  BulkImportModelsResponse,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatStreamEvent,
  CreateModelRequest,
  DiscoveredModelArtifact,
  HealthCheckResponse,
  LogResponse,
  LlamaCppInstallRequest,
  LlamaCppRuntimeStatus,
  MetricHistoryPoint,
  ModelSettings,
  ModelDoctorFixRequest,
  ModelDoctorResponse,
  ModelDownloadRequest,
  ModelDownloadStatus,
  ModelLibraryEntry,
  ModelLibrarySearchResponse,
  ModelView,
  ProfileConfig,
  ResolveModelReferenceRequest,
  RuntimeSetupCheckResponse,
  SystemMetricsResponse,
  TestLaunchResponse,
} from "@/types/api";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (!response.ok) {
    let detail: unknown = response.statusText;
    try {
      const payload = await response.json();
      detail = payload.detail ?? payload.message ?? detail;
    } catch {
      // Ignore parse errors and keep the status text.
    }
    const message =
      typeof detail === "string"
        ? detail
        : detail
          ? JSON.stringify(detail)
          : "Unexpected API error";
    throw new Error(message);
  }

  return (await response.json()) as T;
}

async function streamRequest<TPayload>(
  path: string,
  payload: TPayload,
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    let detail: unknown = response.statusText;
    try {
      const payload = await response.json();
      detail = payload.detail ?? payload.message ?? detail;
    } catch {
      // Ignore parse errors and keep the status text.
    }
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }

  if (!response.body) {
    throw new Error("Streaming response did not include a body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const dispatchBlock = (block: string) => {
    const eventLine = block.split("\n").find((line) => line.startsWith("event:"));
    const dataLines = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    if (!eventLine || !dataLines.length) {
      return;
    }
    const eventName = eventLine.slice(6).trim();
    const data = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
    if (eventName === "delta") {
      onEvent({ type: "delta", delta: String(data.delta ?? "") });
    } else if (eventName === "thinking_delta") {
      onEvent({ type: "thinking_delta", delta: String(data.delta ?? "") });
    } else if (eventName === "done") {
      onEvent({ type: "done", response: data as unknown as ChatCompletionResponse });
    } else if (eventName === "error") {
      const detail = data.detail ?? "Streaming request failed.";
      onEvent({ type: "error", detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const blocks = buffer.split(/\n\n/);
    buffer = blocks.pop() ?? "";
    blocks.forEach(dispatchBlock);
    if (done) {
      break;
    }
  }

  if (buffer.trim()) {
    dispatchBlock(buffer);
  }
}

export const api = {
  getAutopilotReadiness: () => request<AutopilotReadinessResponse>("/autopilot/readiness"),
  createAutopilotStarterPlan: (payload: AutopilotStarterPlanRequest) =>
    request<AutopilotStarterPlanResponse>("/autopilot/plan/starter", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  getAutopilotActions: () => request<AutopilotActionLogEntry[]>("/autopilot/actions"),
  appendAutopilotAction: (payload: AutopilotActionLogRequest) =>
    request<AutopilotActionLogEntry>("/autopilot/actions", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  runAutopilotSmokeTest: (modelId: string) =>
    request<AutopilotSmokeTestResponse>(`/autopilot/smoke-test/${modelId}`, { method: "POST" }),
  getMetrics: () => request<SystemMetricsResponse>("/system/metrics"),
  getUpdateStatus: () => request<AppUpdateResponse>("/system/update"),
  getLlamaCppRuntimeStatus: () => request<LlamaCppRuntimeStatus>("/system/runtime/llama-cpp"),
  installLlamaCppRuntime: (payload: LlamaCppInstallRequest) =>
    request<LlamaCppRuntimeStatus>("/system/runtime/llama-cpp/install", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  createChatCompletion: (payload: ChatCompletionRequest) =>
    request<ChatCompletionResponse>("/chat/completion", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  streamChatCompletion: (payload: ChatCompletionRequest, onEvent: (event: ChatStreamEvent) => void, signal?: AbortSignal) =>
    streamRequest("/chat/completion/stream", payload, onEvent, signal),
  getMetricHistory: (minutes = 60) => request<MetricHistoryPoint[]>(`/system/metrics/history?minutes=${minutes}`),
  getModels: () => request<ModelView[]>("/models"),
  discoverModels: (query = "", limit = 80) =>
    request<DiscoveredModelArtifact[]>(`/models/discover?limit=${limit}${query ? `&query=${encodeURIComponent(query)}` : ""}`),
  createModel: (payload: CreateModelRequest) =>
    request<ModelView>("/models", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  bulkImportModels: (payload: BulkImportModelsRequest) =>
    request<BulkImportModelsResponse>("/models/bulk-import", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  getRuntimeSetupCheck: () => request<RuntimeSetupCheckResponse>("/models/runtime-check"),
  testModelLaunch: (payload: CreateModelRequest) =>
    request<TestLaunchResponse>("/models/test-launch", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  getModel: (modelId: string) => request<ModelView>(`/models/${modelId}`),
  deleteModel: (modelId: string, deleteFile = false) =>
    request<{ message: string }>(`/models/${modelId}?delete_file=${deleteFile ? "true" : "false"}`, { method: "DELETE" }),
  renameModel: (modelId: string, name: string) =>
    request<ModelView>(`/models/${modelId}/name`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),
  startModel: (modelId: string) => request<ModelView>(`/models/${modelId}/start`, { method: "POST" }),
  stopModel: (modelId: string) => request<ModelView>(`/models/${modelId}/stop`, { method: "POST" }),
  restartModel: (modelId: string) => request<ModelView>(`/models/${modelId}/restart`, { method: "POST" }),
  runBenchmark: (modelId: string, payload: BenchmarkRunRequest) =>
    request<BenchmarkRunResponse>(`/models/${modelId}/benchmark`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  startBenchmarkRun: (modelId: string, payload: BenchmarkRunRequest) =>
    request<BenchmarkRunResponse>(`/models/${modelId}/benchmark/runs`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  getBenchmarkRun: (modelId: string, runId: string) =>
    request<BenchmarkRunResponse>(`/models/${modelId}/benchmark/runs/${runId}`),
  cancelBenchmarkRun: (modelId: string, runId: string) =>
    request<BenchmarkRunResponse>(`/models/${modelId}/benchmark/runs/${runId}/cancel`, { method: "POST" }),
  updateModelSettings: (modelId: string, payload: ModelSettings) =>
    request<ModelView>(`/models/${modelId}/settings`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  getLogs: (modelId: string, limit = 200) => request<LogResponse>(`/models/${modelId}/logs?limit=${limit}`),
  clearLogs: (modelId: string) => request<LogResponse>(`/models/${modelId}/logs`, { method: "DELETE" }),
  getHealth: (modelId: string) => request<HealthCheckResponse>(`/models/${modelId}/health`),
  getModelDoctor: (modelId: string) => request<ModelDoctorResponse>(`/models/${modelId}/doctor`),
  applyModelDoctorFix: (modelId: string, payload: ModelDoctorFixRequest) =>
    request<ModelView>(`/models/${modelId}/doctor/fix`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  applyBenchmarkProfile: (modelId: string, payload: ApplyBenchmarkProfileRequest) =>
    request<ProfileConfig>(`/models/${modelId}/apply-benchmark-profile`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  getConfig: () => request<AppConfig>("/config"),
  saveConfig: (payload: AppConfig) =>
    request<AppConfig>("/config", {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  getProfiles: (modelId: string) => request<ProfileConfig[]>(`/models/${modelId}/profiles`),
  createProfile: (modelId: string, payload: ProfileConfig) =>
    request<ProfileConfig>(`/models/${modelId}/profiles`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateProfile: (modelId: string, profileId: string, payload: ProfileConfig) =>
    request<ProfileConfig>(`/models/${modelId}/profiles/${profileId}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  deleteProfile: (modelId: string, profileId: string) =>
    request<{ message: string }>(`/models/${modelId}/profiles/${profileId}`, {
      method: "DELETE",
    }),
  activateProfile: (modelId: string, profileId: string) =>
    request<ProfileConfig>(`/models/${modelId}/profiles/${profileId}/activate`, {
      method: "POST",
    }),
  getFeaturedLibraryModels: () => request<ModelLibraryEntry[]>("/library/featured"),
  searchLibraryModels: (query: string) => request<ModelLibrarySearchResponse>(`/library/search?query=${encodeURIComponent(query)}`),
  resolveLibraryReference: (payload: ResolveModelReferenceRequest) =>
    request<ModelLibraryEntry>("/library/resolve", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  startModelDownload: (payload: ModelDownloadRequest) =>
    request<ModelDownloadStatus>("/library/downloads", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  getModelDownloads: () => request<ModelDownloadStatus[]>("/library/downloads"),
  cancelModelDownload: (downloadId: string) =>
    request<ModelDownloadStatus>(`/library/downloads/${downloadId}/cancel`, { method: "POST" }),
};
