import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface PageShellProps {
  left?: ReactNode;
  center: ReactNode;
  right?: ReactNode;
  rightOpen?: boolean;
  className?: string;
}

export function PageShell({ left, center, right, rightOpen = true, className }: PageShellProps) {
  const columns =
    left && right && rightOpen
      ? "xl:grid-cols-[320px_minmax(0,1fr)_360px]"
      : left
        ? "xl:grid-cols-[320px_minmax(0,1fr)]"
        : right && rightOpen
          ? "xl:grid-cols-[minmax(0,1fr)_360px]"
          : "grid-cols-1";

  return (
    <main className={cn("mt-4 grid min-h-0 flex-1 overflow-hidden rounded-[var(--radius-soft)] border border-line/70 bg-panel/55", columns, className)}>
      {left ? <aside className="min-h-0 overflow-y-auto border-b border-line/70 bg-shell/35 xl:border-b-0 xl:border-r">{left}</aside> : null}
      <section className="min-h-0 overflow-y-auto">{center}</section>
      {right && rightOpen ? <aside className="min-h-0 overflow-y-auto border-t border-line/70 bg-shell/35 xl:border-l xl:border-t-0">{right}</aside> : null}
    </main>
  );
}
