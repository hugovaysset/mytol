/**
 * Renderer-facing types: what to draw, how it is transformed, and how it looks.
 *
 * All of it is plain data. The renderer never reaches for React state, and the
 * style comes in as tokens rather than hardcoded colours, so a host app can
 * hand over its own CSS custom properties and get a tree that matches its
 * theme in both light and dark mode.
 */

import type { Tree, Uid } from "@mytol/core";
import type { DrawTarget } from "./svg";

export type LayoutMode = "rect" | "circular" | "unrooted";

export interface ViewState {
  mode: LayoutMode;
  /** Phylogram (x = branch length) vs cladogram. */
  phylogram: boolean;
  /** Pan offset in screen pixels. */
  panX: number;
  panY: number;
  /**
   * Vertical zoom, rectangular mode only.
   *
   * Kept separate from `zoom` on purpose: for a tree with tens of thousands of
   * leaves you almost always want to stretch vertically to separate rows while
   * the horizontal branch-length axis stays fitted to the panel. garrigue's
   * single uniform zoom cannot express that.
   */
  vZoom: number;
  /** Uniform zoom, circular and unrooted modes. */
  zoom: number;
  /** Circular layout: where the arc starts, in degrees. */
  rotation: number;
  /** Circular layout: how much of the circle the leaves span, in degrees. */
  arc: number;
  /**
   * Which quantile of the LEAF positions the view frames on.
   *
   * 1 means "fit the deepest tip", which lets a single long branch decide the
   * scale for everything else — on the SIR2 tree the deepest tip sits at 15.9
   * against a 90th percentile of 4.9, so one outlier squeezes nine tenths of
   * the tree into under a third of the panel. Framing on the quantile keeps
   * the bulk legible and puts the annotation tracks just beyond it.
   */
  fitQuantile: number;
}

export function defaultView(): ViewState {
  return {
    mode: "rect",
    phylogram: true,
    panX: 0,
    panY: 0,
    vZoom: 1,
    zoom: 1,
    rotation: 0,
    arc: 350,
    fitQuantile: 0.9,
  };
}

export interface StyleTokens {
  background: string;
  branch: string;
  text: string;
  textMuted: string;
  accent: string;
  /** Fill for the hovered clade band/wedge. */
  hover: string;
  /** Fill for the pinned clade. */
  pinned: string;
  /** Highlight for leaves passing the host's filter. */
  selected: string;
  /** Colour for leaves the host's filter excludes. */
  dimmed: string;
  fontFamily: string;
  /** Base branch thickness in px. */
  branchWidth: number;
  /**
   * Clades whose on-screen height falls below this are not drawn at all.
   * This single number is what keeps drawing O(visible pixels) rather than
   * O(nodes), and is why a 500k-leaf tree stays interactive zoomed out.
   */
  lodMinPx: number;
  showLeafLabels: boolean;
  showSupport: boolean;
  colorBySupport: boolean;

  /**
   * Horizontal extent of the tree in px, or null to let it take whatever the
   * annotation columns leave.
   *
   * Pinning it makes the tree's width a property of the tree rather than a
   * consequence of which columns happen to be switched on: turn a wide locus
   * column on and off and the branches stay exactly where they were, which is
   * what makes it possible to compare two screenshots at all.
   */
  treeWidth: number | null;

  /**
   * Colour ramp for branch support, low to high.
   *
   * Three stops rather than two: support is not uniformly distributed — most
   * branches in a large tree sit near the top of the range — so a two-colour
   * ramp puts almost everything at one end and shows nothing. A midpoint lets
   * the scale be pushed to where the interesting variation actually is.
   */
  supportRamp: { low: string; mid: string; high: string };
  /** Where `mid` sits within [supportMin, supportMax]. */
  supportMidpoint: number;
  /**
   * The range of support the ramp spans. Values outside it clamp to the ends.
   *
   * Support is rarely spread over the whole 0..1 interval — on a large tree
   * most branches sit near the top — so a ramp fixed to 0..1 wastes most of its
   * range on values that do not occur. Narrowing the domain to where the data
   * actually is turns a flat picture into a readable one.
   */
  supportMin: number;
  supportMax: number;
  /** Colour for branches carrying no support value at all. */
  supportAbsent: string;
}

export function defaultStyle(): StyleTokens {
  return {
    background: "#ffffff",
    branch: "#333333",
    text: "#1a2027",
    textMuted: "#6b7684",
    accent: "#1f5673",
    hover: "rgba(31, 86, 115, 0.16)",
    pinned: "rgba(31, 86, 115, 0.28)",
    selected: "#1f5673",
    dimmed: "#c9ced6",
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    branchWidth: 1,
    lodMinPx: 1.5,
    showLeafLabels: true,
    showSupport: false,
    treeWidth: null,
    // On by default. Support is the first thing you want to know about a
    // branch before believing anything the topology says, and a tree drawn in
    // one flat colour quietly invites you to trust every split equally.
    colorBySupport: true,
    // Black at the bottom of the range to bright green at the top. The domain
    // starts at 0.8 because below that a split is not worth reading: on the
    // SIR2 tree the median is 0.90, so a 0..1 ramp spends most of its range
    // where almost nothing lives.
    supportRamp: { low: "#000000", mid: "#0f7a3d", high: "#19e06a" },
    supportMidpoint: 0.5,
    supportMin: 0.8,
    supportMax: 1,
    supportAbsent: "#b0b6be",
  };
}

/**
 * A track type. This is the extension seam ported from garrigue: a host adds a
 * column beside the tree by registering one of these, with no change to the
 * renderer. Zahir uses it for Pfam architecture, taxonomy and defense score.
 */
export interface TrackDef<T extends TrackInstance = TrackInstance> {
  /** Column width in screen px. May be overridden per instance. */
  width: number;
  /**
   * Keep the track's full width when drawn as a circular ring.
   *
   * Rings are normally capped narrow: on a circle the circumference is
   * plentiful and radius is scarce. Tracks that encode a magnitude ALONG the
   * radius — a bar, a domain layout — have nothing left to say at 26px.
   */
  wideRing?: boolean;
  /** Called once when the track is attached, to precompute scales/palettes. */
  init?(track: T, ctx: TrackInitContext): void;
  /**
   * Draw one leaf's cell. Called only for leaves that survive culling and LOD.
   *
   * The context is the drawing subset, not the full canvas interface, because
   * the same call has to work against the SVG recorder an export runs through.
   * A track that reaches for `drawImage` would not survive that, and would fail
   * here rather than silently vanish from every exported figure.
   */
  drawCell(
    ctx: DrawTarget,
    x: number,
    y: number,
    w: number,
    h: number,
    leafIndex: number,
    track: T,
  ): void;
  /** Legend entries, for the host to render however it likes. */
  legend?(track: T): Array<{ label: string; color: string }>;
}

export interface TrackInitContext {
  tree: Tree;
  /** Resolve a leaf index to its label. */
  leafName(leafIndex: number): string;
}

/**
 * One attached track.
 *
 * `values` is indexed by LEAF INDEX, not keyed by leaf name. garrigue looked up
 * `track.data[leafName]` inside drawCell, i.e. a string hash per cell per
 * frame; resolving to a flat array once at attach time removes that from the
 * draw loop entirely.
 */
export interface TrackInstance {
  type: string;
  label: string;
  width?: number;
  visible: boolean;
  /** Per-leaf values, indexed by leaf index. */
  values?: Array<unknown>;
  /** Per-leaf numeric values, for continuous tracks. */
  numeric?: Float64Array;
  palette?: Record<string, string>;
  vmin?: number;
  vmax?: number;
  /** Continuous scale for numeric tracks; see `Ramp` in the registry. */
  ramp?: {
    colors: string[];
    vmin: number;
    vmax: number;
    vmid?: number;
    zeroColor?: string;
  };
  color?: string;
  [key: string]: unknown;
}

/** A clade painted a colour, addressed by stable uid. */
export interface RangeInstance {
  nodeUid: Uid;
  color: string;
  label?: string;
}

export type RangeDisplayMode = "background" | "branches";

/** Everything that can be highlighted, independent of the tree itself. */
export interface HighlightState {
  /**
   * One byte per leaf index: 1 when the leaf passes the host's filter.
   * Undefined means "no filter active" and everything draws normally.
   */
  mask?: Uint8Array;
  /** Selected leaf indices. */
  selection?: Set<number>;
  /** Node id whose clade is pinned, or -1. */
  pinned: number;
  /** Node id under the cursor, or -1. */
  hover: number;
}

export function emptyHighlight(): HighlightState {
  return { pinned: -1, hover: -1 };
}

export interface RendererOptions {
  style?: Partial<StyleTokens>;
  /** Device pixel ratio; defaults to the window's. */
  dpr?: number;
}
