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

interface ModelCardProps {
  model: ModelView;
  selected: boolean;
  busy: boolean;
  onSelect: (modelId: string) => void;
  onAction: (modelId: string, action: "start" | "stop" | "restart") => void;
}

export function ModelCard({ model, selected, busy, onSelect, onAction }: ModelCardProps) {
  const activeProfile = model.active_profile;

  return (
    <motion.div layout initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
      <Card
        className={cn(
          "h-full cursor-pointer px-4 py-4 transition-colors",
          selected ? "border-accent/45 bg-white/[0.06]" : "hover:border-accent/25"
        )}
        onClick={() => onSelect(model.id)}
      >
        <div className="flex h-full flex-col gap-4">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-base font-semibold text-milk">{model.name}</h3>
                <Badge variant={statusTone[model.runtime.status]}>{model.runtime.status}</Badge>
              </div>
              <p className="text-sm leading-6 text-milk/55">{model.description}</p>
            </div>
            <div className="rounded-lg border border-line bg-white/[0.04] p-2 text-accent">
              <Cpu className="h-4 w-4" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 text-sm text-milk/62">
            <div>
              <p className="text-[11px] uppercase tracking-[0.18em] text-milk/35">Provider</p>
              <p className="mt-1">{model.provider.replace(/_/g, " ")}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-[0.18em] text-milk/35">Endpoint</p>
              <p className="mt-1 truncate">{model.endpoint}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-[0.18em] text-milk/35">Profile</p>
              <p className="mt-1">{activeProfile?.name ?? "None"}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-[0.18em] text-milk/35">Heartbeat</p>
              <p className="mt-1">{formatTimestamp(model.runtime.last_health_check)}</p>
            </div>
          </div>

          <div className="mt-auto flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs text-milk/45">
              <Activity className="h-3.5 w-3.5" />
              <span>{model.runtime.health_ok ? "Healthy" : model.runtime.last_transition_reason ?? "Awaiting health"}</span>
            </div>
            <div className="flex items-center gap-2" onClick={(event) => event.stopPropagation()}>
              <Button
                size="icon"
                variant="secondary"
                disabled={busy}
                onClick={() => onAction(model.id, "start")}
                title="Start model"
              >
                <Power className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="secondary"
                disabled={busy}
                onClick={() => onAction(model.id, "stop")}
                title="Stop model"
              >
                <Square className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="secondary"
                disabled={busy}
                onClick={() => onAction(model.id, "restart")}
                title="Restart model"
              >
                <RefreshCcw className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </Card>
    </motion.div>
  );
}
