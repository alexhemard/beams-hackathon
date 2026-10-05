// Command execution for CR steps. No shell. argv[0] must be allowlisted, and
// each executable gets the flags that bind it to the bot identity:
//   kubectl -> --kubeconfig <tbot kubeconfig>
//   tctl    -> --identity <bot identity> --auth-server <proxy>

import { spawn } from "node:child_process";
import { toArgv } from "../shared/cr";
import { scrubbedEnv } from "./approval";

export interface ExecConfig {
  allowedExecutables: readonly string[];
  kubeconfig?: string;
  identity?: string;
  proxy?: string;
  timeoutMs?: number;
  /** extra dirs to prepend to PATH (where bootstrap put kubectl/tctl) */
  pathPrepend?: string[];
}

export interface ExecResult {
  argv: string[];
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export async function execCommand(cmd: string, cfg: ExecConfig, stdin?: string): Promise<ExecResult> {
  const argv = toArgv(cmd);
  if (!cfg.allowedExecutables.includes(argv[0])) {
    throw new Error(`executable ${argv[0]} is not allowed`);
  }
  const bound = bind(argv, cfg);
  const env = scrubbedEnv();
  if (cfg.pathPrepend?.length) env.PATH = [...cfg.pathPrepend, env.PATH ?? ""].join(":");
  if (cfg.kubeconfig) env.KUBECONFIG = cfg.kubeconfig;

  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(bound[0], bound.slice(1), { env, stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    if (stdin !== undefined) child.stdin!.end(stdin);
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (d) => (stdout += d));
    child.stderr!.on("data", (d) => (stderr += d));
    const t = setTimeout(() => child.kill("SIGKILL"), cfg.timeoutMs ?? 180_000);
    child.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({ argv: bound, code: code ?? -1, stdout: tail(stdout), stderr: tail(stderr), durationMs: Date.now() - started });
    });
  });
}

function bind(argv: string[], cfg: ExecConfig): string[] {
  switch (argv[0]) {
    case "kubectl":
      return cfg.kubeconfig ? [argv[0], `--kubeconfig=${cfg.kubeconfig}`, ...argv.slice(1)] : argv;
    case "tctl": {
      const extra: string[] = [];
      if (cfg.identity) extra.push(`--identity=${cfg.identity}`);
      if (cfg.proxy) extra.push(`--auth-server=${cfg.proxy}`);
      return [argv[0], ...extra, ...argv.slice(1)];
    }
    default:
      return argv;
  }
}

function tail(s: string, max = 16_000): string {
  return s.length > max ? `…(${s.length - max} bytes trimmed)\n` + s.slice(-max) : s;
}
