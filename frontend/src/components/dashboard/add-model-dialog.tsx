import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, FileCheck2, FileSearch, FolderOpen, HardDrive, Plus, RefreshCw, Server, SlidersHorizontal, X } from "lucide-react";

import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn, formatNumber } from "@/lib/utils";
import type { CreateModelRequest, DiscoveredModelArtifact, LlamaCppRuntimeStatus, ModelView, RuntimeSetupCheckResponse, TestLaunchResponse } from "@/types/api";

interface AddModelDialogProps {
  open: boolean;
  models: ModelView[];
  onClose: () => void;
  onAdded: () => Promise<void>;
}

type WizardStep = "source" | "configure" | "confirm";

const wizardSteps: Array<{ id: WizardStep; label: string }> = [
  { id: "source", label: "Choose source" },
  { id: "configure", label: "Configure runtime" },
  { id: "confirm", label: "Confirm launch" },
];

function portFromModel(model: ModelView) {
  const metadataPort = Number(model.metadata?.port);
  if (Number.isFinite(metadataPort)) {
    return metadataPort;
  }

  const endpointPort = Number(model.endpoint.match(/:(\d+)(?:\/)?$/)?.[1]);
  return Number.isFinite(endpointPort) ? endpointPort : null;
}

function nextPort(models: ModelView[]) {
  const used = new Set(models.map(portFromModel).filter((port): port is number => typeof port === "number"));
  for (let port = 8080; port < 9000; port += 1) {
    if (!used.has(port)) {
      return port;
    }
  }
  return 8080;
}

function bytesToGb(bytes?: number | null) {
  if (!bytes) {
    return "--";
  }
  return `${formatNumber(bytes / 1024 / 1024 / 1024, 2)} GB`;
}

function defaultPayload(models: ModelView[]): CreateModelRequest {
  return {
    provider: "windows_llama_cpp",
    name: "New Local Model",
    model_path: "",
    llama_server_path: null,
    port: nextPort(models),
    host: "127.0.0.1",
    modality: "llm",
    family: null,
    size_label: null,
    quantization: null,
    wsl_distro: "Ubuntu",
    description: null,
    context_size: 8192,
    batch_size: 512,
    ubatch_size: 128,
    temperature: 0.15,
    top_p: 0.9,
    top_k: 30,
    min_p: 0.02,
    cache_type_k: "q4_0",
    cache_type_v: "q4_0",
    extra_args: ["--jinja", "--n-gpu-layers", "999", "--flash-attn", "on", "--parallel", "1", "--cache-ram", "0", "--no-mmap"],
  };
}

function payloadFromArtifact(artifact: DiscoveredModelArtifact, models: ModelView[]): CreateModelRequest {
  return {
    ...defaultPayload(models),
    provider: artifact.provider,
    name: artifact.suggested_name,
    model_path: artifact.launch_path,
    family: artifact.family,
    size_label: artifact.size_label,
    quantization: artifact.quantization,
    description: `Local llama.cpp model from ${artifact.file_name}.`,
  };
}

function inferProviderFromPath(path: string, fallback: CreateModelRequest["provider"]) {
  const trimmed = path.trim();
  if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith("\\\\")) {
    return "windows_llama_cpp";
  }
  if (trimmed.startsWith("/") || trimmed.startsWith("~/")) {
    return "wsl_llama_cpp";
  }
  return fallback;
}

function inferNameFromPath(path: string) {
  const fileName = path.trim().split(/[\\/]/).filter(Boolean).pop() ?? "";
  return fileName.replace(/\.gguf$/i, "").replace(/[-_]+/g, " ").trim() || "New Local Model";
}

function looksLikeLocalPath(value: string) {
  const trimmed = value.trim().replace(/^["']|["']$/g, "");
  return /^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith("\\\\") || trimmed.startsWith("/") || trimmed.startsWith("~/");
}

export function AddModelDialog({ open, models, onClose, onAdded }: AddModelDialogProps) {
  const [query, setQuery] = useState("");
  const [artifacts, setArtifacts] = useState<DiscoveredModelArtifact[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [draft, setDraft] = useState<CreateModelRequest>(() => defaultPayload(models));
  const [isScanning, setIsScanning] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isBulkImporting, setIsBulkImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [runtimeCheck, setRuntimeCheck] = useState<RuntimeSetupCheckResponse | null>(null);
  const [llamaRuntime, setLlamaRuntime] = useState<LlamaCppRuntimeStatus | null>(null);
  const [testLaunch, setTestLaunch] = useState<TestLaunchResponse | null>(null);
  const [isTestingLaunch, setIsTestingLaunch] = useState(false);
  const [step, setStep] = useState<WizardStep>("source");
  const wasOpenRef = useRef(false);

  const selectedArtifact = useMemo(
    () => artifacts.find((artifact) => artifact.launch_path === selectedPath) ?? null,
    [artifacts, selectedPath]
  );
  const safeArtifacts = Array.isArray(artifacts) ? artifacts : [];

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setDraft(defaultPayload(models));
      setSelectedPath(null);
      setError(null);
      setNotice(null);
      setTestLaunch(null);
      setStep("source");
      api
        .getRuntimeSetupCheck()
        .then((check) => {
          setRuntimeCheck(check);
          if (check.llama_server_candidates[0]) {
            setDraft((current) => ({ ...current, llama_server_path: current.llama_server_path || check.llama_server_candidates[0] }));
          }
        })
        .catch(() => setRuntimeCheck(null));
      api
        .getLlamaCppRuntimeStatus()
        .then((status) => {
          setLlamaRuntime(status);
          if (status.llama_server_path) {
            setDraft((current) => ({ ...current, llama_server_path: current.llama_server_path || status.llama_server_path }));
          }
        })
        .catch(() => setLlamaRuntime(null));
    }
    wasOpenRef.current = open;
  }, [models, open]);

  useEffect(() => {
    if (!open || !llamaRuntime || !["queued", "downloading", "extracting"].includes(llamaRuntime.status)) {
      return;
    }
    const interval = window.setInterval(() => {
      api
        .getLlamaCppRuntimeStatus()
        .then((status) => {
          setLlamaRuntime(status);
          if (status.llama_server_path) {
            setDraft((current) => ({ ...current, llama_server_path: current.llama_server_path || status.llama_server_path }));
          }
        })
        .catch(() => undefined);
    }, 1500);
    return () => window.clearInterval(interval);
  }, [llamaRuntime, open]);

  const scan = async () => {
    setIsScanning(true);
    setError(null);
    setNotice(null);
    try {
      const found = await api.discoverModels(query.trim(), 120);
      const nextArtifacts = Array.isArray(found) ? found : [];
      setArtifacts(nextArtifacts);
      if (nextArtifacts[0]) {
        setSelectedPath(nextArtifacts[0].launch_path);
        setDraft(payloadFromArtifact(nextArtifacts[0], models));
        setStep("configure");
      } else if (looksLikeLocalPath(query)) {
        applyManualPath(query);
        setError("No GGUF was discovered in that path. If this is the exact .gguf file, Quokka filled the manual form on the right.");
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Model scan failed");
    } finally {
      setIsScanning(false);
    }
  };

  const importAllFound = async () => {
    const source = query.trim();
    if (!source) {
      setError("Paste a folder such as D:\\Models first, then scan or import.");
      return;
    }

    setIsBulkImporting(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.bulkImportModels({
        query: source,
        limit: 120,
        start_port: nextPort(models),
        context_size: draft.context_size,
        batch_size: draft.batch_size,
        ubatch_size: draft.ubatch_size,
      });
      await onAdded();
      const errorText = result.errors.length ? ` ${result.errors.length} failed.` : "";
      setNotice(`Imported ${result.created.length} model${result.created.length === 1 ? "" : "s"} from ${result.scanned} discovered GGUF file${result.scanned === 1 ? "" : "s"}.${errorText}`);
      if (!result.created.length && result.errors.length) {
        setError(result.errors.map((item) => `${item.path}: ${item.message}`).join("\n"));
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Bulk import failed");
    } finally {
      setIsBulkImporting(false);
    }
  };

  const selectArtifact = (artifact: DiscoveredModelArtifact) => {
    setSelectedPath(artifact.launch_path);
    setDraft(payloadFromArtifact(artifact, models));
    setStep("configure");
  };

  const applyManualPath = (value = query) => {
    const path = value.trim().replace(/^["']|["']$/g, "");
    if (!path) {
      setError("Paste a Windows path like D:\\Models\\model.gguf or choose a discovered GGUF file.");
      return;
    }
    if (/\.(safetensors|bin|pt|pth)$/i.test(path)) {
      setError("This looks like a non-GGUF model file. Quokka Windows llama.cpp launch needs a .gguf file.");
      return;
    }

    setSelectedPath(null);
    setDraft((current) => ({
      ...current,
      provider: inferProviderFromPath(path, current.provider),
      model_path: path,
      name: current.name.trim() && current.name !== "New Local Model" ? current.name : inferNameFromPath(path),
      description: `Local llama.cpp model from ${inferNameFromPath(path)}.`,
    }));
    setError(null);
    setStep("configure");
  };

  const chooseModelFile = async () => {
    if (!window.quokkaDesktop?.openFile) {
      setError("File picker is available in the Quokka desktop app. In browser mode, paste the full GGUF path.");
      return;
    }
    const path = await window.quokkaDesktop.openFile({
      title: "Choose a GGUF model",
      filters: [{ name: "GGUF models", extensions: ["gguf"] }],
    });
    if (path) {
      setQuery(path);
      applyManualPath(path);
    }
  };

  const chooseLlamaServer = async () => {
    if (!window.quokkaDesktop?.openFile) {
      setError("File picker is available in the Quokka desktop app. Paste the llama-server.exe path manually.");
      return;
    }
    const path = await window.quokkaDesktop.openFile({
      title: "Choose llama-server.exe",
      filters: [{ name: "llama.cpp server", extensions: ["exe"] }],
    });
    if (path) {
      setDraft((current) => ({ ...current, provider: "windows_llama_cpp", llama_server_path: path }));
      setError(null);
    }
  };

  const installLlamaCppRuntime = async (variant: "cpu" | "cuda") => {
    setError(null);
    setNotice(null);
    const status = await api.installLlamaCppRuntime({ variant });
    setLlamaRuntime(status);
    setNotice(`llama.cpp ${variant.toUpperCase()} install started. You can leave this dialog open while Quokka downloads it.`);
  };

  const runTestLaunch = async () => {
    setIsTestingLaunch(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.testModelLaunch(draft);
      setTestLaunch(result);
      if (result.llama_server_path && !draft.llama_server_path) {
        setDraft((current) => ({ ...current, llama_server_path: result.llama_server_path ?? current.llama_server_path }));
      }
      if (result.ok) {
        setNotice(result.summary);
      } else {
        setError(result.summary);
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Launch preflight failed");
    } finally {
      setIsTestingLaunch(false);
    }
  };

  const create = async () => {
    if (!draft.model_path.trim()) {
      setError("Choose a discovered GGUF file or paste a model path.");
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      await api.createModel(draft);
      await onAdded();
      onClose();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not add model");
    } finally {
      setIsSaving(false);
    }
  };

  const stepIndex = wizardSteps.findIndex((item) => item.id === step);
  const inputClass = "quokka-input h-10 w-full px-3 text-sm outline-none placeholder:text-milk/30";
  const fieldLabelClass = "text-[11px] font-semibold uppercase tracking-[0.18em] text-milk/42";
  const selectedSourceLabel = selectedArtifact?.file_name ?? (draft.model_path ? inferNameFromPath(draft.model_path) : "No GGUF selected");
  const canContinueFromSource = Boolean(draft.model_path.trim());
  const llamaRuntimeBusy = llamaRuntime?.status === "queued" || llamaRuntime?.status === "downloading" || llamaRuntime?.status === "extracting";

  const goNext = () => {
    if (step === "source") {
      if (!canContinueFromSource) {
        setError("Choose a discovered GGUF file or paste an exact model path first.");
        return;
      }
      setStep("configure");
      return;
    }
    if (step === "configure") {
      setStep("confirm");
    }
  };

  const goBack = () => {
    if (step === "confirm") {
      setStep("configure");
      return;
    }
    if (step === "configure") {
      setStep("source");
    }
  };

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-shell/82 px-4 py-6 backdrop-blur-sm">
      <div className="quokka-surface flex max-h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-[var(--radius-soft)]">
        <div className="flex items-start justify-between gap-4 border-b border-line/60 px-5 py-5">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent">Add Model</p>
            <h2 className="mt-2 text-2xl font-semibold text-milk">Prepare a local LLM runtime</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-milk/55">
              Choose a GGUF source, configure Windows or WSL llama.cpp, then confirm the launch profile before Quokka adds it.
            </p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} className="quokka-control shrink-0 rounded-[var(--radius-control)] text-milk/75 hover:text-accent">
            <X className="h-5 w-5" />
          </Button>
        </div>

        <div className="border-b border-line/60 px-5 py-3">
          <div className="grid gap-2 md:grid-cols-3">
            {wizardSteps.map((item, index) => (
              <button
                key={item.id}
                type="button"
                onClick={() => index <= stepIndex && setStep(item.id)}
                className={cn(
                  "quokka-pill flex items-center gap-2 px-3 py-2 text-left text-sm font-semibold transition",
                  item.id === step ? "border-accent/70 text-accent" : index < stepIndex ? "text-success" : "text-milk/45"
                )}
              >
                {index < stepIndex ? <CheckCircle2 className="h-4 w-4" /> : <span className="grid h-4 w-4 place-items-center rounded-full border border-current text-[10px]">{index + 1}</span>}
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          {step === "source" ? (
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
              <div>
                <div className="grid gap-3 md:grid-cols-3">
                  <button type="button" onClick={() => setQuery("D:\\")} className="quokka-panel rounded-[var(--radius-control)] p-4 text-left transition hover:border-accent/60">
                    <HardDrive className="h-5 w-5 text-accent" />
                    <p className="mt-3 font-semibold text-milk">Scan Windows disk</p>
                    <p className="mt-2 text-sm leading-5 text-milk/50">Point Quokka at D:\, E:\, or a model folder your friend already uses.</p>
                  </button>
                  <button type="button" onClick={() => setQuery("/home/")} className="quokka-panel rounded-[var(--radius-control)] p-4 text-left transition hover:border-accent/60">
                    <Server className="h-5 w-5 text-live" />
                    <p className="mt-3 font-semibold text-milk">Use WSL path</p>
                    <p className="mt-2 text-sm leading-5 text-milk/50">Only when the file is inside Linux. Windows paths stay Windows.</p>
                  </button>
                  <button type="button" onClick={() => applyManualPath()} className="quokka-panel rounded-[var(--radius-control)] p-4 text-left transition hover:border-accent/60">
                    <FileSearch className="h-5 w-5 text-success" />
                    <p className="mt-3 font-semibold text-milk">Paste exact GGUF</p>
                    <p className="mt-2 text-sm leading-5 text-milk/50">Fastest path when you already copied the full model filename.</p>
                  </button>
                </div>

                <div className="mt-5 flex gap-2">
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="D:\Models\model.gguf, D:\Models, or /home/user/models"
                    className={inputClass}
                  />
                  <Button variant="secondary" onClick={() => void scan()} disabled={isScanning} className="quokka-control rounded-[var(--radius-control)] px-4 text-milk/85 hover:text-accent">
                    <RefreshCw className={cn("h-4 w-4", isScanning && "animate-spin")} />
                    {isScanning ? "Scanning" : "Scan"}
                  </Button>
                  <Button variant="secondary" onClick={() => applyManualPath()} className="quokka-control rounded-[var(--radius-control)] px-4 text-milk/85 hover:text-accent">
                    Use path
                  </Button>
                  <Button variant="secondary" onClick={() => void chooseModelFile()} className="quokka-control rounded-[var(--radius-control)] px-4 text-milk/85 hover:text-accent">
                    <FolderOpen className="h-4 w-4" />
                    Pick file
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => void importAllFound()}
                    disabled={isBulkImporting || isScanning}
                    className="quokka-control rounded-[var(--radius-control)] px-4 text-milk/85 hover:text-accent"
                  >
                    <Plus className="h-4 w-4" />
                    {isBulkImporting ? "Importing" : "Import all"}
                  </Button>
                </div>
                <p className="mt-2 text-xs text-milk/42">Scanning is manual, so the dialog opens instantly and never blocks Quokka on huge drives.</p>

                <div className="mt-4 space-y-2">
                  {safeArtifacts.map((artifact) => (
                    <button
                      key={`${artifact.source}-${artifact.launch_path}`}
                      className={cn(
                        "w-full rounded-[var(--radius-control)] border px-4 py-3 text-left transition-colors",
                        selectedArtifact?.launch_path === artifact.launch_path
                          ? "border-accent bg-accent/12"
                          : "border-line/70 bg-surface/50 hover:border-accent/45 hover:bg-panel-2/45"
                      )}
                      onClick={() => selectArtifact(artifact)}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate font-semibold text-milk">{artifact.file_name}</p>
                          <p className="mt-1 truncate text-xs text-milk/48">{artifact.path}</p>
                        </div>
                        <span className="quokka-pill px-2 py-1 text-xs uppercase text-milk/55">{artifact.source}</span>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2 text-xs text-milk/55">
                        <span>{artifact.provider === "windows_llama_cpp" ? "Windows llama.cpp" : "WSL llama.cpp"}</span>
                        <span>{artifact.family ?? "custom"}</span>
                        <span>{artifact.quantization ?? "unknown quant"}</span>
                        <span>{bytesToGb(artifact.size_bytes)}</span>
                      </div>
                    </button>
                  ))}
                  {!safeArtifacts.length ? (
                    <div className="quokka-panel rounded-[var(--radius-control)] px-4 py-10 text-center text-sm text-milk/55">
                      <FileSearch className="mx-auto mb-3 h-6 w-6 text-accent" />
                      {isScanning ? "Scanning model folders..." : "Paste an exact path or scan a folder to discover GGUF files."}
                    </div>
                  ) : null}
                </div>
              </div>

              <aside className="quokka-soft-panel rounded-[var(--radius-control)] p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-accent">Source summary</p>
                <p className="mt-3 text-lg font-semibold text-milk">{selectedSourceLabel}</p>
                <p className="mt-2 break-all text-sm leading-6 text-milk/52">{draft.model_path || "No model path selected yet."}</p>
                <div className="mt-5 space-y-2 text-sm text-milk/55">
                  <p>Windows paths launch without WSL.</p>
                  <p>WSL paths still work when the file lives inside Linux.</p>
                  <p>Quokka will expose running models to Quokka Lab through /api/lab/models.</p>
                </div>
                <div className="mt-5 rounded-[var(--radius-control)] border border-line/60 bg-shell/45 p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-milk/42">Windows setup</p>
                  <p className="mt-2 text-sm text-milk/58">
                    {runtimeCheck?.llama_server_candidates.length
                      ? `Found ${runtimeCheck.llama_server_candidates.length} llama-server.exe candidate.`
                      : "No llama-server.exe found yet."}
                  </p>
                  {runtimeCheck?.llama_server_candidates[0] ? <p className="mt-2 break-all font-mono text-xs text-live/70">{runtimeCheck.llama_server_candidates[0]}</p> : null}
                  <div className="mt-3 rounded-[var(--radius-control)] border border-line/50 bg-panel/40 px-3 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-semibold text-milk/72">Quokka runtime installer</p>
                      <span className="quokka-pill px-2 py-1 text-[10px] text-milk/50">{llamaRuntime?.status ?? "checking"}</span>
                    </div>
                    <p className="mt-2 text-xs leading-5 text-milk/45">{llamaRuntime?.error ?? llamaRuntime?.message ?? "Install llama.cpp if this PC has only a GGUF file and no server executable."}</p>
                    {llamaRuntimeBusy ? (
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                        <div className="h-full rounded-full bg-live" style={{ width: `${Math.max(3, llamaRuntime?.progress_percent ?? 0)}%` }} />
                      </div>
                    ) : null}
                    <div className="mt-3 flex gap-2">
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className="quokka-control flex-1 rounded-[var(--radius-control)]"
                        disabled={llamaRuntimeBusy}
                        onClick={() => void installLlamaCppRuntime("cpu")}
                      >
                        Install CPU
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className="quokka-control flex-1 rounded-[var(--radius-control)]"
                        disabled={llamaRuntimeBusy}
                        onClick={() => void installLlamaCppRuntime("cuda")}
                      >
                        Install CUDA
                      </Button>
                    </div>
                  </div>
                </div>
              </aside>
            </div>
          ) : null}

          {step === "configure" ? (
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
              <div className="space-y-4">
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="space-y-1">
                    <span className={fieldLabelClass}>Runtime</span>
                    <select
                      value={draft.provider}
                      onChange={(event) => setDraft((current) => ({ ...current, provider: event.target.value as CreateModelRequest["provider"] }))}
                      className={inputClass}
                    >
                      <option value="windows_llama_cpp">Windows llama.cpp, no WSL</option>
                      <option value="wsl_llama_cpp">WSL llama.cpp</option>
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span className={fieldLabelClass}>Name</span>
                    <Input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} className={inputClass} />
                  </label>
                </div>

                <label className="space-y-1">
                  <span className={fieldLabelClass}>Model path</span>
                  <Input
                    value={draft.model_path}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        model_path: event.target.value,
                        provider: inferProviderFromPath(event.target.value, current.provider),
                        name: current.name.trim() && current.name !== "New Local Model" ? current.name : inferNameFromPath(event.target.value),
                      }))
                    }
                    className={inputClass}
                  />
                </label>

                {draft.provider === "windows_llama_cpp" ? (
                  <label className="space-y-1">
                    <span className={fieldLabelClass}>llama-server.exe</span>
                    <div className="flex gap-2">
                      <Input
                        value={draft.llama_server_path ?? ""}
                        onChange={(event) => setDraft((current) => ({ ...current, llama_server_path: event.target.value || null }))}
                        placeholder="Optional: leave empty if llama-server.exe is in PATH"
                        className={inputClass}
                      />
                      <Button type="button" variant="secondary" className="quokka-control rounded-[var(--radius-control)] px-3" onClick={() => void chooseLlamaServer()}>
                        Pick
                      </Button>
                    </div>
                    <p className="text-xs text-milk/42">Windows launch uses this executable directly and does not require WSL.</p>
                  </label>
                ) : (
                  <label className="space-y-1">
                    <span className={fieldLabelClass}>WSL distro</span>
                    <Input value={draft.wsl_distro} onChange={(event) => setDraft((current) => ({ ...current, wsl_distro: event.target.value }))} className={inputClass} />
                    <p className="text-xs text-milk/42">Use this only when the model path is inside WSL.</p>
                  </label>
                )}

                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <label className="space-y-1">
                    <span className={fieldLabelClass}>Port</span>
                    <Input type="number" value={draft.port} onChange={(event) => setDraft((current) => ({ ...current, port: Number(event.target.value) }))} className={inputClass} />
                  </label>
                  <label className="space-y-1">
                    <span className={fieldLabelClass}>Context</span>
                    <Input type="number" value={draft.context_size} onChange={(event) => setDraft((current) => ({ ...current, context_size: Number(event.target.value) }))} className={inputClass} />
                  </label>
                  <label className="space-y-1">
                    <span className={fieldLabelClass}>Batch</span>
                    <Input type="number" value={draft.batch_size} onChange={(event) => setDraft((current) => ({ ...current, batch_size: Number(event.target.value) }))} className={inputClass} />
                  </label>
                  <label className="space-y-1">
                    <span className={fieldLabelClass}>uBatch</span>
                    <Input type="number" value={draft.ubatch_size} onChange={(event) => setDraft((current) => ({ ...current, ubatch_size: Number(event.target.value) }))} className={inputClass} />
                  </label>
                </div>

                <label className="space-y-1">
                  <span className={fieldLabelClass}>Extra args</span>
                  <Input
                    value={draft.extra_args.join(" ")}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        extra_args: event.target.value.split(" ").map((item) => item.trim()).filter(Boolean),
                      }))
                    }
                    className={inputClass}
                  />
                </label>
              </div>

              <aside className="quokka-soft-panel rounded-[var(--radius-control)] p-4">
                <SlidersHorizontal className="h-5 w-5 text-accent" />
                <p className="mt-3 text-lg font-semibold text-milk">Runtime profile</p>
                <div className="mt-4 grid gap-3 text-sm text-milk/58">
                  <span>Endpoint: http://{draft.host}:{draft.port}</span>
                  <span>Context: {draft.context_size.toLocaleString()} tokens</span>
                  <span>Batch: {draft.batch_size} / u{draft.ubatch_size}</span>
                  <span>KV cache: {draft.cache_type_k}/{draft.cache_type_v}</span>
                </div>
                {testLaunch ? (
                  <div className="mt-5 rounded-[var(--radius-control)] border border-line/65 bg-shell/45 p-3">
                    <p className={cn("text-sm font-semibold", testLaunch.ok ? "text-success" : "text-danger")}>{testLaunch.summary}</p>
                    <div className="mt-3 space-y-2">
                      {testLaunch.checks.map((check) => (
                        <div key={check.id} className="text-xs leading-5">
                          <span className={check.status === "pass" ? "text-success" : check.status === "fail" ? "text-danger" : "text-warning"}>{check.label}: </span>
                          <span className="text-milk/52">{check.detail}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </aside>
            </div>
          ) : null}

          {step === "confirm" ? (
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
              <div className="quokka-soft-panel rounded-[var(--radius-control)] p-5">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-accent">Ready to add</p>
                <h3 className="mt-3 text-2xl font-semibold text-milk">{draft.name}</h3>
                <div className="mt-5 grid gap-3 text-sm text-milk/62 md:grid-cols-2">
                  <span>Provider: {draft.provider === "windows_llama_cpp" ? "Windows llama.cpp" : "WSL llama.cpp"}</span>
                  <span>Endpoint: http://{draft.host}:{draft.port}</span>
                  <span>Context: {draft.context_size.toLocaleString()}</span>
                  <span>Batch: {draft.batch_size} / u{draft.ubatch_size}</span>
                  <span>Quant: {draft.quantization ?? "unknown"}</span>
                  <span>Family: {draft.family ?? "custom"}</span>
                </div>
                <p className="mt-5 break-all rounded-[var(--radius-control)] border border-line/60 bg-surface/65 px-3 py-3 font-mono text-xs text-milk/55">
                  {draft.model_path}
                </p>
              </div>

              <aside className="quokka-panel rounded-[var(--radius-control)] p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-accent">After adding</p>
                <div className="mt-4 space-y-3 text-sm leading-6 text-milk/58">
                  <p>The model appears in Local Panel.</p>
                  <p>Start it from Quokka, then Chat and Quokka Lab can use the same endpoint.</p>
                  <p>Run LLM Tests later to tune ctx, batch, KV cache, and tok/s.</p>
                </div>
              </aside>
            </div>
          ) : null}

          {notice ? <p className="mt-4 rounded-[var(--radius-control)] border border-success/35 bg-success/10 px-3 py-2 text-sm text-success">{notice}</p> : null}
          {error ? <p className="mt-4 whitespace-pre-wrap rounded-[var(--radius-control)] border border-danger/45 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p> : null}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-line/60 px-5 py-4">
          <Button variant="secondary" className="quokka-control rounded-[var(--radius-control)]" onClick={goBack} disabled={step === "source" || isSaving}>
            Back
          </Button>
          <div className="flex items-center gap-3">
            <Button variant="secondary" className="quokka-control rounded-[var(--radius-control)]" onClick={onClose} disabled={isSaving}>
              Cancel
            </Button>
            {step === "confirm" ? (
              <Button variant="primary" className="rounded-[var(--radius-control)]" onClick={() => void create()} disabled={isSaving}>
                <Plus className="h-4 w-4" />
                {isSaving ? "Adding" : "Add Model"}
              </Button>
            ) : (
              <>
                {step === "configure" ? (
                  <Button variant="secondary" className="quokka-control rounded-[var(--radius-control)]" onClick={() => void runTestLaunch()} disabled={isTestingLaunch || !draft.model_path}>
                    <FileCheck2 className="h-4 w-4" />
                    {isTestingLaunch ? "Testing" : "Test launch"}
                  </Button>
                ) : null}
                <Button variant="primary" className="rounded-[var(--radius-control)]" onClick={goNext}>
                  Continue
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
