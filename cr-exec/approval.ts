// Approval gate. cr-exec never trusts a CR handed to it on the command line;
// it loads the CR from the Access Request itself, via the bot identity, and
// re-checks the request state on every tool call (with a short cache).

import { readFileSync } from "node:fs";
import { parseCR, stepsFingerprint, validateCommands, type CR } from "../shared/cr";
import { getRequest, listRequests, type AccessRequest } from "../shared/teleport";

export interface ApprovalConfig {
  requestId: string;
  /** bot identity file (tbot identity output) used for `tsh -i` */
  identity: string;
  proxy: string;
  /** role the request must name, e.g. oncall-change */
  approvalRole: string;
  allowedExecutables: readonly string[];
  /** cache TTL for the request lookup */
  cacheMs?: number;
}

export interface Approval {
  request: AccessRequest;
  cr: CR;
}

export interface ApprovalStatus {
  request: AccessRequest;
  cr: CR;
  approved: boolean;
  reason?: string;
}

export class ApprovalGate {
  private cached?: { at: number; value: ApprovalStatus };

  constructor(private readonly cfg: ApprovalConfig) {}

  /**
   * Load the request and its CR (the CR is readable while PENDING; the reason is
   * immutable). `approved` is true only when state is APPROVED, unexpired, and
   * the request names the approval role.
   */
  async status(): Promise<ApprovalStatus> {
    const ttl = this.cfg.cacheMs ?? 10_000;
    if (this.cached && Date.now() - this.cached.at < ttl) return this.cached.value;

    const env = scrubbedEnv();
    const req = await getRequest(this.cfg.requestId, { identity: this.cfg.identity, proxy: this.cfg.proxy, env });
    if (!req) throw new Error(`access request ${this.cfg.requestId} not found (or not visible to the bot)`);
    const cr = parseCR(req.reason);
    validateCommands(cr, this.cfg.allowedExecutables);

    let reason: string | undefined;
    if (req.state !== "APPROVED") reason = `access request is ${req.state}, not APPROVED`;
    else if (!req.roles.includes(this.cfg.approvalRole)) reason = `access request does not request role ${this.cfg.approvalRole}`;
    else {
      const expiry = req.accessExpiry ?? req.expires;
      if (expiry && new Date(expiry).getTime() < Date.now()) reason = `access request expired at ${expiry}`;
    }
    const value: ApprovalStatus = { request: req, cr, approved: !reason, reason };
    this.cached = { at: Date.now(), value };
    return value;
  }

  /** Throws if the request is not currently approved and valid. */
  async require(): Promise<Approval> {
    const s = await this.status();
    if (!s.approved) throw new Error(s.reason);
    return { request: s.request, cr: s.cr };
  }

  invalidate(): void {
    this.cached = undefined;
  }
}

/**
 * Register-then-request mode: the executor starts from the CR file it was deployed
 * with and no request exists yet. It watches the requester's Access Requests for one
 * whose CR names this executor's bot, checks the steps are identical to what it
 * loaded, then gates on that request like ApprovalGate.
 */
export interface DiscoveringGateConfig {
  crFile: string;
  executorBot: string;
  requester: string;
  identity: string;
  proxy: string;
  approvalRole: string;
  allowedExecutables: readonly string[];
  cacheMs?: number;
}

export class DiscoveringGate {
  private readonly local: CR;
  private cached?: { at: number; value: ApprovalStatus };
  requestId?: string;

  constructor(private readonly cfg: DiscoveringGateConfig) {
    this.local = parseCR(readFileSync(cfg.crFile, "utf8"));
    validateCommands(this.local, cfg.allowedExecutables);
  }

  async status(): Promise<ApprovalStatus> {
    const ttl = this.cfg.cacheMs ?? 10_000;
    if (this.cached && Date.now() - this.cached.at < ttl) return this.cached.value;

    const env = scrubbedEnv();
    const all = await listRequests({ identity: this.cfg.identity, proxy: this.cfg.proxy, env });
    const mine = all
      .filter((r) => r.user === this.cfg.requester && r.roles.includes(this.cfg.approvalRole))
      .filter((r) => {
        try {
          return parseCR(r.reason).executor?.bot === this.cfg.executorBot;
        } catch {
          return false;
        }
      })
      .sort((a, b) => (a.created < b.created ? 1 : -1));
    const req = mine[0];

    let value: ApprovalStatus;
    if (!req) {
      const placeholder: AccessRequest = { id: "", user: this.cfg.requester, roles: [], state: "NONE", reason: "", created: "", expires: "" };
      value = { request: placeholder, cr: this.local, approved: false, reason: `no access request names executor ${this.cfg.executorBot} yet` };
    } else {
      this.requestId = req.id;
      const inRequest = parseCR(req.reason);
      let reason: string | undefined;
      if (stepsFingerprint(inRequest) !== stepsFingerprint(this.local)) reason = `steps in access request ${req.id} differ from the steps this executor was deployed with`;
      else if (req.state !== "APPROVED") reason = `access request ${req.id} is ${req.state}, not APPROVED`;
      else {
        const expiry = req.accessExpiry ?? req.expires;
        if (expiry && new Date(expiry).getTime() < Date.now()) reason = `access request ${req.id} expired at ${expiry}`;
      }
      value = { request: req, cr: this.local, approved: !reason, reason };
    }
    this.cached = { at: Date.now(), value };
    return value;
  }

  async require(): Promise<Approval> {
    const s = await this.status();
    if (!s.approved) throw new Error(s.reason);
    return { request: s.request, cr: s.cr };
  }

  invalidate(): void {
    this.cached = undefined;
  }
}

/** Local development only: CR from a file, always "approved" for user `dev`. */
export class DevApprovalGate {
  private readonly value: Approval;
  constructor(file: string, allowedExecutables: readonly string[]) {
    const cr = parseCR(readFileSync(file, "utf8"));
    validateCommands(cr, allowedExecutables);
    this.value = {
      cr,
      request: { id: "dev", user: "dev", roles: ["oncall-change"], state: "APPROVED", reason: "", created: "", expires: "" },
    };
  }
  async require(): Promise<Approval> {
    return this.value;
  }
  async status(): Promise<ApprovalStatus> {
    return { ...this.value, approved: true };
  }
  invalidate(): void {}
}

/**
 * Inside a beam, TELEPORT_* env vars point tsh at the beam's delegated identity
 * and override flags. Remove them so `tsh -i <bot identity>` really uses the bot.
 */
export function scrubbedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of ["TELEPORT_PROXY", "TELEPORT_CLUSTER", "TELEPORT_IDENTITY_FILE", "TELEPORT_KEY_AGENT_DIR", "TELEPORT_LOGIN"]) {
    delete env[k];
  }
  return env;
}
