// @vitest-environment jsdom
// The real Mermaid library (the renderer tests mock it): strict security, theme tokens, and no
// stray nodes left on the page when a diagram does not parse.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { readableLabels, renderMermaid } from "../src/renderer/components/MermaidDiagram.js";

beforeAll(() => {
  // jsdom has no layout; Mermaid measures labels with getBBox.
  Object.defineProperty(SVGElement.prototype, "getBBox", { configurable: true, value: () => ({ x: 0, y: 0, width: 100, height: 20 }) });
});

afterEach(() => {
  delete document.documentElement.dataset.theme;
  document.documentElement.style.removeProperty("--color-fg");
});

const strays = () => document.body.querySelectorAll('[id*="peer-mermaid-"]');

describe("Mermaid rendering (real library)", () => {
  it("renders with strict security and the current theme's colors", async () => {
    document.documentElement.style.setProperty("--color-fg", "#abcdef");
    const svg = await renderMermaid("flowchart LR\n  A[request] --> B[cache]");
    expect(svg).toContain("<svg");
    expect(svg).toContain("#abcdef");
    const mermaid = (await import("mermaid")).default;
    expect(mermaid.mermaidAPI.getConfig().securityLevel).toBe("strict");

    document.documentElement.dataset.theme = "light";
    document.documentElement.style.setProperty("--color-fg", "#123456");
    expect(await renderMermaid("flowchart LR\n  A --> B")).toContain("#123456");
    expect(strays()).toHaveLength(0);
  });

  it("a diagram that does not parse rejects and leaves nothing on the page", async () => {
    await expect(renderMermaid("not a diagram")).rejects.toBeDefined();
    expect(strays()).toHaveLength(0);
    expect(document.body.innerHTML).not.toContain("Syntax error");
    // The queue keeps working after a failure.
    expect(await renderMermaid("flowchart LR\n  A --> B")).toContain("<svg");
  });

  it("nodes the agent filled itself get text that reads on that fill, in either theme", async () => {
    document.documentElement.style.setProperty("--color-fg", "#e9eee7"); // dark theme text
    const svg = await renderMermaid("flowchart TD\n  A[\"pale\"]:::hit --> B[\"deep\"]:::deep --> C[\"themed\"]\n  classDef hit fill:#bfb\n  classDef deep fill:#123\n  classDef own fill:#bfb,color:#f00");
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    const label = (text: string) => [...doc.querySelectorAll("g.node")].find((n) => n.textContent?.includes(text))!;
    const styleOf = (n: Element) => [...n.querySelectorAll("span, p, div, text")].map((e) => e.getAttribute("style") ?? "").join(" ");
    expect(styleOf(label("pale"))).toContain("color:#1f2420");
    expect(styleOf(label("deep"))).toContain("color:#eef2ec");
    expect(styleOf(label("themed"))).not.toContain("#1f2420");
  });

  it("mid-tone fills get whichever text contrasts more", async () => {
    const svg = await renderMermaid("flowchart TD\n  A[\"gray\"]:::g --> B[\"teal\"]:::t --> C[\"slate\"]:::s\n  classDef g fill:#aaa\n  classDef t fill:#2a7f7f\n  classDef s fill:#556677");
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    const styleOf = (text: string) =>
      [...[...doc.querySelectorAll("g.node")].find((n) => n.textContent?.includes(text))!.querySelectorAll("span, p, div, text")].map((e) => e.getAttribute("style") ?? "").join(" ");
    // #aaa: dark text 6.8:1 vs light 2.1:1. #2a7f7f and #556677: light text contrasts more.
    expect(styleOf("gray")).toContain("color:#1f2420");
    expect(styleOf("teal")).toContain("color:#eef2ec");
    expect(styleOf("slate")).toContain("color:#eef2ec");
  });

  it("leaves SVG text that sets its own fill alone", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><g class="node"><rect style="fill:#bfb"/><text style="fill:#123456">Explicit</text></g><g class="node"><rect fill="#bfb"/><text fill="#654321">Attr</text></g></svg>';
    expect(readableLabels(svg)).toBe(svg);
  });

  it("leaves a node's own text color alone", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><g class="node"><rect style="fill:#bfb"/><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel" style="color:#f00">own</span></div></foreignObject></g></svg>';
    expect(readableLabels(svg)).toBe(svg);
  });
});
