import { useCallback, useEffect, useMemo, useState } from "react";

import { api } from "@/api/client";
import type {
  AppConfig,
  HealthCheckResponse,
  LogResponse,
  MetricHistoryPoint,
  ModelResourceHistoryPoint,
  ModelSettings,
  ModelView,
  ProfileConfig,
  SystemMetricsResponse,
} from "@/types/api";

const DEFAULT_LOGS: LogResponse = { model_id: "", path: "", lines: [] };
const MODEL_RESOURCE_HISTORY_MS = 24 * 60 * 60 * 1000;

export function useQuokkaDashboard() {
  const [metrics, setMetrics] = useState<SystemMetricsResponse | null>(null);
  const [metricHistory, setMetricHistory] = useState<MetricHistoryPoint[]>([]);
  const [models, setModels] = useState<ModelView[]>([]);
  const [modelResourceHistory, setModelResourceHistory] = useState<ModelResourceHistoryPoint[]>([]);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [logs, setLogs] = useState<LogResponse>(DEFAULT_LOGS);
  const [health, setHealth] = useState<HealthCheckResponse | null>(null);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyModelIds, setBusyModelIds] = useState<Record<string, boolean>>({});

  const selectedModel = useMemo(() => {
    if (selectedModelId) {
      return models.find((model) => model.id === selectedModelId) ?? null;
    }
    return models[0] ?? null;
  }, [models, selectedModelId]);

  const markBusy = useCallback((modelId: string, busy: boolean) => {
    setBusyModelIds((current) => ({ ...current, [modelId]: busy }));
  }, []);

  const refreshDashboard = useCallback(async () => {
    try {
      const [nextMetrics, nextModels, nextConfig, nextMetricHistory] = await Promise.all([
        api.getMetrics(),
        api.getModels(),
        api.getConfig(),
        api.getMetricHistory(24 * 60),
      ]);
      setMetrics(nextMetrics);
      setMetricHistory(nextMetricHistory);
      setModels(nextModels);
      setConfig(nextConfig);
      setModelResourceHistory((current) => {
        const timestamp = nextMetrics.timestamp ?? new Date().toISOString();
        const nextSamples = nextModels.map((model) => ({
          timestamp,
          model_id: model.id,
          model_name: model.name,
          status: model.runtime.status,
          cpu_percent: model.runtime.resource_usage?.cpu_percent ?? null,
          ram_mb: model.runtime.resource_usage?.ram_mb ?? null,
          memory_percent: model.runtime.resource_usage?.memory_percent ?? null,
          vram_mb: model.runtime.resource_usage?.vram_mb ?? null,
          gpu_percent: model.runtime.resource_usage?.gpu_percent ?? null,
          disk_read_mb_s: model.runtime.resource_usage?.disk_read_mb_s ?? null,
          disk_write_mb_s: model.runtime.resource_usage?.disk_write_mb_s ?? null,
          attribution: model.runtime.resource_usage?.attribution ?? "unavailable",
          confidence: model.runtime.resource_usage?.confidence ?? "none",
        }));
        const cutoff = Date.now() - MODEL_RESOURCE_HISTORY_MS;
        return [...current, ...nextSamples].filter((point) => {
          const time = new Date(point.timestamp).getTime();
          return Number.isFinite(time) && time >= cutoff;
        });
      });
      setSelectedModelId((current) => current ?? nextModels[0]?.id ?? null);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to reach Quokka API");
    } finally {
      setIsLoading(false);
    }
  }, []);

  const refreshLogs = useCallback(
    async (modelId?: string | null) => {
      if (!modelId) {
        setLogs(DEFAULT_LOGS);
        return;
      }

      try {
        const nextLogs = await api.getLogs(modelId, 300);
        setLogs(nextLogs);
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed to load logs");
      }
    },
    []
  );

  const refreshHealth = useCallback(async (modelId?: string | null) => {
    if (!modelId) {
      setHealth(null);
      return;
    }

    try {
      const nextHealth = await api.getHealth(modelId);
      setHealth(nextHealth);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to check model health");
    }
  }, []);

  useEffect(() => {
    void refreshDashboard();
    const intervalId = window.setInterval(() => {
      void refreshDashboard();
    }, 5000);
    return () => window.clearInterval(intervalId);
  }, [refreshDashboard]);

  useEffect(() => {
    void refreshLogs(selectedModelId);
    void refreshHealth(selectedModelId);
    const intervalId = window.setInterval(() => {
      void refreshLogs(selectedModelId);
      void refreshHealth(selectedModelId);
    }, 2500);
    return () => window.clearInterval(intervalId);
  }, [refreshHealth, refreshLogs, selectedModelId]);

  const runModelAction = useCallback(
    async (modelId: string, action: "start" | "stop" | "restart") => {
      markBusy(modelId, true);
      try {
        if (action === "start") {
          await api.startModel(modelId);
        } else if (action === "stop") {
          await api.stopModel(modelId);
        } else {
          await api.restartModel(modelId);
        }
        await refreshDashboard();
        await refreshLogs(modelId);
        await refreshHealth(modelId);
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : `Failed to ${action} model`);
      } finally {
        markBusy(modelId, false);
      }
    },
    [markBusy, refreshDashboard, refreshHealth, refreshLogs]
  );

  const updateModelSettings = useCallback(
    async (modelId: string, settings: ModelSettings) => {
      try {
        const updated = await api.updateModelSettings(modelId, settings);
        setModels((current) => current.map((model) => (model.id === modelId ? updated : model)));
        setConfig((current) => {
          if (!current) {
            return current;
          }
          return {
            ...current,
            models: current.models.map((model) => (model.id === modelId ? { ...model, settings: updated.settings } : model)),
          };
        });
        setError(null);
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed to update model settings");
      }
    },
    []
  );

  const saveRawConfig = useCallback(
    async (payload: AppConfig) => {
      try {
        const saved = await api.saveConfig(payload);
        setConfig(saved);
        await refreshDashboard();
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed to save config");
      }
    },
    [refreshDashboard]
  );

  const saveProfile = useCallback(
    async (modelId: string, profile: ProfileConfig, isNew: boolean) => {
      try {
        if (isNew) {
          await api.createProfile(modelId, profile);
        } else {
          await api.updateProfile(modelId, profile.id, profile);
        }
        await refreshDashboard();
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed to save profile");
      }
    },
    [refreshDashboard]
  );

  const deleteProfile = useCallback(
    async (modelId: string, profileId: string) => {
      try {
        await api.deleteProfile(modelId, profileId);
        await refreshDashboard();
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed to delete profile");
      }
    },
    [refreshDashboard]
  );

  const deleteModel = useCallback(
    async (modelId: string, deleteFile = false) => {
      try {
        await api.deleteModel(modelId, deleteFile);
        setSelectedModelId((current) => (current === modelId ? null : current));
        await refreshDashboard();
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed to delete model");
      }
    },
    [refreshDashboard]
  );

  const renameModel = useCallback(async (modelId: string, name: string) => {
    try {
      const updated = await api.renameModel(modelId, name);
      setModels((current) => current.map((model) => (model.id === modelId ? updated : model)));
      setConfig((current) => {
        if (!current) {
          return current;
        }
        return {
          ...current,
          models: current.models.map((model) => (model.id === modelId ? { ...model, name: updated.name } : model)),
        };
      });
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to rename model");
    }
  }, []);

  const clearLogs = useCallback(async (modelId: string) => {
    try {
      const nextLogs = await api.clearLogs(modelId);
      setLogs(nextLogs);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to clear logs");
    }
  }, []);

  const activateProfile = useCallback(
    async (modelId: string, profileId: string) => {
      try {
        await api.activateProfile(modelId, profileId);
        await refreshDashboard();
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed to activate profile");
      }
    },
    [refreshDashboard]
  );

  return {
    metrics,
    metricHistory,
    models,
    modelResourceHistory,
    config,
    logs,
    health,
    error,
    isLoading,
    selectedModel,
    selectedModelId,
    busyModelIds,
    setSelectedModelId,
    refreshDashboard,
    refreshLogs,
    refreshHealth,
    runModelAction,
    updateModelSettings,
    saveRawConfig,
    saveProfile,
    deleteProfile,
    deleteModel,
    renameModel,
    clearLogs,
    activateProfile,
  };
}
