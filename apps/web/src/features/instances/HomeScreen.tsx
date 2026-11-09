import type { DockerStatus, HealthResponse } from "@dpilot/shared";
import { SystemFacts } from "../status/StatusScreen.tsx";
import { InstanceList } from "./InstanceList.tsx";

/** The databases, then the machine they run on. */
export function HomeScreen({
  health,
  docker,
}: {
  health: HealthResponse | undefined;
  docker: DockerStatus | undefined;
}) {
  return (
    <div className="flex flex-col gap-20">
      <InstanceList />
      <SystemFacts health={health} docker={docker} />
    </div>
  );
}
