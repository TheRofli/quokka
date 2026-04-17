import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Cpu, Gauge, HardDrive, MemoryStick, Thermometer, Zap } from "lucide-react";

import { DetailsPanel } from "@/components/dashboard/details-panel";
import { MetricDetailDialog, type MetricId } from "@/components/dashboard/metric-detail-dialog";
import { ModelCard } from "@/components/dashboard/model-card";
import { SystemMetricCard } from "@/components/dashboard/system-metric-card";
import { useQuokkaDashboard } from "@/hooks/use-quokka-dashboard";
import { formatNumber, formatTimestamp } from "@/lib/utils";

function App() {
  const modelGridRef = useRef<HTMLDivElement>(null);
  const [selectedMetricId, setSelectedMetricId] = useState<MetricId | null>(null);
  const [detailsPanelHeight, setDetailsPanelHeight] = useState<number | null>(null);
  const {
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
    refreshHealth,
    runModelAction,
    saveRawConfig,
    saveProfile,
    deleteProfile,
    activateProfile,
  } = useQuokkaDashboard();

  useEffect(() => {
    const grid = modelGridRef.current;
    if (!grid) {
      return;
    }

    const updatePanelHeight = () => {
      if (!window.matchMedia("(min-width: 1280px)").matches) {
        setDetailsPanelHeight(null);
        return;
      }

      setDetailsPanelHeight(Math.ceil(grid.getBoundingClientRect().height));
    };

    updatePanelHeight();
    const observer = new ResizeObserver(updatePanelHeight);
    observer.observe(grid);
    window.addEventListener("resize", updatePanelHeight);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updatePanelHeight);
    };
  }, [models.length]);

  return (
    <div className="min-h-screen bg-shell text-milk">
      <div className="mx-auto flex min-h-screen max-w-[1680px] flex-col px-4 pb-4 pt-4 md:px-6">
        <header className="border-b border-line/70 pb-4">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-3xl font-semibold text-milk">Quokka Local Control</h1>
              <p className="mt-2 text-sm text-milk/52">
                Monitor GPU, supervise launch profiles, and keep your local endpoints honest.
              </p>
            </div>
            <div className="text-right text-sm text-milk/46">
              <p>{config?.app_name ?? "Quokka"} v{config?.version ?? "0.1.0"}</p>
              <p>Last refresh {metrics ? formatTimestamp(metrics.timestamp) : "Pending"}</p>
            </div>
          </div>
        </header>

        {error ? (
          <div className="mt-4 flex items-center gap-3 rounded-lg border border-danger/45 bg-danger/10 px-4 py-3 text-sm text-milk">
            <AlertTriangle className="h-4 w-4 text-danger" />
            <span>{error}</span>
          </div>
        ) : null}

        <main className="mt-4 flex min-h-0 flex-1 flex-col gap-4">
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
            <SystemMetricCard
              label="GPU Usage"
              value={metrics?.gpu_usage_percent}
              suffix="%"
              helper={metrics?.gpu_devices[0]?.name ?? "nvidia-smi unavailable"}
              icon={Gauge}
              onClick={() => setSelectedMetricId("gpu")}
            />
            <SystemMetricCard
              label="VRAM"
              value={metrics?.gpu_memory_used_mb}
              suffix="MB"
              helper={
                metrics?.gpu_memory_total_mb ? `of ${formatNumber(metrics.gpu_memory_total_mb, 0)} MB total` : "No GPU data"
              }
              icon={HardDrive}
              onClick={() => setSelectedMetricId("vram")}
            />
            <SystemMetricCard
              label="GPU Temp"
              value={metrics?.gpu_temperature_c}
              suffix="C"
              helper="Thermal headroom"
              icon={Thermometer}
              onClick={() => setSelectedMetricId("gpu-temp")}
            />
            <SystemMetricCard
              label="CPU"
              value={metrics?.cpu_usage_percent}
              suffix="%"
              helper="System-wide load"
              icon={Cpu}
              onClick={() => setSelectedMetricId("cpu")}
            />
            <SystemMetricCard
              label="RAM"
              value={metrics?.ram_usage_percent}
              suffix="%"
              helper={metrics ? `${formatNumber(metrics.ram_used_gb, 1)} / ${formatNumber(metrics.ram_total_gb, 1)} GB` : "System memory"}
              icon={MemoryStick}
              onClick={() => setSelectedMetricId("ram")}
            />
            <SystemMetricCard
              label="Active Models"
              value={metrics?.active_models}
              suffix=""
              helper={`${models.length} configured`}
              icon={Zap}
              onClick={() => setSelectedMetricId("models")}
            />
          </section>

          <section className="grid min-h-0 flex-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_390px]">
            <div className="min-h-0">
              <div ref={modelGridRef} className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
                {models.map((model) => (
                  <ModelCard
                    key={model.id}
                    model={model}
                    selected={selectedModelId === model.id}
                    busy={Boolean(busyModelIds[model.id])}
                    onSelect={setSelectedModelId}
                    onAction={runModelAction}
                  />
                ))}
              </div>

              {!models.length && !isLoading ? (
                <div className="rounded-lg border border-line bg-white/[0.04] px-4 py-5 text-sm text-milk/55">
                  No models are configured yet. Edit the Quokka config and the dashboard will populate on the next poll.
                </div>
              ) : null}
            </div>

            <DetailsPanel
              model={selectedModel}
              logs={logs}
              health={health}
              config={config}
              panelHeight={detailsPanelHeight}
              onRefreshHealth={refreshHealth}
              onSaveProfile={saveProfile}
              onDeleteProfile={deleteProfile}
              onActivateProfile={activateProfile}
              onSaveConfig={saveRawConfig}
            />
          </section>
        </main>

      </div>
      <MetricDetailDialog
        metricId={selectedMetricId}
        metrics={metrics}
        models={models}
        onClose={() => setSelectedMetricId(null)}
      />
    </div>
  );
}

export default App;
