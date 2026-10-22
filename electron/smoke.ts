// Packaged-app smoke test: `Peer --smoke-test` (CI runs this on every OS/arch target).
// It exercises real behavior, not just "the build succeeded": the bundled runtime binary starts
// on this platform, the Peer plugin loads inside it, the API, persistence and renderer work.
// Set PEER_SMOKE_LLM=1 to also run a real agent turn that edits a file (needs network).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import type { PeerServer } from "../src/server/server.js";
import type { ModelsResponse, PeerSession, SessionSnapshot, Workspace } from "../src/shared/types.js";

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runSmokeTest(peer: PeerServer, openWindow: () => BrowserWindow): Promise<boolean> {
  const checks: Check[] = [];
  const check = async (name: string, fn: () => Promise<string | void>) => {
    try {
      const detail = await fn();
      checks.push({ name, ok: true, detail: detail || undefined });
    } catch (err) {
      checks.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  };
  const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const res = await fetch(`${peer.url}/api${path}`, {
      ...init,
      headers: { authorization: `Bearer ${peer.token}`, "content-type": "application/json" },
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(body)}`);
    return body as T;
  };

  let workspace: Workspace | null = null;
  let session: PeerSession | null = null;
  let models: ModelsResponse | null = null;

  await check("runtime starts on this platform", async () => {
    for (let i = 0; i < 120; i++) {
      const status = peer.service.runtimes.get("opencode").status();
      if (status.state === "ready") return `opencode ${status.version} on ${process.platform}-${process.arch}`;
      if (status.state === "error") throw new Error(status.error);
      await sleep(500);
    }
    throw new Error("timed out");
  });

  // Claude Code and Codex are optional: each must settle as ready, or unavailable with a reason.
  await check("connected runtimes detected", async () => {
    for (let i = 0; i < 60; i++) {
      const runtimes = peer.service.runtimes.info();
      if (runtimes.every((r) => r.status.state === "ready" || (r.status.state === "unavailable" && r.status.error))) {
        return runtimes.map((r) => `${r.kind}: ${r.status.state === "ready" ? r.status.version : "not installed or not logged in"}`).join(", ");
      }
      await sleep(500);
    }
    throw new Error(JSON.stringify(peer.service.runtimes.info()));
  });

  await check("api rejects missing token", async () => {
    const res = await fetch(`${peer.url}/api/workspaces`);
    if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`);
  });

  await check("workspace registration", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "peer-smoke-")));
    writeFileSync(join(dir, "README.md"), "# smoke\n");
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
    } catch {
      // git is optional for the runtime
    }
    workspace = await api<Workspace>("/workspaces", { method: "POST", body: JSON.stringify({ path: dir }) });
    return workspace.path;
  });

  await check("models listed by runtime", async () => {
    models = await api<ModelsResponse>(`/workspaces/${workspace!.id}/models`);
    return `${models.providers.length} provider(s), default ${models.default?.providerId}/${models.default?.modelId}`;
  });

  await check("session create + mode persistence", async () => {
    session = await api<PeerSession>(`/workspaces/${workspace!.id}/sessions`, { method: "POST", body: JSON.stringify({ mode: "learn" }) });
    await api(`/sessions/${session.id}`, { method: "PATCH", body: JSON.stringify({ mode: "focus" }) });
    const snap = await api<SessionSnapshot>(`/sessions/${session.id}`);
    if (snap.session.mode !== "focus") throw new Error(`mode not persisted: ${snap.session.mode}`);
    const stored = peer.service.store.getSession(session.id);
    if (stored?.mode !== "focus") throw new Error("mode not in database");
    return session.runtimeSessionId;
  });

  await check("peer plugin loaded inside runtime", async () => {
    const model = models?.default;
    if (!model) throw new Error("no default model");
    const ids = await peer.service.runtimes.get("opencode").listToolIds(workspace!.path, model);
    if (!ids.includes("peer_checkpoint")) throw new Error(`peer_checkpoint missing from ${ids.join(",")}`);
  });

  await check("renderer loads and reaches the API", async () => {
    const win = openWindow();
    for (let i = 0; i < 60; i++) {
      const ready = await win.webContents.executeJavaScript("Boolean(document.querySelector('[data-peer-ready]'))").catch(() => false);
      if (ready) return;
      await sleep(500);
    }
    throw new Error("renderer did not signal readiness");
  });

  if (process.env.PEER_SMOKE_LLM === "1") {
    await check("real agent turn edits a file (Focus, delegated)", async () => {
      await api(`/sessions/${session!.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ text: "Create a file named SMOKE.txt containing exactly the word ok. Do not ask questions.", intent: "delegate" }),
      });
      for (let i = 0; i < 360; i++) {
        await sleep(500);
        const snap = await api<SessionSnapshot>(`/sessions/${session!.id}`);
        if (snap.lastError) throw new Error(snap.lastError);
        if (snap.status === "idle" && i > 2) break;
      }
      const file = join(workspace!.path, "SMOKE.txt");
      if (!existsSync(file)) throw new Error("SMOKE.txt was not created");
      return readFileSync(file, "utf8").trim();
    });
  }

  const ok = checks.every((c) => c.ok);
  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
  console.log(`PEER_SMOKE_RESULT ${JSON.stringify({ ok, platform: process.platform, arch: process.arch, checks })}`);
  return ok;
}
