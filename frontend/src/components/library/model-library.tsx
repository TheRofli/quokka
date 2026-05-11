import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Cpu,
  Download,
  ExternalLink,
  FolderOpen,
  Gauge,
  HardDrive,
  Library,
  LoaderCircle,
  MonitorDown,
  Search,
  SlidersHorizontal,
  Sparkles,
  Target,
  XCircle,
  Zap,
} from "lucide-react";

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

type FitGoal = "auto" | "coding" | "chat" | "fast" | "reasoning" | "vision";
type FitPolicy = "gpu" | "offload" | "any";
type SortMode = "recommendation" | "quality" | "speed" | "downloads" | "smallest" | "largest" | "params";
type SourceFilter = "all" | "official" | "community";

type FitInfo = {
  label: string;
  detail: string;
  tone: string;
  rank: number;
  mode: "full_gpu" | "gpu" | "offload" | "cpu" | "too_large" | "unknown";
};

type ScoredFile = {
  file: ModelLibraryFile;
  fit: FitInfo;
  estimatedVramGb: number | null;
  estimatedSpeed: number | null;
  quality: number;
  score: number;
  reasons: string[];
};

type ScoredEntry = {
  entry: ModelLibraryEntry;
  best: ScoredFile | null;
  paramsB: number | null;
  source: "official" | "curated" | "community";
  sourceLabel: string;
};

const goalOptions: Array<{ id: FitGoal; label: string; hint: string; query: string }> = [
  { id: "auto", label: "Best overall", hint: "Balanced fit, quality, and speed.", query: "qwen coder gguf q4_k_m" },
  { id: "coding", label: "Coding", hint: "Coder and agent-style local models.", query: "qwen coder devstral gguf q4_k_m" },
  { id: "chat", label: "Chat", hint: "General assistant and instruct models.", query: "llama instruct gemma gguf q4_k_m" },
  { id: "fast", label: "Small/Fast", hint: "Low latency models for quick replies.", query: "4b 7b gguf q4_k_m" },
  { id: "reasoning", label: "Reasoning", hint: "More capable models, more VRAM pressure.", query: "qwen reasoning 14b 32b gguf q4_k_m" },
  { id: "vision", label: "Vision", hint: "Vision models and mmproj companions.", query: "llava vision gguf mmproj" },
];

const categoryPresets = [
  { label: "Best for this PC", query: "qwen coder gguf q4_k_m", hint: "Start here when you just want something good." },
  { label: "Full GPU only", query: "7b 8b gguf q4_k_m", hint: "Safer models that should avoid CPU spill." },
  { label: "RTX 4070 class", query: "14b gguf q4_k_m", hint: "Good quality on 12GB cards with careful quant choice." },
  { label: "CPU fallback", query: "3b 4b gguf q4_0", hint: "For machines without CUDA or with tiny VRAM." },
  { label: "Qwen", query: "qwen gguf q4_k_m", hint: "Qwen and Qwen Coder families." },
  { label: "Gemma", query: "gemma gguf q4_k_m", hint: "Gemma chat and coding derivatives." },
  { label: "Mistral", query: "mistral devstral gguf q4_k_m", hint: "Mistral, Devstral, Codestral style models." },
  { label: "Llama", query: "llama instruct gguf q4_k_m", hint: "Llama instruct/chat variants." },
  { label: "Long Context", query: "long context gguf q4_k_m", hint: "Models with bigger context windows." },
  { label: "Vision", query: "llava gguf mmproj", hint: "Vision models need an mmproj file too." },
  { label: "1-4B", query: "4b gguf q4", hint: "Very small and fast." },
  { label: "7-9B", query: "8b gguf q4_k_m", hint: "Balanced quality and speed." },
  { label: "14B", query: "14b gguf q4_k_m", hint: "Better quality with higher VRAM pressure." },
  { label: "30B+", query: "32b gguf q4_k_m", hint: "Usually needs offload or large VRAM." },
];

const officialOwners = new Set(["google", "qwen", "qwenlm", "mistralai", "meta-llama", "deepseek-ai", "nvidia", "microsoft", "allenai", "01-ai", "tiiuae", "ibm-granite"]);
const knownQuantizers = new Set(["bartowski", "unsloth", "lmstudio-community", "thebloke", "second-state", "mradermacher", "ggml-org"]);

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
  return bytes ? bytes / 1024 / 1024 / 1024 : null;
}

function bytesToLabel(bytes?: number | null) {
  const value = bytesToGb(bytes);
  return value ? `${formatNumber(value, 2)} GB` : "--";
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function parseParamsB(...values: Array<string | null | undefined>) {
  const text = values.filter(Boolean).join(" ");
  const matches = Array.from(text.matchAll(/(^|[^a-z0-9])(\d+(?:\.\d+)?)\s*b([^a-z0-9]|$)/gi));
  const value = matches.map((match) => Number(match[2])).find((item) => Number.isFinite(item) && item > 0);
  return value ?? null;
}

function repoOwner(entry: ModelLibraryEntry) {
  return entry.repo_id.split("/")[0]?.toLowerCase() ?? "";
}

function sourceKind(entry: ModelLibraryEntry): ScoredEntry["source"] {
  const owner = repoOwner(entry);
  if (officialOwners.has(owner)) {
    return "official";
  }
  if (knownQuantizers.has(owner)) {
    return "curated";
  }
  return "community";
}

function sourceLabel(kind: ScoredEntry["source"]) {
  if (kind === "official") {
    return "Official/upstream";
  }
  if (kind === "curated") {
    return "Known GGUF quantizer";
  }
  return "Community quant";
}

function quantQuality(quant?: string | null) {
  const value = (quant ?? "").toUpperCase();
  if (value.startsWith("Q8")) return 99;
  if (value.startsWith("Q6")) return 98;
  if (value.startsWith("Q5")) return 97;
  if (value.startsWith("Q4_K_M")) return 96;
  if (value.startsWith("Q4")) return 93;
  if (value.startsWith("Q3")) return 86;
  if (value.startsWith("Q2")) return 74;
  return 90;
}

function quantBits(quant?: string | null) {
  const value = (quant ?? "").toUpperCase();
  if (value.startsWith("Q8")) return 8.5;
  if (value.startsWith("Q6")) return 6.6;
  if (value.startsWith("Q5")) return 5.7;
  if (value.startsWith("Q4_K_M")) return 4.9;
  if (value.startsWith("Q4")) return 4.6;
  if (value.startsWith("Q3")) return 3.9;
  if (value.startsWith("Q2")) return 3.0;
  return null;
}

function estimatedVramGb(file: ModelLibraryFile, contextSize: number) {
  const sizeGb = bytesToGb(file.size_bytes);
  if (!sizeGb) {
    return null;
  }
  const kvCacheGb = (contextSize / 8192) * 0.35;
  return sizeGb * 1.12 + 0.55 + kvCacheGb;
}

function fitDetails(file: ModelLibraryFile, contextSize: number, gpuTotalGb?: number | null, ramTotalGb?: number | null): FitInfo {
  const need = estimatedVramGb(file, contextSize);
  if (!need || !gpuTotalGb) {
    return { label: "CPU/unknown", detail: "No GPU telemetry for a reliable fit estimate.", tone: "text-milk/42", rank: 1, mode: "unknown" };
  }
  if (need <= gpuTotalGb * 0.7) {
    return { label: "Full GPU", detail: "Weights and KV cache should fit with comfortable VRAM headroom.", tone: "text-success", rank: 5, mode: "full_gpu" };
  }
  if (need <= gpuTotalGb * 0.92) {
    return { label: "GPU fit", detail: "Should fit mostly on GPU, but leave fewer resources for other apps.", tone: "text-success", rank: 4, mode: "gpu" };
  }
  if (need <= gpuTotalGb * 1.25) {
    return { label: "Offload fit", detail: "Likely needs a small CPU/RAM spill. Expect lower tok/s.", tone: "text-warning", rank: 3, mode: "offload" };
  }
  if (ramTotalGb && need <= ramTotalGb * 0.65) {
    return { label: "CPU possible", detail: "GPU is too small, but system RAM may run it slowly.", tone: "text-milk/55", rank: 2, mode: "cpu" };
  }
  return { label: "Too large", detail: "Likely to OOM or run unusably slowly on this machine.", tone: "text-danger", rank: 0, mode: "too_large" };
}

function goalBoost(entry: ModelLibraryEntry, file: ModelLibraryFile, goal: FitGoal) {
  const text = `${entry.name} ${entry.repo_id} ${entry.tags.join(" ")} ${file.filename}`.toLowerCase();
  if (goal === "auto") return 0;
  if (goal === "coding") return /coder|code|devstral|codestral|starcoder|deepseek/.test(text) ? 12 : 0;
  if (goal === "chat") return /instruct|chat|gemma|llama|mistral/.test(text) ? 10 : 0;
  if (goal === "fast") return parseParamsB(text) && (parseParamsB(text) ?? 99) <= 8 ? 12 : /3b|4b|7b|8b/.test(text) ? 10 : 0;
  if (goal === "reasoning") return /reason|qwen|deepseek|r1|32b|14b/.test(text) ? 12 : 0;
  if (goal === "vision") return /llava|vision|vl|mmproj|qwen2-vl|qwen-vl/.test(text) ? 16 : -10;
  return 0;
}

function estimateSpeed(file: ModelLibraryFile, fit: FitInfo, gpuTotalGb?: number | null) {
  const sizeGb = bytesToGb(file.size_bytes);
  if (!sizeGb) {
    return null;
  }
  const hardwareFactor = gpuTotalGb ? clamp(gpuTotalGb / 12, 0.55, 2.4) : 0.5;
  const fitFactor = fit.mode === "full_gpu" ? 1 : fit.mode === "gpu" ? 0.82 : fit.mode === "offload" ? 0.32 : fit.mode === "cpu" ? 0.12 : 0.05;
  return clamp((95 / Math.max(sizeGb, 1.2)) * hardwareFactor * fitFactor, 1, 90);
}

function scoreFile(entry: ModelLibraryEntry, file: ModelLibraryFile, options: {
  goal: FitGoal;
  policy: FitPolicy;
  contextSize: number;
  gpuTotalGb?: number | null;
  ramTotalGb?: number | null;
}): ScoredFile {
  const fit = fitDetails(file, options.contextSize, options.gpuTotalGb, options.ramTotalGb);
  const quality = quantQuality(file.quantization);
  const speed = estimateSpeed(file, fit, options.gpuTotalGb);
  const downloadsScore = Math.log10((entry.downloads ?? 0) + 10) * 2;
  const sourceBonus = sourceKind(entry) === "official" ? 6 : sourceKind(entry) === "curated" ? 4 : 0;
  const policyPenalty =
    options.policy === "gpu" && fit.rank < 4
      ? 35
      : options.policy === "offload" && fit.rank < 3
        ? 18
        : options.policy === "any" && fit.rank === 0
          ? 10
          : 0;
  const q = (file.quantization ?? "unknown").toUpperCase();
  const q4DefaultBonus = q.includes("Q4_K_M") ? 7 : q.startsWith("Q5") ? 4 : q.startsWith("Q3") ? -4 : 0;
  const score =
    fit.rank * 20 +
    quality * 0.28 +
    (speed ?? 0) * 0.8 +
    downloadsScore +
    sourceBonus +
    q4DefaultBonus +
    goalBoost(entry, file, options.goal) -
    policyPenalty;
  const reasons = [
    fit.detail,
    `${file.quantization ?? "Unknown quant"} is about ${quantBits(file.quantization) ? `${quantBits(file.quantization)} bpw` : "unknown bpw"}.`,
    speed ? `Rough decode estimate: ${formatNumber(speed, 1)} tok/s.` : "Speed estimate needs file size metadata.",
  ];
  return {
    file,
    fit,
    estimatedVramGb: estimatedVramGb(file, options.contextSize),
    estimatedSpeed: speed,
    quality,
    score,
    reasons,
  };
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

function FitBadge({ fit }: { fit: FitInfo }) {
  return (
    <span className={cn("rounded-full border px-2.5 py-1 text-xs font-semibold", fit.tone, fit.rank >= 4 ? "border-success/35 bg-success/10" : fit.rank === 3 ? "border-warning/35 bg-warning/10" : fit.rank === 0 ? "border-danger/35 bg-danger/10" : "border-line/60 bg-panel/40")}>
      {fit.label}
    </span>
  );
}

function Stat({ label, value, icon: Icon }: { label: string; value: string; icon: typeof Gauge }) {
  return (
    <div className="rounded-[var(--radius-control)] border border-line/65 bg-panel/45 px-3 py-3">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-milk/38">
        <Icon className="h-3.5 w-3.5 text-accent" />
        {label}
      </div>
      <p className="mt-2 truncate text-sm font-semibold text-milk">{value}</p>
    </div>
  );
}

function EntryMiniCard({ item, onDownload }: { item: ScoredEntry; onDownload: (entry: ModelLibraryEntry, file: ModelLibraryFile) => void }) {
  if (!item.best) {
    return null;
  }
  return (
    <div className="min-w-[280px] rounded-[var(--radius-control)] border border-line/65 bg-panel/45 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-semibold text-milk">{item.entry.name}</p>
          <p className="mt-1 truncate font-mono text-xs text-live/70">{item.entry.repo_id}</p>
        </div>
        <FitBadge fit={item.best.fit} />
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-xs text-milk/48">
        <span><b className="block text-milk/80">{formatNumber(item.best.score, 0)}</b>score</span>
        <span><b className="block text-milk/80">{item.best.estimatedVramGb ? `${formatNumber(item.best.estimatedVramGb, 1)}GB` : "--"}</b>VRAM</span>
        <span><b className="block text-milk/80">{item.best.estimatedSpeed ? formatNumber(item.best.estimatedSpeed, 1) : "--"}</b>tok/s</span>
      </div>
      <p className="mt-3 truncate font-mono text-xs text-milk/50">{item.best.file.filename}</p>
      <Button variant="secondary" size="sm" className="quokka-control mt-3 w-full rounded-[var(--radius-control)]" onClick={() => onDownload(item.entry, item.best!.file)}>
        <Download className="h-4 w-4" />
        Download best GGUF
      </Button>
    </div>
  );
}

export function ModelLibrary({ models, metrics, onAdded }: ModelLibraryProps) {
  const [query, setQuery] = useState("qwen coder gguf q4_k_m");
  const [manualReference, setManualReference] = useState("");
  const [targetDir, setTargetDir] = useState("");
  const [entries, setEntries] = useState<ModelLibraryEntry[]>([]);
  const [downloads, setDownloads] = useState<ModelDownloadStatus[]>([]);
  const [activeCategory, setActiveCategory] = useState("Best for this PC");
  const [goal, setGoal] = useState<FitGoal>("auto");
  const [policy, setPolicy] = useState<FitPolicy>("offload");
  const [contextSize, setContextSize] = useState(8192);
  const [sortMode, setSortMode] = useState<SortMode>("recommendation");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [isSearching, setIsSearching] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activeDownloads = useMemo(() => downloads.filter((item) => item.status === "queued" || item.status === "downloading"), [downloads]);
  const primaryGpu = metrics?.gpu_devices?.[0] ?? null;
  const gpuTotalGb = primaryGpu?.memory_total_mb ? primaryGpu.memory_total_mb / 1024 : metrics?.gpu_memory_total_mb ? metrics.gpu_memory_total_mb / 1024 : null;
  const ramTotalGb = metrics?.ram_total_gb ?? null;

  const scoredEntries = useMemo<ScoredEntry[]>(() => {
    const sourceFiltered = entries.filter((entry) => {
      const kind = sourceKind(entry);
      if (sourceFilter === "all") return true;
      if (sourceFilter === "official") return kind === "official";
      return kind !== "official";
    });

    const scored = sourceFiltered.map((entry): ScoredEntry => {
      const kind = sourceKind(entry);
      const files = entry.files.map((file) => scoreFile(entry, file, { goal, policy, contextSize, gpuTotalGb, ramTotalGb }));
      const best = files.sort((left, right) => right.score - left.score)[0] ?? null;
      return {
        entry,
        best,
        paramsB: parseParamsB(entry.name, entry.repo_id, entry.files[0]?.filename),
        source: kind,
        sourceLabel: sourceLabel(kind),
      };
    });

    return scored.sort((left, right) => {
      if (sortMode === "quality") return (right.best?.quality ?? 0) - (left.best?.quality ?? 0);
      if (sortMode === "speed") return (right.best?.estimatedSpeed ?? 0) - (left.best?.estimatedSpeed ?? 0);
      if (sortMode === "downloads") return (right.entry.downloads ?? 0) - (left.entry.downloads ?? 0);
      if (sortMode === "smallest") return (bytesToGb(left.best?.file.size_bytes) ?? Number.POSITIVE_INFINITY) - (bytesToGb(right.best?.file.size_bytes) ?? Number.POSITIVE_INFINITY);
      if (sortMode === "largest") return (bytesToGb(right.best?.file.size_bytes) ?? 0) - (bytesToGb(left.best?.file.size_bytes) ?? 0);
      if (sortMode === "params") return (left.paramsB ?? Number.POSITIVE_INFINITY) - (right.paramsB ?? Number.POSITIVE_INFINITY);
      return (right.best?.score ?? -1) - (left.best?.score ?? -1);
    });
  }, [contextSize, entries, goal, gpuTotalGb, policy, ramTotalGb, sortMode, sourceFilter]);

  const topPick = scoredEntries.find((item) => item.best && item.best.fit.rank > 0) ?? scoredEntries[0] ?? null;
  const fullGpuLane = scoredEntries.filter((item) => item.best && item.best.fit.rank >= 4).slice(0, 8);
  const speedLane = [...scoredEntries].sort((left, right) => (right.best?.estimatedSpeed ?? 0) - (left.best?.estimatedSpeed ?? 0)).slice(0, 8);
  const qualityLane = [...scoredEntries].sort((left, right) => (right.best?.quality ?? 0) - (left.best?.quality ?? 0)).slice(0, 8);

  useEffect(() => {
    void refreshDownloads();
    void api
      .searchLibraryModels(query)
      .then((result) => setEntries(result.entries))
      .catch(() => undefined);
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
        setMessage("No GGUF repositories found. Try a broader query or paste a direct Hugging Face GGUF URL.");
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Model search failed");
    } finally {
      setIsSearching(false);
    }
  };

  const applyGoal = (nextGoal: FitGoal) => {
    setGoal(nextGoal);
    const option = goalOptions.find((item) => item.id === nextGoal) ?? goalOptions[0];
    void runSearch(option.query);
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
      setMessage("Download started. After it completes, add it to Local Panel and run Test Launch.");
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
      setMessage(`${download.file_name} added to Local Panel. Run Health Doctor/Test Launch before heavy use.`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not add downloaded model");
    }
  };

  return (
    <main className="mt-4 grid min-h-0 flex-1 grid-cols-1 overflow-hidden rounded-[var(--radius-soft)] border border-line/70 bg-panel/55 xl:grid-cols-[330px_minmax(0,1fr)_360px]">
      <aside className="min-h-0 overflow-y-auto border-b border-line/65 bg-shell/35 px-5 py-5 xl:border-b-0 xl:border-r">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent">Model Fit Advisor</p>
          <h1 className="mt-2 text-2xl font-semibold text-milk">Find what runs well</h1>
          <p className="mt-2 text-sm leading-6 text-milk/52">Pick a goal, Quokka scores GGUF files for your GPU, VRAM, RAM, context, and quantization.</p>
        </div>

        <div className="mt-5 rounded-[var(--radius-control)] border border-line/70 bg-panel/42 p-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-milk/42">Search Hugging Face</p>
          <div className="mt-3 flex gap-2">
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="qwen coder gguf q4_k_m" className="quokka-input" />
            <Button variant="primary" size="icon" onClick={() => void runSearch()} disabled={isSearching}>
              {isSearching ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            </Button>
          </div>
        </div>

        <div className="mt-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-milk/42">Goal</p>
          <div className="mt-3 grid gap-2">
            {goalOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => applyGoal(option.id)}
                className={cn(
                  "rounded-[var(--radius-control)] border px-3 py-3 text-left transition hover:border-accent/45",
                  goal === option.id ? "border-accent/65 bg-accent/12" : "border-line/55 bg-panel/35"
                )}
              >
                <span className="font-semibold text-milk">{option.label}</span>
                <span className="mt-1 block text-xs leading-5 text-milk/42">{option.hint}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="mt-5 rounded-[var(--radius-control)] border border-line/70 bg-panel/42 p-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-milk/42">Fit policy</p>
          <div className="mt-3 grid gap-2">
            {[
              { id: "gpu", label: "Full GPU only", hint: "Hide risky offload picks." },
              { id: "offload", label: "GPU + small offload", hint: "Best practical default." },
              { id: "any", label: "Show everything", hint: "Include CPU-only and huge models." },
            ].map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setPolicy(item.id as FitPolicy)}
                className={cn("rounded-[var(--radius-control)] border px-3 py-2 text-left text-sm transition hover:border-accent/45", policy === item.id ? "border-accent/65 bg-accent/12 text-milk" : "border-line/55 bg-shell/30 text-milk/62")}
              >
                <span className="font-semibold">{item.label}</span>
                <span className="mt-0.5 block text-xs text-milk/40">{item.hint}</span>
              </button>
            ))}
          </div>
          <label className="mt-4 block">
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-milk/38">Context cap</span>
            <select className="quokka-input mt-2 h-10 w-full rounded-[var(--radius-control)] px-3 text-sm" value={contextSize} onChange={(event) => setContextSize(Number(event.target.value))}>
              {[4096, 8192, 16384, 32768, 65536].map((value) => (
                <option key={value} value={value}>{value / 1024}K context</option>
              ))}
            </select>
          </label>
        </div>

        <div className="mt-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-milk/42">Explore lanes</p>
          <div className="mt-3 grid max-h-[360px] gap-2 overflow-y-auto pr-1">
            {categoryPresets.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className={cn(
                  "rounded-[var(--radius-control)] border px-3 py-2 text-left transition hover:border-live/45 hover:bg-live/8",
                  activeCategory === preset.label ? "border-accent/65 bg-accent/12" : "border-line/55 bg-panel/35"
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

        <div className="mt-5 rounded-[var(--radius-control)] border border-line/70 bg-panel/42 p-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-milk/42">Manual URL</p>
          <Input value={manualReference} onChange={(event) => setManualReference(event.target.value)} placeholder="https://huggingface.co/.../model.gguf" className="quokka-input mt-3" />
          <Button variant="secondary" className="quokka-control mt-3 w-full rounded-[var(--radius-control)]" onClick={() => void resolveManual()} disabled={isSearching}>
            Resolve URL
          </Button>
        </div>
      </aside>

      <section className="min-h-0 overflow-y-auto px-5 py-5">
        {message ? <div className="mb-4 rounded-[var(--radius-control)] border border-accent/35 bg-accent/10 px-4 py-3 text-sm text-milk/70">{message}</div> : null}
        {error ? <div className="mb-4 rounded-[var(--radius-control)] border border-danger/45 bg-danger/10 px-4 py-3 text-sm text-danger">{error}</div> : null}

        <div className="rounded-[var(--radius-soft)] border border-line/70 bg-shell/40 p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent">Recommendation</p>
              <h2 className="mt-2 text-2xl font-semibold text-milk">{topPick?.entry.name ?? "Search to calculate a fit"}</h2>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-milk/52">
                {topPick?.best
                  ? `Best current file: ${topPick.best.file.filename}`
                  : "Quokka will score models by fit, quality, rough speed, source trust, and your selected use case."}
              </p>
            </div>
            {topPick?.best ? <FitBadge fit={topPick.best.fit} /> : null}
          </div>

          {topPick?.best ? (
            <div className="mt-5 grid gap-3 md:grid-cols-4">
              <Stat label="Score" value={formatNumber(topPick.best.score, 0)} icon={Sparkles} />
              <Stat label="Need" value={topPick.best.estimatedVramGb ? `${formatNumber(topPick.best.estimatedVramGb, 1)} GB VRAM` : "--"} icon={HardDrive} />
              <Stat label="Speed" value={topPick.best.estimatedSpeed ? `${formatNumber(topPick.best.estimatedSpeed, 1)} tok/s` : "--"} icon={Gauge} />
              <Stat label="Quality" value={`${formatNumber(topPick.best.quality, 0)}% est.`} icon={Target} />
            </div>
          ) : null}

          {topPick?.best ? (
            <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1fr)_220px]">
              <div className="rounded-[var(--radius-control)] border border-line/60 bg-panel/35 px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-milk/38">Why this pick</p>
                <div className="mt-3 grid gap-2 text-sm leading-6 text-milk/58">
                  {topPick.best.reasons.map((reason) => (
                    <span key={reason}>- {reason}</span>
                  ))}
                </div>
              </div>
              <Button variant="primary" className="h-full min-h-20 rounded-[var(--radius-control)]" onClick={() => topPick.best && void downloadFile(topPick.entry, topPick.best.file)}>
                <Download className="h-4 w-4" />
                Download recommended GGUF
              </Button>
            </div>
          ) : null}
        </div>

        <div className="mt-5 rounded-[var(--radius-control)] border border-line/70 bg-shell/38 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm text-milk/52">
              <SlidersHorizontal className="h-4 w-4 text-accent" />
              <span>{scoredEntries.length} scored / {entries.length} repos</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select className="quokka-input h-9 rounded-[var(--radius-control)] px-3 text-xs" value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as SourceFilter)}>
                <option value="all">All sources</option>
                <option value="official">Official/upstream only</option>
                <option value="community">Community GGUF</option>
              </select>
              <select className="quokka-input h-9 rounded-[var(--radius-control)] px-3 text-xs" value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}>
                <option value="recommendation">Sort: Quokka score</option>
                <option value="quality">Sort: quality</option>
                <option value="speed">Sort: speed</option>
                <option value="downloads">Sort: downloads</option>
                <option value="smallest">Sort: smallest</option>
                <option value="largest">Sort: largest</option>
                <option value="params">Sort: params</option>
              </select>
            </div>
          </div>
        </div>

        {scoredEntries.length ? (
          <div className="mt-5 space-y-6">
            <section>
              <p className="mb-3 text-xs font-semibold uppercase tracking-[0.22em] text-accent">Fits fully in VRAM</p>
              <div className="flex gap-3 overflow-x-auto pb-2">
                {(fullGpuLane.length ? fullGpuLane : scoredEntries.slice(0, 6)).map((item) => <EntryMiniCard key={`fit-${item.entry.repo_id}`} item={item} onDownload={downloadFile} />)}
              </div>
            </section>
            <section>
              <p className="mb-3 text-xs font-semibold uppercase tracking-[0.22em] text-live">Fastest likely</p>
              <div className="flex gap-3 overflow-x-auto pb-2">
                {speedLane.map((item) => <EntryMiniCard key={`speed-${item.entry.repo_id}`} item={item} onDownload={downloadFile} />)}
              </div>
            </section>
            <section>
              <p className="mb-3 text-xs font-semibold uppercase tracking-[0.22em] text-milk/45">High quality quants</p>
              <div className="flex gap-3 overflow-x-auto pb-2">
                {qualityLane.map((item) => <EntryMiniCard key={`quality-${item.entry.repo_id}`} item={item} onDownload={downloadFile} />)}
              </div>
            </section>
          </div>
        ) : null}

        <div className="mt-6 grid gap-4">
          {scoredEntries.map((item) => (
            <article key={item.entry.repo_id} className="rounded-[var(--radius-control)] border border-line/70 bg-shell/40 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-lg font-semibold text-milk">{item.entry.name}</h3>
                    <span className="quokka-pill px-2 py-1 text-xs text-accent">{item.sourceLabel}</span>
                    {item.paramsB ? <span className="quokka-pill px-2 py-1 text-xs text-milk/52">{item.paramsB}B params</span> : null}
                  </div>
                  <p className="mt-1 break-all font-mono text-xs text-live/75">{item.entry.repo_id}</p>
                  <p className="mt-3 max-w-3xl text-sm leading-6 text-milk/50">{item.entry.description ?? "Hugging Face GGUF model repository."}</p>
                </div>
                <div className="flex items-center gap-2">
                  {item.best ? <FitBadge fit={item.best.fit} /> : null}
                  <Button variant="ghost" size="sm" onClick={() => window.quokkaDesktop?.openExternal?.(`https://huggingface.co/${item.entry.repo_id}`)}>
                    <ExternalLink className="h-4 w-4" />
                    HF
                  </Button>
                </div>
              </div>
              {item.best ? (
                <div className="mt-4 rounded-[var(--radius-control)] border border-accent/25 bg-accent/8 px-3 py-3">
                  <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_90px_90px_90px_150px] md:items-center">
                    <span className="truncate font-mono text-sm text-milk/82">{item.best.file.filename}</span>
                    <span className="text-sm text-accent">{item.best.file.quantization ?? "GGUF"}</span>
                    <span className="text-sm text-milk/55">{bytesToLabel(item.best.file.size_bytes)}</span>
                    <span className={cn("text-sm", item.best.fit.tone)}>{item.best.estimatedVramGb ? `~${formatNumber(item.best.estimatedVramGb, 1)}GB` : "--"}</span>
                    <Button variant="primary" size="sm" className="rounded-[var(--radius-control)]" onClick={() => item.best && void downloadFile(item.entry, item.best.file)}>
                      <Download className="h-4 w-4" />
                      Best GGUF
                    </Button>
                  </div>
                </div>
              ) : null}
              <div className="mt-3 grid gap-2">
                {item.entry.files
                  .map((file) => scoreFile(item.entry, file, { goal, policy, contextSize, gpuTotalGb, ramTotalGb }))
                  .sort((left, right) => right.score - left.score)
                  .slice(0, 6)
                  .map((fileScore) => (
                    <div key={fileScore.file.filename} className="grid gap-3 rounded-[var(--radius-control)] border border-line/45 bg-panel/30 px-3 py-2 md:grid-cols-[minmax(0,1fr)_80px_76px_116px_84px_128px] md:items-center">
                      <span className="truncate font-mono text-xs text-milk/62">{fileScore.file.filename}</span>
                      <span className="text-xs text-accent">{fileScore.file.quantization ?? "GGUF"}</span>
                      <span className="text-xs text-milk/42">{bytesToLabel(fileScore.file.size_bytes)}</span>
                      <span className={cn("text-xs", fileScore.fit.tone)}>{fileScore.fit.label}</span>
                      <span className="text-xs text-milk/48">{fileScore.estimatedSpeed ? `${formatNumber(fileScore.estimatedSpeed, 1)} tok/s` : "--"}</span>
                      <Button variant="secondary" size="sm" className="quokka-control rounded-[var(--radius-control)]" onClick={() => void downloadFile(item.entry, fileScore.file)}>
                        Download
                      </Button>
                    </div>
                  ))}
              </div>
            </article>
          ))}

          {!entries.length ? (
            <div className="grid min-h-[360px] place-items-center rounded-[var(--radius-control)] border border-dashed border-line/70 bg-shell/35 text-center">
              <div>
                <Library className="mx-auto h-8 w-8 text-accent" />
                <p className="mt-4 text-lg font-semibold text-milk">Choose a goal or search Hugging Face</p>
                <p className="mt-2 text-sm text-milk/48">Quokka will calculate fit, speed, quality, and recommended quantization.</p>
              </div>
            </div>
          ) : null}
          {entries.length > 0 && !scoredEntries.length ? (
            <div className="rounded-[var(--radius-control)] border border-line/70 bg-shell/35 px-4 py-10 text-center text-sm text-milk/50">
              Nothing matches this source filter. Try All sources or another goal.
            </div>
          ) : null}
        </div>
      </section>

      <aside className="min-h-0 overflow-y-auto border-t border-line/65 bg-shell/35 px-5 py-5 xl:border-l xl:border-t-0">
        <div className="rounded-[var(--radius-control)] border border-line/70 bg-panel/42 p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">Detected hardware</p>
          <div className="mt-4 grid gap-3">
            <Stat label="GPU" value={primaryGpu?.name ?? "Not detected"} icon={MonitorDown} />
            <Stat label="VRAM" value={gpuTotalGb ? `${formatNumber(gpuTotalGb, 1)} GB` : "--"} icon={HardDrive} />
            <Stat label="RAM" value={ramTotalGb ? `${formatNumber(ramTotalGb, 1)} GB` : "--"} icon={Cpu} />
            <Stat label="Policy" value={policy === "gpu" ? "Full GPU" : policy === "offload" ? "GPU + offload" : "Show all"} icon={Target} />
          </div>
        </div>

        <div className="mt-4 rounded-[var(--radius-control)] border border-line/70 bg-panel/42 p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">Fit scale</p>
          <div className="mt-3 grid gap-2 text-sm text-milk/56">
            <span><b className="text-success">Full GPU</b> - best speed, safest path.</span>
            <span><b className="text-success">GPU fit</b> - should work, less headroom.</span>
            <span><b className="text-warning">Offload fit</b> - works but slower.</span>
            <span><b className="text-milk/70">CPU possible</b> - fallback, slow.</span>
            <span><b className="text-danger">Too large</b> - avoid for this PC.</span>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">Downloads</p>
            <p className="mt-1 break-all text-xs text-milk/42">{targetDir || "Default: Quokka data/models folder"}</p>
          </div>
          <Button variant="secondary" size="icon" className="quokka-control rounded-[var(--radius-control)]" onClick={chooseDownloadFolder} title="Choose download folder">
            <FolderOpen className="h-4 w-4" />
          </Button>
        </div>

        <div className="mt-4 space-y-3">
          {downloads.map((download) => (
            <div key={download.id} className="rounded-[var(--radius-control)] border border-line/70 bg-panel/42 p-3">
              <div className="flex items-start gap-2">
                {download.status === "completed" ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-success" /> : download.status === "failed" ? <XCircle className="mt-0.5 h-4 w-4 text-danger" /> : <LoaderCircle className="mt-0.5 h-4 w-4 animate-spin text-live" />}
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-milk">{download.label}</p>
                  <p className="mt-1 truncate text-xs text-milk/42">{download.file_name}</p>
                </div>
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-milk/8">
                <div className={cn("h-full rounded-full", download.status === "failed" ? "bg-danger" : download.status === "completed" ? "bg-success" : "bg-live")} style={{ width: `${Math.max(2, download.progress_percent)}%` }} />
              </div>
              <p className="mt-2 text-xs text-milk/45">{download.status} / {formatNumber(download.progress_percent, 1)}%</p>
              {download.error ? <p className="mt-2 text-xs text-danger">{download.error}</p> : null}
              <div className="mt-3 flex gap-2">
                {download.status === "completed" ? (
                  <Button variant="primary" size="sm" className="flex-1 rounded-[var(--radius-control)]" onClick={() => void addDownloadedModel(download)}>
                    Add to Local Panel
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
          {!downloads.length ? (
            <div className="rounded-[var(--radius-control)] border border-line/70 bg-panel/35 px-3 py-8 text-center text-sm text-milk/45">
              Downloads will appear here.
            </div>
          ) : null}
        </div>

        <div className="mt-4 rounded-[var(--radius-control)] border border-line/70 bg-panel/42 p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">After download</p>
          <div className="mt-3 grid gap-2 text-sm text-milk/56">
            <span>1. Add to Local Panel</span>
            <span>2. Run Health Doctor</span>
            <span>3. Test Launch</span>
            <span>4. Save profile if stable</span>
          </div>
        </div>
      </aside>
    </main>
  );
}
