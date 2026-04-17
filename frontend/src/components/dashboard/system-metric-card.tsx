import { motion } from "framer-motion";
import type { LucideIcon } from "lucide-react";

import { cn, formatNumber } from "@/lib/utils";

interface SystemMetricCardProps {
  label: string;
  value: number | null | undefined;
  suffix?: string;
  helper?: string;
  icon: LucideIcon;
  onClick?: () => void;
}

export function SystemMetricCard({ label, value, suffix = "", helper, icon: Icon, onClick }: SystemMetricCardProps) {
  return (
    <motion.div className="h-full" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "h-full w-full rounded-lg border border-line bg-white/[0.04] px-4 py-4 text-left shadow-glow backdrop-blur-xl",
          "transition-colors hover:border-accent/45 hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-milk/40">{label}</p>
            <p className="mt-3 text-2xl font-semibold text-milk">
              {formatNumber(value)}
              <span className="ml-1 text-sm text-milk/45">{suffix}</span>
            </p>
            {helper ? <p className="mt-2 text-xs text-milk/45">{helper}</p> : null}
          </div>
          <div className="rounded-lg border border-line bg-white/[0.04] p-2 text-accent">
            <Icon className="h-4 w-4" />
          </div>
        </div>
      </button>
    </motion.div>
  );
}
