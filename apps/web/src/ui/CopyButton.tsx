import { useEffect, useState } from "react";
import { buttonClass } from "./button.ts";

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      className={buttonClass.quiet}
      onClick={() => navigator.clipboard.writeText(value).then(() => setCopied(true))}
    >
      <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}
