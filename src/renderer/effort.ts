import type { ModelRef, ModelsResponse } from "../shared/types";

/** "xhigh" → "Extra high", "medium" → "Medium". */
export function effortLabel(effort: string): string {
  if (effort === "xhigh") return "Extra high";
  return effort.charAt(0).toUpperCase() + effort.slice(1).replace(/[_-]/g, " ");
}

/** Effort levels from least to most thinking, across runtimes. */
const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** Whether `level` is above `cap` on the shared scale (false when either is not a known level). */
export function effortAbove(level: string, cap: string): boolean {
  const a = EFFORT_ORDER.indexOf(level);
  const b = EFFORT_ORDER.indexOf(cap);
  return a >= 0 && b >= 0 && a > b;
}

/** The effort levels of the model a session uses (its pick, else the runtime's default model). */
export function modelEfforts(models: ModelsResponse | null, model: ModelRef | null): string[] {
  const ref = model ?? models?.default ?? null;
  if (!models || !ref) return [];
  const found = models.providers.find((p) => p.id === ref.providerId)?.models.find((m) => m.id === ref.modelId);
  return found?.efforts ?? [];
}

/**
 * The options the picker offers: the model's levels, plus the session's current pick when the model
 * list doesn't have it (an older list, or a level set through the API), so the picker shows the truth.
 */
export function effortOptions(levels: readonly string[], current: string | null): string[] {
  return current && !levels.includes(current) ? [...levels, current] : [...levels];
}

/** The slider stop nearest a pointer at `fraction` (0 = left end, 1 = right end) of a track with `count` stops. */
export function stopAt(fraction: number, count: number): number {
  if (count <= 1) return 0;
  return Math.round(Math.min(1, Math.max(0, fraction)) * (count - 1));
}

/** Where a key moves the slider from `index` (null = no pick yet: the first move lands mid-track). */
export function stepEffort(index: number | null, key: string, count: number): number | null {
  if (count === 0) return null;
  const last = count - 1;
  if (key === "Home") return 0;
  if (key === "End") return last;
  const step = key === "ArrowRight" || key === "ArrowUp" ? 1 : key === "ArrowLeft" || key === "ArrowDown" ? -1 : 0;
  if (!step) return null;
  if (index === null) return Math.floor(last / 2);
  return Math.min(last, Math.max(0, index + step));
}
