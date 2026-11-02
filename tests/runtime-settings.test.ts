import { mkdtempSync, realpathSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { normalizeRuntimeSettings } from "../src/server/app.js";
import { EventHub } from "../src/server/hub.js";
import { claudePermissionMode } from "../src/server/runtime/claude/adapter.js";
import { turnStartParams } from "../src/server/runtime/codex/adapter.js";
import { GeminiAdapter } from "../src/server/runtime/gemini/adapter.js";
import { RuntimeSet } from "../src/server/runtime/set.js";
import { PeerService } from "../src/server/service.js";
import { Store } from "../src/server/store.js";
import { DEFAULT_RUNTIME_SETTINGS } from "../src/shared/types.js";
import { FakeRuntime } from "./helpers.js";

describe("runtime settings validation", () => {
  it("accepts a full form and trims it", () => {
    expect(
      normalizeRuntimeSettings({ claudeBin: " /usr/local/bin/claude ", codexBin: "", geminiBin: null, claudePermissionMode: "auto", codexEffort: " high " }),
    ).toEqual({ claudeBin: "/usr/local/bin/claude", codexBin: null, geminiBin: null, claudePermissionMode: "auto", codexEffort: "high" });
  });

  it("merges a partial update over the stored settings", () => {
    const previous = { ...DEFAULT_RUNTIME_SETTINGS, codexEffort: "low", claudeBin: "/c" };
    expect(normalizeRuntimeSettings({ codexEffort: "" }, previous)).toMatchObject({ codexEffort: null, claudeBin: "/c" });
    expect(normalizeRuntimeSettings({}, previous)).toEqual(previous);
  });

  it("refuses wrong shapes", () => {
    for (const v of [null, 42, "x", []]) expect(() => normalizeRuntimeSettings(v)).toThrow(/must be an object/);
    expect(() => normalizeRuntimeSettings({ claudeBin: 42 })).toThrow(/claudeBin/);
    expect(() => normalizeRuntimeSettings({ claudePermissionMode: "yolo" })).toThrow(/claudePermissionMode/);
    expect(() => normalizeRuntimeSettings({ codexEffort: 42 })).toThrow(/codexEffort/);
    expect(() => normalizeRuntimeSettings({ codexBin: "x".repeat(2000) })).toThrow(/too long/);
  });
});

describe("runtime settings persistence", () => {
  let dir: string;
  let store: Store;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "peer-settings-")));
    store = new Store(":memory:");
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("defaults everything and round-trips", () => {
    expect(store.getPreferences().runtimeSettings).toEqual(DEFAULT_RUNTIME_SETTINGS);
    const prefs = store.setPreferences({ runtimeSettings: { ...DEFAULT_RUNTIME_SETTINGS, codexEffort: "high", claudePermissionMode: "auto" } });
    expect(prefs.runtimeSettings).toMatchObject({ codexEffort: "high", claudePermissionMode: "auto", claudeBin: null });
    expect(store.getPreferences().runtimeSettings).toMatchObject({ codexEffort: "high" });
  });

  it("fills defaults over settings stored by an older Peer", () => {
    store.db.prepare("INSERT INTO preferences (key, value) VALUES ('runtimeSettings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify({ codexEffort: "low" }));
    expect(store.getPreferences().runtimeSettings).toMatchObject({ ...DEFAULT_RUNTIME_SETTINGS, codexEffort: "low" });
  });

  it("PATCH /preferences sets and validates them", async () => {
    const service = new PeerService(store, new RuntimeSet([new FakeRuntime()]), new EventHub());
    const app = createApp({ service, hub: new EventHub(), apiToken: "token", bridgeToken: "bridge", allowedOrigins: [] });
    const patch = (body: unknown) =>
      app.request("/api/preferences", { method: "PATCH", headers: { authorization: "Bearer token", "content-type": "application/json" }, body: JSON.stringify(body) });

    const bad = await patch({ runtimeSettings: { claudePermissionMode: "yolo" } });
    expect(bad.status).toBe(400);
    const ok = await patch({ runtimeSettings: { codexEffort: "medium", geminiBin: "/usr/local/bin/gemini" } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ runtimeSettings: { codexEffort: "medium", geminiBin: "/usr/local/bin/gemini", claudePermissionMode: "acceptEdits" } });
    expect(store.getPreferences().runtimeSettings.codexEffort).toBe("medium");
  });
});

describe("settings applied at session start", () => {
  it("maps auto-approvals and the default to Claude's permission mode", () => {
    expect(claudePermissionMode(true, "acceptEdits")).toBe("auto");
    expect(claudePermissionMode(false, "acceptEdits")).toBe("acceptEdits");
    expect(claudePermissionMode(undefined, "auto")).toBe("auto");
  });

  it("sends the configured effort on Codex turns, and omits it otherwise", () => {
    const input = (effort?: string | null) => ({ text: "do it", system: "POLICY", gate: "open" as const, effort });
    expect(turnStartParams("t", input("high"), "m")).toMatchObject({ effort: "high" });
    expect(turnStartParams("t", input(), "m")).not.toHaveProperty("effort");
    expect(turnStartParams("t", input(null), "m")).not.toHaveProperty("effort");
    expect(turnStartParams("t", input(""), "m")).not.toHaveProperty("effort");
  });

  it("the engine passes the effort only to Codex sessions", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "peer-effort-")));
    const store = new Store(":memory:");
    try {
      const codex = new FakeRuntime("codex");
      const other = new FakeRuntime("claude");
      const service = new PeerService(store, new RuntimeSet([codex, other]), new EventHub());
      store.setPreferences({ runtimeSettings: { ...DEFAULT_RUNTIME_SETTINGS, codexEffort: "xhigh" } });
      const ws = service.addWorkspace(dir);
      const c = await service.createSession(ws.id, { runtime: "codex" });
      await service.send(c.id, "work");
      expect(codex.lastPrompt().input.effort).toBe("xhigh");
      const l = await service.createSession(ws.id, { runtime: "claude" });
      await service.send(l.id, "work");
      expect(other.lastPrompt().input.effort).toBeUndefined();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a configured CLI path overrides PATH discovery (and back)", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "peer-bin-")));
    const store = new Store(":memory:");
    try {
      const binDir = join(dir, "bin");
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, "gemini"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "fake 1.0"; exit 0; fi\necho hi\n`);
      chmodSync(join(binDir, "gemini"), 0o755);
      const settings = { ...DEFAULT_RUNTIME_SETTINGS };
      const a = new GeminiAdapter({ env: { ...process.env, PATH: "/nonexistent" }, storage: store, dataDir: join(dir, "data"), settings: () => settings, log: () => {} });
      await a.start();
      expect(a.status().state).toBe("unavailable");
      settings.geminiBin = join(binDir, "gemini");
      await a.restart();
      expect(a.status()).toMatchObject({ state: "ready", version: "fake 1.0" });
      await a.stop();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
