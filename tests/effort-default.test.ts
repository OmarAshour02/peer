// @vitest-environment jsdom
// The default effort, made visible: what "Default" resolves to (Runtime settings, the CLI's own
// configuration, the model's default), and the composer pill naming that level.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EffortSlider } from "../src/renderer/components/EffortSlider.js";
import { effortDefaultHint } from "../src/renderer/components/Composer.js";
import { canonicalClaudeModel, claudeConfigEffort, claudeEffortConfig, codexConfigEffort, resolveEffortDefault } from "../src/server/effort-default.js";
import { codexModelOption } from "../src/server/runtime/codex/adapter.js";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "peer-effort-default-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};

describe("resolving the default effort", () => {
  it("Claude Code: project local, then project, then user settings; a per-model level wins in each", () => {
    const home = join(dir, "home");
    const project = join(dir, "project");
    const env = { HOME: home };
    expect(claudeConfigEffort(project, "opus", env)).toBeNull();
    write(join(home, ".claude", "settings.json"), JSON.stringify({ effortLevel: "medium", modelSettings: { opus: { effortLevel: "high" } } }));
    expect(claudeConfigEffort(project, "sonnet", env)).toBe("medium");
    expect(claudeConfigEffort(project, "opus", env)).toBe("high");
    write(join(project, ".claude", "settings.json"), JSON.stringify({ effortLevel: "low" }));
    expect(claudeConfigEffort(project, "opus", env)).toBe("low");
    write(join(project, ".claude", "settings.local.json"), JSON.stringify({ effortLevel: "max" }));
    expect(claudeConfigEffort(project, "opus", env)).toBe("max");
    // CLAUDE_CONFIG_DIR moves the user settings.
    write(join(dir, "alt", "settings.json"), JSON.stringify({ effortLevel: "xhigh" }));
    expect(claudeConfigEffort(join(dir, "elsewhere"), null, { HOME: home, CLAUDE_CONFIG_DIR: join(dir, "alt") })).toBe("xhigh");
  });

  it("Claude Code: per-model keys are canonical names and match dated, [1m], Bedrock and Vertex spellings (F1)", () => {
    for (const id of ["claude-sonnet-4-5-20250929", "claude-sonnet-4-5[1m]", "us.anthropic.claude-sonnet-4-5-20250929-v1:0", "claude-sonnet-4-5@20250929", "claude-sonnet-4-5"]) {
      expect(canonicalClaudeModel(id)).toBe("claude-sonnet-4-5");
    }
    const home = join(dir, "home");
    write(join(home, ".claude", "settings.json"), JSON.stringify({ effortLevel: "low", modelSettings: { "claude-sonnet-4-5": { effortLevel: "high" } } }));
    const env = { HOME: home };
    expect(claudeEffortConfig(join(dir, "p"), ["claude-sonnet-4-5-20250929"], env).level).toBe("high");
    // An alias matches through the canonical id it resolves to.
    expect(claudeEffortConfig(join(dir, "p"), ["sonnet", "claude-sonnet-4-5-20250929"], env).level).toBe("high");
    expect(claudeEffortConfig(join(dir, "p"), ["opus"], env).level).toBe("low");
  });

  it("Claude Code: maxEffortLevel caps the level, Runtime settings included; lowest cap across files, per-model replaces (F2)", () => {
    const home = join(dir, "home");
    const project = join(dir, "project");
    const env = { HOME: home };
    write(join(home, ".claude", "settings.json"), JSON.stringify({ effortLevel: "high", maxEffortLevel: "low" }));
    const c = claudeEffortConfig(project, ["claude-opus-5"], env);
    expect(c).toEqual({ level: "high", cap: "low" });
    expect(resolveEffortDefault({ cli: c.level, cap: c.cap })).toEqual({ level: "low", source: "cli", cappedFrom: "high" });
    expect(resolveEffortDefault({ settings: "xhigh", cli: c.level, cap: c.cap })).toEqual({ level: "low", source: "settings", cappedFrom: "xhigh" });
    // Lowest across files.
    write(join(project, ".claude", "settings.json"), JSON.stringify({ maxEffortLevel: "medium" }));
    expect(claudeEffortConfig(project, ["claude-opus-5"], env).cap).toBe("low");
    // Within a file, a per-model cap replaces the file's; "max" exempts the model from that file's cap.
    write(join(home, ".claude", "settings.json"), JSON.stringify({ maxEffortLevel: "low", modelSettings: { "claude-opus-5": { maxEffortLevel: "max" } } }));
    expect(claudeEffortConfig(project, ["claude-opus-5-20260101"], env).cap).toBe("medium");
    expect(claudeEffortConfig(project, ["claude-sonnet-5"], env).cap).toBe("low");
    // A level under the cap is untouched.
    expect(resolveEffortDefault({ cli: "low", cap: "medium" })).toEqual({ level: "low", source: "cli" });
  });

  it("Claude Code: CLAUDE_CODE_EFFORT_LEVEL overrides the files; 'unset' means none", () => {
    const home = join(dir, "home");
    write(join(home, ".claude", "settings.json"), JSON.stringify({ effortLevel: "low" }));
    expect(claudeEffortConfig(join(dir, "p"), [], { HOME: home, CLAUDE_CODE_EFFORT_LEVEL: "high" }).level).toBe("high");
    expect(claudeEffortConfig(join(dir, "p"), [], { HOME: home, CLAUDE_CODE_EFFORT_LEVEL: "unset" }).level).toBeNull();
  });

  it("Codex: the top-level model_reasoning_effort of config.toml, not a profile's", () => {
    const env = { HOME: dir };
    expect(codexConfigEffort(env)).toBeNull();
    write(join(dir, ".codex", "config.toml"), '[profiles.fast]\nmodel_reasoning_effort = "low"\n');
    expect(codexConfigEffort(env)).toBeNull();
    write(join(dir, ".codex", "config.toml"), 'model = "gpt"\nmodel_reasoning_effort = "high"\n[profiles.fast]\nmodel_reasoning_effort = "low"\n');
    expect(codexConfigEffort(env)).toBe("high");
    write(join(dir, "ch", "config.toml"), "model_reasoning_effort = 'minimal'\n");
    expect(codexConfigEffort({ HOME: dir, CODEX_HOME: join(dir, "ch") })).toBe("minimal");
  });

  it("takes Runtime settings first, then the CLI, then the model's default", () => {
    expect(resolveEffortDefault({ settings: "low", cli: "high", model: "medium" })).toEqual({ level: "low", source: "settings" });
    expect(resolveEffortDefault({ cli: "high", model: "medium" })).toEqual({ level: "high", source: "cli" });
    expect(resolveEffortDefault({ model: "medium" })).toEqual({ level: "medium", source: "model" });
    expect(resolveEffortDefault({})).toBeNull();
  });

  it("reads the model's default from Codex's model list", () => {
    expect(codexModelOption({ id: "m", displayName: "M", hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }], defaultReasoningEffort: "medium" })).toMatchObject({ defaultEffort: "medium" });
  });

  it("says where it comes from", () => {
    expect(effortDefaultHint({ level: "low", source: "settings" }, "Codex")).toBe("Low, from Runtime settings.");
    expect(effortDefaultHint({ level: "high", source: "cli" }, "Claude Code")).toBe("High, from Claude Code's own configuration.");
    expect(effortDefaultHint(null, "Codex")).toMatch(/Codex decides/);
    expect(effortDefaultHint({ level: "low", source: "settings", cappedFrom: "high" }, "Claude Code")).toBe("Low: Runtime settings asks for High, and Claude Code's maxEffortLevel caps it at Low.");
  });
});

describe("the composer pill on Default", () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const render = (defaultLevel: string | null) =>
    act(async () => root.render(createElement(EffortSlider, { levels: ["low", "medium", "high"], value: null, defaultLevel, onChange: async () => true, defaultHint: "Low, from Runtime settings." })));

  it("names the level the session runs at, marked as the default", async () => {
    await render("low");
    const pill = host.querySelector("button")!;
    expect(pill.textContent).toBe("Low· default");
    expect(pill.getAttribute("aria-label")).toBe("Reasoning effort: Low (default)");
    await act(async () => pill.click());
    expect(host.textContent).toContain("Default · Low");
    expect(host.querySelector('[role="slider"]')!.getAttribute("aria-valuetext")).toBe("Low (default)");
    expect(host.querySelector('[title="Default: Low"]')).not.toBeNull();
  });

  it("an explicit pick above the CLI's cap says it runs at the cap", async () => {
    await act(async () =>
      root.render(createElement(EffortSlider, { levels: ["low", "medium", "high"], value: "high", capLevel: "medium", capHint: "Caps at Medium.", onChange: async () => true, defaultHint: "" })),
    );
    await act(async () => host.querySelector("button")!.click());
    expect(host.textContent).toContain("Caps at Medium.");
  });

  it("explains the cap even when it is not one of the model's levels (F3)", async () => {
    await act(async () =>
      root.render(createElement(EffortSlider, { levels: ["medium", "high"], value: "high", capLevel: "low", capHint: "Caps at Low.", onChange: async () => true, defaultHint: "" })),
    );
    await act(async () => host.querySelector("button")!.click());
    expect(host.textContent).toContain("Caps at Low.");
  });

  it("still says Effort when nothing sets a level", async () => {
    await render(null);
    expect(host.querySelector("button")!.textContent).toBe("Effort");
  });
});
