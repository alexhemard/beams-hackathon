#!/usr/bin/env node
// Investigator: runs INSIDE the investigation beam. A pi-agent-core agent with
// read-only kubectl tools (bound to the investigator bot's kubeconfig) and a
// submit_change_request tool that writes the CR file.
//
//   node investigate.mjs --alert alert.json --prompt prompt.md --runbooks ./runbooks --kubeconfig kubeconfig.yaml [--out cr.yaml]
//
// The change request is a FILE (--out, /home/beams/investigate/cr.yaml in the beam). The
// laptop pulls it with `tsh beams scp`; every revision rewrites it. After the first draft the
// agent stays alive as a conversation on its tmux stdin: the on-call attaches and types, or the
// TUI types for them with `tmux send-keys`. Follow-ups may investigate further and revise the CR
// (the tool may be called again). Operator edits pushed into the CR file are noticed before each
// turn. `/quit` ends the session.
//
// Inference goes through the beam's Teleport LLM proxy: $ANTHROPIC_BASE_URL is
// set by the beam and the proxy injects the real key, so any api key works.

import { parseArgs } from "node:util";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { CallerVerifier, InsecureHeaderVerifier } from "../plan-runner/identity";
import { Agent, type AgentTool, type AgentToolResult } from "@earendil-works/pi-agent-core";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Type, type Model, type Api } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { CRSchema, parseCR, serializeCR, validateChangeSemantics, validateCommands, verifyNotes, toArgv, type CR } from "../shared/cr";
import { TRUSTED_BOT_USERNAME } from "../shared/teleport";
import bundledPrompt from "./prompt.md"; // fallback copy baked into the bundle at build time

const { values: args } = parseArgs({
  options: {
    alert: { type: "string" },
    runbooks: { type: "string", default: "./runbooks" },
    kubeconfig: { type: "string" },
    kubectl: { type: "string", default: "kubectl" },
    /** path to the investigation bot's own renewed identity (bot-id/identity); audit_find_change is unavailable without it */
    identity: { type: "string" },
    tctl: { type: "string", default: "tctl" },
    out: { type: "string", default: "cr.yaml" },
    /** Markdown system prompt with {{alert_name}} / {{runbook}} placeholders (investigator/prompt.md) */
    prompt: { type: "string", default: "./prompt.md" },
    model: { type: "string", default: process.env.CR_MODEL ?? "anthropic/claude-sonnet-5" },
    // The beam's LLM proxy fronts a Bedrock model that rejects legacy `thinking.type: enabled`;
    // "off" sends no thinking block. Override with --thinking low|medium|high if the model supports it.
    thinking: { type: "string", default: process.env.CR_THINKING ?? "off" },
    "max-turns": { type: "string", default: "25" },
    /** exit right after the first draft instead of staying interactive */
    once: { type: "boolean", default: false },
    /** who this beam is (alias, owner, kube cluster, proxy): written by the laptop into the init archive */
    self: { type: "string" },
    /** HTTP API for the TUI (state, events, message, draft); published as a Teleport app */
    port: { type: "string", default: "8080" },
    /** dev only: trust X-Debug-Caller instead of the Teleport JWT */
    "insecure-caller": { type: "boolean", default: false },
  },
});
if (!args.alert) {
  console.error("usage: investigate --alert alert.json [--prompt f] [--runbooks dir] [--kubeconfig f] [--out cr.yaml]");
  process.exit(2);
}

const alert = JSON.parse(readFileSync(args.alert, "utf8"));
const self: { alias?: string; owner?: string; kubeCluster?: string; proxy?: string } = args.self && existsSync(args.self) ? JSON.parse(readFileSync(args.self, "utf8")) : {};
const alertName: string = alert?.labels?.alertname ?? "unknown";
const runbooks = loadRunbooks(args.runbooks!, alertName);
const OUT = args.out!;

// ---- model via the beam's LLM proxy -----------------------------------------
const [provider, modelId] = args.model!.split("/");
const models = builtinModels();
// Unknown ids fall back to the provider's first catalog entry but keep the requested id,
// so the proxy sees exactly the model name we asked for.
const known = models.getModel(provider, modelId);
const base = known ?? models.getModels(provider)[0];
if (!base) throw new Error(`no model for ${args.model}`);
const baseUrl = provider === "anthropic" ? process.env.ANTHROPIC_BASE_URL : process.env.OPENAI_BASE_URL;
const model: Model<Api> = { ...base, id: known ? base.id : modelId, ...(baseUrl ? { baseUrl: baseUrl.replace(/\/$/, "") } : {}) };

// ---- tools -----------------------------------------------------------------
const READ_ONLY_VERBS = new Set(["get", "describe", "logs", "top", "explain", "api-resources", "rollout"]);

const kubectlTool: AgentTool<any> = {
  name: "kubectl",
  label: "kubectl (read-only)",
  description:
    "Run a read-only kubectl command against the affected cluster. Allowed subcommands: get, describe, logs, top, explain, api-resources, rollout status/history. Pass arguments as a single string, e.g. \"-n emailpals get pods -o wide\". Never pass --kubeconfig.",
  parameters: Type.Object({ args: Type.String({ description: "kubectl arguments" }) }),
  execute: async (_id, params: any) => {
    const argv = toArgv(String(params.args ?? ""));
    const verb = argv.find((a) => READ_ONLY_VERBS.has(a));
    if (!verb || (verb === "rollout" && !["status", "history"].includes(argv[argv.indexOf("rollout") + 1] ?? ""))) {
      return { content: [{ type: "text", text: `refused: only read-only kubectl subcommands are allowed (${[...READ_ONLY_VERBS].join(", ")})` }], details: { refused: true } };
    }
    if (argv.some((a) => a === "--raw" || a.startsWith("--kubeconfig"))) {
      return { content: [{ type: "text", text: "refused: --raw and --kubeconfig are not allowed" }], details: { refused: true } };
    }
    const r = await run([args.kubectl!, ...(args.kubeconfig ? [`--kubeconfig=${args.kubeconfig}`] : []), ...argv]);
    const text = `exit ${r.code}\n${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}`.slice(0, 12_000);
    return { content: [{ type: "text", text }], details: { argv, code: r.code } };
  },
};

// kube_request audit events are retained for one of these windows; pick the smallest that covers
// how far back we need to look (tctl rejects any other value).
const AUDIT_DAY_BUCKETS = [7, 30, 90, 120];
function auditDays(sinceMs: number): number {
  const days = Math.ceil((Date.now() - sinceMs) / 86_400_000) + 1;
  return AUDIT_DAY_BUCKETS.find((d) => d >= days) ?? 120;
}
function sqlLit(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// Root-cause attribution: who (human or bot identity) made a recent write against the cluster's
// Kubernetes API, per Teleport's own audit log (kube_request events), not the cluster's state.
// Needs the "operator" role's audit_query/use grant (terraform/roles.tf) and the investigation
// bot's own identity -- a single API call, no cert reissue, so the bot's renewed identity
// (bot-id/identity) works the same way kubectl does.
const auditTool: AgentTool<any> = {
  name: "audit_find_change",
  label: "audit log: who changed it",
  description:
    "Search the Teleport audit log's kube_request events (every Kubernetes API call Teleport proxied, successful or not) to find which identity -- a human user or a bot -- made a recent write (PATCH/PUT/POST/DELETE) that could be the root cause. This is Teleport's record of who did it, independent of and often more reliable than cluster state (which only shows the result). Use it when the cause might be a recent human or automated change rather than an organic failure (capacity, upstream, crash).",
  parameters: Type.Object({
    namespace: Type.Optional(Type.String({ description: "restrict to this Kubernetes namespace" })),
    resourceKind: Type.Optional(Type.String({ description: "restrict to this resource kind, e.g. deployments, pods, secrets, configmaps" })),
    resourceName: Type.Optional(Type.String({ description: "restrict to this exact resource name" })),
    sinceMinutes: Type.Optional(Type.Number({ description: "how far back to look, in minutes (default: since the alert fired, padded by 30 minutes, or 60 if that can't be determined)" })),
    includeReads: Type.Optional(Type.Boolean({ description: "include GET/WATCH/LIST too, not just writes (default false)" })),
    limit: Type.Optional(Type.Number({ description: "max rows, 1-100 (default 20)" })),
  }),
  execute: async (_id, p: any) => {
    if (!args.identity) {
      return { content: [{ type: "text", text: "audit log lookup is not available in this investigation (no bot identity configured for it)." }], details: { error: true } };
    }
    const alertSinceMs = alert?.startsAt ? Date.parse(alert.startsAt) : NaN;
    const minutes = Number(p?.sinceMinutes) > 0 ? Number(p.sinceMinutes) : Number.isFinite(alertSinceMs) ? Math.max(30, Math.round((Date.now() - alertSinceMs) / 60_000) + 30) : 60;
    const sinceMs = Date.now() - minutes * 60_000;
    const since = new Date(sinceMs).toISOString(); // e.g. 2026-09-26T20:02:57.805Z
    const limit = Math.min(Math.max(Math.trunc(Number(p?.limit) || 20), 1), 100);
    // event_date/event_time are partition pseudo-columns: any WHERE comparison on them (even
    // equality) fails with "code 1002"; `time` (the plain varchar event timestamp, same format
    // as `since`) filters and sorts fine lexicographically.
    const clauses = [`time >= ${sqlLit(since)}`];
    if (!p?.includeReads) clauses.push(`verb IN ('PATCH','PUT','POST','DELETE')`);
    if (self.kubeCluster) clauses.push(`kubernetes_cluster = ${sqlLit(self.kubeCluster)}`);
    if (p?.namespace) clauses.push(`resource_namespace = ${sqlLit(String(p.namespace))}`);
    if (p?.resourceKind) clauses.push(`resource_kind = ${sqlLit(String(p.resourceKind))}`);
    if (p?.resourceName) clauses.push(`resource_name = ${sqlLit(String(p.resourceName))}`);
    const sql = `SELECT time, user, verb, resource_kind, resource_namespace, resource_name, response_code FROM kube_request WHERE ${clauses.join(" AND ")} ORDER BY time DESC LIMIT ${limit}`;
    const r = await run([args.tctl!, "audit", "query", "exec", sql, `--days=${auditDays(sinceMs)}`, "--format=json", "--identity", args.identity!, "--auth-server", self.proxy ?? "flat-pine.beams.sh:443"], 30_000);
    if (r.code !== 0) return { content: [{ type: "text", text: `audit query failed (exit ${r.code}):\n${(r.stderr || r.stdout).slice(0, 2000)}` }], details: { error: true } };
    let rows: string[][];
    try {
      rows = (JSON.parse(r.stdout) as Array<{ data: string[] }>).map((row) => row.data);
    } catch {
      return { content: [{ type: "text", text: `could not parse audit query output:\n${r.stdout.slice(0, 2000)}` }], details: { error: true } };
    }
    const [header, ...body] = rows;
    if (!body.length) return { content: [{ type: "text", text: `no matching kube_request events since ${since}.` }], details: { display: "audit: no matching events" } };
    const text = [header.join(" | "), ...body.map((row) => row.join(" | "))].join("\n");
    // Deep link into the Teleport Web UI audit log, same `/web/cluster/<cluster>/audit?search=`
    // pattern `cli/tui.ts`'s `openAudit` uses — scoped to the top row's resource name (or user,
    // if there's no resource name) so it's a search over the actual root-cause event, not just
    // the whole log. The search is fuzzy text matching, not an exact-row permalink (audit events
    // aren't individually addressable in the Web UI), so also hand back the exact SQL to re-run
    // (`tctl audit query exec`) in case the search doesn't land on the same row.
    const cluster = (self.proxy ?? process.env.TELEPORT_PROXY ?? "flat-pine.beams.sh:443").replace(/:\d+$/, "");
    const nameIdx = header.indexOf("resource_name");
    const userIdx = header.indexOf("user");
    const term = (nameIdx >= 0 && body[0][nameIdx]) || (userIdx >= 0 && body[0][userIdx]) || undefined;
    const auditUrl = `https://${cluster}/web/cluster/${cluster}/audit${term ? `?search=${encodeURIComponent(term)}` : ""}`;
    const footer = `\n\naudit log: ${auditUrl}\nexact query: tctl audit query exec ${JSON.stringify(sql)} --days=${auditDays(sinceMs)} --format=json --identity <bot identity> --auth-server ${self.proxy ?? "flat-pine.beams.sh:443"}`;
    return {
      content: [{ type: "text", text: text + footer }],
      details: { display: `audit: ${body.length} matching event(s) since ${since}`, rows: body.length, auditUrl },
    };
  },
};

let revision = 0;
let lastWrittenMtime = 0; // mtime of OUT after our own last write; a different mtime means the operator edited it
let pending: { cr: CR; yaml: string } | undefined; // a proposed revision waiting for the operator's yes

// ---- events: the structured transcript served to the TUI; stdout keeps the human copy for tmux / recording
type EventType = "assistant" | "operator" | "tool_start" | "tool_end" | "note";
interface Event {
  seq: number;
  at: string;
  type: EventType;
  text: string;
  tool?: string;
  args?: unknown;
  isError?: boolean;
}
const events: Event[] = [];
let seq = 0;
let streaming = ""; // assistant text of the message in progress
const startedAt = new Date().toISOString();
function emit(type: EventType, text: string, extra: Partial<Event> = {}): void {
  events.push({ seq: ++seq, at: new Date().toISOString(), type, text, ...extra });
  if (events.length > 4000) events.splice(0, events.length - 4000);
}
function note(text: string): void {
  emit("note", text);
  process.stdout.write(`\n${text}\n`);
}

function writeCR(yaml: string) {
  revision++;
  writeFileSync(OUT, yaml);
  lastWrittenMtime = statSync(OUT).mtimeMs;
  note(`CR-WRITTEN rev=${revision} path=${OUT}`);
}

// The first draft is written immediately. Every later call is a PROPOSAL: the YAML is shown to
// the operator and nothing is written until they confirm (confirm_change_request).
const submitTool: AgentTool<any> = {
  name: "submit_change_request",
  label: "write / propose change request",
  description:
    "Write the change request once the root cause is understood. Each step is one state-changing operation (run), the operation that returns to the previous state (rollback), and a verify: a blocking, read-only assertion that the state the step intended to reach has been reached, exiting non-zero otherwise. Reads are not steps. Use only the tools and operations the runbooks allow. Keep it to the minimal reversible fix. The first call writes the file. Later calls only PROPOSE a revision: the YAML is shown to the operator and you must ask whether to proceed; call confirm_change_request after an explicit yes, or drop it if they say no.",
  parameters: Type.Object({
    summary: Type.String({ description: "one line: what is wrong and what the change does" }),
    risk: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
    steps: Type.Array(
      Type.Object({
        name: Type.String({ description: "short kebab-case name" }),
        run: Type.String({ description: "the state-changing command" }),
        rollback: Type.String({ description: "the command that returns to the state before run" }),
        verify: Type.String({
          description:
            "Waits for and asserts the intended state, with a timeout: `kubectl wait --for=jsonpath='{<field run changed>}'=<new value> ... --timeout=90s`, `kubectl wait --for=condition=Available ...`, or `kubectl rollout status ... --timeout=90s`. Exit code is the verdict. `get`, `describe` and `logs` always exit 0 and verify nothing.",
        }),
      }),
      { minItems: 1, maxItems: 6 },
    ),
  }),
  execute: async (_id, params: any) => {
    // associate the CR with the alert it answers (not left to the model)
    const alertRef = { name: alertName, fingerprint: alert?.fingerprint, namespace: alert?.labels?.namespace, since: alert?.startsAt };
    const cr = CRSchema.parse({ kind: "change-request", ...params, alert: alertRef });
    validateCommands(cr, ["kubectl"]);
    validateChangeSemantics(cr); // run/rollback must change state; verify must be read-only
    const yaml = serializeCR(cr);
    if (revision === 0) {
      writeCR(yaml);
      const notes = verifyNotes(cr);
      return { content: [{ type: "text", text: `change request written to ${OUT} (revision ${revision}, ${Buffer.byteLength(yaml)} bytes).${notes.length ? ` Note for your summary: ${notes.join("; ")}.` : ""} It is already written: do not ask whether to proceed. Summarize it for the operator in two or three lines and wait for feedback.` }], details: { path: OUT, revision, display: `change request written (revision ${revision})${notes.length ? ` · ${notes.join("; ")}` : ""}` } };
    }
    pending = { cr, yaml };
    process.stdout.write(`\n---PROPOSED-CR---\n${yaml}---END-PROPOSED-CR---\n`);
    emit("note", `proposed revision ${revision + 1} (not written until you say yes)`);
    return {
      content: [{ type: "text", text: `Proposed revision shown to the operator (not written). Ask them plainly: "Proceed and write this as revision ${revision + 1}? (yes/no)". Call confirm_change_request only after an explicit yes.` }],
      details: { proposed: true, display: `proposed revision ${revision + 1} (not written until you say yes)` },
    };
  },
};

const confirmTool: AgentTool<any> = {
  name: "confirm_change_request",
  label: "write the proposed revision",
  description: "Write the currently proposed revision to the change request file. Only call this after the operator explicitly agreed to proceed.",
  parameters: Type.Object({}),
  execute: async () => {
    if (!pending) return { content: [{ type: "text", text: "nothing is proposed; call submit_change_request first" }], details: { written: false } };
    const { yaml } = pending;
    pending = undefined;
    writeCR(yaml);
    return { content: [{ type: "text", text: `revision ${revision} written to ${OUT}.` }], details: { written: true, revision, display: `revision ${revision} written` } };
  },
};

// Some alerts need no change (transient, already recovered, noise). That is a first-class outcome:
// the conclusion is written next to the CR file and a marker tells the laptop to stop waiting.
let concluded = false;
let conclusion: string | undefined;
const concludeTool: AgentTool<any> = {
  name: "conclude_no_change",
  label: "conclude: no change needed",
  description:
    "Use instead of submit_change_request when the alert needs no change: it was transient and has recovered, it is noise, or any fix would be riskier than the symptom. Give the evidence. The operator can still ask follow-up questions afterwards.",
  parameters: Type.Object({
    summary: Type.String({ description: "one line: what happened and why no change is needed" }),
    evidence: Type.String({ description: "the observations that support it (what you ran and saw)" }),
    watch: Type.Optional(Type.String({ description: "what would change the conclusion (what to watch for)" })),
  }),
  execute: async (_id, params: any) => {
    const text = `# No change needed\n\n${params.summary}\n\n## Evidence\n\n${params.evidence}\n${params.watch ? `\n## Watch for\n\n${params.watch}\n` : ""}`;
    writeFileSync(join(OUT, "..", "conclusion.md"), text);
    concluded = true;
    conclusion = String(params.summary).replace(/\s+/g, " ").slice(0, 300);
    note(`NO-CHANGE ${conclusion}`);
    return { content: [{ type: "text", text: "conclusion recorded. Tell the operator in two or three lines and wait; they may still ask questions or ask you to reconsider." }], details: { concluded: true, display: "conclusion recorded: no change needed" } };
  },
};

// ---- the executor: another beam's MCP server, published as a Teleport app; reached over this beam's app access
let executorUrl: string | undefined;
const EXECUTOR_URL = /^https:\/\/[a-z0-9.-]+\/mcp$/i;

async function callExecutor(op: "status" | "exec" | "verify" | "rollback", params: { url?: string; expect?: string } = {}): Promise<AgentToolResult<any>> {
  if (params.url && EXECUTOR_URL.test(params.url)) executorUrl = params.url;
  if (!executorUrl) return { content: [{ type: "text", text: "no executor known yet: submit_for_approval registers one, or pass the URL the operator gave you (https://<app>.<proxy>/mcp)" }], details: { error: true } };
  const client = new McpClient({ name: "investigator", version: "0.1.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(executorUrl)));
    const args = op === "status" ? {} : { confirm: true, ...(params.expect ? { expect: params.expect } : {}) };
    const r = await client.callTool({ name: op, arguments: args }, undefined, { timeout: 15 * 60_000 });
    const text = ((r as any).content ?? []).map((c: any) => c.text ?? "").join("\n");
    return { content: [{ type: "text", text: text || "(no output)" }], details: { op, isError: (r as any).isError === true } };
  } catch (e) {
    return { content: [{ type: "text", text: `executor call failed: ${(e as Error).message}` }], details: { error: true } };
  } finally {
    await client.close().catch(() => {});
  }
}

const executorParams = Type.Object({
  url: Type.Optional(Type.String({ description: "executor MCP URL; only needed if none is known yet" })),
  expect: Type.Optional(Type.String({ description: "step name you expect this to act on; refused if the executor's cursor points elsewhere" })),
});
const STATE_NOTE = " A call the state does not allow (not approved, COMPLETE, out of order, a command still running) returns an error saying why: report it, do not retry.";
const executorTools: AgentTool<any>[] = [
  {
    name: "executor_status",
    label: "executor: status",
    description: "The executor's phase, steps, approval state, running command and which operations would succeed now. Always allowed.",
    parameters: Type.Object({ url: Type.Optional(Type.String({ description: "executor MCP URL; only needed if none is known yet" })) }),
    execute: async (_id, p: any) => callExecutor("status", p ?? {}),
  },
  {
    name: "executor_exec",
    label: "executor: exec",
    description: "Run the NEXT pending step (its run, then its verify), once and in order." + STATE_NOTE,
    parameters: executorParams,
    execute: async (_id, p: any) => callExecutor("exec", p ?? {}),
  },
  {
    name: "executor_verify",
    label: "executor: verify",
    description: "Re-run the verify of the most recent completed step." + STATE_NOTE,
    parameters: executorParams,
    execute: async (_id, p: any) => callExecutor("verify", p ?? {}),
  },
  {
    name: "executor_rollback",
    label: "executor: rollback",
    description: "Undo the most recent completed step with its rollback command; call again to unwind further." + STATE_NOTE,
    parameters: executorParams,
    execute: async (_id, p: any) => callExecutor("rollback", p ?? {}),
  },
];

const connectExecutorTool: AgentTool<any> = {
  name: "connect_executor",
  label: "set the executor URL",
  description: "Remember the executor's MCP URL (from the operator) and check it answers. Not needed after submit_for_approval, which sets it.",
  parameters: Type.Object({ url: Type.String({ description: "https://<app>.<proxy>/mcp" }) }),
  execute: async (_id, p: any) => {
    const url = String(p?.url ?? "");
    if (!EXECUTOR_URL.test(url)) return { content: [{ type: "text", text: `need an executor URL like https://<app>.<proxy>/mcp (got ${url || "nothing"})` }], details: { error: true } };
    executorUrl = url;
    const r = await callExecutor("status");
    return { ...r, details: { ...r.details, display: (r.details as any).error ? `executor ${url}: not reachable` : `executor ${url}: connected` } };
  },
};

// ---- submitting: one-off op from this beam (submit-cr.sh: beam, bot, token, archive, bootstrap, publish, request)
let filed: { requestId: string; beam: string; bot: string; app: string; appUrl: string; mcpUrl: string } | undefined;
let submitProgress: { step: number; beam?: string; bot?: string; app?: string; error?: string } | undefined;
function trackSubmit(line: string): void {
  const p = submitProgress ?? (submitProgress = { step: 0 });
  p.beam = line.match(/executor beam (\S+) created/)?.[1] ?? p.beam;
  p.bot = line.match(/create executor bot (cr-[0-9a-f]+)/)?.[1] ?? p.bot;
  p.app = line.match(/published app (\S+)/)?.[1] ?? p.app;
  const at = (re: RegExp, step: number) => re.test(line) && (p.step = Math.max(p.step, step));
  at(/create executor bot/, 1);
  at(/ship the executor|bootstrap the executor/, 2);
  at(/publish the executor/, 3);
  at(/file the Access Request/, 4);
}
const submitForApprovalTool: AgentTool<any> = {
  name: "submit_for_approval",
  label: "submit the change request for approval",
  description:
    "Register the executor for the current change request file and file it as a Teleport Access Request, from this beam. Only when the operator asks to submit. Takes a few minutes. Returns the request id and the executor's MCP URL; exec/verify/rollback error until a reviewer approves.",
  parameters: Type.Object({}),
  execute: async () => {
    if (revision === 0) return { content: [{ type: "text", text: "no change request file written yet" }], details: { error: true } };
    if (!self.alias || !self.owner) return { content: [{ type: "text", text: "self.json (beam alias, owner) missing; cannot submit from here" }], details: { error: true } };
    submitProgress = { step: 0 };
    const r = await run(["bash", join(OUT, "..", "submit-cr.sh"), OUT, self.alias, self.owner, self.kubeCluster ?? "emailpals-production"], 15 * 60_000, true, (l) => {
      if (!l.startsWith("▶")) return;
      trackSubmit(l);
      emit("note", l);
      process.stdout.write(`    ${l}\n`);
    });
    const line = r.stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop();
    if (r.code !== 0 || !line) {
      submitProgress = { ...(submitProgress ?? { step: 0 }), error: r.stderr.trim().split("\n").pop() ?? `exit ${r.code}` };
      return { content: [{ type: "text", text: `submit failed (exit ${r.code}):\n${r.stderr.slice(-3000)}` }], details: { error: true } };
    }
    filed = JSON.parse(line);
    submitProgress = undefined;
    executorUrl = filed!.mcpUrl;
    note(`CR-FILED ${filed!.requestId} executor=${filed!.beam} bot=${filed!.bot} app=${filed!.app}`);
    return {
      content: [{ type: "text", text: `SUBMITTED. Access Request ${filed!.requestId} is filed and PENDING. Executor: beam ${filed!.beam}, bot ${filed!.bot}, app ${filed!.app}, MCP ${filed!.mcpUrl} (remembered; executor_* tools use it). Tell the operator the request id, then wait.` }],
      details: { ...filed, display: `Access Request ${filed!.requestId} filed · executor ${filed!.beam} (bot ${filed!.bot}, app ${filed!.app})` },
    };
  },
};

const readTool: AgentTool<any> = {
  name: "read_change_request",
  label: "read change request file",
  description: "Read the current change request file. The operator may have edited it; read it before revising.",
  parameters: Type.Object({}),
  execute: async () => ({ content: [{ type: "text", text: existsSync(OUT) ? readFileSync(OUT, "utf8") : "(no change request written yet)" }], details: { display: "read the change request file" } }),
};

// ---- agent -----------------------------------------------------------------
// The prompt lives in Markdown so anyone can edit it (investigator/prompt.md, copied into the beam).
const systemPrompt = loadPrompt(args.prompt!)
  .replaceAll("{{alert_name}}", alertName)
  .replaceAll("{{runbooks}}", runbooks)
  .replaceAll("{{runbook}}", runbooks); // older prompt files

const agent = new Agent({
  initialState: {
    systemPrompt,
    model,
    thinkingLevel: args.thinking as any,
    tools: [kubectlTool, auditTool, submitTool, confirmTool, concludeTool, readTool, submitForApprovalTool, connectExecutorTool, ...executorTools],
    messages: [],
  },
  streamFn: models.streamSimple.bind(models),
  getApiKey: () => process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY ?? "beam",
  toolExecution: "sequential",
});

const flushAssistant = () => {
  if (streaming.trim()) emit("assistant", streaming.trimEnd());
  streaming = "";
};

agent.subscribe((ev) => {
  if (process.env.CR_DEBUG) process.stderr.write(`[event] ${ev.type} ${JSON.stringify((ev as any).assistantMessageEvent?.type ?? (ev as any).message?.role ?? "")}\n`);
  if (ev.type === "message_end" && (ev as any).message?.role === "assistant") {
    const m = (ev as any).message;
    flushAssistant();
    if (m.stopReason === "error" || m.errorMessage) {
      process.stderr.write(`\n[model error] ${m.errorMessage ?? m.stopReason}\n`);
      emit("note", `model error: ${m.errorMessage ?? m.stopReason}`, { isError: true });
    }
  }
  if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
    const delta = (ev.assistantMessageEvent as any).delta ?? "";
    streaming += delta;
    process.stdout.write(delta);
  } else if (ev.type === "tool_execution_start") {
    flushAssistant();
    const name = (ev as any).toolName ?? "tool";
    const a = (ev as any).args ?? {};
    const showArgs = name === "kubectl" || name.startsWith("executor");
    process.stdout.write(`\n▶ ${name}${showArgs ? " " + JSON.stringify(a) : ""}\n`);
    emit("tool_start", showArgs ? JSON.stringify(a) : "", { tool: name, args: a });
  } else if (ev.type === "tool_execution_end") {
    const r = (ev as any).result;
    const display = r?.details?.display;
    const txt = typeof display === "string" ? display : (r?.content?.map((c: any) => c.text).join("\n") ?? "");
    if (txt.trim()) process.stdout.write(`${indent(txt.split("\n").slice(0, 25).join("\n"))}\n`);
    emit("tool_end", txt.split("\n").slice(0, 40).join("\n"), { tool: (ev as any).toolName, isError: r?.details?.error === true || r?.details?.isError === true });
  } else if (ev.type === "turn_end") {
    flushAssistant();
    process.stdout.write("\n");
  }
});

// ---- HTTP API for the TUI: state, events, message, draft. Caller must be the beam owner.
const proxyHost = (self.proxy ?? process.env.TELEPORT_PROXY ?? "").replace(/:\d+$/, "");
const verifier = args["insecure-caller"] || !proxyHost ? new InsecureHeaderVerifier() : new CallerVerifier(proxyHost, proxyHost);
let agentBusy = true; // the first turn starts right away

function stateJson() {
  return {
    alert: { name: alertName, fingerprint: alert?.fingerprint, since: alert?.startsAt },
    startedAt,
    busy: agentBusy,
    status: concluded ? "no-change" : revision > 0 ? "drafted" : agentBusy ? "investigating" : "no-cr",
    revision,
    draft: existsSync(OUT) ? readFileSync(OUT, "utf8") : null,
    proposal: pending?.yaml ?? null,
    conclusion: conclusion ?? null,
    filed: filed ?? null,
    executorUrl: executorUrl ?? null,
    submitProgress: submitProgress ?? null,
    streaming,
    seq,
  };
}

const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/healthz") return json(res, 200, { ok: true, busy: agentBusy, revision, seq });
  try {
    const header = args["insecure-caller"] || !proxyHost ? req.headers["x-debug-caller"] : req.headers["teleport-jwt-assertion"];
    const caller = await verifier.verify(Array.isArray(header) ? header[0] : header);
    if (self.owner && caller.username !== self.owner && caller.username !== TRUSTED_BOT_USERNAME)
      return json(res, 403, { error: `only ${self.owner} may drive this investigation` });
  } catch (e) {
    return json(res, 401, { error: (e as Error).message });
  }
  if (req.method === "GET" && url.pathname === "/state") return json(res, 200, stateJson());
  if (req.method === "GET" && url.pathname === "/events") {
    const since = Number(url.searchParams.get("since") ?? "0");
    return json(res, 200, { seq, streaming, events: events.filter((e) => e.seq > since) });
  }
  if (req.method === "POST" && url.pathname === "/message") {
    const body = await readJson(req);
    const text = String(body?.text ?? "").trim();
    if (!text) return json(res, 400, { error: "text required" });
    queue.push(text);
    void drain();
    return json(res, 202, { queued: true, seq });
  }
  if (req.method === "PUT" && url.pathname === "/draft") {
    const body = await readJson(req);
    const yaml = String(body?.yaml ?? "");
    try {
      parseCR(yaml);
    } catch (e) {
      return json(res, 400, { error: (e as Error).message });
    }
    writeFileSync(OUT, yaml); // mtime differs from lastWrittenMtime: the next turn sees the operator's edit
    if (revision === 0) revision = 1;
    emit("note", "operator edited the change request file");
    return json(res, 200, { ok: true, revision });
  }
  return json(res, 404, { error: "not found" });
});
http.listen(Number(args.port), "0.0.0.0", () => process.stderr.write(`investigator api on :${args.port}\n`));

function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (d) => (data += d));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

async function turn(text: string) {
  // operator edits to the CR file since our last write become context for this turn
  if (existsSync(OUT) && lastWrittenMtime && statSync(OUT).mtimeMs !== lastWrittenMtime) {
    let note = "The operator edited the change request file since you last wrote it.";
    try {
      parseCR(readFileSync(OUT, "utf8"));
      note += " Current contents:\n" + readFileSync(OUT, "utf8");
    } catch (e) {
      note += ` It currently does not parse as a change request (${(e as Error).message}).`;
    }
    lastWrittenMtime = statSync(OUT).mtimeMs;
    text = `${note}\n\n${text}`;
  }
  try {
    await agent.prompt(text);
  } catch (e) {
    process.stderr.write(`\n[agent error] ${(e as Error).stack ?? e}\n`);
  }
  if (agent.state.errorMessage) process.stderr.write(`\n[agent state error] ${agent.state.errorMessage}\n`);
}

const queue: string[] = [];
let draining = false;
async function drain() {
  if (draining || agentBusy) return;
  draining = true;
  agentBusy = true;
  try {
    while (queue.length) {
      const msg = queue.shift()!;
      if (msg.trim() === "/quit" || msg.trim() === "/exit") {
        process.stdout.write("\nbye\n");
        process.exit(0);
      }
      process.stdout.write(`\n[operator] ${msg}\n\n`);
      emit("operator", msg);
      await turn(msg);
      process.stdout.write("> ");
    }
  } finally {
    draining = false;
    agentBusy = false;
  }
}

await turn(`Alert fired:\n${JSON.stringify(alert, null, 2)}\n\nInvestigate and write a change request.`);
agentBusy = false;

if (revision === 0 && !concluded) note("[investigator neither wrote a change request nor concluded; ask it to]");
if (args.once) process.exit(revision === 0 && !concluded ? 3 : 0);

// ---- conversation: RPC (POST /message) or typed into the tmux window ---------------------------
process.stdout.write(`\n${revision ? `change request at ${OUT} (revision ${revision}). ` : concluded ? "Concluded: no change needed. " : ""}Waiting for the operator. /quit ends the session.\n> `);
void drain(); // messages that arrived during the first turn

if (process.stdin.isTTY) {
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    if (line.trim()) {
      queue.push(line);
      void drain();
    } else process.stdout.write("> ");
  });
}

// keep the process alive while idle (readline on a tty normally does; this covers a non-tty stdin)
setInterval(() => {}, 1 << 30);

// ---- helpers ---------------------------------------------------------------
/** The Markdown prompt file, minus its explanatory header (everything above the first `---`). */
function loadPrompt(path: string): string {
  let text: string;
  if (existsSync(path)) text = readFileSync(path, "utf8");
  else {
    process.stderr.write(`prompt file ${path} not found; using the copy bundled at build time\n`);
    text = bundledPrompt;
  }
  const i = text.indexOf("\n---\n");
  return (i >= 0 ? text.slice(i + 5) : text).trim();
}

/** General runbooks (`_*.md`, always) followed by the alert's runbook (or `_default.md`). */
function loadRunbooks(dir: string, name: string): string {
  if (!existsSync(dir)) return "No runbooks available.";
  const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  const general = files.filter((f) => f.startsWith("_") && f !== "_default.md");
  const specific = files.includes(`${name}.md`) ? `${name}.md` : files.includes("_default.md") ? "_default.md" : undefined;
  const parts = [...general, ...(specific ? [specific] : [])].map((f) => `<!-- runbooks/${f} -->\n${readFileSync(join(dir, f), "utf8").trim()}`);
  if (!specific) parts.push(`No runbook for ${name}. Available: ${files.join(", ")}`);
  return parts.join("\n\n---\n\n");
}

function run(argv: string[], timeoutMs = 60_000, keepTeleportEnv = false, onStderrLine?: (line: string) => void): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    // kubectl must not see the beam's Teleport identity; submit-cr.sh needs it (tsh/tctl as the beam)
    if (!keepTeleportEnv) for (const k of ["TELEPORT_PROXY", "TELEPORT_CLUSTER", "TELEPORT_IDENTITY_FILE", "TELEPORT_KEY_AGENT_DIR"]) delete env[k];
    const child = spawn(argv[0], argv.slice(1), { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", partial = "";
    child.stdout!.on("data", (d) => (stdout += d));
    child.stderr!.on("data", (d) => {
      stderr += d;
      if (!onStderrLine) return;
      partial += d;
      const lines = partial.split("\n");
      partial = lines.pop() ?? "";
      for (const l of lines) onStderrLine(l);
    });
    const t = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (e) => { clearTimeout(t); resolve({ code: -1, stdout, stderr: String(e) }); });
    child.on("close", (code) => { clearTimeout(t); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}

function indent(s: string): string {
  return s.split("\n").map((l) => "    " + l).join("\n");
}
