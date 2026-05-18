import { useState } from "react";
import { AlertTriangle, CheckCircle2, DownloadCloud, FileSearch, FlaskConical, MessageSquare, Play, Radar, X } from "lucide-react";

import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import type { AutopilotActionLogEntry, AutopilotReadinessResponse, AutopilotStarterPlanResponse } from "@/types/api";

type AutopilotStep = "scan" | "recommend" | "download" | "add" | "launch" | "test" | "chat";

const steps = [
  { id: "scan", label: "Scan PC" },
  { id: "recommend", label: "Pick model" },
  { id: "download", label: "Download GGUF" },
  { id: "add", label: "Add model" },
  { id: "launch", label: "Launch" },
  { id: "test", label: "Smoke test" },
  { id: "chat", label: "Open chat" },
] as const;

interface FirstRunWizardProps {
  modelCount: number;
  onAddModel: () => void;
  onOpenLibrary: () => void;
  onOpenTests: () => void;
  onOpenChat: () => void;
  onDismiss: () => void;
  onRefreshModels: () => Promise<void>;
}

const statusTone: Record<string, string> = {
  pass: "border-success/35 bg-success/10 text-success",
  warn: "border-accent/35 bg-accent/10 text-accent",
  fail: "border-danger/35 bg-danger/10 text-danger",
  info: "border-live/35 bg-live/10 text-live",
};

const stepIcon: Record<AutopilotStep, typeof Radar> = {
  scan: Radar,
  recommend: CheckCircle2,
  download: DownloadCloud,
  add: FileSearch,
  launch: Play,
  test: FlaskConical,
  chat: MessageSquare,
};

function formatActionTime(timestamp: string) {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString();
}

export function FirstRunWizard({
  modelCount,
  onAddModel,
  onOpenLibrary,
  onOpenTests,
  onOpenChat,
  onDismiss,
  onRefreshModels,
}: FirstRunWizardProps) {
  const [activeStep, setActiveStep] = useState<AutopilotStep>("scan");
  const [readiness, setReadiness] = useState<AutopilotReadinessResponse | null>(null);
  const [plan, setPlan] = useState<AutopilotStarterPlanResponse | null>(null);
  const [actions, setActions] = useState<AutopilotActionLogEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activeIndex = steps.findIndex((step) => step.id === activeStep);
  const ActiveIcon = stepIcon[activeStep];

  const scan = async () => {
    setRunning(true);
    setError(null);
    try {
      const nextReadiness = await api.getAutopilotReadiness();
      const nextPlan = await api.createAutopilotStarterPlan({
        use_case: "chat",
        runtime: nextReadiness.recommended_runtime,
      });
      const nextActions = await api.getAutopilotActions();
      setReadiness(nextReadiness);
      setPlan(nextPlan);
      setActions(nextActions.slice(0, 8));
      setActiveStep("recommend");
      setMessage(nextReadiness.summary);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Autopilot scan failed");
    } finally {
      setRunning(false);
    }
  };

  const logAction = async (
    summary: string,
    details: string[],
    status: "planned" | "running" | "completed" | "failed" = "completed",
  ) => {
    const entry = await api.appendAutopilotAction({
      action: activeStep,
      status,
      summary,
      details,
      undo_hint: "Open Health Doctor to inspect or reverse runtime/path changes.",
      confidence: "medium",
    });
    setActions((current) => [entry, ...current].slice(0, 8));
  };

  const handleOpenRecommendedDownload = async () => {
    setRunning(true);
    setError(null);
    try {
      await logAction("Opened starter model recommendation.", [
        plan ? `Recommended ${plan.name} (${plan.filename}).` : "Opened Model Library for starter model selection.",
        readiness ? `Readiness score was ${readiness.score_percent}%.` : "Readiness score was not available.",
      ]);
      setActiveStep("download");
      onOpenLibrary();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not record the Autopilot action");
    } finally {
      setRunning(false);
    }
  };

  const handleRefreshModels = async () => {
    setRunning(true);
    setError(null);
    try {
      await onRefreshModels();
      setMessage("Model status refreshed. If the model is running, continue to LLM Tests.");
      setActiveStep(modelCount > 0 ? "test" : "launch");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not refresh model status");
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="quokka-soft-panel mb-3 rounded-[var(--radius-soft)] px-5 py-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent">First run Autopilot</p>
          <h2 className="mt-2 text-xl font-semibold text-milk">Set up your first local model</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-milk/55">
            Quokka guides the setup, records each trust step, and keeps download, add, launch, test, and chat actions under your control.
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="quokka-control grid h-9 w-9 shrink-0 place-items-center text-milk/55 hover:text-milk"
          title="Dismiss first run wizard"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-4 grid gap-2 md:grid-cols-7">
        {steps.map((step, index) => {
          const isActive = step.id === activeStep;
          const isComplete = index < activeIndex;
          return (
            <button
              key={step.id}
              type="button"
              onClick={() => setActiveStep(step.id)}
              className={`rounded-[var(--radius-control)] border px-3 py-2 text-left text-xs font-semibold transition ${
                isActive
                  ? "border-accent bg-accent/15 text-accent"
                  : isComplete
                    ? "border-success/30 bg-success/10 text-success"
                    : "border-line/70 bg-shell/45 text-milk/46 hover:border-accent/45 hover:text-milk/70"
              }`}
            >
              <span className="block text-[10px] uppercase tracking-[0.18em]">{String(index + 1).padStart(2, "0")}</span>
              {step.label}
            </button>
          );
        })}
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
        <div className="rounded-[var(--radius-soft)] border border-line/70 bg-shell/45 p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-accent">Local AI readiness</p>
              <p className="mt-2 text-4xl font-semibold text-milk">{readiness?.score_percent ?? "--"}%</p>
            </div>
            <div className="rounded-[var(--radius-control)] border border-accent/25 bg-accent/10 p-3 text-accent">
              <ActiveIcon className="h-5 w-5" />
            </div>
          </div>
          <p className="mt-2 text-sm leading-6 text-milk/52">{readiness?.summary ?? "Scan this PC to get a local AI readiness score."}</p>
          <div className="mt-4 grid gap-2 text-sm text-milk/55 sm:grid-cols-3">
            <div className="rounded-[var(--radius-control)] border border-line/60 bg-black/10 p-3">
              <p className="text-[10px] uppercase tracking-[0.2em] text-milk/38">Hardware</p>
              <p className="mt-1 font-semibold text-milk/78">{readiness?.hardware_class ?? "Unknown"}</p>
            </div>
            <div className="rounded-[var(--radius-control)] border border-line/60 bg-black/10 p-3">
              <p className="text-[10px] uppercase tracking-[0.2em] text-milk/38">Runtime</p>
              <p className="mt-1 font-semibold text-milk/78">{readiness?.recommended_runtime ?? "Pending scan"}</p>
            </div>
            <div className="rounded-[var(--radius-control)] border border-line/60 bg-black/10 p-3">
              <p className="text-[10px] uppercase tracking-[0.2em] text-milk/38">Profile</p>
              <p className="mt-1 font-semibold text-milk/78">{readiness?.recommended_profile ?? "Pending scan"}</p>
            </div>
          </div>
          {readiness?.bottlenecks.length ? (
            <div className="mt-3 rounded-[var(--radius-control)] border border-accent/25 bg-accent/10 p-3">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">Bottlenecks</p>
              <ul className="mt-2 space-y-1 text-sm text-milk/58">
                {readiness.bottlenecks.map((bottleneck) => (
                  <li key={bottleneck}>{bottleneck}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        <div className="rounded-[var(--radius-soft)] border border-line/70 bg-shell/45 p-4">
          <p className="text-xs uppercase tracking-[0.24em] text-accent">Guided next step</p>
          <h3 className="mt-2 text-lg font-semibold text-milk">{steps[activeIndex]?.label ?? "Scan PC"}</h3>
          <p className="mt-2 text-sm leading-6 text-milk/52">
            {message ?? "Start with a scan. Quokka will recommend a starter model, then keep each next action visible and reversible."}
          </p>

          {error ? (
            <div className="mt-3 flex items-start gap-2 rounded-[var(--radius-control)] border border-danger/30 bg-danger/10 p-3 text-sm text-danger">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}

          {plan ? (
            <div className="mt-4 rounded-[var(--radius-control)] border border-accent/25 bg-accent/10 p-3">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">Starter recommendation</p>
              <p className="mt-2 font-semibold text-milk">{plan.name}</p>
              <p className="mt-1 text-sm text-milk/58">{plan.filename}</p>
              <p className="mt-2 text-sm leading-5 text-milk/52">{plan.why}</p>
              <p className="mt-2 text-xs uppercase tracking-[0.18em] text-milk/42">Quantization: {plan.quantization ?? "Unknown"}</p>
            </div>
          ) : null}

          <div className="mt-4 flex flex-wrap gap-2">
            {activeStep === "scan" ? (
              <Button type="button" variant="primary" disabled={running} onClick={() => void scan()}>
                Scan this PC
              </Button>
            ) : null}
            {activeStep === "recommend" ? (
              <Button type="button" variant="primary" disabled={running} onClick={() => void handleOpenRecommendedDownload()}>
                Open recommended download
              </Button>
            ) : null}
            {activeStep === "download" ? (
              <Button type="button" variant="primary" onClick={onOpenLibrary}>
                Continue in Model Library
              </Button>
            ) : null}
            {activeStep === "add" ? (
              <Button
                type="button"
                variant="primary"
                onClick={() => {
                  setActiveStep("launch");
                  onAddModel();
                }}
              >
                Add downloaded GGUF
              </Button>
            ) : null}
            {activeStep === "launch" ? (
              <Button type="button" variant="primary" disabled={running} onClick={() => void handleRefreshModels()}>
                Refresh model status
              </Button>
            ) : null}
            {activeStep === "test" ? (
              <Button type="button" variant="primary" onClick={onOpenTests}>
                Run LLM Tests
              </Button>
            ) : null}
            {activeStep === "chat" ? (
              <Button type="button" variant="primary" onClick={onOpenChat}>
                Open Chat
              </Button>
            ) : null}
            <Button type="button" variant="secondary" onClick={() => setActiveStep(steps[Math.min(activeIndex + 1, steps.length - 1)].id)}>
              Mark step done
            </Button>
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <div className="rounded-[var(--radius-soft)] border border-line/70 bg-shell/35 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent">Readiness checks</p>
          <div className="mt-3 space-y-2">
            {readiness?.items.length ? (
              readiness.items.map((item) => (
                <div key={item.id} className="rounded-[var(--radius-control)] border border-line/60 bg-black/10 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-semibold text-milk">{item.label}</p>
                    <span className={`rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${statusTone[item.status] ?? statusTone.info}`}>
                      {item.status}
                    </span>
                  </div>
                  <p className="mt-2 text-sm leading-5 text-milk/52">{item.detail}</p>
                  {item.fix_action ? <p className="mt-2 text-xs text-accent/80">Suggested fix: {item.fix_action}</p> : null}
                </div>
              ))
            ) : (
              <p className="rounded-[var(--radius-control)] border border-line/60 bg-black/10 p-3 text-sm text-milk/46">
                No readiness checks yet. Run the scan to see runtime, hardware, and path guidance.
              </p>
            )}
          </div>
        </div>

        <div className="rounded-[var(--radius-soft)] border border-line/70 bg-shell/35 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent">Autopilot action log</p>
          <div className="mt-3 space-y-2">
            {actions.length ? (
              actions.map((entry) => (
                <div key={entry.id} className="rounded-[var(--radius-control)] border border-line/60 bg-black/10 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-semibold text-milk">{entry.summary}</p>
                    <span className={`rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${statusTone[entry.status === "failed" ? "fail" : entry.status === "completed" ? "pass" : "info"]}`}>
                      {entry.status}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-milk/38">
                    {formatActionTime(entry.timestamp)} · confidence: {entry.confidence}
                  </p>
                  {entry.details.length ? (
                    <ul className="mt-2 space-y-1 text-sm text-milk/52">
                      {entry.details.map((detail) => (
                        <li key={detail}>{detail}</li>
                      ))}
                    </ul>
                  ) : null}
                  {entry.undo_hint ? <p className="mt-2 text-xs text-milk/42">Undo: {entry.undo_hint}</p> : null}
                </div>
              ))
            ) : (
              <p className="rounded-[var(--radius-control)] border border-line/60 bg-black/10 p-3 text-sm text-milk/46">
                No actions logged yet. Quokka will record guided Autopilot steps here so setup stays inspectable.
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
