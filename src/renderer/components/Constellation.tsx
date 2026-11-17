import { useId, useMemo } from "react";

/**
 * The constellation layer (DESIGN.md): node-and-line science figures for orientation surfaces
 * only — new-thread and empty states. Unlabeled on purpose: cluster labels come from the
 * developer's real sessions once that data is wired in, never invented here.
 *
 * Drawn as a star atlas, not a scatter: six real asterisms (approximate positions, sizes from
 * magnitude), joined the way printed charts join them — hairlines that stop short of each star —
 * over a sparse field of faint unconnected stars and one dashed coordinate arc. Figures sit in
 * pairs balanced through the centre (top-left with bottom-right, and so on), each one distinct,
 * so the composition is symmetric in weight without mirroring shapes. The middle (the empty-state
 * text), the header band and the composer's bottom-centre stay dark.
 *
 * The canvas is close to a real pane's size, so `slice` scales it near 1:1.
 */
const W = 1200;
const H = 750;
const CX = W / 2;
const CY = H / 2;

/** [x, y, visual magnitude] in figure units; links index into the star list. */
type FigureStar = [number, number, number];
interface Figure {
  name: string;
  /** Where the figure's bounding-box centre sits on the canvas, and figure units → canvas units. */
  at: [number, number];
  scale: number;
  stars: FigureStar[];
  links: [number, number][];
}

export const FIGURES: Figure[] = [
  {
    name: "Big Dipper",
    at: [255, 200],
    scale: 56,
    stars: [
      [0, 0, 1.9], // Alkaid
      [0.9, -0.15, 2.2], // Mizar
      [1.65, -0.1, 1.8], // Alioth
      [2.45, 0.05, 3.3], // Megrez
      [2.55, 0.75, 2.4], // Phecda
      [3.6, 0.85, 2.4], // Merak
      [3.75, 0.1, 1.8], // Dubhe
    ],
    links: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 3]],
  },
  {
    name: "Orion",
    at: [955, 585],
    scale: 62,
    stars: [
      [0, 0, 0.5], // Betelgeuse
      [1.6, 0.15, 1.6], // Bellatrix
      [0.62, 1.38, 1.8], // Alnitak
      [0.86, 1.26, 1.7], // Alnilam
      [1.1, 1.14, 2.2], // Mintaka
      [0.25, 2.5, 2.1], // Saiph
      [1.78, 2.36, 0.1], // Rigel
      [0.86, -0.55, 3.4], // Meissa
    ],
    links: [[7, 0], [7, 1], [0, 2], [1, 4], [2, 3], [3, 4], [2, 5], [4, 6]],
  },
  {
    name: "Cassiopeia",
    at: [955, 195],
    scale: 58,
    stars: [
      [0, 0.25, 2.3], // Caph
      [0.7, 0.8, 2.2], // Schedar
      [1.35, 0.35, 2.2], // Navi
      [2.0, 0.85, 2.7], // Ruchbah
      [2.65, 0.3, 3.4], // Segin
    ],
    links: [[0, 1], [1, 2], [2, 3], [3, 4]],
  },
  {
    name: "Cygnus",
    at: [245, 590],
    scale: 60,
    stars: [
      [0, 0, 1.25], // Deneb
      [0.95, 0.62, 2.2], // Sadr
      [2.35, 1.6, 3.1], // Albireo
      [0.35, 1.35, 2.5], // Gienah
      [1.5, -0.12, 2.9], // Fawaris
    ],
    links: [[0, 1], [1, 2], [3, 1], [1, 4]],
  },
  {
    name: "Lyra",
    at: [170, 385],
    scale: 62,
    stars: [
      [0, 0, 0.0], // Vega
      [0.32, -0.3, 4.6], // Epsilon
      [0.45, 0.38, 4.3], // Zeta
      [0.86, 0.28, 4.3], // Delta
      [0.68, 1.12, 3.5], // Sheliak
      [1.08, 0.98, 3.3], // Sulafat
    ],
    links: [[0, 1], [0, 2], [2, 3], [3, 5], [5, 4], [4, 2]],
  },
  {
    name: "Corona Borealis",
    at: [1045, 365],
    scale: 60,
    stars: [
      [0, 0, 4.1],
      [0.18, 0.55, 3.7],
      [0.55, 0.95, 2.2], // Alphecca
      [1.0, 1.08, 3.8],
      [1.42, 0.9, 4.6],
      [1.65, 0.48, 4.2],
      [1.62, 0.02, 4.1],
    ],
    links: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6]],
  },
];

/** The dark middle (empty-state text) as an ellipse the background dust stays out of. */
const CLEAR = { rx: 330, ry: 170 };
const DUST = 90;

interface Star {
  x: number;
  y: number;
  r: number;
  o: number;
  halo: boolean;
}

interface Hairline {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export function Constellation({ className = "" }: { className?: string }) {
  const chart = useMemo(build, []);
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const halo = `cst-halo-${uid}`;
  const arcFade = `cst-arcfade-${uid}`;
  const arcMask = `cst-arcmask-${uid}`;
  return (
    <svg
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 h-full w-full ${className}`}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid slice"
    >
      <defs>
        <radialGradient id={halo}>
          <stop offset="0" stopColor="var(--color-constellation-node)" stopOpacity="0.5" />
          <stop offset="1" stopColor="var(--color-constellation-node)" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={arcFade} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset="0.3" stopColor="#fff" stopOpacity="1" />
          <stop offset="0.7" stopColor="#fff" stopOpacity="1" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <mask id={arcMask} maskUnits="userSpaceOnUse" x="0" y="0" width={W} height={H}>
          <rect width={W} height={H} fill={`url(#${arcFade})`} />
        </mask>
      </defs>

      <g className="constellation-drift">
        {/* A declination arc, as printed on sky charts: the coordinate frame the figures sit in. */}
        <path
          d={chart.arc}
          fill="none"
          stroke="var(--color-constellation-line)"
          strokeWidth="1"
          strokeDasharray="2 7"
          vectorEffect="non-scaling-stroke"
          mask={`url(#${arcMask})`}
        />

        {chart.dust.map((s, i) => (
          <circle key={`d${i}`} cx={s.x} cy={s.y} r={s.r} fill="var(--color-constellation-node)" opacity={s.o} />
        ))}

        {chart.lines.map((l, i) => (
          <line
            key={`l${i}`}
            {...l}
            stroke="var(--color-constellation-line)"
            strokeWidth="1"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {chart.stars
          .filter((s) => s.halo)
          .map((s, i) => (
            <circle key={`h${i}`} className="constellation-halo" cx={s.x} cy={s.y} r={s.r * 4.5} fill={`url(#${halo})`} />
          ))}
        {chart.stars.map((s, i) => (
          <circle key={`s${i}`} cx={s.x} cy={s.y} r={s.r} fill="var(--color-constellation-node)" opacity={s.o} />
        ))}
      </g>
    </svg>
  );
}

const round = (v: number) => Math.round(v * 100) / 100;

/** mulberry32: a small deterministic PRNG whose successive values are well distributed. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Brighter stars (lower magnitude) are larger and more opaque, as on a printed atlas. */
const radius = (mag: number) => round(Math.min(3.8, Math.max(1.2, 3.7 - 0.52 * mag)));
const opacity = (mag: number) => round(Math.min(1, Math.max(0.5, 1.02 - 0.1 * mag)));
/** Hairlines stop this far short of a star's edge. */
const GAP = 4.5;

function build() {
  const stars: Star[] = [];
  const lines: Hairline[] = [];
  for (const f of FIGURES) {
    const xs = f.stars.map((s) => s[0]);
    const ys = f.stars.map((s) => s[1]);
    const mx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const my = (Math.min(...ys) + Math.max(...ys)) / 2;
    const placed = f.stars.map(([x, y, mag]) => ({
      x: round(f.at[0] + (x - mx) * f.scale),
      y: round(f.at[1] + (y - my) * f.scale),
      r: radius(mag),
      o: opacity(mag),
      halo: mag < 1.5,
    }));
    stars.push(...placed);
    for (const [i, j] of f.links) {
      const a = placed[i]!;
      const b = placed[j]!;
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      const ux = (b.x - a.x) / d;
      const uy = (b.y - a.y) / d;
      const sa = a.r + GAP;
      const sb = b.r + GAP;
      if (d <= sa + sb + 2) continue;
      lines.push({ x1: round(a.x + ux * sa), y1: round(a.y + uy * sa), x2: round(b.x - ux * sb), y2: round(b.y - uy * sb) });
    }
  }

  // Background dust: tiny unconnected stars, kept off the figures, the header band, the middle
  // and the composer, with a little spacing so the field reads as sky rather than noise.
  const rand = mulberry32(20261103);
  const dust: Star[] = [];
  for (let tries = 0; dust.length < DUST && tries < 5000; tries++) {
    const x = round(rand() * W);
    const y = round(50 + rand() * (H - 50));
    const inMiddle = ((x - CX) / CLEAR.rx) ** 2 + ((y - CY) / CLEAR.ry) ** 2 < 1;
    const underComposer = x > 320 && x < 880 && y > 610;
    if (inMiddle || underComposer) continue;
    if (stars.some((s) => Math.hypot(s.x - x, s.y - y) < 28)) continue;
    if (dust.some((s) => Math.hypot(s.x - x, s.y - y) < 34)) continue;
    const bright = rand();
    dust.push({ x, y, r: round(0.55 + bright * 0.6), o: round(0.18 + bright * 0.3), halo: false });
  }

  // One declination arc across the top of the chart, centred far below the canvas.
  const R = 3200;
  const oy = 92 + R;
  const half = Math.asin(560 / R);
  const p = (t: number) => `${round(CX + R * Math.sin(t))} ${round(oy - R * Math.cos(t))}`;
  const arc = `M${p(-half)} A${R} ${R} 0 0 1 ${p(half)}`;

  return { stars, lines, dust, arc };
}
