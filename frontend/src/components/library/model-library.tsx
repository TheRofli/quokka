import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Download, ExternalLink, FolderOpen, Library, LoaderCircle, Search, SlidersHorizontal, XCircle } from "lucide-react";

import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn, formatNumber } from "@/lib/utils";
import type { CreateModelRequest, ModelDownloadStatus, ModelLibraryEntry, ModelLibraryFile, ModelView, SystemMetricsResponse } from "@/types/api";

interface ModelLibraryProps {
  models: ModelView[];
  metrics?: SystemMetricsResponse | null;
  onAdded: () => Promise<void>;
}

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

function bytesToLabel(bytes?: number | null) {
  if (!bytes) {
    return "--";
  }
  return `${formatNumber(bytes / 1024 / 1024 / 1024, 2)} GB`;
}

function bytesToGb(bytes?: number | null) {
  return bytes ? bytes / 1024 / 1024 / 1024 : null;
}

function estimateVramGb(file: ModelLibraryFile) {
  const sizeGb = bytesToGb(file.size_bytes);
  if (!sizeGb) {
    return null;
  }
  return sizeGb * 1.18 + 0.8;
}

function fitDetails(file: ModelLibraryFile, gpuTotalGb?: number | null, ramTotalGb?: number | null) {
  const estimatedVramGb = estimateVramGb(file);
  if (!estimatedVramGb || !gpuTotalGb) {
    return { label: "CPU/unknown", detail: "No GPU telemetry", tone: "text-milk/42", rank: 1 };
  }
  if (estimatedVramGb <= gpuTotalGb * 0.72) {
    return { label: "Full GPU", detail: "Plenty of VRAM headroom", tone: "text-success", rank: 5 };
  }
  if (estimatedVramGb <= gpuTotalGb * 0.92) {
    return { label: "GPU fit", detail: "Should fit mostly on GPU", tone: "text-success", rank: 4 };
  }
  if (estimatedVramGb <= gpuTotalGb * 1.25) {
    return { label: "Offload fit", detail: "Needs some CPU/RAM offload", tone: "text-warning", rank: 3 };
  }
  if (ramTotalGb && estimatedVramGb <= ramTotalGb * 0.65) {
    return { label: "CPU possible", detail: "GPU too small, RAM may handle it slowly", tone: "text-milk/55", rank: 2 };
  }
  return { label: "Too large", detail: "Likely OOM or unusably slow", tone: "text-danger", rank: 0 };
}

function parseParamsB(...values: Array<string | null | undefined>) {
  const text = values.filter(Boolean).join(" ");
  const matches = Array.from(text.matchAll(/(^|[^a-z0-9])(\d+(?:\.\d+)?)\s*b([^a-z0-9]|$)/gi));
  const value = matches.map((match) => Number(match[2])).find((item) => Number.isFinite(item) && item > 0);
  return value ?? null;
}

const officialOwners = new Set(["google", "qwen", "qwenlm", "mistralai", "meta-llama", "deepseek-ai", "nvidia", "microsoft", "allenai", "01-ai", "tiiuae", "ibm-granite"]);
const knownQuantizers = new Set(["bartowski", "unsloth", "lmstudio-community", "thebloke", "second-state", "mradermacher", "ggml-org"]);

function repoOwner(entry: ModelLibraryEntry) {
  return entry.repo_id.split("/")[0]?.toLowerCase() ?? "";
}

function sourceKind(entry: ModelLibraryEntry) {
  const owner = repoOwner(entry);
  if (officialOwners.has(owner)) {
    return "official";
  }
  if (knownQuantizers.has(owner)) {
    return "curated";
  }
  return "community";
}

function sourceLabel(entry: ModelLibraryEntry) {
  const kind = sourceKind(entry);
  if (kind === "official") {
    return "Official/upstream";
  }
  if (kind === "curated") {
    return "Known GGUF quantizer";
  }
  return "Community quant";
}

function nameFromPath(path: string) {
  const name = path.split(/[\\/]/).pop() ?? "Downloaded GGUF Model";
  return name.replace(/\.gguf$/i, "").replace(/[_-]/g, " ");
}

function payloadFromDownload(download: ModelDownloadStatus, models: ModelView[]): CreateModelRequest {
  return {
    provider: "windows_llama_cpp",
    name: nameFromPath(download.file_name),
    model_path: download.target_path,
    llama_server_path: null,
    port: nextPort(models),
    host: "127.0.0.1",
    modality: "llm",
    family: null,
    size_label: null,
    quantization: null,
    wsl_distro: "Ubuntu",
    description: `Downloaded from ${download.url}`,
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

const categoryPresets = [
  { label: "Recommended", query: "qwen coder gguf q4_k_m", hint: "Good coding defaults for 8-16GB GPUs." },
  { label: "Best 12GB GPU", query: "qwen 14b gguf q4_k_m", hint: "Bigger but still realistic for RTX 4070-class cards." },
  { label: "Small/Fast", query: "gemma 4b gguf q4", hint: "Fast assistant models." },
  { label: "Coding", query: "devstral qwen coder gguf", hint: "Code-focused local models." },
  { label: "Chat", query: "llama instruct gguf q4_k_m", hint: "General conversation models." },
  { label: "Long Context", query: "long context gguf q4_k_m", hint: "Models known for larger context windows." },
  { label: "Vision", query: "llava gguf mmproj", hint: "Vision models need an mmproj file too." },
  { label: "CPU only", query: "3b gguf q4_0", hint: "Tiny models for machines without CUDA." },
  { label: "Qwen", query: "qwen gguf q4_k_m", hint: "Qwen and Qwen Coder families." },
  { label: "Gemma", query: "gemma gguf q4_k_m", hint: "Google Gemma derivatives and quantizations." },
  { label: "Mistral", query: "mistral gguf q4_k_m", hint: "Mistral, Devstral, Codestral style models." },
  { label: "Llama", query: "llama gguf q4_k_m", hint: "Llama instruct/chat variants." },
  { label: "1-4B", query: "4b gguf q4", hint: "Very small, fast, laptop-friendly." },
  { label: "7-9B", query: "8b gguf q4_k_m", hint: "Balanced quality and speed." },
  { label: "14B", query: "14b gguf q4_k_m", hint: "Better quality, higher VRAM pressure." },
  { label: "30B+", query: "32b gguf q4_k_m", hint: "Usually needs offload or big VRAM." },
];

type SortMode = "relevance" | "best_fit" | "downloads" | "smallest" | "largest" | "params";
type SourceFilter = "all" | "official" | "community";

export function ModelLibrary({ models, metrics, onAdded }: ModelLibraryProps) {
  const [query, setQuery] = useState("gemma gguf");
  const [manualReference, setManualReference] = useState("");
  const [targetDir, setTargetDir] = useState("");
  const [entries, setEntries] = useState<ModelLibraryEntry[]>([]);
  const [downloads, setDownloads] = useState<ModelDownloadStatus[]>([]);
  const [activeCategory, setActiveCategory] = useState("Recommended");
  const [sortMode, setSortMode] = useState<SortMode>("best_fit");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [isSearching, setIsSearching] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activeDownloads = useMemo(() => downloads.filter((item) => item.status === "queued" || item.status === "downloading"), [downloads]);
  const primaryGpu = metrics?.gpu_devices?.[0] ?? null;
  const gpuTotalGb = primaryGpu?.memory_total_mb ? primaryGpu.memory_total_mb / 1024 : metrics?.gpu_memory_total_mb ? metrics.gpu_memory_total_mb / 1024 : null;
  const ramTotalGb = metrics?.ram_total_gb ?? null;
  const filteredEntries = useMemo(() => {
    const sourceFiltered = entries.filter((entry) => {
      if (sourceFilter === "all") {
        return true;
      }
      if (sourceFilter === "official") {
        return sourceKind(entry) === "official";
      }
      return sourceKind(entry) !== "official";
    });

    const scoreEntry = (entry: ModelLibraryEntry) => {
      const files = entry.files.length ? entry.files : [{ filename: entry.name, size_bytes: null, quantization: null, download_url: "" }];
      const sizes = files.map((file) => bytesToGb(file.size_bytes) ?? 0).filter((value) => value > 0);
      const fits = entry.files.map((file) => fitDetails(file, gpuTotalGb, ramTotalGb).rank);
      return {
        downloads: entry.downloads ?? 0,
        minSize: sizes.length ? Math.min(...sizes) : Number.POSITIVE_INFINITY,
        maxSize: sizes.length ? Math.max(...sizes) : 0,
        params: parseParamsB(entry.name, entry.repo_id, entry.files[0]?.filename) ?? Number.POSITIVE_INFINITY,
        fit: fits.length ? Math.max(...fits) : -1,
      };
    };

    return [...sourceFiltered].sort((left, right) => {
      const a = scoreEntry(left);
      const b = scoreEntry(right);
      if (sortMode === "best_fit") {
        return b.fit - a.fit || b.downloads - a.downloads;
      }
      if (sortMode === "downloads") {
        return b.downloads - a.downloads;
      }
      if (sortMode === "smallest") {
        return a.minSize - b.minSize;
      }
      if (sortMode === "largest") {
        return b.maxSize - a.maxSize;
      }
      if (sortMode === "params") {
        return a.params - b.params;
      }
      return 0;
    });
  }, [entries, gpuTotalGb, ramTotalGb, sortMode, sourceFilter]);

  useEffect(() => {
    void refreshDownloads();
  }, []);

  useEffect(() => {
    if (!activeDownloads.length) {
      return;
    }
    const interval = window.setInterval(() => void refreshDownloads(), 1400);
    return () => window.clearInterval(interval);
  }, [activeDownloads.length]);

  const refreshDownloads = async () => {
    const next = await api.getModelDownloads();
    setDownloads(next);
  };

  const runSearch = async (nextQuery = query) => {
    const matchingCategory = categoryPresets.find((preset) => preset.query === nextQuery);
    if (matchingCategory) {
      setActiveCategory(matchingCategory.label);
    }
    setIsSearching(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api.searchLibraryModels(nextQuery);
      setEntries(result.entries);
      setQuery(nextQuery);
      if (!result.entries.length) {
        setMessage("No GGUF repositories found. Try a broader query like 'gemma gguf' or paste a direct Hugging Face URL.");
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Model search failed");
    } finally {
      setIsSearching(false);
    }
  };

  const resolveManual = async () => {
    if (!manualReference.trim()) {
      setError("Paste a Hugging Face model page, repo id, or direct .gguf URL.");
      return;
    }
    setIsSearching(true);
    setError(null);
    setMessage(null);
    try {
      const entry = await api.resolveLibraryReference({ reference: manualReference.trim() });
      setEntries([entry, ...entries.filter((item) => item.repo_id !== entry.repo_id)]);
      setMessage(`Resolved ${entry.repo_id}. Choose a GGUF file to download.`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not resolve that Hugging Face reference");
    } finally {
      setIsSearching(false);
    }
  };

  const chooseDownloadFolder = async () => {
    if (window.quokkaDesktop?.openFolder) {
      const path = await window.quokkaDesktop.openFolder({ title: "Choose a model download folder" });
      if (path) {
        setTargetDir(path);
      }
    } else {
      setMessage("Folder picker is available in the desktop app. Browser mode will use Quokka's default models folder.");
    }
  };

  const downloadFile = async (entry: ModelLibraryEntry, file: ModelLibraryFile) => {
    setError(null);
    setMessage(null);
    try {
      await api.startModelDownload({
        url: file.download_url,
        target_dir: targetDir || null,
        name: `${entry.name} ${file.quantization ?? ""}`.trim(),
      });
      await refreshDownloads();
      setMessage("Download started. You can leave this page open and watch progress below.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not start download");
    }
  };

  const addDownloadedModel = async (download: ModelDownloadStatus) => {
    setError(null);
    setMessage(null);
    try {
      await api.createModel(payloadFromDownload(download, models));
      await onAdded();
      setMessage(`${download.file_name} added to Local Panel. Run Health Doctor if llama-server.exe still needs a path.`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not add downloaded model");
    }
  };

  return (
    <main className="mt-4 flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--radius-soft)] border border-line bg-panel/55">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line/70 px-5 py-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent">Model Library</p>
          <h1 className="mt-2 text-2xl font-semibold text-milk">Find and download local GGUF models</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-milk/52">
            Search Hugging Face, paste a model URL, download GGUF files, then add them to Quokka's Windows llama.cpp runtime.
          </p>
        </div>
        <div className="rounded-[var(--radius-control)] border border-line/65 bg-shell/45 px-4 py-3 text-sm text-milk/58">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">Your GPU fit</p>
          <p className="mt-1 font-semibold text-milk">{primaryGpu?.name ?? "GPU not detected"}</p>
          <p className="mt-1">{gpuTotalGb ? `${formatNumber(gpuTotalGb, 1)} GB VRAM available for fit estimates` : "Download cards will still show file size."}</p>
        </div>
        <Button variant="secondary" className="quokka-control rounded-[var(--radius-control)]" onClick={chooseDownloadFolder}>
          <FolderOpen className="h-4 w-4" />
          {targetDir ? "Change folder" : "Download folder"}
        </Button>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden xl:grid-cols-[330px_minmax(0,1fr)_360px]">
        <aside className="min-h-0 overflow-y-auto border-r border-line/65 px-5 py-5">
          <div className="rounded-[var(--radius-control)] border border-line/70 bg-shell/45 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-milk/42">Search</p>
            <div className="mt-3 flex gap-2">
              <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="gemma gguf" className="quokka-input" />
              <Button variant="primary" size="icon" onClick={() => void runSearch()} disabled={isSearching}>
                {isSearching ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              </Button>
            </div>
            <div className="mt-4 grid gap-2">
              {categoryPresets.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  className={cn(
                    "rounded-[var(--radius-control)] border px-3 py-2 text-left transition hover:border-live/45 hover:bg-live/8",
                    activeCategory === preset.label
                      ? "border-accent/65 bg-accent/12"
                      : "border-line/55 bg-panel/35"
                  )}
                  onClick={() => void runSearch(preset.query)}
                  title={preset.hint}
                >
                  <span className="text-sm font-semibold text-milk">{preset.label}</span>
                  <span className="mt-0.5 block text-xs text-milk/42">{preset.hint}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="mt-4 rounded-[var(--radius-control)] border border-line/70 bg-shell/45 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-milk/42">Manual Hugging Face URL</p>
            <Input value={manualReference} onChange={(event) => setManualReference(event.target.value)} placeholder="https://huggingface.co/.../blob/main/model.gguf" className="quokka-input mt-3" />
            <Button variant="secondary" className="quokka-control mt-3 w-full rounded-[var(--radius-control)]" onClick={() => void resolveManual()} disabled={isSearching}>
              Resolve URL
            </Button>
          </div>
        </aside>

        <section className="min-h-0 overflow-y-auto px-5 py-5">
          {message ? <div className="mb-4 rounded-[var(--radius-control)] border border-accent/35 bg-accent/10 px-4 py-3 text-sm text-milk/70">{message}</div> : null}
          {error ? <div className="mb-4 rounded-[var(--radius-control)] border border-danger/45 bg-danger/10 px-4 py-3 text-sm text-danger">{error}</div> : null}
          <div className="mb-4 rounded-[var(--radius-control)] border border-line/70 bg-shell/38 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm text-milk/52">
                <SlidersHorizontal className="h-4 w-4 text-accent" />
                <span>{filteredEntries.length} shown / {entries.length} repos</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select className="quokka-input h-9 rounded-[var(--radius-control)] px-3 text-xs" value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as SourceFilter)}>
                  <option value="all">All sources</option>
                  <option value="official">Official/upstream only</option>
                  <option value="community">Community GGUF</option>
                </select>
                <select className="quokka-input h-9 rounded-[var(--radius-control)] px-3 text-xs" value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}>
                  <option value="best_fit">Sort: best fit</option>
                  <option value="downloads">Sort: downloads</option>
                  <option value="smallest">Sort: smallest</option>
                  <option value="largest">Sort: largest</option>
                  <option value="params">Sort: params</option>
                  <option value="relevance">Sort: HF relevance</option>
                </select>
              </div>
            </div>
            <p className="mt-2 text-xs leading-5 text-milk/42">
              Fit is approximate: GGUF size plus runtime overhead. Test Launch is still the source of truth.
            </p>
          </div>
          <div className="grid gap-4">
            {filteredEntries.map((entry) => (
              <article key={entry.repo_id} className="rounded-[var(--radius-control)] border border-line/70 bg-shell/40 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-lg font-semibold text-milk">{entry.name}</p>
                    <p className="mt-1 break-all font-mono text-xs text-live/80">{entry.repo_id}</p>
                    <p className="mt-3 max-w-3xl text-sm leading-6 text-milk/50">{entry.description ?? "Hugging Face GGUF model repository."}</p>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => window.quokkaDesktop?.openExternal?.(`https://huggingface.co/${entry.repo_id}`)}>
                    <ExternalLink className="h-4 w-4" />
                    HF
                  </Button>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <span className="quokka-pill px-2 py-1 text-xs text-accent">{sourceLabel(entry)}</span>
                  {parseParamsB(entry.name, entry.repo_id, entry.files[0]?.filename) ? (
                    <span className="quokka-pill px-2 py-1 text-xs text-milk/52">{parseParamsB(entry.name, entry.repo_id, entry.files[0]?.filename)}B params</span>
                  ) : null}
                  {entry.tags.slice(0, 7).map((tag) => (
                    <span key={tag} className="quokka-pill px-2 py-1 text-xs text-milk/52">{tag}</span>
                  ))}
                  {typeof entry.downloads === "number" ? <span className="quokka-pill px-2 py-1 text-xs text-milk/52">{entry.downloads.toLocaleString()} downloads</span> : null}
                </div>
                <div className="mt-4 space-y-2">
                  {[...entry.files].sort((left, right) => {
                    if (sortMode === "largest") {
                      return (right.size_bytes ?? 0) - (left.size_bytes ?? 0);
                    }
                    if (sortMode === "best_fit") {
                      return fitDetails(right, gpuTotalGb, ramTotalGb).rank - fitDetails(left, gpuTotalGb, ramTotalGb).rank;
                    }
                    return (left.size_bytes ?? Number.POSITIVE_INFINITY) - (right.size_bytes ?? Number.POSITIVE_INFINITY);
                  }).map((file) => (
                    <div key={file.filename} className="grid gap-3 rounded-[var(--radius-control)] border border-line/55 bg-panel/40 px-3 py-3 md:grid-cols-[1fr_90px_90px_120px_138px] md:items-center">
                      <span className="break-all font-mono text-sm text-milk/78">{file.filename}</span>
                      <span className="text-sm text-accent">{file.quantization ?? "GGUF"}</span>
                      <span className="text-sm text-milk/45">{bytesToLabel(file.size_bytes)}</span>
                      {(() => {
                        const vramGb = estimateVramGb(file);
                        const fit = fitDetails(file, gpuTotalGb, ramTotalGb);
                        return (
                          <span className={cn("text-sm", fit.tone)} title={fit.detail}>
                            {vramGb ? `~${formatNumber(vramGb, 1)} GB` : "--"} / {fit.label}
                          </span>
                        );
                      })()}
                      <Button variant="primary" size="sm" className="rounded-[var(--radius-control)]" onClick={() => void downloadFile(entry, file)}>
                        <Download className="h-4 w-4" />
                        Download GGUF
                      </Button>
                    </div>
                  ))}
                  {!entry.files.length ? <p className="text-sm text-milk/42">No GGUF files were listed by Hugging Face for this result.</p> : null}
                </div>
              </article>
            ))}
            {!entries.length ? (
              <div className="grid min-h-[360px] place-items-center rounded-[var(--radius-control)] border border-dashed border-line/70 bg-shell/35 text-center">
                <div>
                  <Library className="mx-auto h-8 w-8 text-accent" />
                  <p className="mt-4 text-lg font-semibold text-milk">Search Hugging Face to start</p>
                  <p className="mt-2 text-sm text-milk/48">Try "gemma gguf", "qwen coder gguf", or paste a direct GGUF URL.</p>
                </div>
              </div>
            ) : null}
            {entries.length > 0 && !filteredEntries.length ? (
              <div className="rounded-[var(--radius-control)] border border-line/70 bg-shell/35 px-4 py-10 text-center text-sm text-milk/50">
                Nothing matches this source filter. Try All sources or another category.
              </div>
            ) : null}
          </div>
        </section>

        <aside className="min-h-0 overflow-y-auto border-l border-line/65 px-5 py-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">Downloads</p>
          <p className="mt-2 break-all text-xs text-milk/42">{targetDir || "Default: Quokka data/models folder"}</p>
          <div className="mt-4 space-y-3">
            {downloads.map((download) => (
              <div key={download.id} className="rounded-[var(--radius-control)] border border-line/70 bg-shell/45 p-3">
                <div className="flex items-start gap-2">
                  {download.status === "completed" ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-success" /> : download.status === "failed" ? <XCircle className="mt-0.5 h-4 w-4 text-danger" /> : <LoaderCircle className="mt-0.5 h-4 w-4 animate-spin text-live" />}
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold text-milk">{download.label}</p>
                    <p className="mt-1 truncate text-xs text-milk/42">{download.file_name}</p>
                  </div>
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/8">
                  <div className={cn("h-full rounded-full", download.status === "failed" ? "bg-danger" : download.status === "completed" ? "bg-success" : "bg-live")} style={{ width: `${Math.max(2, download.progress_percent)}%` }} />
                </div>
                <p className="mt-2 text-xs text-milk/45">{download.status} / {formatNumber(download.progress_percent, 1)}%</p>
                {download.error ? <p className="mt-2 text-xs text-danger">{download.error}</p> : null}
                <div className="mt-3 flex gap-2">
                  {download.status === "completed" ? (
                    <Button variant="primary" size="sm" className="flex-1 rounded-[var(--radius-control)]" onClick={() => void addDownloadedModel(download)}>
                      Add to Quokka
                    </Button>
                  ) : null}
                  {download.status === "queued" || download.status === "downloading" ? (
                    <Button variant="secondary" size="sm" className="flex-1 rounded-[var(--radius-control)]" onClick={() => void api.cancelModelDownload(download.id).then(refreshDownloads)}>
                      Cancel
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
            {!downloads.length ? <p className="rounded-[var(--radius-control)] border border-line/70 bg-shell/35 px-3 py-8 text-center text-sm text-milk/45">Downloads will appear here.</p> : null}
          </div>
        </aside>
      </div>
    </main>
  );
}
