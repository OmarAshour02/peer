import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { EventHub } from "../src/server/hub.js";
import { RuntimeSet } from "../src/server/runtime/set.js";
import { PeerService } from "../src/server/service.js";
import { Store } from "../src/server/store.js";
import { Constellation } from "../src/renderer/components/Constellation.js";
import { ThemeToggle } from "../src/renderer/components/Sidebar.js";
import { FakeRuntime } from "./helpers.js";

let dir: string;
let store: Store;

function setup(renderer = false) {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "peer-theme-")));
  store = new Store(":memory:");
  const runtime = new FakeRuntime("opencode");
  const service = new PeerService(store, new RuntimeSet([runtime]), new EventHub());
  let rendererDir: string | undefined;
  if (renderer) {
    rendererDir = join(dir, "renderer");
    mkdirSync(rendererDir, { recursive: true });
    writeFileSync(join(rendererDir, "index.html"), '<html lang="en"><head><title>Peer</title></head><body></body></html>');
  }
  const app = createApp({ service, hub: new EventHub(), apiToken: "api", bridgeToken: "b", allowedOrigins: [], rendererDir });
  return { store, service, app };
}

const patch = (app: ReturnType<typeof setup>["app"], body: unknown) =>
  app.request("/api/preferences", { method: "PATCH", headers: { authorization: ["Bearer", "api"].join(" "), "content-type": "application/json" }, body: JSON.stringify(body) });

describe("display theme", () => {
  afterEach(() => {
    try {
      store.close();
    } catch {
      // already closed
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists as a server preference, validated over the API", async () => {
    const { store, app } = setup();
    expect(store.getPreferences().theme).toBe("dark");
    expect((await patch(app, { theme: "blue" })).status).toBe(400);
    const ok = await patch(app, { theme: "light" });
    expect(ok.status).toBe(200);
    expect(store.getPreferences().theme).toBe("light");
  });

  it("the pre-paint theme bootstrap is an external script the production CSP allows", () => {
    const html = readFileSync(join(process.cwd(), "src/renderer/index.html"), "utf8");
    expect(html).toContain('<script src="./theme-init.js"></script>');
    expect(html).not.toContain("peer-theme");
    expect(existsSync(join(process.cwd(), "src/renderer/public/theme-init.js"))).toBe(true);
  });

  it("stamps the persisted theme onto the served page before first paint", async () => {
    const { store, app } = setup(true);
    // Both themes are stamped, so the bootstrap can tell a stamped dark page from
    // unstamped dev serving.
    const dark = await (await app.request("/")).text();
    expect(dark).toContain('<html lang="en" data-theme="dark">');
    store.setPreferences({ theme: "light" });
    const light = await (await app.request("/")).text();
    expect(light).toContain('<html lang="en" data-theme="light">');
  });

  it("the persisted theme survives closing and reopening the database", () => {
    const { store } = setup();
    const file = join(dir, "peer.db");
    const first = new Store(file);
    first.setPreferences({ theme: "light" });
    first.close();
    const reopened = new Store(file);
    expect(reopened.getPreferences().theme).toBe("light");
    reopened.close();
    expect(store.getPreferences().theme).toBe("dark");
  });

  it("theme helpers tolerate unavailable storage", async () => {
    const theme = await import("../src/renderer/theme.js");
    expect(() => theme.applyTheme("light")).not.toThrow();
    expect(theme.currentTheme()).toBe("dark");
    expect(theme.pendingTheme()).toBeNull();
  });

});
