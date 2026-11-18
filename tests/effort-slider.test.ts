// @vitest-environment jsdom
// The composer's effort slider: a pill opens a popover with the model's levels as slider stops,
// arrows and pointer pick a level, and "Default" clears the pick.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EffortSlider } from "../src/renderer/components/EffortSlider.js";

let host: HTMLDivElement;
let root: Root;
const levels = ["low", "medium", "high", "xhigh", "max"];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function show(value: string | null, onChange = vi.fn(async () => true)) {
  await act(async () => root.render(createElement(EffortSlider, { levels, value, onChange, defaultHint: "Uses Runtime settings." })));
  return onChange;
}
const pill = () => host.querySelector<HTMLButtonElement>("button[aria-haspopup]")!;
const slider = () => host.querySelector<HTMLElement>("[role=slider]");
const key = (k: string) => act(async () => void slider()!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })));

describe("effort slider", () => {
  it("shows the pick on the pill and opens a slider positioned at it", async () => {
    await show("high");
    expect(pill().textContent).toBe("High");
    expect(slider()).toBeNull();
    await act(async () => pill().click());
    expect(slider()!.getAttribute("aria-valuenow")).toBe("2");
    expect(slider()!.getAttribute("aria-valuetext")).toBe("High");
    expect(host.textContent).toContain("Low");
    expect(host.textContent).toContain("Max");
  });

  it("moves one level per arrow key and reports it", async () => {
    const onChange = await show("high");
    await act(async () => pill().click());
    await key("ArrowRight");
    expect(onChange).toHaveBeenLastCalledWith("xhigh");
    expect(slider()!.getAttribute("aria-valuetext")).toBe("Extra high");
    await key("Home");
    expect(onChange).toHaveBeenLastCalledWith("low");
  });

  it("on Default shows no position; the first arrow lands mid-track; Default clears a pick", async () => {
    const onChange = await show(null);
    expect(pill().textContent).toBe("Effort");
    await act(async () => pill().click());
    expect(slider()!.hasAttribute("aria-valuenow")).toBe(false);
    expect(host.textContent).toContain("Uses Runtime settings.");
    await key("ArrowRight");
    expect(onChange).toHaveBeenLastCalledWith("high");
    const def = [...host.querySelectorAll("button")].find((b) => b.textContent === "Default")!;
    await act(async () => def.click());
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("goes back to the session's effort when the change is refused", async () => {
    await show("high", vi.fn(async () => false));
    await act(async () => pill().click());
    await key("ArrowRight");
    expect(slider()!.getAttribute("aria-valuetext")).toBe("High");
  });

  it("commits a drag on release, and drops one cut short by Escape", async () => {
    const onChange = await show("medium");
    await act(async () => pill().click());
    const s = slider()!;
    s.getBoundingClientRect = () => ({ left: 0, width: 400, top: 0, height: 20, right: 400, bottom: 20, x: 0, y: 0, toJSON() {} });
    s.setPointerCapture = () => {};
    const pointer = (type: string, clientX: number) => act(async () => void s.dispatchEvent(new MouseEvent(type, { clientX, bubbles: true })));
    await pointer("pointerdown", 400);
    expect(s.getAttribute("aria-valuetext")).toBe("Max");
    await pointer("pointerup", 300);
    expect(onChange).toHaveBeenLastCalledWith("xhigh");

    onChange.mockClear();
    await pointer("pointerdown", 0);
    expect(pill().textContent).toBe("Low");
    await act(async () => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(onChange).not.toHaveBeenCalled();
    expect(pill().textContent).toBe("Extra high");
  });

  it("closes on Escape and on a click outside", async () => {
    await show("low");
    await act(async () => pill().click());
    await act(async () => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(slider()).toBeNull();
    await act(async () => pill().click());
    await act(async () => void document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(slider()).toBeNull();
  });
});
