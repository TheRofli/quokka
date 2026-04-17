import type {
  AppConfig,
  HealthCheckResponse,
  LogResponse,
  ModelView,
  ProfileConfig,
  SystemMetricsResponse,
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
    let detail = response.statusText;
    try {
      const payload = await response.json();
      detail = payload.detail ?? payload.message ?? detail;
    } catch {
      // Ignore parse errors and keep the status text.
    }
    throw new Error(detail || "Unexpected API error");
  }

  return (await response.json()) as T;
}

export const api = {
  getMetrics: () => request<SystemMetricsResponse>("/system/metrics"),
  getModels: () => request<ModelView[]>("/models"),
  getModel: (modelId: string) => request<ModelView>(`/models/${modelId}`),
  startModel: (modelId: string) => request<ModelView>(`/models/${modelId}/start`, { method: "POST" }),
  stopModel: (modelId: string) => request<ModelView>(`/models/${modelId}/stop`, { method: "POST" }),
  restartModel: (modelId: string) => request<ModelView>(`/models/${modelId}/restart`, { method: "POST" }),
  getLogs: (modelId: string, limit = 200) => request<LogResponse>(`/models/${modelId}/logs?limit=${limit}`),
  getHealth: (modelId: string) => request<HealthCheckResponse>(`/models/${modelId}/health`),
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
};
