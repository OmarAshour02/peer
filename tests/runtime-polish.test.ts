import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { EventHub } from "../src/server/hub.js";
import { parseEnvOutput, providerVariables } from "../src/server/platform.js";
import type { PromptInput } from "../src/server/runtime/adapter.js";
import { turnStartParams } from "../src/server/runtime/codex/adapter.js";
import { RuntimeSet } from "../src/server/runtime/set.js";
import { TESTED_VERSIONS, versionWarning } from "../src/server/runtime/versions.js";
import { PeerService } from "../src/server/service.js";
import { Store } from "../src/server/store.js";
import { FakeRuntime } from "./helpers.js";

describe("version drift", () => {
  const codex = (v: string) => versionWarning("Codex", v, TESTED_VERSIONS.codex, "`npm i -g @openai/codex`");
  const claude = (v: string) => versionWarning("Claude Code", v, TESTED_VERSIONS.claude, "`claude update`");

  it("says nothing inside the tested range", () => {
    expect(codex("0.163.0")).toBeUndefined();
    expect(codex("0.163.4")).toBeUndefined();
    expect(claude("2.1.0")).toBeUndefined();
    expect(claude("2.1.309")).toBeUndefined();
  });

  it("warns about newer and older CLIs, naming the tested range", () => {
    expect(codex("0.164.0")).toBe("Codex 0.164.0 is newer than the versions Peer was tested with (0.163.x). Peer may not work correctly with it; if sessions misbehave, install 0.163.x.");
    expect(codex("1.0.0-alpha.2")).toMatch(/is newer/);
    expect(codex("0.162.9")).toBe("Codex 0.162.9 is older than the versions Peer was tested with (0.163.x). If sessions misbehave, update it (`npm i -g @openai/codex`).");
    expect(claude("2.2.0")).toMatch(/newer than the versions Peer was tested with \(2\.1\.x\)/);
    expect(claude("2.0.77")).toMatch(/older.*\(`claude update`\)/);
    expect(claude("2.10.0")).toMatch(/newer/);
  });

  it("does not guess about a version it cannot read", () => {
    expect(codex("unknown")).toBeUndefined();
    expect(versionWarning("Codex", undefined, TESTED_VERSIONS.codex, "")).toBeUndefined();
  });
});

describe("Codex sandbox network", () => {
  const input = (gate: PromptInput["gate"], network?: boolean): PromptInput => ({ text: "do it", system: "policy", gate, network });

  it("opens the network only for writable turns in workspaces that allow it", () => {
    expect(turnStartParams("t", input("open", true), "m").sandboxPolicy).toMatchObject({ type: "workspaceWrite", networkAccess: true });
    expect(turnStartParams("t", input("open", false), "m").sandboxPolicy).toMatchObject({ type: "workspaceWrite", networkAccess: false });
    expect(turnStartParams("t", input("open"), "m").sandboxPolicy).toMatchObject({ networkAccess: false });
    for (const gate of ["engage", "hold"] as const) expect(turnStartParams("t", input(gate, true), "m").sandboxPolicy).toEqual({ type: "readOnly", networkAccess: false });
  });

  it("tells the agent what its sandbox allows", () => {
    expect(turnStartParams("t", input("open", true), "m").input[0]!.text).toMatch(/may use the network, including opening local ports/);
    expect(turnStartParams("t", input("open", true), "m").input[0]!.text).not.toMatch(/without network access/);
    expect(turnStartParams("t", input("open", false), "m").input[0]!.text).toMatch(/without network access/);
    expect(turnStartParams("t", input("engage", true), "m").input[0]!.text).toMatch(/without network access/);
  });

  let dir: string;
  let store: Store;
  let runtime: FakeRuntime;
  let service: PeerService;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "peer-net-")));
    store = new Store(":memory:");
    runtime = new FakeRuntime("codex");
    service = new PeerService(store, new RuntimeSet([runtime]), new EventHub());
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is a workspace setting, off by default, that applies from the next turn", async () => {
    const hub = new EventHub();
    const app = createApp({ service, hub, apiToken: "token", bridgeToken: "b", allowedOrigins: [] });
    const patch = (id: string, body: unknown) =>
      app.request(`/api/workspaces/${id}`, { method: "PATCH", headers: { authorization: "Bearer token", "content-type": "application/json" }, body: JSON.stringify(body) });
    const ws = service.addWorkspace(dir);
    expect(ws.sandboxNetwork).toBe(false);
    const s = await service.createSession(ws.id, { mode: "focus" });
    await service.send(s.id, "first");
    expect(runtime.lastPrompt().input.network).toBe(false);
    runtime.emit({ type: "session.idle", sessionId: s.runtimeSessionId });

    expect((await patch(ws.id, { sandboxNetwork: "yes" })).status).toBe(400);
    expect((await patch("ws_missing", { sandboxNetwork: true })).status).toBe(404);
    const res = await patch(ws.id, { sandboxNetwork: true });
    expect(await res.json()).toMatchObject({ id: ws.id, sandboxNetwork: true });
    expect(store.listWorkspaces()[0]!.sandboxNetwork).toBe(true);
    await service.send(s.id, "second");
    expect(runtime.lastPrompt().input.network).toBe(true);
  });
});

describe("provider keys from the login shell", () => {
  it("parses `env -0` output, including values with newlines and '='", () => {
    expect(parseEnvOutput("A=1\0B=x=y\0MULTI=line1\nline2\0junk\0")).toEqual({ A: "1", B: "x=y", MULTI: "line1\nline2" });
  });

  it("picks provider credential variables Peer's own environment lacks", () => {
    const shell = {
      OPENAI_API_KEY: "sk-shell",
      GROQ_API_KEY: "gsk",
      HF_API_TOKEN: "hf",
      AWS_PROFILE: "dev",
      OLLAMA_HOST: "0.0.0.0:11434",
      ANTHROPIC_API_KEY: "sk-ant-shell",
      GITHUB_TOKEN: "ghp", // not a model provider variable
      PATH: "/usr/bin",
      lower_api_key: "x",
      EMPTY_API_KEY: "",
    };
    expect(providerVariables(shell, { ANTHROPIC_API_KEY: "sk-ant-own" })).toEqual({
      OPENAI_API_KEY: "sk-shell",
      GROQ_API_KEY: "gsk",
      HF_API_TOKEN: "hf",
      AWS_PROFILE: "dev",
      OLLAMA_HOST: "0.0.0.0:11434",
    });
  });
});

describe("renaming sessions", () => {
  let dir: string;
  let store: Store;
  let runtime: FakeRuntime;
  let service: PeerService;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "peer-rename-")));
    store = new Store(":memory:");
    runtime = new FakeRuntime();
    service = new PeerService(store, new RuntimeSet([runtime]), new EventHub());
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the developer's name when the runtime generates a title later", async () => {
    const s = await service.createSession(service.addWorkspace(dir).id, {});
    runtime.emit({ type: "session.updated", sessionId: s.runtimeSessionId, title: "Generated title", parentId: null });
    await new Promise((r) => setImmediate(r));
    expect(store.getSession(s.id)!.title).toBe("Generated title");

    expect(service.updateSession(s.id, { title: "  My   refactor  " }).title).toBe("My refactor");
    runtime.emit({ type: "session.updated", sessionId: s.runtimeSessionId, title: "Another generated title", parentId: null });
    await new Promise((r) => setImmediate(r));
    expect(store.getSession(s.id)!.title).toBe("My refactor");
    expect(() => service.updateSession(s.id, { title: "   " })).toThrow(/cannot be empty/);
    expect(service.updateSession(s.id, { title: "x".repeat(500) }).title).toHaveLength(200);
  });

  it("deletes a session after stopping its run", async () => {
    const s = await service.createSession(service.addWorkspace(dir).id, {});
    await service.send(s.id, "work");
    await service.deleteSession(s.id);
    expect(runtime.aborted).toContain(s.runtimeSessionId);
    expect(store.getSession(s.id)).toBeNull();
  });
});
