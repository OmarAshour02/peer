// Force-directed layout for the learning map. Deterministic: the same topics and links always land
// in the same places, and a refresh seeded with the previous positions only settles the new ones.

export interface Point {
  x: number;
  y: number;
}

export interface LayoutNode {
  id: string;
  /** Drawn radius; larger nodes keep more room around them. */
  r: number;
}

export interface LayoutLink {
  source: string;
  target: string;
  weight: number;
}

const REPULSION = 2200;
const GRAVITY = 0.012;
const SPRING = 0.05;
const REST = 60;
const DAMPING = 0.55;
const MAX_STEP = 30;
/** Beyond this distance (squared), two nodes no longer push each other. */
const CUTOFF2 = 600 * 600;

export function layoutGraph(nodes: LayoutNode[], links: LayoutLink[], seed?: ReadonlyMap<string, Point>): Map<string, Point> {
  const n = nodes.length;
  const out = new Map<string, Point>();
  if (n === 0) return out;
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const vx = new Float64Array(n);
  const vy = new Float64Array(n);
  const golden = Math.PI * (3 - Math.sqrt(5));
  let seeded = 0;
  nodes.forEach((node, i) => {
    const p = seed?.get(node.id);
    if (p) {
      x[i] = p.x;
      y[i] = p.y;
      seeded++;
    } else {
      // A sunflower spiral: evenly spread, no randomness.
      const r = 28 * Math.sqrt(i + 0.5);
      x[i] = r * Math.cos(i * golden);
      y[i] = r * Math.sin(i * golden);
    }
  });
  const springs: [number, number, number][] = [];
  for (const l of links) {
    const a = index.get(l.source);
    const b = index.get(l.target);
    if (a === undefined || b === undefined || a === b) continue;
    springs.push([a, b, Math.min(3, Math.sqrt(l.weight))]);
  }

  // A refresh that only adds a few topics settles quickly; a fresh map needs the full run.
  const full = n > 200 ? 160 : Math.min(400, 140 + n * 2);
  const iterations = seeded === n ? 40 : seeded > 0 ? 120 : full;
  for (let it = 0; it < iterations; it++) {
    const alpha = 1 - it / iterations;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = x[j]! - x[i]!;
        let dy = y[j]! - y[i]!;
        let d2 = dx * dx + dy * dy;
        if (d2 > CUTOFF2) continue;
        if (d2 < 0.01) {
          // Coincident: nudge apart along a direction fixed by the pair.
          dx = Math.cos(i * 7 + j);
          dy = Math.sin(i * 7 + j);
          d2 = 1;
        }
        const f = (REPULSION * alpha) / d2;
        vx[i]! -= dx * f;
        vy[i]! -= dy * f;
        vx[j]! += dx * f;
        vy[j]! += dy * f;
      }
    }
    for (const [a, b, w] of springs) {
      const dx = x[b]! - x[a]!;
      const dy = y[b]! - y[a]!;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const rest = REST + nodes[a]!.r + nodes[b]!.r;
      const f = ((d - rest) / d) * SPRING * w * alpha;
      vx[a]! += dx * f;
      vy[a]! += dy * f;
      vx[b]! -= dx * f;
      vy[b]! -= dy * f;
    }
    for (let i = 0; i < n; i++) {
      vx[i]! -= x[i]! * GRAVITY * alpha;
      vy[i]! -= y[i]! * GRAVITY * alpha;
      const step = Math.hypot(vx[i]!, vy[i]!);
      const scale = step > MAX_STEP ? MAX_STEP / step : 1;
      x[i]! += vx[i]! * scale;
      y[i]! += vy[i]! * scale;
      vx[i]! *= DAMPING;
      vy[i]! *= DAMPING;
    }
  }
  nodes.forEach((node, i) => out.set(node.id, { x: x[i]!, y: y[i]! }));
  return out;
}

/** The view transform (screen = world × k + offset) that fits every point in a w × h box. */
export function fitView(points: Iterable<Point>, w: number, h: number, pad = 64): { x: number; y: number; k: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (!Number.isFinite(minX) || w <= 0 || h <= 0) return { x: w / 2, y: h / 2, k: 1 };
  const bw = Math.max(1, maxX - minX);
  const bh = Math.max(1, maxY - minY);
  const k = Math.max(0.25, Math.min(2, (w - pad * 2) / bw, (h - pad * 2) / bh));
  return { x: w / 2 - ((minX + maxX) / 2) * k, y: h / 2 - ((minY + maxY) / 2) * k, k };
}
