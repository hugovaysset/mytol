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

/**
 * A stable colour for a category with no palette entry.
 *
 * Some columns have more categories than any palette can carry — genus runs to
 * thousands — and the server caps the domain it sends. Anything past the cap
 * used to fall back to one flat grey, so most of a genus strip looked like a
 * single enormous category. Hashing the name instead gives every value its own
 * colour, the same colour in every session, without shipping a palette of
 * thousands of entries.
 */
/**
 * A fixed wheel of colours chosen to be told apart at a glance.
 *
 * The previous version mapped a hash to a **continuous** hue, which meant two
 * keys could land three degrees apart and be indistinguishable — reported as
 * "often colours are very similar and it's hard to spot that we are actually
 * at two different protein families". A continuous space has no floor on how
 * close two colours can be.
 *
 * So the space is quantised instead. Hues step by the golden angle, which
 * spreads consecutive entries as far apart as a circle allows, and each turn
 * around the wheel changes saturation and lightness together — so entries that
 * do land on a similar hue differ in weight instead. Two families now either
 * share a colour outright or clearly differ, and "clearly the same" is a much
 * easier reading than "probably the same".
 */
const GOLDEN_ANGLE = 137.508;

/** Saturation/lightness bands, walked once per turn of the hue wheel. */
const HASH_BANDS: Array<[number, number]> = [
  [70, 47], [52, 66], [86, 36], [63, 76], [78, 56], [45, 28],
];

export const HASH_WHEEL: string[] = (() => {
  const out: string[] = [];
  for (let i = 0; i < 240; i++) {
    const [sat, light] = HASH_BANDS[Math.floor(i / 40) % HASH_BANDS.length];
    out.push(hslToHex((i * GOLDEN_ANGLE) % 360, sat, light));
  }
  return out;
})();

export function hashColor(key: string): string {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return HASH_WHEEL[(h >>> 0) % HASH_WHEEL.length];
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

/** tab20's pale companions, used to extend deep past ten categories. */
const TAB20_PALE = TAB20.filter((_, i) => i % 2 === 1);

/**
 * The palette a categorical track should use, by how many categories it has.
 *
 * Deep is the default and stays the default past ten: rather than switching
 * wholesale to tab20 — which would repaint every category the moment an
 * eleventh appeared, and hand some of the first ten tab20's greys — the first
 * ten keep their deep colours and the rest take tab20's pale companions. Read
 * with the domain in frequency order, that puts the strongest colours on the
 * categories most of the data is in.
 *
 * Beyond twenty no named palette helps, so hues are spread evenly instead.
 */
export function paletteFor(n: number): string[] {
  if (n <= DEEP.length) return DEEP;
  if (n <= DEEP.length + TAB20_PALE.length) return [...DEEP, ...TAB20_PALE];
  return spreadColors(n);
}

/**
 * Colours for a domain that already arrives in a meaningful order.
 *
 * Unlike `autoPalette`, which sorts to defend against caller-dependent
 * ordering, this trusts the order it is given: the server returns a column's
 * domain commonest-first, and spending the strongest colours on the categories
 * that dominate the view is the whole point.
 */
export function paletteFromDomain(domain: string[]): Record<string, string> {
  const seen = Array.from(new Set(domain));
  const cols = paletteFor(seen.length);
  const out: Record<string, string> = {};
  seen.forEach((c, i) => {
    out[c] = cols[i % cols.length];
  });
  return out;
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
    const k = String(v);
    ctx.fillStyle = track.palette?.[k] ?? hashColor(k);
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
  wideRing: true,
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
  // Depth is what this track needs; a 26px ring cannot show a layout.
  wideRing: true,
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
    // One scale for the whole column when the caller supplies the longest
    // protein. Scaling each cell to its own length would draw every
    // architecture the same width and destroy the comparison the track is for.
    const full = track.vmax && track.vmax > 0 ? track.vmax : rec.length;
    const scale = w / full;
    const midY = y + h / 2;

    // The backbone IS the protein, so it runs to the protein's own length on
    // the shared scale. Drawing it full-width made every protein look the same
    // size and left only the domain boxes carrying any length information.
    const backbone = Math.max(1, rec.length * scale);
    ctx.fillStyle = "#bbb";
    ctx.fillRect(x, midY - Math.max(0.5, h * 0.06), backbone, Math.max(1, h * 0.12));

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

/** One gene in a genomic neighbourhood, in coordinates relative to its target. */
export interface LocusGene {
  acc: string;
  /** Start and end in base pairs from the middle of the target gene. */
  s: number;
  e: number;
  /** Pointing right after the locus has been oriented on its target. */
  fwd: boolean;
  /** What the colour is keyed on — family, Pfam, DefenseFinder type. */
  key: string | null;
  /** True for the target gene itself. */
  self?: boolean;
  cluster?: number | null;
  pfam?: string | null;
  /** The `PFxxxxx` accession, which is what InterPro is addressable by. */
  pfam_acc?: string | null;
  df_type?: string | null;
  df_subtype?: string | null;
  df_gene?: string | null;
  product?: string | null;
}

export interface LocusRecord {
  target: string;
  /** Base pairs drawn each side of the target. The column's shared scale. */
  span: number;
  genes: LocusGene[];
}

/**
 * The genomic neighbourhood around each tip, as a row of gene arrows.
 *
 * Every locus is drawn on **one shared scale**, centred on its target gene and
 * oriented so the target points right — the server does that normalisation.
 * Both halves are what make the column readable: the same operon seen in two
 * assemblies otherwise lands at two offsets, pointing two ways, and comparing
 * neighbourhoods down the tree becomes impossible, which is the only thing
 * this track is for.
 *
 * Colour is a key the server chose (homology family, Pfam, DefenseFinder
 * type), so the palette here means what Hoodini's viewer means by it. The
 * target gene is outlined rather than recoloured: it has to be findable
 * without taking a colour away from the annotation being read.
 */
registerTrack("neighbourhood", {
  width: 260,
  // A locus is fifteen genes across; a 26px ring cannot show one.
  wideRing: true,
  init(track) {
    if (!track.palette && track.values) {
      const keys = new Set<string>();
      for (const rec of track.values as Array<LocusRecord | undefined>) {
        if (!rec) continue;
        for (const g of rec.genes ?? []) if (g.key) keys.add(g.key);
      }
      track.palette = autoPalette(Array.from(keys).sort());
    }
  },
  drawCell(ctx, x, y, w, h, leafIndex, track) {
    const rec = track.values?.[leafIndex] as LocusRecord | undefined;
    if (!rec || !rec.genes?.length) return;
    const span = rec.span || 20000;
    const scale = w / (2 * span);
    const midY = y + h / 2;

    // The contig runs the full width: the arrows sit on it, and without it a
    // sparse locus reads as a few unrelated boxes rather than one region.
    ctx.fillStyle = "#d5d8dd";
    ctx.fillRect(x, midY - Math.max(0.4, h * 0.04), w, Math.max(1, h * 0.08));

    const boxH = Math.max(2, h * 0.66);
    const head = Math.min(boxH * 0.6, 5);
    for (const g of rec.genes) {
      const gx0 = x + (g.s + span) * scale;
      const gx1 = x + (g.e + span) * scale;
      const gw = Math.max(1, gx1 - gx0);
      ctx.fillStyle = g.key ? (track.palette?.[g.key] ?? "#9aa3ad") : "#c9ced6";

      if (gw <= head * 1.5 || boxH < 4) {
        // Too narrow for an arrow head; a plain box at least keeps the gene
        // visible, which matters more at this size than its direction.
        ctx.fillRect(gx0, midY - boxH / 2, gw, boxH);
      } else {
        ctx.beginPath();
        if (g.fwd) {
          ctx.moveTo(gx0, midY - boxH / 2);
          ctx.lineTo(gx1 - head, midY - boxH / 2);
          ctx.lineTo(gx1, midY);
          ctx.lineTo(gx1 - head, midY + boxH / 2);
          ctx.lineTo(gx0, midY + boxH / 2);
        } else {
          ctx.moveTo(gx1, midY - boxH / 2);
          ctx.lineTo(gx0 + head, midY - boxH / 2);
          ctx.lineTo(gx0, midY);
          ctx.lineTo(gx0 + head, midY + boxH / 2);
          ctx.lineTo(gx1, midY + boxH / 2);
        }
        ctx.closePath();
        ctx.fill();
      }

      if (g.self && boxH >= 4) {
        ctx.strokeStyle = "#101418";
        ctx.lineWidth = 1;
        ctx.strokeRect(gx0 - 0.5, midY - boxH / 2 - 0.5, gw + 1, boxH + 1);
      }
    }
  },
  legend(track) {
    return Object.entries(track.palette ?? {}).map(([label, color]) => ({ label, color }));
  },
});
