import { type ReactNode, useEffect, useState } from "react";
import { Link, Route, Switch } from "wouter";
import { ApiError } from "./api/client.ts";
import { useDockerStatus, useHealth } from "./api/status.ts";
import {
  EditConnectionScreen,
  NewConnectionScreen,
} from "./features/connections/ConnectionScreens.tsx";
import { Sidebar } from "./features/explorer/Sidebar.tsx";
import { HomeScreen } from "./features/instances/HomeScreen.tsx";
import { InstanceScreen } from "./features/instances/InstanceScreen.tsx";
import { NewInstanceScreen } from "./features/instances/NewInstanceScreen.tsx";
import { StatusScreen } from "./features/status/StatusScreen.tsx";
import { shellView } from "./features/status/shell.ts";
import { type SessionState, useSession } from "./session/use-session.ts";
import { useMediaQuery } from "./ui/use-media-query.ts";

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
  const appView = ready && !unauthorized && !failed && view !== "status";
  const width = appView ? "max-w-7xl" : "max-w-5xl";

  return (
    <div className={`mx-auto flex min-h-dvh flex-col px-6 py-8 sm:px-10 ${width}`}>
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
          <AppLayout>
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
              <Route path="/connections/new">
                <NewConnectionScreen />
              </Route>
              <Route path="/connections/:id/edit">
                {(params) => <EditConnectionScreen key={params.id} id={params.id} />}
              </Route>
              <Route>
                <Message title="There's nothing at this address.">
                  <Link href="/" className="underline underline-offset-4">
                    Go to your servers
                  </Link>
                </Message>
              </Route>
            </Switch>
          </AppLayout>
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

/** The sidebar sits beside the content on wide screens and in a disclosure on narrow ones. */
function AppLayout({ children }: { children: ReactNode }) {
  const wide = useMediaQuery("(min-width: 768px)");
  if (!wide) {
    return (
      <div className="flex flex-col gap-10">
        <details className="border-y border-rule py-3">
          <summary className="cursor-pointer font-medium">Browse</summary>
          <div className="pt-4">
            <Sidebar />
          </div>
        </details>
        <div className="min-w-0">{children}</div>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-10">
      <aside className="sticky top-8 max-h-[calc(100dvh-4rem)] w-72 shrink-0 overflow-y-auto pr-2">
        <Sidebar />
      </aside>
      <div className="min-w-0 flex-1">{children}</div>
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
