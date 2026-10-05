#!/usr/bin/env node
// plan-runner: MCP server for one change request. Tools: status, exec, verify, rollback (fixed);
// each call is checked against approval and execution state and errors when invalid.
// Runs inside the executor beam next to a tbot holding the per-CR bot identity; served over
// streamable HTTP as a plain Teleport HTTP app.
//
//   node server.js --cr <request-id> --identity /home/beams/bot-id/identity \
//     --proxy flat-pine.beams.sh:443 --cluster flat-pine.beams.sh \
//     [--kubeconfig /home/beams/kube/kubeconfig.yaml] [--allow kubectl,tctl] \
//     [--port 8080] [--insecure-caller-header]

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { ApprovalGate, DevApprovalGate, DiscoveringGate } from "./approval";
import { CallerVerifier, InsecureHeaderVerifier, type Caller } from "./identity";
import { execCommand } from "./exec";
import { CRState, toolName, type Operation } from "./state";
import { STATUS_TOOL } from "../shared/cr";

const { values: args } = parseArgs({
  options: {
    cr: { type: "string" },
    identity: { type: "string" },
    proxy: { type: "string", default: process.env.CR_PROXY ?? "flat-pine.beams.sh:443" },
    cluster: { type: "string" },
    kubeconfig: { type: "string" },
    allow: { type: "string", default: "kubectl,tctl" },
    "approval-role": { type: "string", default: "oncall-change" },
    port: { type: "string", default: "8080" },
    "path-prepend": { type: "string", default: "/home/beams/bin" },
    "insecure-caller-header": { type: "boolean", default: false },
    // Script mode: execute the approved steps in order with no caller, then exit.
    // Same gate, same audit; only who pulls the trigger changes.
    auto: { type: "boolean", default: false },
    // Register-then-request mode: start from the deployed CR file; discover the Access Request
    // that names this executor (--executor bot name) filed by --requester.
    "cr-file": { type: "string" },
    executor: { type: "string" },
    requester: { type: "string" },
    // Local dev only: load the CR from a file and treat it as approved. Never in a beam.
    "insecure-cr-file": { type: "string" },
  },
});

const devMode = Boolean(args["insecure-cr-file"]);
const discoverMode = Boolean(args["cr-file"] && args.executor && args.requester);
if (!devMode && !discoverMode && !(args.cr && args.identity)) {
  console.error("usage: server --cr-file cr.yaml --executor <bot> --requester <user> --identity <bot identity> [--proxy host:443] [--kubeconfig f] [--allow kubectl] [--auto]");
  console.error("       server --cr <request-id> --identity <bot identity file> ...   (request-first mode)");
  console.error("   dev: server --cr dev --insecure-cr-file demo/cr.yaml --insecure-caller-header --allow true,false,echo");
  process.exit(2);
}
if (!args.cr) args.cr = args.executor ?? "dev";

const proxy = args.proxy!;
const proxyHost = proxy.replace(/:\d+$/, "");
const cluster = args.cluster ?? proxyHost;
const allowed = args.allow!.split(",").map((s) => s.trim()).filter(Boolean);

const gate = devMode
  ? new DevApprovalGate(args["insecure-cr-file"]!, allowed)
  : discoverMode
    ? new DiscoveringGate({
        crFile: args["cr-file"]!,
        executorBot: args.executor!,
        requester: args.requester!,
        identity: args.identity!,
        proxy,
        approvalRole: args["approval-role"]!,
        allowedExecutables: allowed,
      })
    : new ApprovalGate({
        requestId: args.cr!,
        identity: args.identity!,
        proxy,
        approvalRole: args["approval-role"]!,
        allowedExecutables: allowed,
      });
const verifier = args["insecure-caller-header"] ? new InsecureHeaderVerifier() : new CallerVerifier(proxyHost, cluster);

const initial = await gate.status();
const state = new CRState(initial.cr);
const requester = args.requester ?? initial.request.user;
let approved = initial.approved;
let approvalNote = initial.reason;
let requestId: string = initial.request.id || args.cr!;
log("info", "loaded change request", { executor: args.executor, request: requestId || "(none yet)", requester, approved, note: approvalNote, steps: state.cr.steps.map((s) => s.name) });

// ---- MCP sessions: fixed tool set (status, exec, verify, rollback); guards live in the handler ----

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  caller: Caller;
}
const sessions = new Map<string, Session>();

let inflight: { op: Operation; step: string; kind: string; since: string; caller: string } | undefined;

function statusJson() {
  return state.status({
    approved,
    approvalNote,
    request: requestId || null,
    executor: args.executor ?? null,
    requester,
    available: approved && !inflight ? state.availableOperations() : [],
    inflight: inflight ?? null,
    updated_at: new Date().toISOString(),
  });
}

const DESCRIBE: Record<Operation, string> = {
  execute: "Execute the next pending step of this change request (its run command, then its verify). Errors if the request is not approved, the change is COMPLETE or terminal, or a command is still running.",
  verify: "Re-run the verify command of the most recent completed step. Errors if no step has completed yet.",
  rollback: "Undo the most recent completed step with its rollback command; call repeatedly to unwind further. Errors unless the change is FAILED, COMPLETE or ROLLING_BACK.",
};

function newSession(transport: StreamableHTTPServerTransport, caller: Caller): Session {
  const server = new McpServer({ name: `plan-runner:${args.cr!.slice(0, 8)}`, version: "0.1.0" });
  const sess: Session = { server, transport, caller };
  server.registerTool(
    STATUS_TOOL,
    { description: "Current phase, steps, approval state, running command, and the operations that would succeed right now.", inputSchema: {} },
    async () => {
      await refreshApproval();
      return { content: [{ type: "text", text: JSON.stringify(statusJson(), null, 2) }] };
    },
  );
  for (const op of ["execute", "verify", "rollback"] as Operation[]) {
    server.registerTool(
      toolName(op),
      {
        description: DESCRIBE[op],
        inputSchema: {
          confirm: z.literal(true).describe("Set to true to perform this operation."),
          expect: z.string().optional().describe("Optional guard: the step name you expect this operation to act on. Refused if the server's cursor points elsewhere."),
        },
      },
      async (input: { confirm: true; expect?: string }) => runOperation(op, sess.caller, input?.expect),
    );
  }
  return sess;
}

async function runOperation(op: Operation, caller: Caller | undefined, expect?: string) {
  if (!caller) return deny("no caller identity");
  let approval;
  try {
    approval = await gate.require();
  } catch (e) {
    return deny(`not approved: ${(e as Error).message}`);
  }
  // No caller-identity check here: Teleport bots can't file Access Requests (confirmed live --
  // "can not request role", independent of role grants), so the request is filed as the human
  // requester while the actual caller is the investigation bot driving it on their behalf. The
  // real gate is Teleport RBAC itself -- investigator-executor-access's app_labels, templated on
  // a trait only set after approval, decides who can even open a session to this app at all
  // (terraform/roles.tf, cli/tui.ts's fetchLive()). caller.username is still recorded below for
  // the audit trail, just not compared against the requester.
  if (inflight) return deny(`${inflight.op} of step ${inflight.step} (${inflight.kind}) is still running since ${inflight.since}; one operation at a time`);
  const cmds = state.plan(op);
  if (cmds.length === 0) return deny(`${op} is not valid in phase ${state.phase} (valid now: ${state.availableOperations().join(", ") || "none"})`);
  if (expect && cmds[0].step.name !== expect) {
    return deny(`${op} would act on step "${cmds[0].step.name}", not "${expect}"`);
  }

  // The result is the operator's record of what happened: who asked, which identity acted,
  // the exact argv, exit code, duration and output of each command, and where to find it in the audit log.
  const who = args.executor ? `bot-${args.executor}` : "executor";
  const out: string[] = [
    `${op} · step ${cmds[0].step.name} · requested by ${caller.username} · executed as ${who} · ${new Date().toISOString()}`,
  ];
  let isError = false;
  try {
    for (const cmd of cmds) {
      inflight = { op, step: cmd.step.name, kind: cmd.kind, since: new Date().toISOString(), caller: caller.username };
      const res = await execCommand(
        cmd.command,
        { allowedExecutables: allowed, kubeconfig: args.kubeconfig, identity: args.identity, proxy, pathPrepend: args["path-prepend"] ? [args["path-prepend"]] : [] },
        cmd.stdin,
      );
      const cont = state.record(op, cmd, caller.username, res.code);
      log("audit", "command executed", { cr: args.cr, op, step: cmd.step.name, kind: cmd.kind, caller: caller.username, argv: res.argv, code: res.code, ms: res.durationMs, phase: state.phase });
      if (res.code !== 0 && res.stderr.includes("access denied")) log("audit", "RBAC denied the bot; check the executor role", { cr: args.cr, step: cmd.step.name });
      const status = res.code === 0 ? "ok" : `FAILED (exit ${res.code})`;
      out.push("", `▶ ${cmd.step.name}.${cmd.kind}  ${status}  ${(res.durationMs / 1000).toFixed(1)}s`, `  $ ${res.argv.map(redactArg).join(" ")}`);
      const body = [res.stdout.trimEnd(), res.stderr.trim() ? `stderr: ${res.stderr.trimEnd()}` : ""].filter(Boolean).join("\n");
      out.push(...(body ? body.split("\n").map((l) => `  ${l}`) : ["  (no output)"]));
      if (res.code !== 0 && res.stderr.includes("access denied")) out.push("  → Teleport RBAC denied the executor bot; the executor role does not allow this");
      if (!cont) {
        isError = true;
        break;
      }
    }
  } finally {
    inflight = undefined;
  }
  const next = state.nextStepIndex();
  out.push(
    "",
    `phase: ${state.phase} · available: ${state.availableOperations().join(", ") || "(none)"}` +
      (state.phase === "IN_PROGRESS" && next !== undefined ? ` · next exec: ${state.cr.steps[next].name}` : ""),
    `audit: kube.request events by ${who} on this cluster; app.session.* by ${caller.username} on the executor app; request ${approval.request.id}`,
  );
  return { content: [{ type: "text" as const, text: out.join("\n") }], isError };
}

function deny(reason: string) {
  log("audit", "denied", { cr: args.cr, reason });
  return { content: [{ type: "text" as const, text: `DENIED: ${reason}` }], isError: true };
}

let refreshing: Promise<void> | undefined;
function refreshApproval(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      gate.invalidate();
      const s = await gate.status();
      if (s.request.id && s.request.id !== requestId) {
        requestId = s.request.id;
        log("audit", "access request found for this executor", { request: requestId, state: s.request.state });
      }
      if (s.approved !== approved || s.reason !== approvalNote) {
        approved = s.approved;
        approvalNote = s.reason;
        log("audit", approved ? "request approved" : "request not approved", { request: requestId, note: approvalNote });
      }
    } catch (e) {
      log("warn", "approval poll failed", { error: (e as Error).message });
    } finally {
      refreshing = undefined;
    }
  })();
  return refreshing;
}
setInterval(() => void refreshApproval(), 10_000).unref();

// ---- HTTP transport ----------------------------------------------------------

const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/healthz") return json(res, 200, { ok: true, phase: state.phase, approved, inflight: inflight ?? null, cr: args.cr });
  if (url.pathname === "/status") return json(res, 200, statusJson());
  if (url.pathname !== "/mcp") return json(res, 404, { error: "not found" });

  let caller: Caller;
  try {
    const header = args["insecure-caller-header"] ? req.headers["x-debug-caller"] : req.headers["teleport-jwt-assertion"];
    caller = await verifier.verify(Array.isArray(header) ? header[0] : header);
  } catch (e) {
    log("audit", "rejected request", { reason: (e as Error).message });
    return json(res, 401, { error: (e as Error).message });
  }
  // No caller-vs-requester check here either, for the same reason as runOperation() above:
  // Teleport RBAC (investigator-executor-access) is what actually restricts who can reach this
  // app at all; requester is still used to discover this executor's own Access Request.

  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let sess = sessionId ? sessions.get(sessionId) : undefined;
  if (!sess) {
    if (req.method !== "POST") return json(res, 400, { error: "no session; initialize with POST first" });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, sess!);
      },
    });
    sess = newSession(transport, caller);
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await sess.server.connect(transport);
  } else {
    sess.caller = caller;
  }
  try {
    await sess.transport.handleRequest(req, res);
  } catch (e) {
    log("warn", "mcp request failed", { error: (e as Error).message });
    if (!res.headersSent) json(res, 500, { error: (e as Error).message });
  }
});

process.on("uncaughtException", (e) => log("error", "uncaught", { error: e.message, stack: e.stack }));
process.on("unhandledRejection", (e) => log("error", "unhandled rejection", { error: String(e) }));

const port = Number(args.port);
http.listen(port, "0.0.0.0", () => log("info", "plan-runner listening", { port, path: "/mcp", cr: args.cr, auto: args.auto }));

if (args.auto) {
  // Deterministic runner: wait for approval, then verify a step that just ran,
  // otherwise run the next step, otherwise roll back. Acts as the requester on record.
  const autoCaller: Caller = { username: requester, roles: [] };
  while (!approved) {
    log("info", "auto: waiting for approval", { note: approvalNote });
    await new Promise((r) => setTimeout(r, 10_000));
  }
  for (let i = 0; i < 100 && !state.isTerminal() && state.phase !== "COMPLETE"; i++) {
    const ops = state.availableOperations();
    const next: Operation | undefined = ops.includes("execute") ? "execute" : state.phase === "FAILED" || state.phase === "ROLLING_BACK" ? (ops.includes("rollback") ? "rollback" : undefined) : undefined;
    if (!next) {
      log("error", "no operation available and not terminal", { phase: state.phase });
      break;
    }
    const res = await runOperation(next, autoCaller);
    log("info", "auto operation", { op: next, isError: (res as any).isError === true, phase: state.phase });
  }
  log("info", "auto run finished", { phase: state.phase });
  http.close();
  process.exit(state.phase === "COMPLETE" ? 0 : 1);
}

function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function log(level: string, msg: string, fields: Record<string, unknown> = {}) {
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }) + "\n");
}

/** Hide the kubeconfig / identity paths the executor binds into every command; the operator asked for the step, not the plumbing. */
function redactArg(a: string): string {
  return a.replace(/^(--kubeconfig=|--identity=)\S+$/, "$1…");
}
