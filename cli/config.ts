// ~/.oncallrc: user preferences for the oncall CLI/TUI (YAML). Imported first by cli/oncall.ts so
// the values are in the environment before the other modules read it.
//
//   editor: nvim                     # for e (edit draft CR); default $VISUAL, $EDITOR, vi
//   attach: tab                      # tab | window | terminal | print  (A: open beam tmux)
//   proxy: flat-pine.beams.sh:443    # Teleport proxy
//   kube_cluster: oncall             # Teleport name of the demo cluster (alerts, investigations)
//   refresh_every: 20                # seconds between TUI refreshes (0 disables)
//   target: kube                     # kube | tctl
//   reviewer: cr-reviewer            # a / d in the CR tab review as this user (own tsh profile)
//   reviewer_home: ~/.tsh-reviewer
//   hide_closed_after: 30            # minutes; closed/denied/expired CRs drop off the list (H toggles)
//   silence_minutes: 120             # m silences the selected alert for this long

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export interface OncallConfig {
  editor?: string;
  attach?: "tab" | "window" | "terminal" | "print";
  proxy?: string;
  kube_cluster?: string;
  refresh_every?: number;
  target?: "kube" | "tctl";
  /** the human reviewer user (a/d in the CR tab review as this user through its own tsh profile) */
  reviewer?: string;
  /** TELEPORT_HOME for the reviewer's tsh profile (default ~/.tsh-reviewer) */
  reviewer_home?: string;
  /** minutes after which closed / denied / expired change requests leave the list (H shows them); default 30, 0 = never hide */
  hide_closed_after?: number;
  /** minutes an alert is silenced for with m (default 120) */
  silence_minutes?: number;
}

export const CONFIG_PATH = process.env.ONCALLRC ?? join(homedir(), ".oncallrc");

export const config: OncallConfig = load();

function load(): OncallConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    const doc = parseYaml(readFileSync(CONFIG_PATH, "utf8")) ?? {};
    if (typeof doc !== "object") throw new Error("not a mapping");
    return doc as OncallConfig;
  } catch (e) {
    process.stderr.write(`warning: ${CONFIG_PATH}: ${(e as Error).message}; ignoring\n`);
    return {};
  }
}

// Config fills in what the environment does not set; explicit env still wins.
if (config.proxy && !process.env.CR_PROXY) process.env.CR_PROXY = config.proxy;
if (config.kube_cluster && !process.env.CR_KUBE_CLUSTER) process.env.CR_KUBE_CLUSTER = config.kube_cluster;
if (config.attach && !process.env.ONCALL_ATTACH) process.env.ONCALL_ATTACH = config.attach;

/** The editor for `e`: config, then $VISUAL, $EDITOR, vi. Returned as argv (the value may carry flags). */
export function editorArgv(): string[] {
  const v = config.editor ?? process.env.VISUAL ?? process.env.EDITOR ?? "vi";
  return v.trim().split(/\s+/);
}
