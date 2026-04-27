import { useEffect, useMemo, useState } from "react";
import { BarChart3, Copy, FileCode2, HeartPulse, Logs, Pencil, Settings2, SlidersHorizontal, Trash2 } from "lucide-react";

import { ProfileEditor } from "@/components/dashboard/profile-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { AppConfig, HealthCheckResponse, LogResponse, ModelSettings, ModelView, ProfileConfig } from "@/types/api";

type TabId = "details" | "logs" | "profiles" | "settings" | "analysis" | "config";

interface DetailsPanelProps {
  model: ModelView | null;
  logs: LogResponse;
  health: HealthCheckResponse | null;
  config: AppConfig | null;
  panelHeight?: number | null;
  onRefreshHealth: (modelId?: string | null) => Promise<void>;
  onSaveProfile: (modelId: string, profile: ProfileConfig, isNew: boolean) => Promise<void>;
  onDeleteProfile: (modelId: string, profileId: string) => Promise<void>;
  onActivateProfile: (modelId: string, profileId: string) => Promise<void>;
  onSaveConfig: (config: AppConfig) => Promise<void>;
  onDeleteModel: (modelId: string, deleteFile?: boolean) => Promise<void>;
  onRenameModel: (modelId: string, name: string) => Promise<void>;
  onClearLogs: (modelId: string) => Promise<void>;
  onUpdateSettings: (modelId: string, settings: ModelSettings) => Promise<void>;
}

const tabs: Array<{ id: TabId; label: string; icon: typeof FileCode2 }> = [
  { id: "details", label: "Details", icon: HeartPulse },
  { id: "logs", label: "Logs", icon: Logs },
  { id: "profiles", label: "Profiles", icon: SlidersHorizontal },
  { id: "settings", label: "Settings", icon: Settings2 },
  { id: "analysis", label: "Analysis", icon: BarChart3 },
  { id: "config", label: "Config", icon: FileCode2 },
];

const settingHelp: Record<string, string> = {
  allow_start_stop: "Allows Quokka to start, stop, and restart this model from the UI.",
  auto_restart: "If the managed process crashes unexpectedly, Quokka will try to start it again.",
  health_enabled: "Runs endpoint checks so Quokka can mark the model healthy, unhealthy, or stopped.",
  health_interval_seconds: "How often the supervisor checks this model's health.",
  startup_grace_seconds: "How long Quokka waits after launch before treating failed health checks as a problem.",
  request_timeout_seconds: "HTTP timeout for health checks and local chat requests.",
  log_tail_lines: "How many recent log lines Quokka reads into the UI.",
  keep_alive: "For Ollama models, how long the model should stay loaded after use.",
};

const settingFields: Array<{ key: keyof ModelSettings; label: string; kind: "boolean" | "number" | "text" }> = [
  { key: "allow_start_stop", label: "Allow start / stop", kind: "boolean" },
  { key: "auto_restart", label: "Auto restart", kind: "boolean" },
  { key: "health_enabled", label: "Health checks", kind: "boolean" },
  { key: "health_interval_seconds", label: "Health interval", kind: "number" },
  { key: "startup_grace_seconds", label: "Startup grace", kind: "number" },
  { key: "request_timeout_seconds", label: "Request timeout", kind: "number" },
  { key: "log_tail_lines", label: "Log tail lines", kind: "number" },
  { key: "keep_alive", label: "Ollama keep alive", kind: "text" },
];

export function DetailsPanel({
  model,
  logs,
  health,
  config,
  panelHeight,
  onRefreshHealth,
  onSaveProfile,
  onDeleteProfile,
  onActivateProfile,
  onSaveConfig,
  onDeleteModel,
  onRenameModel,
  onClearLogs,
  onUpdateSettings,
}: DetailsPanelProps) {
  const [tab, setTab] = useState<TabId>("details");
  const configString = useMemo(() => JSON.stringify(config, null, 2) ?? "", [config]);
  const [draftConfig, setDraftConfig] = useState(configString);
  const [configError, setConfigError] = useState<string | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<ModelSettings | null>(model?.settings ?? null);
  const [copiedLogs, setCopiedLogs] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(model?.name ?? "");
  const launchParams = useMemo(() => {
    const raw = model?.runtime.details.launch_params;
    if (!raw) {
      return null;
    }
    if (typeof raw === "object") {
      return raw as Record<string, unknown>;
    }
    if (typeof raw !== "string") {
      return null;
    }
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }, [model?.runtime.details.launch_params]);

  useEffect(() => {
    setDraftConfig(configString);
  }, [configString]);

  useEffect(() => {
    setSettingsDraft(model?.settings ?? null);
    setNameDraft(model?.name ?? "");
    setRenaming(false);
  }, [model?.id, model?.name]);

  const setSetting = <K extends keyof ModelSettings>(key: K, value: ModelSettings[K]) => {
    setSettingsDraft((current) => (current ? { ...current, [key]: value } : current));
  };

  if (!model) {
    return (
      <Card className="h-full px-5 py-5">
        <p className="text-sm text-milk/55">Select a model to inspect its runtime, logs, profiles, and settings.</p>
      </Card>
    );
  }

  return (
    <Card
      className="flex min-h-0 flex-col overflow-hidden self-start"
      style={panelHeight ? { height: `${panelHeight}px` } : undefined}
    >
      <div className="border-b border-line px-5 py-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-milk/35">Inspection Panel</p>
            {renaming ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Input value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} className="h-9 max-w-[260px]" />
                <Button
                  variant="primary"
                  size="sm"
                  onClick={async () => {
                    const nextName = nameDraft.trim();
                    if (nextName) {
                      await onRenameModel(model.id, nextName);
                    }
                    setRenaming(false);
                  }}
                >
                  Save
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setRenaming(false)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <div className="mt-2 flex items-center gap-2">
                <h2 className="min-w-0 text-xl font-semibold text-milk">{model.name}</h2>
                <Button
                  variant="ghost"
                  size="icon"
                  title="Rename this model in Quokka config. It does not rename the GGUF file on disk."
                  onClick={() => {
                    setNameDraft(model.name);
                    setRenaming(true);
                  }}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
              </div>
            )}
            <p className="mt-1 text-sm text-milk/55">{model.endpoint}</p>
          </div>
          <Badge variant={model.runtime.health_ok ? "success" : "warning"}>
            {model.runtime.health_ok ? "Healthy" : model.runtime.status}
          </Badge>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {tabs.map(({ id, label, icon: Icon }) => (
            <Button
              key={id}
              size="sm"
              variant={tab === id ? "primary" : "ghost"}
              className={cn("border", tab === id ? "border-transparent" : "border-line")}
              onClick={() => setTab(id)}
            >
              <Icon className="h-4 w-4" />
              {label}
            </Button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        {tab === "details" ? (
          <div className="space-y-4">
            <div className="space-y-3 text-sm text-milk/60">
              {[
                ["family", model.metadata.family ?? model.artifact?.family],
                ["quant", model.artifact?.quantization ?? model.metadata.quantization],
                ["size", model.metadata.size],
                ["engine", model.metadata.engine],
                ["port", model.metadata.port],
              ].map(([key, value]) => (
                <div key={String(key)} className="flex items-start justify-between gap-3 border-b border-line/60 pb-2">
                  <span className="uppercase tracking-[0.18em] text-milk/35">{key}</span>
                  <span className="text-right">{value === undefined || value === null ? "--" : String(value)}</span>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => onRefreshHealth(model.id)}>
                Refresh Health
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => {
                  if (window.confirm(`Delete ${model.name} from Quokka config? Stop it first if it is running.`)) {
                    const deleteFile = window.confirm("Also delete the GGUF file from disk? This is permanent and only allowed for files under ~/llm/models.");
                    void onDeleteModel(model.id, deleteFile);
                  }
                }}
              >
                <Trash2 className="h-4 w-4" />
                Delete Model
              </Button>
            </div>
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-[0.22em] text-milk/35">Launch Snapshot</p>
              <div className="grid gap-2 text-sm text-milk/60 sm:grid-cols-2">
                <div className="rounded-lg border border-line bg-white/[0.025] px-3 py-2">
                  <p className="text-[11px] uppercase tracking-[0.18em] text-milk/35">Source</p>
                  <p className="mt-1">{model.runtime.managed ? "Quokka managed" : "External or unmanaged"}</p>
                </div>
                <div className="rounded-lg border border-line bg-white/[0.025] px-3 py-2">
                  <p className="text-[11px] uppercase tracking-[0.18em] text-milk/35">Launch Profile</p>
                  <p className="mt-1">{String(model.runtime.details.launch_profile ?? model.active_profile?.name ?? "None")}</p>
                </div>
              </div>
              <pre className="overflow-x-auto rounded-lg border border-line bg-black/20 p-3 text-xs text-milk/72">
                {String(model.runtime.details.launch_command ?? model.launch.command.join(" "))}
              </pre>
              {launchParams ? (
                <div className="grid gap-2 text-sm text-milk/60 sm:grid-cols-2">
                  {Object.entries(launchParams)
                    .filter(([key]) =>
                      [
                        "context_size",
                        "batch_size",
                        "ubatch_size",
                        "n_gpu_layers",
                        "parallel",
                        "cache_ram",
                        "repeat_penalty",
                        "threads",
                        "threads_batch",
                        "api_default_completion_max_tokens",
                        "temperature",
                        "top_p",
                        "top_k",
                        "min_p",
                        "cache_type_k",
                        "cache_type_v",
                        "flash_attn",
                        "jinja",
                        "no_mmap",
                        "mlock",
                        "override_tensor",
                        "reasoning_format",
                      ].includes(key)
                    )
                    .map(([key, value]) => (
                      <div key={key} className="flex items-center justify-between gap-3 border-b border-line/60 py-2">
                        <span className="uppercase tracking-[0.16em] text-milk/35">{key}</span>
                        <span>{String(value)}</span>
                      </div>
                    ))}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {tab === "logs" ? (
          <div className="flex min-h-0 flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="min-w-0 truncate text-xs uppercase tracking-[0.22em] text-milk/35">{logs.path}</p>
              <Button
                variant="secondary"
                size="sm"
                onClick={async () => {
                  const text = logs.lines.join("\n");
                  try {
                    await navigator.clipboard.writeText(text);
                    setCopiedLogs(true);
                    window.setTimeout(() => setCopiedLogs(false), 1400);
                  } catch {
                    setCopiedLogs(false);
                  }
                }}
              >
                <Copy className="h-4 w-4" />
                {copiedLogs ? "Copied" : "Copy Logs"}
              </Button>
              <Button
                variant="danger"
                size="sm"
                title="Clear this model log file. A small 'Logs cleared' event is written after truncating it."
                onClick={() => {
                  if (window.confirm(`Clear logs for ${model.name}?`)) {
                    void onClearLogs(model.id);
                  }
                }}
              >
                <Trash2 className="h-4 w-4" />
                Clear Logs
              </Button>
            </div>
            <pre className="h-[28rem] max-h-[52vh] overflow-auto rounded-lg border border-line bg-black/25 p-3 text-xs leading-6 text-milk/72">
              {logs.lines.join("\n") || "No log lines yet."}
            </pre>
          </div>
        ) : null}

        {tab === "profiles" ? (
          <ProfileEditor
            model={model}
            onSave={onSaveProfile}
            onDelete={onDeleteProfile}
            onActivate={onActivateProfile}
          />
        ) : null}

        {tab === "settings" ? (
          <div className="space-y-3 text-sm text-milk/62">
            {settingsDraft
              ? settingFields.map((field) => {
                  const value = settingsDraft[field.key];
                  return (
                    <label key={field.key} className="block border-b border-line/60 pb-3" title={settingHelp[field.key]}>
                      <span className="mb-2 block text-[11px] uppercase tracking-[0.18em] text-milk/35">{field.label}</span>
                      {field.kind === "boolean" ? (
                        <span className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={Boolean(value)}
                            onChange={(event) => setSetting(field.key, event.target.checked as never)}
                            className="h-4 w-4 accent-[#b08b66]"
                          />
                          <span>{Boolean(value) ? "Enabled" : "Disabled"}</span>
                        </span>
                      ) : (
                        <Input
                          type={field.kind === "number" ? "number" : "text"}
                          value={value === null || value === undefined ? "" : String(value)}
                          onChange={(event) => {
                            const nextValue = field.kind === "number" ? Number(event.target.value) : event.target.value || null;
                            setSetting(field.key, nextValue as never);
                          }}
                        />
                      )}
                      <p className="mt-2 text-xs leading-5 text-milk/42">{settingHelp[field.key] ?? "Advanced model runtime setting."}</p>
                    </label>
                  );
                })
              : null}
            <Button
              variant="primary"
              size="sm"
              disabled={!settingsDraft}
              onClick={() => settingsDraft && onUpdateSettings(model.id, settingsDraft)}
            >
              Save Settings
            </Button>
          </div>
        ) : null}

        {tab === "analysis" ? (
          <div className="rounded-lg border border-line bg-white/[0.025] px-4 py-8 text-sm leading-6 text-milk/55">
            Model analysis for your hardware will live here: expected token speed, VRAM pressure, context fit, and launch recommendations.
          </div>
        ) : null}

        {tab === "config" ? (
          <div className="space-y-3">
            <Textarea value={draftConfig} onChange={(event) => setDraftConfig(event.target.value)} className="min-h-[32rem]" />
            {configError ? <p className="text-sm text-danger">{configError}</p> : null}
            <Button
              variant="primary"
              size="sm"
              onClick={async () => {
                try {
                  const parsed = JSON.parse(draftConfig) as AppConfig;
                  setConfigError(null);
                  await onSaveConfig(parsed);
                } catch (error) {
                  setConfigError(error instanceof Error ? error.message : "Invalid JSON");
                }
              }}
            >
              Save Config
            </Button>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
