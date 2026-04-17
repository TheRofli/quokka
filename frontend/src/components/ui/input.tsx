import * as React from "react";

import { cn } from "@/lib/utils";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "h-9 w-full rounded-lg border border-line bg-white/[0.04] px-3 text-sm text-milk outline-none placeholder:text-milk/30 focus:border-accent/60",
        className
      )}
      {...props}
    />
  )
);

Input.displayName = "Input";

