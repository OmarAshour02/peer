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

type MdNode = {
  type: string;
  value?: string;
  lang?: string | null;
  children?: MdNode[];
  data?: Record<string, unknown>;
  position?: { start: { offset?: number }; end: { offset?: number } };
};

/**
 * Whether a fenced block (``` code or $$ math) has its closing fence in `src`: while a reply
 * streams, an unclosed fence runs to the end of what has arrived (or of its blockquote or list
 * item), and its source is still partial. Decided from what the parser made of it, so container
 * markers and fence-like lines inside the block can't fool it: a closed block spans its content
 * plus exactly two lines, the opening fence and a closing fence; an unclosed one has no closing line.
 */
export function fenceClosed(src: string, node: MdNode): boolean {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return false;
  // Markdown line endings: \n, \r\n or a bare \r.
  const lines = src.slice(start, end).split(/\r\n|\r|\n/);
  // Container prefixes (blockquote markers, list indentation) come before a fence on its line.
  if (lines.length < 2 || !/^[\s>]*(`{3,}|~{3,}|\${2,})\s*$/.test(lines[lines.length - 1]!)) return false;
  // The value keeps a trailing blank content line ("A\n" for "A" then an empty line), so count it as is.
  const value = node.value ?? "";
  // An empty value is either no content lines or one blank one.
  if (value === "") return lines.length === 2 || lines.length === 3;
  return lines.length === value.split(/\r\n|\r|\n/).length + 2;
}

/** Stands in for a diagram or formula whose source is still arriving. */
const pendingBlock = (label: string): MdNode => ({
  type: "pendingRender",
  children: [],
  data: { hName: "div", hProperties: { className: ["render-pending"], role: "status" }, hChildren: [{ type: "text", value: label }] },
});

/**
 * Where a text node's first formula opener is, as an offset into its value, or -1. An opener is a
 * `$` that isn't escaped in the source (`\\$HOME` is a literal dollar) and is followed by something
 * other than a space or a digit (`$5` is a price). Read from the source, then mapped to the value
 * by counting dollars from the end, since the parser drops escapes from the value and decodes
 * entities (`&#36;` in the prose before the formula is a dollar in the value only).
 */
function formulaOpener(src: string, text: MdNode): number {
  const start = text.position?.start.offset;
  const end = text.position?.end.offset;
  const value = text.value ?? "";
  if (start === undefined || end === undefined) return -1;
  const raw = src.slice(start, end);
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "$") continue;
    let slashes = 0;
    while (raw[i - 1 - slashes] === "\\") slashes++;
    if (slashes % 2 !== 0 || !/[^\s\d]/.test(raw[i + 1] ?? " ")) continue;
    // The opener is the n-th dollar from the end of the source, so also of the value.
    const fromEnd = raw.slice(i).split("$").length - 1;
    let at = value.length;
    for (let k = 0; k < fromEnd && at >= 0; k++) at = value.lastIndexOf("$", at - 1);
    return at;
  }
  return -1;
}

/**
 * Cut `node`'s inline content at the first formula opener, at any depth (bold, links), dropping
 * everything after it. Returns whether it cut.
 */
function cutAtFormula(src: string, node: MdNode): boolean {
  const kids = node.children ?? [];
  for (let i = 0; i < kids.length; i++) {
    const kid = kids[i]!;
    let cut = false;
    if (kid.type === "text") {
      const at = formulaOpener(src, kid);
      if (at >= 0) {
        kid.value = (kid.value ?? "").slice(0, at).trimEnd();
        cut = true;
      }
    } else cut = cutAtFormula(src, kid);
    if (cut) {
      node.children = kids.slice(0, i + 1);
      return true;
    }
  }
  return false;
}

/**
 * While a reply streams, a diagram or a formula has no useful partial form: half a Mermaid source
 * doesn't parse and half a LaTeX source shows as raw markup, then jumps when it completes. Hold
 * each one until it is whole: an unclosed ```mermaid or $$ block shows a quiet placeholder, and an
 * unclosed inline `$…` at the end of the text being written is kept back (the caret shows the
 * reply is still coming) until its closing `$` arrives or the paragraph ends.
 */
function remarkHoldUnfinished() {
  return (tree: MdNode, file: { value?: unknown }) => {
    const src = typeof file.value === "string" ? file.value : String(file.value ?? "");
    const visit = (node: MdNode) => {
      if (!node.children) return;
      node.children = node.children.map((child) => {
        if (child.type === "code" && child.lang === "mermaid" && !fenceClosed(src, child)) return pendingBlock("Drawing diagram…");
        // A one-line `$$ x $$` paragraph (remarkDisplayMathParagraphs, no position) is closed by construction.
        if (child.type === "math" && child.position && !fenceClosed(src, child)) return pendingBlock("Typesetting formula…");
        visit(child);
        return child;
      });
    };
    visit(tree);

    // Inline math can't span paragraphs, so only the paragraph still being written can hold an
    // unfinished formula; a lone `$` in a paragraph that has ended is just a dollar sign.
    let last: MdNode | undefined = tree;
    while (last?.children?.length && last.type !== "paragraph") last = last.children[last.children.length - 1];
    if (last?.type !== "paragraph" || last.position?.end.offset === undefined) return;
    // Still being written: only whitespace follows it, and no blank line (which ends a paragraph,
    // also inside a blockquote).
    const after = src.slice(last.position.end.offset).replace(/\r\n?/g, "\n");
    if (after.trim() !== "" || /\n[ \t>]*\n/.test(after)) return;
    cutAtFormula(src, last);
  };
}

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
const REMARK_STREAMING = [...REMARK, remarkHoldUnfinished];
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
  // until then remarkHoldUnfinished shows a placeholder in its place. MermaidDiagram is memoized on
  // its source, so a diagram already on screen is not redrawn when the reply finishes.
  const components = useMemo<Components>(
    () => ({
      pre({ node, children, ...props }) {
        const source = mermaidSource(node as HastNode | undefined);
        if (source !== null) return <MermaidDiagram source={source} />;
        return <pre {...props}>{children as ReactNode}</pre>;
      },
    }),
    [],
  );
  return (
    <ReactMarkdown remarkPlugins={streaming ? REMARK_STREAMING : REMARK} rehypePlugins={streaming ? rehype : [KATEX, HIGHLIGHT]} components={components}>
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
