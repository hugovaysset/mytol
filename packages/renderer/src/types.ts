/**
 * Renderer-facing types: what to draw, how it is transformed, and how it looks.
 *
 * All of it is plain data. The renderer never reaches for React state, and the
 * style comes in as tokens rather than hardcoded colours, so a host app can
 * hand over its own CSS custom properties and get a tree that matches its
 * theme in both light and dark mode.
 */

import type { Tree, Uid } from "@mytol/core";

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
   * Colour ramp for branch support, low to high.
   *
   * Three stops rather than two: support is not uniformly distributed — most
   * branches in a large tree sit near the top of the range — so a two-colour
   * ramp puts almost everything at one end and shows nothing. A midpoint lets
   * the scale be pushed to where the interesting variation actually is.
   */
  supportRamp: { low: string; mid: string; high: string };
  /** Where `mid` sits on the 0..1 support scale. */
  supportMidpoint: number;
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
    colorBySupport: false,
    supportRamp: { low: "#d73027", mid: "#fee08b", high: "#1a9850" },
    supportMidpoint: 0.5,
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
  /** Called once when the track is attached, to precompute scales/palettes. */
  init?(track: T, ctx: TrackInitContext): void;
  /** Draw one leaf's cell. Called only for leaves that survive culling and LOD. */
  drawCell(
    ctx: CanvasRenderingContext2D,
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
