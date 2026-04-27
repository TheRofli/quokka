import { useEffect, useMemo, useState } from "react";
import {
  Clipboard,
  FlaskConical,
  LoaderCircle,
  Logs,
  PencilLine,
  Pin,
  PinOff,
  Play,
  RefreshCcw,
  SlidersHorizontal,
  Square,
  Trash2,
} from "lucide-react";

import type { MetricId } from "@/components/dashboard/metric-detail-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn, formatNumber } from "@/lib/utils";
import type {
  AppConfig,
  HealthCheckResponse,
  LogResponse,
  ModelStatus,
  ModelView,
  ProfileConfig,
  SystemMetricsResponse,
} from "@/types/api";

type InspectorTab = "details" | "config" | "logs";

interface ControlPanelProps {
  metrics: SystemMetricsResponse | null;
  models: ModelView[];
  selectedModel: ModelView | null;
  selectedModelId: string | null;
  busyModelIds: Record<string, boolean>;
  logs: LogResponse;
  health: HealthCheckResponse | null;
  isLoading: boolean;
  config: AppConfig | null;
  onSelectModel: (modelId: string) => void;
  onMetricSelect: (metricId: MetricId) => void;
  onOpenAddModel: () => void;
  onOpenTests: () => void;
  onRunModelAction: (modelId: string, action: "start" | "stop" | "restart") => Promise<void>;
  onSaveRawConfig: (config: AppConfig) => Promise<void>;
  onDeleteModel: (modelId: string, deleteFile?: boolean) => Promise<void>;
  onClearLogs: (modelId: string) => Promise<void>;
}

type ConfigDraft = {
  context_size: string;
  batch_size: string;
  ubatch_size: string;
  n_gpu_layers: string;
  parallel: string;
  threads: number;
  threads_batch: number;
  repeat_penalty: string;
  temperature: string;
  top_p: string;
  top_k: string;
  min_p: string;
  cache_type_k: string;
  cache_type_v: string;
  flash_attn: boolean;
  jinja: boolean;
  mlock: boolean;
  override_tensor_enabled: boolean;
  override_tensor_value: string;
};

const PINNED_MODELS_STORAGE_KEY = "quokka.control-panel.pinned-models";
const DEFAULT_OVERRIDE_TENSOR = "\\.ffn_.*_exps\\.weight=CPU";
const ACTIVE_STATUSES: ModelStatus[] = ["starting", "running", "warming", "stopping", "unhealthy"];

function isRunningStatus(status: ModelStatus) {
  return ACTIVE_STATUSES.includes(status);
}

function parseNumeric(value: string): number | null {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function statusDotTone(status: ModelStatus) {
  switch (status) {
    case "running":
    case "warming":
    case "starting":
      return "bg-accent";
    case "crashed":
    case "error":
      return "bg-danger";
    default:
      return "bg-milk/35";
  }
}

function statusLabel(status: ModelStatus) {
  return status.replace(/_/g, " ").toUpperCase();
}

function formatRamValue(valueMb?: number | null) {
  if (valueMb === null || valueMb === undefined || Number.isNaN(valueMb)) {
    return "--";
  }
  if (valueMb >= 1024) {
    return `${(valueMb / 1024).toFixed(1)} GB`;
  }
  return `${Math.round(valueMb)} MB`;
}

function safePort(model: ModelView) {
  const metadataPort = model.metadata.port;
  if (typeof metadataPort === "number" || typeof metadataPort === "string") {
    return String(metadataPort);
  }
  try {
    return new URL(model.endpoint).port || "--";
  } catch {
    return "--";
  }
}

function profileToDraft(profile: ProfileConfig, cpuThreadMax: number): ConfigDraft {
  return {
    context_size: String(profile.context_size ?? ""),
    batch_size: String(profile.batch_size ?? ""),
    ubatch_size: String(profile.ubatch_size ?? ""),
    n_gpu_layers: profile.n_gpu_layers === null || profile.n_gpu_layers === undefined ? "" : String(profile.n_gpu_layers),
    parallel: profile.parallel === null || profile.parallel === undefined ? "" : String(profile.parallel),
    threads: Math.min(Math.max(profile.threads ?? cpuThreadMax, 1), cpuThreadMax),
    threads_batch: Math.min(Math.max(profile.threads_batch ?? cpuThreadMax, 1), cpuThreadMax),
    repeat_penalty: profile.repeat_penalty === null || profile.repeat_penalty === undefined ? "" : String(profile.repeat_penalty),
    temperature: String(profile.temperature ?? ""),
    top_p: String(profile.top_p ?? ""),
    top_k: String(profile.top_k ?? ""),
    min_p: String(profile.min_p ?? ""),
    cache_type_k: profile.cache_type_k ?? "",
    cache_type_v: profile.cache_type_v ?? "",
    flash_attn: Boolean(profile.flash_attn),
    jinja: Boolean(profile.jinja),
    mlock: Boolean(profile.mlock),
    override_tensor_enabled: Boolean(profile.override_tensor),
    override_tensor_value: profile.override_tensor ?? DEFAULT_OVERRIDE_TENSOR,
  };
}

function draftToProfile(profile: ProfileConfig, draft: ConfigDraft): ProfileConfig {
  return {
    ...profile,
    context_size: parseNumeric(draft.context_size) ?? profile.context_size,
    batch_size: parseNumeric(draft.batch_size) ?? profile.batch_size,
    ubatch_size: parseNumeric(draft.ubatch_size) ?? profile.ubatch_size,
    n_gpu_layers: parseNumeric(draft.n_gpu_layers),
    parallel: parseNumeric(draft.parallel),
    threads: draft.threads,
    threads_batch: draft.threads_batch,
    repeat_penalty: parseNumeric(draft.repeat_penalty),
    temperature: parseNumeric(draft.temperature) ?? profile.temperature,
    top_p: parseNumeric(draft.top_p) ?? profile.top_p,
    top_k: parseNumeric(draft.top_k) ?? profile.top_k,
    min_p: parseNumeric(draft.min_p) ?? profile.min_p,
    cache_type_k: draft.cache_type_k.trim() || null,
    cache_type_v: draft.cache_type_v.trim() || null,
    flash_attn: draft.flash_attn,
    jinja: draft.jinja,
    mlock: draft.mlock,
    override_tensor: draft.override_tensor_enabled ? draft.override_tensor_value.trim() || DEFAULT_OVERRIDE_TENSOR : null,
  };
}

function configDraftEqualsDraft(left: ConfigDraft | null, right: ConfigDraft | null) {
  if (!left || !right) {
    return left === right;
  }
  return (
    left.context_size === right.context_size &&
    left.batch_size === right.batch_size &&
    left.ubatch_size === right.ubatch_size &&
    left.n_gpu_layers === right.n_gpu_layers &&
    left.parallel === right.parallel &&
    left.threads === right.threads &&
    left.threads_batch === right.threads_batch &&
    left.repeat_penalty === right.repeat_penalty &&
    left.temperature === right.temperature &&
    left.top_p === right.top_p &&
    left.top_k === right.top_k &&
    left.min_p === right.min_p &&
    left.cache_type_k === right.cache_type_k &&
    left.cache_type_v === right.cache_type_v &&
    left.flash_attn === right.flash_attn &&
    left.jinja === right.jinja &&
    left.mlock === right.mlock &&
    left.override_tensor_enabled === right.override_tensor_enabled &&
    left.override_tensor_value === right.override_tensor_value
  );
}

function MetricTile({
  label,
  value,
  subvalue,
  meterPercent,
  active = false,
  onClick,
}: {
  label: string;
  value: string;
  subvalue?: string;
  meterPercent?: number | null;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-[118px] min-w-0 flex-col justify-between bg-panel/70 px-5 py-4 text-left transition-colors",
        onClick ? "hover:bg-panel-2/80" : "cursor-default",
        active && "bg-panel-2"
      )}
    >
      <div className="flex min-w-0 items-center justify-between gap-3">
        <span className="truncate text-[11px] font-semibold uppercase tracking-[0.22em] text-milk/50">{label}</span>
      </div>
      <div className="min-w-0">
        <p className="truncate text-2xl font-semibold text-milk">{value}</p>
        {subvalue ? <p className="mt-2 truncate text-sm text-milk/60">{subvalue}</p> : null}
      </div>
      {meterPercent !== null && meterPercent !== undefined ? (
        <div className="flex items-center gap-3">
          <div className="h-2 w-full overflow-hidden rounded-full bg-black/30">
            <div
              className="h-full rounded-full bg-accent transition-all duration-200"
              style={{ width: `${Math.min(Math.max(meterPercent, 0), 100)}%` }}
            />
          </div>
          <span className="w-9 text-right text-xs font-semibold text-milk/70">{Math.round(meterPercent)}%</span>
        </div>
      ) : (
        <div className="h-2" />
      )}
    </button>
  );
}

function ToggleButton({
  enabled,
  label,
  onClick,
}: {
  enabled: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "min-w-[88px] border px-3 py-2 text-sm font-semibold uppercase tracking-[0.14em] transition-colors",
        enabled
          ? "border-accent bg-accent/15 text-accent hover:bg-accent/22"
          : "border-line bg-[#111111] text-milk/66 hover:border-accent/40 hover:text-milk"
      )}
    >
      {label}
    </button>
  );
}

function InspectorField({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="grid grid-cols-[160px_minmax(0,1fr)] border-b border-line px-4 py-3 text-sm">
      <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-milk/45">{label}</span>
      <span className="truncate text-milk">{value}</span>
    </div>
  );
}

export function ControlPanel({
  metrics,
  models,
  selectedModel,
  selectedModelId,
  busyModelIds,
  logs,
  health,
  isLoading,
  config,
  onSelectModel,
  onMetricSelect,
  onOpenAddModel,
  onOpenTests,
  onRunModelAction,
  onSaveRawConfig,
  onDeleteModel,
  onClearLogs,
}: ControlPanelProps) {
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("details");
  const [pinnedIds, setPinnedIds] = useState<string[]>(() => {
    try {
      const raw = window.localStorage.getItem(PINNED_MODELS_STORAGE_KEY);
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  });
  const [configDraft, setConfigDraft] = useState<ConfigDraft | null>(null);
  const [configDirty, setConfigDirty] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [launchEditMode, setLaunchEditMode] = useState(false);
  const [launchDraft, setLaunchDraft] = useState("");
  const [launchDirty, setLaunchDirty] = useState(false);
  const [launchSaving, setLaunchSaving] = useState(false);
  const [copiedCommand, setCopiedCommand] = useState(false);
  const [copiedLogs, setCopiedLogs] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const cpuThreadMax = Math.max(1, metrics?.cpu_logical_cores ?? metrics?.cpu_physical_cores ?? 16);
  const selectedConfigModel = useMemo(
    () => config?.models.find((model) => model.id === selectedModel?.id) ?? null,
    [config, selectedModel?.id]
  );
  const activeProfile = useMemo(
    () => selectedModel?.active_profile ?? selectedModel?.profiles[0] ?? null,
    [selectedModel]
  );
  const activeProfileKey = selectedModel && activeProfile ? `${selectedModel.id}:${activeProfile.id}` : null;
  const [lastSyncedProfileKey, setLastSyncedProfileKey] = useState<string | null>(null);
  const [lastSyncedLaunchModelId, setLastSyncedLaunchModelId] = useState<string | null>(null);

  const sortedModels = useMemo(() => {
    const pinnedLookup = new Set(pinnedIds);
    return [...models]
      .map((model, index) => ({ model, index }))
      .sort((left, right) => {
        const leftPinned = pinnedLookup.has(left.model.id) ? 1 : 0;
        const rightPinned = pinnedLookup.has(right.model.id) ? 1 : 0;
        if (leftPinned !== rightPinned) {
          return rightPinned - leftPinned;
        }
        return left.index - right.index;
      })
      .map(({ model }) => model);
  }, [models, pinnedIds]);

  useEffect(() => {
    window.localStorage.setItem(PINNED_MODELS_STORAGE_KEY, JSON.stringify(pinnedIds));
  }, [pinnedIds]);

  useEffect(() => {
    if (!selectedModelId) {
      setConfigDraft(null);
      setConfigDirty(false);
      setLastSyncedProfileKey(null);
      return;
    }
    if (!activeProfile || !activeProfileKey) {
      return;
    }
    const nextDraft = profileToDraft(activeProfile, cpuThreadMax);
    if (lastSyncedProfileKey !== activeProfileKey) {
      setConfigDraft(nextDraft);
      setConfigDirty(false);
      setLastSyncedProfileKey(activeProfileKey);
      return;
    }
    if (!configDirty && !configSaving && !configDraftEqualsDraft(configDraft, nextDraft)) {
      setConfigDraft(nextDraft);
    }
  }, [
    activeProfile,
    activeProfileKey,
    configDirty,
    configDraft,
    configSaving,
    cpuThreadMax,
    lastSyncedProfileKey,
    selectedModelId,
  ]);

  useEffect(() => {
    if (!selectedModelId) {
      setLaunchDraft("");
      setLaunchDirty(false);
      setLaunchEditMode(false);
      setLastSyncedLaunchModelId(null);
      return;
    }
    if (!selectedModel) {
      return;
    }
    const nextCommand = (selectedConfigModel?.launch.command ?? selectedModel.launch.command ?? []).join("\n");
    if (lastSyncedLaunchModelId !== selectedModel.id) {
      setLaunchDraft(nextCommand);
      setLaunchDirty(false);
      setLaunchEditMode(false);
      setLastSyncedLaunchModelId(selectedModel.id);
      return;
    }
    if (!launchDirty && !launchEditMode && !launchSaving && launchDraft !== nextCommand) {
      setLaunchDraft(nextCommand);
    }
  }, [
    lastSyncedLaunchModelId,
    launchDirty,
    launchDraft,
    launchEditMode,
    launchSaving,
    selectedConfigModel?.launch.command,
    selectedModel,
    selectedModelId,
  ]);

  const selectedBusy = selectedModel ? Boolean(busyModelIds[selectedModel.id]) : false;
  const selectedRunning = selectedModel ? isRunningStatus(selectedModel.runtime.status) : false;
  const selectedPinned = selectedModel ? pinnedIds.includes(selectedModel.id) : false;
  const runtimeUsage = selectedModel?.runtime.resource_usage;

  const togglePinned = (modelId: string) => {
    setPinnedIds((current) => (current.includes(modelId) ? current.filter((entry) => entry !== modelId) : [modelId, ...current]));
  };

  const setDraftValue = <K extends keyof ConfigDraft>(key: K, value: ConfigDraft[K]) => {
    setConfigDraft((current) => (current ? { ...current, [key]: value } : current));
    setConfigDirty(true);
    setMessage(null);
  };

  const updateLaunchDraft = (value: string) => {
    setLaunchDraft(value);
    setLaunchDirty(true);
    setMessage(null);
  };

  const applyProfileChanges = async () => {
    if (!config || !selectedConfigModel || !activeProfile || !configDraft) {
      return;
    }
    setConfigSaving(true);
    setMessage(null);
    try {
      const updatedProfile = draftToProfile(activeProfile, configDraft);
      const nextConfig: AppConfig = {
        ...config,
        models: config.models.map((model) =>
          model.id === selectedConfigModel.id
            ? {
                ...model,
                profiles: model.profiles.map((profile) => (profile.id === updatedProfile.id ? updatedProfile : profile)),
              }
            : model
        ),
      };
      await onSaveRawConfig(nextConfig);
      setConfigDraft(profileToDraft(updatedProfile, cpuThreadMax));
      setConfigDirty(false);
      setLastSyncedProfileKey(activeProfileKey);
      setMessage("Config changes applied.");
    } finally {
      setConfigSaving(false);
    }
  };

  const saveLaunchSnapshot = async () => {
    if (!config || !selectedConfigModel || !selectedModel) {
      return;
    }
    const nextCommand = launchDraft
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (!nextCommand.length) {
      setMessage("Launch command cannot be empty.");
      return;
    }
    setLaunchSaving(true);
    setMessage(null);
    try {
      const nextConfig: AppConfig = {
        ...config,
        models: config.models.map((model) =>
          model.id === selectedModel.id
            ? {
                ...model,
                launch: {
                  ...model.launch,
                  command: nextCommand,
                },
              }
            : model
        ),
      };
      await onSaveRawConfig(nextConfig);
      setLaunchDraft(nextCommand.join("\n"));
      setLaunchDirty(false);
      setLaunchEditMode(false);
      setLastSyncedLaunchModelId(selectedModel.id);
      setMessage("Launch snapshot saved.");
    } finally {
      setLaunchSaving(false);
    }
  };

  const handleDeleteModel = async () => {
    if (!selectedModel) {
      return;
    }
    if (!window.confirm(`Delete ${selectedModel.name} from Quokka config?`)) {
      return;
    }
    const deleteFile = window.confirm("Also delete the GGUF file from disk when allowed?");
    await onDeleteModel(selectedModel.id, deleteFile);
    setPinnedIds((current) => current.filter((entry) => entry !== selectedModel.id));
  };

  const metricTiles = [
    {
      id: "gpu" as MetricId,
      label: "GPU",
      value: `${formatNumber(metrics?.gpu_usage_percent, 0)}%`,
      subvalue: metrics?.gpu_devices?.[0]?.name ?? "No GPU telemetry",
      meterPercent: metrics?.gpu_usage_percent ?? 0,
    },
    {
      id: "vram" as MetricId,
      label: "VRAM",
      value: `${formatNumber(metrics?.gpu_memory_used_mb ? metrics.gpu_memory_used_mb / 1024 : null, 1)}GB / ${formatNumber(
        metrics?.gpu_memory_total_mb ? metrics.gpu_memory_total_mb / 1024 : null,
        1
      )}GB`,
      subvalue: metrics?.gpu_memory_used_mb !== undefined ? undefined : "Not available",
    },
    {
      id: "cpu" as MetricId,
      label: "CPU",
      value: `${formatNumber(metrics?.cpu_usage_percent, 0)}%`,
      subvalue: metrics?.cpu_logical_cores ? `${metrics.cpu_logical_cores} threads available` : "System-wide load",
      meterPercent: metrics?.cpu_usage_percent ?? 0,
    },
    {
      id: "ram" as MetricId,
      label: "RAM",
      value: `${formatNumber(metrics?.ram_used_gb, 1)} / ${formatNumber(metrics?.ram_total_gb, 1)}GB`,
      subvalue: metrics?.ram_usage_percent !== undefined ? `${formatNumber(metrics.ram_usage_percent, 0)}% used` : "Not available",
    },
    {
      id: "models" as MetricId,
      label: "RUNNING MODELS",
      value: `${metrics?.active_models ?? 0} / ${models.length}`,
      subvalue: isLoading ? "Refreshing..." : "Current managed endpoints",
    },
  ];

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="grid shrink-0 grid-cols-1 overflow-hidden border border-line bg-panel/60 md:grid-cols-2 xl:grid-cols-[repeat(5,minmax(0,1fr))]">
        {metricTiles.map((tile, index) => (
          <div key={tile.id} className={cn("min-w-0", index < metricTiles.length - 1 && "border-b border-line xl:border-b-0 xl:border-r")}>
            <MetricTile
              label={tile.label}
              value={tile.value}
              subvalue={tile.subvalue}
              meterPercent={tile.meterPercent}
              active={tile.id === "models" ? false : false}
              onClick={tile.id === "models" ? undefined : () => onMetricSelect(tile.id)}
            />
          </div>
        ))}
      </div>

      <div className="mt-4 grid min-h-0 flex-1 grid-cols-[360px_minmax(0,1fr)] gap-5 overflow-hidden 2xl:grid-cols-[390px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col overflow-hidden border border-line bg-[#0f0f0f]">
          <div className="border-b border-line px-4 py-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-milk/48">Model list</p>
                <p className="mt-2 text-xs text-milk/38">{models.length} managed endpoints</p>
              </div>
              <button
                type="button"
                onClick={onOpenAddModel}
                className="flex h-10 items-center justify-center border border-line bg-black/20 px-4 text-sm font-semibold uppercase tracking-[0.14em] text-milk transition-colors hover:border-accent hover:bg-accent/10 hover:text-accent"
              >
                + Add model
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {sortedModels.map((model) => {
              const active = selectedModelId === model.id;
              const busy = Boolean(busyModelIds[model.id]);
              const running = isRunningStatus(model.runtime.status);
              const pinned = pinnedIds.includes(model.id);
              const usage = model.runtime.resource_usage;
              const statusTone = running ? "text-accent" : model.runtime.status === "crashed" || model.runtime.status === "error" ? "text-danger" : "text-milk/55";

              return (
                <div
                  key={model.id}
                  className={cn(
                    "group relative border-b border-line px-4 py-4 transition-colors",
                    active ? "bg-[#151515]" : "hover:bg-[#131313]"
                  )}
                >
                  <div className={cn("absolute inset-y-0 left-0 w-px bg-transparent transition-colors", active || pinned ? "bg-accent" : "group-hover:bg-accent/55")} />
                  <button type="button" className="block w-full text-left" onClick={() => onSelectModel(model.id)}>
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <h3 className="truncate text-[15px] font-semibold text-milk">{model.name}</h3>
                          {pinned ? <Pin className="h-3.5 w-3.5 shrink-0 text-accent" /> : null}
                        </div>
                        <div className="mt-1 flex items-center gap-2 text-[11px] uppercase tracking-[0.18em]">
                          <span className={cn("inline-flex items-center gap-1 font-semibold", statusTone)}>
                            <span className={cn("h-2 w-2 rounded-full", statusDotTone(model.runtime.status))} />
                            {statusLabel(model.runtime.status)}
                          </span>
                        </div>
                        <p className="mt-2 truncate text-sm text-milk/58">
                          {model.provider.replace(/_/g, " ")} | :{safePort(model)} | {model.active_profile?.name ?? "Default"}
                        </p>
                        <p className="mt-2 truncate text-sm text-milk/45">{model.description}</p>
                        {running ? (
                          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-milk/68">
                            <span>{usage?.gpu_percent !== null && usage?.gpu_percent !== undefined ? `gpu ${formatNumber(usage.gpu_percent, 0)}%` : "gpu --"}</span>
                            <span>{usage?.ram_mb !== null && usage?.ram_mb !== undefined ? `ram ${formatRamValue(usage.ram_mb)}` : "ram --"}</span>
                            <span>{model.active_profile?.context_size ? `ctx ${model.active_profile.context_size}` : "ctx --"}</span>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </button>

                  <div
                    className={cn(
                      "mt-3 flex items-center gap-2 transition-opacity",
                      active ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                    )}
                  >
                    {running ? (
                      <button
                        type="button"
                        title="Stop model"
                        disabled={busy}
                        onClick={() => void onRunModelAction(model.id, "stop")}
                        className="inline-flex h-8 w-8 items-center justify-center border border-line bg-[#111111] text-milk/72 transition-transform transition-colors hover:scale-105 hover:border-accent hover:text-accent disabled:opacity-40"
                      >
                        {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />}
                      </button>
                    ) : (
                      <button
                        type="button"
                        title="Start model"
                        disabled={busy}
                        onClick={() => void onRunModelAction(model.id, "start")}
                        className="inline-flex h-8 w-8 items-center justify-center border border-line bg-[#111111] text-milk/72 transition-transform transition-colors hover:scale-105 hover:border-accent hover:text-accent disabled:opacity-40"
                      >
                        {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                      </button>
                    )}
                    <button
                      type="button"
                      title="Restart model"
                      disabled={busy}
                      onClick={() => void onRunModelAction(model.id, "restart")}
                      className="inline-flex h-8 w-8 items-center justify-center border border-line bg-[#111111] text-milk/72 transition-transform transition-colors hover:scale-105 hover:border-accent hover:text-accent disabled:opacity-40"
                    >
                      <RefreshCcw className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      title={pinned ? "Unpin model" : "Pin model to top"}
                      onClick={() => togglePinned(model.id)}
                      className={cn(
                        "inline-flex h-8 w-8 items-center justify-center border transition-transform transition-colors hover:scale-105",
                        pinned ? "border-accent bg-accent/14 text-accent" : "border-line bg-[#111111] text-milk/72 hover:border-accent hover:text-accent"
                      )}
                    >
                      {pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
                    </button>
                    <button
                      type="button"
                      title="Open benchmark diagnostics"
                      onClick={onOpenTests}
                      className="inline-flex h-8 w-8 items-center justify-center border border-line bg-[#111111] text-milk/72 transition-transform transition-colors hover:scale-105 hover:border-accent hover:text-accent"
                    >
                      <FlaskConical className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </aside>

        <section className="flex min-h-0 flex-col overflow-hidden border border-line bg-[#0f0f0f]">
          {selectedModel ? (
            <>
              <div className="border-b border-line px-5 py-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-3">
                      <h2 className="truncate text-[32px] font-semibold leading-none text-milk">{selectedModel.name}</h2>
                      <button
                        type="button"
                        title={selectedPinned ? "Unpin model" : "Pin model"}
                        onClick={() => togglePinned(selectedModel.id)}
                        className={cn(
                          "inline-flex h-9 w-9 items-center justify-center border transition-colors",
                          selectedPinned ? "border-accent bg-accent/14 text-accent" : "border-line bg-[#111111] text-milk/72 hover:border-accent hover:text-accent"
                        )}
                      >
                        <Pin className="h-4 w-4" />
                      </button>
                    </div>
                    <div className="mt-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em]">
                      <span className={cn("h-2 w-2 rounded-full", statusDotTone(selectedModel.runtime.status))} />
                      <span className={selectedRunning ? "text-accent" : "text-milk/60"}>{statusLabel(selectedModel.runtime.status)}</span>
                    </div>
                    <p className="mt-4 text-[28px] font-mono text-milk/52">{selectedModel.endpoint}</p>
                  </div>

                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {selectedRunning ? (
                      <button
                        type="button"
                        disabled={selectedBusy}
                        onClick={() => void onRunModelAction(selectedModel.id, "stop")}
                        className="inline-flex h-11 items-center gap-2 border border-line bg-[#111111] px-5 text-sm font-semibold uppercase tracking-[0.12em] text-milk transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
                      >
                        {selectedBusy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />}
                        Stop
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={selectedBusy}
                        onClick={() => void onRunModelAction(selectedModel.id, "start")}
                        className="inline-flex h-11 items-center gap-2 border border-accent bg-accent px-5 text-sm font-semibold uppercase tracking-[0.12em] text-[#111111] transition-colors hover:bg-[#ffa766] disabled:opacity-40"
                      >
                        {selectedBusy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                        Start
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setInspectorTab("details")}
                      className={cn(
                        "inline-flex h-11 items-center gap-2 border px-5 text-sm font-semibold uppercase tracking-[0.12em] transition-colors",
                        inspectorTab === "details"
                          ? "border-accent bg-accent/12 text-accent"
                          : "border-line bg-[#111111] text-milk hover:border-accent/55"
                      )}
                    >
                      Details
                    </button>
                    <button
                      type="button"
                      onClick={() => setInspectorTab("config")}
                      className={cn(
                        "inline-flex h-11 items-center gap-2 border px-5 text-sm font-semibold uppercase tracking-[0.12em] transition-colors",
                        inspectorTab === "config"
                          ? "border-accent bg-accent/12 text-accent"
                          : "border-line bg-[#111111] text-milk hover:border-accent/55"
                      )}
                    >
                      <SlidersHorizontal className="h-4 w-4" />
                      Config
                    </button>
                    <button
                      type="button"
                      onClick={() => setInspectorTab("logs")}
                      className={cn(
                        "inline-flex h-11 items-center gap-2 border px-5 text-sm font-semibold uppercase tracking-[0.12em] transition-colors",
                        inspectorTab === "logs"
                          ? "border-accent bg-accent/12 text-accent"
                          : "border-line bg-[#111111] text-milk hover:border-accent/55"
                      )}
                    >
                      <Logs className="h-4 w-4" />
                      Logs
                    </button>
                    <button
                      type="button"
                      onClick={onOpenTests}
                      className="inline-flex h-11 items-center gap-2 border border-line bg-[#111111] px-5 text-sm font-semibold uppercase tracking-[0.12em] text-milk transition-colors hover:border-accent hover:text-accent"
                    >
                      <FlaskConical className="h-4 w-4" />
                      Bench
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDeleteModel()}
                      className="inline-flex h-11 items-center gap-2 border border-line bg-[#111111] px-4 text-sm font-semibold uppercase tracking-[0.12em] text-milk transition-colors hover:border-danger hover:text-danger"
                      title="Delete this model from Quokka config"
                    >
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </button>
                  </div>
                </div>

                <div className="mt-5 flex flex-wrap items-center gap-6 border border-line bg-[#111111] px-4 py-3 text-sm text-milk/62">
                  <span>Runtime: {selectedModel.runtime.status.toUpperCase()}</span>
                  <span>GPU {runtimeUsage?.gpu_percent !== null && runtimeUsage?.gpu_percent !== undefined ? `${formatNumber(runtimeUsage.gpu_percent, 0)}%` : "--"}</span>
                  <span>RAM {formatRamValue(runtimeUsage?.ram_mb)}</span>
                  <span>VRAM {formatRamValue(runtimeUsage?.vram_mb)}</span>
                  <span>PID {selectedModel.runtime.pid ?? "--"}</span>
                  {health ? <span>Health {health.ok ? "OK" : health.detail}</span> : null}
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-hidden px-5 py-5">
                {message ? (
                  <div className="mb-4 border border-accent/40 bg-accent/10 px-4 py-3 text-sm text-milk">
                    {message}
                  </div>
                ) : null}

                {inspectorTab === "details" ? (
                  <div className="h-full min-h-0 overflow-y-auto overscroll-contain pr-1">
                    <div className="space-y-6">
                    <section className="border border-line">
                      <div className="border-b border-line px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.28em] text-milk/48">
                        Characteristics
                      </div>
                      <InspectorField label="Engine" value={String(selectedModel.metadata.engine ?? selectedModel.provider.replace(/_/g, " "))} />
                      <InspectorField label="Quant" value={String(selectedModel.artifact.quantization ?? selectedModel.metadata.quantization ?? "--")} />
                      <InspectorField label="Size" value={String(selectedModel.metadata.size ?? selectedModel.artifact.file_name ?? "--")} />
                      <InspectorField label="Port" value={safePort(selectedModel)} />
                      <InspectorField label="Health" value={health?.detail ?? selectedModel.runtime.last_transition_reason ?? "--"} />
                    </section>

                    <section className="border border-line">
                      <div className="flex items-center justify-between border-b border-line px-4 py-3">
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-milk/48">Launch Snapshot</p>
                          <p className="mt-2 text-sm text-milk/42">&gt; launch command</p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            className="rounded-none border-line bg-[#111111]"
                            onClick={async () => {
                              await navigator.clipboard.writeText(launchDraft);
                              setCopiedCommand(true);
                              window.setTimeout(() => setCopiedCommand(false), 1200);
                            }}
                          >
                            <Clipboard className="h-4 w-4" />
                            {copiedCommand ? "Copied" : "Copy"}
                          </Button>
                          {launchEditMode ? (
                            <>
                              <Button
                                variant="primary"
                                size="sm"
                                className="rounded-none"
                                disabled={launchSaving}
                                onClick={() => void saveLaunchSnapshot()}
                              >
                                {launchSaving ? "Saving..." : "Save"}
                              </Button>
                              <Button
                                variant="secondary"
                                size="sm"
                                className="rounded-none border-line bg-[#111111]"
                                onClick={() => {
                                  setLaunchEditMode(false);
                                  setLaunchDirty(false);
                                  setLaunchDraft((selectedConfigModel?.launch.command ?? selectedModel.launch.command ?? []).join("\n"));
                                }}
                              >
                                Cancel
                              </Button>
                            </>
                          ) : (
                            <Button
                              variant="secondary"
                              size="sm"
                              className="rounded-none border-line bg-[#111111]"
                              onClick={() => setLaunchEditMode(true)}
                            >
                              <PencilLine className="h-4 w-4" />
                              Edit
                            </Button>
                          )}
                        </div>
                      </div>
                      <div className="px-4 py-4">
                        {launchEditMode ? (
                          <Textarea
                            value={launchDraft}
                            onChange={(event) => updateLaunchDraft(event.target.value)}
                            className="min-h-[210px] rounded-none border-line bg-black/20 font-mono text-sm"
                            autoFocus
                            placeholder="One launch command token per line"
                          />
                        ) : (
                          <pre className="overflow-x-auto border border-line bg-black/20 px-4 py-4 font-mono text-sm leading-8 text-milk">
                            {launchDraft || String(selectedModel.runtime.details.launch_command ?? "(no launch command)")}
                          </pre>
                        )}
                      </div>
                    </section>
                    </div>
                  </div>
                ) : null}

                {inspectorTab === "config" ? (
                  <div className="flex h-full min-h-0 flex-col overflow-hidden">
                    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
                    <div className="grid gap-5 xl:grid-cols-2">
                      <section className="border border-line">
                        <div className="border-b border-line px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.28em] text-milk/48">
                          Context and batching
                        </div>
                        <div className="grid gap-4 px-4 py-4">
                          <div className="grid grid-cols-2 gap-4">
                            <label className="space-y-2 text-sm">
                              <span className="text-milk/55">ctx_size</span>
                              <Input value={configDraft?.context_size ?? ""} onChange={(event) => setDraftValue("context_size", event.target.value)} className="rounded-none border-line bg-[#111111]" />
                            </label>
                            <label className="space-y-2 text-sm">
                              <span className="text-milk/55">batch</span>
                              <Input value={configDraft?.batch_size ?? ""} onChange={(event) => setDraftValue("batch_size", event.target.value)} className="rounded-none border-line bg-[#111111]" />
                            </label>
                          </div>
                          <div className="grid grid-cols-2 gap-4">
                            <label className="space-y-2 text-sm">
                              <span className="text-milk/55">ubatch</span>
                              <Input value={configDraft?.ubatch_size ?? ""} onChange={(event) => setDraftValue("ubatch_size", event.target.value)} className="rounded-none border-line bg-[#111111]" />
                            </label>
                            <label className="space-y-2 text-sm">
                              <span className="text-milk/55">parallel</span>
                              <Input value={configDraft?.parallel ?? ""} onChange={(event) => setDraftValue("parallel", event.target.value)} className="rounded-none border-line bg-[#111111]" />
                            </label>
                          </div>
                          <label className="space-y-2 text-sm">
                            <span className="text-milk/55">n_gpu_layers</span>
                            <Input value={configDraft?.n_gpu_layers ?? ""} onChange={(event) => setDraftValue("n_gpu_layers", event.target.value)} className="rounded-none border-line bg-[#111111]" />
                          </label>
                        </div>
                      </section>

                      <section className="border border-line">
                        <div className="border-b border-line px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.28em] text-milk/48">
                          Threads and runtime
                        </div>
                        <div className="grid gap-4 px-4 py-4">
                          <div className="space-y-2 text-sm">
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-milk/55">threads</span>
                              <span className="font-mono text-milk">{configDraft?.threads ?? cpuThreadMax}</span>
                            </div>
                            <input
                              type="range"
                              min={1}
                              max={cpuThreadMax}
                              value={configDraft?.threads ?? cpuThreadMax}
                              onChange={(event) => setDraftValue("threads", Number(event.target.value))}
                              className="w-full accent-[rgb(var(--color-accent))]"
                            />
                            <p className="text-xs text-milk/38">CPU max detected automatically: {cpuThreadMax}</p>
                          </div>
                          <div className="space-y-2 text-sm">
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-milk/55">threads_batch</span>
                              <span className="font-mono text-milk">{configDraft?.threads_batch ?? cpuThreadMax}</span>
                            </div>
                            <input
                              type="range"
                              min={1}
                              max={cpuThreadMax}
                              value={configDraft?.threads_batch ?? cpuThreadMax}
                              onChange={(event) => setDraftValue("threads_batch", Number(event.target.value))}
                              className="w-full accent-[rgb(var(--color-accent))]"
                            />
                          </div>
                          <label className="space-y-2 text-sm">
                            <span className="text-milk/55">repeat_penalty</span>
                            <Input value={configDraft?.repeat_penalty ?? ""} onChange={(event) => setDraftValue("repeat_penalty", event.target.value)} className="rounded-none border-line bg-[#111111]" />
                          </label>
                          <div className="flex flex-wrap gap-2">
                            <ToggleButton enabled={Boolean(configDraft?.flash_attn)} label={configDraft?.flash_attn ? "flash_attn on" : "flash_attn off"} onClick={() => setDraftValue("flash_attn", !Boolean(configDraft?.flash_attn))} />
                            <ToggleButton enabled={Boolean(configDraft?.jinja)} label={configDraft?.jinja ? "jinja on" : "jinja off"} onClick={() => setDraftValue("jinja", !Boolean(configDraft?.jinja))} />
                            <ToggleButton enabled={Boolean(configDraft?.mlock)} label={configDraft?.mlock ? "mlock on" : "mlock off"} onClick={() => setDraftValue("mlock", !Boolean(configDraft?.mlock))} />
                          </div>
                        </div>
                      </section>

                      <section className="border border-line">
                        <div className="border-b border-line px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.28em] text-milk/48">
                          Sampling and cache
                        </div>
                        <div className="grid gap-4 px-4 py-4">
                          <div className="grid grid-cols-2 gap-4">
                            <label className="space-y-2 text-sm">
                              <span className="text-milk/55">temp</span>
                              <Input value={configDraft?.temperature ?? ""} onChange={(event) => setDraftValue("temperature", event.target.value)} className="rounded-none border-line bg-[#111111]" />
                            </label>
                            <label className="space-y-2 text-sm">
                              <span className="text-milk/55">top_p</span>
                              <Input value={configDraft?.top_p ?? ""} onChange={(event) => setDraftValue("top_p", event.target.value)} className="rounded-none border-line bg-[#111111]" />
                            </label>
                          </div>
                          <div className="grid grid-cols-2 gap-4">
                            <label className="space-y-2 text-sm">
                              <span className="text-milk/55">top_k</span>
                              <Input value={configDraft?.top_k ?? ""} onChange={(event) => setDraftValue("top_k", event.target.value)} className="rounded-none border-line bg-[#111111]" />
                            </label>
                            <label className="space-y-2 text-sm">
                              <span className="text-milk/55">min_p</span>
                              <Input value={configDraft?.min_p ?? ""} onChange={(event) => setDraftValue("min_p", event.target.value)} className="rounded-none border-line bg-[#111111]" />
                            </label>
                          </div>
                          <div className="grid grid-cols-2 gap-4">
                            <label className="space-y-2 text-sm">
                              <span className="text-milk/55">cache_k</span>
                              <Input value={configDraft?.cache_type_k ?? ""} onChange={(event) => setDraftValue("cache_type_k", event.target.value)} className="rounded-none border-line bg-[#111111]" />
                            </label>
                            <label className="space-y-2 text-sm">
                              <span className="text-milk/55">cache_v</span>
                              <Input value={configDraft?.cache_type_v ?? ""} onChange={(event) => setDraftValue("cache_type_v", event.target.value)} className="rounded-none border-line bg-[#111111]" />
                            </label>
                          </div>
                        </div>
                      </section>

                      <section className="border border-line">
                        <div className="border-b border-line px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.28em] text-milk/48">
                          CPU distribution
                        </div>
                        <div className="grid gap-4 px-4 py-4">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                              <p className="text-sm text-milk">Expert offload to CPU</p>
                              <p className="mt-1 text-xs text-milk/38">Turns the override tensor rule on or off for expert weights.</p>
                            </div>
                            <ToggleButton
                              enabled={Boolean(configDraft?.override_tensor_enabled)}
                              label={configDraft?.override_tensor_enabled ? "cpu split on" : "cpu split off"}
                              onClick={() => setDraftValue("override_tensor_enabled", !Boolean(configDraft?.override_tensor_enabled))}
                            />
                          </div>
                          {configDraft?.override_tensor_enabled ? (
                            <label className="space-y-2 text-sm">
                              <span className="text-milk/55">override_tensor</span>
                              <Input
                                value={configDraft.override_tensor_value}
                                onChange={(event) => setDraftValue("override_tensor_value", event.target.value)}
                                className="rounded-none border-line bg-[#111111] font-mono"
                              />
                            </label>
                          ) : null}
                        </div>
                      </section>
                    </div>
                    </div>
                    <div className="mt-5 shrink-0 border border-line bg-[#111111] px-4 py-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <p className="text-sm text-milk/55">
                          {configDirty ? "Unsaved config changes are ready." : "Config matches the saved profile."}
                        </p>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            className="rounded-none border-line bg-[#111111]"
                            disabled={!configDirty || !activeProfile}
                            onClick={() => {
                              if (activeProfile) {
                                setConfigDraft(profileToDraft(activeProfile, cpuThreadMax));
                                setConfigDirty(false);
                              }
                            }}
                          >
                            Reset
                          </Button>
                          <Button
                            variant="primary"
                            size="sm"
                            className="rounded-none"
                            disabled={!configDirty || configSaving || !activeProfile}
                            onClick={() => void applyProfileChanges()}
                          >
                            {configSaving ? "Applying..." : "Apply changes"}
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}

                {inspectorTab === "logs" ? (
                  <div className="flex h-full min-h-0 flex-col">
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                      <p className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-[0.28em] text-milk/48">{logs.path || "Logs"}</p>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="secondary"
                          size="sm"
                          className="rounded-none border-line bg-[#111111]"
                          onClick={async () => {
                            await navigator.clipboard.writeText(logs.lines.join("\n"));
                            setCopiedLogs(true);
                            window.setTimeout(() => setCopiedLogs(false), 1200);
                          }}
                        >
                          <Clipboard className="h-4 w-4" />
                          {copiedLogs ? "Copied" : "Copy"}
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          className="rounded-none border-line bg-[#111111]"
                          onClick={() => void onClearLogs(selectedModel.id)}
                        >
                          Clear logs
                        </Button>
                      </div>
                    </div>
                    <pre className="min-h-0 flex-1 overflow-auto overscroll-contain border border-line bg-black/20 px-4 py-4 font-mono text-sm leading-7 text-milk">
                      {logs.lines.join("\n") || "No log lines yet."}
                    </pre>
                  </div>
                ) : null}
              </div>
            </>
          ) : (
            <div className="flex h-full items-center justify-center border border-dashed border-line bg-[#0f0f0f] text-milk/45">
              Select a model from the left list to inspect it.
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
