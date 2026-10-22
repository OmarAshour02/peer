import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultDataDir, mergePath } from "../src/server/platform.js";
import { platformTarget, resolveOpenCodeBinary } from "../src/server/runtime/opencode/binary.js";
import { SAFETY_PERMISSIONS } from "../src/server/runtime/opencode/process.js";
import { Store } from "../src/server/store.js";
import { validateWorkspacePath } from "../src/server/workspaces.js";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "peer-test-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("store", () => {
  it("persists sessions, modes and checkpoints across reopen", () => {
    const file = join(dir, "peer.db");
    const a = new Store(file);
    const ws = a.upsertWorkspace(dir, "proj");
    const s = a.createSession({ workspaceId: ws.id, runtime: "opencode", runtimeSessionId: "rt1", title: "t", mode: "learn", model: { providerId: "p", modelId: "m" } });
    const turn = a.createTurn({ sessionId: s.id, mode: "learn", intent: "default", gate: "engage" });
    a.createCheckpoint({
      sessionId: s.id,
      turnId: turn.id,
      runtimeCallId: null,
      category: "hypothesis",
      question: "Q",
      context: null,
      options: [{ label: "A" }],
      recommendation: "A",
      status: "pending",
      resolution: null,
    });
    a.close();

    const b = new Store(file);
    const loaded = b.getSession(s.id)!;
    expect(loaded.mode).toBe("learn");
    expect(loaded.model).toEqual({ providerId: "p", modelId: "m" });
    expect(b.listCheckpoints(s.id)[0]).toMatchObject({ question: "Q", options: [{ label: "A" }], status: "pending" });
    expect(b.latestTurn(s.id)!.gate).toBe("engage");
    b.close();
  });

  it("upserts workspaces by path", () => {
    const store = new Store(":memory:");
    const a = store.upsertWorkspace(dir, "x");
    const b = store.upsertWorkspace(dir, "x");
    expect(a.id).toBe(b.id);
    expect(store.listWorkspaces()).toHaveLength(1);
  });
});

describe("workspace validation", () => {
  it("accepts a real project directory and resolves symlinks", () => {
    expect(validateWorkspacePath(dir)).toEqual({ path: dir, name: dir.split("/").pop() });
  });
  it("rejects relative, missing, file, root and home paths", () => {
    writeFileSync(join(dir, "f"), "");
    expect(() => validateWorkspacePath("relative/path")).toThrow(/absolute/);
    expect(() => validateWorkspacePath(join(dir, "missing"))).toThrow(/does not exist/);
    expect(() => validateWorkspacePath(join(dir, "f"))).toThrow(/Not a directory/);
    expect(() => validateWorkspacePath("/")).toThrow(/root/);
    expect(() => validateWorkspacePath(dir, dir)).toThrow(/home/);
    expect(() => validateWorkspacePath(42)).toThrow(/required/);
  });
});

describe("platform", () => {
  it("maps supported platforms to vendor targets", () => {
    expect(platformTarget("darwin", "arm64")).toBe("mac-arm64");
    expect(platformTarget("darwin", "x64")).toBe("mac-x64");
    expect(platformTarget("linux", "arm64")).toBe("linux-arm64");
    expect(platformTarget("linux", "x64")).toBe("linux-x64");
    expect(() => platformTarget("win32", "x64")).toThrow(/does not support/);
    expect(() => platformTarget("linux", "ia32")).toThrow(/architecture/);
  });

  it("finds the runtime binary: override, then packaged resources, then vendor dir", () => {
    const vendor = join(dir, "vendor", "opencode", platformTarget());
    mkdirSync(vendor, { recursive: true });
    writeFileSync(join(vendor, "opencode"), "");
    expect(resolveOpenCodeBinary({ appRoot: dir, env: {} })).toBe(join(vendor, "opencode"));

    const resources = join(dir, "res");
    mkdirSync(join(resources, "opencode"), { recursive: true });
    writeFileSync(join(resources, "opencode", "opencode"), "");
    expect(resolveOpenCodeBinary({ appRoot: dir, resourcesPath: resources, env: {} })).toBe(join(resources, "opencode", "opencode"));

    expect(resolveOpenCodeBinary({ appRoot: dir, env: { PEER_OPENCODE_BIN: join(vendor, "opencode") }, resourcesPath: resources })).toBe(
      join(vendor, "opencode"),
    );
    expect(() => resolveOpenCodeBinary({ appRoot: join(dir, "nothing"), env: {} })).toThrow(/fetch:opencode/);
  });

  it("uses Electron-compatible data dirs per platform", () => {
    expect(defaultDataDir({ HOME: "/h" }, "darwin")).toBe("/h/Library/Application Support/Peer");
    expect(defaultDataDir({ HOME: "/h" }, "linux")).toBe("/h/.config/Peer");
    expect(defaultDataDir({ HOME: "/h", XDG_CONFIG_HOME: "/x" }, "linux")).toBe("/x/Peer");
    expect(defaultDataDir({ PEER_DATA_DIR: "/d" }, "linux")).toBe("/d");
  });

  it("merges PATHs without duplicates, login shell first", () => {
    expect(mergePath("/opt/homebrew/bin:/usr/bin", "/usr/bin:/bin")).toBe("/opt/homebrew/bin:/usr/bin:/bin");
  });

  it("safety rules ask before destructive commands and deny outside-workspace access", () => {
    expect(SAFETY_PERMISSIONS.external_directory).toBe("deny");
    for (const p of ["rm *", "git push*", "git reset --hard*", "sudo *"]) expect(SAFETY_PERMISSIONS.bash[p as keyof typeof SAFETY_PERMISSIONS.bash]).toBe("ask");
  });
});
