import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatNumber } from "@/lib/utils";
import type { ModelView, SystemMetricsResponse } from "@/types/api";

export type MetricId = "gpu" | "vram" | "gpu-temp" | "cpu" | "ram" | "models";

interface MetricDetailDialogProps {
  metricId: MetricId | null;
  metrics: SystemMetricsResponse | null;
  models: ModelView[];
  onClose: () => void;
}

const copy: Record<MetricId, { title: string; subtitle: string; empty: string }> = {
  gpu: {
    title: "GPU Usage",
    subtitle: "Current NVIDIA utilization reported by nvidia-smi.",
    empty: "No GPU telemetry is available.",
  },
  vram: {
    title: "VRAM",
    subtitle: "Video memory currently allocated on detected GPU devices.",
    empty: "No VRAM telemetry is available.",
  },
  "gpu-temp": {
    title: "GPU Temperature",
    subtitle: "Thermal state for local inference workloads.",
    empty: "No temperature telemetry is available.",
  },
  cpu: {
    title: "CPU Usage",
    subtitle: "System-wide processor load while Quokka supervises local models.",
    empty: "No CPU telemetry is available.",
  },
  ram: {
    title: "RAM Usage",
    subtitle: "System memory pressure across the local machine.",
    empty: "No RAM telemetry is available.",
  },
  models: {
    title: "Active Models",
    subtitle: "Configured model endpoints and runtime states.",
    empty: "No models are configured.",
  },
};

function ratio(value?: number | null, total?: number | null) {
  if (value === null || value === undefined || !total) {
    return null;
  }
  return Math.max(0, Math.min(100, (value / total) * 100));
}

function ProgressLine({ label, value, helper }: { label: string; value: number | null; helper: string }) {
  const width = value ?? 0;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="text-milk/62">{label}</span>
        <span className="font-medium text-milk">{helper}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-md bg-white/[0.06]">
        <div className="h-full rounded-md bg-accent transition-all" style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-white/[0.035] px-4 py-3">
      <p className="text-[11px] uppercase tracking-[0.2em] text-milk/35">{label}</p>
      <p className="mt-2 text-lg font-semibold text-milk">{value}</p>
    </div>
  );
}

export function MetricDetailDialog({ metricId, metrics, models, onClose }: MetricDetailDialogProps) {
  if (!metricId) {
    return null;
  }

  const content = copy[metricId];
  const gpu = metrics?.gpu_devices[0];
  const vramRatio = ratio(metrics?.gpu_memory_used_mb, metrics?.gpu_memory_total_mb);
  const runningModels = models.filter((model) => model.runtime.status === "running");
  const warningModels = models.filter((model) =>
    ["starting", "warming", "stopping", "unhealthy"].includes(model.runtime.status)
  );
  const failedModels = models.filter((model) => ["crashed", "error"].includes(model.runtime.status));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 py-6 backdrop-blur-sm">
      <div className="max-h-[86vh] w-full max-w-4xl overflow-hidden rounded-lg border border-line bg-[#151411] shadow-glow">
        <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-5">
          <div>
            <p className="text-xs uppercase tracking-[0.24em] text-accent">Metric Details</p>
            <h2 className="mt-2 text-2xl font-semibold text-milk">{content.title}</h2>
            <p className="mt-2 text-sm text-milk/55">{content.subtitle}</p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-5 w-5" />
          </Button>
        </div>

        <div className="max-h-[calc(86vh-7rem)] overflow-y-auto px-6 py-6">
          {metricId === "gpu" ? (
            <div className="space-y-5">
              <div className="grid gap-3 md:grid-cols-3">
                <StatTile label="Usage" value={`${formatNumber(metrics?.gpu_usage_percent)}%`} />
                <StatTile label="Device" value={gpu?.name ?? "Unavailable"} />
                <StatTile label="Detected GPUs" value={`${metrics?.gpu_devices.length ?? 0}`} />
              </div>
              <ProgressLine
                label="Average GPU load"
                value={metrics?.gpu_usage_percent ?? null}
                helper={`${formatNumber(metrics?.gpu_usage_percent)}%`}
              />
              <div className="grid gap-3 md:grid-cols-2">
                {(metrics?.gpu_devices.length ? metrics.gpu_devices : []).map((device) => (
                  <div key={device.index} className="rounded-lg border border-line bg-white/[0.025] px-4 py-4">
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-medium text-milk">{device.name}</p>
                      <p className="text-sm text-milk/50">GPU {device.index}</p>
                    </div>
                    <div className="mt-4 space-y-3">
                      <ProgressLine
                        label="Compute"
                        value={device.usage_percent ?? null}
                        helper={`${formatNumber(device.usage_percent)}%`}
                      />
                      <ProgressLine
                        label="VRAM"
                        value={ratio(device.memory_used_mb, device.memory_total_mb)}
                        helper={`${formatNumber(device.memory_used_mb, 0)} / ${formatNumber(device.memory_total_mb, 0)} MB`}
                      />
                    </div>
                  </div>
                ))}
                {!metrics?.gpu_devices.length ? <p className="text-sm text-milk/50">{content.empty}</p> : null}
              </div>
            </div>
          ) : null}

          {metricId === "vram" ? (
            <div className="space-y-5">
              <div className="grid gap-3 md:grid-cols-3">
                <StatTile label="Used" value={`${formatNumber(metrics?.gpu_memory_used_mb, 0)} MB`} />
                <StatTile label="Total" value={`${formatNumber(metrics?.gpu_memory_total_mb, 0)} MB`} />
                <StatTile label="Load" value={`${formatNumber(vramRatio)}%`} />
              </div>
              <ProgressLine label="VRAM pressure" value={vramRatio} helper={`${formatNumber(vramRatio)}%`} />
              <p className="text-sm leading-6 text-milk/55">
                High VRAM pressure usually means larger context windows, multiple active models, or heavyweight vision workloads
                are competing for memory.
              </p>
            </div>
          ) : null}

          {metricId === "gpu-temp" ? (
            <div className="space-y-5">
              <div className="grid gap-3 md:grid-cols-3">
                <StatTile label="Temperature" value={`${formatNumber(metrics?.gpu_temperature_c)} C`} />
                <StatTile label="Thermal Band" value={(metrics?.gpu_temperature_c ?? 0) > 80 ? "Hot" : "Normal"} />
                <StatTile label="Device" value={gpu?.name ?? "Unavailable"} />
              </div>
              <ProgressLine
                label="Thermal gauge"
                value={metrics?.gpu_temperature_c ? Math.min(metrics.gpu_temperature_c, 100) : null}
                helper={`${formatNumber(metrics?.gpu_temperature_c)} C`}
              />
            </div>
          ) : null}

          {metricId === "cpu" ? (
            <div className="space-y-5">
              <div className="grid gap-3 md:grid-cols-3">
                <StatTile label="CPU Load" value={`${formatNumber(metrics?.cpu_usage_percent)}%`} />
                <StatTile label="Backend" value="FastAPI supervisor" />
                <StatTile label="Polling" value="5 sec" />
              </div>
              <ProgressLine label="Processor load" value={metrics?.cpu_usage_percent ?? null} helper={`${formatNumber(metrics?.cpu_usage_percent)}%`} />
            </div>
          ) : null}

          {metricId === "ram" ? (
            <div className="space-y-5">
              <div className="grid gap-3 md:grid-cols-3">
                <StatTile label="Used" value={`${formatNumber(metrics?.ram_used_gb, 1)} GB`} />
                <StatTile label="Total" value={`${formatNumber(metrics?.ram_total_gb, 1)} GB`} />
                <StatTile label="Load" value={`${formatNumber(metrics?.ram_usage_percent)}%`} />
              </div>
              <ProgressLine label="RAM pressure" value={metrics?.ram_usage_percent ?? null} helper={`${formatNumber(metrics?.ram_usage_percent)}%`} />
            </div>
          ) : null}

          {metricId === "models" ? (
            <div className="space-y-5">
              <div className="grid gap-3 md:grid-cols-4">
                <StatTile label="Configured" value={`${models.length}`} />
                <StatTile label="Running" value={`${runningModels.length}`} />
                <StatTile label="Warming" value={`${warningModels.length}`} />
                <StatTile label="Failed" value={`${failedModels.length}`} />
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                {models.map((model) => (
                  <div key={model.id} className="rounded-lg border border-line bg-white/[0.025] px-4 py-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-medium text-milk">{model.name}</p>
                        <p className="mt-1 text-sm text-milk/45">{model.endpoint}</p>
                      </div>
                      <span className="rounded-md bg-white/[0.06] px-2 py-1 text-xs text-milk/60">{model.runtime.status}</span>
                    </div>
                  </div>
                ))}
                {!models.length ? <p className="text-sm text-milk/50">{content.empty}</p> : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
