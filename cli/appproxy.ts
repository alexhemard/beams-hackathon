// A persistent `tsh proxy app <app>` per published beam app, with HTTP over it. Teleport injects the
// caller's JWT on every request, so the app sees who is calling. Pooled by app name, LRU-evicted.

import { spawn, type ChildProcess } from "node:child_process";
import { PROXY, ambientEnv } from "./beamops";
import { freePort, portOpen } from "./ops";
import { retryWithBackoff } from "./retry";

/** Extra wall-clock budget on top of one attempt's own timeout, so `fetch()` gets a second attempt
 *  instead of its only attempt eating the entire timeout. */
const RETRY_BUDGET_MS = 20_000;

export class AppProxy {
  private child?: ChildProcess;
  private port = 0;
  private readonly ready: Promise<void>;
  private closed = false;
  used = Date.now();

  constructor(readonly app: string) {
    this.ready = this.start();
  }

  private async start(): Promise<void> {
    this.port = await freePort();
    // A freshly published app can take a moment to propagate; `tsh proxy app` fails fast with
    // "not found" until it does, so retry that specific failure within the overall deadline.
    const deadline = Date.now() + 20_000;
    try {
      await retryWithBackoff(() => this.attempt(deadline), deadline, (err) => !this.closed && /not found/i.test(err));
    } catch (e) {
      this.closed = true;
      throw e;
    }
  }

  /** One spawn-and-wait attempt. Resolves with undefined once the local port is up, or an error message. */
  private attempt(deadline: number): Promise<string | undefined> {
    return new Promise((resolve) => {
      const child = spawn("tsh", ["--proxy", PROXY, "proxy", "app", this.app, "--port", String(this.port)], { stdio: ["ignore", "pipe", "pipe"], env: ambientEnv() });
      this.child = child;
      let err = "";
      let exited = false;
      child.stderr!.on("data", (d) => (err += d.toString()));
      child.on("exit", () => (exited = true));
      const poll = async () => {
        for (;;) {
          if (this.closed) return resolve("closed");
          if (exited) return resolve(`tsh proxy app ${this.app} exited: ${err.trim().split("\n").pop() ?? ""}`);
          if (await portOpen(this.port)) return resolve(undefined);
          if (Date.now() > deadline) {
            child.kill("SIGTERM");
            return resolve(`tsh proxy app ${this.app} did not come up`);
          }
          await new Promise((r) => setTimeout(r, 250));
        }
      };
      poll();
    });
  }

  get alive(): boolean {
    return !this.closed;
  }

  async fetch<T = any>(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
    await this.ready;
    this.used = Date.now();
    const perAttempt = init.timeoutMs ?? 15_000;
    // A freshly published app's first authenticated request can be slow (tunnel still propagating,
    // the server's first JWT verify fetches the proxy's JWKS over the network) - give it a couple of
    // attempts' worth of extra budget rather than making one attempt eat the whole timeout.
    const deadline = Date.now() + perAttempt + RETRY_BUDGET_MS;
    let result: T | undefined;
    await retryWithBackoff(
      async () => {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), perAttempt);
        try {
          const res = await fetch(`http://127.0.0.1:${this.port}${path}`, {
            method: init.method ?? "GET",
            headers: init.body !== undefined ? { "content-type": "application/json" } : {},
            body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
            signal: ctl.signal,
          });
          const text = await res.text();
          let data: any = undefined;
          try {
            data = text ? JSON.parse(text) : {};
          } catch {
            data = { raw: text };
          }
          // 502/503/504 is the proxy saying it couldn't reach the app's backend yet (freshly
          // published/granted, routing still propagating) -- transient, unlike a real 4xx/other 5xx
          // from the app itself, which means exactly what it says and isn't retried.
          if (!res.ok) return `${this.app}${path}: ${res.status} ${data?.error ?? text.slice(0, 200)}`;
          result = data as T;
          return undefined;
        } catch (e) {
          const msg = (e as Error).name === "AbortError" ? `timed out after ${perAttempt}ms` : (e as Error).message;
          return `${this.app}${path}: ${msg}`;
        } finally {
          clearTimeout(t);
        }
      },
      deadline,
      (err) => /timed out after|ECONNRESET|ECONNREFUSED|fetch failed|socket hang up|: 50[234]\b/i.test(err),
    );
    return result as T;
  }

  close(): void {
    this.closed = true;
    this.child?.kill("SIGTERM");
  }
}

const pool = new Map<string, AppProxy>();
const MAX = 6;

export function appProxy(app: string): AppProxy {
  const have = pool.get(app);
  if (have?.alive) return have;
  if (have) pool.delete(app);
  while (pool.size >= MAX) {
    const lru = [...pool.entries()].sort((a, b) => a[1].used - b[1].used)[0];
    lru[1].close();
    pool.delete(lru[0]);
  }
  const p = new AppProxy(app);
  pool.set(app, p);
  return p;
}

export function closeAppProxies(): void {
  for (const p of pool.values()) p.close();
  pool.clear();
}

export function dropAppProxy(app: string): void {
  pool.get(app)?.close();
  pool.delete(app);
}
