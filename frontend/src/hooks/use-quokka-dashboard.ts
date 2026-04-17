import { useCallback, useEffect, useMemo, useState } from "react";

import { api } from "@/api/client";
import type { AppConfig, HealthCheckResponse, LogResponse, ModelView, ProfileConfig, SystemMetricsResponse } from "@/types/api";

const DEFAULT_LOGS: LogResponse = { model_id: "", path: "", lines: [] };

export function useQuokkaDashboard() {
  const [metrics, setMetrics] = useState<SystemMetricsResponse | null>(null);
  const [models, setModels] = useState<ModelView[]>([]);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [logs, setLogs] = useState<LogResponse>(DEFAULT_LOGS);
  const [health, setHealth] = useState<HealthCheckResponse | null>(null);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyModelIds, setBusyModelIds] = useState<Record<string, boolean>>({});

  const selectedModel = useMemo(
    () => models.find((model) => model.id === selectedModelId) ?? models[0] ?? null,
    [models, selectedModelId]
  );

  const markBusy = useCallback((modelId: string, busy: boolean) => {
    setBusyModelIds((current) => ({ ...current, [modelId]: busy }));
  }, []);

  const refreshDashboard = useCallback(async () => {
    try {
      const [nextMetrics, nextModels, nextConfig] = await Promise.all([api.getMetrics(), api.getModels(), api.getConfig()]);
      setMetrics(nextMetrics);
      setModels(nextModels);
      setConfig(nextConfig);
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
    void refreshLogs(selectedModel?.id);
    void refreshHealth(selectedModel?.id);
    const intervalId = window.setInterval(() => {
      void refreshLogs(selectedModel?.id);
      void refreshHealth(selectedModel?.id);
    }, 2500);
    return () => window.clearInterval(intervalId);
  }, [refreshHealth, refreshLogs, selectedModel?.id]);

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
    models,
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
    saveRawConfig,
    saveProfile,
    deleteProfile,
    activateProfile,
  };
}
