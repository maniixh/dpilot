import type { ConnectionTestRequest, TargetId, TargetsResponse, TestResult } from "@dpilot/shared";
import type { ExplorerAdapter } from "../engines/types.ts";

export interface Explorer {
  /** Dpilot servers and saved connections, with whether each can be browsed now. */
  targets(): Promise<TargetsResponse>;
  /** Runs `use` with the target's cached adapter; throws TargetError on failure. */
  run<T>(target: TargetId, use: (adapter: ExplorerAdapter) => Promise<T>): Promise<T>;
  /** Connects once with unsaved settings and reports the outcome; never caches. */
  test(request: ConnectionTestRequest): Promise<TestResult>;
  /** Closes and drops the target's cached adapter, if any. */
  forget(target: TargetId): Promise<void>;
}
