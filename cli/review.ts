// Reviewing a change request as a human reviewer, from the TUI.
//
// Teleport refuses self-review, so approval comes from a second local user (`webmaster`, role
// webmaster, created by terraform) through its own tsh profile (~/.tsh-reviewer). The first
// time, the TUI suspends and runs the reviewer's `tsh login` interactively; after that reviews are
// one `tsh request review`. `tctl users reset <user>` prints the link that sets the password.

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "./config";
import { run, runOk } from "../shared/teleport";

const PROXY = process.env.CR_PROXY ?? "flat-pine.beams.sh:443";
export const REVIEWER = config.reviewer ?? process.env.CR_REVIEWER ?? "webmaster";
export const REVIEWER_HOME = config.reviewer_home ?? process.env.CR_REVIEWER_HOME ?? join(homedir(), ".tsh-reviewer");

function env() {
  const e: NodeJS.ProcessEnv = {
    ...process.env,
    TELEPORT_HOME: REVIEWER_HOME,
    // keep the reviewer's login away from the on-call's kube contexts and ssh-agent
    KUBECONFIG: join(REVIEWER_HOME, "kubeconfig"),
    TELEPORT_ADD_KEYS_TO_AGENT: "no",
  };
  for (const k of ["TELEPORT_PROXY", "TELEPORT_CLUSTER", "TELEPORT_IDENTITY_FILE", "TELEPORT_KEY_AGENT_DIR"]) delete e[k];
  return e;
}

/** Is the reviewer profile logged in with a valid certificate? */
export async function reviewerLoggedIn(): Promise<boolean> {
  const r = await run(["tsh", "--proxy", PROXY, "--add-keys-to-agent=no", "status", "--format", "json"], { echo: false, env: env() });
  if (r.code !== 0) return false;
  try {
    const st = JSON.parse(r.stdout);
    return st?.active?.username === REVIEWER && new Date(st.active.valid_until).getTime() > Date.now() + 60_000;
  } catch {
    return false;
  }
}

/**
 * Interactive reviewer login (password + MFA on the terminal). The caller suspends the TUI around it.
 * Returns an error message, or undefined on success.
 */
export function reviewerLoginInteractive(): string | undefined {
  const r = spawnSync("tsh", ["--proxy", PROXY, "--add-keys-to-agent=no", "login", "--user", REVIEWER], { stdio: "inherit", env: env() });
  if (r.status === 0) return undefined;
  return `tsh login as ${REVIEWER} failed (exit ${r.status}). If the user has no password yet: tctl users reset ${REVIEWER}  (prints a link to set it).`;
}

/** Approve or deny a request as the reviewer. Returns the new state. */
export async function reviewRequest(id: string, decision: "approve" | "deny", reason: string): Promise<string> {
  const out = await runOk(["tsh", "--proxy", PROXY, "--add-keys-to-agent=no", "request", "review", `--${decision}`, "--reason", reason, id], { env: env() });
  return out.match(/Request state: (\w+)/)?.[1] ?? decision.toUpperCase();
}

/** The password-reset link for the reviewer (for first-time setup). */
export async function reviewerResetLink(): Promise<string> {
  const out = await runOk(["tctl", "users", "reset", REVIEWER, "--auth-server", PROXY], { echo: false });
  return out.match(/https?:\/\/\S+/)?.[0] ?? out.trim();
}
