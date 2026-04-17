import { useEffect, useMemo, useState } from "react";
import { FileCode2, HeartPulse, Logs, Settings2, SlidersHorizontal } from "lucide-react";

import { ProfileEditor } from "@/components/dashboard/profile-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { cn, formatTimestamp } from "@/lib/utils";
import type { AppConfig, HealthCheckResponse, LogResponse, ModelView, ProfileConfig } from "@/types/api";

type TabId = "details" | "logs" | "profiles" | "settings" | "config";

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
}

const tabs: Array<{ id: TabId; label: string; icon: typeof FileCode2 }> = [
  { id: "details", label: "Details", icon: HeartPulse },
  { id: "logs", label: "Logs", icon: Logs },
  { id: "profiles", label: "Profiles", icon: SlidersHorizontal },
  { id: "settings", label: "Settings", icon: Settings2 },
  { id: "config", label: "Config", icon: FileCode2 },
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
}: DetailsPanelProps) {
  const [tab, setTab] = useState<TabId>("details");
  const configString = useMemo(() => JSON.stringify(config, null, 2) ?? "", [config]);
  const [draftConfig, setDraftConfig] = useState(configString);
  const [configError, setConfigError] = useState<string | null>(null);

  useEffect(() => {
    setDraftConfig(configString);
  }, [configString]);

  if (!model) {
    return (
      <Card className="h-full px-5 py-5">
        <p className="text-sm text-milk/55">Select a model to inspect its runtime, logs, profiles, and settings.</p>
      </Card>
    );
  }

  return (
    <Card
      className="flex min-h-[520px] flex-col overflow-hidden xl:min-h-0"
      style={panelHeight ? { height: `${panelHeight}px` } : undefined}
    >
      <div className="border-b border-line px-5 py-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-milk/35">Inspection Panel</p>
            <h2 className="mt-2 text-xl font-semibold text-milk">{model.name}</h2>
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
          <div className="space-y-5">
            <div className="space-y-2 text-sm text-milk/62">
              <p>{model.description}</p>
              <p>Started: {formatTimestamp(model.runtime.started_at)}</p>
              <p>PID: {model.runtime.pid ?? "--"}</p>
              <p>Profile: {model.active_profile?.name ?? "None"}</p>
              <p>Health latency: {health?.latency_ms?.toFixed(2) ?? "--"} ms</p>
            </div>
            <Button variant="secondary" size="sm" onClick={() => onRefreshHealth(model.id)}>
              Refresh Health
            </Button>
            <div className="space-y-3 text-sm text-milk/60">
              {Object.entries(model.metadata).map(([key, value]) => (
                <div key={key} className="flex items-start justify-between gap-3 border-b border-line/60 pb-2">
                  <span className="uppercase tracking-[0.18em] text-milk/35">{key}</span>
                  <span className="text-right">
                    {Array.isArray(value) ? value.join(", ") : String(value)}
                  </span>
                </div>
              ))}
            </div>
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-[0.22em] text-milk/35">Launch Command</p>
              <pre className="overflow-x-auto rounded-lg border border-line bg-black/20 p-3 text-xs text-milk/72">
                {model.launch.command.join(" ")}
              </pre>
            </div>
          </div>
        ) : null}

        {tab === "logs" ? (
          <div className="space-y-3">
            <p className="text-xs uppercase tracking-[0.22em] text-milk/35">{logs.path}</p>
            <pre className="min-h-[28rem] overflow-auto rounded-lg border border-line bg-black/25 p-3 text-xs leading-6 text-milk/72">
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
            {Object.entries(model.settings).map(([key, value]) => (
              <div key={key} className="flex items-start justify-between gap-3 border-b border-line/60 pb-2">
                <span className="uppercase tracking-[0.18em] text-milk/35">{key}</span>
                <span>{String(value)}</span>
              </div>
            ))}
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
