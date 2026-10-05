// Thin wrappers around tsh/tctl. Every call is logged so the demo can narrate
// exactly which Teleport commands run.

import { spawn } from "node:child_process";

/** Teleport username of the shared `oncall-bot` Machine ID bot `beaminit.sh` provisions in every
 *  beam (name configurable via `BEAMINIT_BOT_NAME`, same convention as that script). Owner-only
 *  caller checks (`investigator/agent.ts`, `plan-runner/server.ts`) trust this bot as a stand-in
 *  for the human owner/requester, since it's the identity `cli/appproxy.ts` uses to reach these
 *  APIs from inside a beam (the beam's own identity can't reissue the app cert `tsh proxy app`
 *  needs). */
export const TRUSTED_BOT_USERNAME = `bot-${process.env.BEAMINIT_BOT_NAME ?? "oncall-bot"}`;

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOpts {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  /** Print the command to stderr before running. Default true. */
  echo?: boolean;
  /** Redact these substrings in the echoed command line. */
  redact?: string[];
}

/** Where echoed commands go. The TUI redirects this into its log pane. */
let echoSink: (line: string) => void = (line) => process.stderr.write(line + "\n");
export function setEchoSink(fn: (line: string) => void): void {
  echoSink = fn;
}
/** Emit a narration line through the same sink as echoed commands. */
export function echo(line: string): void {
  echoSink(line);
}

export function run(argv: string[], opts: RunOpts = {}): Promise<RunResult> {
  const { env = process.env, cwd, timeoutMs = 120_000, echo = true, redact = [] } = opts;
  if (echo) {
    let line = argv.map(shellDisplay).join(" ");
    for (const r of redact) if (r) line = line.split(r).join("<redacted>");
    echoSink(`$ ${line}`);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const t = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

export async function runOk(argv: string[], opts: RunOpts = {}): Promise<string> {
  const r = await run(argv, opts);
  if (r.code !== 0) {
    throw new Error(`${argv[0]} ${argv[1] ?? ""} failed (exit ${r.code}):\n${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

export async function runJson<T = unknown>(argv: string[], opts: RunOpts = {}): Promise<T> {
  const out = await runOk(argv, opts);
  return JSON.parse(out) as T;
}

function shellDisplay(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

// ---- Access Requests -------------------------------------------------------

export type RequestState = "PENDING" | "APPROVED" | "DENIED" | "PROMOTED" | string;

export interface AccessRequest {
  id: string;
  user: string;
  roles: string[];
  state: RequestState;
  reason: string;
  created: string;
  expires: string;
  /** when the granted access expires (if approved) */
  accessExpiry?: string;
}

/** Normalize `tsh request ls --format json` output, which is the raw resource. */
export function normalizeRequests(raw: unknown): AccessRequest[] {
  const items = Array.isArray(raw) ? raw : [];
  return items.map((r: any) => {
    const spec = r.spec ?? {};
    const meta = r.metadata ?? {};
    return {
      id: meta.name ?? r.id ?? "",
      user: spec.user ?? "",
      roles: spec.roles ?? [],
      state: stateName(spec.state),
      reason: spec.request_reason ?? spec.reason ?? "",
      created: spec.created ?? "",
      expires: meta.expires ?? "",
      accessExpiry: spec.access_expiry ?? spec.expires,
    };
  });
}

function stateName(s: unknown): RequestState {
  // tsh emits either the enum name or the numeric value depending on version.
  if (typeof s === "string") return s.toUpperCase();
  const map: Record<number, RequestState> = { 1: "PENDING", 2: "APPROVED", 3: "DENIED", 4: "PROMOTED" };
  return typeof s === "number" ? map[s] ?? String(s) : "UNKNOWN";
}

export interface TshOpts {
  /** identity file for `tsh -i` (bot identity inside the beam). */
  identity?: string;
  proxy?: string;
  env?: NodeJS.ProcessEnv;
}

function tshBase(o: TshOpts): string[] {
  const argv = ["tsh"];
  if (o.identity) argv.push("-i", o.identity);
  if (o.proxy) argv.push("--proxy", o.proxy);
  return argv;
}

export async function listRequests(o: TshOpts = {}): Promise<AccessRequest[]> {
  const raw = await runJson([...tshBase(o), "request", "ls", "--format", "json"], { env: o.env, echo: false });
  return normalizeRequests(raw);
}

export async function getRequest(id: string, o: TshOpts = {}): Promise<AccessRequest | undefined> {
  const all = await listRequests(o);
  return all.find((r) => r.id === id);
}

// ---- Kube clusters ---------------------------------------------------------

export interface KubeCluster {
  name: string;
  labels: Record<string, string>;
}

/** Normalize `tsh kube ls --format json` output across tsh versions (flat KubeListClusters shape, or resource-style metadata). */
export function normalizeKubeClusters(raw: unknown): KubeCluster[] {
  const items = Array.isArray(raw) ? raw : [];
  return items.map((r: any) => ({
    name: r.kube_cluster_name ?? r.metadata?.name ?? r.name ?? "",
    labels: r.labels ?? r.metadata?.labels ?? {},
  }));
}

/** Every kube cluster this identity can see (Teleport RBAC already scopes the result; no app-level filtering needed). */
export async function listKubeClusters(o: TshOpts = {}): Promise<KubeCluster[]> {
  const raw = await runJson([...tshBase(o), "kube", "ls", "--format", "json"], { env: o.env, echo: false });
  return normalizeKubeClusters(raw);
}
