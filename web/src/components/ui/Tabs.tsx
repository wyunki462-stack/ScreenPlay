import { type ReactNode } from "react";
import { useT } from "../../i18n";
import { cn } from "../../lib/utils";

export interface TabItem<T extends string> {
  value: T;
  label: ReactNode;
}

export interface TabsProps<T extends string> {
  tabs: TabItem<T>[];
  value: T;
  onValueChange: (value: T) => void;
  className?: string;
}

export function Tabs<T extends string>({ tabs, value, onValueChange, className }: TabsProps<T>) {
  const t = useT();
  return (
    <div role="tablist" aria-label={t("media.tabs.label")} className={cn("flex gap-1 overflow-x-auto border-b border-zinc-800", className)}>
      {tabs.map((tab) => {
        const active = tab.value === value;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onValueChange(tab.value)}
            className={cn(
              "whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium transition-colors",
              active ? "border-violet-500 text-white" : "border-transparent text-zinc-400 hover:text-zinc-200",
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}