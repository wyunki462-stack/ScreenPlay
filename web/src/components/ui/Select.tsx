import { forwardRef, type SelectHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils";

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <div className={cn("relative inline-flex", className)}>
      <select
        ref={ref}
        className="h-9 w-full appearance-none rounded-md border border-zinc-700 bg-zinc-900 pl-3 pr-8 text-sm text-zinc-100 transition-colors focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
    </div>
  ),
);
Select.displayName = "Select";