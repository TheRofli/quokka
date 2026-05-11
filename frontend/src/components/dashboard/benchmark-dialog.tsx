import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Activity, BarChart3, ChevronDown, Copy, Download, Gauge, History, Play, Square, Terminal, XCircle, Zap } from "lucide-react";

import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { cn, formatNumber, formatTimestamp } from "@/lib/utils";
import type {
  BenchmarkCandidate,
  BenchmarkOptimizeFor,
  BenchmarkRunResponse,
  BenchmarkSuite,
  BenchmarkWorkflowMode,
  ModelView,
} from "@/types/api";

interface BenchmarkDialogProps {
  open: boolean;
  embedded?: boolean;
  models: ModelView[];
  onClose: () => void;
}

const HISTORY_KEY = "quokka.benchmark.history.v2";
const terminalStatuses = new Set(["completed", "failed", "cancelled"]);

const workflowOptions: Array<{ value: BenchmarkWorkflowMode; label: string; hint: string }> = [
  { value: "single", label: "single", hint: "One profile, quick or full suite." },
  { value: "smart_auto", label: "smart auto", hint: "Staged sweeps with selected winners." },
  { value: "exhaustive", label: "exhaustive", hint: "Wider staged sweep inside constraints." },
  { value: "compare", label: "compare", hint: "Diff saved runs without a new load test." },
];

const suiteOptions: Array<{ value: BenchmarkSuite; label: string }> = [
  { value: "quick", label: "Quick" },
  { value: "full", label: "Full" },
  { value: "stress", label: "Stress" },
  { value: "short_chat", label: "Short chat" },
  { value: "coding", label: "Coding" },
  { value: "long_reasoning", label: "Long reasoning" },
  { value: "mixed", label: "Mixed" },
  { value: "vision", label: "Vision" },
];

const optimizeOptions: Array<{ value: BenchmarkOptimizeFor; label: string }> = [
  { value: "max_toks", label: "Max tok/s" },
  { value: "lowest_ttft", label: "Lowest TTFT" },
  { value: "balanced", label: "Balanced" },
  { value: "long_context", label: "Long context" },
  { value: "coding", label: "Coding" },
  { value: "vision", label: "Vision" },
];

function modelLabel(model: ModelView) {
  const quant = model.artifact?.quantization ? ` ${model.artifact.quantization}` : "";
  return `${model.name}${quant}`;
}

function metricValue(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key];
  return typeof value === "number" ? value : null;
}

function downloadText(fileName: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function csvEscape(value: unknown) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function resultToCsv(result: BenchmarkRunResponse) {
  const rows = [
    ["stage", "ok", "duration_ms", "ttft_ms", "prefill_tokens_per_second", "decode_tokens_per_second", "tokens_estimate", "thinking_tokens", "answer_tokens", "thinking_ratio_percent", "error"],
    ...result.stages.map((stage) => [
      stage.name,
      stage.ok,
      stage.duration_ms,
      stage.ttft_ms ?? "",
      stage.prompt_tokens_per_second ?? "",
      stage.tokens_per_second ?? "",
      stage.generated_tokens_estimate ?? "",
      stage.thinking_tokens_estimate ?? "",
      stage.answer_tokens_estimate ?? "",
      stage.thinking_ratio_percent ?? "",
      stage.error ?? "",
    ]),
  ];
  return rows.map((row) => row.map(csvEscape).join(",")).join("\n");
}

function bestNumber(values: Array<number | null | undefined>, mode: "min" | "max") {
  const numeric = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  if (!numeric.length) {
    return null;
  }
  return mode === "min" ? Math.min(...numeric) : Math.max(...numeric);
}

function parseNumberList(value: string) {
  return value
    .split(/[,\s]+/)
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0);
}

function parseStringList(value: string) {
  return value
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function legacyMode(workflowMode: BenchmarkWorkflowMode, suite: BenchmarkSuite): "quick" | "full" | "autotune" {
  if (workflowMode === "smart_auto" || workflowMode === "exhaustive") {
    return "autotune";
  }
  if (workflowMode === "compare") {
    return "quick";
  }
  return suite === "quick" || suite === "short_chat" ? "quick" : "full";
}

function statusLabel(result: BenchmarkRunResponse | null) {
  if (!result) {
    return "idle";
  }
  if (result.status === "completed") {
    return result.stable ? "stable" : "unstable";
  }
  return result.status ?? "running";
}

function elapsedSeconds(result: BenchmarkRunResponse | null) {
  if (!result) {
    return null;
  }
  const start = new Date(result.started_at).getTime();
  const end = result.finished_at ? new Date(result.finished_at).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }
  return (end - start) / 1000;
}

function terminalFallback(result: BenchmarkRunResponse | null, isRunning: boolean) {
  if (!result) {
    return ["[INIT] choose a model and start a run", "[SCAN] terminal output will stream here"];
  }
  const lines = [
    `[INIT] ${result.workflow_mode ?? result.mode} / ${result.suite ?? "legacy"}`,
    `[SCAN] ${result.current_stage ?? "waiting"}`,
  ];
  for (const stage of result.stages) {
    if (stage.tokens_per_second || stage.ttft_ms || stage.prompt_tokens_per_second) {
      lines.push(
        `[PERF] ${stage.name}: ${formatNumber(stage.tokens_per_second, 2)} tok/s, TTFT ${formatNumber(stage.ttft_ms, 0)} ms, prefill ${formatNumber(stage.prompt_tokens_per_second, 1)} tok/s`
      );
    } else {
      lines.push(`${stage.ok ? "[OK  ]" : "[WARN]"} ${stage.name}${stage.error ? `: ${stage.error}` : ""}`);
    }
  }
  if (isRunning) {
    lines.push("> running...");
  }
  return lines;
}

function eventFallback(result: BenchmarkRunResponse | null) {
  return (result?.events ?? []).map((event) => `[${event.level.toUpperCase().padEnd(5)}] ${event.stage}: ${event.message}`);
}

function candidateMetric(candidate: BenchmarkCandidate | null | undefined, key: keyof BenchmarkCandidate) {
  const value = candidate?.[key];
  return typeof value === "number" ? value : null;
}

function compareRows(history: BenchmarkRunResponse[]) {
  const rows = history.slice(0, 2).map((item) => ({
    id: item.id,
    label: `${item.workflow_mode ?? item.mode}/${item.suite ?? "legacy"}`,
    decode: bestNumber(item.stages.map((stage) => stage.tokens_per_second), "max"),
    ttft: bestNumber(item.stages.map((stage) => stage.ttft_ms), "min"),
    score: item.score_percent ?? null,
  }));
  if (rows.length < 2) {
    return [];
  }
  const [current, previous] = rows;
  return [
    `decode delta: ${formatNumber((current.decode ?? 0) - (previous.decode ?? 0), 2)} tok/s`,
    `TTFT delta: ${formatNumber((current.ttft ?? 0) - (previous.ttft ?? 0), 0)} ms`,
    `score delta: ${formatNumber((current.score ?? 0) - (previous.score ?? 0), 1)}%`,
  ];
}

function ControlLabel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-2 block font-mono text-[12px] lowercase tracking-wide text-milk/58">&gt; {label}:</span>
      {children}
    </label>
  );
}

function MetricBar({ label, value, color }: { label: string; value: number | null; color: string }) {
  const width = Math.max(0, Math.min(value ?? 0, 100));
  return (
    <div className="grid grid-cols-[42px_1fr_42px] items-center gap-2 font-mono text-xs">
      <span className="text-milk/58">{label}</span>
      <span className="h-4 border border-line/70 bg-shell/70">
        <span className={cn("block h-full", color)} style={{ width: `${width}%` }} />
      </span>
      <span className="text-right text-milk/68">{formatNumber(value, 0)}%</span>
    </div>
  );
}

function RailMetric({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="border-b border-line/60 py-3 font-mono">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs uppercase tracking-[0.16em] text-accent/78">{label}</span>
        <span className="text-lg font-bold text-milk">
          {value}
          {unit ? <span className="ml-1 text-xs text-milk/45">{unit}</span> : null}
        </span>
      </div>
    </div>
  );
}

export function BenchmarkDialog({ open, embedded = false, models, onClose }: BenchmarkDialogProps) {
  const activeModels = useMemo(() => models.filter((model) => model.runtime.status === "running"), [models]);
  const defaultModelId = activeModels[0]?.id ?? models[0]?.id ?? "";
  const [modelId, setModelId] = useState(defaultModelId);
  const [workflowMode, setWorkflowMode] = useState<BenchmarkWorkflowMode>("smart_auto");
  const [suite, setSuite] = useState<BenchmarkSuite>("coding");
  const [optimizeFor, setOptimizeFor] = useState<BenchmarkOptimizeFor>("max_toks");
  const [maxTokens, setMaxTokens] = useState(512);
  const [maxTests, setMaxTests] = useState(40);
  const [maxTimeMinutes, setMaxTimeMinutes] = useState(15);
  const [repeatsPerConfig, setRepeatsPerConfig] = useState(3);
  const [warmupRuns, setWarmupRuns] = useState(1);
  const [stopAfter, setStopAfter] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [ctxValues, setCtxValues] = useState("8192 16384 32768");
  const [batchValues, setBatchValues] = useState("512 1024 2048");
  const [ubatchValues, setUbatchValues] = useState("128 256 512");
  const [cacheModes, setCacheModes] = useState("q4_0/q4_0 q8_0/q8_0 f16/f16");
  const [flashModes, setFlashModes] = useState("off on");
  const [threadValues, setThreadValues] = useState("8 12 16");
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applyMessage, setApplyMessage] = useState<string | null>(null);
  const [applySaving, setApplySaving] = useState(false);
  const [result, setResult] = useState<BenchmarkRunResponse | null>(null);
  const [history, setHistory] = useState<BenchmarkRunResponse[]>([]);
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const selectedModel = models.find((model) => model.id === modelId) ?? models[0] ?? null;

  useEffect(() => {
    if (!open) {
      return;
    }
    setModelId((current) => current || defaultModelId);
    try {
      const raw = window.localStorage.getItem(HISTORY_KEY);
      setHistory(raw ? (JSON.parse(raw) as BenchmarkRunResponse[]) : []);
    } catch {
      setHistory([]);
    }
  }, [defaultModelId, open]);

  const persistHistory = (nextResult: BenchmarkRunResponse) => {
    setHistory((current) => {
      const nextHistory = [nextResult, ...current.filter((item) => item.id !== nextResult.id)].slice(0, 16);
      window.localStorage.setItem(HISTORY_KEY, JSON.stringify(nextHistory));
      return nextHistory;
    });
  };

  useEffect(() => {
    if (!result || !selectedModel || !isRunning) {
      return;
    }

    const intervalId = window.setInterval(async () => {
      try {
        const next = await api.getBenchmarkRun(selectedModel.id, result.id);
        setResult(next);
        if (terminalStatuses.has(next.status ?? "")) {
          setIsRunning(false);
          persistHistory(next);
        }
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed to refresh benchmark run");
        setIsRunning(false);
      }
    }, 1500);

    return () => window.clearInterval(intervalId);
  }, [isRunning, result, selectedModel]);

  const visibleResult = result ?? history[0] ?? null;
  const terminalLines = visibleResult?.terminal_lines?.length ? visibleResult.terminal_lines : terminalFallback(visibleResult, isRunning);
  const runLogLines = visibleResult?.run_log_lines?.length ? visibleResult.run_log_lines : eventFallback(visibleResult);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [terminalLines.length]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [runLogLines.length]);

  const run = async () => {
    if (!selectedModel) {
      return;
    }
    setIsRunning(true);
    setError(null);
    try {
      const mode = legacyMode(workflowMode, suite);
      const timeoutSeconds = Math.max(60, Math.min(maxTimeMinutes * 60, 43200));
      const nextResult = await api.startBenchmarkRun(selectedModel.id, {
        mode,
        workflow_mode: workflowMode,
        suite,
        optimize_for: optimizeFor,
        max_tokens: maxTokens,
        timeout_seconds: timeoutSeconds,
        startup_wait_seconds: Math.max(300, Math.min(timeoutSeconds, 3600)),
        repetitions: repeatsPerConfig,
        stop_after: stopAfter,
        autotune_max_configs: maxTests,
        max_tests: maxTests,
        max_time_minutes: maxTimeMinutes,
        repeats_per_config: repeatsPerConfig,
        warmup_runs: warmupRuns,
        ctx_values: parseNumberList(ctxValues),
        batch_values: parseNumberList(batchValues),
        ubatch_values: parseNumberList(ubatchValues),
        cache_type_modes: parseStringList(cacheModes),
        flash_attn_modes: parseStringList(flashModes),
        threads_values: parseNumberList(threadValues),
        threads_batch_values: parseNumberList(threadValues),
        compare_run_ids: workflowMode === "compare" ? history.slice(0, 6).map((item) => item.id) : [],
      });
      setResult(nextResult);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Benchmark failed");
      setIsRunning(false);
    }
  };

  const cancel = async () => {
    if (!selectedModel || !result || terminalStatuses.has(result.status ?? "")) {
      return;
    }
    const next = await api.cancelBenchmarkRun(selectedModel.id, result.id);
    setResult(next);
    setIsRunning(false);
  };

  const saveRecommendedProfile = async () => {
    if (!selectedModel || !visibleResult) {
      return;
    }
    setApplySaving(true);
    setApplyMessage(null);
    try {
      const profile = await api.applyBenchmarkProfile(selectedModel.id, {
        name: `Benchmark ${visibleResult.suite ?? visibleResult.mode} ${new Date().toLocaleDateString()}`,
        launch_params: visibleResult.launch_params ?? {},
        final_recommended_launch: visibleResult.final_recommended_launch ?? null,
        activate: true,
      });
      setApplyMessage(`Saved and activated profile: ${profile.name}`);
    } catch (nextError) {
      setApplyMessage(nextError instanceof Error ? nextError.message : "Could not save benchmark profile");
    } finally {
      setApplySaving(false);
    }
  };

  if (!open) {
    return null;
  }

  const liveMetrics = visibleResult?.metrics_current ?? visibleResult?.metrics_after ?? visibleResult?.metrics_before;
  const progress = Math.round(visibleResult?.progress_percent ?? 0);
  const bestDecode = bestNumber(visibleResult?.stages.map((stage) => stage.tokens_per_second) ?? [], "max");
  const bestPrefill = bestNumber(visibleResult?.stages.map((stage) => stage.prompt_tokens_per_second) ?? [], "max");
  const bestTtft = bestNumber(visibleResult?.stages.map((stage) => stage.ttft_ms) ?? [], "min");
  const totalTokens = visibleResult?.stages.reduce((sum, stage) => sum + (stage.generated_tokens_estimate ?? 0), 0) ?? 0;
  const bestCandidate = visibleResult?.leaderboard?.[0] ?? null;
  const shellClass = embedded
    ? "min-h-0 w-full flex-1 overflow-hidden text-milk"
    : "fixed inset-0 z-50 bg-shell p-4 text-milk";
  const disabled = isRunning;
  const inputClass =
    "quokka-input h-11 w-full px-3 font-mono text-sm outline-none transition disabled:cursor-not-allowed disabled:opacity-55";
  const compactInputClass =
    "quokka-input h-10 px-3 font-mono text-sm outline-none disabled:cursor-not-allowed disabled:opacity-55";
  const comparePreview = compareRows(history);

  return (
    <div className={shellClass}>
      <div className="flex h-full min-h-0 flex-col bg-transparent">
        <header className="quokka-panel flex h-[66px] shrink-0 items-center justify-between rounded-[var(--radius-control)] px-5">
          <div className="flex items-center gap-3">
            <Terminal className="h-5 w-5 text-live" />
            <div>
              <h2 className="font-mono text-[20px] font-bold uppercase tracking-[0.12em] text-milk">LLM Tests Terminal</h2>
              <p className="font-mono text-xs text-milk/45">optimization lab / polling mode / artifacts written on finish</p>
            </div>
          </div>
          {!embedded ? (
            <Button variant="ghost" size="icon" onClick={onClose}>
              <XCircle className="h-5 w-5" />
            </Button>
          ) : null}
        </header>

        <div className="mt-3 grid min-h-0 flex-1 grid-cols-[330px_minmax(0,1fr)_260px] gap-3 overflow-hidden">
          <aside className="quokka-surface flex min-h-0 flex-col overflow-hidden rounded-[var(--radius-control)]">
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
              <div className="space-y-6">
                <ControlLabel label="model">
                  <select className={inputClass} value={modelId} onChange={(event) => setModelId(event.target.value)} disabled={disabled}>
                    {models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {modelLabel(model)}
                      </option>
                    ))}
                  </select>
                </ControlLabel>

                <ControlLabel label="mode">
                  <div className="relative">
                    <select
                      className={cn(inputClass, "appearance-none pr-10")}
                      value={workflowMode}
                      onChange={(event) => setWorkflowMode(event.target.value as BenchmarkWorkflowMode)}
                      disabled={disabled}
                    >
                      {workflowOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-3 top-3.5 h-4 w-4 text-milk/55" />
                  </div>
                  <p className="mt-2 font-mono text-xs leading-5 text-milk/40">
                    {workflowOptions.find((option) => option.value === workflowMode)?.hint}
                  </p>
                </ControlLabel>

                <ControlLabel label="optimize for">
                  <select className={inputClass} value={optimizeFor} onChange={(event) => setOptimizeFor(event.target.value as BenchmarkOptimizeFor)} disabled={disabled}>
                    {optimizeOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </ControlLabel>

                <ControlLabel label="test suite">
                  <select className={inputClass} value={suite} onChange={(event) => setSuite(event.target.value as BenchmarkSuite)} disabled={disabled}>
                    {suiteOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </ControlLabel>

                <div>
                  <p className="mb-3 font-mono text-[12px] lowercase tracking-wide text-milk/58">&gt; constraints:</p>
                  <div className="space-y-3 font-mono text-sm">
                    <label className="flex items-center gap-3">
                      <span className="w-24 text-milk/58">max tests:</span>
                      <input className={cn(compactInputClass, "w-24")} type="number" min={1} max={240} value={maxTests} disabled={disabled} onChange={(event) => setMaxTests(Number(event.target.value))} />
                    </label>
                    <label className="flex items-center gap-3">
                      <span className="w-24 text-milk/58">max time:</span>
                      <input className={cn(compactInputClass, "w-24")} type="number" min={1} max={720} value={maxTimeMinutes} disabled={disabled} onChange={(event) => setMaxTimeMinutes(Number(event.target.value))} />
                      <span className="text-milk/58">min</span>
                    </label>
                    <label className="flex items-center gap-3">
                      <span className="w-24 text-milk/58">repeats:</span>
                      <input className={cn(compactInputClass, "w-24")} type="number" min={1} max={20} value={repeatsPerConfig} disabled={disabled} onChange={(event) => setRepeatsPerConfig(Number(event.target.value))} />
                    </label>
                    <label className="flex items-center gap-3">
                      <span className="w-24 text-milk/58">warmup:</span>
                      <input className={cn(compactInputClass, "w-24")} type="number" min={0} max={10} value={warmupRuns} disabled={disabled} onChange={(event) => setWarmupRuns(Number(event.target.value))} />
                    </label>
                    <label className="flex items-center gap-3">
                      <span className="w-24 text-milk/58">tokens:</span>
                      <input className={cn(compactInputClass, "w-24")} type="number" min={16} max={4096} value={maxTokens} disabled={disabled} onChange={(event) => setMaxTokens(Number(event.target.value))} />
                    </label>
                  </div>
                </div>

                <button
                  type="button"
                  className="flex items-center gap-2 font-mono text-sm text-milk/58 hover:text-milk"
                  onClick={() => setAdvancedOpen((current) => !current)}
                  disabled={disabled}
                >
                  <span>&gt; advanced</span>
                  <ChevronDown className={cn("h-4 w-4 transition", advancedOpen && "rotate-180")} />
                </button>

                {advancedOpen ? (
                  <div className="quokka-panel space-y-3 rounded-[var(--radius-control)] p-3 font-mono text-xs">
                    <label className="block">
                      <span className="mb-1 block text-milk/48">ctx range</span>
                      <input className={inputClass} value={ctxValues} disabled={disabled} onChange={(event) => setCtxValues(event.target.value)} />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-milk/48">batch range</span>
                      <input className={inputClass} value={batchValues} disabled={disabled} onChange={(event) => setBatchValues(event.target.value)} />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-milk/48">ubatch range</span>
                      <input className={inputClass} value={ubatchValues} disabled={disabled} onChange={(event) => setUbatchValues(event.target.value)} />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-milk/48">kv modes</span>
                      <input className={inputClass} value={cacheModes} disabled={disabled} onChange={(event) => setCacheModes(event.target.value)} />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-milk/48">flash-attn modes</span>
                      <input className={inputClass} value={flashModes} disabled={disabled} onChange={(event) => setFlashModes(event.target.value)} />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-milk/48">threads</span>
                      <input className={inputClass} value={threadValues} disabled={disabled} onChange={(event) => setThreadValues(event.target.value)} />
                    </label>
                  </div>
                ) : null}

                <label className="quokka-panel flex items-start gap-3 rounded-[var(--radius-control)] p-3 font-mono text-sm text-milk/68">
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 border-line bg-shell"
                    checked={stopAfter}
                    onChange={(event) => setStopAfter(event.target.checked)}
                    disabled={disabled}
                  />
                  <span>
                    stop model after test
                    <span className="block text-xs text-milk/40">release VRAM/RAM after the report</span>
                  </span>
                </label>

                {error ? <p className="border border-danger/45 bg-danger/10 px-3 py-2 font-mono text-sm text-danger">{error}</p> : null}
              </div>
            </div>

            <div className="border-t border-line/60 p-4">
              {isRunning ? (
                <Button className="h-14 w-full justify-center rounded-[var(--radius-control)] font-mono" variant="danger" onClick={() => void cancel()}>
                  <Square className="h-4 w-4" />
                  &gt; stop
                </Button>
              ) : (
                <Button className="h-14 w-full justify-center rounded-[var(--radius-control)] font-mono" variant="primary" disabled={!selectedModel} onClick={() => void run()}>
                  <Play className="h-4 w-4" />
                  &gt; run tests
                </Button>
              )}
            </div>

            <div className="max-h-56 overflow-y-auto border-t border-line/60 px-4 py-3">
              <div className="mb-2 flex items-center gap-2 font-mono text-xs uppercase tracking-[0.16em] text-accent/78">
                <History className="h-3.5 w-3.5" />
                history / compare
              </div>
              <div className="space-y-2">
                {history.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setResult(item)}
                    className={cn(
                      "w-full border border-line/65 bg-panel/50 px-3 py-2 text-left font-mono text-xs hover:border-accent/55",
                      visibleResult?.id === item.id && "border-accent/65 bg-panel-2/55"
                    )}
                  >
                    <span className="block truncate text-milk">{item.model_name}</span>
                    <span className="mt-1 block text-milk/45">
                      {item.workflow_mode ?? item.mode} / {item.finished_at ? formatTimestamp(item.finished_at) : item.status}
                    </span>
                  </button>
                ))}
                {!history.length ? <p className="font-mono text-xs text-milk/38">No reports yet.</p> : null}
              </div>
            </div>
          </aside>

          <main className="quokka-terminal grid min-h-0 grid-rows-[minmax(0,1fr)_230px] overflow-hidden rounded-[var(--radius-control)] border border-line/60">
            <section className="min-h-0 border-b border-line/60">
              <div className="flex h-12 items-center justify-between border-b border-line/60 px-5 font-mono">
                <div className="flex items-center gap-3 text-sm">
                  <Activity className={cn("h-4 w-4", isRunning ? "animate-pulse text-live" : "text-milk/45")} />
                  <span className="uppercase tracking-[0.16em] text-live/80">live terminal</span>
                  <span className="text-milk/45">{statusLabel(visibleResult)}</span>
                </div>
                <div className="flex items-center gap-4 text-xs text-milk/45">
                  <span>{progress}%</span>
                  <span>{visibleResult?.id ?? "no-run"}</span>
                </div>
              </div>

              <div ref={terminalRef} className="h-[calc(100%-3rem)] overflow-y-auto px-5 py-4 font-mono text-[15px] leading-7">
                {terminalLines.map((line, index) => (
                  <div
                    key={`${line}-${index}`}
                    className={cn(
                      "whitespace-pre-wrap",
                      line.startsWith("[PERF]") && "text-success",
                      line.startsWith("[OK") && "text-live",
                      line.startsWith("[WAIT") && "text-milk/50",
                      line.startsWith("[WARN") && "text-warning",
                      line.startsWith("[ERR") && "text-danger",
                      line.startsWith("[BEST]") && "text-live",
                      line.startsWith("[STEP") && "mt-2 font-bold text-milk",
                      line.startsWith("  ") && "pl-5 text-milk/68",
                      line.startsWith(">") && "text-milk"
                    )}
                  >
                    {line}
                  </div>
                ))}

                {workflowMode === "compare" && comparePreview.length ? (
                  <div className="mt-6 border-l-2 border-live/70 pl-4 text-live">
                    {comparePreview.map((line) => (
                      <div key={line}>{line}</div>
                    ))}
                  </div>
                ) : null}

                {visibleResult?.candidate_groups?.length ? (
                  <div className="mt-6 grid gap-3">
                    {visibleResult.candidate_groups.map((group) => (
                      <div key={group.id} className="rounded-[var(--radius-control)] border border-line/60 bg-surface/58 p-3">
                        <div className="mb-2 flex items-center justify-between text-xs uppercase tracking-[0.16em] text-accent/78">
                          <span>{group.title}</span>
                          <span>{group.selected ? `${group.selected} <- selected` : "scanning"}</span>
                        </div>
                        <div className="grid gap-1 text-xs">
                          {group.candidates.slice(-5).map((candidate, index) => (
                            <div key={`${group.id}-${candidate.label}-${index}`} className={cn("grid grid-cols-[minmax(0,1fr)_90px_90px_70px] gap-3", candidate.selected && "text-accent")}>
                              <span className="truncate">{candidate.label ?? "candidate"}</span>
                              <span className="text-right">{formatNumber(candidateMetric(candidate, "decode_tokens_per_second"), 2)} tok/s</span>
                              <span className="text-right">{formatNumber(candidateMetric(candidate, "ttft_ms"), 0)} ms</span>
                              <span className={cn("text-right", candidate.probe_ok === true && "text-success", candidate.probe_ok === false && "text-danger")}>
                                {typeof candidate.probe_ok === "boolean" ? (candidate.probe_ok ? "ok" : "fail") : "saved"}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </section>

            <section className="min-h-0 bg-surface/54">
              <div className="flex h-10 items-center justify-between border-b border-line/60 px-5 font-mono text-xs uppercase tracking-[0.16em] text-accent/78">
                <span>run log</span>
                <span>{runLogLines.length} lines</span>
              </div>
              <div ref={logRef} className="h-[calc(100%-2.5rem)] overflow-y-auto px-5 py-3 font-mono text-xs leading-6 text-success">
                {runLogLines.map((line, index) => (
                  <div
                    key={`${line}-${index}`}
                    className={cn(
                      "whitespace-pre-wrap",
                      line.startsWith("[WARN") && "text-warning",
                      line.startsWith("[ERROR") && "text-danger",
                      line.startsWith("[INFO") && "text-live"
                    )}
                  >
                    {line}
                  </div>
                ))}
                {!runLogLines.length ? <div className="text-milk/38">[INFO ] waiting for benchmark events...</div> : null}
              </div>
            </section>
          </main>

          <aside className="quokka-surface min-h-0 overflow-y-auto rounded-[var(--radius-control)] px-5 py-5">
            <div className="mb-4 flex items-center gap-2 font-mono text-xs uppercase tracking-[0.16em] text-accent/78">
              <Gauge className="h-4 w-4" />
              metrics rail
            </div>

            <RailMetric label="tokens/sec" value={formatNumber(bestDecode ?? candidateMetric(bestCandidate, "decode_tokens_per_second"), 2)} />
            <RailMetric label="first token" value={formatNumber(bestTtft ?? candidateMetric(bestCandidate, "ttft_ms"), 0)} unit="ms" />
            <RailMetric label="total time" value={elapsedSeconds(visibleResult) ? formatNumber(elapsedSeconds(visibleResult), 1) : "--"} unit="s" />
            <RailMetric label="tokens" value={totalTokens ? String(totalTokens) : "--"} />
            <RailMetric label="prefill" value={formatNumber(bestPrefill ?? candidateMetric(bestCandidate, "prefill_tokens_per_second"), 1)} unit="tok/s" />

            <div className="mt-5 border-b border-line/60 pb-5">
              <p className="mb-3 font-mono text-xs text-milk/58">tok/s</p>
              <div className="flex h-8 items-end gap-1">
                {(visibleResult?.stages ?? []).slice(-18).map((stage, index) => {
                  const height = Math.max(4, Math.min(32, ((stage.tokens_per_second ?? 0) / Math.max(bestDecode ?? 1, 1)) * 32));
                  return <span key={`${stage.name}-${index}`} className="w-2 bg-accent/75" style={{ height }} title={`${stage.name}: ${formatNumber(stage.tokens_per_second, 2)} tok/s`} />;
                })}
                {!visibleResult?.stages.length ? <span className="font-mono text-xs text-milk/38">no samples</span> : null}
              </div>
            </div>

            <div className="mt-5 space-y-3">
              <MetricBar label="GPU" value={metricValue(liveMetrics, "gpu_usage_percent")} color="bg-live/75" />
              <MetricBar label="CPU" value={metricValue(liveMetrics, "cpu_usage_percent")} color="bg-warning/75" />
              <MetricBar label="RAM" value={metricValue(liveMetrics, "ram_usage_percent")} color="bg-success/75" />
            </div>

            <div className="quokka-panel mt-6 rounded-[var(--radius-control)] p-3 font-mono text-xs">
              <div className="mb-2 flex items-center gap-2 uppercase tracking-[0.16em] text-accent/78">
                <BarChart3 className="h-3.5 w-3.5" />
                leaderboard
              </div>
              <div className="space-y-2">
                {(visibleResult?.leaderboard ?? []).slice(0, 6).map((item, index) => (
                  <div key={`${item.id ?? item.label}-${index}`} className={cn("grid grid-cols-[24px_1fr_64px] gap-2", item.selected && "text-accent")}>
                    <span>{item.rank ? `#${item.rank}` : `#${index + 1}`}</span>
                    <span className="truncate">{String(item.label ?? item.group ?? "candidate")}</span>
                    <span className="text-right">{formatNumber(candidateMetric(item, "decode_tokens_per_second"), 1)}</span>
                  </div>
                ))}
                {!visibleResult?.leaderboard?.length ? <p className="text-milk/38">waiting for candidates</p> : null}
              </div>
            </div>

            <div className="quokka-panel mt-6 rounded-[var(--radius-control)] p-3 font-mono text-xs">
              <div className="mb-2 flex items-center gap-2 uppercase tracking-[0.16em] text-accent/78">
                <Zap className="h-3.5 w-3.5" />
                artifacts
              </div>
              <div className="space-y-2 text-milk/58">
                {Object.entries(visibleResult?.artifacts ?? {}).map(([key, value]) => (
                  <div key={key}>
                    <span className="text-milk">{key}</span>
                    <span className="mt-1 block break-all">{String(value ?? "--")}</span>
                  </div>
                ))}
                {!Object.keys(visibleResult?.artifacts ?? {}).length ? <p className="text-milk/38">written after completion</p> : null}
              </div>
            </div>

            {applyMessage ? (
              <div className="mt-4 rounded-[var(--radius-control)] border border-accent/35 bg-accent/10 px-3 py-2 font-mono text-xs text-milk/70">
                {applyMessage}
              </div>
            ) : null}

            <div className="mt-4 grid gap-2">
              <Button
                className="rounded-[var(--radius-control)] font-mono"
                variant="primary"
                size="sm"
                disabled={!visibleResult || applySaving || !Object.keys(visibleResult.launch_params ?? {}).length}
                onClick={() => void saveRecommendedProfile()}
              >
                <Zap className="h-4 w-4" />
                {applySaving ? "Saving" : "Save Profile"}
              </Button>
              <Button
                className="rounded-[var(--radius-control)] font-mono"
                variant="secondary"
                size="sm"
                disabled={!visibleResult}
                onClick={() => visibleResult && void navigator.clipboard.writeText(JSON.stringify(visibleResult, null, 2))}
              >
                <Copy className="h-4 w-4" />
                Copy JSON
              </Button>
              <Button
                className="rounded-[var(--radius-control)] font-mono"
                variant="secondary"
                size="sm"
                disabled={!visibleResult}
                onClick={() => visibleResult && downloadText(`${visibleResult.id}.json`, JSON.stringify(visibleResult, null, 2), "application/json")}
              >
                <Download className="h-4 w-4" />
                JSON
              </Button>
              <Button
                className="rounded-[var(--radius-control)] font-mono"
                variant="secondary"
                size="sm"
                disabled={!visibleResult}
                onClick={() => visibleResult && downloadText(`${visibleResult.id}.csv`, resultToCsv(visibleResult), "text/csv")}
              >
                <Download className="h-4 w-4" />
                CSV
              </Button>
              <Button
                className="rounded-[var(--radius-control)] font-mono"
                variant="secondary"
                size="sm"
                disabled={!visibleResult?.final_recommended_launch}
                onClick={() => visibleResult?.final_recommended_launch && void navigator.clipboard.writeText(visibleResult.final_recommended_launch)}
              >
                <Copy className="h-4 w-4" />
                Launch
              </Button>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
