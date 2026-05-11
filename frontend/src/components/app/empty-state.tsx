import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

interface EmptyStateProps {
  icon: LucideIcon;
  eyebrow?: string;
  title: string;
  body: string;
  actions?: ReactNode;
}

export function EmptyState({ icon: Icon, eyebrow, title, body, actions }: EmptyStateProps) {
  return (
    <div className="grid min-h-[360px] place-items-center px-6 py-10 text-center">
      <div className="max-w-md">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-full border border-line/70 bg-shell/70 text-accent">
          <Icon className="h-5 w-5" />
        </div>
        {eyebrow ? <p className="mt-5 text-xs font-semibold uppercase tracking-[0.24em] text-accent">{eyebrow}</p> : null}
        <h2 className="mt-2 text-2xl font-semibold text-milk">{title}</h2>
        <p className="mt-3 text-sm leading-6 text-milk/52">{body}</p>
        {actions ? <div className="mt-5 flex flex-wrap justify-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}
