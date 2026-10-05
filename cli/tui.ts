// `oncall` TUI (pi-tui). Lists on the left, the selected item on the right, a log strip at the bottom.
//
//   [1] Alerts           active Alertmanager alerts
//   [2] Investigations   investigator beam, draft, and the executor it registered; execution is driven from here
//   [3] Change Requests  the Access Requests (stand-in for a Teleport UI): approve / deny
//
// Keys come from actionsFor(pane): computed from the selection's state, shown in the help bar.
// Tab / 1-3 switch pane · ↑↓ j k select · [ ] scroll · L log · R refresh · q quit

import { writeFileSync, readFileSync, existsSync, appendFileSync, rmSync } from "node:fs";
import { execFile, spawnSync } from "node:child_process";
import { config, editorArgv } from "./config";
import { BEAMS_MARK, BEAMS_TAGLINE } from "./logo";
import { REVIEWER, reviewRequest, reviewerLoggedIn, reviewerLoginInteractive, reviewerResetLink } from "./review";
import { join } from "node:path";
import { Key, ProcessTerminal, TuiAltScreen, decodeKittyPrintable, isKeyRelease, matchesKey, parseKey, type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { alertTitle, expireSilence, fetchAlerts, fetchSilences, silenceAlert, silencedBy, type Alert, type Silence } from "../shared/alerts";
import { setEchoSink, type AccessRequest } from "../shared/teleport";
import { isAsserting, parseCR, type CR } from "../shared/cr";
import { PROXY, currentUser, listBeams, removeBeam, removeBot, stateDir } from "./beamops";
import { investigate } from "./investigate";
import { appProxy, closeAppProxies, dropAppProxy } from "./appproxy";
import { callOperation, discover, executorStatus, listCRs, loadState, recoverExecutors, submit, teardown, type ExecutorStatus, type Operation } from "./ops";

export interface TuiOptions {
  alertsFile?: string;
  mockKubectl?: boolean;
  target?: "kube" | "tctl";
  /** seconds between automatic refreshes (0 disables) */
  refreshEvery?: number;
}

interface Investigation {
  id: string;
  alertName: string;
  alertFingerprint?: string;
  /** startsAt of the alert occurrence investigated; a later re-fire of the same labels is a new incident */
  alertStartsAt?: string;
  alertFile: string;
  beam?: string;
  bot?: string;
  attach?: string;
  /** the investigator's API, published as a Teleport app */
  app?: string;
  /** last event sequence applied to the transcript */
  eventSeq?: number;
  /** assistant text in progress (not persisted) */
  streaming?: string;
  status: "starting" | "running" | "drafted" | "no-change" | "no-cr" | "failed" | "removed";
  /** the investigator's one-line conclusion when no change is needed */
  conclusion?: string;
  crPath?: string;
  crYaml?: string;
  requestId?: string;
  startedAt: string;
  /** the investigator's output (persisted, capped) */
  transcript?: string[];
  /** when the CR file was last pulled from the beam */
  draftAt?: number;
  /** revision counter of the CR file as seen locally */
  draftRev?: number;
  /** the investigator proposed a revision and is waiting for yes/no (p) */
  proposalPending?: boolean;
  /** local intent not yet reflected by remote state; cleared by reconcile() (or dropped at boot) */
  pending?: Pending;
}

type Via = "investigator" | "laptop";
type Pending =
  | { kind: "submit"; at: number; via: Via; progress?: { step: number; beam?: string; bot?: string; app?: string } }
  | { kind: "op"; op: Operation | "run"; at: number; via: Via; logLen: number; phase: string };
const PENDING_TIMEOUT: Record<string, number> = { submit: 15 * 60_000, run: 30 * 60_000, op: 5 * 60_000 };

interface Action {
  key: string;
  label: string;
  run: () => void;
}
/** keys that never start work, allowed while busy */
const FREE_KEYS = new Set(["t", "c", "l", "A", "y", "Enter", "S", "H", "w", "p"]);

interface CRRow {
  req: AccessRequest;
  cr?: CR; // parsed from the request reason (summary, steps, alert, executor)
  summary: string;
  executor?: { beam?: string; bot?: string; appName?: string; phase?: string };
  live?: ExecutorStatus;
  liveAt?: number;
}

const BOLD = (s: string) => `\x1b[1m${s}\x1b[0m`;
const DIM = (s: string) => `\x1b[2m${s}\x1b[0m`;
const INV = (s: string) => `\x1b[7m${s}\x1b[0m`;
const GREEN = (s: string) => `\x1b[32m${s}\x1b[0m`;
const YELLOW = (s: string) => `\x1b[33m${s}\x1b[0m`;
const RED = (s: string) => `\x1b[31m${s}\x1b[0m`;
const CYAN = (s: string) => `\x1b[36m${s}\x1b[0m`;
/** the key-help bar: light text on a dark blue background, so it reads as chrome, not as log output */
const BAR = (s: string) => `\x1b[48;5;24m\x1b[38;5;253m${s}\x1b[0m`;
/** the right panel's heading: a dark gray band; coloured badges stay legible on it */
const HEAD = (s: string) => `\x1b[48;5;237m${s.replace(/\x1b\[0m/g, "\x1b[0m\x1b[48;5;237m")}\x1b[0m`;

const PANES = ["Alerts", "Investigations", "Change Requests"] as const;
type InvView = "transcript" | "cr" | "log";
const SPINNER = ["✱", "✲", "✳"];
const LOG_STRIP = 3;
const MAX_TRANSCRIPT = 600;

export async function startTui(o: TuiOptions): Promise<void> {
  const terminal = new ProcessTerminal();
  // mouse: false leaves mouse events to the terminal, so native text selection and
  // copy/paste keep working inside the frame. Nothing here needs mouse input.
  // mouse on for wheel scrolling of the right panel; hold Shift while dragging for the terminal's own selection
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true, copyOnSelect: false });
  installCrashGuard(tui);
  const target = o.target ?? "kube";
  const invFile = join(stateDir(), "investigations.json");

  let alerts: Alert[] = []; // shown alerts (silenced ones hidden unless showSilenced)
  let allAlerts: Alert[] = [];
  let silences: Silence[] = []; // active Alertmanager silences (m mutes, M unmutes)
  let showSilenced = false; // S toggles silenced alerts in the list
  const applyAlertFilter = () => {
    alerts = showSilenced ? allAlerts : allAlerts.filter((a) => !silencedBy(a, silences));
    sel[0] = Math.min(sel[0], Math.max(0, alerts.length - 1));
  };
  let investigations: Investigation[] = existsSync(invFile) ? JSON.parse(readFileSync(invFile, "utf8")) : [];
  for (const inv of investigations) delete inv.pending; // boot: remote state decides
  let crs: CRRow[] = [];
  let pane = 0;
  const sel = [0, 0, 0];
  let scroll = 0; // right view offset from the natural position (0 = top for documents, bottom for streams)
  let showLog = false;
  let splash: string | undefined = "connecting to " + PROXY.replace(/:\d+$/, ""); // startup screen until the first load completes
  let spin = 0;
  const spinTimer = setInterval(() => {
    spin++;
    tui.requestRender();
  }, 120);
  let showClosed = false; // H: also list closed/denied/expired CRs older than hide_closed_after
  let hiddenCRs = 0;
  let allCRs: CRRow[] = [];
  let invView: "auto" | InvView = "auto";
  // the bottom-line prompt: a message to the investigator (p), or a review reason (a / d)
  let prompt: { text: string; mode: "ask" | "approve" | "deny" | "silence"; cr?: CRRow; alert?: Alert } | undefined;
  let busy: string | undefined;
  let refreshing = false;
  let lastRefresh: Date | undefined;
  // in-flight trackers: declared with the state, before the first await, because keypresses
  // arrive during that await and the handlers below reference them (const TDZ crashed here once)
  const liveInflight = new Set<string>(); // executor status fetches by request id
  const syncInflight = new Set<string>(); // investigation log/draft syncs by investigation id
  const liveStreams = new Set<string>(); // investigations whose output is streaming into this process
  let attaching = false; // one attach (A) at a time
  const recorders = new Map<string, import("node:child_process").ChildProcess>(); // beam → recording client (Teleport session recording)
  const log: Array<{ line: string; inv?: string }> = []; // inv: the investigation a line concerns (its log view filters on it)
  let logCtx: string | undefined; // investigation id for lines pushed during a guarded action
  const logLines = (inv?: string) => (inv ? log.filter((e) => e.inv === inv) : log).map((e) => e.line);

  const pushLog = (line: string, inv?: string) => {
    for (const l of line.replace(/\r/g, "").split("\n")) if (l !== "") log.push({ line: l, inv: inv ?? logCtx });
    if (log.length > 3000) log.splice(0, log.length - 3000);
    for (const v of investigations) if (v.pending?.kind === "submit" && v.pending.via === "laptop") noteSubmitProgress(v, line);
    tui.requestRender();
  };
  // Streams arrive in small chunks (model text deltas), so a chunk continues the previous line unless
  // the previous chunk ended with a newline. Otherwise one paragraph shows as many broken lines.
  const openLine = new WeakMap<string[], boolean>(); // arr → last chunk did not end with "\n"
  const appendTo = (arr: string[], chunk: string) => {
    const text = chunk.replace(/\r/g, "");
    if (!text) return;
    const parts = text.split("\n");
    if (openLine.get(arr) && arr.length && parts[0] !== "") arr[arr.length - 1] += parts[0];
    else if (parts[0] !== "") arr.push(parts[0]);
    // keep single blank lines (paragraph breaks), collapse runs of them
    for (const l of parts.slice(1)) if (l !== "" || (arr.length && arr[arr.length - 1] !== "")) arr.push(l);
    openLine.set(arr, !text.endsWith("\n"));
    if (arr.length > MAX_TRANSCRIPT) arr.splice(0, arr.length - MAX_TRANSCRIPT);
    tui.requestRender();
  };
  setEchoSink((l) => pushLog(DIM(l)));
  const saveInv = () => writeFileSync(invFile, JSON.stringify(investigations, null, 2));

  // ---- render -----------------------------------------------------------------

  const root: Component = {
    invalidate() {},
    handleMouse(ev) {
      if (ev.type !== "wheel" || !ev.wheelDelta) return { handled: true };
      const up = ev.wheelDelta < 0;
      const step = 3;
      // streams (transcript, log) scroll back by increasing `scroll`; documents by decreasing it
      const stream = pane === 1 ? invViewOf(investigations[sel[1]]) !== "cr" : showLog;
      if (stream) scroll = Math.max(0, scroll + (up ? step : -step));
      else scroll = Math.max(0, scroll + (up ? -step : step));
      tui.requestRender();
      return { handled: true };
    },
    render(width: number): string[] {
      const height = Math.max(16, (process.stdout.rows ?? 40) - 1);
      if (splash !== undefined) return renderSplash(width, height, `${SPINNER[spin % SPINNER.length]} ${splash}…`);
      const leftW = Math.min(64, Math.max(40, Math.floor(width * 0.4)));
      const rightW = Math.max(30, width - leftW - 3);
      const tabs = PANES.map((p, i) => (i === pane ? INV(` ${i + 1} ${p} `) : DIM(` ${i + 1} ${p} `))).join(" ");
      const state = busy ? YELLOW(`   ⟳ ${busy}`) : refreshing ? DIM("   ⟳ refreshing") : lastRefresh ? DIM(`   refreshed ${hhmmss(lastRefresh)}`) : "";
      const logOn = pane === 1 ? invViewOf(investigations[sel[1]]) === "log" : showLog;
      const title = ` ${BOLD("oncall")}  ${tabs}${logOn ? "  " + INV(" log ") : ""}${state}`;
      const help = BAR(pad(" " + helpLine(), width));
      const bodyH = height - 3 - LOG_STRIP - 1;
      const left = fit(renderList(leftW, bodyH), bodyH);
      const view = showLog && pane !== 1 ? [` log  ${log.length} lines`, ...tailView(logLines(), bodyH - 1, rightW)] : renderView(rightW, bodyH);
      const right = fit([HEAD(pad(view[0] ?? "", rightW)), ...view.slice(1)], bodyH);
      const out: string[] = [truncateToWidth(title, width), "─".repeat(width)];
      for (let i = 0; i < bodyH; i++) out.push(`${pad(left[i], leftW)} │ ${truncateToWidth(right[i], rightW)}`);
      out.push(DIM("─".repeat(width)));
      if (prompt) {
        const strip = fit(logLines().slice(-(LOG_STRIP - 1)), LOG_STRIP - 1);
        for (const l of strip) out.push(truncateToWidth(` ${l}`, width));
        // hint pinned to the right edge; the typed text grows on the left without moving it
        const hint = DIM("Enter sends · Esc cancels");
        const label = prompt.mode === "ask" ? CYAN("investigator ▶") : prompt.mode === "silence" ? YELLOW(`silence ${prompt.alert?.labels?.alertname} for ${config.silence_minutes ?? 120}m · comment ▶`) : prompt.mode === "approve" ? GREEN(`approve ${prompt.cr?.req.id.slice(0, 8)} as ${REVIEWER} · reason ▶`) : RED(`deny ${prompt.cr?.req.id.slice(0, 8)} as ${REVIEWER} · reason ▶`);
        const left = ` ${label} ${prompt.text}${INV(" ")}`;
        const gap = width - visibleWidth(left) - visibleWidth(hint) - 1;
        out.push(gap > 1 ? `${left}${" ".repeat(gap)}${hint} ` : truncateToWidth(left, width));
      } else {
        for (const l of fit(logLines().slice(-LOG_STRIP), LOG_STRIP)) out.push(truncateToWidth(` ${l}`, width));
      }
      out.push(help);
      return out;
    },
  };

  function renderList(w: number, h: number): string[] {
    // Rows are variable height: a title line (wrapped, up to 3 lines) plus a badge line.
    const lines: string[] = [];
    const rowStart: number[] = [];
    const row = (i: number, title: string, badge: string) => {
      const cur = i === sel[pane];
      rowStart[i] = lines.length;
      const titleLines = wrapWords(title, Math.max(10, w - 2)).slice(0, 3);
      titleLines.forEach((t, j) => {
        const l = `${j === 0 ? (cur ? "▶ " : "  ") : "  "}${t}`;
        lines.push(cur ? INV(pad(l, w)) : pad(l, w));
      });
      lines.push(pad(`    ${badge}`, w));
    };
    if (pane === 0) {
      alerts.forEach((a, i) => {
        const sil = silencedBy(a, silences);
        const cluster = a.labels?.cluster ? DIM(`[${a.labels.cluster}] `) : "";
        row(i, alertTitle(a), `${cluster}${sil ? YELLOW(`silenced → ${sil.endsAt.slice(11, 16)}Z `) : ""}${DIM(a.annotations?.summary ?? a.annotations?.description ?? "")}`);
      });
      const hiddenSil = allAlerts.length - alerts.length;
      if (!alerts.length) lines.push(DIM(hiddenSil ? `  ${hiddenSil} silenced hidden (S)` : "  none"));
      else if (hiddenSil) lines.push(DIM(`  +${hiddenSil} silenced (S)`));
      else if (showSilenced && silences.length) lines.push(DIM("  showing silenced (S)"));
    } else if (pane === 1) {
      investigations.forEach((inv, i) => row(i, `${inv.alertName}  ${inv.beam ?? ""}`, invBadge(inv, crRowFor(inv.requestId))));
      if (!investigations.length) lines.push(DIM("  none"));
    } else {
      crs.forEach((c, i) => row(i, `${c.req.id.slice(0, 8)}  ${c.summary}`, crBadge(c)));
      if (!crs.length) lines.push(DIM(hiddenCRs ? `  ${hiddenCRs} hidden (H)` : "  none"));
      else if (hiddenCRs && !showClosed) lines.push(DIM(`  +${hiddenCRs} hidden (H)`));
      else if (showClosed) lines.push(DIM("  showing finished (H)"));
    }
    // keep the selected row visible
    const selTop = rowStart[sel[pane]] ?? 0;
    const top = Math.max(0, Math.min(selTop - Math.floor(h / 3), lines.length - h));
    return lines.slice(top, top + h);
  }

  /** The right panel: a view of the selected item. */
  function renderView(w: number, h: number): string[] {
    // key/value row; long plain values word-wrap onto continuation lines aligned under the value
    const LABEL = 14;
    const kv = (k: string, v: string | undefined, color?: (s: string) => string): string[] | undefined => {
      if (!v) return undefined;
      const lines = wrapWords(v, Math.max(20, w - LABEL));
      return lines.map((l, i) => `${i === 0 ? DIM(k.padEnd(LABEL)) : " ".repeat(LABEL)}${color ? color(l) : l}`);
    };
    const flat = (rows: Array<string | string[] | undefined>): string[] => rows.flatMap((r) => (r === undefined ? [] : Array.isArray(r) ? r : [r]));
    const doc = (lines: Array<string | string[] | undefined>) => docView(flat(lines), h, w);
    if (pane === 0) {
      const a = alerts[sel[0]];
      if (!a) return [DIM(" select an alert")];
      const inv = investigationFor(a);
      const cr = inv?.requestId ? crs.find((c) => c.req.id === inv.requestId) : crFor(a);
      return doc([
        BOLD(a.labels?.alertname ?? "alert") + `  ${sevColor(a.labels?.severity)}  ${DIM(a.status?.state ?? "")}`,
        "",
        kv("summary", a.annotations?.summary),
        kv("descr.", a.annotations?.description),
        kv("since", a.startsAt ? `${a.startsAt.replace("T", " ").slice(0, 19)}Z` : undefined),
        kv("runbook", a.annotations?.runbook ?? a.annotations?.runbook_url),
        kv("fingerprint", a.fingerprint),
        kv("silence", (() => { const sil = silencedBy(a, silences); return sil ? YELLOW(`until ${sil.endsAt.replace("T", " ").slice(0, 16)}Z · ${sil.createdBy}: ${sil.comment}`) : undefined; })()),
        "",
        BOLD("labels"),
        ...Object.entries(a.labels ?? {}).sort().map(([k, v]) => `  ${DIM(k.padEnd(14))}${v}`),
        "",
        kv("investigator", inv ? `${invStatus(inv, cr)}${inv.beam ? ` · ${inv.beam}` : ""}` : DIM("none")),
        kv("access req", cr ? `${cr.req.id.slice(0, 8)} ${stateColor(cr.req.state)}` : undefined),
        kv("executor", cr ? exStatus(cr).color(exStatus(cr).label) : undefined),
      ]);
    }
    if (pane === 1) {
      const inv = investigations[sel[1]];
      if (!inv) return [DIM(" select an investigation")];
      const a = alertFor(inv);
      const c = crRowFor(inv.requestId);
      const header: Array<string | string[] | undefined> = [
        BOLD(inv.alertName) + `  ${invStatus(inv, c)}  ${a ? YELLOW("alert firing") : GREEN("alert not active")}`,
        kv("beam", inv.beam ? `${inv.beam}${inv.bot ? `  bot ${inv.bot}` : ""}` : DIM(inv.status === "removed" ? "removed" : inv.status === "starting" ? "none · starting" : "none")),
        kv("conclusion", inv.conclusion, GREEN),
        ...executorBlock(inv, c, kv),
      ];
      const view = invViewOf(inv);
      const tab = (name: string, on: boolean, off = false) => (on ? INV(` ${name} `) : off ? DIM(` ${name} `) : ` ${name} `);
      const tabs = `${tab("transcript", view === "transcript")}${inv.status === "running" && view !== "transcript" ? YELLOW("●") : ""} ${tab(crLabel(inv), view === "cr", !inv.crYaml)} ${tab("log", view === "log")}`;
      const head = [...flat(header), "", tabs];
      const room = h - head.length;
      if (view === "cr") return [...head, DIM(inv.requestId ? "filed; immutable" : inv.crPath ?? ""), ...docView(yamlLines(inv.crYaml ?? ""), room - 1, w)];
      if (view === "log") {
        const mine = logLines(inv.id);
        return [...head, ...tailView(mine.length ? mine : [DIM("nothing logged for this investigation yet")], room, w)];
      }
      const t = [...(inv.transcript ?? []), ...(inv.streaming ? inv.streaming.split("\n") : [])];
      const empty = syncInflight.has(inv.id) ? "…" : inv.beam ? "no output yet" : "no output";
      return [...head, ...tailView(t.length ? t : [DIM(empty)], room, w)];
    }
    const c = crs[sel[2]];
    if (!c) return [DIM(" select a change request")];
    const inv = investigations.find((v) => v.requestId === c.req.id);
    const ts = (s?: string) => (s ? s.replace("T", " ").slice(0, 19) : undefined);
    const ex = c.cr?.executor;
    return doc([
      BOLD(`Access Request ${c.req.id}`) + `  ${stateColor(c.req.state)}`,
      kv("requester", c.req.user),
      kv("roles", c.req.roles.join(", ")),
      kv("created", ts(c.req.created)),
      kv("expires", ts(c.req.accessExpiry ?? c.req.expires)),
      kv("reviewer", c.req.state === "PENDING" ? `${REVIEWER} ${DIM("(a / d review as this user)")}` : DIM(c.req.state.toLowerCase())),
      kv("investigator", inv ? `${inv.alertName} · ${inv.beam ?? DIM("beam gone")} · ${invStatusColor(inv.status)}` : DIM("none")),
      kv("executor", ex ? `bot ${ex.bot} · beam ${ex.beam} · app ${ex.app}  ${DIM("(state in Investigations)")}` : DIM("none named in the request")),
      "",
      BOLD("reason") + DIM("  (the change request as filed)"),
      "",
      ...yamlLines(c.req.reason),
    ]);
  }

  type KV = (k: string, v: string | undefined, color?: (s: string) => string) => string[] | undefined;

  /** The executor as the investigation sees it: none, or its state as the executor reports it. */
  function executorBlock(inv: Investigation, c: CRRow | undefined, kv: KV): Array<string | string[] | undefined> {
    if (!c) {
      if (inv.pending?.kind === "submit") {
        const p = inv.pending;
        const prog = p.progress ?? { step: 0 };
        const steps = [
          `new beam for the executor${prog.beam ? `  ${prog.beam}` : ""}`,
          `one-change bot + one-time join token${prog.bot ? `  ${prog.bot}` : ""}`,
          "bootstrap: tbot joins as the bot, plan-runner starts",
          `publish plan-runner as a Teleport app${prog.app ? `  ${prog.app}` : ""}`,
          "Access Request for that app · needs a reviewer's approval",
        ];
        return [
          kv("executor", YELLOW(`submitting via ${p.via} · since ${hhmmss(new Date(p.at))}`)),
          ...steps.map((s, i) => `  ${i < prog.step ? GREEN("✓") : i === prog.step ? YELLOW("⟳") : DIM("·")} ${i <= prog.step ? s : DIM(s)}`),
        ];
      }
      if (inv.requestId) return [kv("executor", YELLOW(`filed ${inv.requestId.slice(0, 8)} · loading…`))];
      return [kv("executor", DIM("none"))];
    }
    const st = exStatus(c);
    const live = c.live;
    const sub = (k: string, v: string | undefined) => kv(`  ${k}`, v);
    const lines: Array<string | string[] | undefined> = [
      DIM("executor"),
      sub("state", `${st.color(st.label)}${st.detail ? DIM(` · ${st.detail}`) : ""}${!live && liveInflight.has(c.req.id) ? DIM(" …") : ""}`),
      sub("request", `${c.req.id.slice(0, 8)} ${stateColor(c.req.state)}`),
      c.executor?.beam || c.executor?.bot ? sub("beam", `${c.executor.beam ?? DIM("gone")}${c.executor.bot ? `  bot ${c.executor.bot}` : ""}${c.executor.appName ? `  app ${c.executor.appName}` : ""}`) : undefined,
      live?.approved && executorOpen(c) ? sub("driver", hasInvestigator(inv) ? `investigator ${inv.beam}` : YELLOW("laptop (investigator gone)")) : undefined,
      live?.inflight ? sub("running", YELLOW(`${live.inflight.op} ${live.inflight.step}.${live.inflight.kind} since ${live.inflight.since.slice(11, 19)}Z`)) : undefined,
      inv.pending?.kind === "op" && !live?.inflight ? sub("pending", YELLOW(`${inv.pending.op} → ${inv.pending.via} at ${hhmmss(new Date(inv.pending.at))}`)) : undefined,
      sub("last", lastOp(live)),
    ];
    if (live?.steps?.length) {
      lines.push(DIM("  steps"));
      for (const s of live.steps) lines.push(`    ${stepMark(s)} ${BOLD(s.name)}  ${DIM(s.run)}${s.verify && !isAsserting(s.verify) ? YELLOW("  verify: no-op") : !s.verify ? YELLOW("  no verify") : ""}`);
    }
    return lines;
  }

  /** A document: shown from the top, scrolled with [ ]. Lines are word-wrapped to the width first. */
  function docView(raw: string[], h: number, w: number): string[] {
    const lines = raw.flatMap((l) => wrapWords(l, w));
    const top = Math.max(0, Math.min(scroll, Math.max(0, lines.length - h)));
    const slice = lines.slice(top, top + h);
    if (lines.length > top + h) slice[h - 1] = DIM(`… ${lines.length - top - h + 1} more lines  ( ] to scroll )`);
    return slice;
  }
  /** A stream: shown from the bottom, scrolled back with [. Lines are word-wrapped to the width first. */
  function tailView(raw: string[], h: number, w: number): string[] {
    const lines = raw.flatMap((l) => wrapWords(l, w));
    const end = Math.max(h, lines.length - scroll);
    return lines.slice(Math.max(0, end - h), end);
  }

  tui.setLayoutRoot(root);

  // ---- actions: what the selection's state allows right now --------------------------------

  const act = (key: string, label: string, run: () => void): Action => ({ key, label, run });

  function crRowFor(id?: string): CRRow | undefined {
    return id ? crs.find((c) => c.req.id === id) ?? allCRs.find((c) => c.req.id === id) : undefined;
  }
  function invViewOf(inv?: Investigation): InvView {
    if (invView !== "auto") return invView;
    return inv?.crYaml && inv.status !== "running" ? "cr" : "transcript";
  }
  function hasInvestigator(inv: Investigation): boolean {
    return Boolean(inv.beam) && inv.status !== "removed" && inv.status !== "starting";
  }

  function actionsFor(p: number): Action[] {
    const out: Action[] = [];
    if (p === 0) {
      const a = alerts[sel[0]];
      if (a) {
        const inv = investigationFor(a);
        if (!inv || ["failed", "removed", "no-cr"].includes(inv.status)) out.push(act("i", "investigate", () => void guarded("investigate", () => doInvestigate(a))));
        if (inv) out.push(act("Enter", "investigation", () => switchPane(1)));
        const sil = silencedBy(a, silences);
        if (sil) out.push(act("M", "unsilence", () => void guarded("unsilence", () => doUnsilence(sil))));
        else out.push(act("m", "silence", () => { prompt = { text: inv?.requestId ? `oncall: Access Request ${inv.requestId}` : "oncall", mode: "silence", alert: a }; }));
        out.push(act("y", "copy", () => void copySelected()));
      }
      out.push(act("S", showSilenced ? "hide silenced" : "show silenced", () => { showSilenced = !showSilenced; applyAlertFilter(); }));
      return out;
    }
    if (p === 1) {
      const inv = investigations[sel[1]];
      if (!inv) return out;
      const c = crRowFor(inv.requestId);
      const live = c?.live;
      const quiet = !inv.pending && !live?.inflight;
      if (hasInvestigator(inv)) out.push(act("p", "ask", () => { prompt = { text: "", mode: "ask" }; }));
      if (inv.crPath && !inv.requestId && inv.status === "drafted" && quiet) {
        out.push(act("s", "submit", () => void guarded("submit", () => doSubmit(inv), inv.id)));
        out.push(act("e", "edit", () => editDraft(inv)));
      }
      if (c && live?.approved && quiet && executorOpen(c)) {
        if (live.available.includes("execute")) {
          out.push(act("n", `exec ${live.next_execute ?? ""}`.trim(), () => void guarded("exec", () => doStep(inv, c, "execute"), inv.id)));
          if (hasInvestigator(inv)) out.push(act("r", "run all", () => void guarded("run", () => doStep(inv, c, "run"), inv.id)));
        }
        if (live.available.includes("verify")) out.push(act("v", "verify", () => void guarded("verify", () => doStep(inv, c, "verify"), inv.id)));
        if (live.available.includes("rollback")) out.push(act("b", `rollback ${live.next_rollback ?? ""}`.trim(), () => void guarded("rollback", () => doStep(inv, c, "rollback"), inv.id)));
      }
      const cur = invViewOf(inv);
      const show = (v: InvView) => () => { invView = v; scroll = 0; };
      if (cur !== "transcript") out.push(act("t", "transcript", show("transcript")));
      if (cur !== "cr" && inv.crYaml) out.push(act("c", crLabel(inv), show("cr")));
      if (cur !== "log") out.push(act("l", "log", show("log")));
      if (inv.beam) out.push(act("A", "attach", () => void attachSelected()));
      if (inv.bot || inv.beam || c?.executor?.bot) out.push(act("w", "audit", () => void openAudit(c?.executor?.bot ?? inv.bot ?? inv.beam ?? inv.alertName)));
      if (quiet && inv.status !== "starting") out.push(act("x", "teardown", () => void guarded("teardown", () => doTeardown(inv), inv.id)));
      out.push(act("y", "copy", () => void copySelected()));
      return out;
    }
    const c = crs[sel[2]];
    if (c) {
      if (c.req.state === "PENDING") {
        out.push(act("a", "approve", () => { prompt = { text: "", mode: "approve", cr: c }; }));
        out.push(act("d", "deny", () => { prompt = { text: "", mode: "deny", cr: c }; }));
      }
      if (investigations.some((v) => v.requestId === c.req.id)) out.push(act("Enter", "investigation", () => switchPane(1)));
      out.push(act("w", "audit", () => void openAudit(c.executor?.bot ?? c.cr?.executor?.bot ?? c.req.id.slice(0, 8))));
      out.push(act("y", "copy id", () => void copySelected()));
    }
    out.push(act("H", showClosed ? "hide finished" : "show finished", () => { showClosed = !showClosed; void refreshCRs(false); }));
    return out;
  }

  function helpLine(): string {
    const acts = actionsFor(pane).map((a) => `${a.key === "Enter" ? "⏎" : a.key} ${a.label}`);
    const logKey = pane === 1 ? (invViewOf(investigations[sel[1]]) === "log" ? "L back" : "L log") : showLog ? "L details" : "L log";
    return [...acts, "Tab/1-3", "↑↓", "[ ]", logKey, "R refresh", "q"].join(" · ");
  }

  function matchAction(acts: Action[], k: string, data: string): Action | undefined {
    const enter = k === "enter" || data === "\r";
    const hit = acts.find((a) => {
      if (a.key === "Enter") return enter;
      if (/^[A-Z]$/.test(a.key)) return data === a.key || k === `shift+${a.key.toLowerCase()}`;
      return k === a.key;
    });
    return hit ?? (pane === 1 && enter ? acts.find((a) => a.key === "A") : undefined);
  }

  // ---- input ------------------------------------------------------------------

  tui.addInputListener((data: string) => {
    // pi-tui may run the terminal in the Kitty keyboard protocol, so match keys through
    // its helpers instead of comparing raw escape sequences. parseKey gives "a", "shift+r", "up", ...
    // Kitty reports press, repeat and release; a raw input listener sees all three, so without
    // this every key acted twice (press + release) and arrows felt twice as fast.
    if (isKeyRelease(data)) return { consume: true };
    const k = parseKey(data) ?? data;
    const is = (id: Parameters<typeof matchesKey>[1]) => matchesKey(data, id);
    if (splash !== undefined && !(k === "q" || is(Key.ctrl("c")))) return { consume: true };
    if (prompt) {
      if (is(Key.escape) || k === "escape") prompt = undefined;
      else if (is(Key.enter) || k === "enter" || data === "\r") {
        const text = prompt.text.trim();
        const p = prompt;
        prompt = undefined;
        if (p.mode === "ask") {
          if (text) void guarded("ask investigator", () => doAsk(investigations[sel[1]], text), investigations[sel[1]]?.id);
        } else if (p.mode === "silence") {
          if (p.alert) void guarded("silence", () => doSilence(p.alert!, text));
        } else if (p.cr) void guarded(p.mode, () => doReview(p.cr!, p.mode as "approve" | "deny", text || `${p.mode}d via oncall`));
      } else if (is(Key.backspace) || k === "backspace") prompt.text = prompt.text.slice(0, -1);
      else if (is(Key.ctrl("c"))) prompt = undefined;
      else {
        const ch = decodeKittyPrintable(data) ?? (k === "space" ? " " : data.length === 1 && data >= " " ? data : undefined);
        if (ch) prompt.text += ch;
      }
      tui.requestRender();
      return { consume: true };
    }
    if (k === "q" || is(Key.ctrl("c"))) {
      closeAppProxies();
      for (const c of recorders.values()) c.kill("SIGTERM"); // ends the Teleport session recordings cleanly
      tui.stop();
      process.exit(0);
    }
    const up = is(Key.up) || k === "k";
    const down = is(Key.down) || k === "j";
    const backTab = is(Key.shift("tab")) || k === "shift+tab";
    const tab = !backTab && is(Key.tab);
    const refreshKey = k === "shift+r" || data === "R";
    const logKey = k === "shift+l" || data === "L";
    if (backTab) switchPane((pane + 2) % 3);
    else if (tab) switchPane((pane + 1) % 3);
    else if (k === "1" || k === "2" || k === "3") switchPane(Number(k) - 1);
    else if (up) select(pane, sel[pane] - 1);
    else if (down) select(pane, sel[pane] + 1);
    else if (k === "]" || k === "pagedown") scroll += 5;
    else if (k === "[" || k === "pageup") scroll = Math.max(0, scroll - 5);
    else if (logKey) {
      if (pane === 1) invView = invViewOf(investigations[sel[1]]) === "log" ? "auto" : "log";
      else showLog = !showLog;
      scroll = 0;
    }
    else if (refreshKey) void refreshAll(true);
    else {
      const a = matchAction(actionsFor(pane), k, data);
      if (a && busy && !FREE_KEYS.has(a.key)) pushLog(YELLOW(`busy (${busy}); wait`));
      else a?.run();
    }
    tui.requestRender();
    return { consume: true };
  });

  tui.start();
  pushLog(BOLD("oncall") + DIM(`  ${PROXY.replace(/:\d+$/, "")}` + (o.mockKubectl ? " · MOCK kubectl" : "")));
  await refreshAll(true); // the splash shows each step (loading alerts, loading change requests)
  splash = undefined;
  clearInterval(spinTimer);
  tui.requestRender();
  const every = (o.refreshEvery ?? 20) * 1000;
  if (every > 0) setInterval(() => void refreshAll(false), every).unref();
  // fast path while anything awaits review: re-read request states every 5s (one tsh call), fetch the
  // executor as soon as a state changes, so approval shows within seconds wherever it came from
  setInterval(() => void refreshRequestStates(), 5000).unref();
  setInterval(() => void pollExecutors(), 5000).unref();

  // ---- selection / linking ----------------------------------------------------------

  function paneLen(p = pane) {
    return [alerts.length, investigations.length, crs.length][p];
  }

  function select(p: number, i: number) {
    const before = sel[p];
    sel[p] = Math.max(0, Math.min(Math.max(0, paneLen(p) - 1), i));
    if (sel[p] !== before || p !== pane) {
      scroll = 0;
      invView = "auto";
    }
    if (p === 1) {
      void syncInvestigation(investigations[sel[1]]);
      void fetchLive(crRowFor(investigations[sel[1]]?.requestId));
    }
  }

  /** Switch pane, carrying the selection over: alert ↔ investigation ↔ change request. */
  function switchPane(to: number) {
    const from = pane;
    let fp: string | undefined, since: string | undefined, reqId: string | undefined;
    if (from === 0 && alerts[sel[0]]) (fp = alerts[sel[0]].fingerprint), (since = alerts[sel[0]].startsAt);
    if (from === 1 && investigations[sel[1]]) ({ alertFingerprint: fp, alertStartsAt: since, requestId: reqId } = investigations[sel[1]]);
    if (from === 2 && crs[sel[2]]) (reqId = crs[sel[2]].req.id), (fp = crs[sel[2]].cr?.alert?.fingerprint), (since = crs[sel[2]].cr?.alert?.since);
    pane = to;
    scroll = 0;
    invView = "auto";
    const occ = (f?: string, s?: string) => Boolean(fp && f === fp && (!since || !s || s === since));
    let i = -1;
    if (to === 0) i = alerts.findIndex((a) => occ(a.fingerprint, a.startsAt));
    if (to === 1) i = investigations.findIndex((v) => (reqId && v.requestId === reqId) || occ(v.alertFingerprint, v.alertStartsAt));
    if (to === 2) i = crs.findIndex((c) => (reqId && c.req.id === reqId) || occ(c.cr?.alert?.fingerprint, c.cr?.alert?.since));
    select(to, i >= 0 ? i : sel[to]);
  }

  // An alert occurrence is (fingerprint, startsAt). The fingerprint alone repeats on every re-fire of the
  // same labels, so a new firing must not inherit the previous occurrence's investigation or request.
  const sameOccurrence = (fp?: string, since?: string, a?: Alert) => Boolean(a && fp && a.fingerprint === fp && (!since || a.startsAt === since));
  function investigationFor(a?: Alert) {
    return a ? investigations.find((v) => sameOccurrence(v.alertFingerprint, v.alertStartsAt, a)) : undefined;
  }
  function crFor(a?: Alert) {
    return a ? crs.find((c) => sameOccurrence(c.cr?.alert?.fingerprint, c.cr?.alert?.since, a)) : undefined;
  }
  function alertFor(inv: Investigation) {
    return alerts.find((a) => sameOccurrence(inv.alertFingerprint, inv.alertStartsAt, a)) ?? allAlerts.find((a) => sameOccurrence(inv.alertFingerprint, inv.alertStartsAt, a));
  }

  // ---- actions ----------------------------------------------------------------

  async function guarded(label: string, fn: () => Promise<void>, invId?: string) {
    busy = label;
    const prevCtx = logCtx;
    logCtx = invId;
    tui.requestRender();
    try {
      await fn();
    } catch (e) {
      pushLog(RED(`error: ${(e as Error).message}`));
    } finally {
      logCtx = prevCtx;
      busy = undefined;
      tui.requestRender();
      void refreshAll(false); // every action ends with fresh state
    }
  }

  /** w: the Teleport Web UI audit log, searched for the selected bot / beam. Every hop is a native event there:
   *  access_request.create/review, bot.create, exec/sftp on the beam node, bot.join, cert.create, app.session.start,
   *  kube.request as the bot, bot.delete. */
  async function openAudit(term: string) {
    const cluster = PROXY.replace(/:\d+$/, "");
    const url = `https://${cluster}/web/cluster/${cluster}/audit?search=${encodeURIComponent(term)}`;
    const r = await run(process.platform === "darwin" ? "open" : "xdg-open", [url]);
    pushLog(r.ok ? DIM(`audit → ${url}`) : YELLOW(`open failed: ${url}`));
  }

  /** A / Enter: open the selected beam's tmux in a new terminal tab (Ghostty), or print the command. */
  async function attachSelected() {
    if (attaching) return; // one attach at a time: two AppleScript runs would type into the same tab
    attaching = true;
    try {
      await attachSelectedInner();
    } finally {
      attaching = false;
    }
  }
  async function attachSelectedInner() {
    let beam: string | undefined;
    if (pane === 1) beam = investigations[sel[1]]?.beam;
    if (pane === 2) beam = crs[sel[2]]?.executor?.beam;
    if (!beam) return pushLog(YELLOW("no live beam on the selection"));
    const cmd = `tsh --proxy ${PROXY} beams ssh ${beam}`;
    const how = await openTerminal(cmd);
    pushLog(how.ok ? GREEN(`attach → ${how.where}`) : YELLOW(`${how.where}: ${cmd}`));
  }

  /** y: copy the selected item's useful string (attach command, request id, alert JSON) to the clipboard. */
  async function copySelected() {
    let textToCopy: string | undefined;
    if (pane === 0 && alerts[sel[0]]) textToCopy = JSON.stringify(alerts[sel[0]]);
    if (pane === 1 && investigations[sel[1]]) textToCopy = investigations[sel[1]].attach?.replace(/\s+#.*$/, "") ?? investigations[sel[1]].crPath;
    if (pane === 2 && crs[sel[2]]) textToCopy = crs[sel[2]].req.id;
    if (!textToCopy) return pushLog(YELLOW("nothing to copy"));
    try {
      const { spawn } = await import("node:child_process");
      const cmd = process.platform === "darwin" ? "pbcopy" : process.platform === "win32" ? "clip" : "xclip";
      const args = cmd === "xclip" ? ["-selection", "clipboard"] : [];
      await new Promise<void>((resolve, reject) => {
        const p = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
        p.on("error", reject);
        p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} exited ${c}`))));
        p.stdin.end(textToCopy);
      });
      pushLog(GREEN(`copied: ${textToCopy.length > 100 ? textToCopy.slice(0, 100) + "…" : textToCopy}`));
    } catch (e) {
      pushLog(YELLOW(`copy failed (${(e as Error).message}); value: ${textToCopy}`));
    }
  }

  let statesInflight = false;
  async function refreshRequestStates() {
    if (statesInflight || refreshing) return;
    const pending = allCRs.filter((c) => c.req.state === "PENDING" || (c.live && !c.live.approved && c.req.state !== "DENIED"));
    if (!pending.length) return;
    statesInflight = true;
    try {
      const fresh = await listCRs();
      for (const c of pending) {
        const f = fresh.find((r) => r.id === c.req.id);
        if (f && f.state !== c.req.state) {
          c.req.state = f.state;
          c.liveAt = 0;
          pushLog(`${c.req.id.slice(0, 8)} ${stateColor(f.state)}`);
          void fetchLive(c, true);
        }
      }
      tui.requestRender();
    } catch {
      /* next tick */
    } finally {
      statesInflight = false;
    }
  }

  /** Refresh alerts and change requests. Quiet on the timer, chatty when asked (R). */
  async function refreshAll(verbose: boolean) {
    if (refreshing) return;
    refreshing = true;
    tui.requestRender();
    const stage = (what: string) => {
      if (splash !== undefined) {
        splash = what;
        tui.requestRender();
      }
    };
    try {
      try {
        stage("loading alerts");
        allAlerts = await fetchAlerts({ file: o.alertsFile });
        if (!o.alertsFile) silences = await fetchSilences().catch(() => silences);
        applyAlertFilter();
        if (verbose) pushLog(DIM(`alerts: ${alerts.length}`));
      } catch (e) {
        pushLog(RED(`alerts: ${(e as Error).message}`));
      }
      stage("loading access requests");
      await refreshCRs(verbose);
      for (let i = 0; i < 3; i++) sel[i] = Math.min(sel[i], Math.max(0, paneLen(i) - 1));
      lastRefresh = new Date();
      if (pane === 1) {
        void syncInvestigation(investigations[sel[1]], investigations[sel[1]]?.status === "running");
        void fetchLive(crRowFor(investigations[sel[1]]?.requestId));
      }
    } catch (e) {
      pushLog(RED(`refresh: ${(e as Error).message}`));
    } finally {
      refreshing = false;
      tui.requestRender();
    }
  }

  async function refreshCRs(verbose: boolean) {
    // Teleport is the source of truth: requests from `tsh request ls`, executors from bot labels.
    const [reqs, recovered, tracked, beams] = await Promise.all([listCRs(), recoverExecutors(), discover(), listBeams().catch(() => [])]);
    const prev = new Map(crs.map((c) => [c.req.id, c]));
    crs = reqs.map((req) => {
      const st = recovered.get(req.id) ?? loadState(req.id);
      let cr: CR | undefined;
      try {
        cr = parseCR(req.reason);
      } catch {
        /* not a CR-shaped reason */
      }
      const summary = cr?.summary ?? req.reason.split("\n").find((l) => l.startsWith("summary:"))?.slice(8).trim() ?? "(no summary)";
      const executor = st?.bot ? { beam: st.beam, bot: st.bot, appName: st.appName, phase: st.phase } : st?.phase === "TORN_DOWN" ? { phase: "TORN_DOWN" } : undefined;
      const old = prev.get(req.id);
      return { req, cr, summary, executor, live: old?.live, liveAt: old?.liveAt };
    });
    // Old, finished change requests leave the list (closed / denied / expired for longer than hide_closed_after).
    allCRs = crs;
    const minutes = config.hide_closed_after ?? 30;
    const cutoff = Date.now() - minutes * 60_000;
    const finishedAt = (c: CRRow): number | undefined => {
      const st = loadState(c.req.id);
      if (st?.closedAt) return new Date(st.closedAt).getTime();
      if (c.req.state === "DENIED") return new Date(c.req.created).getTime();
      if (c.req.expires && new Date(c.req.expires).getTime() < Date.now()) return new Date(c.req.expires).getTime();
      if (c.executor?.phase === "TORN_DOWN" || (c.req.state === "APPROVED" && !c.executor?.appName)) return new Date(c.req.created).getTime();
      return undefined;
    };
    if (minutes > 0 && !showClosed) {
      crs = allCRs.filter((c) => {
        const t = finishedAt(c);
        return t === undefined || t > cutoff;
      });
    }
    hiddenCRs = allCRs.length - crs.length;
    // An investigator that submitted from its beam: link its request by the executor bot's parent-beam label.
    for (const t of tracked.filter((t) => t.role === "executor" && t.parent && t.parent !== "-")) {
      const inv = investigations.find((v) => v.beam === t.parent && !v.requestId);
      if (inv && /^[0-9a-f-]{36}$/i.test(t.ref)) inv.requestId = t.ref;
    }
    // Investigations known to Teleport (bot labels) but not in the local list: show them as recovered.
    for (const t of tracked.filter((t) => t.role === "investigator")) {
      const known = investigations.find((i) => i.bot === t.bot);
      if (known) {
        if (!known.app && t.app) known.app = t.app;
        continue;
      }
      investigations.push({
        id: t.bot, alertName: t.ref, alertFile: "", beam: t.beamAlive ? t.beamAlias : undefined, bot: t.bot, app: t.app,
        attach: t.beamAlive ? `tsh --proxy ${PROXY} beams ssh ${t.beamAlias}` : undefined,
        status: t.beamAlive ? "running" : "removed", startedAt: "", transcript: [],
      });
    }
    // Kept: running here (liveStreams), starting, failed, beam alive, unsubmitted drafts, and anything with an open executor.
    const beamAliases = new Set(beams.map((b) => b.id));
    const beamAlive = (inv: Investigation) =>
      inv.bot ? tracked.some((t) => t.bot === inv.bot && t.beamAlive) : Boolean(inv.beam && beamAliases.has(inv.beam));
    for (const inv of investigations) {
      if (liveStreams.has(inv.id)) continue;
      if (inv.status === "running" && !beamAlive(inv)) inv.status = "removed";
    }
    const before = investigations.length;
    investigations = investigations.filter(
      (inv) => liveStreams.has(inv.id) || inv.status === "starting" || inv.status === "failed" || beamAlive(inv) || (inv.crPath && !inv.requestId) || executorOpen(crRowFor(inv.requestId)),
    );
    // an open executor with no investigation row (filed from the CLI, or the row was lost) gets one
    for (const c of allCRs) {
      if (!executorOpen(c) || investigations.some((v) => v.requestId === c.req.id)) continue;
      investigations.push({
        id: `exec-${c.req.id}`, alertName: c.cr?.alert?.name ?? c.summary, alertFingerprint: c.cr?.alert?.fingerprint, alertStartsAt: c.cr?.alert?.since,
        alertFile: "", status: "removed", requestId: c.req.id, crYaml: c.req.reason, startedAt: c.req.created, transcript: [],
      });
    }
    if (investigations.length !== before) sel[1] = Math.min(sel[1], Math.max(0, investigations.length - 1));
    reconcileAll();
    saveInv();
  }

  /** Follow the laptop-side submit's step lines (ops.submit echoes) to show where registration is. */
  function noteSubmitProgress(inv: Investigation, text: string): void {
    const p = inv.pending;
    if (p?.kind !== "submit") return;
    const prog = p.progress ?? { step: 0 };
    const at = (re: RegExp, step: number) => {
      if (re.test(text)) prog.step = Math.max(prog.step, step);
    };
    prog.beam = text.match(/executor beam (\S+) created/)?.[1] ?? prog.beam;
    prog.bot = text.match(/create executor bot (administrator-[0-9a-f]+)/)?.[1] ?? prog.bot;
    prog.app = text.match(/published app (\S+)/)?.[1] ?? prog.app;
    at(/create executor bot/, 1);
    at(/copy plan-runner|bootstrap/, 2);
    at(/publish/, 3);
    at(/file the (Access Request|change request)/, 4);
    p.progress = prog;
  }

  // ---- the investigator's API (published app): state, events, message, draft --------------------

  interface InvState {
    busy: boolean;
    status: "investigating" | "drafted" | "no-change" | "no-cr";
    revision: number;
    draft: string | null;
    proposal: string | null;
    conclusion: string | null;
    filed: { requestId: string; beam: string; bot: string; app: string; appUrl: string; mcpUrl: string } | null;
    executorUrl: string | null;
    submitProgress: { step: number; beam?: string; bot?: string; app?: string; error?: string } | null;
    streaming: string;
    seq: number;
  }
  interface InvEvent {
    seq: number;
    at: string;
    type: "assistant" | "operator" | "tool_start" | "tool_end" | "note";
    text: string;
    tool?: string;
    isError?: boolean;
  }

  function api(inv: Investigation) {
    if (!inv.app) throw new Error(`${inv.alertName}: investigator API not published yet`);
    return appProxy(inv.app);
  }

  /** POST /message: one operator message; the reply arrives as events. */
  async function sendToInvestigator(inv: Investigation, text: string) {
    if (!hasInvestigator(inv)) throw new Error("the investigator is not running");
    await api(inv).fetch("/message", { method: "POST", body: { text } });
  }

  function applyState(inv: Investigation, st: InvState) {
    if (st.draft && st.draft !== inv.crYaml) {
      inv.crPath = inv.crPath ?? join(stateDir(), `draft-${inv.alertName}-${inv.id.slice(-6)}.yaml`);
      writeFileSync(inv.crPath, st.draft);
      if (inv.crYaml && st.revision > 1) pushLog(CYAN(`${inv.alertName}: draft rev ${st.revision}`), inv.id);
      inv.crYaml = st.draft;
    }
    inv.draftRev = st.revision;
    inv.proposalPending = Boolean(st.proposal);
    inv.conclusion = st.conclusion ?? undefined;
    inv.streaming = st.streaming || undefined;
    if (inv.status === "running" || inv.status === "drafted" || inv.status === "no-cr" || inv.status === "no-change") {
      inv.status = st.status === "investigating" ? "running" : st.status;
    }
    if (inv.pending?.kind === "submit" && st.submitProgress) inv.pending.progress = st.submitProgress;
    if (st.filed && !inv.requestId) {
      inv.requestId = st.filed.requestId;
      reconcile(inv);
      void refreshCRs(false).then(() => fetchLive(crRowFor(st.filed!.requestId), true));
    }
    inv.draftAt = Date.now();
  }

  function applyEvents(inv: Investigation, evs: InvEvent[]) {
    const t = inv.transcript ?? (inv.transcript = []);
    for (const e of evs) {
      if (e.seq <= (inv.eventSeq ?? 0)) continue;
      inv.eventSeq = e.seq;
      switch (e.type) {
        case "operator":
          t.push("", `${CYAN("you ▶")} ${e.text}`, "");
          break;
        case "assistant":
          t.push(...e.text.split("\n"));
          break;
        case "tool_start":
          t.push("", DIM(`▶ ${e.tool}${e.text ? ` ${e.text}` : ""}`));
          break;
        case "tool_end":
          if (e.text.trim()) t.push(...e.text.split("\n").map((l) => (e.isError ? RED(`    ${l}`) : DIM(`    ${l}`))));
          break;
        case "note":
          t.push(YELLOW(noteText(e.text)));
          break;
      }
    }
    if (t.length > MAX_TRANSCRIPT) t.splice(0, t.length - MAX_TRANSCRIPT);
  }

  /** Poll one investigation's API: state, then events since the last seen sequence. */
  async function syncInvestigation(inv?: Investigation, force = false) {
    if (!inv?.app || !hasInvestigator(inv) || syncInflight.has(inv.id)) return;
    if (!force && inv.draftAt && Date.now() - inv.draftAt < 2500) return;
    syncInflight.add(inv.id);
    tui.requestRender();
    try {
      const p = api(inv);
      const st = await p.fetch<InvState>("/state");
      applyState(inv, st);
      if (st.seq > (inv.eventSeq ?? 0)) {
        const ev = await p.fetch<{ events: InvEvent[] }>(`/events?since=${inv.eventSeq ?? 0}`);
        applyEvents(inv, ev.events);
      }
      saveInv();
    } catch (e) {
      pushLog(DIM(`${inv.alertName}: investigator api: ${(e as Error).message}`), inv.id);
    } finally {
      syncInflight.delete(inv.id);
      tui.requestRender();
    }
  }

  /** p: one message to the investigator over its API. The reply streams into the transcript. */
  async function doAsk(inv: Investigation | undefined, text: string) {
    if (!inv?.beam) throw new Error("no running investigation selected");
    await sendToInvestigator(inv, text);
    invView = "transcript";
    inv.draftAt = 0;
    pushLog(DIM(`→ ${inv.beam}`));
    void syncInvestigation(inv, true);
  }

  /** Background fetch of the executor's live status for one CR (no busy flag; a few seconds via tsh proxy app). */
  async function fetchLive(c?: CRRow, force = false) {
    if (!c?.executor?.appName || liveInflight.has(c.req.id)) return;
    if (!force && c.liveAt && Date.now() - c.liveAt < 15_000) return;
    liveInflight.add(c.req.id);
    tui.requestRender();
    try {
      const s = await executorStatus(c.req.id, () => {});
      const who = investigations.find((v) => v.requestId === c.req.id)?.id;
      const seen = c.live?.log?.length ?? (c.live ? 0 : s.log?.length ?? 0); // first fetch: history, not news
      for (const l of (s.log ?? []).slice(seen)) {
        pushLog(`${DIM(`${c.executor?.bot ?? c.req.id.slice(0, 8)}`)} ${l.op} ${BOLD(`${l.step}.${l.kind}`)} ${l.code === 0 ? GREEN("ok") : RED(`exit ${l.code}`)} ${DIM(`by ${l.caller} · ${l.at.slice(11, 19)}Z`)}`, who);
      }
      if (s.inflight && !c.live?.inflight) pushLog(`${DIM(c.executor?.bot ?? c.req.id.slice(0, 8))} ${YELLOW(`running ${s.inflight.step}.${s.inflight.kind}`)}`, who);
      if (c.live && s.phase !== c.live.phase) pushLog(`${DIM(c.executor?.bot ?? c.req.id.slice(0, 8))} phase ${c.live.phase} → ${BOLD(s.phase)}`, who);
      c.live = s;
      c.liveAt = Date.now();
      c.executor = { ...c.executor, phase: s.phase };
      reconcileAll();
    } catch (e) {
      pushLog(DIM(`${c.req.id.slice(0, 8)}: executor status: ${(e as Error).message}`), investigations.find((v) => v.requestId === c.req.id)?.id);
    } finally {
      liveInflight.delete(c.req.id);
      tui.requestRender();
    }
  }

  async function doInvestigate(alert: Alert) {
    const alertName = alert.labels?.alertname ?? "alert";
    const alertFile = join(stateDir(), `alert-${Date.now()}.json`);
    writeFileSync(alertFile, JSON.stringify(alert, null, 2));
    const inv: Investigation = { id: `${Date.now()}`, alertName, alertFingerprint: alert.fingerprint, alertStartsAt: alert.startsAt, alertFile, status: "starting", startedAt: new Date().toISOString(), transcript: [] };
    logCtx = inv.id; // restored by guarded()
    liveStreams.add(inv.id); // in-memory: never pruned while this process runs it
    investigations.unshift(inv);
    saveInv();
    pane = 1;
    sel[1] = 0;
    scroll = 0;
    invView = "auto";
    try {
      await investigate({
        alertFile,
        mockKubectl: o.mockKubectl,
        keepRecorder: true,
        waitForDraft: false, // the API is polled from here on
        onRecorder: (child) => {
          if (inv.beam) recorders.set(inv.beam, child);
          pushLog(DIM(`recording ${inv.beam}`));
        },
        onOutput: (s) => appendTo(inv.transcript!, DIM(s)),
        onBeam: (b) => {
          inv.beam = b.beam;
          inv.bot = b.bot;
          inv.attach = b.attach;
          saveInv();
          pushLog(GREEN(`${b.beam} up`));
          tui.requestRender();
        },
        onPublished: (p) => {
          inv.app = p.app;
          inv.status = "running";
          saveInv();
          pushLog(GREEN(`investigator api: ${p.app}`));
        },
      });
    } catch (e) {
      inv.status = "failed";
      appendTo(inv.transcript ?? (inv.transcript = []), RED(`investigation failed: ${(e as Error).message}`));
      saveInv();
      throw e;
    } finally {
      liveStreams.delete(inv.id);
    }
    if (!investigations.includes(inv)) investigations.unshift(inv);
    inv.status = "running";
    saveInv();
    void syncInvestigation(inv, true);
  }

  /** e: open the drafted CR in $EDITOR (TUI suspended meanwhile), then reload and validate it. */
  function editDraft(inv: Investigation) {
    if (!inv.crPath) return pushLog(YELLOW("no drafted change request to edit"));
    if (inv.requestId) return pushLog(YELLOW(`already filed as Access Request ${inv.requestId.slice(0, 8)}, which is immutable; revise the draft and file again`));
    const [ed, ...edArgs] = editorArgv();
    const original = readFileSync(inv.crPath, "utf8");
    const tmp = `${inv.crPath}.edit`;
    const stripHeader = (s: string) => (s.startsWith("# ERROR:") ? s.replace(/^(#.*\n)+/, "") : s);
    let shown = original;
    let error: string | undefined;
    for (;;) {
      const header = error ? `# ERROR: ${error.replace(/\n/g, "\n# ")}\n# Fix it and save, or save without changes to cancel.\n#\n` : "";
      writeFileSync(tmp, header + shown);
      tui.stop();
      const r = spawnSync(ed, [...edArgs, tmp], { stdio: "inherit" });
      tui.start();
      if (r.error) {
        rmSync(tmp, { force: true });
        return pushLog(RED(`editor ${ed}: ${r.error.message} (set editor in ~/.oncallrc or $EDITOR)`), inv.id);
      }
      const edited = stripHeader(readFileSync(tmp, "utf8"));
      if (edited === shown) {
        rmSync(tmp, { force: true });
        pushLog(YELLOW(error ? "edit cancelled; draft unchanged" : "draft unchanged"), inv.id);
        return;
      }
      try {
        parseCR(edited); // schema only; change semantics are checked at submit
      } catch (e) {
        error = (e as Error).message;
        shown = edited;
        continue; // back into the editor with the error on top
      }
      rmSync(tmp, { force: true });
      writeFileSync(inv.crPath, edited);
      inv.crYaml = edited;
      inv.status = "drafted";
      saveInv();
      invView = "cr";
      pushLog(GREEN("draft saved"), inv.id);
      if (hasInvestigator(inv) && inv.app) {
        void api(inv)
          .fetch("/draft", { method: "PUT", body: { yaml: edited } })
          .then(
            () => pushLog(DIM(`→ ${inv.beam}: draft`), inv.id),
            (e: Error) => pushLog(YELLOW(`could not push the edit to the investigator: ${e.message}`), inv.id),
          );
      }
      tui.requestRender();
      return;
    }
  }

  async function doSubmit(inv: Investigation) {
    if (!inv.crPath) throw new Error("no drafted change request on this investigation");
    if (inv.requestId) throw new Error(`already filed as Access Request ${inv.requestId}`);
    if (hasInvestigator(inv) && inv.app && !o.mockKubectl) {
      inv.pending = { kind: "submit", at: Date.now(), via: "investigator" };
      saveInv();
      pushLog(CYAN(`→ ${inv.beam}: submit`));
      await sendToInvestigator(inv, "Submit the change request for approval now.");
      invView = "transcript";
      inv.draftAt = 0;
      void syncInvestigation(inv, true);
      return;
    }
    if (hasInvestigator(inv) && inv.app) await syncInvestigation(inv, true); // the investigator's file is the source of truth
    inv.pending = { kind: "submit", at: Date.now(), via: "laptop" };
    saveInv();
    pushLog(CYAN("submit: register executor, then file"));
    let st: Awaited<ReturnType<typeof submit>>;
    try {
      st = await submit(inv.crPath, target, pushLog, inv.beam);
    } catch (e) {
      inv.pending = undefined;
      saveInv();
      throw e;
    }
    inv.requestId = st.requestId;
    reconcile(inv);
    saveInv();
    if (hasInvestigator(inv) && inv.app && st.appUrl) {
      await sendToInvestigator(inv, `Your change request is filed as Access Request ${st.requestId}. Its executor is registered at ${st.appUrl}/mcp (exec/verify/rollback error until the request is approved). Do nothing with it until I ask.`).catch((e: Error) =>
        pushLog(YELLOW(`could not inform the investigator: ${e.message}`)),
      );
    }
    await refreshCRs(false);
    void fetchLive(crRowFor(inv.requestId), true);
    pushLog(GREEN(`filed ${inv.requestId}`));
  }

  /** x: everything the investigation owns, in order: executor (beam, bot, token), then investigator (beam, bot), then the row. */
  async function doTeardown(inv: Investigation) {
    const c = crRowFor(inv.requestId);
    const problems: string[] = [];
    const note = (s: string) => pushLog(YELLOW(s));

    pushLog(BOLD(`teardown ${inv.alertName}`));
    if (executorOpen(c)) {
      const phase = c!.live?.phase ?? c!.executor!.phase;
      if (phase === "IN_PROGRESS" && c!.live?.steps.some((s) => s.ran)) note("executor: change partially performed, not rolled back");
      if (!c!.executor!.beam) note(`executor: beam already gone, removing bot ${c!.executor!.bot ?? "?"} and token`);
      try {
        await teardown(c!.req.id, pushLog);
        c!.executor = { phase: "TORN_DOWN" };
        c!.live = undefined;
      } catch (e) {
        problems.push(`executor: ${(e as Error).message}`);
      }
    } else if (c?.executor?.phase === "TORN_DOWN") pushLog(DIM("executor: already torn down"));
    else if (inv.requestId) note(`executor: none found for request ${inv.requestId.slice(0, 8)}`);
    else pushLog(DIM("executor: none"));

    if (inv.app) dropAppProxy(inv.app);
    if (inv.beam) {
      recorders.get(inv.beam)?.kill("SIGTERM");
      recorders.delete(inv.beam);
      try {
        await removeBeam(inv.beam);
      } catch (e) {
        problems.push(`investigator beam ${inv.beam}: ${(e as Error).message}`);
      }
    } else if (inv.bot) note("investigator: beam already gone");
    else pushLog(DIM("investigator: no beam"));
    if (inv.bot) {
      try {
        await removeBot(inv.bot, inv.bot);
      } catch (e) {
        problems.push(`investigator bot ${inv.bot}: ${(e as Error).message}`);
      }
    }

    const a = inv.alertFingerprint ? alertFor(inv) : undefined;
    if (a) note(`${inv.alertName} is still firing`);
    inv.status = "removed";
    inv.beam = undefined;
    inv.attach = undefined;
    inv.pending = undefined;
    investigations = investigations.filter((v) => v !== inv); // the draft file stays in ~/.oncall
    sel[1] = Math.min(sel[1], Math.max(0, investigations.length - 1));
    saveInv();
    if (problems.length) throw new Error(`teardown finished with problems: ${problems.join("; ")}`);
    pushLog(GREEN(`${inv.alertName}: torn down${c?.req.id ? ` (request ${c.req.id.slice(0, 8)} stays as the record)` : ""}`));
  }

  /** n / v / b / r: one operation, handed to the investigator (which calls the executor's MCP tools), or to the executor directly when the investigator is gone. */
  async function doStep(inv: Investigation, c: CRRow, op: Operation | "run") {
    const live = c.live;
    const appUrl = loadState(c.req.id)?.appUrl ?? (c.executor?.appName ? `https://${c.executor.appName}.${PROXY.replace(/:\d+$/, "")}` : undefined);
    if (!appUrl) throw new Error("no executor app known for this request");
    const via: Via = hasInvestigator(inv) ? "investigator" : "laptop";
    inv.pending = { kind: "op", op, at: Date.now(), logLen: live?.log?.length ?? 0, phase: live?.phase ?? "", via };
    saveInv();
    if (via === "laptop") {
      if (op === "run") throw new Error("run all needs the investigator");
      pushLog(YELLOW(`${c.req.id.slice(0, 8)}: investigator gone; calling the executor from here`));
      try {
        const r = await callOperation(c.req.id, op, (s) => pushLog(s.replace(/^ {4}/, "")));
        c.live = r.status;
        c.liveAt = Date.now();
        c.executor = { ...(c.executor ?? {}), phase: r.status.phase };
      } finally {
        inv.pending = undefined;
        saveInv();
      }
      return;
    }
    await sendToInvestigator(inv, instruction(op, c.req.id, `${appUrl}/mcp`, live));
    invView = "transcript";
    inv.draftAt = 0;
    void syncInvestigation(inv, true);
    pushLog(CYAN(`→ ${inv.beam}: ${op}${op === "execute" && live?.next_execute ? ` ${live.next_execute}` : ""}`));
  }

  function instruction(op: Operation | "run", id: string, mcpUrl: string, live?: ExecutorStatus): string {
    const base = `Access Request ${id} is APPROVED. Executor: ${mcpUrl} (connect_executor first if the executor_* tools are not attached).`;
    switch (op) {
      case "execute":
        return `${base} Run exactly one step now: call executor_exec once${live?.next_execute ? ` with expect "${live.next_execute}"` : ""}. Report the result in one line, then stop and wait. If the executor returns an error, report it and do nothing else.`;
      case "verify":
        return `${base} Call executor_verify once and report the result in one line. Do nothing else.`;
      case "rollback":
        return `${base} Roll back exactly one step now: call executor_rollback once${live?.next_rollback ? ` with expect "${live.next_rollback}"` : ""}. Report the result in one line, then stop and wait.`;
      case "run":
        return `${base} Run to completion: executor_status, then executor_exec one step at a time reading each result; on a failure stop, explain, and executor_rollback until ROLLED_BACK; report after every step and summarize when COMPLETE.`;
    }
  }

  /** Local intent vs remote state: clear the intent once remote reflects it, or after its timeout. */
  function reconcile(inv: Investigation): void {
    const p = inv.pending;
    if (!p) return;
    const age = Date.now() - p.at;
    const timeout = PENDING_TIMEOUT[p.kind === "op" && p.op === "run" ? "run" : p.kind];
    let settled = false;
    let label: string | undefined;
    if (p.kind === "submit") {
      settled = Boolean(inv.requestId);
      if (settled) label = GREEN(`${inv.alertName}: filed ${inv.requestId!.slice(0, 8)}`);
    } else {
      const c = crRowFor(inv.requestId);
      const live = c?.live;
      if (!c || !live) return;
      const logLen = live.log?.length ?? 0;
      settled = p.op === "run" ? !live.approved || (live.phase !== "IN_PROGRESS" && !live.inflight) : logLen > p.logLen && !live.inflight;
      if (settled) {
        const st = exStatus(c);
        label = st.color(`${c.req.id.slice(0, 8)} ${st.label}${st.detail ? ` · ${st.detail}` : ""}`);
      }
    }
    if (!settled && age < timeout) return;
    inv.pending = undefined;
    saveInv();
    pushLog(settled ? label! : YELLOW(`${inv.alertName}: ${p.kind === "op" ? p.op : p.kind} not reflected after ${timeout / 60_000} min`), inv.id);
  }
  function reconcileAll(): void {
    for (const inv of investigations) reconcile(inv);
  }

  let pollInflight = false;
  let pollTick = 0;
  async function pollExecutors() {
    if (pollInflight) return;
    pollInflight = true;
    pollTick++;
    try {
      reconcileAll(); // timeouts
      const wanted = new Map<string, boolean>(); // request id → force
      for (const inv of investigations) if (inv.pending?.kind === "op" && inv.requestId) wanted.set(inv.requestId, true);
      const cur = pane === 1 ? crRowFor(investigations[sel[1]]?.requestId) : undefined;
      if (cur && !wanted.has(cur.req.id)) wanted.set(cur.req.id, Boolean(cur.live?.inflight));
      // investigators: the selected one every tick; the others only while they have an open intent or are still investigating (every third tick)
      const sel1 = pane === 1 ? investigations[sel[1]] : undefined;
      const invs = investigations.filter((v) => v === sel1 || v.pending || (v.status === "running" && pollTick % 3 === 0));
      await Promise.all([...[...wanted].map(([id, force]) => fetchLive(crRowFor(id), force)), ...invs.map((v) => syncInvestigation(v, v === sel1))]);
    } finally {
      pollInflight = false;
    }
  }

  /** m: silence the alert in Alertmanager for the change window (POST /api/v2/silences through the kube proxy). */
  async function doSilence(a: Alert, comment: string) {
    const minutes = config.silence_minutes ?? 120;
    const id = await silenceAlert(a, minutes, comment || "oncall", await currentUserName());
    pushLog(YELLOW(`silenced ${a.labels?.alertname} ${minutes}m (${id.slice(0, 8)})`));
    silences = await fetchSilences().catch(() => silences);
    applyAlertFilter();
  }
  async function doUnsilence(sil: Silence) {
    await expireSilence(sil);
    pushLog(GREEN(`unsilenced (${sil.id.slice(0, 8)})`));
    silences = await fetchSilences().catch(() => silences);
    applyAlertFilter();
  }
  let userName: string | undefined;
  async function currentUserName(): Promise<string> {
    if (!userName) userName = await currentUser().catch(() => "oncall");
    return userName;
  }

  /** a / d: review the request as the human reviewer (own tsh profile); first time, log the reviewer in. */
  async function doReview(c: CRRow, decision: "approve" | "deny", reason: string) {
    if (!(await reviewerLoggedIn())) {
      pushLog(YELLOW(`login ${REVIEWER}`));
      tui.stop();
      const err = reviewerLoginInteractive();
      tui.start();
      if (err) {
        let hint = "";
        try {
          hint = ` · set the password first: ${await reviewerResetLink()}`;
        } catch {
          /* no tctl rights */
        }
        throw new Error(err + hint);
      }
    }
    let state: string;
    try {
      state = await reviewRequest(c.req.id, decision, reason);
    } catch (e) {
      // a cert issued before a role rename carries a role that no longer exists: re-login once and retry
      if (!/not found|access denied|certificate|expired/i.test((e as Error).message)) throw e;
      pushLog(YELLOW(`re-login ${REVIEWER}: ${(e as Error).message.split("\n")[0].slice(0, 80)}`));
      tui.stop();
      const err = reviewerLoginInteractive();
      tui.start();
      if (err) throw new Error(err);
      state = await reviewRequest(c.req.id, decision, reason);
    }
    pushLog((decision === "approve" ? GREEN : RED)(`${c.req.id.slice(0, 8)} ${state} (${REVIEWER})`));
    c.req.state = state as typeof c.req.state;
    c.liveAt = 0;
    await refreshCRs(false); // Teleport's view of the request, now
    const cur = crs.find((x) => x.req.id === c.req.id) ?? c;
    await fetchLive(cur, true); // the executor re-checks approval on status, so tools show up at once
    if (state === "APPROVED") pushLog(DIM("2: n runs the first step through the investigator"));
  }

}

// ---- startup screen -----------------------------------------------------------------

function renderSplash(width: number, height: number, status: string): string[] {
  const BLUE = (s: string) => `\x1b[38;5;75m${s}\x1b[0m`;
  // the mark is centered as a block (its rows differ in width), the text lines individually
  const markW = Math.max(...BEAMS_MARK.map((l) => visibleWidth(l)));
  const markLeft = Math.max(0, Math.floor((width - markW) / 2));
  const mark = BEAMS_MARK.map((l) => " ".repeat(markLeft) + BLUE(l));
  const center = (l: string) => " ".repeat(Math.max(0, Math.floor((width - visibleWidth(l)) / 2))) + l;
  const block = [...mark, center(DIM(BEAMS_TAGLINE)), "", center(BOLD("on-call ᵛⁱᵇᵉˢ")), "", center(DIM(status))];
  const top = Math.max(0, Math.floor((height - block.length) / 2));
  const out: string[] = [];
  for (let i = 0; i < top; i++) out.push("");
  for (const l of block) out.push(truncateToWidth(l, width));
  while (out.length < height) out.push("");
  return out;
}

// ---- badges / formatting ----------------------------------------------------------

function invBadge(inv: Investigation, c?: CRRow): string {
  if (inv.pending?.kind === "submit") return YELLOW(`submitting · registering executor via ${inv.pending.via}`);
  if (inv.requestId) {
    if (!c) return YELLOW(`${inv.requestId.slice(0, 8)} filed · loading…`);
    const st = exStatus(c);
    const pend = inv.pending?.kind === "op" ? YELLOW(` · ${inv.pending.op} via ${inv.pending.via}`) : "";
    const gone = inv.status === "removed" && executorOpen(c) ? DIM(" · investigator gone") : "";
    return st.color(`${inv.requestId.slice(0, 8)} ${st.label}${st.detail ? ` · ${st.detail}` : ""}`) + pend + gone;
  }
  switch (inv.status) {
    case "starting": return YELLOW("starting beam…");
    case "running": return YELLOW("running");
    case "drafted": return inv.proposalPending ? YELLOW("proposal pending · p yes/no") : CYAN(`draft${inv.draftRev && inv.draftRev > 1 ? ` rev ${inv.draftRev}` : ""}`);
    case "no-change": return GREEN(`no change · ${inv.conclusion ?? ""}`);
    case "no-cr": return RED("no CR");
    case "failed": return RED("failed");
    case "removed": return DIM("beam removed");
  }
}
/** The investigation's status for display: once filed, the request's state is what matters. */
function invStatus(inv: Investigation, c?: CRRow): string {
  if (inv.pending?.kind === "submit") return YELLOW("submitting");
  if (inv.requestId) return `filed · ${c ? stateColor(c.req.state) : DIM("loading")}`;
  return invStatusColor(inv.status);
}
function invStatusColor(s: Investigation["status"]): string {
  return s === "drafted" || s === "no-change" ? GREEN(s) : s === "running" || s === "starting" ? YELLOW(s) : s === "removed" ? DIM(s) : RED(s);
}

/** The executor's state (the Access Request's state is `c.req.state`; the two are shown separately). */
function exStatus(c: CRRow): { label: string; color: (s: string) => string; detail?: string } {
  const st = c.req.state;
  if (c.executor?.phase === "TORN_DOWN") return { label: "TORN DOWN", color: DIM, detail: "beam, bot, token removed" };
  if (st === "DENIED") return { label: "IDLE", color: DIM, detail: "request denied" };
  if (st === "PENDING" && !c.live?.approved) return { label: "WAITING FOR APPROVAL", color: YELLOW, detail: c.executor?.appName ? undefined : "no executor" };
  if (!c.executor?.appName) return { label: "GONE", color: RED, detail: "beam not found" };
  const ex = c.live;
  if (!ex) return { label: "…", color: DIM, detail: "fetching status" };
  if (!ex.approved) return { label: "WAITING FOR APPROVAL", color: YELLOW, detail: ex.approvalNote };
  if (ex.inflight) return { label: `RUNNING ${ex.inflight.step}.${ex.inflight.kind}`, color: YELLOW, detail: `since ${ex.inflight.since.slice(11, 19)}Z` };
  const p = ex.phase;
  const prog = ex.progress ?? { done: ex.steps.filter((s) => s.ran && s.runOk !== false).length, total: ex.steps.length };
  if (p === "IN_PROGRESS") return prog.done === 0 ? { label: "READY", color: GREEN, detail: `${prog.total} step${prog.total === 1 ? "" : "s"}` } : { label: `IN PROGRESS ${prog.done}/${prog.total}`, color: YELLOW, detail: ex.next_execute ? `next ${ex.next_execute}` : undefined };
  if (p === "COMPLETE") return { label: "COMPLETE", color: GREEN, detail: `${prog.total}/${prog.total}` };
  if (p === "FAILED") return { label: "FAILED", color: RED, detail: ex.next_rollback ? `rollback ${ex.next_rollback}` : undefined };
  if (p === "ROLLING_BACK") return { label: "ROLLING BACK", color: YELLOW, detail: ex.next_rollback ? `next ${ex.next_rollback}` : undefined };
  if (p === "ROLLED_BACK") return { label: "ROLLED BACK", color: YELLOW };
  if (p === "ROLLBACK_FAILED") return { label: "ROLLBACK FAILED", color: RED };
  if (p === "ABORTED") return { label: "ABORTED", color: RED, detail: "first step failed" };
  return { label: p, color: YELLOW };
}

function crBadge(c: CRRow): string {
  const expired = c.req.expires && new Date(c.req.expires).getTime() < Date.now();
  return `${stateColor(c.req.state)}${expired ? DIM(" · expired") : ""}${DIM(` · ${c.req.user}`)}`;
}

function executorOpen(c?: CRRow): boolean {
  return Boolean(c?.executor) && c!.executor!.phase !== "TORN_DOWN";
}

function lastOp(live?: ExecutorStatus): string | undefined {
  const l = live?.log?.[live.log.length - 1];
  return l ? `${l.at.slice(11, 19)}Z ${l.op} ${l.step}.${l.kind} ${l.code === 0 ? GREEN("ok") : RED(`exit ${l.code}`)}` : undefined;
}

function stepMark(s: { ran: boolean; runOk?: boolean; verified?: boolean; rolledBack?: boolean }): string {
  if (s.rolledBack) return YELLOW("↶");
  if (s.ran && s.runOk === false) return RED("✗");
  if (s.ran && s.verified) return GREEN("✓");
  if (s.ran) return GREEN("•");
  return DIM("·");
}

/** Light YAML highlighting: keys dim, values plain. */
function yamlLines(yaml: string): string[] {
  return yaml.replace(/\n$/, "").split("\n").map((l) => l.replace(/^(\s*-?\s*)([A-Za-z_][\w-]*):/, (_m, ind, key) => `${ind}${DIM(key + ":")}`));
}

/** The investigator's marker notes, in the operator's words. */
function noteText(s: string): string {
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^CR-WRITTEN rev=(\d+)/))) return `change request written (revision ${m[1]})`;
  if ((m = s.match(/^CR-FILED ([0-9a-f-]{36})/))) return `filed as Access Request ${m[1].slice(0, 8)}`;
  if ((m = s.match(/^NO-CHANGE (.*)$/))) return `no change needed: ${m[1]}`;
  return s;
}
function crLabel(inv: Investigation): string {
  return !inv.crYaml || inv.requestId ? "change request" : inv.draftRev && inv.draftRev > 1 ? `draft rev ${inv.draftRev}` : "draft";
}
function stateColor(st: string): string {
  return st === "APPROVED" ? GREEN(st) : st === "DENIED" ? RED(st) : YELLOW(st);
}
function sevColor(s?: string): string {
  return s === "critical" ? RED(s) : s === "warning" ? YELLOW(s) : DIM(s ?? "");
}

/** Word-wrap to a visible width, keeping each line's leading indentation on its continuation lines. */
function wrapWords(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.replace(/\r/g, "").split("\n")) {
    if (visibleWidth(para) <= width) {
      out.push(para);
      continue;
    }
    const indent = para.match(/^\s*/)![0].slice(0, Math.max(0, width - 10));
    let line = indent;
    for (const word of para.trim().split(/\s+/).filter(Boolean)) {
      if (line.trim() && visibleWidth(line) + 1 + visibleWidth(word) > width) {
        out.push(line);
        line = indent;
      }
      let wd = word;
      while (visibleWidth(indent) + visibleWidth(wd) > width) {
        if (line.trim()) {
          out.push(line);
          line = indent;
        }
        const room = width - visibleWidth(indent);
        out.push(indent + wd.slice(0, room));
        wd = wd.slice(room);
      }
      line = line.trim() ? `${line} ${wd}` : indent + wd;
    }
    out.push(line);
  }
  return out.length ? out : [""];
}

function pad(s: string, w: number): string {
  const v = visibleWidth(s);
  return v >= w ? truncateToWidth(s, w) : s + " ".repeat(w - v);
}
function fit(lines: string[], n: number): string[] {
  const out = lines.slice(0, n);
  while (out.length < n) out.push("");
  return out;
}
function hhmmss(d: Date): string {
  return d.toTimeString().slice(0, 8);
}

// ---- terminal integration ---------------------------------------------------------
//
// Ghostty on macOS has no CLI to open a tab in the running app (`ghostty +new-window` is
// Linux-only), so a new *tab* is driven by AppleScript keystrokes (needs Accessibility
// permission for Ghostty once), and a new *window* by `open -na Ghostty.app --args -e`.
// ONCALL_ATTACH = tab | window | print overrides the choice.

async function openTerminal(cmd: string): Promise<{ ok: boolean; where: string }> {
  const mode = process.env.ONCALL_ATTACH ?? (process.env.TERM_PROGRAM === "ghostty" ? "tab" : process.env.TERM_PROGRAM === "Apple_Terminal" ? "terminal" : "print");
  const osa = (...lines: string[]) => run("osascript", lines.flatMap((l) => ["-e", l]));
  if (mode === "tab") {
    const r = await osa(
      'tell application "Ghostty" to activate',
      "delay 0.3",
      'tell application "System Events" to keystroke "t" using command down',
      "delay 0.5",
      `tell application "System Events" to keystroke ${JSON.stringify(cmd)}`,
      'tell application "System Events" to key code 36',
    );
    if (r.ok) return { ok: true, where: "Ghostty tab" };
    if (/not allowed to send keystrokes|1002/.test(r.err)) {
      const w = await run("open", ["-na", "Ghostty.app", "--args", "-e", "bash", "-lc", cmd]);
      return { ok: w.ok, where: w.ok ? "Ghostty window (grant Ghostty Accessibility in System Settings for tabs)" : "Ghostty needs Accessibility permission for tabs" };
    }
    return { ok: false, where: `AppleScript failed: ${r.err.trim()}` };
  }
  if (mode === "window") {
    const w = await run("open", ["-na", "Ghostty.app", "--args", "-e", "bash", "-lc", cmd]);
    return { ok: w.ok, where: w.ok ? "Ghostty window" : `open failed: ${w.err.trim()}` };
  }
  if (mode === "terminal") {
    const r = await osa(`tell application "Terminal" to do script ${JSON.stringify(cmd)}`, 'tell application "Terminal" to activate');
    return { ok: r.ok, where: r.ok ? "Terminal window" : `Terminal failed: ${r.err.trim()}` };
  }
  return { ok: false, where: "no terminal integration for this terminal" };
}

function run(cmd: string, args: string[]): Promise<{ ok: boolean; err: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15_000 }, (e, _out, err) => resolve({ ok: !e, err: String(err || e?.message || "") }));
  });
}

// ---- never leave the terminal broken ------------------------------------------------
//
// pi-tui enables the Kitty keyboard protocol, bracketed paste and the alternate screen; if the
// process dies without tui.stop() the shell is left reading CSI-u sequences ("a7;1:3u").
// Any exit path restores the terminal, and crashes are written to ~/.oncall/oncall.log.

const RESTORE = "\x1b[<u\x1b[?2004l\x1b[?1049l\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l";

function installCrashGuard(tui: { stop: () => void }) {
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    try {
      tui.stop();
    } catch {
      /* already stopped */
    }
    process.stdout.write(RESTORE);
  };
  const crash = (kind: string) => (e: unknown) => {
    restore();
    const msg = e instanceof Error ? e.stack ?? e.message : String(e);
    try {
      appendFileSync(join(stateDir(), "oncall.log"), `${new Date().toISOString()} ${kind}: ${msg}\n`);
    } catch {
      /* ignore */
    }
    process.stderr.write(`\noncall: ${kind}: ${msg}\n(details in ~/.oncall/oncall.log)\n`);
    process.exit(1);
  };
  process.on("uncaughtException", crash("uncaught exception"));
  process.on("unhandledRejection", crash("unhandled rejection"));
  process.on("SIGINT", () => { restore(); process.exit(130); });
  process.on("SIGTERM", () => { restore(); process.exit(143); });
  process.on("SIGHUP", () => { restore(); process.exit(129); });
  process.on("exit", restore);
}
