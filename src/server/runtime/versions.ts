/**
 * The CLI versions Peer was tested with. `max` may be a "major.minor" prefix, meaning any patch
 * release of it. Outside the range Peer still runs the CLI, but says so: Codex's app-server API
 * that Peer uses for checkpoints is experimental, and Claude Code's SDK protocol tracks 2.1.x.
 */
export interface TestedVersions {
  min: string;
  max: string;
}

export const TESTED_VERSIONS = {
  claude: { min: "2.1.0", max: "2.1" },
  codex: { min: "0.163.0", max: "0.163" },
} satisfies Record<string, TestedVersions>;

/** Numeric parts of a version, ignoring a pre-release or build suffix ("0.164.0-alpha.1" -> [0, 164, 0]). */
function parts(version: string): number[] | null {
  const match = /^v?(\d+(?:\.\d+)*)/.exec(version.trim());
  return match ? match[1]!.split(".").map(Number) : null;
}

/** Compare a version with a bound, only as far as the bound has parts ("2.1.309" vs "2.1" -> 0). */
function compareTo(version: number[], bound: number[]): number {
  for (let i = 0; i < bound.length; i++) {
    const d = (version[i] ?? 0) - bound[i]!;
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

function describe(range: TestedVersions): string {
  const max = range.max.split(".").length < 3 ? `${range.max}.x` : range.max;
  return `${range.min}.`.startsWith(`${range.max}.`) ? max : `${range.min} to ${max}`;
}

/**
 * A warning when `version` is outside the tested range, else undefined. An unparseable version
 * gets no warning: the CLI already answered `--version`, and guessing would only add noise.
 */
export function versionWarning(name: string, version: string | undefined, range: TestedVersions, update: string): string | undefined {
  const v = version ? parts(version) : null;
  const min = parts(range.min);
  const max = parts(range.max);
  if (!v || !min || !max) return undefined;
  const tested = describe(range);
  if (compareTo(v, min) < 0) return `${name} ${version} is older than the versions Peer was tested with (${tested}). If sessions misbehave, update it (${update}).`;
  if (compareTo(v, max) > 0) return `${name} ${version} is newer than the versions Peer was tested with (${tested}). Peer may not work correctly with it; if sessions misbehave, install ${tested}.`;
  return undefined;
}
