import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import { MermaidDiagram } from "./MermaidDiagram";

/**
 * Agent replies arrive in bursts (a runtime batches tokens, and the event stream delivers what
 * piled up), so rendering each delta as it lands makes text jump in blocks. While a reply is
 * live, this reveals it at a steady pace instead, word by word, and each new word fades in.
 * Text that is already complete (history, a session you switch to) renders at once.
 */

/** Never reveal slower than this, so short bursts still read as typing rather than a crawl. */
const MIN_CPS = 90;
/** How far the reveal may trail the text that has arrived, in seconds, while the reply streams. */
const LAG_LIVE_S = 0.45;
/** Once the reply is complete, finish the remainder quickly instead of trailing it. */
const LAG_DONE_S = 0.2;
/** Snap forward to the end of the current word when it ends within this many characters. */
const WORD_SNAP = 16;
/** Re-render at most this often; markdown is re-parsed on every reveal step. */
const FRAME_MS = 32;

export interface RevealState {
  shown: number;
  /** Fractional characters owed from earlier frames. */
  carry: number;
}

/** One step of the reveal: how much of `text` is visible after `dtMs` more milliseconds. */
export function revealStep(text: string, state: RevealState, dtMs: number, live: boolean): RevealState {
  const len = text.length;
  if (state.shown >= len) return { shown: len, carry: 0 };
  const backlog = len - state.shown;
  const cps = Math.max(MIN_CPS, backlog / (live ? LAG_LIVE_S : LAG_DONE_S));
  const budget = state.carry + (cps * Math.max(0, dtMs)) / 1000;
  const whole = Math.floor(budget);
  if (whole === 0) return { shown: state.shown, carry: budget };
  let shown = Math.min(len, state.shown + whole);
  // Finish the word in progress, so words appear whole (and fade in once) rather than letter by letter.
  if (shown < len && /\S/.test(text[shown - 1] ?? "")) {
    const rest = text.slice(shown, shown + WORD_SNAP + 1).search(/\s/);
    if (rest >= 0 && rest <= WORD_SNAP) shown += rest;
  }
  return { shown, carry: budget - whole };
}

const prefersReducedMotion = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The visible length of `text`: all of it unless it is streaming, then a steadily advancing prefix.
 * `fromStart`: the part just appeared, so reveal it from its first character. Otherwise the text it
 * mounts with shows at once (history, or a turn already under way when you open the session) and
 * only text that arrives afterwards animates.
 */
export function useSmoothText(text: string, live: boolean, fromStart = live): { visible: string; animating: boolean } {
  const [shown, setShown] = useState(() => (live && fromStart && !prefersReducedMotion() ? 0 : text.length));
  const state = useRef<RevealState>({ shown, carry: 0 });
  const textRef = useRef(text);
  const liveRef = useRef(live);
  textRef.current = text;
  liveRef.current = live;

  // One reveal loop at a time. New chunks never restart a running loop (that would reset its
  // timing, and chunks arriving every frame would keep the text from ever painting); they only
  // start the loop again when it has stopped, including in the render batch where it caught up.
  const raf = useRef(0);
  const lastPaint = useRef(0);
  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current);
      raf.current = 0;
    },
    [],
  );
  useEffect(() => {
    if (raf.current || state.current.shown >= text.length) return;
    if (prefersReducedMotion()) {
      state.current = { shown: text.length, carry: 0 };
      setShown(text.length);
      return;
    }
    let last = performance.now();
    const tick = (now: number) => {
      state.current = revealStep(textRef.current, state.current, now - last, liveRef.current);
      last = now;
      const done = state.current.shown >= textRef.current.length;
      if (done || now - lastPaint.current >= FRAME_MS) {
        lastPaint.current = now;
        setShown(state.current.shown);
      }
      raf.current = done ? 0 : requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  }, [text.length]);

  // A part's text can also be replaced by a shorter final version; never show past its end.
  const end = Math.min(shown, text.length);
  return { visible: text.slice(0, end), animating: live || end < text.length };
}

type HastNode = { type: string; tagName?: string; value?: string; children?: HastNode[]; properties?: Record<string, unknown> };

/** The words a part first rendered with (normalized, document order), recorded on its first render. */
type Settled = { current: string[] | null };

/** A word without markdown syntax, so the same word reads the same before and after its markup completes. */
const normalizeWord = (w: string) => w.replace(/[*_~`[\]()#>|\\]/g, "");

/**
 * Wrap each word of the rendered markdown in a span. React keeps the spans already on screen
 * mounted as the text grows, so only words that are new this frame play the fade-in. The text a
 * part first renders with was already there (history, a turn opened mid-way): the leading words
 * that still match it stay plain text, and everything from the first difference on fades in.
 * Matching words (code included, markdown syntax ignored) rather than offsets keeps the boundary
 * in place when entities decode or markup completes later (a closing backtick, `**`, a link).
 */
function rehypeStreamWords(options: { settled: Settled }) {
  const settled = options.settled;
  return (tree: HastNode) => {
    const first = settled.current === null;
    const before = settled.current ?? [];
    const seen: string[] = [];
    let matching = true;
    /** Whether the next word is one the part already showed. */
    const settles = (word: string) => {
      const norm = normalizeWord(word);
      if (!norm) return matching;
      seen.push(norm);
      if (first) return true;
      if (matching && seen.length <= before.length && before[seen.length - 1] === norm) return true;
      matching = false;
      return false;
    };
    const walk = (node: HastNode, inCode: boolean) => {
      if (!node.children) return;
      // Typeset math is laid out glyph by glyph: like code, it keeps its text nodes as they are.
      const code = inCode || node.tagName === "pre" || node.tagName === "code" || isKatex(node);
      const next: HastNode[] = [];
      for (const child of node.children) {
        if (child.type !== "text" || !child.value) {
          walk(child, code);
          next.push(child);
          continue;
        }
        for (const piece of child.value.split(/(\s+)/)) {
          if (!piece) continue;
          if (/^\s+$/.test(piece)) {
            next.push({ type: "text", value: piece });
            continue;
          }
          const old = settles(piece);
          // Code keeps its text nodes as they are; only prose words get the fade.
          if (code || old) next.push({ type: "text", value: piece });
          else next.push({ type: "element", tagName: "span", properties: { className: ["stream-word"] }, children: [{ type: "text", value: piece }] });
        }
      }
      node.children = next;
    };
    walk(tree, false);
    if (first) settled.current = seen;
  };
}

function isKatex(node: HastNode): boolean {
  const cls = node.properties?.className;
  return Array.isArray(cls) ? cls.some((c) => typeof c === "string" && c.startsWith("katex")) : typeof cls === "string" && cls.startsWith("katex");
}

/** Text of a hast node (a code block's source). */
function hastText(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastText).join("");
}

/** The ```mermaid source of a `pre` node, or null for any other block. */
export function mermaidSource(pre: HastNode | undefined): string | null {
  const code = pre?.children?.find((c) => c.type === "element" && c.tagName === "code");
  const cls = code?.properties?.className;
  const isMermaid = Array.isArray(cls) && cls.includes("language-mermaid");
  return isMermaid ? hastText(code).replace(/\n$/, "") : null;
}

type Positioned = { position?: { start?: { offset?: number }; end?: { offset?: number } } };

/**
 * Whether a code block's closing fence is in `text`: while a reply streams, an unclosed fence runs
 * to the end of what has arrived (or of its blockquote or list item), and its source is still
 * partial. Decided from what the parser made of it, so container markers and fence-like lines
 * inside the code can't fool it: a closed block's source is its content plus exactly two lines,
 * the opening fence and a closing fence; an unclosed one has no closing line.
 */
export function fenceClosed(text: string, pre: (HastNode & Positioned) | undefined): boolean {
  const start = pre?.position?.start?.offset;
  const end = pre?.position?.end?.offset;
  const code = pre?.children?.find((c) => c.type === "element" && c.tagName === "code");
  if (start === undefined || end === undefined || !code) return false;
  // Markdown line endings: \n, \r\n or a bare \r.
  const lines = text.slice(start, end).split(/\r\n|\r|\n/);
  // Container prefixes (blockquote markers, list indentation) come before a fence on its line.
  const close = /^[\s>]*(`{3,}|~{3,})\s*$/.exec(lines[lines.length - 1]!);
  if (lines.length < 2 || !close) return false;
  const value = hastText(code).replace(/(\r\n|\r|\n)$/, "");
  const contentLines = value === "" ? 0 : value.split(/\r\n|\r|\n/).length;
  return lines.length === contentLines + 2;
}

type MdNode = { type: string; value?: string; children?: MdNode[]; position?: { start: { offset?: number } } };

/** A display math node, shaped as remark-math builds one for a `$$` fence. */
const displayMath = (value: string) => ({
  type: "math",
  value,
  data: {
    hName: "pre",
    hChildren: [{ type: "element", tagName: "code", properties: { className: ["language-math", "math-display"] }, children: [{ type: "text", value }] }],
  },
});

/**
 * remark-math only treats `$$` as display math when the delimiters sit on their own lines; agents
 * often write `$$ x $$` on one line as its own paragraph. Typeset that as display math too.
 */
function remarkDisplayMathParagraphs() {
  return (tree: MdNode, file: { value?: unknown }) => {
    const src = typeof file.value === "string" ? file.value : String(file.value ?? "");
    const visit = (node: MdNode) => {
      if (!node.children) return;
      node.children = node.children.map((child) => {
        const only = child.type === "paragraph" && child.children?.length === 1 ? child.children[0] : undefined;
        const at = only?.position?.start.offset;
        if (only?.type === "inlineMath" && at !== undefined && src.startsWith("$$", at)) return displayMath(only.value ?? "");
        visit(child);
        return child;
      });
    };
    visit(tree);
  };
}

/** Math: $inline$ and $$display$$ (LaTeX), typeset by KaTeX. A malformed formula shows as its source rather than throwing. */
const REMARK = [remarkGfm, remarkMath, remarkDisplayMathParagraphs];
type KatexEntry = [typeof rehypeKatex, { throwOnError: false; strict: false; errorColor: string }];
const KATEX: KatexEntry = [rehypeKatex, { throwOnError: false, strict: false, errorColor: "var(--color-muted)" }];
/**
 * Syntax colors for fenced code that names its language (highlight.js's common set). No guessing
 * for untagged blocks: detection runs every grammar, and replies re-render on every reveal step.
 * Diagrams and math keep their plain source for their own renderers.
 */
type HighlightEntry = [typeof rehypeHighlight, { detect: false; plainText: string[] }];
export const HIGHLIGHT: HighlightEntry = [rehypeHighlight, { detect: false, plainText: ["mermaid", "math", "text", "txt", "plaintext"] }];

const Markdown = memo(function Markdown({ text, streaming, settled }: { text: string; streaming: boolean; settled: Settled }) {
  const rehype = useMemo(
    () => [KATEX, HIGHLIGHT, [rehypeStreamWords, { settled }] as [typeof rehypeStreamWords, { settled: Settled }]],
    [settled],
  );
  // A diagram renders as soon as its closing fence arrives, while the rest of the reply streams on;
  // until then its source is partial and shows as code. The renderer stays the same component for
  // the whole reply (it reads the text and the streaming state from refs), so a diagram already on
  // screen is not redrawn when the reply finishes.
  const textRef = useRef(text);
  const streamingRef = useRef(streaming);
  textRef.current = text;
  streamingRef.current = streaming;
  const components = useMemo<Components>(
    () => ({
      pre({ node, children, ...props }) {
        const complete = !streamingRef.current || fenceClosed(textRef.current, node as (HastNode & Positioned) | undefined);
        const source = complete ? mermaidSource(node as HastNode | undefined) : null;
        if (source !== null) return <MermaidDiagram source={source} />;
        return <pre {...props}>{children as ReactNode}</pre>;
      },
    }),
    [],
  );
  return (
    <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={streaming ? rehype : [KATEX, HIGHLIGHT]} components={components}>
      {text}
    </ReactMarkdown>
  );
});

export function StreamingMarkdown({ text, live, fromStart = live, className = "" }: { text: string; live: boolean; fromStart?: boolean; className?: string }) {
  const { visible, animating } = useSmoothText(text, live, fromStart);
  const settled = useRef<string[] | null>(null);
  return (
    <div className={`${className} ${animating ? "streaming" : ""}`}>
      <Markdown text={visible} streaming={animating} settled={settled} />
    </div>
  );
}
