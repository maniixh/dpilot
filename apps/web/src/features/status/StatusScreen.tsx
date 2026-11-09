import type { DockerStatus, HealthResponse } from "@dpilot/shared";
import { Fact, Facts } from "../../ui/Facts.tsx";
import { formatUptime } from "./format.ts";

interface StatusScreenProps {
  health: HealthResponse | undefined;
  docker: DockerStatus | undefined;
  checking: boolean;
  onCheckAgain: () => void;
}

export function StatusScreen({ health, docker, checking, onCheckAgain }: StatusScreenProps) {
  return (
    <div className="flex flex-col gap-12">
      <Headline docker={docker} />

      {docker?.state === "unreachable" && (
        <FixDocker docker={docker} checking={checking} onCheckAgain={onCheckAgain} />
      )}

      <SystemFacts health={health} docker={docker} />
    </div>
  );
}

function Headline({ docker }: { docker: DockerStatus | undefined }) {
  const { tone, text } = headlineFor(docker);
  return (
    <section aria-live="polite" className="flex gap-5">
      <span
        aria-hidden
        className={`w-2 shrink-0 rounded-full ${
          tone === "ok" ? "bg-running" : tone === "down" ? "bg-down" : "bg-flag"
        }`}
      />
      <h1 className="max-w-[22ch] text-4xl leading-tight font-semibold tracking-tight sm:text-5xl">
        {text}
      </h1>
    </section>
  );
}

function headlineFor(docker: DockerStatus | undefined): {
  tone: "ok" | "down" | "pending";
  text: string;
} {
  if (!docker) return { tone: "pending", text: "Checking Docker…" };
  if (docker.state === "running") {
    return { tone: "ok", text: "Docker is running. Dpilot is ready for your databases." };
  }
  return { tone: "down", text: "Dpilot can't reach Docker, so databases can't start yet." };
}

function FixDocker({
  docker,
  checking,
  onCheckAgain,
}: {
  docker: Extract<DockerStatus, { state: "unreachable" }>;
  checking: boolean;
  onCheckAgain: () => void;
}) {
  return (
    <section className="max-w-prose border-l-2 border-down pl-6">
      <h2 className="text-lg font-semibold">To fix this</h2>
      <ol className="mt-3 list-decimal space-y-1 pl-5 text-slate">
        <li>Start Docker Desktop, or the Docker service on Linux.</li>
        <li>Wait until Docker says it's running.</li>
        <li>Check again. Dpilot also re-checks every 10 seconds.</li>
      </ol>
      <button
        type="button"
        onClick={onCheckAgain}
        disabled={checking}
        className="mt-5 rounded-md bg-ink px-4 py-2 font-medium text-chart disabled:opacity-60"
      >
        {checking ? "Checking…" : "Check again"}
      </button>
      <details className="mt-5 text-sm text-slate">
        <summary className="cursor-pointer">What Dpilot tried</summary>
        <p className="mt-2 font-mono break-all">{docker.reason}</p>
      </details>
    </section>
  );
}

export function SystemFacts({
  health,
  docker,
}: {
  health: HealthResponse | undefined;
  docker: DockerStatus | undefined;
}) {
  return (
    <div className="grid gap-10 md:grid-cols-2">
      <Facts title="Docker">
        {docker?.state === "running" ? (
          <>
            <Fact term="Engine">{docker.version}</Fact>
            <Fact term="API">{docker.apiVersion}</Fact>
            <Fact term="Platform">
              {docker.os}/{docker.arch}
            </Fact>
            <Fact term="Endpoint" mono>
              {docker.endpoint}
            </Fact>
          </>
        ) : (
          <Fact term="Engine">{docker ? "Not reachable" : "Checking…"}</Fact>
        )}
      </Facts>

      <Facts title="Dpilot">
        <Fact term="Version">{health?.version ?? "…"}</Fact>
        <Fact term="Running for">{health ? formatUptime(health.uptimeSeconds) : "…"}</Fact>
        <Fact term="Listening on" mono>
          {window.location.host}
        </Fact>
      </Facts>
    </div>
  );
}
