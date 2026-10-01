// Active alerts for the TUI. Reads Alertmanager through the Kubernetes API
// server's service proxy using the operator's Teleport kube access
// (`tsh kube login <cluster>` once), or from a JSON file for demos.

import { readFileSync } from "node:fs";
import { run, runOk } from "./teleport";

export interface Alert {
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: string;
  /** Alertmanager's stable hash of the label set */
  fingerprint?: string;
  status?: { state?: string };
}

export interface AlertSource {
  file?: string;
  kubeCluster?: string;
  namespace?: string;
  service?: string;
}

export async function fetchAlerts(src: AlertSource): Promise<Alert[]> {
  if (src.file) {
    const raw = JSON.parse(readFileSync(src.file, "utf8"));
    return Array.isArray(raw) ? raw : [raw];
  }
  const cluster = src.kubeCluster ?? "oncall";
  const ns = src.namespace ?? "monitoring";
  const svc = src.service ?? "alertmanager-operated:9093";
  // Always go through Teleport: log in (idempotent; also refreshes the kube cert) and pin the
  // kubectl context tsh creates (<teleport-cluster>-<kube-cluster>) instead of the current one.
  const proxy = process.env.CR_PROXY ?? "flat-pine.beams.sh:443";
  await runOk(["tsh", "--proxy", proxy, "kube", "login", cluster], { echo: false });
  const status = JSON.parse(await runOk(["tsh", "--proxy", proxy, "status", "--format", "json"], { echo: false }));
  const teleportCluster: string = status?.active?.cluster ?? proxy.replace(/:\d+$/, "");
  const context = `${teleportCluster}-${cluster}`;
  const out = await runOk(
    ["kubectl", "--context", context, "get", "--raw", `/api/v1/namespaces/${ns}/services/${svc}/proxy/api/v2/alerts?active=true&silenced=false&inhibited=false`],
    { echo: false },
  );
  const alerts = JSON.parse(out) as Alert[];
  // hide Watchdog and inhibited/info noise
  return alerts.filter((a) => a.labels?.alertname !== "Watchdog" && a.labels?.alertname !== "InfoInhibitor");
}

/** The kubectl context and proxy path prefix for Alertmanager through Teleport (same route fetchAlerts uses). */
async function amRoute(src: AlertSource): Promise<{ context: string; prefix: string }> {
  const cluster = src.kubeCluster ?? "oncall";
  const ns = src.namespace ?? "monitoring";
  const svc = src.service ?? "alertmanager-operated:9093";
  const proxy = process.env.CR_PROXY ?? "flat-pine.beams.sh:443";
  await runOk(["tsh", "--proxy", proxy, "kube", "login", cluster], { echo: false });
  const status = JSON.parse(await runOk(["tsh", "--proxy", proxy, "status", "--format", "json"], { echo: false }));
  const teleportCluster: string = status?.active?.cluster ?? proxy.replace(/:\d+$/, "");
  return { context: `${teleportCluster}-${cluster}`, prefix: `/api/v1/namespaces/${ns}/services/${svc}/proxy/api/v2` };
}

export interface Silence {
  id: string;
  matchers: Array<{ name: string; value: string; isEqual?: boolean; isRegex?: boolean }>;
  startsAt: string;
  endsAt: string;
  createdBy: string;
  comment: string;
  status?: { state?: string };
}

/**
 * Run `fn` against a short-lived `kubectl proxy` (plain local HTTP to the API server, through Teleport),
 * so requests to the Alertmanager service proxy can carry exact headers. kubectl's own raw POST is
 * rejected by Alertmanager (415), the proxied request is not.
 */
async function withKubeProxy<T>(context: string, fn: (base: string) => Promise<T>): Promise<T> {
  const { spawn } = await import("node:child_process");
  const { createServer } = await import("node:net");
  const port: number = await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as { port: number }).port;
      srv.close(() => resolve(p));
    });
  });
  const child = spawn("kubectl", ["--context", context, "proxy", "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("kubectl proxy did not start")), 15_000);
      child.stdout!.on("data", (d) => { if (/Starting to serve/.test(String(d))) { clearTimeout(t); resolve(); } });
      child.on("exit", (c) => { clearTimeout(t); reject(new Error(`kubectl proxy exited ${c}`)); });
    });
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    child.kill("SIGTERM");
  }
}

/**
 * Silence an alert in Alertmanager for `minutes` (POST /api/v2/silences through the kube service proxy,
 * so Teleport records it as a kube.request by the operator). Matches on alertname plus the
 * namespace/deployment/pod labels present, so only this alert instance is muted. Returns the silence id.
 */
export async function silenceAlert(a: Alert, minutes: number, comment: string, createdBy: string, src: AlertSource = {}): Promise<string> {
  const { context, prefix } = await amRoute(src);
  const keys = ["alertname", "namespace", "deployment", "pod", "instance"].filter((k) => a.labels?.[k]);
  const body = {
    matchers: keys.map((k) => ({ name: k, value: a.labels[k], isEqual: true, isRegex: false })),
    startsAt: new Date().toISOString(),
    endsAt: new Date(Date.now() + minutes * 60_000).toISOString(),
    createdBy,
    comment,
  };
  return withKubeProxy(context, async (base) => {
    const r = await fetch(`${base}${prefix}/silences`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok) throw new Error(`alertmanager: ${r.status} ${text.slice(0, 200)}`);
    const j = JSON.parse(text);
    return j.silenceID ?? j.silenceId ?? "?";
  });
}

/** Active silences, to mark muted alerts. */
export async function fetchSilences(src: AlertSource = {}): Promise<Silence[]> {
  const { context, prefix } = await amRoute(src);
  const out = await runOk(["kubectl", "--context", context, "get", "--raw", `${prefix}/silences?silenced=false&inhibited=false`], { echo: false });
  return (JSON.parse(out) as Silence[]).filter((s) => s.status?.state === "active");
}

/** Remove a silence (DELETE /api/v2/silence/{id}). */
export async function expireSilence(id: string, src: AlertSource = {}): Promise<void> {
  const { context, prefix } = await amRoute(src);
  await withKubeProxy(context, async (base) => {
    const r = await fetch(`${base}${prefix}/silence/${id}`, { method: "DELETE" });
    if (!r.ok) throw new Error(`alertmanager: ${r.status} ${(await r.text()).slice(0, 200)}`);
  });
}

/** Does an active silence match this alert? */
export function silencedBy(a: Alert, silences: Silence[]): Silence | undefined {
  return silences.find((s) => s.matchers.every((m) => (m.isRegex ? new RegExp(`^(?:${m.value})$`).test(a.labels?.[m.name] ?? "") : a.labels?.[m.name] === m.value) === (m.isEqual !== false)));
}

export function alertTitle(a: Alert): string {
  const l = a.labels ?? {};
  // deployment first: kube-state-metrics alerts carry the exporter's own pod label
  const target = l.deployment ?? l.pod ?? l.job ?? l.instance ?? "";
  return `${l.severity ?? "?"}  ${l.alertname}  ${l.namespace ? l.namespace + "/" : ""}${target}`.trim();
}
