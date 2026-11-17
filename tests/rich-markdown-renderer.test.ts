// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const render = vi.fn(async (_id: string, source: string) => ({ svg: `<svg data-source="${source.length}"><text>diagram</text></svg>` }));
vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: (id: string, src: string) => render(id, src) } }));

const { StreamingMarkdown } = await import("../src/renderer/components/StreamingMarkdown.js");
const { CheckpointCard } = await import("../src/renderer/components/Interactions.js");
const { partIsLive } = await import("../src/renderer/components/Transcript.js");
import type { Checkpoint, PeerPart } from "../src/shared/types.js";

let frames: Map<number, FrameRequestCallback>;
let clock: number;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  frames = new Map();
  clock = 0;
  let id = 0;
  render.mockClear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.set(++id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (n: number) => frames.delete(n));
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  host = document.createElement("div");
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
});

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

const show = (text: string, live = false) => act(async () => root.render(createElement(StreamingMarkdown, { text, live })));
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

const DIAGRAM = "Here is the flow:\n\n```mermaid\nflowchart LR\n  A[request] --> B[cache]\n```\n";

describe("rich markdown in agent replies", () => {
  it("typesets inline and display LaTeX", async () => {
    await show("Lookup is $O(\\log n)$ and\n\n$$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$\n");
    expect(host.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(2);
    expect(host.querySelector(".katex-display")).not.toBeNull();
  });

  it("a malformed formula shows its source instead of breaking the reply", async () => {
    await show("Broken: $\\frac{1}{$ and the rest of the reply.");
    expect(host.textContent).toContain("and the rest of the reply.");
  });

  it("does not wrap typeset math in fading word spans while streaming", async () => {
    await show("The cost is $a + b$ per call, then more words arrive", true);
    await advance(1500);
    expect(host.querySelector(".katex")).not.toBeNull();
    expect(host.querySelector(".katex .stream-word")).toBeNull();
  });

  it("draws a mermaid block once the reply is complete, not while it streams", async () => {
    await show(DIAGRAM, true);
    await advance(1500);
    await flush();
    expect(render).not.toHaveBeenCalled();
    expect(host.querySelector("code.language-mermaid")).not.toBeNull();

    await show(DIAGRAM, false);
    await flush();
    expect(render).toHaveBeenCalledTimes(1);
    expect(render.mock.calls[0]![1]).toBe("flowchart LR\n  A[request] --> B[cache]");
    expect(host.querySelector(".mermaid-diagram svg")).not.toBeNull();
  });

  it("falls back to the source when a diagram does not parse", async () => {
    render.mockRejectedValueOnce(new Error("Parse error"));
    await show("```mermaid\nnot a diagram\n```\n");
    await flush();
    expect(host.querySelector(".mermaid-diagram")).toBeNull();
    expect(host.querySelector("pre.mermaid-failed code")?.textContent).toBe("not a diagram");
  });

  it("re-renders a diagram on screen when the display theme changes", async () => {
    await show(DIAGRAM);
    await flush();
    expect(render).toHaveBeenCalledTimes(1);
    await act(async () => {
      document.documentElement.dataset.theme = "light";
    });
    await flush();
    expect(render).toHaveBeenCalledTimes(2);
    expect(host.querySelector(".mermaid-diagram svg")).not.toBeNull();
  });

  it("a checkpoint's context renders math and diagrams too", async () => {
    const checkpoint: Checkpoint = {
      id: "cp-rich", sessionId: "s", turnId: null, category: "hypothesis", source: "agent", decision: null,
      question: "Why does the cache miss?", context: `Each lookup costs $O(n)$ today.\n\n${DIAGRAM}`,
      options: [], recommendation: null, status: "pending", resolution: null, createdAt: 1, resolvedAt: null,
    };
    await act(async () => root.render(createElement(CheckpointCard, { checkpoint, mode: "learn" })));
    await flush();
    expect(host.querySelector(".katex")).not.toBeNull();
    expect(host.querySelector(".mermaid-diagram svg")).not.toBeNull();
  });

  it("code blocks and tables are direct children of the reply, so they share the text column's edges", async () => {
    await show("Text.\n\n```yaml\nkey: value\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
    const md = host.firstElementChild!;
    expect(md.querySelector(":scope > pre > code.language-yaml")).not.toBeNull();
    expect(md.querySelector(":scope > table")).not.toBeNull();
  });

  it("text the agent has moved past is final: its diagram renders while the turn waits on a checkpoint", async () => {
    const parts: PeerPart[] = [
      { type: "text", id: "t1", text: DIAGRAM },
      { type: "tool", id: "c1", tool: "peer_checkpoint", callId: "x", status: "running", input: {} },
    ];
    expect(partIsLive(parts, 0, true)).toBe(false);
    expect(partIsLive(parts, 1, true)).toBe(true);
    expect(partIsLive(parts, 1, false)).toBe(false);
    await show(DIAGRAM, partIsLive(parts, 0, true));
    await flush();
    expect(render).toHaveBeenCalledTimes(1);
    expect(host.querySelector(".mermaid-diagram svg")).not.toBeNull();
  });

  it("a checkpoint question with a code block renders the block, not a line of backticks", async () => {
    const checkpoint: Checkpoint = {
      id: "cp-code", sessionId: "s", turnId: null, category: "hypothesis", source: "agent", decision: null,
      question: "Why does this alert flap?\n\n```yaml\n- alert: HighErrorRate\n  expr: rate(http_requests_errors_total[1m]) > 10\n  for: 5m\n```",
      context: null, options: [], recommendation: null, status: "pending", resolution: null, createdAt: 1, resolvedAt: null,
    };
    await act(async () => root.render(createElement(CheckpointCard, { checkpoint, mode: "learn" })));
    const q = host.querySelector(".checkpoint-question")!;
    expect(q.querySelector("p")?.textContent).toBe("Why does this alert flap?");
    expect(q.querySelector("pre > code.language-yaml")?.textContent).toBe("- alert: HighErrorRate\n  expr: rate(http_requests_errors_total[1m]) > 10\n  for: 5m\n");
    expect(q.textContent).not.toContain("```");
  });

  it("leaves other code blocks as code", async () => {
    await show("```ts\nconst x = 1;\n```\n");
    await flush();
    expect(render).not.toHaveBeenCalled();
    expect(host.querySelector("pre code.language-ts")?.textContent).toBe("const x = 1;\n");
  });
});
