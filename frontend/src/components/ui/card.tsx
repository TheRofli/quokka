import * as React from "react";

import { cn } from "@/lib/utils";

export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "rounded-lg border border-line/75 bg-panel/70 backdrop-blur-xl shadow-glow transition-colors duration-300",
        className
      )}
      {...props}
    />
  )
);

Card.displayName = "Card";
