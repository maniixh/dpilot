import type { ServerVariable } from "@dpilot/shared";

const UNITS = [
  { name: "day", seconds: 86_400 },
  { name: "hour", seconds: 3_600 },
  { name: "minute", seconds: 60 },
  { name: "second", seconds: 1 },
] as const;

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/** The largest unit and, when non-zero, the next one down: "3 hours 4 minutes". */
export function formatUptime(seconds: number | null): string {
  if (seconds === null) return "—";
  const total = Math.max(0, Math.floor(seconds));
  const major = UNITS.find((unit) => total >= unit.seconds);
  if (major === undefined) return plural(0, "second");
  const majorCount = Math.floor(total / major.seconds);
  const minor = UNITS[UNITS.indexOf(major) + 1];
  const parts = [plural(majorCount, major.name)];
  if (minor !== undefined) {
    const minorCount = Math.floor((total % major.seconds) / minor.seconds);
    if (minorCount > 0) parts.push(plural(minorCount, minor.name));
  }
  return parts.join(" ");
}

export function filterVariables(vars: readonly ServerVariable[], query: string): ServerVariable[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...vars];
  return vars.filter(
    (v) => v.name.toLowerCase().includes(needle) || v.value.toLowerCase().includes(needle),
  );
}
