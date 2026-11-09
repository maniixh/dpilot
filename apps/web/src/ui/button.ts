const base =
  "inline-flex items-center justify-center rounded-md px-4 py-2 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60";

export const buttonClass = {
  primary: `${base} bg-ink text-chart hover:bg-ink/90`,
  secondary: `${base} border border-ink/30 text-ink hover:border-ink hover:bg-white/50`,
  danger: `${base} bg-down text-white hover:bg-down/90`,
  quiet: "text-sm font-medium text-slate underline-offset-4 hover:text-ink hover:underline",
} as const;
