// The change-request operations, callable from the CLI and the TUI.
// Every step emits human-readable lines through `emit` (stdout by default).
//
// Order of operations (register, then request, then approval):
//   submit   = deploy the executor (beam + labeled bot + plan-runner + published app) and
//              THEN file the Access Request whose reason is the CR plus an `executor:`
//              block naming that bot/beam/app. The reviewer approves a concrete, registered
//              executor. plan-runner discovers its request by that block; exec/verify/rollback
//              error until it is APPROVED and the steps match what it was deployed with.
//   exec / verify / rollback / status  one operation at a time on the executor
//   teardown  remove beam, bot, token

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer, connect } from "node:net";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseCR, serializeCR, validateChangeSemantics, validateCommands, STATUS_TOOL, toolName, type CR, type Operation } from "../shared/cr";
import { getRequest, listRequests, run, runOk, type AccessRequest } from "../shared/teleport";
import { retryWithBackoff } from "./retry";
import {
  PROXY, REPO, addBotLabels, ambientEnv, botAppEnv, beamExec, beamExecOk, beamInit, beamScp, bundle, createBeam, createBoundKeypairToken, currentUser, discover,
  ensureBot, listBeams, publishedAppName, removeBeam, removeBot, stateDir, step as stepLog, type BotLabels, type TrackedBot,
 beamScpFrom } from "./beamops";

export type { Operation } from "../shared/cr";
export type { TrackedBot };
export { discover };

export const APPROVAL_ROLE = process.env.CR_APPROVAL_ROLE ?? "oncall-change";
export const BOT_ROLE = process.env.CR_BOT_ROLE ?? "administrator";
export const KUBE_CLUSTER = process.env.CR_KUBE_CLUSTER ?? "emailpals-production";
export const ALLOW: Record<string, string[]> = { kube: ["kubectl"], tctl: ["tctl"] };

export type Emit = (line: string) => void;
const stdout: Emit = (l) => console.log(l);

export interface CRRun {
  requestId: string;
  target: "kube" | "tctl";
  bot?: string;
  token?: string;
  beam?: string;
  beamUuid?: string;
  appUrl?: string;
  appName?: string;
  phase?: string;
  /** when the executor was torn down (close) */
  closedAt?: string;
}

/** Phases after which nothing further can run (COMPLETE is not terminal: it still offers rollback). */
export const TERMINAL = ["ROLLED_BACK", "ROLLBACK_FAILED", "ABORTED"];

// ---- submit = register executor, then file the request --------------------------------

export async function submit(file: string, target: CRRun["target"], emit: Emit = stdout, parentBeam?: string): Promise<CRRun> {
  const cr = parseCR(readFileSync(file, "utf8"));
  validateCommands(cr, ALLOW[target]);
  validateChangeSemantics(cr);
  const owner = await currentUser();
  const runId = randomBytes(3).toString("hex");
  const bot = `administrator-${runId}`;
  const st: CRRun = { requestId: "", target, bot, token: bot };

  stepLog(`bundle plan-runner`);
  await bundle("bundle:plan-runner");

  stepLog(`create executor beam`);
  const beam = await createBeam();
  st.beam = beam.id;
  st.beamUuid = beam.uuid;
  stepLog(`executor beam ${beam.id} created`);

  // The bot is the tracking record: labeled with role, owner, beam and (later) the request id.
  const labels: BotLabels = { role: "executor", owner, beamAlias: beam.id, beamId: beam.uuid, ref: runId, parent: parentBeam };
  stepLog(`create executor bot ${bot} (role ${BOT_ROLE}) labeled for beam ${beam.id}`);
  await ensureBot(bot, BOT_ROLE, labels);
  const secret = await createBoundKeypairToken(bot, bot, labels);

  stepLog(`copy plan-runner and the change request into beam ${beam.id}`);
  const crFile = join(stateDir(), `cr-${runId}.yaml`);
  writeFileSync(crFile, serializeCR(cr));
  // one archive = the executor's reproducible init state (bundle, bootstrap, the CR file)
  await beamInit(
    beam.id,
    [
      { local: join(REPO, "dist/plan-runner.mjs"), remote: "plan-runner/plan-runner.mjs" },
      { local: join(REPO, "plan-runner/bootstrap.sh"), remote: "plan-runner/bootstrap.sh" },
      { local: crFile, remote: "plan-runner/cr.yaml" },
    ],
    bot,
  );

  stepLog(`bootstrap inside beam: enroll bot, start tbot, start plan-runner (no tools until approved)`);
  const boot = await beamExec(
    beam.id,
    ["env", `KUBE_CLUSTER=${KUBE_CLUSTER}`, "bash", "/home/beams/plan-runner/bootstrap.sh", PROXY, bot, secret, bot, target, owner],
    { redact: [secret] },
  );
  for (const l of boot.stdout.split("\n")) if (l.trim()) emit(l);
  if (boot.code !== 0) throw new Error(`bootstrap failed:\n${boot.stderr}`);

  stepLog(`publish plan-runner as a Teleport app`);
  const pub = await runOk(["tsh", "--proxy", PROXY, "beams", "publish", beam.id], { env: ambientEnv() });
  st.appUrl = pub.match(/https:\/\/\S+/)?.[0];
  st.appName = st.appUrl ? new URL(st.appUrl).hostname.split(".")[0] : publishedAppName(beam);
  stepLog(`published app ${st.appName}`);
  emit(`executor registered: beam ${beam.id}, bot ${bot}, app ${st.appName}`);

  stepLog(`file the change request as an Access Request naming this executor`);
  const withExecutor: CR = { ...cr, executor: { bot, beam: beam.id, app: st.appName!, owner } };
  const reason = serializeCR(withExecutor);
  const out = await runOk(["tsh", "--proxy", PROXY, "request", "create", "--roles", APPROVAL_ROLE, "--reason", reason, "--nowait"], { env: ambientEnv() });
  const id = out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
  if (!id) throw new Error(`could not find a request id in tsh output:\n${out}`);
  st.requestId = id;
  st.phase = "PENDING_APPROVAL";
  saveState(st);
  await addBotLabels(bot, { "oncall/ref": id, "oncall/app": st.appName! });
  emit(`change request ${id} filed (PENDING). Executor ${bot} in beam ${beam.id} is waiting for approval.`);
  return st;
}

export async function requestStatus(id: string): Promise<AccessRequest | undefined> {
  return getRequest(id, { proxy: PROXY });
}

// ---- operations ------------------------------------------------------------------------

/** What the executor reports about itself (the `status` tool). The executor owns this state; the TUI only shows it. */
export interface ExecutorStatus {
  phase: string;
  approved: boolean;
  approvalNote?: string;
  request: string | null;
  executor: string | null;
  summary: string;
  steps: Array<{ name: string; ran: boolean; runOk?: boolean; verified?: boolean; rolledBack?: boolean; run: string; verify?: string; rollback?: string }>;
  /** operations callable right now: empty until approved, and empty while a command runs */
  available: Operation[];
  progress?: { done: number; total: number };
  next_execute: string | null;
  next_rollback: string | null;
  /** the command running at this moment, if any */
  inflight?: { op: Operation; step: string; kind: string; since: string; caller: string } | null;
  /** every command the executor ran, in order */
  log?: Array<{ at: string; op: string; step: string; kind: string; caller: string; code: number }>;
  updated_at?: string;
}

export interface RunOptions {
  port?: number;
  /** dev: direct URL to a local plan-runner */
  url?: string;
  caller?: string;
}

/** Open a connection to the CR's executor (through `tsh proxy app`, or a direct URL in dev), run fn, close. */
export async function withExecutor<T>(id: string, emit: Emit, o: RunOptions, fn: (client: Client) => Promise<T>): Promise<T> {
  // A free ephemeral port per call: a fixed port collides when the TUI and the CLI (or two
  // TUIs) reach executors at the same time, and the failure shows up as ECONNREFUSED.
  const port = o.port ?? (await freePort());
  let proxy: ReturnType<typeof spawn> | undefined;
  let mcpUrl: URL;
  let headers: Record<string, string> = {};

  if (o.url) {
    mcpUrl = new URL(o.url);
    headers = { "X-Debug-Caller": o.caller ?? "dev" };
  } else {
    const st = await stateFor(id);
    if (!st?.appName) throw new Error(`no executor known for ${id} (locally or in Teleport)`);
    const appName = st.appName;
    // wait until the local proxy actually accepts connections (up to 20s overall)
    const deadline = Date.now() + 20_000;
    // A freshly published executor app can take a moment to propagate; `tsh proxy app` fails
    // fast with "not found" until it does, so retry that specific failure within the deadline.
    const attempt = (): Promise<string | undefined> =>
      new Promise((resolve) => {
        const p = spawn("tsh", ["--proxy", PROXY, "proxy", "app", appName, "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"], env: botAppEnv() });
        proxy = p;
        let err = "";
        let exited = false;
        const onData = (d: Buffer) => {
          const s = d.toString();
          err += s;
          const t = s.trim();
          if (t && !/listening|Proxying|127\.0\.0\.1/i.test(t)) emit(t);
        };
        p.stdout!.on("data", onData);
        p.stderr!.on("data", onData);
        p.on("exit", () => (exited = true));
        const poll = async () => {
          for (;;) {
            if (exited) return resolve(`tsh proxy app exited: ${err.trim().split("\n").pop() ?? ""}`);
            if (await portOpen(port)) return resolve(undefined);
            if (Date.now() > deadline) {
              p.kill("SIGTERM");
              return resolve(`tsh proxy app on 127.0.0.1:${port} did not come up`);
            }
            await new Promise((r) => setTimeout(r, 250));
          }
        };
        poll();
      });
    await retryWithBackoff(attempt, deadline, (err) => /not found/i.test(err));
    mcpUrl = new URL(`http://127.0.0.1:${port}/mcp`);
  }
  try {
    const client = new Client({ name: "oncall", version: "0.1.0" });
    await client.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers } }));
    try {
      return await fn(client);
    } finally {
      await client.close().catch(() => {});
    }
  } finally {
    proxy?.kill();
  }
}

/** exec/verify/rollback run real commands (e.g. `rollout status --timeout=90s`); the SDK default is 60s. */
const OP_CALL = { timeout: 15 * 60_000, resetTimeoutOnProgress: true };

export async function executorStatus(id: string, emit: Emit = stdout, o: RunOptions = {}): Promise<ExecutorStatus> {
  return withExecutor(id, emit, o, async (client) => JSON.parse(text(await client.callTool({ name: STATUS_TOOL, arguments: {} }))));
}

/** Perform one operation (execute | verify | rollback) on the executor. Throws with the executor's reason when it refuses. */
export async function callOperation(id: string, op: Operation, emit: Emit = stdout, o: RunOptions = {}): Promise<{ output: string; status: ExecutorStatus }> {
  return withExecutor(id, emit, o, async (client) => {
    stepLog(toolName(op));
    const res = await client.callTool({ name: toolName(op), arguments: { confirm: true } }, undefined, OP_CALL);
    const output = text(res);
    if ((res as any).isError && /^DENIED:/.test(output)) throw new Error(output.replace(/^DENIED:\s*/, ""));
    for (const l of output.split("\n")) emit("    " + l);
    const status = JSON.parse(text(await client.callTool({ name: STATUS_TOOL, arguments: {} }))) as ExecutorStatus;
    const st = loadState(id);
    if (st) {
      st.phase = status.phase;
      saveState(st);
    }
    return { output, status };
  });
}

/** Run the whole CR: execute until COMPLETE; on failure, roll back until terminal. */
export async function runCR(id: string, emit: Emit = stdout, o: RunOptions = {}): Promise<string> {
  return withExecutor(id, emit, o, async (client) => {
    let phase = "UNKNOWN";
    for (let i = 0; i < 100; i++) {
      const status = JSON.parse(text(await client.callTool({ name: STATUS_TOOL, arguments: {} }))) as ExecutorStatus;
      phase = status.phase;
      emit(`phase=${status.phase} approved=${status.approved} available=[${status.available.join(", ")}]`);
      if (!status.approved) {
        emit(`waiting for approval: ${status.approvalNote ?? ""}`);
        await new Promise((r) => setTimeout(r, 10_000));
        continue;
      }
      if (TERMINAL.includes(status.phase) || status.phase === "COMPLETE") break;
      const next: Operation | undefined = status.available.includes("execute") ? "execute" : status.available.includes("rollback") ? "rollback" : undefined;
      if (!next) throw new Error("no operation available and not terminal; executor state is stuck");
      stepLog(toolName(next));
      const res = await client.callTool({ name: toolName(next), arguments: { confirm: true } }, undefined, OP_CALL);
      for (const l of text(res).split("\n")) emit("    " + l);
    }
    const st = loadState(id);
    if (st) {
      st.phase = phase;
      saveState(st);
    }
    emit(`change request ${id}: ${phase}`);
    return phase;
  });
}

// ---- teardown --------------------------------------------------------------------------

export async function teardown(id: string, emit: Emit = stdout): Promise<void> {
  const st = await stateFor(id);
  if (!st) throw new Error(`no executor known for ${id} (locally or in Teleport)`);
  if (st.beam) {
    // The exact argv plan-runner ran lives only in its own log (Teleport audits the plan and the
    // kube.request effects, not the commands). Keep it before the beam disappears.
    const logPath = join(stateDir(), `${id}.exec.log`);
    stepLog(`save executor log → ${logPath}`);
    try {
      await beamScpFrom(st.beam, "/home/beams/logs/plan-runner.log", logPath);
      emit(`executor log saved: ${logPath}`);
      const summaryPath = join(stateDir(), `${id}.summary.md`);
      writeFileSync(summaryPath, executionSummary(id, st, readFileSync(logPath, "utf8")));
      emit(`execution summary: ${summaryPath}`);
    } catch (e) {
      emit(`executor log not saved (${(e as Error).message})`);
    }
    stepLog(`remove beam ${st.beam}`);
    await removeBeam(st.beam);
  } else emit(`executor beam already gone (no log to save)`);
  if (st.bot) {
    stepLog(`remove bot ${st.bot} and token`);
    await removeBot(st.bot, st.token ?? st.bot);
  }
  saveState({ requestId: id, target: st.target, phase: "TORN_DOWN", closedAt: new Date().toISOString() });
  emit(`torn down ${id}`);
}

// ---- listing / recovery (Teleport is the source of truth) ------------------------------

/** The requester's change requests (Access Requests naming the approval role), newest first. */
export async function listCRs(): Promise<AccessRequest[]> {
  const all = await listRequests({ proxy: PROXY });
  return all.filter((r) => r.roles.includes(APPROVAL_ROLE)).sort((a, b) => (a.created < b.created ? 1 : -1));
}

/**
 * Executor state per CR, recovered from Teleport: the executor bot's labels name the beam,
 * the published app and the request id; `tsh beams ls` says whether the beam is still alive.
 * Falls back to the `executor:` block in the request reason when the bot is gone.
 */
export async function recoverExecutors(): Promise<Map<string, CRRun>> {
  const [tracked, beams] = await Promise.all([discover(), listBeams().catch(() => [])]);
  const byUuid = new Map(beams.map((b) => [b.uuid, b]));
  const out = new Map<string, CRRun>();
  for (const t of tracked.filter((t) => t.role === "executor" && /^[0-9a-f-]{36}$/.test(t.ref))) {
    const beam = byUuid.get(t.beamId);
    const local = loadState(t.ref);
    const st: CRRun = {
      requestId: t.ref,
      target: local?.target ?? "kube",
      bot: t.bot,
      token: t.bot,
      beam: t.beamAlive ? t.beamAlias : undefined,
      beamUuid: t.beamId,
      appName: t.beamAlive ? t.app ?? (beam ? publishedAppName(beam) : undefined) : undefined,
      phase: local?.phase ?? (t.beamAlive ? "READY" : "BEAM_GONE"),
    };
    out.set(t.ref, st);
    if (!local) saveState(st); // re-seed the cache from Teleport
  }
  return out;
}

/** Local cache first, then Teleport. */
async function stateFor(id: string): Promise<CRRun | undefined> {
  const local = loadState(id);
  if (local?.bot && local.appName) return local;
  return (await recoverExecutors()).get(id) ?? local;
}

export function saveState(st: CRRun) {
  writeFileSync(join(stateDir(), `${st.requestId || st.bot}.json`), JSON.stringify(st, null, 2));
}

export function loadState(id: string): CRRun | undefined {
  const p = join(stateDir(), `${id}.json`);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as CRRun) : undefined;
}

function text(res: any): string {
  return (res?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
}

export { run };

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

export function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ port, host: "127.0.0.1" });
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("error", () => resolve(false));
  });
}

/**
 * A human-readable summary of what the executor did, from its own JSON log: the record of the change
 * (who asked, which identity acted, each command with exit code and duration, the final phase).
 * Teleport's session summaries cover recorded SSH/k8s/db sessions; the executor is an HTTP app, so
 * this is the change request's equivalent.
 */
function executionSummary(id: string, st: CRRun, log: string): string {
  const events = log
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
  const cmds = events.filter((e) => e.msg === "command executed");
  const phase = cmds.length ? cmds[cmds.length - 1].phase : "(no operations)";
  const first = cmds[0]?.ts ?? events[0]?.ts ?? "";
  const last = cmds[cmds.length - 1]?.ts ?? events[events.length - 1]?.ts ?? "";
  const lines = [
    `# Change request ${id}: execution summary`,
    "",
    `- executor: bot ${st.bot ?? "?"} in beam ${st.beam ?? "?"} (app ${st.appName ?? "?"})`,
    `- window: ${first} → ${last}`,
    `- final phase: ${phase}`,
    `- operations: ${cmds.length}`,
    "",
    "## Commands run (as the bot)",
    "",
  ];
  for (const c of cmds) {
    lines.push(`- ${c.ts}  ${c.op} · step ${c.step}.${c.kind} · exit ${c.code} · ${((c.ms ?? 0) / 1000).toFixed(1)}s · requested by ${c.caller}`);
    lines.push(`  \`${(c.argv ?? []).join(" ")}\``);
  }
  const denied = events.filter((e) => /RBAC denied/.test(e.msg ?? ""));
  if (denied.length) lines.push("", `## Denied by Teleport RBAC: ${denied.length}`, ...denied.map((d) => `- step ${d.step}`));
  lines.push("", "## Where to look in Teleport", "", `- audit log: kube.request by bot-${st.bot ?? "?"} on the cluster; app.session.* on ${st.appName ?? "?"}; request ${id}`);
  return lines.join("\n") + "\n";
}
