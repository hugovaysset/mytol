/**
 * Track registry — the plugin seam, ported from garrigue's `registerTrack`.
 *
 * A track type is a width plus a `drawCell`. Registering one adds a column
 * beside the tree without touching the renderer, which is how Zahir will add
 * Pfam architecture, taxonomy strips and defense scores.
 */

import type { TrackDef, TrackInstance, TrackInitContext } from "./types";

const registry = new Map<string, TrackDef<never>>();

export function registerTrack<T extends TrackInstance>(type: string, def: TrackDef<T>): void {
  registry.set(type, def as unknown as TrackDef<never>);
}

export function getTrack(type: string): TrackDef<never> | undefined {
  return registry.get(type);
}

export function registeredTrackTypes(): string[] {
  return Array.from(registry.keys());
}

export function initTrack(track: TrackInstance, ctx: TrackInitContext): void {
  const def = registry.get(track.type);
  def?.init?.(track as never, ctx);
}

// ============================================================
// Shared helpers
// ============================================================

/** Colour-blind-friendly qualitative palette (garrigue's). */
export const PALETTE = [
  "#e6194B", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#42d4f4",
  "#f032e6", "#bfef45", "#469990", "#9A6324", "#800000", "#000075",
];

/** Tableau-style palette, mytol's default. */
export const CAT_COLORS = [
  "#4c78a8", "#f58518", "#e45756", "#72b7b2", "#54a24b",
  "#eeca3b", "#b279a2", "#ff9da6", "#9d755d", "#bab0ac",
];

/** Seaborn's "deep" — the default for up to 10 categories. */
export const DEEP = [
  "#4C72B0", "#DD8452", "#55A868", "#C44E52", "#8172B3",
  "#937860", "#DA8BC3", "#8C8C8C", "#CCB974", "#64B5CD",
];

/** matplotlib tab20 — the default for 11 to 20 categories. */
export const TAB20 = [
  "#1f77b4", "#aec7e8", "#ff7f0e", "#ffbb78", "#2ca02c", "#98df8a", "#d62728",
  "#ff9896", "#9467bd", "#c5b0d5", "#8c564b", "#c49c94", "#e377c2", "#f7b6d2",
  "#7f7f7f", "#c7c7c7", "#bcbd22", "#dbdb8d", "#17becf", "#9edae5",
];

/**
 * Well-spread colours for more categories than any named palette covers.
 *
 * Hues advance by the golden angle, which spreads them evenly however many are
 * asked for, and lightness/saturation cycle so neighbouring hues stay
 * distinguishable. Deterministic in the index, not actually random: the user
 * asked for stable colours, and a palette that changes between sessions is
 * worse than one that merely repeats.
 */
export function spreadColors(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const h = (i * 137.508) % 360;
    const s = [68, 52, 80][i % 3];
    const l = [52, 38, 64][(i + 1) % 3];
    out.push(hslToHex(h, s, l));
  }
  return out;
}

function hslToHex(h: number, s: number, l: number): string {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (k: number) => {
    const m = (k + h / 30) % 12;
    const v = l / 100 - a * Math.max(-1, Math.min(m - 3, 9 - m, 1));
    return Math.round(255 * v)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * The palette a categorical track should use, chosen by how many categories it
 * has: deep up to 10, tab20 up to 20, spread colours beyond.
 */
export function paletteFor(n: number): string[] {
  if (n <= DEEP.length) return DEEP;
  if (n <= TAB20.length) return TAB20;
  return spreadColors(n);
}

/** matplotlib "Reds", the default continuous ramp. */
export const REDS = [
  "#fff5f0", "#fee0d2", "#fcbba1", "#fc9272", "#fb6a4a",
  "#ef3b2c", "#cb181d", "#a50f15", "#67000d",
];

/** A continuous colour scale with an optional off-centre midpoint. */
export interface Ramp {
  colors: string[];
  vmin: number;
  vmax: number;
  /** Value that lands halfway along the ramp. Defaults to the true middle. */
  vmid?: number;
  /** Colour for exactly vmin (or below), when it should stand apart. */
  zeroColor?: string;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/**
 * Sample a ramp.
 *
 * `vmid` bends the scale: values below it use the lower half of the colours and
 * values above it the upper half. Defense scores need this — almost everything
 * sits near zero, so a linear scale over the full range leaves the whole column
 * looking blank.
 */
export function rampColor(v: number, ramp: Ramp): string | null {
  if (v == null || Number.isNaN(v)) return null;
  const { colors, vmin, vmax } = ramp;
  if (ramp.zeroColor != null && v <= vmin) return ramp.zeroColor;
  const mid = ramp.vmid ?? (vmin + vmax) / 2;
  let t: number;
  if (v <= mid) {
    t = mid > vmin ? (0.5 * (v - vmin)) / (mid - vmin) : 0;
  } else {
    t = vmax > mid ? 0.5 + (0.5 * (v - mid)) / (vmax - mid) : 1;
  }
  t = Math.max(0, Math.min(1, t));
  const pos = t * (colors.length - 1);
  const i = Math.min(colors.length - 2, Math.floor(pos));
  const f = pos - i;
  const a = hexToRgb(colors[i]);
  const b = hexToRgb(colors[i + 1]);
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(
    a[1] + (b[1] - a[1]) * f,
  )},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
}

/**
 * Assign a colour per category, deterministically.
 *
 * Categories are SORTED before assignment. Insertion order would otherwise
 * decide the colours, and insertion order here is leaf order — so rerooting or
 * rotating the tree silently repainted every annotation, which makes the
 * colours useless for comparing one view against another.
 *
 * Sorting fixes the ordering but not the domain: if the set of categories
 * changes (after a prune, say) the remaining ones still shift. Callers that
 * need colours stable across edits should pass the full domain once, rather
 * than letting it be inferred from whatever is currently on screen.
 */
export function autoPalette(
  categories: Iterable<string>,
  colors?: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  const sorted = Array.from(new Set(categories)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  // Sizing the palette to the category count is what keeps one category to one
  // colour: a fixed 12-colour list silently reuses colours past the twelfth.
  const cols = colors ?? paletteFor(sorted.length);
  sorted.forEach((c, i) => {
    out[c] = cols[i % cols.length];
  });
  return out;
}

/** Blue -> white -> red diverging ramp. */
export function heatColor(v: number, vmin: number, vmax: number): string | null {
  if (v == null || Number.isNaN(v)) return null;
  let t = (v - vmin) / (vmax - vmin || 1);
  t = Math.max(0, Math.min(1, t));
  let r: number;
  let g: number;
  let b: number;
  if (t < 0.5) {
    const u = t * 2;
    r = 255 * u + 33 * (1 - u);
    g = 255 * u + 102 * (1 - u);
    b = 255 * u + 172 * (1 - u);
  } else {
    const u = (t - 0.5) * 2;
    r = 178 * u + 255 * (1 - u);
    g = 24 * u + 255 * (1 - u);
    b = 43 * u + 255 * (1 - u);
  }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

// ============================================================
// Built-in track types
// ============================================================

/** One categorical colour block per leaf. */
registerTrack("colorstrip", {
  width: 18,
  init(track, ctx) {
    if (!track.palette && track.values) {
      const cats = track.values.filter((v) => v != null).map(String);
      track.palette = autoPalette(cats);
    }
    void ctx;
  },
  drawCell(ctx, x, y, w, h, leafIndex, track) {
    const v = track.values?.[leafIndex];
    if (v == null) return;
    ctx.fillStyle = track.palette?.[String(v)] ?? "#888";
    ctx.fillRect(x, y, w, h);
  },
  legend(track) {
    return Object.entries(track.palette ?? {}).map(([label, color]) => ({ label, color }));
  },
});

/** Presence/absence square. */
registerTrack("binary", {
  width: 16,
  drawCell(ctx, x, y, w, h, leafIndex, track) {
    const v = track.values?.[leafIndex];
    if (!v) return;
    ctx.fillStyle = track.color ?? "#2b6cb0";
    const pad = Math.min(2, h * 0.15);
    ctx.fillRect(x + pad, y + pad, w - 2 * pad, h - 2 * pad);
  },
  legend(track) {
    return [{ label: track.label, color: track.color ?? "#2b6cb0" }];
  },
});

/** Per-leaf text column. Skips itself when rows are too short to read. */
registerTrack("text", {
  width: 90,
  drawCell(ctx, x, y, w, h, leafIndex, track) {
    if (h < 7) return;
    const v = track.values?.[leafIndex];
    if (v == null) return;
    ctx.fillStyle = track.color ?? "#222";
    ctx.font = `${Math.min(12, Math.max(6, h - 2))}px system-ui, sans-serif`;
    ctx.textBaseline = "middle";
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.fillText(String(v), x + 2, y + h / 2);
    ctx.restore();
  },
});

/** Continuous value as a diverging heat cell. */
registerTrack("heatmap", {
  width: 18,
  init(track) {
    if (track.numeric && (track.vmin == null || track.vmax == null)) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const v of track.numeric) {
        if (Number.isNaN(v)) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      track.vmin = track.vmin ?? (Number.isFinite(lo) ? lo : 0);
      track.vmax = track.vmax ?? (Number.isFinite(hi) ? hi : 1);
    }
  },
  drawCell(ctx, x, y, w, h, leafIndex, track) {
    const v = track.numeric?.[leafIndex];
    if (v == null || Number.isNaN(v)) return;
    const c = heatValueColor(v, track);
    if (!c) return;
    ctx.fillStyle = c;
    ctx.fillRect(x, y, w, h);
  },
});

/** The colour a continuous track gives a value: its own ramp, or Reds. */
export function heatValueColor(v: number, track: TrackInstance): string | null {
  const ramp = track.ramp as Ramp | undefined;
  if (ramp) return rampColor(v, ramp);
  return rampColor(v, { colors: REDS, vmin: track.vmin ?? 0, vmax: track.vmax ?? 1 });
}

/** Continuous value as a bar. */
registerTrack("bar", {
  width: 60,
  init(track) {
    if (track.numeric && track.vmax == null) {
      let hi = -Infinity;
      for (const v of track.numeric) if (!Number.isNaN(v) && v > hi) hi = v;
      track.vmax = Number.isFinite(hi) ? hi : 1;
    }
  },
  drawCell(ctx, x, y, w, h, leafIndex, track) {
    const v = track.numeric?.[leafIndex];
    if (v == null || Number.isNaN(v)) return;
    const max = track.vmax ?? 1;
    const frac = max > 0 ? Math.max(0, Math.min(1, v / max)) : 0;
    ctx.fillStyle = track.color ?? "#7fa8bd";
    ctx.fillRect(x, y + h * 0.1, w * frac, h * 0.8);
  },
});

/**
 * Pfam-style domain architecture.
 *
 * `values[leafIndex]` is `{ length, domains: [{name, start, end}] }` — which is
 * exactly the shape Zahir's existing /api/domains endpoint already returns.
 */
export interface DomainRecord {
  length: number;
  domains: Array<{ name: string; start: number; end: number }>;
}

registerTrack("domains", {
  width: 220,
  init(track) {
    if (!track.palette && track.values) {
      const names = new Set<string>();
      for (const rec of track.values as Array<DomainRecord | undefined>) {
        if (!rec) continue;
        for (const d of rec.domains ?? []) names.add(d.name);
      }
      track.palette = autoPalette(Array.from(names).sort());
    }
  },
  drawCell(ctx, x, y, w, h, leafIndex, track) {
    const rec = track.values?.[leafIndex] as DomainRecord | undefined;
    if (!rec || !rec.length) return;
    const scale = w / rec.length;
    const midY = y + h / 2;

    // backbone
    ctx.fillStyle = "#bbb";
    ctx.fillRect(x, midY - Math.max(0.5, h * 0.06), w, Math.max(1, h * 0.12));

    const boxH = Math.max(2, h * 0.7);
    for (const d of rec.domains ?? []) {
      const dx = x + d.start * scale;
      const dw = Math.max(1, (d.end - d.start) * scale);
      ctx.fillStyle = track.palette?.[d.name] ?? "#888";
      ctx.fillRect(dx, midY - boxH / 2, dw, boxH);
      if (dw > 22 && boxH >= 8) {
        ctx.fillStyle = "#fff";
        ctx.font = `${Math.min(10, boxH - 2)}px system-ui, sans-serif`;
        ctx.textBaseline = "middle";
        ctx.save();
        ctx.beginPath();
        ctx.rect(dx, midY - boxH / 2, dw, boxH);
        ctx.clip();
        ctx.fillText(d.name, dx + 2, midY);
        ctx.restore();
      }
    }
  },
  legend(track) {
    return Object.entries(track.palette ?? {}).map(([label, color]) => ({ label, color }));
  },
});
