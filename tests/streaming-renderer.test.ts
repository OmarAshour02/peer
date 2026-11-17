// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamingMarkdown, useSmoothText } from "../src/renderer/components/StreamingMarkdown.js";

let frames: Map<number, FrameRequestCallback>;
let clock: number;
let host: HTMLDivElement;
let root: Root;
let reducedMotion: boolean;

beforeEach(() => {
  frames = new Map();
  clock = 0;
  reducedMotion = false;
  let id = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.set(++id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (n: number) => frames.delete(n));
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: reducedMotion && q.includes("reduce"), addEventListener() {}, removeEventListener() {} }));
  host = document.createElement("div");
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Run pending animation frames, advancing the clock 16 ms per frame. */
async function advance(ms: number) {
  await act(async () => {
    for (let t = 0; t < ms; t += 16) {
      clock += 16;
      const due = [...frames.entries()];
      frames.clear();
      for (const [, cb] of due) cb(clock);
    }
  });
}

function Probe({ text, live }: { text: string; live: boolean }) {
  return createElement("div", null, useSmoothText(text, live).visible);
}
const render = (text: string, live: boolean) => act(async () => root.render(createElement(Probe, { text, live })));

describe("streaming text (renderer)", () => {
  it("a completed message renders in full at once, with no animation", async () => {
    const text = "Already done. ".repeat(20);
    await render(text, false);
    expect(host.textContent).toBe(text);
    expect(frames.size).toBe(0);
  });

  it("a live message reveals progressively, then completely", async () => {
    const text = "Streaming words arrive here. ".repeat(20);
    await render(text, true);
    expect(host.textContent).toBe("");
    await advance(100);
    const partial = host.textContent!.length;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(text.length);
    await advance(3000);
    expect(host.textContent).toBe(text);
  });

  it("keeps going when a chunk arrives in the same batch as the frame that caught up", async () => {
    await render("hello ", true);
    await act(async () => {
      clock += 100;
      const due = [...frames.values()];
      frames.clear();
      for (const cb of due) cb(clock);
      root.render(createElement(Probe, { text: "hello world from the next chunk ", live: true }));
    });
    expect(frames.size).toBeGreaterThan(0);
    await advance(2000);
    expect(host.textContent).toBe("hello world from the next chunk ");
  });

  it("keeps painting while chunks arrive every frame", async () => {
    let text = "word ".repeat(100);
    await render(text, true);
    let sawPartial = false;
    for (let i = 0; i < 120; i++) {
      await advance(16);
      text += "word ";
      await render(text, true);
      const visible = host.textContent!.length;
      if (visible > 0 && visible < text.length) sawPartial = true;
      // Never more than about half a second (plus a frame) behind a steady 300 chars/s stream.
      if (i > 60) expect(text.length - visible).toBeLessThan(300 * 0.6 + 20);
    }
    expect(sawPartial).toBe(true);
    // One loop at a time: chunks never stack up extra frames.
    expect(frames.size).toBeLessThanOrEqual(1);
  });

  it("a live turn opened mid-way shows its text at once, and only new text fades in", async () => {
    // e.g. reloading while the turn waits on a checkpoint: the part is live but not fresh.
    const before = "Already written while you were away.";
    await act(async () => root.render(createElement(StreamingMarkdown, { text: before, live: true, fromStart: false })));
    expect(host.textContent).toBe(before);
    expect(host.querySelectorAll(".stream-word")).toHaveLength(0);
    expect(frames.size).toBe(0);

    await act(async () => root.render(createElement(StreamingMarkdown, { text: `${before} And then more arrives.`, live: true, fromStart: false })));
    await advance(1000);
    expect(host.textContent).toBe(`${before} And then more arrives.`);
    expect([...host.querySelectorAll(".stream-word")].map((n) => n.textContent)).toEqual(["And", "then", "more", "arrives."]);
  });

  it("escapes, entities and markdown completed later don't shift which words are new", async () => {
    const cases: [string, string][] = [
      ["A &amp; B.", " New words."],
      ["Use \\*literal\\* stars.", " New words."],
      ["Tom &lt;3 &quot;quotes&quot;", " New words."],
      // Markdown that completes after the part was opened: the closing markup arrives later.
      ["Use `some code", "` New words."],
      ["Run `npm install` then `npm", " test` New words."],
      ["Some **bold", "** New words."],
      ["See [the docs", "](https://x.dev) New words."],
    ];
    for (const [before, after] of cases) {
      await act(async () => root.render(createElement(StreamingMarkdown, { key: before, text: before, live: true, fromStart: false })));
      await act(async () => root.render(createElement(StreamingMarkdown, { key: before, text: before + after, live: true, fromStart: false })));
      await advance(1000);
      expect([...host.querySelectorAll(".stream-word")].map((n) => n.textContent)).toEqual(["New", "words."]);
    }
  });

  it("leaving a busy session and coming back shows its text at once", async () => {
    const { usePeer } = await import("../src/renderer/store.js");
    const { Transcript } = await import("../src/renderer/components/Transcript.js");
    Element.prototype.scrollIntoView = () => {};
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const snapshot = { session: { id: "reopen", mode: "collaborate", runtime: "codex" }, status: "busy", checkpoints: [], permissions: [], lastError: null } as never;
    const text = "Already streamed before switching away.";
    const messages = [{ id: "m-reopen", role: "assistant", createdAt: 1, parts: [{ type: "text", id: "p-reopen", text }] }] as never;
    usePeer.setState({ activeSessionId: "reopen", snapshot, messages: [] });
    // Arrived live while the session was open: it is fresh for this viewing.
    usePeer.getState().handleEvent({ type: "part.updated", sessionId: "reopen", messageId: "m-reopen", part: { type: "text", id: "p-reopen", text } });
    await act(async () => root.render(createElement(Transcript)));
    usePeer.setState({ modelsFor: "codex", api: { setPreferences: async () => ({}), snapshot: async () => snapshot, messages: async () => messages, diff: async () => [] } as never });
    await act(async () => usePeer.getState().selectSession(null));
    await act(async () => usePeer.getState().selectSession("reopen"));
    expect(host.querySelector(".markdown")?.textContent).toBe(text);
    expect(host.querySelectorAll(".stream-word")).toHaveLength(0);
  });

  it("reduced motion shows live text in full", async () => {
    reducedMotion = true;
    await render("No animation please. ".repeat(5), true);
    expect(host.textContent).toBe("No animation please. ".repeat(5));
  });

  it("wraps words in fading spans while streaming, and drops them once caught up", async () => {
    await act(async () => root.render(createElement(StreamingMarkdown, { text: "Some **bold** text and `code here`", live: true })));
    await advance(1500);
    const words = [...host.querySelectorAll(".stream-word")].map((n) => n.textContent);
    expect(words).toEqual(["Some", "bold", "text", "and"]);
    expect(host.querySelector("code .stream-word")).toBeNull();
    expect(host.firstElementChild!.className).toContain("streaming");

    await act(async () => root.render(createElement(StreamingMarkdown, { text: "Some **bold** text and `code here`", live: false })));
    expect(host.querySelectorAll(".stream-word")).toHaveLength(0);
    expect(host.firstElementChild!.className).not.toContain("streaming");
    expect(host.textContent).toBe("Some bold text and code here");
  });

  it("word spans already on screen stay mounted as text grows, so they fade in only once", async () => {
    await act(async () => root.render(createElement(StreamingMarkdown, { text: "first second ", live: true })));
    await advance(500);
    const first = host.querySelector(".stream-word");
    await act(async () => root.render(createElement(StreamingMarkdown, { text: "first second third fourth ", live: true })));
    await advance(500);
    expect(host.querySelector(".stream-word")).toBe(first);
    expect(host.querySelectorAll(".stream-word")).toHaveLength(4);
  });
});

describe("transcript scroll while a reply streams", () => {
  const H = { scroll: 5000, client: 400 };
  async function mountTranscript(sessionId = "ps_1") {
    Element.prototype.scrollIntoView = () => {};
    const observers: (() => void)[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private cb: () => void) {
          observers.push(() => this.cb());
        }
        observe() {}
        disconnect() {}
      },
    );
    H.scroll = 5000;
    const { usePeer } = await import("../src/renderer/store.js");
    const { Transcript } = await import("../src/renderer/components/Transcript.js");
    const setSession = async (id: string, userMessages = 0) =>
      act(async () =>
        usePeer.setState({
          snapshot: { session: { id, mode: "collaborate" }, status: "busy", checkpoints: [], permissions: [], lastError: null } as never,
          messages: [
            ...Array.from({ length: userMessages }, (_, i) => ({ id: `u${i}`, role: "user" as const, createdAt: i, parts: [{ type: "text" as const, id: `u${i}p`, text: "go" }] })),
            { id: "m1", role: "assistant", createdAt: 100, parts: [{ type: "text", id: "p1", text: "Hello there. ".repeat(30) }] },
          ],
        }),
      );
    // jsdom has no layout: give the scroller a size, and clamp scrollTop like a browser does.
    let top = 0;
    const proto = HTMLDivElement.prototype;
    vi.spyOn(proto, "scrollHeight", "get").mockImplementation(() => H.scroll);
    vi.spyOn(proto, "clientHeight", "get").mockImplementation(() => H.client);
    vi.spyOn(proto, "scrollTop", "get").mockImplementation(() => top);
    vi.spyOn(proto, "scrollTop", "set").mockImplementation((v: number) => {
      top = Math.max(0, Math.min(v, H.scroll - H.client));
    });
    await setSession(sessionId);
    await act(async () => root.render(createElement(Transcript)));
    const scroller = host.querySelector<HTMLDivElement>("[data-transcript-scroller]")!;
    const user = async (dy: number) =>
      act(async () => {
        scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: dy, bubbles: true }));
        scroller.scrollTop = scroller.scrollTop + dy;
        scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      });
    const grow = async (by: number) =>
      act(async () => {
        H.scroll += by;
        observers.forEach((o) => o());
      });
    return { scroller, user, grow, setSession, usePeer, jump: () => host.querySelector<HTMLButtonElement>(".jump-latest") };
  }

  it("opens a session at its end", async () => {
    const { scroller } = await mountTranscript();
    expect(scroller.scrollTop).toBe(H.scroll - H.client);
  });

  it("follows streamed text while the developer is at the end", async () => {
    const { scroller, grow } = await mountTranscript();
    await grow(300);
    expect(scroller.scrollTop).toBe(H.scroll - H.client);
  });

  it("a small trackpad step up lets go at once, and streaming no longer pulls it back", async () => {
    const { scroller, user, grow, jump } = await mountTranscript();
    await user(-3);
    const at = scroller.scrollTop;
    await grow(200);
    await grow(200);
    expect(scroller.scrollTop).toBe(at);
    expect(jump()).not.toBeNull();
  });

  it("scrolling back down to the end follows again and hides the jump button", async () => {
    const { scroller, user, grow, jump } = await mountTranscript();
    await user(-300);
    await user(400);
    expect(jump()).toBeNull();
    await grow(200);
    expect(scroller.scrollTop).toBe(H.scroll - H.client);
  });

  it("content shrinking (no developer input) does not unpin", async () => {
    const { scroller, grow, jump } = await mountTranscript();
    await act(async () => {
      H.scroll -= 300;
      scroller.scrollTop = scroller.scrollTop; // the browser clamps
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(jump()).toBeNull();
    await grow(500);
    expect(scroller.scrollTop).toBe(H.scroll - H.client);
  });

  it("content that shrinks to the end while scrolled up hides the jump button and follows again", async () => {
    const { scroller, user, grow, jump } = await mountTranscript();
    await user(-300);
    expect(jump()).not.toBeNull();
    // The reply finishes: "Working…" goes, a diagram replaces its source. The browser clamps the
    // scroll position to the new end; the developer is at the bottom without scrolling down.
    await act(async () => {
      H.scroll -= 400;
      scroller.scrollTop = scroller.scrollTop;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(jump()).toBeNull();
    await grow(200);
    expect(scroller.scrollTop).toBe(H.scroll - H.client);
  });

  it("a shrink with no scroll event (seen only as a resize) also hides the button", async () => {
    const { scroller, user, grow, jump } = await mountTranscript();
    await user(-300);
    await act(async () => {
      H.scroll -= 400;
      scroller.scrollTop = scroller.scrollTop;
    });
    await grow(0);
    expect(jump()).toBeNull();
  });

  it("Jump to latest returns to the end and follows again", async () => {
    const { scroller, user, grow, jump } = await mountTranscript();
    await user(-500);
    await act(async () => jump()!.click());
    expect(scroller.scrollTop).toBe(H.scroll - H.client);
    await grow(200);
    expect(scroller.scrollTop).toBe(H.scroll - H.client);
  });

  it("switching sessions or sending a message returns to the end", async () => {
    const { scroller, user, setSession, jump } = await mountTranscript();
    await user(-800);
    await setSession("ps_2");
    expect(scroller.scrollTop).toBe(H.scroll - H.client);
    expect(jump()).toBeNull();
    await user(-800);
    await setSession("ps_2", 1);
    expect(scroller.scrollTop).toBe(H.scroll - H.client);
  });
});
