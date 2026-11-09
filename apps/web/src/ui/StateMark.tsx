import type { InstanceState } from "@dpilot/shared";
import { describeState, type Tone } from "../features/instances/present.ts";

const TONE_CLASS: Record<Tone, string> = {
  ok: "bg-running",
  busy: "bg-flag motion-safe:animate-pulse",
  idle: "border border-slate bg-transparent",
  down: "bg-down",
};

/** The diamond from the Dpilot mark, coloured by how the instance is doing. */
export function StateMark({ state, size = "sm" }: { state: InstanceState; size?: "sm" | "lg" }) {
  const { label, tone } = describeState(state);
  return (
    <span className={`inline-flex items-center ${size === "lg" ? "gap-3 text-lg" : "gap-2"}`}>
      <span
        aria-hidden
        className={`shrink-0 rotate-45 ${size === "lg" ? "size-3" : "size-2.5"} ${TONE_CLASS[tone]}`}
      />
      <span>{label}</span>
    </span>
  );
}
