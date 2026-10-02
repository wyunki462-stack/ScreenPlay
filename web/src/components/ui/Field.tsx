import { type ChangeEvent } from "react";

import { Input } from "./Input";

/**
 * Labelled text/password field. Shared by the Settings forms — the API-key form
 * in `pages/Settings.tsx` and the change-password card in
 * `components/ChangePasswordCard.tsx` (that card is replaced by a stub in the
 * desktop build, see `web/src/lib/platform.ts`).
 */
export function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
  type = "password",
  autoComplete = "off",
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
  type?: string;
  autoComplete?: string;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm text-zinc-300">{label}</span>
      <Input
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        autoComplete={autoComplete}
        spellCheck={false}
      />
      {hint ? <span className="block text-xs text-zinc-500">{hint}</span> : null}
    </label>
  );
}