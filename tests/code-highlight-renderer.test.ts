// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamingMarkdown } from "../src/renderer/components/StreamingMarkdown.js";

describe("code blocks", () => {
  beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
  afterEach(() => vi.unstubAllGlobals());

  const render = async (text: string) => {
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(createElement(StreamingMarkdown, { text, live: false })));
    return { host, unmount: () => act(async () => root.unmount()) };
  };

  it("colors code that names its language, keeping its text", async () => {
    const source = 'const answer: number = 42; // the answer\nfunction f() { return "x"; }';
    const { host, unmount } = await render("```ts\n" + source + "\n```");
    const code = host.querySelector("pre code")!;
    expect(code.querySelector(".hljs-keyword")?.textContent).toBe("const");
    expect(code.querySelector(".hljs-number")?.textContent).toBe("42");
    expect(code.querySelector(".hljs-comment")?.textContent).toBe("// the answer");
    expect(code.querySelector(".hljs-string")?.textContent).toBe('"x"');
    expect(code.textContent).toBe(source + "\n");
    await unmount();
  });

  it("leaves untagged and unknown languages plain, without failing", async () => {
    const { host, unmount } = await render("```\nplain text\n```\n\n```notalanguage\nstill fine\n```\n\nInline `code` too.");
    expect(host.querySelectorAll("pre code")).toHaveLength(2);
    expect(host.querySelector("[class*='hljs-']")).toBeNull();
    expect(host.textContent).toContain("still fine");
    await unmount();
  });
});
