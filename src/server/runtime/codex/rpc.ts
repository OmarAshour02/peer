import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

export interface RpcRequest {
  id: number | string;
  method: string;
  params: Record<string, unknown>;
}

export interface RpcNotification {
  method: string;
  params: Record<string, unknown>;
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

/**
 * JSON-RPC 2.0 over stdio (one JSON object per line) with `codex app-server`. Codex sends
 * notifications and also requests of its own (approvals, dynamic tool calls) that we answer.
 */
export class CodexRpc {
  private readonly child: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private closed = false;

  constructor(
    binary: string,
    env: NodeJS.ProcessEnv,
    private readonly handlers: {
      onNotification: (n: RpcNotification) => void;
      onRequest: (r: RpcRequest) => void;
      onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
      log: (line: string) => void;
    },
  ) {
    this.child = spawn(binary, ["app-server"], { env, stdio: ["pipe", "pipe", "pipe"] });
    createInterface({ input: this.child.stdout! }).on("line", (line) => this.onLine(line));
    createInterface({ input: this.child.stderr! }).on("line", (line) => line.trim() && handlers.log(line));
    this.child.on("error", (err) => handlers.log(`app-server error: ${err.message}`));
    this.child.on("exit", (code, signal) => {
      this.closed = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new RpcError("Codex app-server exited"));
      }
      this.pending.clear();
      handlers.onExit(code, signal);
    });
  }

  get alive(): boolean {
    return !this.closed;
  }

  call<T = Record<string, unknown>>(method: string, params: Record<string, unknown>, timeoutMs = 60_000): Promise<T> {
    if (this.closed) return Promise.reject(new RpcError("Codex app-server is not running"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(`Codex did not answer ${method} in time`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown> = {}) {
    this.write({ method, params });
  }

  respond(id: number | string, result: unknown) {
    this.write({ id, result });
  }

  respondError(id: number | string, message: string, code = -32000) {
    this.write({ id, error: { code, message } });
  }

  kill() {
    if (!this.closed) this.child.kill("SIGTERM");
  }

  private write(message: Record<string, unknown>) {
    if (this.closed) return;
    this.child.stdin!.write(`${JSON.stringify(message)}\n`);
  }

  private onLine(line: string) {
    let msg: { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string; code?: number } };
    try {
      msg = JSON.parse(line);
    } catch {
      this.handlers.log(`unparseable app-server output: ${line.slice(0, 200)}`);
      return;
    }
    if (msg.method && msg.id !== undefined) {
      this.handlers.onRequest({ id: msg.id, method: msg.method, params: msg.params ?? {} });
    } else if (msg.method) {
      this.handlers.onNotification({ method: msg.method, params: msg.params ?? {} });
    } else if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new RpcError(msg.error.message ?? "Codex error", msg.error.code));
      else p.resolve(msg.result);
    }
  }
}
