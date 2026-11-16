import { memo, useEffect, useState } from "react";

/**
 * A Mermaid diagram from a ```mermaid block in an agent reply. Mermaid is large, so it loads on the
 * first diagram, not with the app. Diagrams follow the display theme (read from the CSS tokens) and
 * re-render when it changes. If the source does not parse, the block shows as the code it is.
 */

type MermaidApi = typeof import("mermaid").default;

let loading: Promise<MermaidApi> | null = null;
const loadMermaid = () => (loading ??= import("mermaid").then((m) => m.default));

/** Mermaid keeps global config and render ids, so renders run one at a time. */
let queue: Promise<unknown> = Promise.resolve();
let nextId = 0;

const token = (name: string, fallback: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

function themeVariables() {
  const bg = token("--color-bg", "#090b09");
  const panel = token("--color-panel", "#0f120f");
  const raised = token("--color-raised", "#171b16");
  const line = token("--color-line", "#262c24");
  const fg = token("--color-fg", "#e9eee7");
  const muted = token("--color-muted", "#9daa9c");
  const accent = token("--color-accent", "#86b985");
  return {
    darkMode: document.documentElement.dataset.theme !== "light",
    background: bg,
    fontFamily: "inherit",
    fontSize: "13px",
    primaryColor: raised,
    primaryTextColor: fg,
    primaryBorderColor: accent,
    secondaryColor: panel,
    secondaryTextColor: fg,
    secondaryBorderColor: line,
    tertiaryColor: panel,
    tertiaryTextColor: fg,
    tertiaryBorderColor: line,
    lineColor: muted,
    textColor: fg,
    mainBkg: raised,
    nodeBorder: accent,
    clusterBkg: panel,
    clusterBorder: line,
    edgeLabelBackground: panel,
    noteBkgColor: panel,
    noteTextColor: fg,
    noteBorderColor: line,
    actorBkg: raised,
    actorBorder: accent,
    actorTextColor: fg,
    signalColor: muted,
    signalTextColor: fg,
  };
}

/** Relative luminance (0 dark .. 1 light) of a CSS color the browser can parse, or null. */
function luminance(color: string): number | null {
  const probe = document.createElement("span");
  probe.style.color = color;
  if (!probe.style.color) return null;
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).color.match(/\d+(\.\d+)?/g)?.slice(0, 3).map(Number);
  probe.remove();
  if (!rgb || rgb.length < 3) return null;
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/**
 * The agent may color nodes itself (classDef/style fills). The theme's text color is chosen for the
 * theme's own surfaces, so a pale fill in the dark theme would carry pale text. Give each node with
 * its own fill (and no text color of its own) dark or light text by the fill's brightness.
 */
const DARK_TEXT = "#1f2420";
const LIGHT_TEXT = "#eef2ec";
/** Relative luminance of DARK_TEXT and LIGHT_TEXT. */
const DARK_TEXT_L = 0.0166;
const LIGHT_TEXT_L = 0.8774;

export function readableLabels(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (doc.querySelector("parsererror")) return svg;
  let changed = false;
  for (const node of doc.querySelectorAll("g.node")) {
    const shape = node.querySelector("rect, polygon, circle, ellipse, path");
    const fill = shape?.getAttribute("style")?.match(/(?:^|;)\s*fill\s*:\s*([^;!]+)/i)?.[1]?.trim() ?? shape?.getAttribute("fill") ?? null;
    if (!fill || fill === "none") continue;
    // A label that sets its own color (HTML labels) or fill (SVG text) is the agent's choice: keep it.
    const labelStyled =
      [...node.querySelectorAll(".nodeLabel, .label, span, p, div")].some((el) => /(?:^|;)\s*color\s*:/i.test(el.getAttribute("style") ?? "")) ||
      [...node.querySelectorAll("text, tspan")].some((el) => el.hasAttribute("fill") || /(?:^|;)\s*fill\s*:/i.test(el.getAttribute("style") ?? ""));
    if (labelStyled) continue;
    const l = luminance(fill);
    if (l === null) continue;
    // Whichever candidate contrasts more with this fill (WCAG contrast ratio).
    const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const text = contrast(l, DARK_TEXT_L) >= contrast(l, LIGHT_TEXT_L) ? DARK_TEXT : LIGHT_TEXT;
    for (const el of node.querySelectorAll(".nodeLabel, .label, span, p, div, text, tspan")) {
      el.setAttribute("style", `${el.getAttribute("style") ?? ""};color:${text} !important;fill:${text} !important`);
    }
    changed = true;
  }
  return changed ? new XMLSerializer().serializeToString(doc.documentElement) : svg;
}

export function renderMermaid(source: string): Promise<string> {
  const run = queue.then(async () => {
    const mermaid = await loadMermaid();
    // No error diagram: a source that does not parse falls back to its code block.
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, theme: "base", themeVariables: themeVariables() });
    const id = `peer-mermaid-${++nextId}`;
    try {
      const { svg } = await mermaid.render(id, source);
      return readableLabels(svg);
    } finally {
      // Mermaid measures in a scratch node on document.body and can leave it behind when it fails.
      for (const stale of [id, `d${id}`, `i${id}`]) document.getElementById(stale)?.remove();
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

/** The current display theme, updated when the document's theme attribute changes. */
function useThemeKey(): string {
  const read = () => document.documentElement.dataset.theme ?? "dark";
  const [key, setKey] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setKey(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return key;
}

export const MermaidDiagram = memo(function MermaidDiagram({ source }: { source: string }) {
  const theme = useThemeKey();
  const [state, setState] = useState<{ svg: string | null; failed: boolean }>({ svg: null, failed: false });
  useEffect(() => {
    let cancelled = false;
    renderMermaid(source).then(
      (svg) => !cancelled && setState({ svg, failed: false }),
      () => !cancelled && setState({ svg: null, failed: true }),
    );
    return () => {
      cancelled = true;
    };
  }, [source, theme]);

  if (state.svg) return <div className="mermaid-diagram" role="img" aria-label="Diagram" dangerouslySetInnerHTML={{ __html: state.svg }} />;
  return (
    <pre className={state.failed ? "mermaid-source mermaid-failed" : "mermaid-source"}>
      <code className="language-mermaid">{source}</code>
    </pre>
  );
});
