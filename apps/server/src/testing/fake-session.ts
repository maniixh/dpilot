import type { SqlResult } from "../engines/types.ts";
import type { SqlSession } from "../query/types.ts";

interface Scripted {
  pattern: RegExp;
  result: SqlResult | Error;
}

const EMPTY_RESULT: SqlResult = { columns: [], rows: [], command: null, affected: null };

/** Scripted SqlSession: the most recently added matching response wins. */
export class FakeSession implements SqlSession {
  readonly executed: string[] = [];
  readonly cancelled: string[] = [];
  closed = false;
  private scripted: Scripted[] = [];
  private gates: { pattern: RegExp; gate: Promise<void> }[] = [];
  private inFlight: string | null = null;
  private cancelDelay: Promise<void> = Promise.resolve();

  respond(pattern: RegExp, result: SqlResult | Error): void {
    this.scripted.unshift({ pattern, result });
  }

  /** Statements matching `pattern` stay in flight until `gate` settles. */
  hold(pattern: RegExp, gate: Promise<void>): void {
    this.gates.unshift({ pattern, gate });
  }

  /** Makes `cancel()` settle only after `delay` does. */
  delayCancel(delay: Promise<void>): void {
    this.cancelDelay = delay;
  }

  async execute(text: string): Promise<SqlResult> {
    this.executed.push(text);
    this.inFlight = text;
    try {
      const gate = this.gates.find((g) => g.pattern.test(text));
      if (gate) await gate.gate;
      const match = this.scripted.find((s) => s.pattern.test(text));
      if (!match) return EMPTY_RESULT;
      if (match.result instanceof Error) throw match.result;
      return match.result;
    } finally {
      this.inFlight = null;
    }
  }

  /** Records the statement in flight; a no-op (and unrecorded) when idle. */
  async cancel(): Promise<void> {
    if (this.inFlight === null) return;
    this.cancelled.push(this.inFlight);
    await this.cancelDelay;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
