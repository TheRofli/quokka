import { lazy, Suspense, useEffect, useState } from "react";
import { AlertTriangle, DownloadCloud, FlaskConical, MessageSquare, PanelLeft, Settings, Sparkles } from "lucide-react";

import { ControlPanel } from "@/components/control/control-panel";
import { EmptyState } from "@/components/app/empty-state";
import { PageShell } from "@/components/app/page-shell";
import { TopStatusBar } from "@/components/app/top-status-bar";
import { AddModelDialog } from "@/components/dashboard/add-model-dialog";
import type { MetricId } from "@/components/dashboard/metric-detail-dialog";
import { FIRST_RUN_WIZARD_STORAGE_KEY, FirstRunWizard, hasFirstRunWizardState } from "@/components/onboarding/first-run-wizard";
import { RuntimeErrorBoundary } from "@/components/runtime-error-boundary";
import { api } from "@/api/client";
import { useQuokkaDashboard } from "@/hooks/use-quokka-dashboard";
import { formatTimestamp } from "@/lib/utils";
import type { AppUpdateResponse, LlamaCppRuntimeStatus } from "@/types/api";

const ChatWorkspace = lazy(() => import("@/components/chat/chat-workspace").then((module) => ({ default: module.ChatWorkspace })));
const BenchmarkDialog = lazy(() => import("@/components/dashboard/benchmark-dialog").then((module) => ({ default: module.BenchmarkDialog })));
const ModelLibrary = lazy(() => import("@/components/library/model-library").then((module) => ({ default: module.ModelLibrary })));
const MetricDetailDialog = lazy(() => import("@/components/dashboard/metric-detail-dialog").then((module) => ({ default: module.MetricDetailDialog })));

const themes = [
  { id: "quokka", name: "Quokka", description: "Current charcoal, milk white, and beige-brown control room." },
  { id: "graphite", name: "Graphite", description: "Neutral classic dark UI with low color pressure." },
  { id: "oled", name: "OLED Black", description: "Deep black panels for high contrast and less glow." },
  { id: "nordic", name: "Nordic", description: "Cool muted desktop palette for long sessions." },
  { id: "solarized", name: "Solarized Dark", description: "Classic terminal-inspired warm dark colors." },
  { id: "forest", name: "Forest", description: "Green-gray accents for a calmer monitoring wall." },
  { id: "burgundy", name: "Burgundy", description: "Muted red-brown control surface with warm contrast." },
  { id: "clay", name: "Clay", description: "Earthy low-glare palette with stronger amber accents." },
  { id: "matrix", name: "Matrix", description: "Green terminal-inspired theme without rainbow neon." },
  { id: "rose", name: "Rose", description: "Soft dark rose accents for a quieter chat workspace." },
  { id: "paper-dark", name: "Paper Dark", description: "Warm document-like dark theme for reading logs." },
] as const;

const settingsSections = [
  {
    title: "Chat defaults",
    eyebrow: "Assistant",
    body: "Default max tokens, context indicator behavior, attachment limits, and answer timeout will live here.",
  },
  {
    title: "Quokka Lab bridge",
    eyebrow: "External Lab",
    body: "Running model discovery for the standalone Quokka Lab app is exposed at /api/lab/models.",
  },
  {
    title: "Benchmarks",
    eyebrow: "Diagnostics",
    body: "Quick/full presets, startup wait, repeat count, comparison profiles, and report retention.",
  },
  {
    title: "WSL and llama.cpp",
    eyebrow: "Runtime",
    body: "Default distro, llama.cpp path, model scan roots, CUDA graph options, and WSL memory warnings.",
  },
  {
    title: "Logs and privacy",
    eyebrow: "Storage",
    body: "Log retention, crash append behavior, chat history location, and one-click cleanup.",
  },
  {
    title: "Notifications",
    eyebrow: "Desktop",
    body: "Tray alerts for crashes, hot temperatures, failed health checks, and completed benchmark reports.",
  },
] as const;

function LazyPanelFallback({ label }: { label: string }) {
  return (
    <div className="mt-4 min-h-0 flex-1 overflow-hidden rounded-[var(--radius-soft)] border border-line/70 bg-panel/55">
      <EmptyState icon={Sparkles} eyebrow="Loading" title={label} body="Quokka is preparing this workspace." />
    </div>
  );
}

function App() {
  const [sidebarOpen, setSidebarOpen] = useState(() => window.localStorage.getItem("quokka.sidebar.open") !== "0");
  const [mode, setMode] = useState<"control" | "library" | "chat" | "tests" | "settings">("control");
  const [librarySearchQuery, setLibrarySearchQuery] = useState<string | null>(null);
  const [chatMounted, setChatMounted] = useState(false);
  const [addModelOpen, setAddModelOpen] = useState(false);
  const [themeId, setThemeId] = useState(() => window.localStorage.getItem("quokka.theme") ?? "quokka");
  const [firstRunDismissed, setFirstRunDismissed] = useState(() => window.localStorage.getItem("quokka.firstRun.dismissed") === "1");
  const [firstRunWizardStarted, setFirstRunWizardStarted] = useState(hasFirstRunWizardState);
  const [selectedMetricId, setSelectedMetricId] = useState<MetricId | null>(null);
  const [updateStatus, setUpdateStatus] = useState<AppUpdateResponse | null>(null);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const [llamaRuntime, setLlamaRuntime] = useState<LlamaCppRuntimeStatus | null>(null);
  const {
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
    runModelAction,
    clearLogs,
    saveRawConfig,
    deleteModel,
    saveProfile,
  } = useQuokkaDashboard();

  useEffect(() => {
    document.documentElement.dataset.theme = themeId;
    window.localStorage.setItem("quokka.theme", themeId);
  }, [themeId]);

  useEffect(() => {
    window.localStorage.setItem("quokka.sidebar.open", sidebarOpen ? "1" : "0");
  }, [sidebarOpen]);

  useEffect(() => {
    if (mode === "chat") {
      setChatMounted(true);
    }
  }, [mode]);

  useEffect(() => {
    if (!firstRunDismissed && !isLoading && models.length === 0) {
      setFirstRunWizardStarted(true);
    }
  }, [firstRunDismissed, isLoading, models.length]);

  useEffect(() => {
    api.getUpdateStatus().then(setUpdateStatus).catch(() => setUpdateStatus(null));
  }, []);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      api
        .getLlamaCppRuntimeStatus()
        .then((status) => {
          if (active) {
            setLlamaRuntime(status);
          }
        })
        .catch(() => {
          if (active) {
            setLlamaRuntime(null);
          }
        });
    };
    refresh();
    const interval = window.setInterval(() => {
      if (llamaRuntime?.status === "queued" || llamaRuntime?.status === "downloading" || llamaRuntime?.status === "extracting") {
        refresh();
      }
    }, 1500);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [llamaRuntime?.status]);

  const dismissFirstRun = () => {
    setFirstRunDismissed(true);
    setFirstRunWizardStarted(false);
    window.localStorage.setItem("quokka.firstRun.dismissed", "1");
    window.localStorage.removeItem(FIRST_RUN_WIZARD_STORAGE_KEY);
  };

  const openLibrary = (searchQuery?: string | null) => {
    if (searchQuery) {
      setLibrarySearchQuery(searchQuery);
    }
    setMode("library");
  };

  const runUpdate = async () => {
    if (window.quokkaDesktop?.runUpdate) {
      const result = await window.quokkaDesktop.runUpdate({
        installerUrl: updateStatus?.installer_url,
        releaseUrl: updateStatus?.release_url,
      });
      setUpdateMessage(result.message);
      return;
    }
    if (updateStatus?.release_url) {
      window.open(updateStatus.release_url, "_blank", "noopener,noreferrer");
      setUpdateMessage("Opened the latest GitHub release in your browser.");
      return;
    }
    await navigator.clipboard.writeText("quokka update");
    setUpdateMessage("Copied: quokka update");
  };

  const installLlamaCpp = async (variant: "cpu" | "cuda") => {
    const status = await api.installLlamaCppRuntime({ variant });
    setLlamaRuntime(status);
  };

  const llamaRuntimeBusy = llamaRuntime?.status === "queued" || llamaRuntime?.status === "downloading" || llamaRuntime?.status === "extracting";
  const showFirstRunWizard = mode === "control" && !firstRunDismissed && !isLoading && (models.length === 0 || firstRunWizardStarted);
  const settingsCenter = (
    <div className="px-5 py-5">
      <div className="max-w-6xl">
        <p className="text-xs uppercase tracking-[0.24em] text-accent">Settings</p>
        <h1 className="mt-2 text-2xl font-semibold text-milk">Control Center</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-milk/52">
          Tune Quokka's local control room: appearance, runtime setup, chat defaults, model library, updates, and diagnostics.
        </p>

        <section className="mt-6">
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-accent">Appearance</p>
              <h2 className="mt-2 text-xl font-semibold text-milk">Theme Studio</h2>
            </div>
            <span className="hidden text-xs text-milk/38 md:inline">Applies instantly on this machine</span>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
            {themes.map((theme) => (
              <button
                key={theme.id}
                type="button"
                title={theme.description}
                onClick={() => setThemeId(theme.id)}
                className={`min-h-[104px] rounded-[var(--radius-control)] border px-4 py-4 text-left transition-colors ${
                  themeId === theme.id
                    ? "border-accent bg-accent/12 text-milk"
                    : "border-line/70 bg-shell/42 text-milk/68 hover:border-accent/35 hover:bg-white/[0.055]"
                }`}
              >
                <div className="flex h-full items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-milk">{theme.name}</p>
                    <p className="mt-2 text-sm leading-5 text-milk/48">{theme.description}</p>
                  </div>
                  <span className={themeId === theme.id ? "text-accent" : "text-milk/25"}>{themeId === theme.id ? "active" : "preview"}</span>
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="mt-8">
          <p className="text-xs uppercase tracking-[0.24em] text-accent">Control Surface</p>
          <h2 className="mt-2 text-xl font-semibold text-milk">Upcoming Settings</h2>
          <div className="mt-4 divide-y divide-line/55 overflow-hidden rounded-[var(--radius-control)] border border-line/65 bg-shell/34">
            {settingsSections.map((section) => (
              <div key={section.title} className="grid gap-3 px-4 py-4 md:grid-cols-[170px_minmax(0,1fr)]" title={section.body}>
                <p className="text-[11px] uppercase tracking-[0.2em] text-milk/35">{section.eyebrow}</p>
                <div>
                  <p className="font-semibold text-milk">{section.title}</p>
                  <p className="mt-1 text-sm leading-6 text-milk/48">{section.body}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );

  const settingsRight = (
    <div className="px-5 py-5">
      <div className="rounded-[var(--radius-control)] border border-line/70 bg-shell/45 px-4 py-4">
        <p className="text-xs uppercase tracking-[0.24em] text-accent">Update Center</p>
        <h2 className="mt-2 text-xl font-semibold text-milk">Quokka {updateStatus?.current_version?.split("+")[0] ?? "0.2.0"}</h2>
        <p className="mt-2 text-sm leading-6 text-milk/52">{updateStatus?.message ?? "Checking for updates..."}</p>
        <div className="mt-4 grid gap-2 text-sm text-milk/55">
          <span>Install type: {updateStatus?.source_install ? "GitHub source" : "Desktop installer"}</span>
          <span>Latest: {updateStatus?.latest_version ?? "--"}</span>
          <span>Checked: {updateStatus ? formatTimestamp(updateStatus.checked_at) : "Pending"}</span>
        </div>
        <button
          type="button"
          onClick={() => void runUpdate()}
          className="quokka-control mt-4 w-full px-3 py-2 text-sm font-semibold text-live hover:border-live/60"
        >
          {updateStatus?.update_available ? "Update Quokka" : "Check update path"}
        </button>
      </div>

      <div className="mt-4 rounded-[var(--radius-control)] border border-line/70 bg-shell/45 px-4 py-4">
        <p className="text-xs uppercase tracking-[0.24em] text-accent">Install Commands</p>
        <p className="mt-2 text-sm leading-6 text-milk/52">Source installs update fastest. Desktop installer updates require a GitHub Release asset.</p>
        <div className="mt-4 space-y-3">
          {[
            { label: "Install", command: "irm https://raw.githubusercontent.com/TheRofli/Quokka/main/install.ps1 | iex" },
            { label: "Open", command: "quokka" },
            { label: "Update", command: "quokka update" },
          ].map((item) => (
            <div key={item.label} className="rounded-[var(--radius-control)] border border-line/70 bg-panel/42 px-3 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-milk/38">{item.label}</p>
              <code className="mt-2 block break-all font-mono text-xs leading-5 text-milk/70">{item.command}</code>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-4 rounded-[var(--radius-control)] border border-line/70 bg-shell/45 px-4 py-4">
        <p className="text-xs uppercase tracking-[0.24em] text-accent">Windows Runtime</p>
        <p className="mt-2 text-sm leading-6 text-milk/52">GGUF + Windows llama.cpp is the default path. Use Model Library to download, then Add Model to preflight.</p>
        <div className="mt-4 rounded-[var(--radius-control)] border border-line/60 bg-panel/42 px-3 py-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-milk">llama.cpp</p>
            <span className="quokka-pill px-2 py-1 text-xs text-milk/55">{llamaRuntime?.status ?? "checking"}</span>
          </div>
          <p className="mt-2 text-sm leading-5 text-milk/50">{llamaRuntime?.error ?? llamaRuntime?.message ?? "Checking local runtime..."}</p>
          {llamaRuntimeBusy ? (
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
              <div className="h-full rounded-full bg-live" style={{ width: `${Math.max(3, llamaRuntime?.progress_percent ?? 0)}%` }} />
            </div>
          ) : null}
          {llamaRuntime?.llama_server_path ? <p className="mt-2 break-all font-mono text-[11px] leading-5 text-live/70">{llamaRuntime.llama_server_path}</p> : null}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void installLlamaCpp("cpu")}
            disabled={llamaRuntimeBusy}
            className="quokka-control px-3 py-2 text-xs font-semibold text-milk/78 hover:text-accent disabled:cursor-not-allowed disabled:opacity-45"
          >
            Install CPU
          </button>
          <button
            type="button"
            onClick={() => void installLlamaCpp("cuda")}
            disabled={llamaRuntimeBusy}
            className="quokka-control px-3 py-2 text-xs font-semibold text-milk/78 hover:text-live disabled:cursor-not-allowed disabled:opacity-45"
          >
            Install CUDA
          </button>
          <button type="button" onClick={() => openLibrary()} className="quokka-control px-3 py-2 text-xs font-semibold text-milk/78 hover:text-accent">
            Open Library
          </button>
          <button type="button" onClick={() => setAddModelOpen(true)} className="quokka-control px-3 py-2 text-xs font-semibold text-milk/78 hover:text-accent">
            Add Model
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="quokka-page h-screen overflow-hidden bg-shell text-milk">
      <div className="relative flex h-screen w-full overflow-hidden">
        {!sidebarOpen ? (
          <button
            type="button"
            className="absolute left-4 top-4 z-30 hidden h-10 items-center gap-2 border border-line bg-[#111111]/95 px-3 text-xs font-semibold uppercase tracking-[0.08em] text-milk/72 backdrop-blur transition-all duration-300 hover:border-accent/55 hover:text-milk lg:inline-flex"
            onClick={() => setSidebarOpen(true)}
            title="Show navigation sidebar"
          >
            <PanelLeft className="h-4 w-4 rotate-180 transition-transform duration-300" />
            Nav
          </button>
        ) : null}
        <div
          className={`hidden shrink-0 overflow-hidden transition-[width] duration-300 ease-out lg:block ${
            sidebarOpen ? "w-[270px] 2xl:w-[292px]" : "w-0"
          }`}
        >
          <aside className="flex h-full min-h-0 w-full flex-col overflow-hidden border-r border-line/70 bg-shell px-5 pb-8 pt-8">
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="mb-8 flex items-start justify-between gap-4 px-1">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.34em] text-accent">Quokka</p>
                  <p className="mt-2 text-2xl font-semibold text-milk">Local Stack</p>
                </div>
                <button
                  type="button"
                  className="inline-flex h-10 w-10 shrink-0 items-center justify-center border border-line bg-[#111111] text-milk/72 transition-colors hover:border-accent/55 hover:text-milk"
                  onClick={() => setSidebarOpen(false)}
                  title="Hide navigation sidebar"
                >
                  <PanelLeft className="h-4 w-4" />
                </button>
              </div>
              <nav className="space-y-1">
                {[
                  { id: "control", label: "Local Panel", icon: PanelLeft },
                  { id: "library", label: "Model Library", icon: DownloadCloud },
                  { id: "chat", label: "Chat", icon: MessageSquare },
                  { id: "tests", label: "LLM Tests", icon: FlaskConical },
                  { id: "settings", label: "Settings", icon: Settings },
                ].map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    className={`flex w-full items-center gap-3 rounded-lg px-3.5 py-3 text-left text-[15px] font-semibold transition-colors ${
                      mode === id ? "bg-white/[0.09] text-milk" : "text-milk/62 hover:bg-white/[0.045] hover:text-milk"
                    }`}
                    onClick={() => (id === "library" ? openLibrary() : setMode(id as typeof mode))}
                  >
                    <Icon className="h-4 w-4" />
                    {label}
                  </button>
                ))}
              </nav>
              <div className="mt-auto border-t border-line/70 px-2 pt-4 text-xs leading-5 text-milk/42">
                <p>{config?.app_name ?? "Quokka"} v{updateStatus?.current_version?.split("+")[0] ?? config?.version ?? "0.2.0"}</p>
                <p>Last refresh</p>
                <p>{metrics ? formatTimestamp(metrics.timestamp) : "Pending"}</p>
              </div>
            </div>
          </aside>
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-4 pb-4 pt-3 md:px-6 2xl:px-7">
          <div className="mb-4 flex flex-wrap gap-2 border-b border-line/70 pb-4 lg:hidden">
                <button
                  className={`rounded-lg border px-4 py-2 text-sm font-semibold transition-colors ${
                    mode === "control" ? "border-accent bg-accent text-[#171410]" : "border-line bg-white/[0.03] text-milk/62"
                  }`}
                  onClick={() => setMode("control")}
                >
                  Local Panel
                </button>
                <button
                  className={`rounded-lg border px-4 py-2 text-sm font-semibold transition-colors ${
                    mode === "library" ? "border-accent bg-accent text-[#171410]" : "border-line bg-white/[0.03] text-milk/62"
                  }`}
                  onClick={() => openLibrary()}
                >
                  Model Library
                </button>
                <button
                  className={`rounded-lg border px-4 py-2 text-sm font-semibold transition-colors ${
                    mode === "chat" ? "border-accent bg-accent text-[#171410]" : "border-line bg-white/[0.03] text-milk/62"
                  }`}
                  onClick={() => setMode("chat")}
                >
                  Chat
                </button>
                <button
                  className={`rounded-lg border px-4 py-2 text-sm font-semibold transition-colors ${
                    mode === "tests" ? "border-accent bg-accent text-[#171410]" : "border-line bg-white/[0.03] text-milk/62"
                  }`}
                  onClick={() => setMode("tests")}
                >
                  LLM Tests
                </button>
                <button
                  className={`rounded-lg border px-4 py-2 text-sm font-semibold transition-colors ${
                    mode === "settings" ? "border-accent bg-accent text-[#171410]" : "border-line bg-white/[0.03] text-milk/62"
                  }`}
                  onClick={() => setMode("settings")}
                >
                  Settings
                </button>
          </div>

          <TopStatusBar
            mode={mode}
            selectedModel={selectedModel}
            models={models}
            metrics={metrics}
            onOpenAddModel={() => setAddModelOpen(true)}
            onOpenTests={() => setMode("tests")}
          />

        {updateStatus?.update_available ? (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-control)] border border-live/35 bg-live/10 px-4 py-3 text-sm text-milk">
            <div className="flex items-center gap-3">
              <Sparkles className="h-4 w-4 text-live" />
              <span>
                Quokka update available: v{updateStatus.current_version} -&gt; v{updateStatus.latest_version}
                {updateMessage ? <span className="ml-2 text-milk/50">{updateMessage}</span> : null}
              </span>
            </div>
            <button type="button" onClick={() => void runUpdate()} className="quokka-control px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-live hover:border-live/60">
              Update
            </button>
          </div>
        ) : null}

        {error ? (
          <div className="mt-3 flex items-center gap-3 rounded-lg border border-danger/45 bg-danger/10 px-4 py-3 text-sm text-milk">
            <AlertTriangle className="h-4 w-4 text-danger" />
            <span>{error}</span>
          </div>
        ) : null}

        {showFirstRunWizard ? (
          <FirstRunWizard
            modelCount={models.length}
            activeModelId={selectedModelId ?? selectedModel?.id ?? null}
            onAddModel={() => setAddModelOpen(true)}
            onOpenLibrary={(searchQuery) => openLibrary(searchQuery)}
            onOpenTests={() => setMode("tests")}
            onOpenChat={() => setMode("chat")}
            onDismiss={dismissFirstRun}
            onRefreshModels={refreshDashboard}
          />
        ) : null}

        {chatMounted ? (
          <div className={mode === "chat" ? "contents" : "hidden"}>
            <Suspense fallback={<LazyPanelFallback label="Loading Chat..." />}>
              <ChatWorkspace models={models} />
            </Suspense>
          </div>
        ) : null}

        {mode === "tests" ? (
          <Suspense fallback={<LazyPanelFallback label="Loading LLM Tests..." />}>
            <BenchmarkDialog open embedded models={models} onClose={() => setMode("control")} />
          </Suspense>
        ) : null}

        {mode === "library" ? (
          <Suspense fallback={<LazyPanelFallback label="Loading Model Library..." />}>
            <ModelLibrary models={models} metrics={metrics} initialQuery={librarySearchQuery} onAdded={refreshDashboard} />
          </Suspense>
        ) : null}

        {mode === "settings" ? <PageShell center={settingsCenter} right={settingsRight} /> : null}

        {mode === "control" ? (
          <ControlPanel
            metrics={metrics}
            models={models}
            selectedModel={selectedModel}
            selectedModelId={selectedModelId}
            busyModelIds={busyModelIds}
            logs={logs}
            health={health}
            isLoading={isLoading}
            config={config}
            onSelectModel={setSelectedModelId}
            onMetricSelect={setSelectedMetricId}
            onOpenAddModel={() => setAddModelOpen(true)}
            onOpenTests={() => setMode("tests")}
            onRunModelAction={runModelAction}
            onSaveRawConfig={saveRawConfig}
            onDeleteModel={deleteModel}
            onClearLogs={clearLogs}
          />
        ) : null}

        </div>
      </div>
      {selectedMetricId ? (
        <Suspense fallback={null}>
          <MetricDetailDialog
            metricId={selectedMetricId}
            metrics={metrics}
            metricHistory={metricHistory}
            models={models}
            modelResourceHistory={modelResourceHistory}
            onClose={() => setSelectedMetricId(null)}
          />
        </Suspense>
      ) : null}
      {addModelOpen ? (
        <RuntimeErrorBoundary fallbackTitle="Add Model failed to render" onReset={() => setAddModelOpen(false)}>
          <AddModelDialog open={addModelOpen} models={models} onClose={() => setAddModelOpen(false)} onAdded={refreshDashboard} />
        </RuntimeErrorBoundary>
      ) : null}
    </div>
  );
}

export default App;
