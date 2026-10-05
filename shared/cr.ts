// Change request schema and parsing. Shared by the `cr` CLI (submit) and
// plan-runner (load from the approved Access Request).
//
// The CR is plain YAML carried in the Access Request `reason` field, which
// Teleport caps at 4096 bytes. Each step has a `run` command and optional
// `rollback` and `verify` commands. Commands are parsed into argv with
// shell-quote and executed without a shell; argv[0] must be on the executor's
// allowlist.

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { parse as shellParse } from "shell-quote";
import { z } from "zod";

export const REASON_MAX_BYTES = 4096;

/**
 * The executor's operations. Each acts on exactly one step and the server picks
 * which: `execute` runs the next pending step (and its verify), `verify` re-runs
 * the last completed step's verify, `rollback` undoes the last completed step.
 */
export type Operation = "execute" | "verify" | "rollback";

/** MCP tool names. Short verbs: the server is scoped to one change request. */
export function toolName(op: Operation): string {
  return { execute: "exec", verify: "verify", rollback: "rollback" }[op];
}
export const STATUS_TOOL = "status";

const command = z.string().min(1).max(1024);

export const StepSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,40}$/, "step name: lowercase, digits, dashes"),
  run: command,
  /** Optional content piped to `run` on stdin (e.g. a resource manifest for `-f /dev/stdin`). */
  stdin: z.string().max(2000).optional(),
  rollback: command.optional(),
  verify: command.optional(),
});

/** Identity of the executor that will run the CR. Filled in at submit time, after the executor is registered. */
export const ExecutorRefSchema = z.object({
  bot: z.string(),
  beam: z.string(),
  app: z.string(),
  owner: z.string(),
});

/** The alert this change answers. Written by the investigator from Alertmanager's alert; lets the
 *  TUI link CR ↔ alert ↔ investigation and tell when the alert has resolved. */
export const AlertRefSchema = z.object({
  name: z.string(),
  /** Alertmanager fingerprint (stable hash of the label set; identical across re-fires) */
  fingerprint: z.string().optional(),
  namespace: z.string().optional(),
  /** startsAt of the occurrence this change answers (fingerprint + since identifies one firing) */
  since: z.string().optional(),
});

export const CRSchema = z.object({
  kind: z.literal("change-request"),
  summary: z.string().min(1).max(400),
  alert: AlertRefSchema.optional(),
  risk: z.enum(["low", "medium", "high"]).default("low"),
  steps: z.array(StepSchema).min(1).max(12),
  /** Present in the Access Request reason: the reviewer approves this executor, not an abstract plan. */
  executor: ExecutorRefSchema.optional(),
});

/** Canonical form of the steps, used to check that the CR in the request equals the CR the executor loaded. */
export function stepsFingerprint(cr: CR): string {
  return JSON.stringify(cr.steps.map((s) => [s.name, s.run, s.stdin ?? "", s.rollback ?? "", s.verify ?? ""]));
}

export type Step = z.infer<typeof StepSchema>;
export type CR = z.infer<typeof CRSchema>;
export type ExecutorRef = z.infer<typeof ExecutorRefSchema>;
export type AlertRef = z.infer<typeof AlertRefSchema>;

export function parseCR(text: string): CR {
  const doc = parseYaml(text);
  const cr = CRSchema.parse(doc);
  const names = new Set<string>();
  for (const s of cr.steps) {
    if (names.has(s.name)) throw new Error(`duplicate step name: ${s.name}`);
    names.add(s.name);
  }
  return cr;
}

export function serializeCR(cr: CR): string {
  const text = stringifyYaml(cr, { lineWidth: 0 });
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > REASON_MAX_BYTES) {
    throw new Error(
      `change request is ${bytes} bytes; Access Request reason max is ${REASON_MAX_BYTES}. Tighten the steps.`,
    );
  }
  return text;
}

/** Parse a command string into argv. Rejects shell operators, globs, env expansion. */
export function toArgv(cmd: string): string[] {
  const parts = shellParse(cmd);
  const argv: string[] = [];
  for (const p of parts) {
    if (typeof p !== "string") {
      throw new Error(`command contains a shell operator or glob, not allowed: ${JSON.stringify(p)}`);
    }
    argv.push(p);
  }
  if (argv.length === 0) throw new Error("empty command");
  return argv;
}

/** Validate every command in the CR against the executor's allowlist of executables. */
export function validateCommands(cr: CR, allowedExecutables: readonly string[]): void {
  for (const s of cr.steps) {
    for (const [kind, cmd] of Object.entries({ run: s.run, rollback: s.rollback, verify: s.verify })) {
      if (!cmd) continue;
      const argv = toArgv(cmd);
      if (!allowedExecutables.includes(argv[0])) {
        throw new Error(
          `step ${s.name}.${kind}: executable ${JSON.stringify(argv[0])} not allowed (allowed: ${allowedExecutables.join(", ")})`,
        );
      }
    }
  }
}

// ---- change semantics -----------------------------------------------------------
//
// A change request must result in a change: at least one step mutates. Steps may read when a later
// step depends on the result; `rollback` is always mutating and `verify` always read-only.

const MUTATING = new Set(["set", "scale", "patch", "delete", "create", "apply", "replace", "label", "annotate", "cordon", "uncordon", "drain", "taint", "expose", "autoscale"]);
const MUTATING_ROLLOUT = new Set(["undo", "restart", "pause", "resume"]);
const READ_ONLY = new Set(["get", "describe", "logs", "top", "wait", "diff", "explain", "events"]);
const READ_ONLY_ROLLOUT = new Set(["status", "history"]);
// A verify must be able to fail: only commands whose exit code asserts a condition qualify.
// `get`/`describe`/`logs` exit 0 whatever they show, so they are reads, not verifies.
const ASSERTING = new Set(["wait", "diff"]);
const ASSERTING_ROLLOUT = new Set(["status"]);

/** The kubectl verb of a command, with rollout's subcommand folded in ("rollout undo"). */
export function kubectlVerb(cmd: string): string | undefined {
  const argv = toArgv(cmd);
  if (argv[0] !== "kubectl") return undefined;
  const words = argv.slice(1).filter((a, i, all) => !a.startsWith("-") && !(i > 0 && /^-(n|c|f|l|o)$/.test(all[i - 1])));
  const verb = words[0];
  if (!verb) return undefined;
  return verb === "rollout" ? `rollout ${words[1] ?? ""}`.trim() : verb;
}

export function isMutating(cmd: string): boolean {
  const v = kubectlVerb(cmd);
  if (!v) return false;
  if (v.startsWith("rollout ")) return MUTATING_ROLLOUT.has(v.slice(8));
  return MUTATING.has(v);
}

/** Does this read-only command assert a condition via its exit code (so it can serve as a verify)? */
export function isAsserting(cmd: string): boolean {
  const v = kubectlVerb(cmd);
  if (!v) return false;
  if (v.startsWith("rollout ")) return ASSERTING_ROLLOUT.has(v.slice(8));
  return ASSERTING.has(v);
}

export function isReadOnly(cmd: string): boolean {
  const v = kubectlVerb(cmd);
  if (!v) return false;
  if (v.startsWith("rollout ")) return READ_ONLY_ROLLOUT.has(v.slice(8));
  return READ_ONLY.has(v);
}

/**
 * A change request must result in a change: at least one step's `run` changes state. Individual
 * steps may read (a pre-check, or information a later step depends on); such a step has no rollback.
 * `verify` is always read-only. Throws with a message the agent can act on.
 */
export function validateChangeSemantics(cr: CR): void {
  const known = (c: string) => kubectlVerb(c) ?? "unknown verb";
  if (!cr.steps.some((s) => isMutating(s.run))) {
    throw new Error(
      `no step changes the system (${cr.steps.map((s) => `${s.name}: ${known(s.run)}`).join("; ")}). A change request must result in a change: at least one step's run must be one of ${[...MUTATING].join(", ")}, rollout undo/restart/pause/resume. If nothing needs changing, conclude no change instead.`,
    );
  }
  for (const s of cr.steps) {
    if (!isMutating(s.run) && !isReadOnly(s.run)) {
      throw new Error(`step ${s.name}.run: ${known(s.run)} is neither a known change nor a known read-only operation.`);
    }
    if (s.rollback && !isMutating(s.run)) {
      throw new Error(`step ${s.name} only reads (${known(s.run)}), so it has nothing to roll back; omit its rollback.`);
    }
    if (s.rollback && !isMutating(s.rollback)) {
      throw new Error(`step ${s.name}.rollback is not a change (${known(s.rollback)}); it must return the system to the state before run.`);
    }
    if (s.verify && !isReadOnly(s.verify)) {
      throw new Error(`step ${s.name}.verify must be read-only (${[...READ_ONLY].join(", ")}, rollout status/history), got ${known(s.verify)}.`);
    }
    // A verify that cannot fail (get/describe/logs) or a missing verify is allowed: sometimes nothing
    // meaningful can be asserted. It is reported as a no-op verify (see verifyNotes) rather than rejected.
  }
}

/** Steps whose verify cannot fail (or is missing) on a state-changing step: shown to the operator and reviewer, not rejected. */
export function verifyNotes(cr: CR): string[] {
  const notes: string[] = [];
  for (const st of cr.steps) {
    if (!isMutating(st.run)) continue;
    if (!st.verify) notes.push(`${st.name}: no verify`);
    else if (!isAsserting(st.verify)) notes.push(`${st.name}: verify is a no-op (${kubectlVerb(st.verify) ?? "?"} always exits 0)`);
  }
  return notes;
}
