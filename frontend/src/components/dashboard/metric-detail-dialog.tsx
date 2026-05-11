import "chart.js/auto";

import { useMemo, useState } from "react";
import type { ChartData, ChartOptions } from "chart.js";
import { Line } from "react-chartjs-2";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn, formatNumber } from "@/lib/utils";
import type { MetricHistoryPoint, ModelResourceHistoryPoint, ModelResourceUsage, ModelView, ProcessMetric, SystemMetricsResponse } from "@/types/api";

export type MetricId = "gpu" | "vram" | "gpu-temp" | "cpu" | "ram" | "disk" | "network" | "models";

interface MetricDetailDialogProps {
  metricId: MetricId | null;
  metrics: SystemMetricsResponse | null;
  metricHistory: MetricHistoryPoint[];
  models: ModelView[];
  modelResourceHistory: ModelResourceHistoryPoint[];
  onClose: () => void;
}

const copy: Record<MetricId, { title: string; subtitle: string; empty: string }> = {
  gpu: {
    title: "GPU Usage",
    subtitle: "Compute load, power draw, fans, and GPU memory pressure.",
    empty: "No GPU telemetry is available.",
  },
  vram: {
    title: "VRAM",
    subtitle: "Used, free, and total video memory across detected devices.",
    empty: "No VRAM telemetry is available.",
  },
  "gpu-temp": {
    title: "GPU Temperature",
    subtitle: "Thermal state, fan speed, and power headroom.",
    empty: "No temperature telemetry is available.",
  },
  cpu: {
    title: "CPU",
    subtitle: "Per-core load, frequency, temperature, cache info, and recent history.",
    empty: "No CPU telemetry is available.",
  },
  ram: {
    title: "RAM",
    subtitle: "Memory pressure with used, free, cached, shared, and slab values when available.",
    empty: "No RAM telemetry is available.",
  },
  disk: {
    title: "Disk I/O",
    subtitle: "Read/write throughput and partition usage.",
    empty: "No disk telemetry is available.",
  },
  network: {
    title: "Network",
    subtitle: "Inbound/outbound throughput, TCP connections, and interface status.",
    empty: "No network telemetry is available.",
  },
  models: {
    title: "Active Models",
    subtitle: "Configured endpoints, runtime states, and model-related processes.",
    empty: "No models are configured.",
  },
};

type ModelImpactConfig = {
  title: string;
  subtitle: string;
  unit: string;
  suffix: string;
  digits: number;
  valueLabel: string;
  empty: string;
  note?: string;
  pickHistory: (point: ModelResourceHistoryPoint) => number | null | undefined;
  pickCurrent: (usage?: ModelResourceUsage | null) => number | null | undefined;
};

const modelImpactCopy: Record<MetricId, ModelImpactConfig> = {
  gpu: {
    title: "Model GPU Load",
    subtitle: "Best-effort GPU utilization attributed to each local model.",
    unit: "%",
    suffix: "%",
    digits: 1,
    valueLabel: "GPU load",
    empty: "No per-model GPU load is visible yet.",
    pickHistory: (point) => point.gpu_percent,
    pickCurrent: (usage) => usage?.gpu_percent,
  },
  vram: {
    title: "Model VRAM Footprint",
    subtitle: "Which model is occupying GPU memory right now.",
    unit: "MB",
    suffix: " MB",
    digits: 0,
    valueLabel: "VRAM",
    empty: "No per-model VRAM samples are available yet.",
    pickHistory: (point) => point.vram_mb,
    pickCurrent: (usage) => usage?.vram_mb,
  },
  "gpu-temp": {
    title: "Model Thermal Pressure Proxy",
    subtitle: "GPU temperature is device-level; Quokka shows model VRAM as the closest useful contributor.",
    unit: "MB",
    suffix: " MB",
    digits: 0,
    valueLabel: "VRAM",
    empty: "No per-model GPU footprint is visible yet.",
    note: "NVIDIA does not expose a separate temperature per model process, so this chart uses VRAM footprint as a practical proxy.",
    pickHistory: (point) => point.vram_mb,
    pickCurrent: (usage) => usage?.vram_mb,
  },
  cpu: {
    title: "Model CPU Load",
    subtitle: "CPU used by visible model processes and their child processes.",
    unit: "%",
    suffix: "%",
    digits: 1,
    valueLabel: "CPU",
    empty: "No per-model CPU samples are available yet.",
    pickHistory: (point) => point.cpu_percent,
    pickCurrent: (usage) => usage?.cpu_percent,
  },
  ram: {
    title: "Model RAM Footprint",
    subtitle: "Resident memory held by each visible model process.",
    unit: "MB",
    suffix: " MB",
    digits: 0,
    valueLabel: "RAM",
    empty: "No per-model RAM samples are available yet.",
    pickHistory: (point) => point.ram_mb,
    pickCurrent: (usage) => usage?.ram_mb,
  },
  disk: {
    title: "Model Disk Activity",
    subtitle: "Read plus write throughput for each visible model process.",
    unit: "MB/s",
    suffix: " MB/s",
    digits: 2,
    valueLabel: "Disk I/O",
    empty: "No per-model disk activity is visible yet.",
    pickHistory: (point) => (point.disk_read_mb_s ?? 0) + (point.disk_write_mb_s ?? 0),
    pickCurrent: (usage) => (usage?.disk_read_mb_s ?? 0) + (usage?.disk_write_mb_s ?? 0),
  },
  network: {
    title: "Model Network Attribution",
    subtitle: "Network counters are system-level on this platform; per-model traffic needs a lower-level Windows collector.",
    unit: "Mbps",
    suffix: " Mbps",
    digits: 2,
    valueLabel: "Network",
    empty: "Per-model network throughput is not available yet.",
    note: "Windows does not expose reliable per-process network throughput through psutil. Quokka keeps this explicit instead of guessing.",
    pickHistory: () => null,
    pickCurrent: () => null,
  },
  models: {
    title: "Active Model Footprint",
    subtitle: "Current memory footprint for all configured local models.",
    unit: "MB",
    suffix: " MB",
    digits: 0,
    valueLabel: "RAM",
    empty: "No per-model resource samples are available yet.",
    pickHistory: (point) => point.ram_mb,
    pickCurrent: (usage) => usage?.ram_mb,
  },
};

const chartColors = ["#b08b66", "#f5f0e7", "#7f8c6d", "#c05c50", "#8d9db6", "#d4b28b", "#b96f5a", "#a5ad8a"];
const ranges = [
  { id: "now", label: "Now", ms: 0 },
  { id: "5m", label: "5 min", ms: 5 * 60 * 1000 },
  { id: "1h", label: "1 hour", ms: 60 * 60 * 1000 },
  { id: "1d", label: "1 day", ms: 24 * 60 * 60 * 1000 },
] as const;

function ratio(value?: number | null, total?: number | null) {
  if (value === null || value === undefined || !total) {
    return null;
  }
  return Math.max(0, Math.min(100, (value / total) * 100));
}

function fmt(value?: number | null, digits = 1, suffix = "") {
  const rendered = formatNumber(value, digits);
  return rendered === "--" ? rendered : `${rendered}${suffix}`;
}

function formatGb(value?: number | null) {
  return fmt(value, 2, " GB");
}

function formatMb(value?: number | null) {
  if (value === null || value === undefined) {
    return "--";
  }
  if (value >= 1024) {
    return `${formatNumber(value / 1024, 2)} GB`;
  }
  return `${formatNumber(value, 0)} MB`;
}

function prettyKey(value?: string | null) {
  if (!value) {
    return "--";
  }
  return value.replace(/_/g, " ");
}

function compactTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date);
}

function statusTone(value?: number | null, warning = 75, danger = 90) {
  if (value === null || value === undefined) {
    return "neutral";
  }
  if (value >= danger) {
    return "danger";
  }
  if (value >= warning) {
    return "warning";
  }
  return "ok";
}

function StatusPill({ label, tone }: { label: string; tone: "ok" | "warning" | "danger" | "neutral" }) {
  return (
    <span
      className={cn(
        "rounded-full border px-2.5 py-1 text-xs font-medium",
        tone === "ok" && "border-success/45 bg-success/12 text-success",
        tone === "warning" && "border-accent/55 bg-accent/15 text-accent",
        tone === "danger" && "border-danger/55 bg-danger/15 text-danger",
        tone === "neutral" && "border-line/65 bg-panel/55 text-milk/55"
      )}
    >
      {label}
    </span>
  );
}

function ProgressLine({ label, value, helper }: { label: string; value: number | null; helper: string }) {
  const width = value ?? 0;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="text-milk/62">{label}</span>
        <span className="font-medium text-milk">{helper}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-milk/[0.07]">
        <div className="h-full bg-accent transition-all" style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

function StatTile({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warning" | "danger" | "neutral" }) {
  return (
    <div className="rounded-[var(--radius-control)] border border-line/70 bg-panel/58 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] uppercase tracking-[0.2em] text-milk/35">{label}</p>
        {tone ? <StatusPill label={tone} tone={tone} /> : null}
      </div>
      <p className="mt-2 text-lg font-semibold text-milk">{value}</p>
    </div>
  );
}

function MetricLineChart({
  history,
  title,
  series,
  ySuffix,
}: {
  history: MetricHistoryPoint[];
  title: string;
  series: { label: string; pick: (point: MetricHistoryPoint) => number | null | undefined }[];
  ySuffix: string;
}) {
  if (!history.length) {
    return (
      <div className="rounded-[var(--radius-control)] border border-line/70 bg-panel/58 px-4 py-8 text-center text-sm text-milk/55">
        Waiting for history samples.
      </div>
    );
  }

  const data: ChartData<"line"> = {
    labels: history.map((point) => compactTime(point.timestamp)),
    datasets: series.map((item, index) => ({
      label: item.label,
      data: history.map((point) => item.pick(point) ?? null),
      borderColor: chartColors[index % chartColors.length],
      backgroundColor: `${chartColors[index % chartColors.length]}33`,
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 3,
      tension: 0.35,
      fill: false,
    })),
  };

  const options: ChartOptions<"line"> = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        labels: { color: "rgba(245, 240, 231, 0.68)", boxWidth: 10, boxHeight: 10 },
      },
      tooltip: {
        callbacks: {
          label: (context) => `${context.dataset.label}: ${formatNumber(Number(context.parsed.y), 2)} ${ySuffix}`,
        },
      },
    },
    scales: {
      x: {
        grid: { color: "rgba(245, 240, 231, 0.06)" },
        ticks: { color: "rgba(245, 240, 231, 0.42)", maxTicksLimit: 6 },
      },
      y: {
        beginAtZero: true,
        grid: { color: "rgba(245, 240, 231, 0.06)" },
        ticks: { color: "rgba(245, 240, 231, 0.42)" },
      },
    },
  };

  return (
    <div className="rounded-[var(--radius-control)] border border-line/70 bg-panel/58 px-4 py-4">
      <p className="mb-3 text-[11px] uppercase tracking-[0.2em] text-milk/35">{title}</p>
      <div className="h-56">
        <Line data={data} options={options} />
      </div>
    </div>
  );
}

function ModelImpactChart({
  metricId,
  history,
  models,
}: {
  metricId: MetricId;
  history: ModelResourceHistoryPoint[];
  models: ModelView[];
}) {
  const config = modelImpactCopy[metricId];
  const timestamps = Array.from(new Set(history.map((point) => point.timestamp))).sort();
  const byModelAndTime = new Map(history.map((point) => [`${point.model_id}:${point.timestamp}`, point]));
  const datasets = models
    .map((model, index) => {
      const data = timestamps.map((timestamp) => {
        const point = byModelAndTime.get(`${model.id}:${timestamp}`);
        return point ? config.pickHistory(point) ?? null : null;
      });
      const hasData = data.some((value) => value !== null && value !== undefined && value > 0);
      return {
        model,
        hasData,
        dataset: {
          label: model.name,
          data,
          borderColor: chartColors[index % chartColors.length],
          backgroundColor: `${chartColors[index % chartColors.length]}33`,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 3,
          tension: 0.35,
          fill: false,
        },
      };
    })
    .filter((item) => item.hasData)
    .slice(0, 8);

  if (!datasets.length || !timestamps.length) {
    return (
      <div className="rounded-[var(--radius-control)] border border-line/70 bg-panel/58 px-4 py-8 text-center text-sm text-milk/55">
        {config.empty}
      </div>
    );
  }

  const data: ChartData<"line"> = {
    labels: timestamps.map(compactTime),
    datasets: datasets.map((item) => item.dataset),
  };

  const options: ChartOptions<"line"> = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        labels: { color: "rgba(245, 240, 231, 0.68)", boxWidth: 10, boxHeight: 10 },
      },
      tooltip: {
        callbacks: {
          label: (context) =>
            `${context.dataset.label}: ${formatNumber(Number(context.parsed.y), config.digits)} ${config.unit}`,
        },
      },
    },
    scales: {
      x: {
        grid: { color: "rgba(245, 240, 231, 0.06)" },
        ticks: { color: "rgba(245, 240, 231, 0.42)", maxTicksLimit: 6 },
      },
      y: {
        beginAtZero: true,
        grid: { color: "rgba(245, 240, 231, 0.06)" },
        ticks: { color: "rgba(245, 240, 231, 0.42)" },
      },
    },
  };

  return (
    <div className="h-52">
      <Line data={data} options={options} />
    </div>
  );
}

function ModelImpactPanel({
  metricId,
  models,
  history,
}: {
  metricId: MetricId;
  models: ModelView[];
  history: ModelResourceHistoryPoint[];
}) {
  const config = modelImpactCopy[metricId];
  const rows = models
    .map((model) => {
      const value = config.pickCurrent(model.runtime.resource_usage);
      return { model, value };
    })
    .sort((left, right) => (right.value ?? -1) - (left.value ?? -1));

  return (
    <div className="mb-5 rounded-[var(--radius-control)] border border-line/70 bg-panel/58 px-4 py-4">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.2em] text-accent">Model Impact</p>
          <h3 className="mt-1 text-lg font-semibold text-milk">{config.title}</h3>
          <p className="mt-1 text-sm text-milk/50">{config.subtitle}</p>
        </div>
        {config.note ? (
          <span className="max-w-md rounded-[var(--radius-control)] border border-accent/35 bg-accent/12 px-3 py-2 text-xs leading-5 text-milk/70">
            {config.note}
          </span>
        ) : null}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <ModelImpactChart metricId={metricId} history={history} models={models} />
        <div className="overflow-hidden rounded-[var(--radius-control)] border border-line/70 bg-shell/45">
          <div className="grid grid-cols-[minmax(0,1fr)_100px_96px] gap-3 border-b border-line/65 px-3 py-2 text-[10px] uppercase tracking-[0.16em] text-milk/35">
            <span>Model</span>
            <span className="text-right">{config.valueLabel}</span>
            <span className="text-right">Link</span>
          </div>
          {rows.map(({ model, value }) => (
            <div key={`${metricId}-${model.id}`} className="grid grid-cols-[minmax(0,1fr)_100px_96px] gap-3 border-b border-line/50 px-3 py-3 text-sm last:border-b-0">
              <span className="min-w-0">
                <span className="block truncate font-medium text-milk">{model.name}</span>
                <span className="mt-1 block truncate text-xs text-milk/35">{model.runtime.status}</span>
              </span>
              <span className="text-right font-semibold text-milk">
                {value === null || value === undefined ? "--" : `${formatNumber(value, config.digits)}${config.suffix}`}
              </span>
              <span className="truncate text-right text-xs text-milk/45">
                {prettyKey(model.runtime.resource_usage?.attribution)}
              </span>
            </div>
          ))}
          {!rows.length ? <p className="px-3 py-4 text-sm text-milk/45">No models are configured.</p> : null}
        </div>
      </div>
    </div>
  );
}

function ModelLinesBlock({
  metricId,
  models,
  history,
}: {
  metricId: MetricId;
  models: ModelView[];
  history: ModelResourceHistoryPoint[];
}) {
  const config = modelImpactCopy[metricId];
  return (
    <div className="rounded-[var(--radius-control)] border border-line/70 bg-panel/58 px-4 py-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.2em] text-accent">Model lines</p>
          <p className="mt-1 text-sm text-milk/50">{config.valueLabel} per visible local model</p>
        </div>
        <span className="text-xs text-milk/35">{config.unit}</span>
      </div>
      <ModelImpactChart metricId={metricId} history={history} models={models} />
    </div>
  );
}

function KeyValueRows({ rows }: { rows: { label: string; value: string; tone?: "ok" | "warning" | "danger" | "neutral" }[] }) {
  return (
    <div className="overflow-hidden rounded-[var(--radius-control)] border border-line/70 bg-panel/58">
      {rows.map((row) => (
        <div key={row.label} className="flex items-center justify-between gap-4 border-b border-line/50 px-4 py-3 last:border-b-0">
          <span className="text-[11px] uppercase tracking-[0.2em] text-milk/35">{row.label}</span>
          <span className="flex items-center gap-2 text-right text-sm font-medium text-milk">
            {row.value}
            {row.tone ? <StatusPill label={row.tone} tone={row.tone} /> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

function ProcessTable({ processes, empty }: { processes: ProcessMetric[]; empty: string }) {
  if (!processes.length) {
    return <p className="rounded-[var(--radius-control)] border border-line/70 bg-panel/58 px-4 py-4 text-sm text-milk/55">{empty}</p>;
  }

  return (
    <div className="overflow-hidden rounded-[var(--radius-control)] border border-line/70 bg-panel/58">
      <div className="grid grid-cols-[70px_minmax(0,1fr)_88px_88px] gap-3 border-b border-line/65 px-4 py-2 text-[11px] uppercase tracking-[0.18em] text-milk/35">
        <span>PID</span>
        <span>Process</span>
        <span className="text-right">CPU</span>
        <span className="text-right">RAM</span>
      </div>
      {processes.map((process) => (
        <div key={`${process.pid}-${process.name}`} className="grid grid-cols-[70px_minmax(0,1fr)_88px_88px] gap-3 border-b border-line/50 px-4 py-3 text-sm last:border-b-0">
          <span className="text-milk/55">{process.pid}</span>
          <span className="min-w-0">
            <span className="block truncate font-medium text-milk">{process.name}</span>
            {process.command ? <span className="mt-1 block truncate text-xs text-milk/35">{process.command}</span> : null}
          </span>
          <span className="text-right text-milk">{fmt(process.cpu_percent, 1, "%")}</span>
          <span className="text-right text-milk">{fmt(process.memory_mb, 1, " MB")}</span>
        </div>
      ))}
    </div>
  );
}

export function MetricDetailDialog({ metricId, metrics, metricHistory, models, modelResourceHistory, onClose }: MetricDetailDialogProps) {
  const [rangeId, setRangeId] = useState<(typeof ranges)[number]["id"]>("now");
  const activeRange = ranges.find((range) => range.id === rangeId) ?? ranges[0];
  const rangedModelHistory = useMemo(() => {
    if (activeRange.id === "now") {
      const timestamp = metrics?.timestamp ?? new Date().toISOString();
      return models
        .map((model): ModelResourceHistoryPoint => {
          const usage = model.runtime.resource_usage;
          return {
            timestamp,
            model_id: model.id,
            model_name: model.name,
            status: model.runtime.status,
            cpu_percent: usage?.cpu_percent,
            ram_mb: usage?.ram_mb,
            memory_percent: usage?.memory_percent,
            vram_mb: usage?.vram_mb,
            gpu_percent: usage?.gpu_percent,
            disk_read_mb_s: usage?.disk_read_mb_s,
            disk_write_mb_s: usage?.disk_write_mb_s,
            attribution: usage?.attribution ?? "none",
            confidence: usage?.confidence ?? "low",
          };
        })
        .filter((point) =>
          [point.cpu_percent, point.ram_mb, point.vram_mb, point.gpu_percent, point.disk_read_mb_s, point.disk_write_mb_s].some(
            (value) => value !== null && value !== undefined
          )
        );
    }
    const cutoff = Date.now() - activeRange.ms;
    return modelResourceHistory.filter((point) => new Date(point.timestamp).getTime() >= cutoff);
  }, [activeRange.id, activeRange.ms, metrics?.timestamp, modelResourceHistory, models]);
  const rangedMetricHistory = useMemo(() => {
    const baseHistory = metricHistory.length ? metricHistory : metrics?.history ?? [];
    if (activeRange.id === "now") {
      if (metrics) {
        return [
          {
            timestamp: metrics.timestamp,
            cpu_usage_percent: metrics.cpu_usage_percent,
            ram_usage_percent: metrics.ram_usage_percent,
            gpu_usage_percent: metrics.gpu_usage_percent,
            gpu_memory_used_mb: metrics.gpu_memory_used_mb,
            disk_read_mb_s: metrics.disk_read_mb_s,
            disk_write_mb_s: metrics.disk_write_mb_s,
            network_rx_mbps: metrics.network_rx_mbps,
            network_tx_mbps: metrics.network_tx_mbps,
          },
        ];
      }
      return baseHistory.slice(-1);
    }
    const cutoff = Date.now() - activeRange.ms;
    return baseHistory.filter((point) => new Date(point.timestamp).getTime() >= cutoff);
  }, [activeRange.id, activeRange.ms, metricHistory, metrics]);
  if (!metricId) {
    return null;
  }

  const content = copy[metricId];
  const gpuDevices = metrics?.gpu_devices ?? [];
  const gpu = gpuDevices[0];
  const vramRatio = ratio(metrics?.gpu_memory_used_mb, metrics?.gpu_memory_total_mb);
  const memory = metrics?.memory ?? {
    total_gb: metrics?.ram_total_gb ?? 0,
    used_gb: metrics?.ram_used_gb ?? 0,
    available_gb: Math.max((metrics?.ram_total_gb ?? 0) - (metrics?.ram_used_gb ?? 0), 0),
    free_gb: Math.max((metrics?.ram_total_gb ?? 0) - (metrics?.ram_used_gb ?? 0), 0),
    usage_percent: metrics?.ram_usage_percent ?? 0,
  };
  const cpuCache = metrics?.cpu_cache ?? {};
  const diskPartitions = metrics?.disk_partitions ?? [];
  const topProcesses = metrics?.top_processes ?? [];
  const modelProcesses = metrics?.model_processes ?? [];
  const runningModels = models.filter((model) => model.runtime.status === "running");
  const warningModels = models.filter((model) =>
    ["starting", "warming", "stopping", "unhealthy"].includes(model.runtime.status)
  );
  const failedModels = models.filter((model) => ["crashed", "error"].includes(model.runtime.status));
  const history = rangedMetricHistory;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-shell/82 px-4 py-6 backdrop-blur-md">
      <div className="quokka-zone max-h-[90vh] w-full max-w-6xl overflow-hidden rounded-[var(--radius-soft)] shadow-[0_30px_90px_rgba(0,0,0,0.55)]">
        <div className="flex items-start justify-between gap-4 border-b border-line/65 px-6 py-5">
          <div>
            <p className="text-xs uppercase tracking-[0.24em] text-accent">Metric Details</p>
            <h2 className="mt-2 text-2xl font-semibold text-milk">{content.title}</h2>
            <p className="mt-2 text-sm text-milk/55">{content.subtitle}</p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} className="quokka-control rounded-[var(--radius-control)] text-milk/70 hover:text-accent">
            <X className="h-5 w-5" />
          </Button>
        </div>

        <div className="max-h-[calc(90vh-7rem)] overflow-y-auto px-6 py-6">
          <div className="mb-5 flex flex-wrap justify-end gap-2">
            {ranges.map((range) => (
              <Button
                key={range.id}
                variant={range.id === rangeId ? "primary" : "secondary"}
                size="sm"
                onClick={() => setRangeId(range.id)}
                className={`rounded-[var(--radius-control)] ${
                  range.id === rangeId
                    ? "border border-accent bg-accent text-black hover:bg-accent/90"
                    : "border border-line/70 bg-panel/55 text-milk/78 hover:border-accent/55 hover:text-accent"
                }`}
              >
                {range.label}
              </Button>
            ))}
          </div>

          {metricId === "gpu" ? (
            <div className="space-y-5">
              <div className="grid gap-3 md:grid-cols-4">
                <StatTile label="Usage" value={fmt(metrics?.gpu_usage_percent, 1, "%")} tone={statusTone(metrics?.gpu_usage_percent)} />
                <StatTile label="Device" value={gpu?.name ?? "Unavailable"} />
                <StatTile label="Power" value={fmt(gpu?.power_draw_w, 1, " W")} />
                <StatTile label="Fans" value={fmt(gpu?.fan_speed_percent, 0, "%")} />
              </div>
              <MetricLineChart
                title="GPU load, last samples"
                history={history}
                ySuffix="%"
                series={[{ label: "GPU", pick: (point) => point.gpu_usage_percent }]}
              />
              <ModelLinesBlock metricId="gpu" models={models} history={rangedModelHistory} />
              <div className="grid gap-3 md:grid-cols-2">
                {gpuDevices.map((device) => (
                  <div key={device.index} className="rounded-[var(--radius-control)] border border-line/70 bg-panel/58 px-4 py-4">
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-medium text-milk">{device.name}</p>
                      <StatusPill label={`GPU ${device.index}`} tone={statusTone(device.temperature_c, 72, 84)} />
                    </div>
                    <div className="mt-4 space-y-3">
                      <ProgressLine label="Compute" value={device.usage_percent ?? null} helper={fmt(device.usage_percent, 1, "%")} />
                      <ProgressLine
                        label="VRAM"
                        value={ratio(device.memory_used_mb, device.memory_total_mb)}
                        helper={`${fmt(device.memory_used_mb, 0, " MB")} / ${fmt(device.memory_total_mb, 0, " MB")}`}
                      />
                      <KeyValueRows
                        rows={[
                          { label: "Free VRAM", value: fmt(device.memory_free_mb, 0, " MB") },
                          { label: "Temperature", value: fmt(device.temperature_c, 1, " C"), tone: statusTone(device.temperature_c, 72, 84) },
                          { label: "Power Draw", value: fmt(device.power_draw_w, 1, " W") },
                          { label: "Power Limit", value: fmt(device.power_limit_w, 1, " W") },
                          { label: "Fan Speed", value: fmt(device.fan_speed_percent, 0, "%") },
                        ]}
                      />
                    </div>
                  </div>
                ))}
                {!gpuDevices.length ? <p className="text-sm text-milk/50">{content.empty}</p> : null}
              </div>
            </div>
          ) : null}

          {metricId === "vram" ? (
            <div className="space-y-5">
              <div className="grid gap-3 md:grid-cols-4">
                <StatTile label="Used" value={fmt(metrics?.gpu_memory_used_mb, 0, " MB")} />
                <StatTile label="Free" value={fmt(metrics?.gpu_memory_free_mb, 0, " MB")} />
                <StatTile label="Total" value={fmt(metrics?.gpu_memory_total_mb, 0, " MB")} />
                <StatTile label="Pressure" value={fmt(vramRatio, 1, "%")} tone={statusTone(vramRatio)} />
              </div>
              <MetricLineChart
                title="VRAM used, last samples"
                history={history}
                ySuffix="MB"
                series={[{ label: "VRAM used", pick: (point) => point.gpu_memory_used_mb }]}
              />
              <ModelLinesBlock metricId="vram" models={models} history={rangedModelHistory} />
              <ProgressLine label="VRAM pressure" value={vramRatio} helper={fmt(vramRatio, 1, "%")} />
            </div>
          ) : null}

          {metricId === "gpu-temp" ? (
            <div className="space-y-5">
              <div className="grid gap-3 md:grid-cols-4">
                <StatTile label="Temperature" value={fmt(metrics?.gpu_temperature_c, 1, " C")} tone={statusTone(metrics?.gpu_temperature_c, 72, 84)} />
                <StatTile label="Fan Speed" value={fmt(gpu?.fan_speed_percent, 0, "%")} />
                <StatTile label="Power Draw" value={fmt(gpu?.power_draw_w, 1, " W")} />
                <StatTile label="Power Limit" value={fmt(gpu?.power_limit_w, 1, " W")} />
              </div>
              <ProgressLine
                label="Thermal gauge"
                value={metrics?.gpu_temperature_c ? Math.min(metrics.gpu_temperature_c, 100) : null}
                helper={fmt(metrics?.gpu_temperature_c, 1, " C")}
              />
              <KeyValueRows
                rows={(metrics?.gpu_devices ?? []).map((device) => ({
                  label: device.name,
                  value: `${fmt(device.temperature_c, 1, " C")} / ${fmt(device.fan_speed_percent, 0, "% fan")}`,
                  tone: statusTone(device.temperature_c, 72, 84),
                }))}
              />
            </div>
          ) : null}

          {metricId === "cpu" ? (
            <div className="space-y-5">
              <div className="grid gap-3 md:grid-cols-5">
                <StatTile label="Load" value={fmt(metrics?.cpu_usage_percent, 1, "%")} tone={statusTone(metrics?.cpu_usage_percent)} />
                <StatTile label="Frequency" value={fmt(metrics?.cpu_frequency_mhz, 0, " MHz")} />
                <StatTile label="Temperature" value={fmt(metrics?.cpu_temperature_c, 1, " C")} tone={statusTone(metrics?.cpu_temperature_c, 72, 84)} />
                <StatTile label="Physical Cores" value={`${metrics?.cpu_physical_cores ?? "--"}`} />
                <StatTile label="Logical Cores" value={`${metrics?.cpu_logical_cores ?? "--"}`} />
              </div>
              <MetricLineChart
                title="CPU load, last samples"
                history={history}
                ySuffix="%"
                series={[{ label: "CPU", pick: (point) => point.cpu_usage_percent }]}
              />
              <ModelLinesBlock metricId="cpu" models={models} history={rangedModelHistory} />
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
                <div className="rounded-[var(--radius-control)] border border-line/70 bg-panel/58 px-4 py-4">
                  <p className="mb-4 text-[11px] uppercase tracking-[0.2em] text-milk/35">Per-core utilization</p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {(metrics?.cpu_cores ?? []).map((core) => (
                      <ProgressLine
                        key={core.index}
                        label={`Core ${core.index}`}
                        value={core.usage_percent}
                        helper={`${fmt(core.usage_percent, 1, "%")} / ${fmt(core.frequency_mhz, 0, " MHz")}`}
                      />
                    ))}
                  </div>
                </div>
                <KeyValueRows
                  rows={[
                    { label: "Hyper-Threading", value: metrics?.cpu_hyper_threading_enabled ? "Enabled" : "Disabled" },
                    { label: "L1D Cache", value: cpuCache.l1d ?? "--" },
                    { label: "L1I Cache", value: cpuCache.l1i ?? "--" },
                    { label: "L2 Cache", value: cpuCache.l2 ?? "--" },
                    { label: "L3 Cache", value: cpuCache.l3 ?? "--" },
                  ]}
                />
              </div>
              <ProcessTable processes={topProcesses} empty="No process details are available." />
            </div>
          ) : null}

          {metricId === "ram" ? (
            <div className="space-y-5">
              <div className="grid gap-3 md:grid-cols-4">
                <StatTile label="Used" value={formatGb(memory.used_gb)} />
                <StatTile label="Available" value={formatGb(memory.available_gb)} />
                <StatTile label="Free" value={formatGb(memory.free_gb)} />
                <StatTile label="Pressure" value={fmt(memory.usage_percent, 1, "%")} tone={statusTone(memory.usage_percent)} />
              </div>
              <MetricLineChart
                title="RAM usage, last samples"
                history={history}
                ySuffix="%"
                series={[{ label: "RAM", pick: (point) => point.ram_usage_percent }]}
              />
              <ModelLinesBlock metricId="ram" models={models} history={rangedModelHistory} />
              <KeyValueRows
                rows={[
                  { label: "Total", value: formatGb(memory.total_gb) },
                  { label: "Used", value: formatGb(memory.used_gb) },
                  { label: "Available", value: formatGb(memory.available_gb) },
                  { label: "Free", value: formatGb(memory.free_gb) },
                  { label: "Buffers", value: formatGb(memory.buffers_gb) },
                  { label: "Cached", value: formatGb(memory.cached_gb) },
                  { label: "Shared", value: formatGb(memory.shared_gb) },
                  { label: "Slab", value: formatGb(memory.slab_gb) },
                ]}
              />
            </div>
          ) : null}

          {metricId === "disk" ? (
            <div className="space-y-5">
              <div className="grid gap-3 md:grid-cols-3">
                <StatTile label="Read" value={fmt(metrics?.disk_read_mb_s, 2, " MB/s")} />
                <StatTile label="Write" value={fmt(metrics?.disk_write_mb_s, 2, " MB/s")} />
                <StatTile label="Partitions" value={`${diskPartitions.length}`} />
              </div>
              <MetricLineChart
                title="Disk throughput, last samples"
                history={history}
                ySuffix="MB/s"
                series={[
                  { label: "Read", pick: (point) => point.disk_read_mb_s },
                  { label: "Write", pick: (point) => point.disk_write_mb_s },
                ]}
              />
              <ModelLinesBlock metricId="disk" models={models} history={rangedModelHistory} />
              <div className="grid gap-3 md:grid-cols-2">
                {diskPartitions.map((partition) => (
                  <div key={`${partition.device}-${partition.mountpoint}`} className="rounded-[var(--radius-control)] border border-line/70 bg-panel/58 px-4 py-4">
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-medium text-milk">{partition.mountpoint}</p>
                      <StatusPill label={partition.fstype || "disk"} tone={statusTone(partition.usage_percent)} />
                    </div>
                    <p className="mt-1 truncate text-xs text-milk/40">{partition.device}</p>
                    <div className="mt-4">
                      <ProgressLine
                        label="Usage"
                        value={partition.usage_percent}
                        helper={`${fmt(partition.used_gb, 1, " GB")} / ${fmt(partition.total_gb, 1, " GB")}`}
                      />
                    </div>
                  </div>
                ))}
                {!diskPartitions.length ? <p className="text-sm text-milk/50">{content.empty}</p> : null}
              </div>
            </div>
          ) : null}

          {metricId === "network" ? (
            <div className="space-y-5">
              <div className="grid gap-3 md:grid-cols-3">
                <StatTile label="Inbound" value={fmt(metrics?.network_rx_mbps, 2, " Mbps")} />
                <StatTile label="Outbound" value={fmt(metrics?.network_tx_mbps, 2, " Mbps")} />
                <StatTile label="TCP Connections" value={`${metrics?.active_tcp_connections ?? 0}`} />
              </div>
              <MetricLineChart
                title="Network throughput, last samples"
                history={history}
                ySuffix="Mbps"
                series={[
                  { label: "Inbound", pick: (point) => point.network_rx_mbps },
                  { label: "Outbound", pick: (point) => point.network_tx_mbps },
                ]}
              />
              <div className="grid gap-3 md:grid-cols-2">
                {(metrics?.network_interfaces ?? []).map((networkInterface) => (
                  <div key={networkInterface.name} className="rounded-[var(--radius-control)] border border-line/70 bg-panel/58 px-4 py-4">
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-medium text-milk">{networkInterface.name}</p>
                      <StatusPill label={networkInterface.is_up ? "up" : "down"} tone={networkInterface.is_up ? "ok" : "neutral"} />
                    </div>
                    <p className="mt-2 text-sm text-milk/50">Speed: {networkInterface.speed_mbps ? `${networkInterface.speed_mbps} Mbps` : "--"}</p>
                    <p className="mt-1 truncate text-xs text-milk/35">{networkInterface.addresses.join(", ") || "No IP address"}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {metricId === "models" ? (
            <div className="space-y-5">
              <div className="grid gap-3 md:grid-cols-4">
                <StatTile label="Configured" value={`${models.length}`} />
                <StatTile label="Running" value={`${runningModels.length}`} />
                <StatTile label="Warming" value={`${warningModels.length}`} />
                <StatTile label="Failed" value={`${failedModels.length}`} tone={failedModels.length ? "danger" : "ok"} />
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                {models.map((model) => (
                  <div key={model.id} className="rounded-[var(--radius-control)] border border-line/70 bg-panel/58 px-4 py-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-medium text-milk">{model.name}</p>
                        <p className="mt-1 text-sm text-milk/45">{model.endpoint}</p>
                      </div>
                      <span className="rounded-full border border-line/65 bg-panel/55 px-2 py-1 text-xs text-milk/60">{model.runtime.status}</span>
                    </div>
                    <div className="mt-4 grid grid-cols-4 gap-2 text-xs">
                      <div>
                        <p className="uppercase tracking-[0.16em] text-milk/30">CPU</p>
                        <p className="mt-1 font-semibold text-milk/75">{fmt(model.runtime.resource_usage?.cpu_percent, 1, "%")}</p>
                      </div>
                      <div>
                        <p className="uppercase tracking-[0.16em] text-milk/30">RAM</p>
                        <p className="mt-1 font-semibold text-milk/75">{formatMb(model.runtime.resource_usage?.ram_mb)}</p>
                      </div>
                      <div>
                        <p className="uppercase tracking-[0.16em] text-milk/30">VRAM</p>
                        <p className="mt-1 font-semibold text-milk/75">{formatMb(model.runtime.resource_usage?.vram_mb)}</p>
                      </div>
                      <div>
                        <p className="uppercase tracking-[0.16em] text-milk/30">Link</p>
                        <p className="mt-1 truncate font-semibold text-milk/75">{prettyKey(model.runtime.resource_usage?.attribution)}</p>
                      </div>
                    </div>
                    {model.runtime.resource_usage?.note ? (
                      <p className="mt-3 text-xs leading-5 text-milk/40">{model.runtime.resource_usage.note}</p>
                    ) : null}
                  </div>
                ))}
                {!models.length ? <p className="text-sm text-milk/50">{content.empty}</p> : null}
              </div>
              <div className="overflow-hidden rounded-[var(--radius-control)] border border-line/70 bg-panel/58">
                <div className="grid grid-cols-[minmax(0,1fr)_96px_96px_96px_120px] gap-3 border-b border-line/65 px-4 py-2 text-[11px] uppercase tracking-[0.18em] text-milk/35">
                  <span>Model</span>
                  <span className="text-right">CPU</span>
                  <span className="text-right">RAM</span>
                  <span className="text-right">VRAM</span>
                  <span className="text-right">PIDs</span>
                </div>
                {models.map((model) => (
                  <div key={`${model.id}-resources`} className="grid grid-cols-[minmax(0,1fr)_96px_96px_96px_120px] gap-3 border-b border-line/50 px-4 py-3 text-sm last:border-b-0">
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-milk">{model.name}</span>
                      <span className="mt-1 block truncate text-xs text-milk/35">
                        {prettyKey(model.runtime.resource_usage?.confidence)} confidence
                      </span>
                    </span>
                    <span className="text-right text-milk">{fmt(model.runtime.resource_usage?.cpu_percent, 1, "%")}</span>
                    <span className="text-right text-milk">{formatMb(model.runtime.resource_usage?.ram_mb)}</span>
                    <span className="text-right text-milk">{formatMb(model.runtime.resource_usage?.vram_mb)}</span>
                    <span className="truncate text-right text-milk/60">
                      {model.runtime.resource_usage?.pids.join(", ") || "--"}
                    </span>
                  </div>
                ))}
              </div>
              <ProcessTable processes={modelProcesses} empty="No llama.cpp or Ollama process is visible yet." />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
