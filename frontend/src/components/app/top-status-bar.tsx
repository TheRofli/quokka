import { Cpu, Database, Gauge, HardDrive, Plus, Server, TestTube2, Zap, type LucideIcon } from "lucide-react";

import type { ModelStatus, ModelView, SystemMetricsResponse } from "@/types/api";

type AppMode = "control" | "library" | "chat" | "tests" | "settings";

interface TopStatusBarProps {
  mode: AppMode;
  selectedModel: ModelView | null;
  models: ModelView[];
  metrics: SystemMetricsResponse | null;
  onOpenAddModel: () => void;
  onOpenTests: () => void;
}

const modeLabels: Record<AppMode, string> = {
  control: "Local Panel",
  library: "Model Library",
  chat: "Chat",
  tests: "LLM Tests",
  settings: "Settings",
};

function readNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function formatCompact(value: number | null | undefined, suffix = "") {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "--";
  }
  if (Math.abs(value) >= 1000) {
    return `${Math.round(value).toLocaleString()}${suffix}`;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)}${suffix}`;
}

function statusTone(status?: ModelStatus | string | null) {
  switch (status) {
    case "running":
    case "warming":
      return "bg-success text-success";
    case "starting":
    case "stopping":
      return "bg-live text-live";
    case "unhealthy":
    case "crashed":
    case "error":
      return "bg-danger text-danger";
    default:
      return "bg-warning text-warning";
  }
}

function StatusPill({
  icon: Icon,
  label,
  value,
  tone = "text-milk",
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="quokka-pill flex min-w-0 items-center gap-2 px-3 py-2">
      <Icon className={`h-4 w-4 ${tone}`} />
      <div className="min-w-0">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-milk/45">{label}</p>
        <p className={`truncate text-sm font-semibold ${tone}`}>{value}</p>
      </div>
    </div>
  );
}

export function TopStatusBar({
  mode,
  selectedModel,
  models,
  metrics,
  onOpenAddModel,
  onOpenTests,
}: TopStatusBarProps) {
  const runningModels = metrics?.active_models ?? models.filter((model) => model.runtime.status === "running").length;
  const status = selectedModel?.runtime.status ?? "no model";
  const dotTone = statusTone(status).split(" ")[0];
  const textTone = statusTone(status).split(" ")[1];
  const ctx = readNumber(selectedModel?.active_profile?.context_size, selectedModel?.metadata.context_size);
  const tokensPerSecond = readNumber(
    selectedModel?.runtime.details.tokens_per_second,
    selectedModel?.runtime.details.decode_tokens_per_second,
    selectedModel?.runtime.details.tok_s,
    selectedModel?.metadata.tokens_per_second,
  );
  const gpuPercent = readNumber(metrics?.gpu_usage_percent);
  const gpuMemoryUsed = readNumber(metrics?.gpu_memory_used_mb);
  const gpuMemoryTotal = readNumber(metrics?.gpu_memory_total_mb);
  const vram =
    gpuMemoryUsed !== null && gpuMemoryTotal !== null
      ? `${(gpuMemoryUsed / 1024).toFixed(1)} / ${(gpuMemoryTotal / 1024).toFixed(1)} GB`
      : "--";

  return (
    <section className="quokka-topbar flex min-h-[74px] shrink-0 items-center gap-4 overflow-hidden px-4 py-3">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className={`h-3 w-3 shrink-0 rounded-full ${dotTone}`} />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-semibold text-milk">
              {selectedModel?.name ?? "No model selected"}
            </p>
            <span className={`rounded-full bg-current/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.16em] ${textTone}`}>
              {status}
            </span>
            <span className="rounded-full border border-line/55 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-milk/45">
              {modeLabels[mode]}
            </span>
          </div>
          <p className="mt-1 truncate text-xs text-milk/48">
            {selectedModel?.endpoint ?? "Add a GGUF, import Ollama, or connect an existing local endpoint"}
          </p>
        </div>
      </div>

      <div className="hidden min-w-0 grid-cols-4 gap-2 xl:grid">
        <StatusPill icon={Gauge} label="tok/s" value={tokensPerSecond ? formatCompact(tokensPerSecond) : "0"} tone="text-live" />
        <StatusPill icon={Database} label="ctx" value={ctx ? `${Math.round(ctx / 1000)}K` : "--"} />
        <StatusPill icon={Zap} label="gpu" value={gpuPercent === null ? "--" : `${formatCompact(gpuPercent, "%")}`} tone="text-live" />
        <StatusPill icon={HardDrive} label="vram" value={vram} tone="text-accent" />
      </div>

      <div className="hidden items-center gap-2 2xl:flex">
        <StatusPill icon={Cpu} label="cpu" value={metrics ? `${formatCompact(metrics.cpu_usage_percent, "%")}` : "--"} />
        <StatusPill icon={Server} label="running" value={`${runningModels} / ${models.length}`} />
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={onOpenTests}
          className="quokka-control hidden items-center gap-2 px-3 py-2 text-xs font-semibold text-milk/78 transition hover:border-live/60 hover:text-live md:flex"
        >
          <TestTube2 className="h-4 w-4" />
          Tests
        </button>
        <button
          type="button"
          onClick={onOpenAddModel}
          className="quokka-control flex items-center gap-2 px-3 py-2 text-xs font-semibold text-milk transition hover:border-accent/70 hover:text-accent"
        >
          <Plus className="h-4 w-4" />
          Add
        </button>
      </div>
    </section>
  );
}
