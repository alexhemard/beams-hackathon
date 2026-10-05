// Shared beam/bot plumbing used by `oncall investigate` and `oncall deploy`.
//
// Tracking lives in Teleport, not on the laptop: every bot we create carries labels
// (role, owner, beam alias/id, and the CR id or alert it serves), the same way the
// beam service labels each beam's own system bot. `discover()` rebuilds the picture
// from `tctl get bots` + `tsh beams ls`; local ~/.oncall files are only a cache.

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { echo, run, runJson, runOk } from "../shared/teleport";

export const PROXY = process.env.CR_PROXY ?? "flat-pine.beams.sh:443";
export const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
export const STATE_DIR = join(homedir(), ".oncall");

/**
 * Beam/bot control-plane calls (`tsh beams ...`, `tctl ...`) must ride the beam's own delegated
 * user identity (role `beam-user` grants `create`/`*` on `beam`), not whatever bot identity
 * `beaminit.sh` exported for kube access (`TELEPORT_IDENTITY_FILE`, overridden in `~/.bashrc`) —
 * the oncall-bot's `operator` role has no beam/bot management grant, so inheriting it here fails
 * with "access denied to perform action create on beam".
 *
 * Just deleting TELEPORT_IDENTITY_FILE and hoping tsh falls back to TELEPORT_KEY_AGENT_DIR's SSH
 * agent doesn't work: that agent only serves SSH certs, not a full tsh login, so with no identity
 * file and no TELEPORT_HOME profile tsh has zero auth methods ("no SSH auth methods loaded, are
 * you logged in?" — reproduced directly). The beam's own delegated identity is a platform-fixed
 * path, `/var/run/tbot/identity/identity` (set in `/etc/environment`, same for every beam), which
 * `beaminit.sh` never touches — point at it explicitly instead of deleting+hoping. Guarded by
 * existsSync so plain laptop usage (TELEPORT_HOME profile, no identity file at all) is unaffected,
 * matching `cli/review.ts`'s `env()`, which drops both vars because it targets a wholly separate
 * on-disk reviewer profile (TELEPORT_HOME) that doesn't use either.
 */
const BEAM_IDENTITY_FILE = "/var/run/tbot/identity/identity";

export function ambientEnv(): NodeJS.ProcessEnv {
  const e = { ...process.env };
  if (existsSync(BEAM_IDENTITY_FILE)) e.TELEPORT_IDENTITY_FILE = BEAM_IDENTITY_FILE;
  else delete e.TELEPORT_IDENTITY_FILE;
  return e;
}

/**
 * `tsh proxy app` (used by `cli/appproxy.ts` to reach the investigator/executor APIs) needs to
 * reissue an app-scoped cert — something the beam's own delegated identity (`BEAM_IDENTITY_FILE`,
 * used by `ambientEnv()` for beam/bot control-plane calls) can never do, by platform design
 * (`disallow-reissue`). The `oncall-bot` Machine ID bot `beaminit.sh` provisions in every beam
 * *can* reissue, and the investigator/executor owner checks trust its username
 * (`shared/teleport.ts`'s `TRUSTED_BOT_USERNAME`) as a stand-in for the human owner. Point at it
 * here instead of the native identity. Guarded by existsSync so plain laptop usage (full `tsh
 * login` session, no beam-specific identity files at all) is unaffected.
 */
const BOT_IDENTITY_FILE = join(homedir(), "bot-id", "identity");

export function botAppEnv(): NodeJS.ProcessEnv {
  const e = { ...process.env };
  if (existsSync(BOT_IDENTITY_FILE)) e.TELEPORT_IDENTITY_FILE = BOT_IDENTITY_FILE;
  else delete e.TELEPORT_IDENTITY_FILE;
  return e;
}

export type BotRole = "executor" | "investigator";

export interface BotLabels {
  role: BotRole;
  owner: string;
  beamAlias: string;
  beamId: string;
  /** request id for executors, alert name for investigators */
  ref: string;
  /** the beam that produced this one (investigator → executor), "-" when none */
  parent?: string;
}

export function stateDir(): string {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  return STATE_DIR;
}

export function step(msg: string) {
  echo(`▶ ${msg}`);
}

export async function currentUser(): Promise<string> {
  const out = await runOk(["tsh", "--proxy", PROXY, "status", "--format", "json"], { echo: false, env: ambientEnv() });
  const st = JSON.parse(out);
  return st?.active?.username ?? st?.username ?? "";
}

// ---- bots ----------------------------------------------------------------------

/** Create a bot as a resource so it carries tracking labels. Idempotent (updates labels if it exists). */
export async function ensureBot(name: string, teleportRole: string, labels: BotLabels): Promise<void> {
  const yaml = fill(readFileSync(join(REPO, "teleport/bot.yaml.tmpl"), "utf8"), {
    BOT_NAME: name,
    TELEPORT_ROLE: teleportRole,
    ROLE: labels.role,
    OWNER: labels.owner,
    BEAM_ALIAS: labels.beamAlias,
    BEAM_ID: labels.beamId,
    REF: labels.ref,
    PARENT: labels.parent ?? "-",
  });
  const file = join(stateDir(), `bot-${name}.yaml`);
  writeFileSync(file, yaml, { mode: 0o600 });
  await runOk(["tctl", "create", "--force", "-f", file, "--auth-server", PROXY], { env: ambientEnv() });
}

/** Merge extra labels onto an existing bot (e.g. the published app name once known). */
export async function addBotLabels(name: string, extra: Record<string, string>): Promise<void> {
  const bots = await runJson<any[]>(["tctl", "get", `bot/${name}`, "--format", "json", "--auth-server", PROXY], { echo: false, env: ambientEnv() });
  const bot = bots[0];
  if (!bot) throw new Error(`bot ${name} not found`);
  bot.metadata.labels = { ...(bot.metadata.labels ?? {}), ...extra };
  const file = join(stateDir(), `bot-${name}.json`);
  writeFileSync(file, JSON.stringify(bot), { mode: 0o600 });
  await runOk(["tctl", "create", "--force", "-f", file, "--auth-server", PROXY], { echo: false, env: ambientEnv() });
}

/** Create a fresh bound-keypair token for the bot; returns the one-time secret. */
export async function createBoundKeypairToken(tokenName: string, botName: string, labels: BotLabels): Promise<string> {
  const secret = randomBytes(24).toString("hex");
  const yaml = fill(readFileSync(join(REPO, "teleport/token.yaml.tmpl"), "utf8"), {
    TOKEN_NAME: tokenName,
    BOT_NAME: botName,
    SECRET: secret,
    EXPIRES: new Date(Date.now() + 30 * 60_000).toISOString(),
    ROLE: labels.role,
    OWNER: labels.owner,
    BEAM_ALIAS: labels.beamAlias,
    REF: labels.ref,
  });
  const file = join(stateDir(), `token-${tokenName}.yaml`);
  writeFileSync(file, yaml, { mode: 0o600 });
  // Overwriting with --force keeps status.registration_secret, so delete first.
  await run(["tctl", "rm", `token/${tokenName}`, "--auth-server", PROXY], { echo: false, env: ambientEnv() });
  await runOk(["tctl", "create", "-f", file, "--auth-server", PROXY], { redact: [secret], env: ambientEnv() });
  return secret;
}

export async function removeBot(bot: string, token: string): Promise<void> {
  await run(["tctl", "bots", "rm", bot, "--auth-server", PROXY], { env: ambientEnv() });
  await run(["tctl", "tokens", "rm", token, "--auth-server", PROXY], { echo: false, env: ambientEnv() });
}

// ---- beams ---------------------------------------------------------------------

export interface BeamInfo {
  id: string;
  uuid: string;
  owner?: string;
  expires?: string;
  region?: string;
}

export async function createBeam(): Promise<BeamInfo> {
  const beam = await runJson<BeamInfo>(["tsh", "--proxy", PROXY, "beams", "add", "--no-console", "--format", "json"], { timeoutMs: 180_000, env: ambientEnv() });
  await waitForBeam(beam.id);
  return beam;
}

export async function listBeams(): Promise<BeamInfo[]> {
  return runJson<BeamInfo[]>(["tsh", "--proxy", PROXY, "beams", "ls", "--format", "json"], { echo: false, env: ambientEnv() });
}

/** Name the beam service gives a published app: <alias>-<first 4 of uuid>. */
export function publishedAppName(beam: BeamInfo): string {
  return `${beam.id}-${beam.uuid.slice(0, 4)}`;
}

/** A new beam can take a few seconds before SSH accepts commands; retry a no-op until it does. */
export async function waitForBeam(beam: string, timeoutMs = 90_000): Promise<void> {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    const r = await run(beamExecArgv(beam, ["true"]), { echo: false, timeoutMs: 30_000, env: ambientEnv() });
    if (r.code === 0) return;
    last = r.stderr.trim().split("\n").pop() ?? "";
    await new Promise((res) => setTimeout(res, 3000));
  }
  throw new Error(`beam ${beam} did not become reachable: ${last}`);
}

/** tsh beams exec: `--` ends tsh flag parsing; args are re-joined with spaces over SSH, so no quoting. */
export function beamExecArgv(beam: string, argv: string[]): string[] {
  return ["tsh", "--proxy", PROXY, "beams", "exec", beam, "--", ...argv];
}

export async function beamExec(beam: string, argv: string[], opts: { timeoutMs?: number; redact?: string[] } = {}) {
  return run(beamExecArgv(beam, argv), { timeoutMs: opts.timeoutMs ?? 600_000, redact: opts.redact, env: ambientEnv() });
}

/** Like beamExec but throws on non-zero exit. */
export async function beamExecOk(beam: string, argv: string[], opts: { timeoutMs?: number; redact?: string[] } = {}): Promise<string> {
  const r = await beamExec(beam, argv, opts);
  if (r.code !== 0) throw new Error(`in beam ${beam}: ${argv.join(" ")} failed (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout;
}

export async function beamScp(local: string, beam: string, remote: string): Promise<void> {
  await runOk(["tsh", "--proxy", PROXY, "beams", "scp", local, `${beam}:${remote}`], { env: ambientEnv() });
}

/**
 * Reproducible init state for a beam: stage the given files under their target paths (relative
 * to /home/beams), tar.gz them, copy the archive once, extract it on the beam. One scp + one exec
 * instead of a copy per file, and the archive is the exact initial state (kept in ~/.oncall for the record).
 */
export async function beamInit(beam: string, entries: Array<{ local: string; remote: string }>, label: string): Promise<string> {
  const stage = join(stateDir(), `init-${label}`);
  rmSync(stage, { recursive: true, force: true });
  for (const e of entries) {
    const dest = join(stage, e.remote);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(e.local, dest, { recursive: true });
  }
  const archive = join(stateDir(), `init-${label}.tgz`);
  await runOk(["tar", "czf", archive, "-C", stage, "."], { echo: false });
  rmSync(stage, { recursive: true, force: true });
  await beamScp(archive, beam, "/home/beams/init.tgz");
  await beamExecOk(beam, ["tar", "xzf", "/home/beams/init.tgz", "-C", "/home/beams"]);
  await beamExec(beam, ["rm", "-f", "/home/beams/init.tgz"]);
  return archive;
}

/** Copy a file out of a beam (beam:remote → local). */
export async function beamScpFrom(beam: string, remote: string, local: string): Promise<void> {
  await runOk(["tsh", "--proxy", PROXY, "beams", "scp", `${beam}:${remote}`, local], { env: ambientEnv() });
}

export async function removeBeam(beam: string): Promise<void> {
  await run(["tsh", "--proxy", PROXY, "beams", "unpublish", beam], { echo: false, env: ambientEnv() });
  await run(["tsh", "--proxy", PROXY, "beams", "rm", beam], { env: ambientEnv() });
}

export async function bundle(script: string): Promise<void> {
  await runOk(["npm", "run", "-s", script], { cwd: REPO, echo: false });
}

// ---- discovery: rebuild tracking from Teleport ---------------------------------

export interface TrackedBot {
  bot: string;
  role: BotRole;
  owner: string;
  beamAlias: string;
  beamId: string;
  ref: string;
  app?: string;
  /** beam still exists per `tsh beams ls` */
  beamAlive: boolean;
  /** the beam that produced this executor (investigator alias) */
  parent?: string;
}

export async function discover(): Promise<TrackedBot[]> {
  const [bots, beams] = await Promise.all([
    runJson<any[]>(["tctl", "get", "bots", "--format", "json", "--auth-server", PROXY], { echo: false, env: ambientEnv() }).catch(() => [] as any[]),
    listBeams().catch(() => [] as BeamInfo[]),
  ]);
  const alive = new Set(beams.map((b) => b.uuid));
  return bots
    .filter((b) => b?.metadata?.labels?.["oncall/role"])
    .map((b) => {
      const l = b.metadata.labels as Record<string, string>;
      return {
        bot: b.metadata.name as string,
        role: l["oncall/role"] as BotRole,
        owner: l["oncall/owner"] ?? "",
        beamAlias: l["oncall/beam-alias"] ?? "",
        beamId: l["oncall/beam-id"] ?? "",
        ref: l["oncall/ref"] ?? "",
        parent: l["oncall/parent-beam"] && l["oncall/parent-beam"] !== "-" ? l["oncall/parent-beam"] : undefined,
        app: l["oncall/app"],
        beamAlive: alive.has(l["oncall/beam-id"] ?? ""),
      };
    });
}

function fill(tmpl: string, vars: Record<string, string>): string {
  let out = tmpl;
  for (const [k, v] of Object.entries(vars)) out = out.replaceAll("${" + k + "}", v);
  return out;
}
