/**
 * Track registry — the plugin seam, ported from garrigue's `registerTrack`.
 *
 * A track type is a width plus a `drawCell`. Registering one adds a column
 * beside the tree without touching the renderer, which is how Zahir will add
 * Pfam architecture, taxonomy strips and defense scores.
 */

import type { TrackDef, TrackInstance, TrackInitContext } from "./types";
import type { DrawTarget } from "./svg";

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
    // One scale for the whole column when the caller supplies a reference
    // length. Scaling each cell to its own length would draw every
    // architecture the same width and destroy the comparison the track is for.
    //
    // The reference does not have to be the longest protein present, and
    // usually should not be: on a family whose tail runs to 3,000 residues a
    // median 800-residue protein drew across a quarter of the column and the
    // other three quarters were blank — which reads as a gap before the next
    // column rather than as "these proteins are short". The caller picks the
    // reference; anything past it is clipped and marked.
    const full = track.vmax && track.vmax > 0 ? track.vmax : rec.length;
    const scale = w / full;
    const midY = y + h / 2;
    const clipped = rec.length > full;

    // The backbone IS the protein, so it runs to the protein's own length on
    // the shared scale. Drawing it full-width made every protein look the same
    // size and left only the domain boxes carrying any length information.
    const backbone = Math.min(w, Math.max(1, rec.length * scale));
    ctx.fillStyle = "#bbb";
    ctx.fillRect(x, midY - Math.max(0.5, h * 0.06), backbone, Math.max(1, h * 0.12));

    const boxH = Math.max(2, h * 0.7);
    for (const d of rec.domains ?? []) {
      const dx = x + d.start * scale;
      if (dx >= x + w) continue;
      // Clipped to the column, so a domain running past the reference length
      // cannot be drawn over the next column.
      const dw = Math.min(x + w - dx, Math.max(1, (d.end - d.start) * scale));
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

    // A protein longer than the reference is cut, and has to say so. Without
    // the mark a clipped architecture is indistinguishable from one that
    // happens to end exactly at the column edge, which is the reading that
    // makes a truncated protein look complete.
    if (clipped && h >= 3) {
      ctx.fillStyle = "#5a6270";
      ctx.fillRect(x + w - 1.5, midY - Math.max(1.5, h * 0.35), 1.5,
                   Math.max(3, h * 0.7));
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
  /**
   * Called by DefenseFinder under either annotator — Aleph's precomputed
   * `df_type` or Hoodini's own `deffinder_type`.
   *
   * The server folds the two into one boolean because the mark is the same
   * either way: "something here is a defence gene". Which annotator said so is
   * a question for the tooltip, where the two are shown apart because they can
   * legitimately disagree.
   */
  defense?: boolean;
  /** DefenseFinder re-run by Hoodini over this exact window. */
  deffinder_type?: string | null;
  deffinder_subtype?: string | null;
  deffinder_gene?: string | null;
  product?: string | null;
  /**
   * Pfam hits on this gene, overlaps already resolved by the server, in the
   * same relative base-pair coordinates as the gene. Drawn only when the track
   * is in `domainsOnGenes` mode.
   */
  domains?: LocusDomain[];
}

/** One Pfam hit placed on a neighbourhood gene. */
export interface LocusDomain {
  name: string;
  /** Start and end in base pairs, the same frame as `LocusGene.s`/`e`. */
  s: number;
  e: number;
  /** Residue range on the protein, for the tooltip. */
  from?: number;
  to?: number;
  /** HMMER bit score of this occurrence. */
  score?: number | null;
}

/**
 * The domain of `gene` covering base pair `bp`, if any.
 *
 * Shared by the hover test so the tooltip names the box under the pointer
 * from the same coordinates `drawCell` painted it with.
 */
export function locusDomainAt(gene: LocusGene, bp: number): LocusDomain | undefined {
  for (const d of gene.domains ?? []) if (bp >= d.s && bp <= d.e) return d;
  return undefined;
}

/**
 * Trace one gene's outline onto the current path, without painting it.
 *
 * A separate function because the shape is needed twice — once to fill and
 * once to clip the defence hatch to — and computing the arrow a second time by
 * hand is how a mark comes to sit a pixel off the gene it belongs to, which is
 * the drawing/hit-testing trap this renderer has already been caught by twice.
 * Free-standing rather than a closure in the draw loop: at fifteen genes a row
 * and several hundred rows a frame, a closure per gene is real allocation.
 */
function traceGene(
  ctx: DrawTarget,
  gx0: number,
  gx1: number,
  midY: number,
  boxH: number,
  head: number,
  fwd: boolean,
  plain: boolean,
): void {
  ctx.beginPath();
  if (plain) {
    ctx.rect(gx0, midY - boxH / 2, Math.max(1, gx1 - gx0), boxH);
  } else if (fwd) {
    ctx.moveTo(gx0, midY - boxH / 2);
    ctx.lineTo(gx1 - head, midY - boxH / 2);
    ctx.lineTo(gx1, midY);
    ctx.lineTo(gx1 - head, midY + boxH / 2);
    ctx.lineTo(gx0, midY + boxH / 2);
    ctx.closePath();
  } else {
    ctx.moveTo(gx1, midY - boxH / 2);
    ctx.lineTo(gx0 + head, midY - boxH / 2);
    ctx.lineTo(gx0, midY);
    ctx.lineTo(gx0 + head, midY + boxH / 2);
    ctx.lineTo(gx1, midY + boxH / 2);
    ctx.closePath();
  }
}

/** Perpendicular spacing of the defence hatch, in screen px. */
const HATCH_PX = 3;

/** Annotated, but not named by the palette — see the track's note. */
const UNRANKED = "#9aa3ad";

/** Not annotated at all. Deliberately lighter than `UNRANKED`. */
const UNKEYED = "#c9ced6";

/**
 * A gene's body when its domains carry the colour. Lighter than both greys
 * above, because here it is the ground the domains sit on rather than a
 * statement about the gene — and a rare domain drawn `UNRANKED` on top of it
 * has to stay visible.
 */
const GENE_BODY = "#e1e4e9";

/** The body's outline in domain mode, so abutting genes stay two genes. */
const GENE_EDGE = "#aab1bb";

/**
 * How many families a neighbourhood legend names before it stops.
 *
 * Two dozen is roughly where a list of swatches stops being scannable, and it
 * is also where colours stop being reliably tellable apart — so naming more
 * would be promising a distinction the eye cannot make anyway.
 */
const LEGEND_MAX = 24;

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
 * type), so the palette here means what Hoodini's viewer means by it. **The
 * palette is the whole answer**: a key it does not name is drawn `UNRANKED`,
 * and the caller decides which keys are in it. That is not a detail — Zahir
 * puts a family in the palette when it occurs beside at least N of the job's
 * neighbourhoods, N being a slider, so a key falling through to grey means
 * "too rare to be worth a colour at your current setting" and hashing it a
 * colour anyway would quietly overrule the control.
 *
 * The two greys therefore say different things and must not converge:
 * `UNRANKED` is *annotated but rare*, `UNKEYED` is *not annotated at all*. On
 * a real project 424k of 622k neighbours carry a Pfam family across 9,316
 * distinct families, so the second grey covers a third of the column and the
 * first covers however much of the rest the threshold decides.
 *
 * The target gene is outlined rather than recoloured, and a DefenseFinder call
 * is hatched rather than recoloured: both have to be findable without taking a
 * colour away from the annotation being read, and both have to be tellable
 * apart from each other, which is why one is an outline and one is a fill.
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
    // Pfam mode: a gene is one grey arrow and each of its domains a coloured
    // box on the stretch it covers, instead of the whole arrow taking the
    // colour of its single best hit — which hid every multi-domain protein's
    // other families and where on the gene any of them sat.
    const byDomain = !!track.domainsOnGenes;
    for (const g of rec.genes) {
      const gx0 = x + (g.s + span) * scale;
      const gx1 = x + (g.e + span) * scale;
      const gw = Math.max(1, gx1 - gx0);
      // The palette decides. A keyed gene it does not name is rare rather than
      // unannotated, and gets the darker of the two greys; see the track note.
      ctx.fillStyle = byDomain
        ? GENE_BODY
        : g.key ? (track.palette?.[g.key] ?? UNRANKED) : UNKEYED;

      const plain = gw <= head * 1.5 || boxH < 4;

      if (plain) {
        // Too narrow for an arrow head; a plain box at least keeps the gene
        // visible, which matters more at this size than its direction. Drawn
        // with fillRect rather than through `traceGene`, which keeps it a
        // `<rect>` in an export instead of a four-point path.
        ctx.fillRect(gx0, midY - boxH / 2, gw, boxH);
      } else {
        traceGene(ctx, gx0, gx1, midY, boxH, head, g.fwd, false);
        ctx.fill();
      }

      if (byDomain && g.domains?.length) {
        // Clipped to the gene's own outline so a domain at the tip of an arrow
        // takes the arrow head's shape rather than squaring it off. The same
        // palette rule as whole genes: a family it does not name is rare at
        // the current threshold and gets the rare grey.
        ctx.save();
        traceGene(ctx, gx0, gx1, midY, boxH, head, g.fwd, plain);
        ctx.clip();
        for (const d of g.domains) {
          const dx0 = x + (d.s + span) * scale;
          const dx1 = x + (d.e + span) * scale;
          ctx.fillStyle = track.palette?.[d.name] ?? UNRANKED;
          ctx.fillRect(dx0, midY - boxH / 2, Math.max(1, dx1 - dx0), boxH);
        }
        ctx.restore();
      }
      if (byDomain && boxH >= 4) {
        traceGene(ctx, gx0, gx1, midY, boxH, head, g.fwd, plain);
        ctx.strokeStyle = GENE_EDGE;
        ctx.lineWidth = 0.75;
        ctx.stroke();
      }

      // A DefenseFinder call, hatched over whatever colour the gene already
      // has. Recolouring it would mean choosing between "this is a defence
      // gene" and "this is a Cap4 family", and the column exists to be read
      // for both at once. Below four pixels the lines are closer together than
      // the shape is tall, so the hatch reads as a smudge rather than as a
      // mark — the same threshold the arrow head and the self-outline use.
      if (g.defense && boxH >= 4) {
        ctx.save();
        traceGene(ctx, gx0, gx1, midY, boxH, head, g.fwd, plain);
        ctx.clip();
        ctx.strokeStyle = "rgba(0,0,0,0.55)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        const yTop = midY - boxH / 2;
        const yBot = midY + boxH / 2;
        // Lines of x = y + c, so 45° down-right. Perpendicular spacing is
        // c-spacing / sqrt(2); the loop only walks the range of c that can
        // cross the box at all, because the clip hides the rest but an export
        // would still carry every one of them as a path.
        const step = HATCH_PX * Math.SQRT2;
        const c0 = Math.ceil((gx0 - yBot) / step) * step;
        for (let c = c0; c <= gx1 - yTop; c += step) {
          ctx.moveTo(c + yTop, yTop);
          ctx.lineTo(c + yBot, yBot);
        }
        ctx.stroke();
        ctx.restore();
      }

      if (g.self && boxH >= 4) {
        ctx.strokeStyle = "#101418";
        ctx.lineWidth = 1;
        ctx.strokeRect(gx0 - 0.5, midY - boxH / 2 - 0.5, gw + 1, boxH + 1);
      }
    }
  },
  /**
   * Capped, because the palette is no longer a shortlist.
   *
   * Every ranked key now has an entry — thousands of them on a real project —
   * and a legend of thousands of rows is not a legend. The palette is built in
   * rank order and object keys keep insertion order, so the head of it is the
   * families that recur in the most loci, which is the only part worth naming;
   * the tail is identifiable by hovering a gene.
   */
  legend(track) {
    const all = Object.entries(track.palette ?? {});
    const out = all.slice(0, LEGEND_MAX).map(([label, color]) => ({ label, color }));
    if (all.length > LEGEND_MAX) {
      out.push({ label: `+${all.length - LEGEND_MAX} more`, color: UNRANKED });
    }
    return out;
  },
});
