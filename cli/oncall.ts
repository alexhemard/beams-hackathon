#!/usr/bin/env -S npx tsx
// `oncall` — run from the laptop as the on-call operator.
//
//   oncall [--alerts-file f] [--mock-kubectl]      the TUI: alerts → investigate → change request → approval → execute
//   oncall investigate <alert.json> [--cleanup] [--mock-kubectl]
//   oncall submit <cr.yaml> [--target kube|tctl] [--parent <investigator-beam>]            register the executor (beam + bot + MCP app), THEN file the Access Request
//   oncall status <request-id>
//   oncall run <request-id> [--port N]                  execute until COMPLETE (rollback on failure)
//   oncall exec|verify|rollback <request-id>                one operation on the executor (one step at a time)
//   oncall exec-status <request-id>
//   oncall teardown <request-id>
//   oncall run dev --url http://127.0.0.1:8080/mcp           dev: local cr-exec started with --insecure-*
//
// Every tsh/tctl command is echoed to stderr. That is the demo narration.

import "./config"; // first: ~/.oncallrc lands in the environment before the other modules read it
import { parseArgs } from "node:util";
import { config } from "./config";
import { investigate } from "./investigate";
import { callOperation, executorStatus, loadState, requestStatus, runCR, submit, teardown, type Operation } from "./ops";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    target: { type: "string" },
    port: { type: "string" },
    url: { type: "string" },
    caller: { type: "string", default: "dev" },
    cleanup: { type: "boolean", default: false },
    "mock-kubectl": { type: "boolean", default: false },
    "alerts-file": { type: "string" },
    /** submit: the investigator beam that produced the CR (recorded as oncall/parent-beam on the executor bot) */
    parent: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
const [cmd, arg, arg2] = positionals;
const target = (values.target as "kube" | "tctl" | undefined) ?? config.target;
const runOpts = { port: values.port ? Number(values.port) : undefined, url: values.url, caller: values.caller };

try {
  switch (cmd) {
    case undefined:
    case "tui": {
      if (values.help) usage();
      else {
        const { startTui } = await import("./tui");
        await startTui({ alertsFile: values["alerts-file"], mockKubectl: values["mock-kubectl"], target, refreshEvery: config.refresh_every });
      }
      break;
    }
    case "investigate": {
      const r = await investigate({ alertFile: need(arg, "alert.json path"), cleanup: values.cleanup, mockKubectl: values["mock-kubectl"] });
      if (r.ok) console.log(`\nchange request drafted: ${r.crPath}\n${r.crYaml}next: oncall submit ${r.crPath}`);
      else console.log(`\nno change request. Attach to the beam: ${r.attach}`);
      if (!values.cleanup) console.log(`beam ${r.beam} kept. Attach: ${r.attach}`);
      break;
    }
    case "submit": {
      const st = await submit(need(arg, "cr.yaml path"), target ?? "kube", undefined, values.parent);
      console.log(`reviewer approves with:  TELEPORT_HOME=~/.tsh-reviewer tsh request review --approve ${st.requestId}`);
      console.log(`then:                    oncall exec ${st.requestId}   (one step at a time), or oncall run ${st.requestId}`);
      break;
    }
    case "status": {
      const id = need(arg, "request id");
      const req = await requestStatus(id);
      if (!req) throw new Error(`request ${id} not found`);
      console.log(`request ${req.id}\n  user:    ${req.user}\n  roles:   ${req.roles.join(",")}\n  state:   ${req.state}\n  expires: ${req.accessExpiry ?? req.expires}\n--- change request ---\n${req.reason}`);
      const st = loadState(id);
      if (st) console.log(`--- executor ---\n${JSON.stringify(st, null, 2)}`);
      break;
    }
    case "run":
      await runCR(need(arg, "request id"), undefined, runOpts);
      break;
    case "exec":
    case "execute":
    case "verify":
    case "rollback": {
      const op: Operation = cmd === "exec" ? "execute" : (cmd as Operation);
      const r = await callOperation(need(arg, "request id"), op, undefined, runOpts);
      console.log(`phase: ${r.status.phase}; available: ${r.status.available.join(", ") || "none"}`);
      break;
    }
    case "exec-status": {
      const s = await executorStatus(need(arg, "request id"), undefined, runOpts);
      console.log(JSON.stringify(s, null, 2));
      break;
    }
    case "teardown":
      await teardown(need(arg, "request id"));
      break;
    default:
      usage();
      process.exit(2);
  }
} catch (e) {
  const err = e as Error & { cause?: unknown };
  console.error(`error: ${err.message}${err.cause ? `\n  cause: ${(err.cause as any)?.message ?? String(err.cause)}` : ""}`);
  if (process.env.CR_DEBUG) console.error(err.stack);
  process.exit(1);
}

function usage() {
  console.log(`usage:
  oncall [--alerts-file f] [--mock-kubectl]         TUI
  oncall investigate <alert.json> [--cleanup] [--mock-kubectl]
  oncall submit <cr.yaml> [--target kube|tctl]       register the executor (beam+bot+MCP app), THEN file the Access Request
  oncall status <request-id>
  oncall run <request-id>                            execute until COMPLETE (rollback on failure)
  oncall exec|verify|rollback <request-id>           one operation on the executor (one step at a time)
  oncall exec-status <request-id>
  oncall teardown <request-id>
  oncall run dev --url http://127.0.0.1:8080/mcp`);
}

function need(v: string | undefined, what: string): string {
  if (!v) throw new Error(`missing ${what}`);
  return v;
}
