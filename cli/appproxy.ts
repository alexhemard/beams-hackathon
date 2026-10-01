// A persistent `tsh proxy app <app>` per published beam app, with HTTP over it. Teleport injects the
// caller's JWT on every request, so the app sees who is calling. Pooled by app name, LRU-evicted.

import { spawn, type ChildProcess } from "node:child_process";
import { PROXY } from "./beamops";
import { freePort, portOpen } from "./ops";

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
    const child = spawn("tsh", ["--proxy", PROXY, "proxy", "app", this.app, "--port", String(this.port)], { stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    let err = "";
    child.stderr!.on("data", (d) => (err += d.toString()));
    child.on("exit", () => (this.closed = true));
    const deadline = Date.now() + 20_000;
    for (;;) {
      if (this.closed) throw new Error(`tsh proxy app ${this.app} exited: ${err.trim().split("\n").pop() ?? ""}`);
      if (await portOpen(this.port)) return;
      if (Date.now() > deadline) throw new Error(`tsh proxy app ${this.app} did not come up`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  get alive(): boolean {
    return !this.closed;
  }

  async fetch<T = any>(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
    await this.ready;
    this.used = Date.now();
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), init.timeoutMs ?? 15_000);
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
      if (!res.ok) throw new Error(`${this.app}${path}: ${res.status} ${data?.error ?? text.slice(0, 200)}`);
      return data as T;
    } finally {
      clearTimeout(t);
    }
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
