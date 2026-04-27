import { motion } from "framer-motion";
import type { LucideIcon } from "lucide-react";

import { cn, formatNumber } from "@/lib/utils";

interface SystemMetricCardProps {
  label: string;
  value: number | null | undefined;
  suffix?: string;
  helper?: string;
  description?: string;
  icon: LucideIcon;
  onClick?: () => void;
}

export function SystemMetricCard({ label, value, suffix = "", helper, description, icon: Icon, onClick }: SystemMetricCardProps) {
  return (
    <motion.div className="h-full" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}>
      <button
        type="button"
        onClick={onClick}
        title={description ?? helper ?? label}
        className={cn(
          "min-h-[126px] w-full rounded-lg border border-line/55 bg-black/18 px-4 py-4 text-left backdrop-blur-xl",
          "shadow-[inset_0_1px_0_rgba(255,255,255,0.035)] transition-all duration-300 hover:-translate-y-0.5 hover:border-accent/45 hover:bg-white/[0.055] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] uppercase tracking-[0.22em] text-milk/40">{label}</p>
            <p className="mt-3 text-2xl font-semibold text-milk">
              {formatNumber(value)}
              <span className="ml-1 text-sm text-milk/45">{suffix}</span>
            </p>
            {helper ? <p className="mt-2 line-clamp-2 text-xs leading-5 text-milk/45">{helper}</p> : null}
          </div>
          <div className="rounded-lg border border-line/70 bg-white/[0.04] p-2.5 text-accent">
            <Icon className="h-4 w-4" />
          </div>
        </div>
      </button>
    </motion.div>
  );
}
