import { type ReactNode, useEffect, useState } from "react";
import { Link, Route, Switch } from "wouter";
import { ApiError } from "./api/client.ts";
import { useDockerStatus, useHealth } from "./api/status.ts";
import { HomeScreen } from "./features/instances/HomeScreen.tsx";
import { InstanceScreen } from "./features/instances/InstanceScreen.tsx";
import { NewInstanceScreen } from "./features/instances/NewInstanceScreen.tsx";
import { StatusScreen } from "./features/status/StatusScreen.tsx";
import { shellView } from "./features/status/shell.ts";
import { type SessionState, useSession } from "./session/use-session.ts";

export function App() {
  const session = useSession();
  const ready = session === "ready";
  const health = useHealth(ready);
  const docker = useDockerStatus(ready);

  const unauthorized = [health.error, docker.error].some(
    (error) => error instanceof ApiError && error.status === 401,
  );
  const failed = !unauthorized && (health.isError || docker.isError);
  const dockerRunning = docker.data?.state === "running";
  const [seenRunning, setSeenRunning] = useState(false);
  useEffect(() => {
    if (dockerRunning) setSeenRunning(true);
  }, [dockerRunning]);
  const view = shellView(docker.data, seenRunning);

  return (
    <div className="mx-auto flex min-h-dvh max-w-5xl flex-col px-6 py-8 sm:px-10">
      <header className="mb-16 flex items-center gap-3">
        <Link href="/" className="flex items-center gap-3">
          <span aria-hidden className="size-4 rotate-45 bg-flag" />
          <span className="text-xl font-semibold tracking-tight">dpilot</span>
        </Link>
      </header>

      <main className="flex-1">
        {session !== "ready" ? (
          <SessionMessage state={session} />
        ) : unauthorized ? (
          <SessionMessage state="invalid-link" />
        ) : failed ? (
          <ServerDown />
        ) : view !== "status" ? (
          <>
            {view === "app-docker-lost" && (
              <p role="alert" className="mb-10 border-l-2 border-down pl-4">
                Dpilot lost contact with Docker. Your database servers may have stopped. Dpilot
                checks again every 10 seconds.
              </p>
            )}
            <Switch>
              <Route path="/">
                <HomeScreen health={health.data} docker={docker.data} />
              </Route>
              <Route path="/new">
                <NewInstanceScreen />
              </Route>
              <Route path="/instances/:name">
                {(params) => <InstanceScreen key={params.name} name={params.name} />}
              </Route>
              <Route>
                <Message title="There's nothing at this address.">
                  <Link href="/" className="underline underline-offset-4">
                    Go to your servers
                  </Link>
                </Message>
              </Route>
            </Switch>
          </>
        ) : (
          <StatusScreen
            health={health.data}
            docker={docker.data}
            checking={docker.isFetching}
            onCheckAgain={() => docker.refetch()}
          />
        )}
      </main>
    </div>
  );
}

function SessionMessage({ state }: { state: Exclude<SessionState, "ready"> }) {
  if (state === "connecting") return <Message title="Connecting to Dpilot…" />;
  if (state === "failed") return <ServerDown />;
  return (
    <Message title="This link is no longer valid.">
      Open the link printed in the terminal where you ran dpilot. Each run creates a new one.
    </Message>
  );
}

function ServerDown() {
  return (
    <Message title="Dpilot's server isn't responding.">
      Check the terminal where you ran dpilot. If it stopped, start it again.
    </Message>
  );
}

function Message({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <section aria-live="polite" className="max-w-prose">
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      {children && <p className="mt-4 text-lg text-slate">{children}</p>}
    </section>
  );
}
