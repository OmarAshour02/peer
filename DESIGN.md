---
name: Peer
description: "AI coding that makes developers better, not just faster."
colors:
  bg: "#090B09"
  panel: "#0F120F"
  nav: "#0F120F"
  raised: "#171B16"
  line: "#262C24"
  fg: "#E9EEE7"
  muted: "#9DAA9C"
  faint: "#7D8B7A"
  accent: "#86B985"
  accent-deep: "#5E8F5C"
  link: "#7AA2C9"
  collab: "#58A6FF"
  learn: "#D2A8FF"
  warn: "#D29922"
  danger: "#F85149"
  constellation-node: "#A9C4A2"
  constellation-line: "#3A4A38"
  paper: "#F7F5F0"
  warm-white: "#FFFFFF"
  pencil-lines: "#D5D1C9"
  graphite: "#292929"
  soft-gray: "#63665E"
  muted-olive: "#606E56"
  muted-olive-deep: "#55624D"
typography:
  display:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "28px"
    fontWeight: 500
    lineHeight: 1.25
  headline:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "0.08em"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: "4px"
  md: "8px"
  lg: "12px"
  xl: "16px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.bg}"
    rounded: "{rounded.md}"
    padding: "6px 14px"
  button-primary-light:
    backgroundColor: "{colors.muted-olive}"
    textColor: "{colors.warm-white}"
    rounded: "{rounded.md}"
    padding: "6px 14px"
  button-ghost:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.muted}"
    rounded: "{rounded.md}"
    padding: "5px 12px"
  card-checkpoint:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.fg}"
    rounded: "{rounded.lg}"
    padding: "12px 16px"
  input-composer:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.fg}"
    rounded: "{rounded.xl}"
    padding: "12px 16px"
  chip-mode:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.muted}"
    rounded: "{rounded.sm}"
    padding: "2px 8px"
---

# Design System: Peer

## Overview

**Creative North Star: "The Constellation Graph"**

Peer looks like knowledge plotted in the dark. The working surface is a near-black, green-tinted void — calm as T3 Code's console — and behind the quiet moments (a new thread, an empty state, the Learning Space) a faint constellation of nodes and connecting lines drifts: graph theory, geometry, and proof sketches rendered as small scientific figures, never as decoration for its own sake. Knowledge in Peer is a network of concepts the developer has actually touched, and the interface says so visually.

Dark mode is home. It carries the signature: deep green-black surfaces, graph-paper green emphasis, soft ambient lift under the things that float. Light mode is a full peer, not an inversion: the developer's paper palette — Paper ground, Graphite text, Pencil Lines for structure, Muted Olive for emphasis — like working notes on good stock. Both themes share one geometry, one type system, and one behavior for every control.

This document defines the system going forward. It supersedes the incumbent GitHub-dark palette in `src/renderer/styles.css` when implemented; component behavior, density, and keyboard-first operation carry over unchanged.

**Key Characteristics:**

- Near-black green-tinted dark theme; warm paper light theme. Never a blue-gray theme again.
- Graph-paper green leads in the dark; Muted Olive leads in the light. Blue survives only as links and the Collaborate mode color.
- A constellation layer — node-and-line science figures at low opacity — appears only where the developer is orienting, never behind working text.
- Soft ambient shadows do the lifting; 1px lines do the separating.
- Small, precise, restrained controls (11–14px type) that stay invisible until needed.
- Every control is fully keyboard-operable, with a visible focus ring in both themes.

## Colors

A two-theme palette with one accent logic: a muted botanical green carries emphasis, mode colors carry meaning, and neutrals do almost all of the work.

### Primary

- **Graph-Paper Green** (#86B985): the dark theme's accent. Primary actions (send, confirm), the checkpoint emphasis border, active navigation, and focus rings. It is the green of the constellation's lit nodes, deepened for text-bearing surfaces.
- **Muted Olive** (#606E56): the light theme's accent. The same jobs on paper: primary actions, emphasis borders, active states, focus rings.

### Secondary

- **Steel Link Blue** (#7AA2C9): links and inline references in the dark theme only. Blue is demoted on purpose: in the light theme, links take Muted Olive Deep (#55624D) underlined instead.

### Tertiary

- **Mode colors** (meaning, never decoration): Collaborate Blue (#58A6FF), Learn Violet (#D2A8FF), Warning Amber (#D29922), Danger Red (#F85149). These identify collaboration state — mode labels, checkpoint kinds, the risk family — and are never used as general accent or background tint.

### Neutral

Dark theme:

- **Void** (#090B09): the application background; green-black, a step darker than any panel.
- **Panel** (#0F120F): sidebars, cards, the composer at rest.
- **Raised** (#171B16): hover surfaces, code blocks, chips, anything one step toward the developer.
- **Line** (#262C24): the single border and divider color.
- **Text** (#E9EEE7), **Muted** (#9DAA9C), **Faint** (#7D8B7A): the three text steps; faint is for timestamps and metadata only, never body text.

Light theme (the developer's palette, verbatim roles):

- **Paper** (#F7F5F0): the application background.
- **Warm White** (#FFFFFF): raised surfaces, cards, the composer — the only pure white.
- **Pencil Lines** (#D5D1C9): borders and dividers.
- **Graphite** (#292929): body text.
- **Soft Gray** (#63665E): muted text and metadata on Paper; a metadata step, not a body-text step.

Every text token is measured, not eyeballed: text steps and mode colors hold WCAG AA contrast (≥4.5:1) on every surface token in both themes, enforced by a test over the stylesheet tokens. The steps above were darkened/lightened one measured step from the source palette where the original values fell short (Faint, Soft Gray, Muted Olive as text on the sidebar).

### Named Rules

**The Constellation Rule.** The node-network layer appears only on orientation surfaces — new-thread and empty states, the Learning Space, onboarding. It never sits behind a transcript, a diff, or settings: where the developer is working, the ground is still.

**The Green Leads Rule.** In the dark, graph-paper green is the only general accent. If a screen's loudest element is blue and it is not a link or a Collaborate marker, it is wrong.

**The Paper Rule.** In the light, Paper is the ground and Warm White is earned by elevation. A white sidebar on Paper, or Paper-colored cards, flatten the system — don't.

## Typography

**Display Font:** system sans (ui-sans-serif, system-ui, -apple-system, "Segoe UI")
**Body Font:** the same system sans — one family, used with restraint
**Label/Mono Font:** ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace

**Character:** A single quiet sans at small sizes, with mono reserved for code, file paths, token counts, and the constellation's figure labels. Nothing about the type performs; precision is the personality. Uppercase appears only in 11px tracked labels (section eyebrows, card kinds).

### Hierarchy

- **Display** (500, 28px, 1.25): the empty-state question only ("What should we build in …?"), one per screen at most.
- **Headline** (600, 15px, 1.4): session titles, dialog titles, checkpoint questions.
- **Title** (600, 14px, 1.4): card headings, panel headings.
- **Body** (400, 14px, 1.6): transcript text, answers, settings prose. Markdown in answers keeps this size and rhythm.
- **Label** (500, 11px, 0.08em tracking, uppercase where eyebrow): card kinds ("Peer paused the agent"), section eyebrows, timestamps (not uppercase).

### Named Rules

**The Small Type Rule.** Product UI text lives at 11–14px. Anything larger than Headline outside the empty state is a bug, not emphasis.

## Layout

A three-zone desktop layout that does not move: workspace/session sidebar (fixed ~250px) on the left, the transcript column in the center (fluid, text capped by the composer width), and contextual panels (changes, project card) docked right when open. The transcript is one reading column, max 960px, shared by prose, code blocks, tables, and the composer so every block lines up on the same two edges; code lines wider than that scroll inside their block. The composer is a single floating-feeling panel centered on that column, with its control row inside it (mode controls, model, send) and a subdued context strip beneath (workspace, branch) in the T3 manner.

Density is compact and even: 4px base rhythm, 8/12/16px steps, 24px only between major regions. Sessions lists are single-line rows (title, age) with truncation; nothing in the sidebar wraps. The layout is desktop-first (Electron window, macOS and Linux); below ~900px window width the right panel overlays instead of docking, and the sidebar collapses to icons rather than reflowing text.

## Elevation & Depth

Soft ambient shadows do the lifting; tone and line do the separating. At rest, surfaces differ by background step (Void → Panel → Raised in the dark; Paper → Warm White in the light) and a 1px border. Cards, the composer, dialogs, and floating panels additionally carry a diffuse ambient shadow — wide, low-contrast, never a hard drop. In the light theme the shadow is warm-gray, echoing paper on a desk; in the dark it is near-black and deeper than the panel step it lifts from.

### Shadow Vocabulary

- **Ambient card** (`box-shadow: 0 8px 30px rgba(0,0,0,0.35)` dark; `0 8px 30px rgba(41,41,41,0.10)` light): checkpoint cards, project card, changes panel.
- **Ambient composer** (`box-shadow: 0 12px 40px rgba(0,0,0,0.45)` dark; `0 12px 40px rgba(41,41,41,0.12)` light): the composer and dialogs — the most-lifted everyday surfaces.

### Named Rules

**The Float Responsibly Rule.** Shadows answer "this floats above the work" — composer, cards, dialogs, menus. Rows, code blocks, and inline surfaces never cast one.

## Shapes

Softly squared geometry: 4px for chips and inline code, 8px for buttons and inputs, 12px for cards, 16px for the composer and dialogs. Borders are always 1px in the theme's line color; emphasis is a 1px accent border, never a thicker stroke. The constellation layer is the one place circles and hairlines (1px, low opacity) appear as pure form.

Focus is a shape too: `:focus-visible` draws a 2px accent (Graph-Paper Green / Muted Olive) outline at 2px offset on every interactive element, in both themes, with no exceptions for mouse users' convenience — keyboard-first is a product commitment (see PRODUCT.md).

## Components

Refined and restrained throughout: quiet surfaces, precise states, and emphasis spent only where the collaboration model needs the developer's attention.

### Buttons

- **Shape:** gently squared (8px radius), 12–13px label.
- **Primary:** Graph-Paper Green fill with Void text in the dark; Muted Olive fill with Warm White text in the light. Send is the round 32px variant of the same fill with a centered arrow icon.
- **Hover / Focus:** primary deepens one step (accent-deep / muted-olive-deep); ghost buttons move text from muted to full foreground; focus shows the 2px accent outline.
- **Ghost / secondary:** Raised (dark) or Warm White (light) surface, line border, muted text — the default for toggles (Network, Auto approvals, Approach gate), header actions, and settings controls. Toggles read as text switches ("Approach gate: on") rather than pill switches.

### Chips

Mode and control chips sit inside the composer and on checkpoint cards: Raised surface, 4px radius, 11px label. Selected state takes the relevant mode color as text (Collaborate Blue, Learn Violet) with a line border in the same color at low contrast; never a filled mode-color background.

### Cards / Containers

- **Checkpoint card (the signature component):** Panel surface, 12px radius, ambient card shadow, 1px Line border — or a Graph-Paper Green border when Peer is waiting on the developer. Kind eyebrow in 11px uppercase ("Peer paused the agent · large change"), question at Headline size, options as full-width Raised rows. Peer-noted (auto-resolved) cards drop the shadow and use a dashed Line border: recorded, not asking.
- **Permission card:** the same shell with a Warning Amber border; safety never borrows the accent.
- **Project / changes panel:** Warm-side card floating over the canvas edge (the T3 pattern), rows separated by hairlines, diff counts in mono (additions Graph-Paper Green, deletions Danger Red).

### Inputs / Fields

- **Composer:** Panel surface, 16px radius, ambient composer shadow, no visible border at rest; the placeholder is Faint. Attach and send sit bottom-right inside it; the mode/model control row is its footer.
- **Text fields and selects (settings):** Raised/Paper surface, 1px Line (Pencil Lines) border, 8px radius, 13px text. Focus moves the border to the accent and adds the outline; error text is Danger Red at 12px (graphite-safe in the light via the same red darkened by role, never by tinting backgrounds).

### Navigation

Sidebar rows: 13px title, Faint mono age at right, one line, truncated. The active session row is Raised with full-foreground text; hover is Raised at half strength. Workspace and session headers are 14px/600 with the path in 11px mono Faint beneath. The constellation layer may sit behind the sidebar's empty bottom region in the dark theme — behind no text.

### The Constellation Layer (signature)

A generated SVG/canvas field of small nodes (1–2px circles in Constellation Node) joined by hairlines (Constellation Line at 25–40% opacity), denser at the edges, clearing toward the center where the composer or empty-state question sits. A few clusters carry tiny mono labels drawn from real science the developer has touched (concept names from their sessions, e.g. "Gradient descent", "Relational model") — and only from real data; an account with no history gets unlabeled geometry. In the light theme the same figures render as pencil work: Soft Gray nodes and Pencil Lines joins on Paper, no glow. Motion, if any, is a near-imperceptible drift; it stops under `prefers-reduced-motion`, and the layer is `aria-hidden` and pointer-events-none at all times.

## Do's and Don'ts

### Do:

- **Do** keep working surfaces still: the constellation belongs to new-thread, empty, and Learning surfaces only (The Constellation Rule).
- **Do** spend Graph-Paper Green (dark) and Muted Olive (light) on actions, emphasis borders, and focus — and almost nothing else (The Green Leads Rule).
- **Do** use mode colors only for collaboration meaning: mode labels, checkpoint kinds, risk and safety states.
- **Do** lift only what floats — composer, cards, dialogs — with the ambient shadows, and separate everything else with the 1px line.
- **Do** give every interactive element the 2px accent `:focus-visible` outline in both themes; keyboard-first is binding.
- **Do** label constellation clusters only from the developer's real sessions and code. Unlabeled geometry is the honest default.

### Don't:

- **Don't** reintroduce the incumbent blue-gray GitHub-dark palette (#58A6FF as general accent, #0D1117 grounds). Blue is links and Collaborate coding now.
- **Don't** put constellation figures, gradients, or glow behind a transcript, diff, code block, or settings form.
- **Don't** use Soft Gray (#63665E) for body text on Paper, or Faint (#7D8B7A) for body text in the dark; both are metadata-only steps.
- **Don't** fill chips or rows with mode colors; mode color is text and hairline, never a background wash.
- **Don't** add a second accent, a gradient button, or an emoji anywhere in product UI.
- **Don't** invent constellation labels, concept names, or learning data for decoration. If it isn't from the developer's real work, it isn't drawn.
