import * as React from "react";

import { cn } from "@/lib/utils";

export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "rounded-lg border border-line bg-white/[0.04] backdrop-blur-xl shadow-glow",
        className
      )}
      {...props}
    />
  )
);

Card.displayName = "Card";

