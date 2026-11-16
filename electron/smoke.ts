// Packaged-app smoke test: `Peer --smoke-test` (CI runs this on every OS/arch target).
// It exercises real behavior, not just "the build succeeded": the bundled runtime binary starts
// on this platform, the Peer plugin loads inside it, the API, persistence and renderer work.
// Set PEER_SMOKE_LLM=1 to also run a real agent turn that edits a file (needs network).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeTheme, type BrowserWindow } from "electron";
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

  let win: BrowserWindow | null = null;
  await check("renderer loads and reaches the API", async () => {
    win = openWindow();
    for (let i = 0; i < 60; i++) {
      const ready = await win.webContents.executeJavaScript("Boolean(document.querySelector('[data-peer-ready]'))").catch(() => false);
      if (ready) return;
      await sleep(500);
    }
    throw new Error("renderer did not signal readiness");
  });

  // The design system (DESIGN.md) in the real renderer: computed theme tokens switch with the
  // toggle, keyboard focus shows the accent outline, floating surfaces carry ambient shadows,
  // and reduced motion actually stops the constellation animation.
  await check("rendered design system: themes, focus, shadows, reduced motion", async () => {
    if (!win) throw new Error("no renderer window");
    const read = (expr: string) => win!.webContents.executeJavaScript(expr) as Promise<Record<string, string | boolean>>;
    // Open a session so the composer and the empty transcript (constellation) are on screen.
    await read(`(() => { [...document.querySelectorAll('button')].find((b) => b.textContent.includes('New session'))?.click(); return {}; })()`);
    for (let i = 0; i < 20; i++) {
      const has = await win.webContents.executeJavaScript("Boolean(document.querySelector('.shadow-composer'))").catch(() => false);
      if (has) break;
      await sleep(500);
    }
    // Pixel-level proof, not just computed style: sample the captured frame.
    // Bottom-left is the sidebar (nav surface); the transcript's left edge is the main ground.
    const frame = async () => {
      const img = await win!.capturePage();
      const size = img.getSize();
      return { ...size, bmp: img.toBitmap() }; // BGRA
    };
    const near = (px: readonly number[], rgb: readonly number[]) => px.every((v, i) => Math.abs(v - rgb[i]!) <= 3);
    const sidebarPixel = async () => {
      const { width, height, bmp } = await frame();
      const i = ((height - 5) * width + 4) * 4;
      return [bmp[i + 2] ?? -1, bmp[i + 1] ?? -1, bmp[i] ?? -1];
    };
    const groundFraction = async (rgb: readonly number[]) => {
      const rect = await win!.webContents.executeJavaScript(`(() => { const m = document.querySelector('main').getBoundingClientRect(); return { x: m.x, y: m.y, w: m.width, h: m.height, iw: window.innerWidth }; })()`) as { x: number; y: number; w: number; h: number; iw: number };
      const { width, bmp } = await frame();
      const scale = width / rect.iw;
      let hits = 0;
      const n = 40;
      for (let k = 0; k < n; k++) {
        const x = Math.floor((rect.x + 8) * scale);
        const y = Math.floor((rect.y + 60 + ((rect.h - 120) * k) / n) * scale);
        const i = (y * width + x) * 4;
        if (near([bmp[i + 2] ?? -1, bmp[i + 1] ?? -1, bmp[i] ?? -1], rgb)) hits++;
      }
      return hits / n;
    };
    const darkNavPx = await sidebarPixel();
    if (!near(darkNavPx, [15, 18, 15])) throw new Error(`dark sidebar pixel: ${darkNavPx}`);
    const darkGround = await groundFraction([9, 11, 9]);
    if (darkGround < 0.8) throw new Error(`dark ground pixels: ${darkGround}`);
    // Pin motion to "no-preference" so the check doesn't depend on the host's accessibility
    // settings (CI macOS runners can have Reduce Motion on, which correctly stops the drift).
    const dbg = win.webContents.debugger;
    if (!dbg.isAttached()) dbg.attach("1.3");
    await dbg.sendCommand("Emulation.setEmulatedMedia", { media: "", features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
    await sleep(200);
    const before = await read(`(() => {
      const cs = getComputedStyle(document.documentElement);
      const composer = document.querySelector('.shadow-composer');
      const drift = document.querySelector('.constellation-drift');
      return {
        bg: cs.getPropertyValue('--color-bg').trim(),
        accent: cs.getPropertyValue('--color-accent').trim(),
        composerShadow: composer ? getComputedStyle(composer).boxShadow : 'missing',
        driftAnimation: drift ? getComputedStyle(drift).animationName : 'missing',
        selection: getComputedStyle(document.body, '::selection').backgroundColor,
      };
    })()`);
    // Detach before the pixel checks: with the debugger attached, Linux (xvfb) captured a stale frame.
    dbg.detach();
    if (before.bg !== "#090b09") throw new Error(`dark bg token: ${before.bg}`);
    if (before.accent !== "#86b985") throw new Error(`dark accent token: ${before.accent}`);
    if (before.composerShadow === "missing" || before.composerShadow === "none") throw new Error(`composer shadow: ${before.composerShadow}`);
    if (before.driftAnimation !== "constellation-drift") throw new Error(`constellation animation: ${before.driftAnimation}`);
    if (before.selection !== "rgb(134, 185, 133)") throw new Error(`selection color: ${before.selection}`);

    await read(`(() => { document.querySelector('button[role="switch"][aria-label="Light theme"]')?.click(); return {}; })()`);
    await sleep(300);
    const light = await read(`(() => {
      const cs = getComputedStyle(document.documentElement);
      const nav = document.querySelector('aside');
      return {
        bg: cs.getPropertyValue('--color-bg').trim(), accent: cs.getPropertyValue('--color-accent').trim(), fg: cs.getPropertyValue('--color-fg').trim(),
        navBg: nav ? getComputedStyle(nav).backgroundColor : 'missing',
      };
    })()`);
    if (light.bg !== "#f7f5f0" || light.accent !== "#606e56" || light.fg !== "#292929") throw new Error(`light tokens: ${JSON.stringify(light)}`);
    if (light.navBg !== "rgb(237, 234, 227)") throw new Error(`light sidebar must be paper-toned, not white: ${light.navBg}`);
    const lightNavPx = await sidebarPixel();
    if (!near(lightNavPx, [237, 234, 227])) throw new Error(`light sidebar pixel: ${lightNavPx}`);
    // The native title bar follows Peer's theme, not the system appearance.
    if (nativeTheme.themeSource !== "light") throw new Error(`native theme after switching to light: ${nativeTheme.themeSource}`);
    const lightGround = await groundFraction([247, 245, 240]);
    if (lightGround < 0.8) throw new Error(`light ground pixels: ${lightGround}`);
    await read(`(() => { document.querySelector('button[role="switch"][aria-label="Light theme"]')?.click(); return {}; })()`);
    await sleep(300);

    if ((nativeTheme.themeSource as string) !== "dark") throw new Error(`native theme after switching back to dark: ${nativeTheme.themeSource}`);

    // Real keyboard focus: Tab into the page and read the focused control's outline.
    win.focus();
    win.webContents.focus();
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
    await sleep(200);
    const focus = await read(`(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return { focused: false };
      const cs = getComputedStyle(el);
      return { focused: true, tag: el.tagName, outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth };
    })()`);
    if (!focus.focused) throw new Error("Tab did not focus a control");
    if (focus.outlineStyle === "none" || focus.outlineWidth === "0px") throw new Error(`focus outline: ${JSON.stringify(focus)}`);
    // The transcript takes focus from code (after keyboard use too): it is not a control, so no ring.
    const scrollerFocus = await read(`(() => {
      const s = document.querySelector('[data-transcript-scroller]');
      if (!s) return { present: false };
      s.focus();
      const cs = getComputedStyle(s);
      return { present: true, focused: document.activeElement === s, visible: s.matches(':focus-visible'), outlineStyle: cs.outlineStyle };
    })()`);
    if (scrollerFocus.present && scrollerFocus.focused && scrollerFocus.outlineStyle !== "none") throw new Error(`transcript shows a focus ring: ${JSON.stringify(scrollerFocus)}`);

    // Reduced motion must stop the constellation drift in the applied media query.
    try {
      if (!dbg.isAttached()) dbg.attach("1.3");
      await dbg.sendCommand("Emulation.setEmulatedMedia", { media: "", features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
      await sleep(200);
      const reduced = await read(`(() => {
        const drift = document.querySelector('.constellation-drift');
        return { driftAnimation: drift ? getComputedStyle(drift).animationName : 'missing' };
      })()`);
      if (reduced.driftAnimation !== "none") throw new Error(`reduced-motion animation: ${reduced.driftAnimation}`);
      await dbg.sendCommand("Emulation.setEmulatedMedia", { media: "", features: [] });
    } finally {
      if (dbg.isAttached()) dbg.detach();
    }
    return "dark/light tokens, native title bar theme, focus outline, composer shadow, selection, reduced motion";
  });

  // Panels open only when the developer asks: the Changes panel starts closed and has a close
  // button; the sidebar closes from its own toggle and reopens from the main view.
  await check("panel toggles: changes closed by default, close buttons, sidebar toggle", async () => {
    if (!win) throw new Error("no renderer window");
    const r = await win.webContents.executeJavaScript(`(async () => {
      const wait = () => new Promise((r) => setTimeout(r, 200));
      const changesOpen = () => [...document.querySelectorAll('aside')].some((a) => a.querySelector('[aria-label="Close the changes panel"]'));
      const out = { startsClosed: !changesOpen() };
      [...document.querySelectorAll('header button')].find((b) => b.textContent.trim() === 'Changes').click();
      await wait();
      out.opens = changesOpen();
      document.querySelector('[aria-label="Close the changes panel"]').click();
      await wait();
      out.closes = !changesOpen();
      document.querySelector('[aria-label="Close sidebar"]').click();
      await wait();
      out.sidebarHidden = !document.querySelector('aside [aria-label="Close sidebar"]') && !document.body.textContent.includes('Open project');
      const reopen = document.querySelector('[aria-label="Open sidebar"]');
      const title = document.querySelector('header .truncate');
      out.noOverlap = !reopen || !title || reopen.getBoundingClientRect().right <= title.getBoundingClientRect().left;
      reopen?.click();
      await wait();
      out.sidebarBack = document.body.textContent.includes('Open project');
      // Switching to another session starts it with the panel closed.
      [...document.querySelectorAll('header button')].find((b) => b.textContent.trim() === 'Changes').click();
      await wait();
      // Identify the session on screen by its highlighted sidebar row (unique per session).
      const rows = () => [...document.querySelectorAll('aside .group.rounded')];
      const activeRow = () => rows().find((r) => r.className.includes('bg-raised text-fg'));
      const rowsBefore = rows().length;
      const activeBefore = activeRow();
      [...document.querySelectorAll('aside button')].find((b) => b.textContent.includes('New session'))?.click();
      // Wait until the new session is the one on screen and its header has rendered.
      const loaded = () => rows().length > rowsBefore && activeRow() && activeRow() !== activeBefore && [...document.querySelectorAll('header button')].some((b) => b.textContent.trim() === 'Changes');
      for (let i = 0; i < 40 && !loaded(); i++) await wait();
      out.switchedSession = Boolean(loaded());
      out.closedOnSwitch = !changesOpen();
      return out;
    })()`) as Record<string, boolean>;
    for (const [k, v] of Object.entries(r)) if (!v) throw new Error(`${k} failed: ${JSON.stringify(r)}`);
  });

  // Search: the sidebar's search icon and ⌘K/Ctrl+K open it; typing filters by title; Enter opens.
  await check("search: icon and shortcut open it, Enter opens a session", async () => {
    if (!win) throw new Error("no renderer window");
    const ws = await api<Workspace[]>("/workspaces");
    const chats = ws.find((w) => w.general)!;
    const target = await api<PeerSession>(`/workspaces/${chats.id}/sessions`, { method: "POST", body: JSON.stringify({ runtime: "opencode" }) });
    await api(`/sessions/${target.id}`, { method: "PATCH", body: JSON.stringify({ title: "Smoke search target" }) });
    const r = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms));
      const dialog = () => document.querySelector('[role="dialog"][aria-label="Search chats and sessions"]');
      const out = {};
      document.querySelector('aside [aria-label="Search chats and sessions"]').click();
      await wait();
      out.iconOpens = Boolean(dialog());
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await wait();
      out.escapeCloses = !dialog();
      const mac = /Mac/i.test(navigator.platform);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: mac, ctrlKey: !mac, bubbles: true }));
      await wait();
      out.shortcutOpens = Boolean(dialog());
      const input = dialog().querySelector('input');
      input.focus();
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(input, 'smoke search');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(500);
      out.filtered = [...dialog().querySelectorAll('[role="option"]')].map((o) => o.textContent).some((t) => t.includes('Smoke search target'));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      for (let i = 0; i < 20 && document.querySelector('header .truncate')?.textContent !== 'Smoke search target'; i++) await wait();
      out.enterOpens = !dialog() && document.querySelector('header .truncate')?.textContent === 'Smoke search target';
      // With the sidebar closed, the search icon beside the open-sidebar toggle opens it; a click on the overlay closes it.
      document.querySelector('[aria-label="Close sidebar"]').click();
      await wait();
      const closedIcon = [...document.querySelectorAll('[aria-label="Search chats and sessions"]')].find((b) => b.tagName === 'BUTTON' && !b.closest('aside'));
      closedIcon?.click();
      await wait();
      out.closedSidebarIconOpens = Boolean(closedIcon) && Boolean(dialog());
      const overlay = dialog()?.parentElement;
      overlay?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      await wait();
      out.overlayClickCloses = Boolean(overlay) && !dialog();
      document.querySelector('[aria-label="Open sidebar"]').click();
      await wait();
      return out;
    })()`) as Record<string, boolean>;
    for (const [k, v] of Object.entries(r)) if (!v) throw new Error(`${k} failed: ${JSON.stringify(r)}`);
  });

  // One reading column: prose, code blocks, tables and the composer share both edges (up to
  // 960px), in wide and narrow zoomed windows, with and without the transcript's scrollbar. Code
  // longer than the column scrolls inside its block, never the transcript. The probe uses the
  // markup StreamingMarkdown renders (direct pre/table children; tests/rich-markdown-renderer.test.ts).
  await check("one reading column: prose, code, tables and composer share both edges", async () => {
    if (!win) throw new Error("no renderer window");
    const [w0, h0] = win.getSize();
    const results: string[] = [];
    try {
      for (const size of [{ w: 1600, h: 900, zoom: 1 }, { w: 900, h: 1100, zoom: 1.44 }]) {
        win.setSize(size.w, size.h);
        win.webContents.setZoomFactor(size.zoom);
        await sleep(500);
        for (const tall of [false, true]) {
          const r = await win.webContents.executeJavaScript(`(() => {
            const scroller = document.querySelector('main [data-transcript-scroller]');
            const probe = document.createElement('div');
            probe.className = 'markdown';
            probe.innerHTML = '<p>Short reply.</p><pre><code>short</code></pre><pre><code class="language-yaml">' + 'x'.repeat(400) + '</code></pre><table><tr>' + '<td>cell</td>'.repeat(3) + '</tr></table>' + (${tall} ? '<div style="height:3000px"></div>' : '');
            scroller.firstElementChild.appendChild(probe);
            const edge = (el) => { const b = el.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.right)]; };
            const pres = probe.querySelectorAll('pre');
            const composer = document.querySelector('.shadow-composer');
            const out = {
              prose: edge(probe), short: edge(pres[0]), long: edge(pres[1]), table: edge(probe.querySelector('table')),
              composer: composer ? edge(composer) : null,
              scrollbar: scroller.scrollHeight > scroller.clientHeight,
              longScrolls: pres[1].scrollWidth > pres[1].clientWidth + 1,
              transcriptScrolls: scroller.scrollWidth > scroller.clientWidth + 1,
              page: document.documentElement.scrollWidth > innerWidth,
            };
            probe.remove();
            return out;
          })()`) as { prose: number[]; short: number[]; long: number[]; table: number[]; composer: number[] | null; scrollbar: boolean; longScrolls: boolean; transcriptScrolls: boolean; page: boolean };
          const where = `${size.w}px @${size.zoom}x, ${tall ? "with" : "without"} scrollbar`;
          if (r.scrollbar !== tall) throw new Error(`${where}: scrollbar state ${r.scrollbar}`);
          if (!r.composer) throw new Error(`${where}: composer missing`);
          const width = r.prose[1]! - r.prose[0]!;
          if (width > 961) throw new Error(`${where}: column ${width}px > 960`);
          for (const k of ["short", "long", "table", "composer"] as const) {
            const e = r[k]!;
            if (Math.abs(e[0]! - r.prose[0]!) > 1 || Math.abs(e[1]! - r.prose[1]!) > 1) throw new Error(`${where}: ${k} edges ${e} differ from the column ${r.prose}`);
          }
          if (!r.longScrolls || r.transcriptScrolls || r.page) throw new Error(`${where}: long code must scroll inside its block only: ${JSON.stringify(r)}`);
          results.push(`${where}: ${width}px`);
        }
      }
      return results.join("; ");
    } finally {
      win.webContents.setZoomFactor(1);
      win.setSize(w0!, h0!);
    }
  });

  // Layout in a narrow, zoomed window (the minimum window width at 144% zoom): nothing scrolls
  // sideways, the sidebar shares one edge and one text line, the composer's actions stay on one
  // row, and the Changes panel overlays the transcript instead of squeezing it.
  await check("narrow zoomed layout: alignment, no sideways scroll, composer row, changes overlay", async () => {
    if (!win) throw new Error("no renderer window");
    const js = <T,>(expr: string) => win!.webContents.executeJavaScript(expr) as Promise<T>;
    const [w0, h0] = win.getSize();
    win.setSize(900, 700);
    win.webContents.setZoomFactor(1.44);
    await sleep(500);
    try {
      // Wide content in a reply: a table and an unbreakable inline code span.
      const overflow = await js<{ doc: number; iw: number; scroller: number[]; table: number[] }>(`(() => {
        const scroller = document.querySelector('main .overflow-y-auto');
        const probe = document.createElement('div');
        probe.className = 'markdown';
        probe.innerHTML = '<table><tr>' + '<td>column_with_a_long_header</td>'.repeat(20) + '</tr></table><p><code>' + 'x'.repeat(400) + '</code> https://example.com/' + 'a'.repeat(300) + '</p>';
        (scroller.firstElementChild ?? scroller).appendChild(probe);
        const out = { doc: document.documentElement.scrollWidth, iw: innerWidth, scroller: [scroller.clientWidth, scroller.scrollWidth], table: [probe.querySelector('table').clientWidth, probe.querySelector('table').scrollWidth] };
        probe.remove();
        return out;
      })()`);
      if (overflow.doc > overflow.iw) throw new Error(`page scrolls sideways: ${JSON.stringify(overflow)}`);
      if (overflow.scroller[1]! > overflow.scroller[0]! + 1) throw new Error(`transcript scrolls sideways: ${JSON.stringify(overflow)}`);
      if (overflow.table[1]! <= overflow.table[0]!) throw new Error(`wide table should scroll inside itself: ${JSON.stringify(overflow)}`);

      const align = await js<{ boxes: number[]; texts: number[]; title: number }>(`(() => {
        const aside = document.querySelector('aside');
        const open = [...aside.querySelectorAll('button')].find((b) => b.textContent.includes('Open project'));
        const rows = [...aside.querySelectorAll('.group.rounded-md')];
        const eyebrow = [...aside.querySelectorAll('div')].find((d) => d.textContent === 'Projects');
        const brand = aside.querySelector('.font-semibold');
        const textLeft = (el) => { const r = document.createRange(); r.selectNodeContents(el); return Math.round(r.getBoundingClientRect().left); };
        return {
          boxes: [open, ...rows].map((el) => Math.round(el.getBoundingClientRect().left)),
          // A row's first glyph (Chats leads with its icon) sits on the same line as the labels above.
          texts: [textLeft(brand), textLeft(eyebrow), ...rows.map((r) => Math.round(r.querySelector('button').firstElementChild.getBoundingClientRect().left))],
          title: document.querySelector('header .truncate')?.getBoundingClientRect().width ?? -1,
        };
      })()`);
      if (new Set(align.boxes).size !== 1) throw new Error(`sidebar box edges differ: ${align.boxes}`);
      if (Math.max(...align.texts) - Math.min(...align.texts) > 2) throw new Error(`sidebar text lines differ: ${align.texts}`);
      if (align.title !== -1 && align.title < 100) throw new Error(`session title squeezed to ${align.title}px`);

      const composer = await js<{ tops: number[] }>(`(() => {
        const footer = document.querySelector('.shadow-composer > div:last-child');
        const actions = footer ? [...footer.querySelectorAll(':scope > div > button')] : [];
        return { tops: actions.map((b) => { const r = b.getBoundingClientRect(); return Math.round(r.top + r.height / 2); }) };
      })()`);
      if (composer.tops.length === 0) throw new Error("composer actions not found");
      if (Math.max(...composer.tops) - Math.min(...composer.tops) > 2) throw new Error(`composer actions split across rows (centers ${composer.tops})`);

      const panel = await js<{ position: string; transcript: number } | null>(`(async () => {
        const toggle = [...document.querySelectorAll('header button')].find((b) => b.textContent.trim() === 'Changes');
        if (!toggle) return null;
        if (toggle.getAttribute('aria-pressed') !== 'true') toggle.click();
        await new Promise((r) => setTimeout(r, 200));
        const aside = [...document.querySelectorAll('aside')].find((a) => a.textContent.includes('Changes') && a !== document.querySelector('aside'));
        const out = { position: aside ? getComputedStyle(aside).position : 'missing', transcript: document.querySelector('main .overflow-y-auto').clientWidth };
        toggle.click();
        return out;
      })()`);
      if (!panel) throw new Error("Changes toggle not found");
      if (panel.position !== "absolute") throw new Error(`changes panel should overlay when narrow: ${JSON.stringify(panel)}`);
      return `doc ${overflow.doc}/${overflow.iw}px, sidebar edge ${align.boxes[0]}px, text ${align.texts[0]}px`;
    } finally {
      win.webContents.setZoomFactor(1);
      win.setSize(w0!, h0!);
    }
  });

  // General chat: Peer's own Chats workspace exists, cannot be removed, and a real runtime
  // session starts there.
  await check("general chat: Chats workspace, protected, real session starts in it", async () => {
    const all = await api<Workspace[]>("/workspaces");
    const chats = all.filter((w) => w.general);
    if (chats.length !== 1) throw new Error(`expected one Chats workspace, got ${chats.length}`);
    const res = await fetch(`${peer.url}/api/workspaces/${chats[0]!.id}`, { method: "DELETE", headers: { authorization: `Bearer ${peer.token}` } });
    if (res.status !== 400) throw new Error(`removing Chats should be refused, got ${res.status}`);
    const chat = await api<PeerSession>(`/workspaces/${chats[0]!.id}/sessions`, { method: "POST", body: JSON.stringify({ mode: "learn", runtime: "opencode" }) });
    if (!chat.runtimeSessionId) throw new Error("no runtime session");
    if (!existsSync(chats[0]!.path)) throw new Error(`chats folder missing: ${chats[0]!.path}`);
    return chats[0]!.path;
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
