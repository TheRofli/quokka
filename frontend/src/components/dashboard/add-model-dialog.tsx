import { useEffect, useMemo, useRef, useState } from "react";
import { FileSearch, Plus, RefreshCw, X } from "lucide-react";

import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatNumber } from "@/lib/utils";
import type { CreateModelRequest, DiscoveredModelArtifact, ModelView } from "@/types/api";

interface AddModelDialogProps {
  open: boolean;
  models: ModelView[];
  onClose: () => void;
  onAdded: () => Promise<void>;
}

function nextPort(models: ModelView[]) {
  const used = new Set(models.map((model) => Number(model.metadata.port)).filter(Number.isFinite));
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

export function AddModelDialog({ open, models, onClose, onAdded }: AddModelDialogProps) {
  const [query, setQuery] = useState("");
  const [artifacts, setArtifacts] = useState<DiscoveredModelArtifact[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [draft, setDraft] = useState<CreateModelRequest>(() => defaultPayload(models));
  const [isScanning, setIsScanning] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wasOpenRef = useRef(false);

  const selectedArtifact = useMemo(
    () => artifacts.find((artifact) => artifact.launch_path === selectedPath) ?? null,
    [artifacts, selectedPath]
  );

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setDraft(defaultPayload(models));
      setSelectedPath(null);
      setError(null);
    }
    wasOpenRef.current = open;
  }, [models, open]);

  const scan = async () => {
    setIsScanning(true);
    setError(null);
    try {
      const found = await api.discoverModels(query, 120);
      setArtifacts(found);
      if (found[0]) {
        setSelectedPath(found[0].launch_path);
        setDraft(payloadFromArtifact(found[0], models));
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Model scan failed");
    } finally {
      setIsScanning(false);
    }
  };

  useEffect(() => {
    if (open) {
      void scan();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const selectArtifact = (artifact: DiscoveredModelArtifact) => {
    setSelectedPath(artifact.launch_path);
    setDraft(payloadFromArtifact(artifact, models));
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

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4 py-6 backdrop-blur-sm">
      <div className="max-h-[90vh] w-full max-w-6xl overflow-hidden border border-[#2A2A2A] bg-[#0A0A0A] shadow-[0_30px_90px_rgba(0,0,0,0.65)]">
        <div className="flex items-start justify-between gap-4 border-b border-[#242424] px-5 py-5">
          <div>
            <p className="text-xs uppercase tracking-[0.24em] text-[#FF8C42]">Add Model</p>
            <h2 className="mt-2 text-2xl font-semibold text-white">Find local GGUF files</h2>
            <p className="mt-2 text-sm text-white/55">
              Quokka scans common Windows drives, WSL ~/llm/models, and any folder pasted into search, then writes the launch config for you.
            </p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} className="rounded-none border border-[#2A2A2A] bg-[#111111] text-white/75 hover:border-[#FF8C42] hover:text-[#FF8C42]">
            <X className="h-5 w-5" />
          </Button>
        </div>

        <div className="grid max-h-[calc(90vh-7rem)] gap-0 overflow-hidden lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="min-h-0 overflow-y-auto border-r border-[#242424] px-5 py-5">
            <div className="flex gap-2">
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search by file, family, or quant"
                className="rounded-none border-[#2A2A2A] bg-[#111111] text-white placeholder:text-white/35"
              />
              <Button
                variant="secondary"
                onClick={() => void scan()}
                disabled={isScanning}
                className="rounded-none border-[#2A2A2A] bg-[#111111] text-white/85 hover:border-[#FF8C42] hover:text-[#FF8C42]"
              >
                <RefreshCw className="h-4 w-4" />
                {isScanning ? "Scanning" : "Scan"}
              </Button>
            </div>

            <div className="mt-4 space-y-2">
              {artifacts.map((artifact) => (
                <button
                  key={`${artifact.source}-${artifact.launch_path}`}
                  className={`w-full border px-4 py-3 text-left transition-colors ${
                    selectedArtifact?.launch_path === artifact.launch_path
                      ? "border-[#FF8C42] bg-[rgba(255,140,66,0.14)]"
                      : "border-[#252525] bg-[#111111] hover:border-[#FF8C42]/45 hover:bg-[rgba(255,140,66,0.08)]"
                  }`}
                  onClick={() => selectArtifact(artifact)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-white">{artifact.file_name}</p>
                      <p className="mt-1 truncate text-xs text-white/48">{artifact.path}</p>
                    </div>
                    <span className="border border-[#2A2A2A] bg-[#0A0A0A] px-2 py-1 text-xs uppercase text-white/55">{artifact.source}</span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2 text-xs text-white/55">
                    <span>{artifact.provider === "windows_llama_cpp" ? "Windows llama.cpp" : "WSL llama.cpp"}</span>
                    <span>{artifact.family ?? "custom"}</span>
                    <span>{artifact.quantization ?? "unknown quant"}</span>
                    <span>{bytesToGb(artifact.size_bytes)}</span>
                  </div>
                </button>
              ))}
              {!artifacts.length ? (
                <div className="border border-[#252525] bg-[#111111] px-4 py-8 text-center text-sm text-white/55">
                  <FileSearch className="mx-auto mb-3 h-6 w-6 text-[#FF8C42]" />
                  No new GGUF files found yet. Paste a folder like D:\Models into search, or paste a GGUF file path manually on the right.
                </div>
              ) : null}
            </div>
          </div>

          <div className="min-h-0 overflow-y-auto px-5 py-5">
            <div className="space-y-3">
              <label className="space-y-1">
                <span className="text-[11px] uppercase tracking-[0.18em] text-white/38">Runtime</span>
                <select
                  value={draft.provider}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, provider: event.target.value as CreateModelRequest["provider"] }))
                  }
                  className="h-10 w-full rounded-none border border-[#2A2A2A] bg-[#111111] px-3 text-sm text-white outline-none"
                >
                  <option value="windows_llama_cpp">Windows llama.cpp, no WSL</option>
                  <option value="wsl_llama_cpp">WSL llama.cpp</option>
                </select>
              </label>
              <label className="space-y-1">
                  <span className="text-[11px] uppercase tracking-[0.18em] text-white/38">Name</span>
                  <Input
                    value={draft.name}
                    onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                    className="rounded-none border-[#2A2A2A] bg-[#111111] text-white"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] uppercase tracking-[0.18em] text-white/38">Model path</span>
                  <Input
                    value={draft.model_path}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        model_path: event.target.value,
                        provider: inferProviderFromPath(event.target.value, current.provider),
                      }))
                    }
                    className="rounded-none border-[#2A2A2A] bg-[#111111] text-white"
                  />
                </label>
                {draft.provider === "windows_llama_cpp" ? (
                  <label className="space-y-1">
                    <span className="text-[11px] uppercase tracking-[0.18em] text-white/38">llama-server.exe</span>
                    <Input
                      value={draft.llama_server_path ?? ""}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, llama_server_path: event.target.value || null }))
                      }
                      placeholder="Optional: leave empty if llama-server.exe is in PATH"
                      className="rounded-none border-[#2A2A2A] bg-[#111111] text-white placeholder:text-white/30"
                    />
                    <p className="text-xs text-white/42">Windows launch uses this executable directly and does not require WSL.</p>
                  </label>
                ) : (
                  <label className="space-y-1">
                    <span className="text-[11px] uppercase tracking-[0.18em] text-white/38">WSL distro</span>
                    <Input
                      value={draft.wsl_distro}
                      onChange={(event) => setDraft((current) => ({ ...current, wsl_distro: event.target.value }))}
                      className="rounded-none border-[#2A2A2A] bg-[#111111] text-white"
                    />
                    <p className="text-xs text-white/42">Use this only when the model path is inside WSL, for example /home/user/llm/models/model.gguf.</p>
                  </label>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <label className="space-y-1">
                    <span className="text-[11px] uppercase tracking-[0.18em] text-white/38">Port</span>
                    <Input
                      type="number"
                      value={draft.port}
                      onChange={(event) => setDraft((current) => ({ ...current, port: Number(event.target.value) }))}
                      className="rounded-none border-[#2A2A2A] bg-[#111111] text-white"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[11px] uppercase tracking-[0.18em] text-white/38">Context</span>
                    <Input
                      type="number"
                      value={draft.context_size}
                      onChange={(event) => setDraft((current) => ({ ...current, context_size: Number(event.target.value) }))}
                      className="rounded-none border-[#2A2A2A] bg-[#111111] text-white"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[11px] uppercase tracking-[0.18em] text-white/38">Batch</span>
                    <Input
                      type="number"
                      value={draft.batch_size}
                      onChange={(event) => setDraft((current) => ({ ...current, batch_size: Number(event.target.value) }))}
                      className="rounded-none border-[#2A2A2A] bg-[#111111] text-white"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[11px] uppercase tracking-[0.18em] text-white/38">uBatch</span>
                    <Input
                      type="number"
                      value={draft.ubatch_size}
                      onChange={(event) => setDraft((current) => ({ ...current, ubatch_size: Number(event.target.value) }))}
                      className="rounded-none border-[#2A2A2A] bg-[#111111] text-white"
                    />
                  </label>
                </div>
                <label className="space-y-1">
                  <span className="text-[11px] uppercase tracking-[0.18em] text-white/38">Extra args</span>
                  <Input
                    value={draft.extra_args.join(" ")}
                    onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                        extra_args: event.target.value.split(" ").map((item) => item.trim()).filter(Boolean),
                      }))
                    }
                    className="rounded-none border-[#2A2A2A] bg-[#111111] text-white"
                  />
                </label>
              {error ? <p className="border border-[#82382B] bg-[rgba(255,140,66,0.12)] px-3 py-2 text-sm text-[#ff9f73]">{error}</p> : null}
              <Button
                variant="primary"
                className="w-full rounded-none border border-[#FF8C42] bg-[#FF8C42] text-[#101010] hover:bg-[#FFA766]"
                onClick={() => void create()}
                disabled={isSaving}
              >
                <Plus className="h-4 w-4" />
                {isSaving ? "Adding" : "Add Model"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
