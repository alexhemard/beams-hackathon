// `cr investigate <alert.json>`: spin an investigation beam with a read-only bot,
// run the investigator agent inside it under tmux, stream its log, capture the CR.
// The beam is kept so the operator can attach:  tsh beams ssh <beam>  (the shell attaches to tmux itself)

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { PROXY, REPO, addBotLabels, beamExec, beamExecArgv, beamExecOk, beamInit, beamScp, beamScpFrom, bundle, createBeam, createBoundKeypairToken, currentUser, ensureBot, publishedAppName, removeBeam, removeBot, stateDir, step, type BotLabels } from "./beamops";
import { echo, runOk } from "../shared/teleport";

const INVESTIGATOR_ROLE = process.env.CR_INVESTIGATOR_ROLE ?? "cr-investigator";
const KUBE_CLUSTER = process.env.CR_KUBE_CLUSTER ?? "oncall";

export interface InvestigateOptions {
  alertFile: string;
  /** remove the beam and bot when done (default: keep, so the user can attach) */
  cleanup?: boolean;
  onOutput?: (chunk: string) => void;
  /** called as soon as the beam exists (TUI shows the attach hint) */
  onBeam?: (info: { beam: string; bot?: string; attach: string }) => void;
  /** called once the investigator's API is published as a Teleport app */
  onPublished?: (info: { app: string; appUrl: string }) => void;
  /** block until the first draft / conclusion (CLI); false returns right after publish (TUI polls the API) */
  waitForDraft?: boolean;
  /** dev: use a mock kubectl inside the beam instead of enrolling a bot */
  mockKubectl?: boolean;
  /** keep an interactive tsh beams ssh attached so Teleport records the investigation (default true) */
  record?: boolean;
  /** leave the recording client running after this call returns (the TUI owns it; default: stop it) */
  keepRecorder?: boolean;
  /** receives the recording client so the caller can stop it later */
  onRecorder?: (child: ChildProcess) => void;
}

export interface InvestigateResult {
  crPath?: string;
  crYaml?: string;
  beam: string;
  bot?: string;
  attach: string;
  /** the investigator's API, published as a Teleport app */
  app?: string;
  appUrl?: string;
  transcript: string;
  ok: boolean;
  /** set when the investigator concluded that no change is needed (its one-line summary) */
  noChange?: string;
}

export async function investigate(o: InvestigateOptions): Promise<InvestigateResult> {
  const alert = JSON.parse(readFileSync(o.alertFile, "utf8"));
  const alertName = alert?.labels?.alertname ?? "alert";
  const runId = randomBytes(3).toString("hex");
  const bot = o.mockKubectl ? undefined : `cr-inv-${runId}`;
  const emit = o.onOutput ?? ((s: string) => process.stdout.write(s));

  step(`bundle investigator and executor`);
  await bundle("bundle:investigate");
  await bundle("bundle:cr-exec"); // the investigator ships the executor itself (submit-cr.sh)

  step(`create investigation beam`);
  const beam = await createBeam();
  const attach = `tsh --proxy ${PROXY} beams ssh ${beam.id}`;
  o.onBeam?.({ beam: beam.id, bot, attach });
  emit(`beam ${beam.id} created · attach: ${attach}\n`);

  let secret = "";
  if (bot) {
    step(`create read-only bot ${bot} (${INVESTIGATOR_ROLE}) labeled for beam ${beam.id} and alert ${alertName}`);
    const labels: BotLabels = { role: "investigator", owner: await currentUser(), beamAlias: beam.id, beamId: beam.uuid, ref: alertName };
    await ensureBot(bot, INVESTIGATOR_ROLE, labels);
    secret = await createBoundKeypairToken(bot, bot, labels);
  }

  // Everything the beam needs, as one archive extracted under /home/beams: a reproducible init state.
  step(`init ${beam.id}: one archive (investigator, prompt, runbooks, alert, scripts${o.mockKubectl ? ", mock kubectl" : ""})`);
  const terminfo = localTerminfo();
  const entries: Array<{ local: string; remote: string }> = [
    { local: join(REPO, "dist/investigate.mjs"), remote: "investigate/investigate.mjs" },
    { local: join(REPO, "investigator/bootstrap-investigate.sh"), remote: "investigate/bootstrap.sh" },
    { local: join(REPO, "investigator/run-investigate.sh"), remote: "investigate/run.sh" },
    { local: join(REPO, "investigator/prepare-beam.sh"), remote: "investigate/prepare-beam.sh" },
    { local: join(REPO, "investigator/prompt.md"), remote: "investigate/prompt.md" },
    { local: join(REPO, "runbooks"), remote: "investigate/runbooks" },
    { local: o.alertFile, remote: "investigate/alert.json" },
  ];
  // the investigator registers the executor from its beam: executor bundle, templates, submit script, and who it is
  const selfFile = join(stateDir(), `self-${runId}.json`);
  writeFileSync(selfFile, JSON.stringify({ alias: beam.id, uuid: beam.uuid, owner: await currentUser(), kubeCluster: KUBE_CLUSTER, proxy: PROXY }, null, 2));
  entries.push(
    { local: join(REPO, "dist/cr-exec.mjs"), remote: "investigate/exec/cr-exec.mjs" },
    { local: join(REPO, "cr-exec/bootstrap.sh"), remote: "investigate/exec/bootstrap.sh" },
    { local: join(REPO, "teleport/bot.yaml.tmpl"), remote: "investigate/teleport/bot.yaml.tmpl" },
    { local: join(REPO, "teleport/token.yaml.tmpl"), remote: "investigate/teleport/token.yaml.tmpl" },
    { local: join(REPO, "investigator/submit-cr.sh"), remote: "investigate/submit-cr.sh" },
    { local: selfFile, remote: "investigate/self.json" },
  );
  if (terminfo) entries.push({ local: terminfo, remote: "investigate/terminfo.src" });
  if (o.mockKubectl) entries.push({ local: join(REPO, "investigator/mock-kubectl.sh"), remote: "bin/kubectl" });
  await beamInit(beam.id, entries, `${alertName}-${runId}`);

  // Before the slow bootstrap: `tsh beams ssh` lands in the investigator's tmux (the hook waits for it),
  // and the operator's terminfo is installed so tmux accepts their TERM.
  await beamExecOk(beam.id, ["bash", "/home/beams/investigate/prepare-beam.sh", ...(terminfo ? ["/home/beams/investigate/terminfo.src"] : [])]);

  let runArgs: string[];
  if (o.mockKubectl) {
    await beamExecOk(beam.id, ["chmod", "+x", "/home/beams/bin/kubectl"]);
    runArgs = ["/home/beams/bin/kubectl"];
  } else {
    step(`bootstrap inside ${beam.id}: enroll read-only bot, tbot kubeconfig, kubectl`);
    const boot = await beamExec(beam.id, ["bash", "/home/beams/investigate/bootstrap.sh", PROXY, bot!, secret, KUBE_CLUSTER], { redact: [secret] });
    emit(boot.stdout);
    if (boot.code !== 0) throw new Error(`investigation bootstrap failed:\n${boot.stderr}`);
    runArgs = ["/home/beams/bin/kubectl", "/home/beams/kube/kubeconfig.yaml"];
  }

  step(`start investigator under tmux in ${beam.id} (alert ${alertName})`);
  await beamExecOk(beam.id, ["bash", "/home/beams/investigate/run.sh", ...runArgs]);
  const recorder = o.record === false ? undefined : startRecorder(beam.id);
  if (recorder) o.onRecorder?.(recorder);

  step(`publish the investigator's API as a Teleport app`);
  const pub = await runOk(["tsh", "--proxy", PROXY, "beams", "publish", beam.id]);
  const appUrl = pub.match(/https:\/\/\S+/)?.[0];
  const app = appUrl ? new URL(appUrl).hostname.split(".")[0] : publishedAppName(beam);
  if (bot) await addBotLabels(bot, { "oncall/app": app }).catch((e: Error) => emit(`could not label bot with app: ${e.message}\n`));
  o.onPublished?.({ app, appUrl: appUrl ?? `https://${app}.${PROXY.replace(/:\d+$/, "")}` });
  if (o.waitForDraft === false) return { beam: beam.id, bot, attach, app, appUrl, transcript: "", ok: false };

  step(`stream investigator log until the first draft`);
  // The agent prints CR-WRITTEN when the change request file exists, then stays alive for follow-ups.
  const transcript = await tailUntil(beamExecArgv(beam.id, ["tail", "-n", "+1", "-f", "/home/beams/investigate/log"]), emit, /CR-WRITTEN rev=\d+|NO-CHANGE |EXIT:\d+/);

  // The change request is a file in the beam; pull it (tsh beams scp), never parse it out of the log.
  let crPath: string | undefined;
  let crYaml: string | undefined;
  if (/CR-WRITTEN/.test(transcript)) {
    crPath = join(stateDir(), `draft-${alertName}-${runId}.yaml`);
    step(`pull change request file from ${beam.id}`);
    await pullDraft(beam.id, crPath);
    crYaml = readFileSync(crPath, "utf8");
  }

  if (recorder && !o.keepRecorder) recorder.kill("SIGTERM");
  if (o.cleanup) {
    step(`remove investigation beam ${beam.id}` + (bot ? ` and bot ${bot}` : ""));
    await removeBeam(beam.id);
    if (bot) await removeBot(bot, bot);
  }
  const noChange = transcript.match(/^NO-CHANGE (.*)$/m)?.[1];
  if (noChange) emit(`investigator concluded: no change needed. ${noChange}\n`);
  return { crPath, crYaml, beam: beam.id, bot, attach, app, appUrl, transcript, ok: Boolean(crYaml), noChange };
}

export const CR_FILE = "/home/beams/investigate/cr.yaml";

/** Pull the change request file out of the beam (beam:cr.yaml → local). */
export async function pullDraft(beam: string, localPath: string): Promise<string> {
  await beamScpFrom(beam, CR_FILE, localPath);
  return readFileSync(localPath, "utf8");
}

/** Push an operator-edited change request back into the beam, where the agent reads it before its next turn. */
export async function pushDraft(beam: string, localPath: string): Promise<void> {
  await beamScp(localPath, beam, CR_FILE);
}

/**
 * Teleport records interactive SSH sessions, not detached tmux windows. So the laptop keeps one
 * interactive `tsh beams ssh <beam>` attached to the investigator's tmux for the whole investigation:
 * the beam's shell hook attaches it, and everything the agent prints becomes a session recording
 * (`tsh play <sid>`, Web UI player, and a Teleport session summary when an inference policy exists).
 * `script` provides the pty; `stty` gives it a generous size so the recording is not cropped.
 * Returns the child; kill it to end the recording.
 */
export function startRecorder(beam: string): ChildProcess {
  const cmd = `stty cols 200 rows 50 2>/dev/null; exec tsh --proxy ${PROXY} beams ssh ${beam}`;
  const child = spawn("script", ["-q", "/dev/null", "sh", "-c", cmd], { stdio: ["ignore", "ignore", "ignore"], env: { ...process.env, TERM: "xterm-256color" } });
  echo(`$ script -q /dev/null tsh --proxy ${PROXY} beams ssh ${beam}   # recording client`);
  return child;
}

export async function cleanupInvestigation(beam: string, bot?: string): Promise<void> {
  await removeBeam(beam);
  if (bot) await removeBot(bot, bot);
}

/** Run a streaming command, emitting output, until `stop` matches; then kill it. */
function tailUntil(argv: string[], emit: (s: string) => void, stop: RegExp): Promise<string> {
  echo(`$ ${argv.join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let all = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      child.kill("SIGTERM");
      resolve(all);
    };
    const onData = (d: Buffer) => {
      if (done) return; // tsh prints "context canceled" after we kill the tail
      const s = d.toString();
      all += s;
      emit(s.replace(/EXIT:\d+\n?|CR-WRITTEN rev=\d+ path=\S+\n?/g, ""));
      if (stop.test(all)) finish();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (e) => (done ? undefined : reject(e)));
    child.on("close", () => finish());
    setTimeout(finish, 20 * 60_000).unref();
  });
}

/** The local terminal's terminfo source (`infocmp -x $TERM`), written to ~/.cr, or undefined if unavailable. */
function localTerminfo(): string | undefined {
  const term = process.env.TERM;
  if (!term || /^(xterm|xterm-256color|screen|tmux|dumb)$/.test(term)) return undefined; // beam image already has these
  const r = spawnSync("infocmp", ["-x", term], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return undefined;
  const p = join(stateDir(), `terminfo-${term}.src`);
  writeFileSync(p, r.stdout);
  return p;
}
