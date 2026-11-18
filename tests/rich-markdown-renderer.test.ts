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

  it("draws a mermaid block as soon as its closing fence arrives, while the reply streams on", async () => {
    // The fence is still open: its source is partial, so a placeholder stands in for it.
    await show("Here is the flow:\n\n```mermaid\nflowchart LR\n  A[request] --> B", true);
    await advance(1500);
    await flush();
    expect(render).not.toHaveBeenCalled();
    expect(host.querySelector("code.language-mermaid")).toBeNull();
    expect(host.querySelector(".render-pending")?.textContent).toBe("Drawing diagram…");
    expect(host.textContent).not.toContain("flowchart");

    // The fence closes and more prose streams after it: the diagram draws now, mid-reply.
    await show(`${DIAGRAM}\nNext, the cache`, true);
    await advance(1500);
    await flush();
    expect(render).toHaveBeenCalledTimes(1);
    expect(render.mock.calls[0]![1]).toBe("flowchart LR\n  A[request] --> B[cache]");
    expect(host.querySelector(".mermaid-diagram svg")).not.toBeNull();
    expect(host.querySelector(".streaming")).not.toBeNull();

    // The reply finishes: the diagram on screen is not drawn again.
    await show(`${DIAGRAM}\nNext, the cache layer.`, false);
    await flush();
    expect(render).toHaveBeenCalledTimes(1);
    expect(host.querySelector(".mermaid-diagram svg")).not.toBeNull();
  });

  it("a closed diagram inside a blockquote or a list item also draws while the reply streams", async () => {
    await show("> ```mermaid\n> flowchart LR\n> A --> B\n> ```\n\nStill writing", true);
    await advance(1500);
    await flush();
    expect(render).toHaveBeenCalledTimes(1);
    await show("- Step one:\n\n  ```mermaid\n  flowchart LR\n  C --> D\n  ```\n\nStill writing", true);
    await advance(1500);
    await flush();
    expect(render).toHaveBeenCalledTimes(2);
    // Still open inside the quote: a placeholder, not a diagram.
    await show("> ```mermaid\n> flowchart LR\n> E --> F", true);
    await advance(1500);
    await flush();
    expect(render).toHaveBeenCalledTimes(2);
    // An unfinished top-level block whose content has a line that only looks like a quoted fence.
    await show("```mermaid\nflowchart LR\nG --> H\n> ```", true);
    await advance(1500);
    await flush();
    expect(render).toHaveBeenCalledTimes(2);
    expect(host.querySelector(".render-pending")).not.toBeNull();
    // Closed with nothing after it yet (the stream stopped right at the fence).
    await show("```mermaid\nflowchart LR\nI --> J\n```", true);
    await advance(1500);
    await flush();
    expect(render).toHaveBeenCalledTimes(3);
    // Carriage-return line endings, alone or with newlines.
    await show("```mermaid\rflowchart LR\rK --> L\r```\r\rStill writing", true);
    await advance(1500);
    await flush();
    expect(render).toHaveBeenCalledTimes(4);
    await show("```mermaid\r\nflowchart LR\r\nM --> N\r\n```\r\n\r\nStill writing", true);
    await advance(1500);
    await flush();
    expect(render).toHaveBeenCalledTimes(5);
  });

  it("holds an unfinished $$ block while the reply streams, then typesets it whole", async () => {
    await show("The sum:\n\n$$\n\\sum_{i=1}^{n} i = \\frac{n(n+1)", true);
    await advance(1500);
    expect(host.querySelector(".katex")).toBeNull();
    expect(host.querySelector(".render-pending")?.textContent).toBe("Typesetting formula…");
    expect(host.textContent).not.toContain("\\sum");

    await show("The sum:\n\n$$\n\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n$$\n\nThen more", true);
    await advance(1500);
    expect(host.querySelector(".render-pending")).toBeNull();
    expect(host.querySelector(".katex-display")).not.toBeNull();
  });

  it("an opening $$ with the formula on the same line is held too", async () => {
    await show("Intro\n\n$$ x^2 + y", true);
    await advance(1500);
    expect(host.querySelector(".render-pending")).not.toBeNull();
    await show("Intro\n\n$$ x^2 + y^2 $$", true);
    await advance(1500);
    expect(host.querySelector(".render-pending")).toBeNull();
    expect(host.querySelector(".katex-display")).not.toBeNull();
  });

  it("keeps back an unfinished inline formula at the end of the text, not the prose before it", async () => {
    await show("The cost is $\\frac{a}{b", true);
    await advance(1500);
    expect(host.textContent).toContain("The cost is");
    expect(host.textContent).not.toContain("$");
    expect(host.textContent).not.toContain("frac");

    await show("The cost is $\\frac{a}{b}$ per call", true);
    await advance(1500);
    expect(host.querySelector(".katex")).not.toBeNull();
    expect(host.textContent).toContain("per call");
  });

  it("a closed block whose last content line is blank renders while the reply streams", async () => {
    await show("```mermaid\nflowchart LR\nA --> B\n\n```\n\nContinuing", true);
    await advance(1500);
    await flush();
    expect(host.querySelector(".render-pending")).toBeNull();
    expect(render).toHaveBeenCalledTimes(1);
    await show("$$\nx^2\n\n$$\n\nContinuing", true);
    await advance(1500);
    expect(host.querySelector(".render-pending")).toBeNull();
    expect(host.querySelector(".katex-display")).not.toBeNull();
  });

  it("holds an unfinished formula inside bold or a link too", async () => {
    await show("The result is **$\\frac{a}{b**", true);
    await advance(1500);
    expect(host.textContent).toContain("The result is");
    expect(host.textContent).not.toContain("frac");
    await show("See [the $\\alpha", true);
    await advance(1500);
    expect(host.textContent).not.toContain("alpha");
  });

  it("an escaped dollar is a literal: the prose after it keeps streaming", async () => {
    await show("Use \\$HOME for your home directory", true);
    await advance(1500);
    expect(host.textContent).toContain("$HOME for your home directory");
    await show("Use &#36;HOME, then $\\alpha", true);
    await advance(1500);
    expect(host.textContent).toContain("$HOME, then");
    expect(host.textContent).not.toContain("alpha");
    await show("Set \\$PATH, then $\\beta", true);
    await advance(1500);
    expect(host.textContent).toContain("$PATH, then");
    expect(host.textContent).not.toContain("beta");
  });

  it("a single CRLF line ending does not end the paragraph; two do", async () => {
    await show("Compute $\\frac{a}{b\r\n", true);
    await advance(1500);
    expect(host.textContent).not.toContain("frac");
    await show("A lone $x here.\r\n\r\n", true);
    await advance(1500);
    expect(host.textContent).toContain("$x here.");
  });

  it("does not hold prices, a paragraph that has ended, or a finished reply", async () => {
    await show("A lone $x here.\n\n", true);
    await advance(1500);
    expect(host.textContent).toContain("$x here.");
    await show("> Quoted $x here.\n>\n", true);
    await advance(1500);
    expect(host.textContent).toContain("$x here.");
    await show("It costs $5 a month", true);
    await advance(1500);
    expect(host.textContent).toContain("$5 a month");
    await show("A lone $x here.\n\nNext paragraph", true);
    await advance(1500);
    expect(host.textContent).toContain("$x here.");
    await show("Unclosed $\\alpha at the end", false);
    expect(host.textContent).toContain("$\\alpha at the end");
    await show("```mermaid\nflowchart LR\nA --> B", false);
    await flush();
    expect(host.querySelector(".render-pending")).toBeNull();
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
