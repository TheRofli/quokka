import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  CheckCircle2,
  ChevronDown,
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
  Target,
  XCircle,
  Zap,
} from "lucide-react";

import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn, formatNumber } from "@/lib/utils";
import type {
  CreateModelRequest,
  ModelDownloadStatus,
  ModelLibraryEntry,
  ModelLibraryFile,
  ModelView,
  SystemMetricsResponse,
} from "@/types/api";

interface ModelLibraryProps {
  models: ModelView[];
  metrics?: SystemMetricsResponse | null;
  initialQuery?: string | null;
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
  { id: "reasoning", label: "Reasoning", hint: "More capable models with more VRAM pressure.", query: "qwen reasoning 14b 32b gguf q4_k_m" },
  { id: "vision", label: "Vision", hint: "Vision models and mmproj companions.", query: "llava vision gguf mmproj" },
];

const categoryPresets = [
  { label: "Best for this PC", query: "qwen coder gguf q4_k_m" },
  { label: "Coding", query: "qwen coder devstral gguf q4_k_m" },
  { label: "Small/Fast", query: "4b 7b gguf q4_k_m" },
  { label: "Chat", query: "llama instruct gemma gguf q4_k_m" },
  { label: "Vision", query: "llava gguf mmproj" },
  { label: "Long Context", query: "long context gguf q4_k_m" },
  { label: "Qwen", query: "qwen gguf q4_k_m" },
  { label: "Gemma", query: "gemma gguf q4_k_m" },
  { label: "Mistral", query: "mistral devstral gguf q4_k_m" },
  { label: "Llama", query: "llama instruct gguf q4_k_m" },
  { label: "CPU fallback", query: "3b 4b gguf q4_0" },
  { label: "30B+", query: "32b gguf q4_k_m" },
];

const officialOwners = new Set([
  "google",
  "qwen",
  "qwenlm",
  "mistralai",
  "meta-llama",
  "deepseek-ai",
  "nvidia",
  "microsoft",
  "allenai",
  "01-ai",
  "tiiuae",
  "ibm-granite",
]);
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

function scoreFile(
  entry: ModelLibraryEntry,
  file: ModelLibraryFile,
  options: {
    goal: FitGoal;
    policy: FitPolicy;
    contextSize: number;
    gpuTotalGb?: number | null;
    ramTotalGb?: number | null;
  }
): ScoredFile {
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

function goalLabel(goal: FitGoal) {
  return goalOptions.find((option) => option.id === goal)?.label ?? "Best overall";
}

function policyLabel(policy: FitPolicy) {
  if (policy === "gpu") return "Full GPU only";
  if (policy === "offload") return "GPU + small offload";
  return "Show everything";
}

function sourceFilterLabel(sourceFilter: SourceFilter) {
  if (sourceFilter === "official") return "Official only";
  if (sourceFilter === "community") return "Community GGUF";
  return "All sources";
}

function sortLabel(sortMode: SortMode) {
  const labels: Record<SortMode, string> = {
    recommendation: "Quokka score",
    quality: "Quality",
    speed: "Likely speed",
    downloads: "Downloads",
    smallest: "Smallest",
    largest: "Largest",
    params: "Parameter count",
  };
  return labels[sortMode];
}

function FitBadge({ fit }: { fit: FitInfo }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold",
        fit.tone,
        fit.rank >= 4
          ? "border-success/35 bg-success/10"
          : fit.rank === 3
            ? "border-warning/35 bg-warning/10"
            : fit.rank === 0
              ? "border-danger/35 bg-danger/10"
              : "border-line/60 bg-panel/40"
      )}
    >
      {fit.label}
    </span>
  );
}

function ControlLabel({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-2 flex items-center justify-between gap-2 font-mono text-[12px] lowercase tracking-wide text-milk/58">
        <span>&gt; {label}:</span>
        {hint ? <span className="truncate text-[11px] text-milk/32">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

function RailMetric({ icon: Icon, label, value, hint }: { icon: LucideIcon; label: string; value: string; hint?: string }) {
  return (
    <div className="border-b border-line/55 py-3">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-milk/42">
        <Icon className="h-3.5 w-3.5 text-accent" />
        {label}
      </div>
      <p className="mt-2 truncate font-mono text-lg font-semibold text-milk">{value}</p>
      {hint ? <p className="mt-1 truncate text-xs text-milk/42">{hint}</p> : null}
    </div>
  );
}

function TerminalLine({ tag, tone = "text-live", children }: { tag: string; tone?: string; children: ReactNode }) {
  return (
    <p className="font-mono text-sm leading-7 text-milk/70">
      <span className={cn("mr-2", tone)}>[{tag.padEnd(5)}]</span>
      {children}
    </p>
  );
}

function ResultRow({
  item,
  index,
  variants,
  onDownload,
}: {
  item: ScoredEntry;
  index: number;
  variants: ScoredFile[];
  onDownload: (entry: ModelLibraryEntry, file: ModelLibraryFile) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const best = item.best;

  if (!best) {
    return null;
  }

  return (
    <article className="border-b border-line/55 px-4 py-3 transition hover:bg-panel/32">
      <div className="grid gap-3 xl:grid-cols-[44px_minmax(0,1fr)_110px_92px_96px_112px] xl:items-center">
        <span className="font-mono text-xs text-milk/34">#{String(index + 1).padStart(2, "0")}</span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate font-semibold text-milk">{item.entry.name}</p>
            {item.paramsB ? <span className="rounded-full bg-milk/6 px-2 py-0.5 text-[11px] text-milk/52">{item.paramsB}B</span> : null}
            <span className="rounded-full bg-milk/6 px-2 py-0.5 text-[11px] text-milk/42">{item.sourceLabel}</span>
          </div>
          <button
            type="button"
            className="mt-1 truncate font-mono text-xs text-live/68 hover:text-live"
            onClick={() => window.quokkaDesktop?.openExternal?.(`https://huggingface.co/${item.entry.repo_id}`)}
          >
            {item.entry.repo_id}
          </button>
          <p className="mt-2 truncate font-mono text-xs text-milk/38">{best.file.filename}</p>
        </div>
        <FitBadge fit={best.fit} />
        <div className="font-mono text-sm text-milk/68">
          <span className="block text-milk/86">{best.file.quantization ?? "GGUF"}</span>
          <span className="text-xs text-milk/36">{bytesToLabel(best.file.size_bytes)}</span>
        </div>
        <div className="font-mono text-sm">
          <span className={best.fit.tone}>{best.estimatedVramGb ? `${formatNumber(best.estimatedVramGb, 1)} GB` : "--"}</span>
          <span className="block text-xs text-milk/36">need</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="primary" size="sm" className="rounded-[var(--radius-control)]" onClick={() => onDownload(item.entry, best.file)}>
            <Download className="h-4 w-4" />
            GGUF
          </Button>
          <Button variant="ghost" size="icon" className="rounded-[var(--radius-control)]" onClick={() => setExpanded((value) => !value)} title="Show variants">
            <ChevronDown className={cn("h-4 w-4 transition", expanded ? "rotate-180" : "")} />
          </Button>
        </div>
      </div>

      {expanded ? (
        <div className="mt-3 rounded-[var(--radius-control)] border border-line/55 bg-shell/35">
          {variants.slice(0, 8).map((variant) => (
            <div
              key={variant.file.filename}
              className="grid gap-2 border-b border-line/40 px-3 py-2 last:border-b-0 md:grid-cols-[minmax(0,1fr)_84px_78px_94px_88px_108px] md:items-center"
            >
              <span className="truncate font-mono text-xs text-milk/58">{variant.file.filename}</span>
              <span className="font-mono text-xs text-accent">{variant.file.quantization ?? "GGUF"}</span>
              <span className="font-mono text-xs text-milk/42">{bytesToLabel(variant.file.size_bytes)}</span>
              <span className={cn("font-mono text-xs", variant.fit.tone)}>{variant.fit.label}</span>
              <span className="font-mono text-xs text-milk/48">{variant.estimatedSpeed ? `${formatNumber(variant.estimatedSpeed, 1)} tok/s` : "--"}</span>
              <Button variant="secondary" size="sm" className="quokka-control rounded-[var(--radius-control)]" onClick={() => onDownload(item.entry, variant.file)}>
                Download
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </article>
  );
}

export function ModelLibrary({ models, metrics, initialQuery, onAdded }: ModelLibraryProps) {
  const defaultQuery = initialQuery ?? "qwen coder gguf q4_k_m";
  const [query, setQuery] = useState(defaultQuery);
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
  const [advancedOpen, setAdvancedOpen] = useState(false);
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

  const policyVisibleEntries = useMemo(() => {
    const visible = scoredEntries.filter((item) => {
      if (!item.best) return false;
      if (policy === "gpu") return item.best.fit.rank >= 4;
      if (policy === "offload") return item.best.fit.rank >= 3;
      return item.best.fit.rank >= 0;
    });
    return visible.length ? visible : scoredEntries;
  }, [policy, scoredEntries]);

  const topPick = policyVisibleEntries.find((item) => item.best && item.best.fit.rank > 0) ?? policyVisibleEntries[0] ?? null;

  useEffect(() => {
    void refreshDownloads();
    void api
      .searchLibraryModels(defaultQuery)
      .then((result) => setEntries(result.entries))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!initialQuery || initialQuery === query) {
      return;
    }
    void runSearch(initialQuery);
  }, [initialQuery, query]);

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

  const variantScores = (item: ScoredEntry) =>
    item.entry.files
      .map((file) => scoreFile(item.entry, file, { goal, policy, contextSize, gpuTotalGb, ramTotalGb }))
      .sort((left, right) => right.score - left.score);

  const topFit = topPick?.best?.fit ?? null;
  const runningDownloads = activeDownloads.length;

  return (
    <main className="mt-4 flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="quokka-panel flex h-[66px] shrink-0 items-center justify-between rounded-[var(--radius-control)] px-5">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <Library className="h-5 w-5 text-accent" />
            <h1 className="truncate text-xl font-semibold tracking-[0.16em] text-milk">MODEL LIBRARY</h1>
          </div>
          <p className="mt-1 truncate font-mono text-xs text-milk/42">fit advisor / GGUF search / local launch preparation</p>
        </div>
        <div className="hidden items-center gap-2 lg:flex">
          <span className="quokka-pill px-3 py-2 font-mono text-xs text-milk/52">{entries.length} repos</span>
          <span className="quokka-pill px-3 py-2 font-mono text-xs text-milk/52">{goalLabel(goal)}</span>
          <span className="quokka-pill px-3 py-2 font-mono text-xs text-milk/52">{policyLabel(policy)}</span>
        </div>
      </header>

      <div className="mt-3 grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-hidden xl:grid-cols-[300px_minmax(0,1fr)_270px]">
        <aside className="quokka-surface flex min-h-0 flex-col overflow-hidden rounded-[var(--radius-control)]">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
            <ControlLabel label="goal" hint="what you want">
              <select className="quokka-input h-12 w-full rounded-[var(--radius-control)] px-3 text-sm" value={goal} onChange={(event) => applyGoal(event.target.value as FitGoal)} disabled={isSearching}>
                {goalOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              <p className="mt-2 text-xs leading-5 text-milk/42">{goalOptions.find((option) => option.id === goal)?.hint}</p>
            </ControlLabel>

            <ControlLabel label="search" hint="Hugging Face">
              <div className="flex gap-2">
                <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="qwen coder gguf q4_k_m" className="quokka-input h-12" />
                <Button variant="primary" size="icon" className="h-12 w-12 shrink-0 rounded-[var(--radius-control)]" onClick={() => void runSearch()} disabled={isSearching}>
                  {isSearching ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                </Button>
              </div>
            </ControlLabel>

            <ControlLabel label="fit policy" hint="how strict">
              <select className="quokka-input h-12 w-full rounded-[var(--radius-control)] px-3 text-sm" value={policy} onChange={(event) => setPolicy(event.target.value as FitPolicy)}>
                <option value="offload">GPU + small offload</option>
                <option value="gpu">Full GPU only</option>
                <option value="any">Show everything</option>
              </select>
            </ControlLabel>

            <button
              type="button"
              className="flex w-full items-center justify-between rounded-[var(--radius-control)] border border-line/60 bg-panel/35 px-3 py-3 text-left text-sm text-milk/70 transition hover:border-accent/45"
              onClick={() => setAdvancedOpen((value) => !value)}
            >
              <span className="flex items-center gap-2">
                <SlidersHorizontal className="h-4 w-4 text-accent" />
                Advanced filters
              </span>
              <ChevronDown className={cn("h-4 w-4 transition", advancedOpen ? "rotate-180" : "")} />
            </button>

            {advancedOpen ? (
              <div className="space-y-4 rounded-[var(--radius-control)] border border-line/55 bg-shell/30 p-3">
                <ControlLabel label="source">
                  <select className="quokka-input h-10 w-full rounded-[var(--radius-control)] px-3 text-sm" value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as SourceFilter)}>
                    <option value="all">All sources</option>
                    <option value="official">Official/upstream only</option>
                    <option value="community">Community GGUF</option>
                  </select>
                </ControlLabel>

                <ControlLabel label="sort">
                  <select className="quokka-input h-10 w-full rounded-[var(--radius-control)] px-3 text-sm" value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}>
                    <option value="recommendation">Quokka score</option>
                    <option value="quality">Quality</option>
                    <option value="speed">Likely speed</option>
                    <option value="downloads">Downloads</option>
                    <option value="smallest">Smallest file</option>
                    <option value="largest">Largest file</option>
                    <option value="params">Parameter count</option>
                  </select>
                </ControlLabel>

                <ControlLabel label="context">
                  <select className="quokka-input h-10 w-full rounded-[var(--radius-control)] px-3 text-sm" value={contextSize} onChange={(event) => setContextSize(Number(event.target.value))}>
                    {[4096, 8192, 16384, 32768, 65536].map((value) => (
                      <option key={value} value={value}>
                        {value / 1024}K context
                      </option>
                    ))}
                  </select>
                </ControlLabel>

                <div>
                  <p className="mb-2 font-mono text-[12px] lowercase tracking-wide text-milk/58">&gt; quick lanes:</p>
                  <div className="flex flex-wrap gap-2">
                    {categoryPresets.map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        className={cn(
                          "rounded-full border px-3 py-1.5 text-xs transition hover:border-live/45",
                          activeCategory === preset.label ? "border-accent/55 bg-accent/12 text-milk" : "border-line/55 bg-panel/35 text-milk/52"
                        )}
                        onClick={() => void runSearch(preset.query)}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>

                <ControlLabel label="manual URL">
                  <Input value={manualReference} onChange={(event) => setManualReference(event.target.value)} placeholder="https://huggingface.co/.../model.gguf" className="quokka-input h-10" />
                  <Button variant="secondary" className="quokka-control mt-2 h-10 w-full rounded-[var(--radius-control)]" onClick={() => void resolveManual()} disabled={isSearching}>
                    Resolve URL
                  </Button>
                </ControlLabel>
              </div>
            ) : null}
          </div>

          <div className="border-t border-line/55 p-4">
            <Button variant="primary" className="h-12 w-full rounded-[var(--radius-control)]" onClick={() => void runSearch()} disabled={isSearching}>
              {isSearching ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Target className="h-4 w-4" />}
              Find best fit
            </Button>
          </div>
        </aside>

        <section className="quokka-terminal grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-[var(--radius-control)] border border-line/60">
          <div className="flex h-14 items-center justify-between border-b border-line/55 px-4">
            <div className="flex items-center gap-2">
              <Gauge className="h-4 w-4 text-live" />
              <p className="font-mono text-xs uppercase tracking-[0.22em] text-accent">Fit Advisor</p>
              <span className="font-mono text-xs text-milk/42">{isSearching ? "scanning" : `${policyVisibleEntries.length} visible`}</span>
            </div>
            <p className="hidden font-mono text-xs text-milk/38 md:block">{sourceFilterLabel(sourceFilter)} / {sortLabel(sortMode)}</p>
          </div>

          <div className="min-h-0 overflow-y-auto">
            {message ? <div className="mx-4 mt-4 rounded-[var(--radius-control)] border border-accent/35 bg-accent/10 px-4 py-3 text-sm text-milk/70">{message}</div> : null}
            {error ? <div className="mx-4 mt-4 rounded-[var(--radius-control)] border border-danger/45 bg-danger/10 px-4 py-3 text-sm text-danger">{error}</div> : null}

            <div className="border-b border-line/55 px-4 py-4">
              {topPick?.best ? (
                <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_190px]">
                  <div className="min-w-0">
                    <TerminalLine tag="SCAN" tone="text-live">
                      {primaryGpu?.name ?? "GPU telemetry unavailable"} / {gpuTotalGb ? `${formatNumber(gpuTotalGb, 1)}GB VRAM` : "unknown VRAM"} / ctx {contextSize / 1024}K
                    </TerminalLine>
                    <TerminalLine tag="GOAL" tone="text-accent">
                      {goalLabel(goal)} / {policyLabel(policy)} / {sourceFilterLabel(sourceFilter)}
                    </TerminalLine>
                    <TerminalLine tag="BEST" tone="text-success">
                      <span className="font-semibold text-milk">{topPick.entry.name}</span>
                    </TerminalLine>
                    <TerminalLine tag="FIT" tone={topFit?.rank && topFit.rank >= 4 ? "text-success" : topFit?.rank === 3 ? "text-warning" : "text-danger"}>
                      {topPick.best.fit.label} / needs {topPick.best.estimatedVramGb ? `${formatNumber(topPick.best.estimatedVramGb, 1)}GB` : "--"} VRAM / est.{" "}
                      {topPick.best.estimatedSpeed ? `${formatNumber(topPick.best.estimatedSpeed, 1)} tok/s` : "--"}
                    </TerminalLine>
                    <TerminalLine tag="WHY" tone="text-milk/42">
                      {topPick.best.reasons[0]}
                    </TerminalLine>
                  </div>
                  <div className="flex flex-col gap-2">
                    <FitBadge fit={topPick.best.fit} />
                    <Button variant="primary" className="h-12 rounded-[var(--radius-control)]" onClick={() => topPick.best && void downloadFile(topPick.entry, topPick.best.file)}>
                      <Download className="h-4 w-4" />
                      Download best
                    </Button>
                    <Button
                      variant="secondary"
                      className="quokka-control h-10 rounded-[var(--radius-control)]"
                      onClick={() => window.quokkaDesktop?.openExternal?.(`https://huggingface.co/${topPick.entry.repo_id}`)}
                    >
                      <ExternalLink className="h-4 w-4" />
                      Open HF
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="grid min-h-[220px] place-items-center text-center">
                  <div>
                    <Library className="mx-auto h-8 w-8 text-accent" />
                    <p className="mt-4 text-lg font-semibold text-milk">Choose a goal, then scan</p>
                    <p className="mt-2 max-w-md text-sm leading-6 text-milk/48">Quokka will keep the first screen simple: one best pick, why it fits, then a clean list of alternatives.</p>
                  </div>
                </div>
              )}
            </div>

            {policyVisibleEntries.length ? (
              <div>
                <div className="grid border-b border-line/55 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.16em] text-milk/34 xl:grid-cols-[44px_minmax(0,1fr)_110px_92px_96px_112px]">
                  <span>#</span>
                  <span>Model</span>
                  <span>Fit</span>
                  <span>Quant</span>
                  <span>Need</span>
                  <span>Action</span>
                </div>
                {policyVisibleEntries.map((item, index) => (
                  <ResultRow key={item.entry.repo_id} item={item} index={index} variants={variantScores(item)} onDownload={downloadFile} />
                ))}
              </div>
            ) : entries.length ? (
              <div className="px-4 py-10 text-center text-sm text-milk/50">Nothing matches this filter. Try "All sources" or "Show everything".</div>
            ) : null}
          </div>
        </section>

        <aside className="quokka-surface min-h-0 overflow-y-auto rounded-[var(--radius-control)] px-5 py-5">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">Hardware fit</p>
            <RailMetric icon={MonitorDown} label="GPU" value={primaryGpu?.name ?? "Not detected"} hint={primaryGpu?.memory_total_mb ? "CUDA telemetry available" : "No GPU telemetry"} />
            <RailMetric icon={HardDrive} label="VRAM" value={gpuTotalGb ? `${formatNumber(gpuTotalGb, 1)} GB` : "--"} hint={topPick?.best?.estimatedVramGb ? `best needs ~${formatNumber(topPick.best.estimatedVramGb, 1)} GB` : "waiting for scan"} />
            <RailMetric icon={Cpu} label="RAM" value={ramTotalGb ? `${formatNumber(ramTotalGb, 1)} GB` : "--"} hint={policy === "offload" ? "offload allowed" : policyLabel(policy)} />
            <RailMetric icon={Zap} label="Speed" value={topPick?.best?.estimatedSpeed ? `${formatNumber(topPick.best.estimatedSpeed, 1)} tok/s` : "--"} hint="rough estimate before benchmark" />
          </div>

          <div className="mt-5 rounded-[var(--radius-control)] border border-line/60 bg-shell/32 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">Fit scale</p>
            <div className="mt-3 space-y-2 text-sm leading-6 text-milk/56">
              <p><span className="text-success">Full GPU</span> - safest and fastest.</p>
              <p><span className="text-warning">Offload</span> - usable, slower.</p>
              <p><span className="text-danger">Too large</span> - likely OOM.</p>
            </div>
          </div>

          <div className="mt-5 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">Downloads</p>
              <p className="mt-1 truncate text-xs text-milk/42">{targetDir || "Default Quokka models folder"}</p>
            </div>
            <Button variant="secondary" size="icon" className="quokka-control rounded-[var(--radius-control)]" onClick={chooseDownloadFolder} title="Choose download folder">
              <FolderOpen className="h-4 w-4" />
            </Button>
          </div>

          <div className="mt-3 space-y-3">
            {downloads.slice(0, 8).map((download) => (
              <div key={download.id} className="rounded-[var(--radius-control)] border border-line/60 bg-panel/35 p-3">
                <div className="flex items-start gap-2">
                  {download.status === "completed" ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 text-success" />
                  ) : download.status === "failed" ? (
                    <XCircle className="mt-0.5 h-4 w-4 text-danger" />
                  ) : (
                    <LoaderCircle className="mt-0.5 h-4 w-4 animate-spin text-live" />
                  )}
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
                      Add
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
              <div className="rounded-[var(--radius-control)] border border-dashed border-line/60 bg-shell/30 px-3 py-8 text-center text-sm text-milk/45">
                Downloads appear here.
              </div>
            ) : null}
            {downloads.length > 8 ? <p className="text-center text-xs text-milk/36">Showing latest 8 downloads.</p> : null}
          </div>

          <div className="mt-5 rounded-[var(--radius-control)] border border-line/60 bg-shell/32 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">Next step</p>
            <div className="mt-3 space-y-2 text-sm leading-6 text-milk/56">
              <p>Download GGUF.</p>
              <p>Add to Local Panel.</p>
              <p>Run Health Doctor and Test Launch.</p>
            </div>
            {runningDownloads ? <p className="mt-3 font-mono text-xs text-live">{runningDownloads} active download(s)</p> : null}
          </div>
        </aside>
      </div>
    </main>
  );
}
