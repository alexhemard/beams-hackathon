// CR execution state machine. Owned by cr-exec, never by the caller.
//
// The caller gets four fixed operations; the server decides which step they
// apply to and enforces order, one-shot execution, and phases:
//
//   execute   run the next step in order, then its verify           IN_PROGRESS → … → COMPLETE | FAILED | ABORTED
//   verify    re-run the verify of the most recent completed step   (repeatable, informational)
//   rollback  undo the most recent completed step                   FAILED|COMPLETE → ROLLING_BACK → ROLLED_BACK | ROLLBACK_FAILED
//
// A step "completed" iff its run succeeded. Only completed steps are ever rolled back.

import type { CR, Step } from "../shared/cr";

export type Phase = "IN_PROGRESS" | "COMPLETE" | "FAILED" | "ROLLING_BACK" | "ROLLED_BACK" | "ROLLBACK_FAILED" | "ABORTED";

export interface StepRecord {
  name: string;
  ran: boolean;
  runOk?: boolean;
  verified?: boolean;
  rolledBack?: boolean;
}

export { toolName, type Operation } from "../shared/cr";
import type { Operation } from "../shared/cr";

export interface Command {
  step: Step;
  kind: "run" | "verify" | "rollback";
  command: string;
  stdin?: string;
}

export class CRState {
  phase: Phase = "IN_PROGRESS";
  readonly steps: StepRecord[];
  readonly log: Array<{ at: string; op: string; step: string; kind: string; caller: string; code: number }> = [];

  constructor(readonly cr: CR) {
    this.steps = cr.steps.map((s) => ({ name: s.name, ran: false }));
  }

  // ---- what each operation would do right now ----------------------------------

  /** The step `execute` would run next, or undefined. */
  nextStepIndex(): number | undefined {
    if (this.phase !== "IN_PROGRESS") return undefined;
    for (let i = 0; i < this.steps.length; i++) {
      if (!this.steps[i].ran) return i;
    }
    return undefined;
  }

  /** The most recent completed (run OK, not rolled back) step, or undefined. */
  lastCompletedIndex(): number | undefined {
    for (let i = this.steps.length - 1; i >= 0; i--) {
      const r = this.steps[i];
      if (r.runOk && !r.rolledBack) return i;
    }
    return undefined;
  }

  availableOperations(): Operation[] {
    const ops: Operation[] = [];
    if (this.nextStepIndex() !== undefined) ops.push("execute");
    const last = this.lastCompletedIndex();
    if (last !== undefined) {
      if (this.cr.steps[last].verify && this.phase !== "ROLLING_BACK") ops.push("verify");
      if (this.cr.steps[last].rollback && ["FAILED", "COMPLETE", "ROLLING_BACK"].includes(this.phase)) ops.push("rollback");
    }
    return ops;
  }

  /** Commands an operation will run, in order. Empty if not available. */
  plan(op: Operation): Command[] {
    if (!this.availableOperations().includes(op)) return [];
    if (op === "execute") {
      const s = this.cr.steps[this.nextStepIndex()!];
      const cmds: Command[] = [{ step: s, kind: "run", command: s.run, stdin: s.stdin }];
      if (s.verify) cmds.push({ step: s, kind: "verify", command: s.verify });
      return cmds;
    }
    const s = this.cr.steps[this.lastCompletedIndex()!];
    if (op === "verify") return [{ step: s, kind: "verify", command: s.verify! }];
    return [{ step: s, kind: "rollback", command: s.rollback! }];
  }

  // ---- record outcomes -----------------------------------------------------------

  /** Record a command result. Returns false if the operation should stop (a failure). */
  record(op: Operation, cmd: Command, caller: string, code: number): boolean {
    this.log.push({ at: new Date().toISOString(), op, step: cmd.step.name, kind: cmd.kind, caller, code });
    const rec = this.steps.find((r) => r.name === cmd.step.name)!;
    const ok = code === 0;
    switch (cmd.kind) {
      case "run":
        rec.ran = true;
        rec.runOk = ok;
        if (!ok) this.fail();
        return ok;
      case "verify":
        rec.verified = ok;
        if (!ok && (this.phase === "IN_PROGRESS" || this.phase === "COMPLETE")) this.fail();
        else if (ok) this.advanceIfComplete();
        return ok;
      case "rollback":
        this.phase = "ROLLING_BACK";
        rec.rolledBack = ok;
        if (!ok) this.phase = "ROLLBACK_FAILED";
        else if (this.lastCompletedIndex() === undefined) this.phase = "ROLLED_BACK";
        return ok;
    }
  }

  private fail(): void {
    this.phase = this.lastCompletedIndex() === undefined ? "ABORTED" : "FAILED";
  }

  private advanceIfComplete(): void {
    if (this.phase !== "IN_PROGRESS") return;
    const allDone = this.cr.steps.every((s, i) => this.steps[i].runOk === true && (!s.verify || this.steps[i].verified === true));
    if (allDone) this.phase = "COMPLETE";
  }

  isTerminal(): boolean {
    return ["ROLLED_BACK", "ROLLBACK_FAILED", "ABORTED"].includes(this.phase);
  }

  status(extra: Record<string, unknown> = {}) {
    const next = this.nextStepIndex();
    const last = this.lastCompletedIndex();
    return {
      phase: this.phase,
      // steps done (ran ok) out of total; READY = approved and nothing run yet, IN PROGRESS n/m after that
      progress: { done: this.steps.filter((st) => st.ran && st.runOk !== false).length, total: this.cr.steps.length },
      summary: this.cr.summary,
      risk: this.cr.risk,
      steps: this.cr.steps.map((s, i) => ({ ...this.steps[i], run: s.run, verify: s.verify, rollback: s.rollback })),
      available: this.availableOperations(),
      next_execute: next !== undefined ? this.cr.steps[next].name : null,
      next_rollback: last !== undefined && this.cr.steps[last].rollback ? this.cr.steps[last].name : null,
      log: this.log,
      ...extra,
    };
  }
}
