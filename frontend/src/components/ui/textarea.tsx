import * as React from "react";

import { cn } from "@/lib/utils";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        "min-h-[140px] w-full rounded-lg border border-line bg-white/[0.04] px-3 py-2 text-sm text-milk outline-none placeholder:text-milk/30 focus:border-accent/60",
        className
      )}
      {...props}
    />
  )
);

Textarea.displayName = "Textarea";
