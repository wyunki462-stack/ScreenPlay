import { type HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export type BadgeVariant = "default" | "secondary" | "outline" | "violet" | "cyan";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

const variants: Record<BadgeVariant, string> = {
  default: "border-violet-500/30 bg-violet-600/20 text-violet-300",
  secondary: "border-zinc-700 bg-zinc-800 text-zinc-300",
  outline: "border-zinc-700 bg-transparent text-zinc-300",
  violet: "border-transparent bg-violet-600 text-white",
  cyan: "border-transparent bg-cyan-600 text-white",
};

export function Badge({ className, variant = "default", ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}