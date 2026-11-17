// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Constellation, FIGURES } from "../src/renderer/components/Constellation.js";
import { ThemeToggle } from "../src/renderer/components/Sidebar.js";

describe("display theme (renderer)", () => {
  it("the toggle renders as a switch usable without a server connection", () => {
    const html = renderToStaticMarkup(createElement(ThemeToggle));
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-label="Light theme"');
    expect(html).toContain("<svg");
    expect(html).not.toContain("Theme:");
  });

  it("the sidebar keeps the theme switch while disconnected", async () => {
    const { Sidebar } = await import("../src/renderer/components/Sidebar.js");
    const { usePeer } = await import("../src/renderer/store.js");
    usePeer.setState({ connected: false, api: null, workspaces: [], sessions: [], runtimes: [] });
    const html = renderToStaticMarkup(createElement(Sidebar));
    expect(html).toContain("offline");
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-label="Light theme"');
  });

  it("the constellation spans an empty thread's pane and fades out once the first message lands", async () => {
    const { BACKDROP_FADE_MS, ThreadBackdrop, Transcript } = await import("../src/renderer/components/Transcript.js");
    const { usePeer } = await import("../src/renderer/store.js");
    const snapshotFor = (id: string) =>
      ({ session: { id, mode: "collaborate" }, checkpoints: [], permissions: [], lastError: null, status: "idle" }) as never;
    const message = { id: "m1", role: "user", createdAt: 1, parts: [{ type: "text", text: "hello" }] } as never;
    Element.prototype.scrollIntoView = () => {};
    vi.useFakeTimers();
    const host = document.createElement("div");
    const root = createRoot(host);
    // The pane-wide backdrop (header, transcript and composer) next to the transcript itself.
    const pane = () => createElement("div", null, createElement(ThreadBackdrop), createElement(Transcript));
    try {
      usePeer.setState({ snapshot: snapshotFor("s1"), messages: [] });
      await act(async () => root.render(pane()));
      expect(host.innerHTML).toContain("constellation-drift");
      expect(host.innerHTML).not.toContain("constellation-leave");
      expect(host.innerHTML).toContain("Describe a task");

      // First message in the same thread: the figure stays just long enough to fade out.
      await act(async () => usePeer.setState({ messages: [message] }));
      expect(host.innerHTML).toContain("constellation-leave");
      await act(async () => vi.advanceTimersByTime(BACKDROP_FADE_MS + 10));
      expect(host.innerHTML).not.toContain("constellation-drift");

      // Switching to a session that already has messages drops it at once, with no fade.
      await act(async () => usePeer.setState({ snapshot: snapshotFor("s2"), messages: [] }));
      expect(host.innerHTML).toContain("constellation-drift");
      await act(async () => usePeer.setState({ snapshot: snapshotFor("s3"), messages: [message] }));
      expect(host.innerHTML).not.toContain("constellation-drift");

      await act(async () => usePeer.setState({ snapshot: null, messages: [] }));
      expect(host.innerHTML).not.toContain("constellation-drift");
    } finally {
      await act(async () => root.unmount());
      vi.useRealTimers();
    }
  });

  it("a project can be removed from the sidebar after confirming", async () => {
    const { Sidebar } = await import("../src/renderer/components/Sidebar.js");
    const { usePeer } = await import("../src/renderer/store.js");
    window.localStorage.clear();
    const removeWorkspace = vi.fn(async () => ({ ok: true }));
    const api = { removeWorkspace, sessions: async () => [] };
    const ws = (id: string, name: string) => ({ id, name, path: `/tmp/${name}`, sandboxNetwork: false }) as never;
    usePeer.setState({
      api: api as never,
      connected: true,
      workspaces: [ws("w1", "Alpha"), ws("w2", "Beta")],
      sessions: [],
      runtimes: [],
      activeWorkspaceId: "w1",
      activeSessionId: null,
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(createElement(Sidebar)));
    const button = host.querySelector('button[aria-label="Remove project Alpha"]')!;
    expect(button).toBeTruthy();
    await act(async () => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(removeWorkspace).toHaveBeenCalledWith("w1");
    expect(usePeer.getState().workspaces.map((w) => w.name)).toEqual(["Beta"]);
    expect(usePeer.getState().activeWorkspaceId).toBe("w2");
    confirmSpy.mockRestore();
    await act(async () => root.unmount());
  });

  it("the changes panel lists readable file names with the full path on hover", async () => {
    const { ChangesPanel } = await import("../src/renderer/components/ChangesPanel.js");
    const { usePeer } = await import("../src/renderer/store.js");
    const file = "app/Http/Controllers/Auth/RedirectsUsers.php";
    usePeer.setState({ diff: [{ file, additions: 2, deletions: 1, patch: "+added\n-removed" }] });
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(createElement(ChangesPanel, { onClose: () => {} })));
    // The first button is the panel's close button; the file row comes after it.
    const button = [...host.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") !== "Close the changes panel")!;
    expect(button.textContent).toContain("RedirectsUsers.php");
    expect(button.textContent).not.toContain("Controllers/Auth");
    expect(button.title).toBe(file);
    expect(host.textContent).toContain("1 file");
    await act(async () => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(host.textContent).toContain("+added");
    await act(async () => root.unmount());
  });

  it("clicking the toggle switches, persists, and queues the choice when the write fails", async () => {
    const { usePeer } = await import("../src/renderer/store.js");
    const theme = await import("../src/renderer/theme.js");
    const setPreferences = vi.fn(async () => {
      throw new Error("offline");
    });
    usePeer.setState({ api: { setPreferences } as never });
    document.documentElement.removeAttribute("data-theme");
    window.localStorage.clear();
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(createElement(ThemeToggle)));
    const button = host.querySelector("button")!;
    await act(async () => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(setPreferences).toHaveBeenCalledWith({ theme: "light" });
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(theme.pendingTheme()).toBe("light");
    await act(async () => root.unmount());
  });

  it("reconnect writes back a queued theme; an older write cannot clear a newer queued choice", async () => {
    const { usePeer } = await import("../src/renderer/store.js");
    const theme = await import("../src/renderer/theme.js");
    window.localStorage.clear();
    theme.markPendingTheme("light");
    let releaseLight!: () => void;
    const setPreferences = vi.fn(async (prefs: { theme?: string }) => {
      if (prefs.theme === "light") await new Promise<void>((r) => (releaseLight = r));
      if (prefs.theme === "dark") throw new Error("offline");
      return {};
    });
    usePeer.setState({
      api: { setPreferences, health: async () => ({ runtimes: [] }) } as never,
      activeWorkspaceId: null,
      activeSessionId: null,
    });
    const reconnecting = usePeer.getState().reconnected();
    // While the light retry is outstanding, the developer picks dark and that write fails.
    await vi.waitFor(() => expect(setPreferences).toHaveBeenCalledWith({ theme: "light" }));
    // While the light retry is outstanding, a newer dark choice is queued by its failed write.
    theme.markPendingTheme("dark");
    releaseLight();
    await reconnecting;
    await new Promise((r) => setImmediate(r));
    expect(theme.pendingTheme()).toBe("dark");
    // A later successful dark write clears only its own marker.
    theme.clearPendingTheme("dark");
    expect(theme.pendingTheme()).toBeNull();
  });

  it("a reconnect landing while a theme write is outstanding still retries after it fails", async () => {
    const { usePeer } = await import("../src/renderer/store.js");
    const theme = await import("../src/renderer/theme.js");
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    let rejectWrite!: (err: Error) => void;
    let calls = 0;
    const setPreferences = vi.fn(async () => {
      calls++;
      if (calls === 1) await new Promise<never>((_, reject) => (rejectWrite = reject));
      return {};
    });
    usePeer.setState({ api: { setPreferences, health: async () => ({ runtimes: [] }) } as never, activeWorkspaceId: null, activeSessionId: null });
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(createElement(ThemeToggle)));
    const button = host.querySelector("button")!;
    await act(async () => button.dispatchEvent(new MouseEvent("click", { bubbles: true }))); // -> light, write outstanding
    expect(theme.pendingTheme()).toBe("light");
    const reconnecting = usePeer.getState().reconnected();
    await vi.waitFor(() => expect(setPreferences.mock.calls.length).toBeGreaterThanOrEqual(1));
    await act(async () => rejectWrite(new Error("offline")));
    await reconnecting;
    await vi.waitFor(() => expect(setPreferences.mock.calls.length).toBe(2));
    await vi.waitFor(() => expect(theme.pendingTheme()).toBeNull());
    await act(async () => root.unmount());
  });

  it("a late failure of an older choice does not queue it over the newer persisted choice", async () => {
    const { usePeer } = await import("../src/renderer/store.js");
    const theme = await import("../src/renderer/theme.js");
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    let rejectLight!: (err: Error) => void;
    const setPreferences = vi.fn(async (prefs: { theme?: string }) => {
      if (prefs.theme === "light") await new Promise<never>((_, reject) => (rejectLight = reject));
      return {};
    });
    usePeer.setState({ api: { setPreferences } as never });
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(createElement(ThemeToggle)));
    const button = host.querySelector("button")!;
    await act(async () => button.dispatchEvent(new MouseEvent("click", { bubbles: true }))); // -> light (outstanding)
    await act(async () => button.dispatchEvent(new MouseEvent("click", { bubbles: true }))); // -> dark (queued behind)
    await act(async () => rejectLight(new Error("offline")));
    expect(setPreferences).toHaveBeenLastCalledWith({ theme: "dark" });
    expect(theme.pendingTheme()).toBeNull();
    expect(document.documentElement.dataset.theme).toBeUndefined();
    await act(async () => root.unmount());
  });

  it("the stylesheet carries both themes, focus rings, and reduced-motion behavior", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(join(process.cwd(), "src/renderer/styles.css"), "utf8");
    const darkTokens = [...css.matchAll(/--(color-[a-z-]+|shadow-[a-z-]+):/g)].map((m) => m[1]!);
    const lightBlock = css.slice(css.indexOf('[data-theme="light"]'));
    for (const token of new Set(darkTokens)) expect(lightBlock, token).toContain(`--${token}:`);
    expect(css).toContain(":focus-visible");
    expect(css).toContain("outline: 2px solid var(--color-accent)");
    // Text fields show focus through their border/container, never a rectangular ring.
    expect(css).toContain("textarea:focus-visible");
    expect(css).toContain("prefers-reduced-motion");
    expect(css).toContain("::selection");
    expect(css).toContain("constellation-drift");

    // Computed behavior in a real DOM: token values actually switch with the theme attribute,
    // and the reduced-motion rule really disables the constellation animation.
    const style = document.createElement("style");
    style.textContent = css.replace('@import "tailwindcss";', "").replace("@theme", ":root");
    document.head.appendChild(style);
    const rootStyle = () => getComputedStyle(document.documentElement);
    document.documentElement.removeAttribute("data-theme");
    expect(rootStyle().getPropertyValue("--color-bg").trim()).toBe("#090b09");
    expect(rootStyle().getPropertyValue("--color-accent").trim()).toBe("#86b985");
    document.documentElement.dataset.theme = "light";
    expect(rootStyle().getPropertyValue("--color-bg").trim()).toBe("#f7f5f0");
    expect(rootStyle().getPropertyValue("--color-accent").trim()).toBe("#606e56");
    expect(rootStyle().getPropertyValue("--color-fg").trim()).toBe("#292929");
    document.documentElement.removeAttribute("data-theme");
    const rules = [...style.sheet!.cssRules].map((r) => r.cssText);
    const media = rules.find((r) => r.includes("prefers-reduced-motion"))!;
    expect(media).toContain("animation: none");
    expect(rules.some((r) => r.startsWith(":focus-visible"))).toBe(true);
    style.remove();
  });

  it("every text token meets WCAG AA contrast on every surface in both themes", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(join(process.cwd(), "src/renderer/styles.css"), "utf8");
    const grab = (block: string) => Object.fromEntries([...block.matchAll(/--color-([a-z-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1]!, m[2]!]));
    const dark = grab(css.slice(css.indexOf("@theme"), css.indexOf('[data-theme="light"]')));
    const light = { ...dark, ...grab(css.slice(css.indexOf('[data-theme="light"]'))) };
    const lum = (hex: string) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    };
    const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
    const surfaces = ["bg", "panel", "nav", "raised"];
    const text = ["fg", "muted", "faint", "accent", "accent-deep", "link", "collab", "learn", "warn", "danger"];
    for (const [name, tokens] of [["dark", dark], ["light", light]] as const) {
      for (const fg of text) for (const bg of surfaces) {
        expect(ratio(tokens[fg]!, tokens[bg]!), `${name}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
      // Focus/accent are UI indicators: WCAG non-text contrast.
      for (const ui of ["accent", "focus"]) for (const bg of surfaces) {
        expect(ratio(tokens[ui]!, tokens[bg]!), `${name}: ${ui} on ${bg}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("a reconnect sync during a delayed init is not overwritten by the stale init preferences", async () => {
    const { usePeer } = await import("../src/renderer/store.js");
    const theme = await import("../src/renderer/theme.js");
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    window.localStorage.setItem("peer-theme", "light");
    window.localStorage.setItem("peer-theme-pending", "light");
    let saved = "dark";
    let releasePrefs!: () => void;
    const prefsGate = new Promise<void>((r) => { releasePrefs = r; });
    const api = {
      workspaces: async () => [],
      health: async () => ({ runtimes: [] }),
      preferences: async () => { const stale = saved; await prefsGate; return { theme: stale, defaultRuntime: "claude", runtimeChosen: null, lastSessionId: null }; },
      setPreferences: async (p: { theme?: string }) => { if (p.theme) saved = p.theme; return {}; },
    };
    const initDone = usePeer.getState().init(api as never);
    await usePeer.getState().reconnected(); // syncs the queued light choice, clears the marker
    expect(saved).toBe("light");
    expect(theme.pendingTheme()).toBeNull();
    releasePrefs(); // init now resumes with its stale dark preferences
    await initDone;
    expect(document.documentElement.dataset.theme).toBe("light");
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("currentTheme agrees with the bootstrap: a queued choice beats the stamp", async () => {
    const theme = await import("../src/renderer/theme.js");
    window.localStorage.clear();
    document.documentElement.dataset.theme = "light";
    window.localStorage.setItem("peer-theme", "light");
    window.localStorage.setItem("peer-theme-pending", "dark");
    expect(theme.currentTheme()).toBe("dark");
    window.localStorage.clear();
    document.documentElement.dataset.theme = "dark";
    window.localStorage.setItem("peer-theme", "light");
    expect(theme.currentTheme()).toBe("dark");
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("a successful newer choice supersedes an older queued one", async () => {
    const { usePeer } = await import("../src/renderer/store.js");
    const theme = await import("../src/renderer/theme.js");
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    const setPreferences = vi.fn(async (prefs: { theme?: string }) => {
      if (prefs.theme === "light") throw new Error("offline");
      return {};
    });
    usePeer.setState({ api: { setPreferences } as never });
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(createElement(ThemeToggle)));
    const button = host.querySelector("button")!;
    await act(async () => button.dispatchEvent(new MouseEvent("click", { bubbles: true }))); // -> light, write fails
    expect(theme.pendingTheme()).toBe("light");
    await act(async () => button.dispatchEvent(new MouseEvent("click", { bubbles: true }))); // -> dark, write succeeds
    expect(setPreferences).toHaveBeenLastCalledWith({ theme: "dark" });
    expect(theme.pendingTheme()).toBeNull();
    await act(async () => root.unmount());
  });

  it("the pre-paint bootstrap honors queued choices in both directions", async () => {
    const { readFileSync } = await import("node:fs");
    const boot = readFileSync(join(process.cwd(), "src/renderer/public/theme-init.js"), "utf8");
    const run = (stamped: string | null, stored: Record<string, string>) => {
      window.localStorage.clear();
      for (const [k, v] of Object.entries(stored)) window.localStorage.setItem(k, v);
      if (stamped) document.documentElement.dataset.theme = stamped;
      else document.documentElement.removeAttribute("data-theme");
      new Function(boot)();
      return document.documentElement.dataset.theme ?? null;
    };
    // Server saved light, queued dark choice: dark wins before paint.
    expect(run("light", { "peer-theme": "dark", "peer-theme-pending": "dark" })).toBeNull();
    // Server saved dark (stamped), queued light choice: light wins before paint.
    expect(run("dark", { "peer-theme": "light", "peer-theme-pending": "light" })).toBe("light");
    // Nothing queued: the server stamp stands, even over a stale local mirror, both directions.
    expect(run("light", {})).toBe("light");
    expect(run("light", { "peer-theme": "dark" })).toBe("light");
    expect(run("dark", {})).toBe("dark");
    expect(run("dark", { "peer-theme": "light" })).toBe("dark");
    // Unstamped dev serving: the local mirror applies.
    expect(run(null, { "peer-theme": "light" })).toBe("light");
    document.documentElement.removeAttribute("data-theme");
  });

  it("the constellation is deterministic, hidden from assistive tech, and pointer-transparent", () => {
    const a = renderToStaticMarkup(createElement(Constellation));
    const b = renderToStaticMarkup(createElement(Constellation));
    expect(a).toBe(b);
    expect(a).toContain('aria-hidden="true"');
    expect(a).toContain("pointer-events-none");
    expect(a).toContain("constellation-drift");
  });

  it("the constellation is a star atlas: real figures balanced through the centre, hairlines short of every star", () => {
    const a = renderToStaticMarkup(createElement(Constellation));
    const circles = [...a.matchAll(/<circle cx="(-?[\d.]+)" cy="(-?[\d.]+)" r="([\d.]+)" fill="var\(--color-constellation-node\)"/g)].map(
      ([, x, y, r]) => ({ x: Number(x), y: Number(y), r: Number(r) }),
    );
    const lines = [...a.matchAll(/x1="(-?[\d.]+)" y1="(-?[\d.]+)" x2="(-?[\d.]+)" y2="(-?[\d.]+)"/g)].map(([, x1, y1, x2, y2]) => [
      { x: Number(x1), y: Number(y1) },
      { x: Number(x2), y: Number(y2) },
    ]);
    expect(lines.length).toBeGreaterThan(25);
    // The middle stays dark for the empty-state text: no star, figure or dust, in the central band.
    for (const c of circles) expect(c.x > 400 && c.x < 800 && c.y > 270 && c.y < 480, `star at ${c.x},${c.y}`).toBe(false);
    // Atlas joins: every hairline ends short of the star it points at, never touching it.
    for (const [p, q] of lines) for (const c of circles) for (const e of [p!, q!]) expect(Math.hypot(e.x - c.x, e.y - c.y)).toBeGreaterThan(c.r + 3);
    // Figures, not a tangle: no two hairlines cross.
    type Pt = { x: number; y: number };
    const o = (p: Pt, q: Pt, r: Pt) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    for (let i = 0; i < lines.length; i++)
      for (let j = i + 1; j < lines.length; j++) {
        const [p, q] = lines[i]!;
        const [r, t] = lines[j]!;
        expect(o(p!, q!, r!) * o(p!, q!, t!) < 0 && o(r!, t!, p!) * o(r!, t!, q!) < 0, `lines ${i} and ${j} cross`).toBe(false);
      }
    // Balanced through the centre: each figure has a distinct partner near its point reflection.
    for (const f of FIGURES) {
      const partner = FIGURES.find((g) => g !== f && Math.hypot(g.at[0] - (1200 - f.at[0]), g.at[1] - (750 - f.at[1])) < 50);
      expect(partner, `${f.name} has no partner`).toBeDefined();
      for (const [u, v] of f.links) expect(u < f.stars.length && v < f.stars.length, `${f.name} link ${u}-${v}`).toBe(true);
    }
  });
});
