import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useI18n } from "../../i18n";

type Props = {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  autoComplete?: string;
  autoFocus?: boolean;
  /** Classes for the `<input>` itself; the eye button is positioned on top. */
  className?: string;
  testId?: string;
};

/**
 * Password input with a show/hide eye button on the right.
 *
 * The field keeps its masked state by default; clicking the eye reveals the
 * plain text and clicking it again masks the value again, so the value is never
 * changed — only the `type` attribute. Used by the login screen and by the
 * first-run "create account" form.
 */
export function PasswordInput({ value, onChange, autoComplete, autoFocus, className, testId }: Props) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);
  const label = t(visible ? "login.hidePassword" : "login.showPassword");

  return (
    <span className="relative block">
      <input
        type={visible ? "text" : "password"}
        value={value}
        onChange={onChange}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        className={`w-full pr-9 ${className ?? ""}`.trim()}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={label}
        title={label}
        aria-pressed={visible}
        data-testid={testId ?? "password-visibility"}
        className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-500 transition-colors hover:text-zinc-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-600"
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </span>
  );
}