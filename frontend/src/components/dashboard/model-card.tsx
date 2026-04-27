import { motion } from "framer-motion";
import { Activity, Cpu, Power, RefreshCcw, Square } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn, formatTimestamp } from "@/lib/utils";
import type { ModelStatus, ModelView } from "@/types/api";

const statusTone: Record<ModelStatus, "neutral" | "success" | "warning" | "danger" | "accent"> = {
  stopped: "neutral",
  starting: "accent",
  running: "success",
  warming: "accent",
  stopping: "warning",
  unhealthy: "warning",
  crashed: "danger",
  error: "danger",
};

const statusRail: Record<ModelStatus, string> = {
  stopped: "bg-milk/18",
  starting: "bg-accent shadow-[0_0_24px_rgba(176,139,102,0.5)]",
  running: "bg-success shadow-[0_0_24px_rgba(140,165,107,0.45)]",
  warming: "bg-accent shadow-[0_0_24px_rgba(176,139,102,0.5)]",
  stopping: "bg-warning shadow-[0_0_24px_rgba(208,165,106,0.45)]",
  unhealthy: "bg-warning shadow-[0_0_24px_rgba(208,165,106,0.45)]",
  crashed: "bg-danger shadow-[0_0_24px_rgba(198,122,101,0.5)]",
  error: "bg-danger shadow-[0_0_24px_rgba(198,122,101,0.5)]",
};

interface ModelCardProps {
  model: ModelView;
  selected: boolean;
  busy: boolean;
  onSelect: (modelId: string) => void;
  onAction: (modelId: string, action: "start" | "stop" | "restart") => void;
  onToggleAutoRestart: (modelId: string, enabled: boolean) => void;
}

export function ModelCard({ model, selected, busy, onSelect, onAction, onToggleAutoRestart }: ModelCardProps) {
  const activeProfile = model.active_profile;

  return (
    <motion.div layout initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
      <Card
        className={cn(
          "relative min-h-[280px] cursor-pointer overflow-hidden px-6 py-5 transition-all duration-300",
          selected ? "border-accent/50 bg-white/[0.07] shadow-[0_0_0_1px_rgba(176,139,102,0.18),0_28px_70px_rgba(0,0,0,0.45)]" : "bg-white/[0.025] hover:-translate-y-0.5 hover:border-accent/25 hover:bg-white/[0.045]"
        )}
        onClick={() => onSelect(model.id)}
        title="Select this model to inspect launch parameters, logs, profiles, settings, and hardware attribution."
      >
        <div className={cn("absolute inset-y-4 left-0 w-[4px] rounded-r-full", statusRail[model.runtime.status])} />
        <div className="flex h-full flex-col gap-5">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-lg font-semibold text-milk">{model.name}</h3>
                <Badge variant={statusTone[model.runtime.status]}>{model.runtime.status}</Badge>
              </div>
              <p className="text-sm leading-6 text-milk/55">{model.description}</p>
            </div>
            <div className="rounded-lg border border-line/70 bg-white/[0.04] p-2.5 text-accent">
              <Cpu className="h-4 w-4" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-x-5 gap-y-3 text-sm text-milk/62">
            <div>
              <p className="text-[11px] uppercase tracking-[0.18em] text-milk/35" title="Provider tells Quokka how this model is launched or monitored.">Provider</p>
              <p className="mt-1">{model.provider.replace(/_/g, " ")}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-[0.18em] text-milk/35" title="HTTP endpoint used for health checks and chat requests.">Endpoint</p>
              <p className="mt-1 truncate">{model.endpoint}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-[0.18em] text-milk/35" title="Active launch profile: context size, batch settings, sampling, cache settings, and extra llama.cpp args.">Profile</p>
              <p className="mt-1">{activeProfile?.name ?? "None"}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-[0.18em] text-milk/35" title="Last time Quokka checked whether the endpoint was reachable.">Heartbeat</p>
              <p className="mt-1">{formatTimestamp(model.runtime.last_health_check)}</p>
            </div>
          </div>

          <div className="mt-auto flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2 text-xs text-milk/45">
              <Activity className="h-3.5 w-3.5" />
              <span className="truncate">{model.runtime.health_ok ? "Healthy" : model.runtime.last_transition_reason ?? "Awaiting health"}</span>
            </div>
            <div className="flex items-center gap-2" onClick={(event) => event.stopPropagation()}>
              <Button
                size="icon"
                variant="secondary"
                disabled={busy}
                onClick={() => onAction(model.id, "start")}
                title="Start this model using the active profile and write stdout/stderr into its log file."
              >
                <Power className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="secondary"
                disabled={busy}
                onClick={() => onAction(model.id, "stop")}
                title="Stop this model. Managed llama.cpp processes are terminated as a process tree; external endpoints may use the configured stop command."
              >
                <Square className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="secondary"
                disabled={busy}
                onClick={() => onAction(model.id, "restart")}
                title="Restart this model with the current active launch profile."
              >
                <RefreshCcw className="h-4 w-4" />
              </Button>
              <label
                className="flex h-10 items-center gap-2 rounded-lg border border-line bg-white/[0.04] px-3 text-xs text-milk/55"
                title="If enabled, Quokka will restart this model after an unexpected crash. Logs are appended, not cleared."
              >
                <input
                  type="checkbox"
                  checked={model.settings.auto_restart}
                  onChange={(event) => onToggleAutoRestart(model.id, event.target.checked)}
                  className="h-4 w-4 accent-[#b08b66]"
                />
                Crash
              </label>
            </div>
          </div>
        </div>
      </Card>
    </motion.div>
  );
}
