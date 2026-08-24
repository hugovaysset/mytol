/**
 * Canvas renderer.
 *
 * Extracted from mytol's 3694-line component, where `draw()` was a closure over
 * ~40 pieces of React state and could not be called without a mounted
 * component. Here it is a plain class over explicit state, which means it can
 * be unit-tested, driven from any framework, and pointed at an offscreen canvas
 * for export.
 *
 * Three things mytol did not have and an embedded dashboard panel needs:
 *   - requestAnimationFrame batching, so a drag coalesces into one repaint per
 *     frame instead of one per mousemove;
 *   - a ResizeObserver hook, so a canvas laid out inside a hidden tab paints
 *     correctly when the tab is shown (mytol only sized on other state changes);
 *   - a highlight layer independent of the tree, so the host can dim leaves
 *     that fall outside its filter without touching the tree itself.
 */

import {
  type Tree,
  layoutRectangular,
  layoutUnrooted,
  rectToPolar,
  type RectLayout,
  type UnrootedLayout,
  nodeByUid,
} from "@mytol/core";

import {
  type ViewState,
  type StyleTokens,
  type HighlightState,
  type TrackInstance,
  type RangeInstance,
  type RangeDisplayMode,
  type RendererOptions,
  type LayoutMode,
  defaultStyle,
  emptyHighlight,
} from "./types";
import { getTrack, initTrack, heatValueColor, hashColor } from "./registry";

const PADDING = 40;
const LABEL_RESERVE_PX = 150;
/** Rows shorter than this cannot carry a readable label, so none is drawn. */
const LABEL_MIN_ROW_PX = 7;
const CIRC_RADIUS_FRACTION = 0.45;
const MIN_EDGE_PIXELS = 0.5;
const TRACK_GAP = 6;
/** Length of the caret that points at a selected tip. */
const POINTER_LEN = 11;
/**
 * Beyond a handful, a caret per tip stops being a pointer and becomes a second
 * copy of the selection; the highlight band already reads at that size.
 */
const POINTER_MAX_MARKS = 8;

/** Where a leaf's row sits on screen, used for tracks, labels and hit-testing. */
export interface RectMetrics {
  sx: number;
  sy: number;
  originX: number;
  originY: number;
  trackStartX: number;
  trackWidth: number;
  visibleLeafStart: number;
  visibleLeafEnd: number;
}

/** What the pointer is over, inside an annotation track. */
export interface TrackHover {
  track: TrackInstance;
  /** Leaf whose value is painted here, or -1 when over a hidden-category marker. */
  leafIndex: number;
  /** Set only for a marker: the category the current zoom cannot draw. */
  hiddenCategory?: string;
  /** How many leaves in this stretch carry it. */
  hiddenCount?: number;
}

export class TreeRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr: number;

  private tree: Tree | null = null;
  private rect: RectLayout | null = null;
  private unrooted: UnrootedLayout | null = null;

  private view: ViewState;
  private style: StyleTokens;
  private highlight: HighlightState = emptyHighlight();
  private tracks: TrackInstance[] = [];
  private ranges: RangeInstance[] = [];
  private rangeMode: RangeDisplayMode = "background";
  private collapsed = new Set<number>();

  private frame = 0;
  private rampFull: string[] = [];
  private rampDim: string[] = [];
  /**
   * Where each track column ended up, in screen space.
   *
   * Recorded during the draw rather than recomputed on hover: the geometry
   * already exists at that moment, and a track's position depends on the
   * layout mode, the LOD stride and every earlier track's width.
   */
  private trackHits: Array<{
    track: TrackInstance;
    mode: LayoutMode;
    x0: number;
    x1: number;
    r0?: number;
    r1?: number;
  }> = [];
  private width = 0;
  private height = 0;
  private lastMetrics: RectMetrics | null = null;
  /** Clades folded by LOD in the last rect draw, outermost only. */
  private lodCollapsed: number[] = [];
  /**
   * Rarity order per categorical track, cached: rarer categories win the
   * contest for a pixel row, so a small category is not erased by a large one.
   */
  private catRank = new WeakMap<TrackInstance, Map<string, number>>();
  /**
   * Which leaf actually supplied the colour of each pixel row of each track,
   * so hovering an aggregated strip reports the value that is on screen.
   */
  private bandLeaf = new Map<TrackInstance, {
    top: number;
    leaf: Int32Array;
    /** Any leaf on this row, even one with no value, so the tooltip can name it. */
    any: Int32Array;
  }>();
  /**
   * Categories present in a stretch of a track but not drawn there, because
   * the rows they sit on are thinner than a pixel.
   */
  private trackMarkers: Array<{
    track: TrackInstance;
    category: string;
    color: string;
    count: number;
    x0: number;
    x1: number;
    y: number;
  }> = [];

  constructor(canvas: HTMLCanvasElement, opts: RendererOptions = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("could not obtain a 2d canvas context");
    this.ctx = ctx;
    this.dpr = opts.dpr ?? (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
    this.style = { ...defaultStyle(), ...(opts.style ?? {}) };
    this.buildRamp();
    this.view = {
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

  // -- state ---------------------------------------------------------------

  setTree(tree: Tree | null): void {
    this.tree = tree;
    this.recomputeLayouts();
    this.requestDraw();
  }

  setView(view: Partial<ViewState>): void {
    const before = this.view;
    this.view = { ...before, ...view };
    if (
      (view.phylogram !== undefined && view.phylogram !== before.phylogram) ||
      (view.fitQuantile !== undefined && view.fitQuantile !== before.fitQuantile)
    ) {
      this.recomputeLayouts();
    }
    this.requestDraw();
  }

  getView(): ViewState {
    return { ...this.view };
  }

  setStyle(style: Partial<StyleTokens>): void {
    this.style = { ...this.style, ...style };
    this.buildRamp();
    this.requestDraw();
  }

  /**
   * Precompute the support ramp, once per style change.
   *
   * Two tables: the ramp itself, and the same ramp faded towards the dimmed
   * colour for branches the current filter excludes. Fading rather than
   * replacing keeps both readings legible when support colouring and a filter
   * are on together — either one winning outright hides the other.
   */
  private buildRamp(): void {
    const s = this.style;
    const dim = hexToRgb(s.dimmed);
    const full: string[] = new Array(RAMP_STEPS);
    const faded: string[] = new Array(RAMP_STEPS);
    for (let i = 0; i < RAMP_STEPS; i++) {
      const v = i / (RAMP_STEPS - 1);
      const rgb = supportRgb(v, s.supportRamp, s.supportMidpoint);
      full[i] = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
      faded[i] = mix(rgb, dim, 0.72);
    }
    this.rampFull = full;
    this.rampDim = faded;
  }

  getStyle(): StyleTokens {
    return { ...this.style };
  }

  setHighlight(h: Partial<HighlightState>): void {
    this.highlight = { ...this.highlight, ...h };
    this.requestDraw();
  }

  setTracks(tracks: TrackInstance[]): void {
    this.tracks = tracks;
    if (this.tree) {
      const tree = this.tree;
      for (const t of tracks) {
        initTrack(t, {
          tree,
          leafName: (i: number) => tree.name[tree.leaves[i]] ?? "",
        });
      }
    }
    this.requestDraw();
  }

  setRanges(ranges: RangeInstance[], mode: RangeDisplayMode = this.rangeMode): void {
    this.ranges = ranges;
    this.rangeMode = mode;
    this.requestDraw();
  }

  setCollapsed(collapsed: Set<number>): void {
    this.collapsed = collapsed;
    this.requestDraw();
  }

  private recomputeLayouts(): void {
    if (!this.tree) {
      this.rect = null;
      this.unrooted = null;
      return;
    }
    this.rect = layoutRectangular(this.tree, this.view.phylogram, this.view.fitQuantile);
    this.unrooted = layoutUnrooted(this.tree, !this.view.phylogram);
  }

  // -- frame scheduling ------------------------------------------------------

  /** Coalesce repaints to one per animation frame. */
  requestDraw(): void {
    if (this.frame) return;
    if (typeof requestAnimationFrame !== "function") {
      this.draw();
      return;
    }
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  /** Cancel a pending frame; call on unmount. */
  dispose(): void {
    if (this.frame && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.frame);
    }
    this.frame = 0;
  }

  /** Resize the backing store to the element's CSS box. */
  resize(cssWidth: number, cssHeight: number): void {
    const w = Math.max(1, Math.floor(cssWidth));
    const h = Math.max(1, Math.floor(cssHeight));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.canvas.width = Math.floor(w * this.dpr);
    this.canvas.height = Math.floor(h * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.requestDraw();
  }

  // -- geometry --------------------------------------------------------------

  private effectiveTrackWidth(): number {
    let total = 0;
    for (const t of this.tracks) {
      if (!t.visible) continue;
      const def = getTrack(t.type);
      if (!def) continue;
      total += (t.width ?? def.width) + TRACK_GAP;
    }
    return total;
  }

  /** Screen metrics for the rectangular layout. */
  metrics(): RectMetrics | null {
    if (!this.tree || !this.rect) return null;
    const W = this.width;
    const H = this.height;
    const trackWidth = this.effectiveTrackWidth();

    // Vertical scale does not depend on the horizontal budget, so it can be
    // settled first — which lets the label reserve be conditional rather than
    // circular. Reserving 150px for labels that LOD then suppresses wastes a
    // sixth of the panel and leaves a conspicuous gap before the tracks.
    const sy = (H - 2 * PADDING) / Math.max(1, this.rect.height);
    const labelsWillDraw = this.style.showLeafLabels && sy * this.view.vZoom >= LABEL_MIN_ROW_PX;
    const labelW = labelsWillDraw ? LABEL_RESERVE_PX : 0;

    const usableW = Math.max(10, W - 2 * PADDING - trackWidth - labelW);
    const sx = usableW / Math.max(1e-9, this.rect.fitX);

    const originX = -W / 2 + PADDING;
    const originY = -H / 2 + PADDING;

    const { vZoom, panY } = this.view;
    const nLeaves = this.tree.leaves.length;
    let visibleLeafStart = 0;
    let visibleLeafEnd = nLeaves;
    if (this.view.mode === "rect" && sy > 0) {
      const topWy = (0 - H / 2 - panY) / vZoom;
      const botWy = (H - H / 2 - panY) / vZoom;
      const top = (topWy + H / 2 - PADDING) / sy;
      const bot = (botWy + H / 2 - PADDING) / sy;
      visibleLeafStart = clampInt(Math.floor(top) - 1, 0, nLeaves);
      visibleLeafEnd = clampInt(Math.ceil(bot) + 1, 0, nLeaves);
      if (visibleLeafEnd < visibleLeafStart) {
        const t = visibleLeafStart;
        visibleLeafStart = visibleLeafEnd;
        visibleLeafEnd = t;
      }
    }

    // Screen-space, not world-space: the rect path draws tracks and labels
    // against an untransformed context, so this must already be in px.
    const trackStartX = this.view.panX + PADDING + sx * this.rect.fitX + TRACK_GAP;
    return {
      sx,
      sy,
      originX,
      originY,
      trackStartX,
      trackWidth,
      visibleLeafStart,
      visibleLeafEnd,
    };
  }

  /** World -> screen for the rectangular layout. */
  private screenOf(m: RectMetrics, id: number): { x: number; y: number } {
    const lo = this.rect as RectLayout;
    const wx = m.originX + m.sx * lo.x[id];
    const wy = m.originY + m.sy * lo.y[id];
    return {
      x: this.width / 2 + this.view.panX + wx,
      y: this.height / 2 + this.view.panY + wy * this.view.vZoom,
    };
  }

  // -- drawing ---------------------------------------------------------------

  draw(): void {
    const ctx = this.ctx;
    const W = this.width;
    const H = this.height;
    if (W === 0 || H === 0) return;

    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = this.style.background;
    ctx.fillRect(0, 0, W, H);

    if (!this.tree || !this.rect) {
      ctx.restore();
      return;
    }

    this.trackHits = [];
    this.trackMarkers = [];

    // skipNode: 0 draw, 1 collapsed triangle, 2 hidden inside a collapse
    const skip = this.computeSkip();

    if (this.view.mode === "rect") {
      this.drawRect(skip);
    } else if (this.view.mode === "circular") {
      this.drawCircular(skip);
    } else {
      this.drawUnrooted(skip);
    }

    ctx.restore();
  }

  private computeSkip(): Uint8Array {
    const t = this.tree as Tree;
    const skip = new Uint8Array(t.count);
    if (this.collapsed.size === 0) return skip;
    const stack = [t.root];
    while (stack.length) {
      const id = stack.pop() as number;
      if (skip[id] === 2) continue;
      if (id !== t.root && this.collapsed.has(id)) {
        skip[id] = 1;
        const inner: number[] = [];
        for (let c = t.firstChild[id]; c !== -1; c = t.nextSib[c]) inner.push(c);
        while (inner.length) {
          const u = inner.pop() as number;
          skip[u] = 2;
          for (let c = t.firstChild[u]; c !== -1; c = t.nextSib[c]) inner.push(c);
        }
        continue;
      }
      for (let c = t.firstChild[id]; c !== -1; c = t.nextSib[c]) stack.push(c);
    }
    return skip;
  }

  /** Colour for a branch, honouring support colouring and the filter mask. */
  private branchColor(id: number): string {
    const t = this.tree as Tree;
    const s = this.style;

    // A clade is excluded only when NO leaf under it passes the filter.
    let excluded = false;
    const mask = this.highlight.mask;
    if (mask) {
      excluded = true;
      for (let i = t.L[id]; i < t.R[id]; i++) {
        if (mask[i]) {
          excluded = false;
          break;
        }
      }
    }

    if (s.colorBySupport) {
      const v = t.support[id];
      if (Number.isNaN(v)) return excluded ? s.dimmed : s.supportAbsent;
      // Quantised lookup rather than building a colour string per branch: this
      // runs for every drawn branch of a 40 000-tip tree, twice over when a
      // filter is active.
      // Rescale into the configured domain before looking up.
      const span = s.supportMax - s.supportMin;
      const norm = span > 1e-9 ? (v - s.supportMin) / span : v >= s.supportMax ? 1 : 0;
      const bucket = Math.round(Math.max(0, Math.min(1, norm)) * (RAMP_STEPS - 1));
      const table = excluded ? this.rampDim : this.rampFull;
      return table[bucket];
    }

    if (excluded) return s.dimmed;
    return s.branch;
  }

  private drawRect(skip: Uint8Array): void {
    const t = this.tree as Tree;
    const ctx = this.ctx;
    const s = this.style;
    const m = this.metrics();
    if (!m) return;
    this.lastMetrics = m;

    const { vZoom } = this.view;
    const rowH = m.sy * vZoom;

    // -- coloured range backgrounds -----------------------------------------
    if (this.rangeMode === "background") {
      for (const r of this.ranges) {
        const id = nodeByUid(t, r.nodeUid);
        if (id === -1) continue;
        const p0 = this.screenOf(m, id);
        const yTop = this.rowY(m, t.L[id]) - rowH / 2;
        const yBot = this.rowY(m, t.R[id] - 1) + rowH / 2;
        ctx.fillStyle = r.color + "55";
        const right = m.trackStartX + m.trackWidth;
        ctx.fillRect(p0.x, yTop, Math.max(0, right - p0.x), yBot - yTop);
      }
    }

    // -- clade highlight (hover / pinned) ------------------------------------
    for (const [nodeId, fill] of [
      [this.highlight.pinned, s.pinned] as const,
      [this.highlight.hover, s.hover] as const,
    ]) {
      if (nodeId < 0 || nodeId >= t.count) continue;
      const p = this.screenOf(m, nodeId);
      const yTop = this.rowY(m, t.L[nodeId]) - rowH / 2;
      const yBot = this.rowY(m, t.R[nodeId] - 1) + rowH / 2;
      ctx.fillStyle = fill;
      ctx.fillRect(p.x, yTop, this.width - p.x, Math.max(1, yBot - yTop));
    }

    // -- branches ------------------------------------------------------------
    //
    // Fitting the view to a quantile of the tips leaves the deepest few running
    // past the fitted edge — that is the point of it, and the alternative is
    // letting one long branch set the scale for the whole tree. But those
    // overhanging branches were drawn straight through the annotation columns,
    // which made the strips unreadable and the hit test ambiguous. When there
    // are tracks, the tree is clipped where they begin.
    const clipAtTracks = this.tracks.some((tr) => tr.visible) && m.trackWidth > 0;
    if (clipAtTracks) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, Math.max(0, m.trackStartX - TRACK_GAP / 2), this.height);
      ctx.clip();
    }

    const lw = s.branchWidth;
    // Clades folded away by level of detail, kept so the annotation tracks can
    // say what is hiding inside them.
    const collapsed: number[] = [];
    this.lodCollapsed = collapsed;
    for (let id = 0; id < t.count; id++) {
      if (skip[id] === 2) continue;
      if (t.R[id] <= m.visibleLeafStart || t.L[id] >= m.visibleLeafEnd) continue;

      // Level of detail.
      //
      // A clade too short to draw in full is drawn as a WEDGE spanning the
      // depth it actually reaches, not dropped. Dropping it — the obvious
      // reading of "too small to see" — makes the tree stop well short of its
      // own tips, because the surviving nodes are all backbone and the deep
      // structure lives in exactly the clades being discarded. The tree then
      // looks shifted left with a gap before the annotation tracks.
      if (id !== t.root && skip[id] === 0 && s.lodMinPx > 0) {
        const cladePx = (t.R[id] - t.L[id]) * rowH;
        if (cladePx < s.lodMinPx) {
          const parent = t.parent[id];
          // Only the outermost such clade draws; its descendants are inside it.
          if (parent !== -1 && (t.R[parent] - t.L[parent]) * rowH < s.lodMinPx) continue;
          this.drawWedge(m, id, rowH, lw);
          collapsed.push(id);
          continue;
        }
      }

      const p = this.screenOf(m, id);

      if (skip[id] === 1) {
        // collapsed clade as a triangle
        const yTop = this.rowY(m, t.L[id]) - rowH / 2;
        const yBot = this.rowY(m, t.R[id] - 1) + rowH / 2;
        const triLen = Math.min((t.R[id] - t.L[id]) * rowH * 0.4, 60);
        ctx.beginPath();
        ctx.moveTo(p.x, (yTop + yBot) / 2);
        ctx.lineTo(p.x + triLen, yTop);
        ctx.lineTo(p.x + triLen, yBot);
        ctx.closePath();
        ctx.fillStyle = "rgba(100,100,100,0.18)";
        ctx.fill();
        ctx.strokeStyle = this.branchColor(id);
        ctx.lineWidth = 1;
        ctx.stroke();
        continue;
      }

      for (let c = t.firstChild[id]; c !== -1; c = t.nextSib[c]) {
        if (skip[c] === 2) continue;
        const pc = this.screenOf(m, c);
        // An edge belongs to its CHILD. Branch length and support are both
        // properties of the node an edge leads to, not the node it leaves, so
        // every part of the elbow takes the child's colour. Colouring the
        // vertical connector by the parent — which is what setting the colour
        // once per parent amounts to — split each edge into two colours and
        // made the support ramp unreadable.
        const color = this.branchColor(c);

        // vertical connector
        if (Math.abs(pc.y - p.y) >= MIN_EDGE_PIXELS) {
          ctx.fillStyle = color;
          const yA = Math.min(p.y, pc.y);
          ctx.fillRect(p.x - lw / 2, yA, lw, Math.abs(pc.y - p.y));
        }
        // horizontal branch
        if (Math.abs(pc.x - p.x) >= MIN_EDGE_PIXELS) {
          ctx.fillStyle = color;
          const xA = Math.min(p.x, pc.x);
          ctx.fillRect(xA, pc.y - lw / 2, Math.abs(pc.x - p.x), lw);
        }
      }
    }

    // Selection marks sit right against the tracks, so the clip lifts first.
    if (clipAtTracks) ctx.restore();

    // -- selection marks -----------------------------------------------------
    const sel = this.highlight.selection;
    if (sel && sel.size) {
      ctx.fillStyle = s.selected;
      for (const leafIdx of sel) {
        if (leafIdx < m.visibleLeafStart || leafIdx >= m.visibleLeafEnd) continue;
        const y = this.rowY(m, leafIdx);
        ctx.fillRect(m.trackStartX - 4, y - Math.max(0.5, rowH / 2), 3, Math.max(1, rowH));
      }
    }

    this.drawTracks(m, rowH);

    // A caret for each selected tip, once the selection is small enough that
    // pointing at them individually means something. At tens of thousands of
    // tips the tick above is a fraction of a pixel and impossible to find.
    if (sel && sel.size && sel.size <= POINTER_MAX_MARKS) {
      // Beside the tracks, but never past the edge of the canvas: with no
      // tracks the column sits at the very margin, where a caret is present
      // but unfindable.
      const x = Math.min(m.trackStartX + m.trackWidth + 2, this.width - POINTER_LEN - 3);
      for (const leafIdx of sel) {
        if (leafIdx < m.visibleLeafStart || leafIdx >= m.visibleLeafEnd) continue;
        const y = this.rowY(m, leafIdx);
        // A guide along the row. The caret alone says "one of the tips out
        // here"; at forty thousand rows the line is what says WHICH.
        ctx.fillStyle = s.selected;
        ctx.globalAlpha = 0.35;
        ctx.fillRect(0, y - 0.5, x, 1);
        ctx.globalAlpha = 1;
        this.drawPointerCaret(x, y, s.selected);
      }
    }

    this.drawLeafLabels(m, rowH);
    this.drawSupport(m, rowH, skip);
  }

  /**
   * A clade drawn as a filled wedge, from its own node out to its deepest tip.
   *
   * The shape carries two honest facts a dropped clade carries none of: where
   * the lineage reaches, and roughly how many tips are inside it (the wedge's
   * height is its row span).
   */
  private drawWedge(m: RectMetrics, id: number, rowH: number, lw: number): void {
    const t = this.tree as Tree;
    const lo = this.rect as RectLayout;
    const ctx = this.ctx;

    const p = this.screenOf(m, id);
    const tipX =
      this.width / 2 + this.view.panX + m.originX + m.sx * lo.subtreeMaxX[id];
    const yTop = this.rowY(m, t.L[id]) - rowH / 2;
    const yBot = this.rowY(m, t.R[id] - 1) + rowH / 2;
    const h = Math.max(lw, yBot - yTop);

    ctx.beginPath();
    ctx.moveTo(p.x, (yTop + yBot) / 2);
    ctx.lineTo(tipX, yTop - (h < 2 ? 0.6 : 0));
    ctx.lineTo(tipX, yBot + (h < 2 ? 0.6 : 0));
    ctx.closePath();
    ctx.fillStyle = this.branchColor(id);
    ctx.fill();
  }

  /** Test seam: the colour a branch is drawn in. */
  branchColorForTest(id: number): string {
    return this.branchColor(id);
  }

  /** Which leaf row a screen point falls on in circular mode, by angle alone. */
  leafRowAtPoint(sx: number, sy: number): number {
    const t = this.tree;
    if (!t) return -1;
    const { zoom, panX, panY } = this.view;
    const wx = (sx - this.width / 2 - panX) / zoom;
    const wy = (sy - this.height / 2 - panY) / zoom;
    return this.leafRowAtAngle(Math.atan2(wy, wx), t.leaves.length || 1);
  }

  /** Test seam: the rect metrics of the current view. */
  metricsForTest(): RectMetrics {
    return this.metrics() as RectMetrics;
  }

  /** Test seam: the hidden-category markers from the last draw. */
  markersForTest(): Array<{ category: string; count: number; x0: number; x1: number; y: number }> {
    return this.trackMarkers.map((mk) => ({
      category: mk.category,
      count: mk.count,
      x0: mk.x0,
      x1: mk.x1,
      y: mk.y,
    }));
  }

  /** Clades the last draw folded away, for a host that wants to annotate them. */
  collapsedClades(): number[] {
    return this.lodCollapsed;
  }

  private rowY(m: RectMetrics, leafIndex: number): number {
    const wy = m.originY + m.sy * leafIndex;
    return this.height / 2 + this.view.panY + wy * this.view.vZoom;
  }

  private drawTracks(m: RectMetrics, rowH: number): void {
    if (!this.tracks.length) return;
    const ctx = this.ctx;

    let colX = m.trackStartX;
    let shown = 0;
    // Names are far wider than the ~18px columns they head, so headers are
    // staggered down several rows and each is allowed to run over its
    // neighbours' columns — whose own names are on different rows.
    const nVisible = this.tracks.filter((tr) => tr.visible).length;
    const headerRows = Math.min(3, Math.max(1, nVisible));
    for (const track of this.tracks) {
      if (!track.visible) continue;
      const def = getTrack(track.type);
      if (!def) continue;
      const w = track.width ?? def.width;

      // Header. Columns are ~18px wide and names are not, so headers alternate
      // between two rows and each is allowed to run over its neighbour's
      // column — which is empty, because that neighbour's name is on the other
      // row. Clipping each name to its own 18px was legible for one track and
      // unreadable for two.
      if (this.style.showLeafLabels) {
        const row = shown % headerRows;
        ctx.fillStyle = this.style.textMuted;
        ctx.font = `10px ${this.style.fontFamily}`;
        ctx.textBaseline = "alphabetic";
        ctx.save();
        ctx.beginPath();
        ctx.rect(colX, row * 11, headerRows * (w + TRACK_GAP), 12);
        ctx.clip();
        ctx.fillText(track.label, colX, 10 + row * 11);
        ctx.restore();
      }

      // Below about two pixels a row cannot be drawn on its own. Sampling every
      // Nth leaf — the obvious thing — is wrong twice over: it drops whole
      // categories, and it paints blocks on fractional pixel boundaries, so
      // neighbouring blocks antialias together and one category appears in
      // several shades. Aggregating each pixel row instead fixes both.
      if (rowH < 2) this.drawTrackAggregated(m, rowH, track, colX, w);
      else {
        for (let i = m.visibleLeafStart; i < m.visibleLeafEnd; i++) {
          const y = this.rowY(m, i) - rowH / 2;
          def.drawCell(ctx, colX, y, w, rowH, i, track as never);
        }
        this.bandLeaf.delete(track);
      }

      this.trackHits.push({ track, mode: "rect", x0: colX, x1: colX + w });
      colX += w + TRACK_GAP;
      shown++;
    }

    this.drawTrackMarkers();
  }

  /** Rarity order for a categorical track: index 0 is the rarest category. */
  private rarityRank(track: TrackInstance): Map<string, number> {
    const cached = this.catRank.get(track);
    if (cached) return cached;
    const counts = new Map<string, number>();
    for (const v of track.values ?? []) {
      if (v == null) continue;
      const k = String(v);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const rank = new Map<string, number>();
    Array.from(counts.entries())
      .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
      .forEach(([k], i) => rank.set(k, i));
    this.catRank.set(track, rank);
    return rank;
  }

  /**
   * One pixel row at a time, when leaf rows are thinner than a pixel.
   *
   * Each row is won by the RAREST category it contains. Letting the most common
   * one win would be the natural choice and is the wrong one here: the whole
   * point of the strip at this zoom is to show where the unusual annotations
   * are, and they are exactly the ones a majority vote erases.
   *
   * Everything a row could not show is remembered, and surfaces as a marker.
   */
  private drawTrackAggregated(
    m: RectMetrics,
    rowH: number,
    track: TrackInstance,
    colX: number,
    w: number,
  ): void {
    const ctx = this.ctx;
    const numeric = track.numeric;
    const values = track.values;
    if (!numeric && !values) return;

    const top = Math.floor(this.rowY(m, m.visibleLeafStart) - rowH / 2);
    const nBands = Math.max(1, Math.ceil(this.height) - top + 2);
    const best = new Int32Array(nBands).fill(-1);
    const bestRank = new Float64Array(nBands).fill(Infinity);
    const hidden: Array<Map<string, number> | null> = new Array(nBands).fill(null);
    const rank = values ? this.rarityRank(track) : null;
    // Continuous tracks average instead of competing: a pixel row stands for
    // dozens of leaves, and its mean is the honest summary of them. Taking the
    // maximum — the natural analogue of "rarest wins" — paints the whole column
    // its top colour as soon as any row contains one high value.
    const sum = numeric ? new Float64Array(nBands) : null;
    const nSum = numeric ? new Int32Array(nBands) : null;
    // A row whose leaves all lack a value still belongs to this track. Without
    // this the hit test falls through to the tree behind it and the tooltip
    // answers with the leaf's own details instead of the dataset's.
    const anyLeaf = new Int32Array(nBands).fill(-1);

    for (let i = m.visibleLeafStart; i < m.visibleLeafEnd; i++) {
      const band = Math.floor(this.rowY(m, i)) - top;
      if (band < 0 || band >= nBands) continue;
      if (anyLeaf[band] < 0) anyLeaf[band] = i;

      let score: number;
      if (numeric) {
        const v = numeric[i];
        if (Number.isNaN(v)) continue;
        sum![band] += v;
        nSum![band]++;
        // Any leaf will do as the row's representative; the colour comes from
        // the mean, and the first one gives the tooltip something to name.
        score = best[band] >= 0 ? Infinity : 0;
      } else {
        const v = values![i];
        if (v == null) continue;
        score = rank!.get(String(v)) ?? Infinity;
      }

      if (score < bestRank[band]) {
        // The category being displaced still happened here.
        if (values && best[band] >= 0) {
          const prev = values[best[band]];
          if (prev != null) {
            let h = hidden[band];
            if (!h) hidden[band] = h = new Map();
            const k = String(prev);
            h.set(k, (h.get(k) ?? 0) + 1);
          }
        }
        bestRank[band] = score;
        best[band] = i;
      } else if (values) {
        const v = values[i];
        if (v != null && String(v) !== String(values[best[band]])) {
          let h = hidden[band];
          if (!h) hidden[band] = h = new Map();
          const k = String(v);
          h.set(k, (h.get(k) ?? 0) + 1);
        }
      }
    }

    for (let b = 0; b < nBands; b++) {
      const i = best[b];
      if (i < 0) continue;
      const color = numeric
        ? heatValueColor(sum![b] / Math.max(1, nSum![b]), track)
        : (track.palette?.[String(values![i])] ?? hashColor(String(values![i])));
      if (!color) continue;
      ctx.fillStyle = color;
      // Integer coordinates: a fractional rect is antialiased, which is how one
      // category ended up looking like three.
      ctx.fillRect(colX, top + b, w, 1);
    }

    this.bandLeaf.set(track, { top, leaf: best, any: anyLeaf });

    if (!values) return;
    // Markers are merged into coarse bands so they stay legible; a marker per
    // pixel row would be a second, noisier copy of the strip.
    const SPACING = 8;
    // What the strip manages to show, slot by slot.
    //
    // A marker means "this category is here and you cannot see it around here",
    // which is the thing worth interrupting the user about. Two rules were
    // tried and are both wrong. Marking anything displaced from its own pixel
    // row puts a caret beside nearly every row: the rarest category wins each
    // row, so whatever it displaces is by definition commoner and drawn plainly
    // a little further down. Requiring a category to be missing from the ENTIRE
    // strip is the opposite failure — one leaf winning one row at the very edge
    // of the canvas silently cancels every marker for it.
    //
    // So: look in a neighbourhood. NEARBY slots either side is close enough
    // that the eye would have found the colour, and narrow enough that a
    // category genuinely absent from a region still gets flagged.
    const NEARBY = 2;
    const drawnInSlot = new Map<number, Set<string>>();
    for (let b = 0; b < nBands; b++) {
      const i = best[b];
      if (i < 0) continue;
      const v = values[i];
      if (v == null) continue;
      const slot = Math.floor(b / SPACING);
      let set = drawnInSlot.get(slot);
      if (!set) drawnInSlot.set(slot, (set = new Set()));
      set.add(String(v));
    }
    const visibleNear = (cat: string, slot: number): boolean => {
      for (let s2 = slot - NEARBY; s2 <= slot + NEARBY; s2++) {
        if (drawnInSlot.get(s2)?.has(cat)) return true;
      }
      return false;
    };

    const merged = new Map<string, { cat: string; count: number; y: number }>();
    for (let b = 0; b < nBands; b++) {
      const h = hidden[b];
      if (!h) continue;
      const slot = Math.floor(b / SPACING);
      for (const [cat, n] of h) {
        if (visibleNear(cat, slot)) continue;
        const key = `${cat}@${slot}`;
        const e = merged.get(key);
        if (e) e.count += n;
        else merged.set(key, { cat, count: n, y: top + slot * SPACING + SPACING / 2 });
      }
    }
    for (const e of merged.values()) {
      const color = track.palette?.[e.cat] ?? hashColor(e.cat);
      this.trackMarkers.push({
        track,
        category: e.cat,
        color,
        count: e.count,
        x0: colX + w + 1,
        x1: colX + w + TRACK_GAP,
        y: e.y,
      });
    }
  }

  /**
   * A caret pointing at a row, in the selection colour.
   *
   * Same shape as the hidden-category markers, deliberately: the tree already
   * uses that arrow to mean "the thing you are looking for is on this row",
   * and a selected protein is the same statement. Larger, because it answers a
   * question the user just asked rather than one they might.
   *
   * The apex is the pointing end and sits at (apexX, apexY); the body extends
   * away from it along `angle`. So the caller places the apex where it wants
   * the arrow to POINT — against the row in a rectangular layout, against the
   * tip in a radial one — and the arrow grows outward from there.
   */
  private drawPointerCaret(
    apexX: number,
    apexY: number,
    color: string,
    angle = 0,
  ): void {
    const ctx = this.ctx;
    const LEN = POINTER_LEN;
    const HALF = 6;
    ctx.save();
    ctx.translate(apexX, apexY);
    if (angle) ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(LEN, -HALF);
    ctx.lineTo(LEN, HALF);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    // A thin light edge so the caret reads against a dark branch or a strip.
    ctx.strokeStyle = this.style.background;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  /**
   * A caret per hidden category, in the gap to the right of its strip.
   *
   * It points back at the strip it belongs to, and says only "something is in
   * here that the current zoom cannot draw" — the count is in the tooltip.
   */
  private drawTrackMarkers(): void {
    if (!this.trackMarkers.length) return;
    const ctx = this.ctx;
    for (const mk of this.trackMarkers) {
      const h = 3;
      ctx.beginPath();
      ctx.moveTo(mk.x0, mk.y);
      ctx.lineTo(mk.x1, mk.y - h);
      ctx.lineTo(mk.x1, mk.y + h);
      ctx.closePath();
      ctx.fillStyle = mk.color;
      ctx.fill();
    }
  }

  private drawLeafLabels(m: RectMetrics, rowH: number): void {
    // Same threshold that decided whether to reserve room for labels, so the
    // reserve and the drawing can never disagree.
    if (!this.style.showLeafLabels || rowH < LABEL_MIN_ROW_PX) return;
    const t = this.tree as Tree;
    const ctx = this.ctx;
    const mask = this.highlight.mask;

    ctx.font = `${Math.min(13, Math.max(6, rowH - 2))}px ${this.style.fontFamily}`;
    ctx.textBaseline = "middle";
    const x = m.trackStartX + m.trackWidth + 4;

    for (let i = m.visibleLeafStart; i < m.visibleLeafEnd; i++) {
      const id = t.leaves[i];
      const name = t.name[id];
      if (!name) continue;
      ctx.fillStyle = mask && !mask[i] ? this.style.dimmed : this.style.text;
      ctx.fillText(name, x, this.rowY(m, i));
    }
  }

  private drawSupport(m: RectMetrics, rowH: number, skip: Uint8Array): void {
    if (!this.style.showSupport || rowH < 9) return;
    const t = this.tree as Tree;
    const ctx = this.ctx;
    ctx.font = `${Math.min(10, rowH - 2)}px ${this.style.fontFamily}`;
    ctx.fillStyle = this.style.textMuted;
    ctx.textBaseline = "bottom";
    ctx.textAlign = "right";
    for (let id = 0; id < t.count; id++) {
      if (skip[id] !== 0 || t.isLeaf[id]) continue;
      if (t.R[id] <= m.visibleLeafStart || t.L[id] >= m.visibleLeafEnd) continue;
      const v = t.support[id];
      if (Number.isNaN(v)) continue;
      const p = this.screenOf(m, id);
      ctx.fillText(v.toFixed(2), p.x - 2, p.y - 1);
    }
    ctx.textAlign = "left";
  }

  // -- radial modes ----------------------------------------------------------

  /** Angle of a leaf row in the circular layout, in radians. */
  private leafAngle(row: number, n: number): number {
    const start = (this.view.rotation * Math.PI) / 180;
    const span = (this.view.arc * Math.PI) / 180;
    return start - ((row + 0.5) / Math.max(1, n)) * span;
  }

  private drawCircular(skip: Uint8Array): void {
    const t = this.tree as Tree;
    const lo = this.rect as RectLayout;
    const ctx = this.ctx;
    const s = this.style;
    const W = this.width;
    const H = this.height;
    const R = Math.min(W, H) * CIRC_RADIUS_FRACTION;
    const n = t.leaves.length || 1;
    const { zoom, panX, panY, rotation, arc } = this.view;

    ctx.save();
    ctx.translate(W / 2 + panX, H / 2 + panY);
    ctx.scale(zoom, zoom);

    const pt = (id: number) =>
      rectToPolar(
        this.radialFraction(lo, id),
        lo.y[id],
        n,
        R,
        rotation,
        arc,
      );

    const arcPerLeaf = ((arc * Math.PI) / 180 / n) * R * zoom;
    const halfStep = (arc * Math.PI) / 180 / n / 2;
    const lw = s.branchWidth / zoom;

    // -- coloured ranges, as full-depth sectors --------------------------------
    if (this.rangeMode === "background") {
      for (const r of this.ranges) {
        const id = nodeByUid(t, r.nodeUid);
        if (id === -1) continue;
        this.fillWedge(ctx, pt(id).radius, R, t.L[id], t.R[id] - 1, n, halfStep, r.color + "55");
      }
    }

    // -- hovered and pinned clades --------------------------------------------
    for (const [nodeId, fill] of [
      [this.highlight.pinned, s.pinned] as const,
      [this.highlight.hover, s.hover] as const,
    ]) {
      if (nodeId < 0 || nodeId >= t.count) continue;
      // Starts at the clade's own radius and runs outward, so the highlight
      // marks the clade rather than a pie slice through the whole tree.
      this.fillWedge(ctx, pt(nodeId).radius, R * 1.02, t.L[nodeId], t.R[nodeId] - 1, n, halfStep, fill);
    }

    // -- branches --------------------------------------------------------------
    for (let id = 0; id < t.count; id++) {
      if (skip[id] === 2) continue;
      if (id !== t.root && skip[id] === 0 && s.lodMinPx > 0) {
        if ((t.R[id] - t.L[id]) * arcPerLeaf < s.lodMinPx) continue;
      }
      const p = pt(id);
      ctx.lineWidth = lw;

      for (let c = t.firstChild[id]; c !== -1; c = t.nextSib[c]) {
        if (skip[c] === 2) continue;
        const q = pt(c);
        // Both halves of the edge take the child's colour; see drawRect. Here
        // the parent's colour was applied to the radial run as well, so a
        // child's own branch showed its parent's support.
        ctx.strokeStyle = this.branchColor(c);
        // radial segment out to the child
        ctx.beginPath();
        ctx.moveTo(p.radius * Math.cos(q.angle), p.radius * Math.sin(q.angle));
        ctx.lineTo(q.x, q.y);
        ctx.stroke();
        // arc joining the parent's angle to the child's
        ctx.beginPath();
        ctx.arc(0, 0, p.radius, Math.min(p.angle, q.angle), Math.max(p.angle, q.angle));
        ctx.stroke();
      }
    }

    // -- selected leaves, as ticks just outside the tips -----------------------
    const sel = this.highlight.selection;
    if (sel && sel.size) {
      ctx.strokeStyle = s.selected;
      ctx.lineWidth = Math.max(lw, halfStep * R * 1.4);
      for (const row of sel) {
        if (row < 0 || row >= n) continue;
        const a = this.leafAngle(row, n);
        ctx.beginPath();
        ctx.moveTo(R * 1.005 * Math.cos(a), R * 1.005 * Math.sin(a));
        ctx.lineTo(R * 1.03 * Math.cos(a), R * 1.03 * Math.sin(a));
        ctx.stroke();
      }
    }

    // -- annotation rings ------------------------------------------------------
    const ringOuter = this.drawRings(ctx, R, n, halfStep, arcPerLeaf);

    // Selected tips get a caret outside the rings, pointing back in along the
    // tip's own direction — the radial equivalent of the rectangular marker.
    if (sel && sel.size && sel.size <= POINTER_MAX_MARKS) {
      const rr = Math.max(ringOuter, R) + 4;
      for (const row of sel) {
        if (row < 0 || row >= n) continue;
        const a = this.leafAngle(row, n);
        this.drawPointerCaret(rr * Math.cos(a), rr * Math.sin(a), s.selected, a);
      }
    }

    // -- leaf labels around the rim -------------------------------------------
    // Fitting labels around a circle is the main reason to use this layout, so
    // they are drawn whenever the angular spacing leaves room for them.
    const arcPx = arcPerLeaf;
    if (s.showLeafLabels && arcPx >= 6) {
      const mask = this.highlight.mask;
      const fontPx = Math.min(12, Math.max(6, arcPx - 1)) / zoom;
      ctx.font = `${fontPx}px ${s.fontFamily}`;
      ctx.textBaseline = "middle";
      for (let row = 0; row < n; row++) {
        const id = t.leaves[row];
        const name = t.name[id];
        if (!name) continue;
        const a = this.leafAngle(row, n);
        const flip = Math.cos(a) < 0;
        ctx.save();
        ctx.rotate(a);
        ctx.translate(ringOuter + 6 / zoom, 0);
        if (flip) {
          ctx.rotate(Math.PI);
          ctx.textAlign = "right";
        } else {
          ctx.textAlign = "left";
        }
        ctx.fillStyle = mask && !mask[row] ? s.dimmed : s.text;
        ctx.fillText(name, 0, 0);
        ctx.restore();
      }
      ctx.textAlign = "left";
    }

    ctx.restore();
  }

  /**
   * Annotation tracks as concentric rings.
   *
   * The registry's drawCell paints an axis-aligned rectangle, which is exactly
   * right in the rectangular layout and meaningless here. Rather than ask every
   * track type to know about polar coordinates, each leaf's cell is drawn into
   * a rotated frame: the context is rotated to the leaf's angle and translated
   * out to the ring, so drawCell still receives a plain (x, y, w, h) box and
   * any track written for the linear view works unchanged in circular.
   *
   * Returns the outer radius reached, so labels know where to start.
   */
  private drawRings(
    ctx: CanvasRenderingContext2D,
    R: number,
    n: number,
    halfStep: number,
    arcPerLeaf: number,
  ): number {
    let radius = R * 1.04;
    if (!this.tracks.length) return radius;

    // One cell per leaf is pointless when leaves are sub-pixel apart; step in
    // proportion, exactly as the rectangular tracks do.
    const step = Math.max(1, Math.round(this.style.lodMinPx / Math.max(arcPerLeaf, 1e-6)));
    const cellAngle = halfStep * 2 * step;

    for (const track of this.tracks) {
      if (!track.visible) continue;
      const def = getTrack(track.type);
      if (!def) continue;
      const width = track.width ?? def.width;
      // Rings are thinner than linear tracks: they have the whole circumference
      // to work with and depth is the scarce axis here.
      const thickness = Math.min(width, 26);

      for (let row = 0; row < n; row += step) {
        const a = this.leafAngle(row, n);
        ctx.save();
        ctx.rotate(a);
        // A cell tall enough to cover the angular slice it stands for.
        const h = Math.max(1, cellAngle * radius);
        ctx.translate(radius, -h / 2);
        def.drawCell(ctx, 0, 0, thickness, h, row, track as never);
        ctx.restore();
      }
      this.trackHits.push({
        track,
        mode: "circular",
        x0: 0,
        x1: 0,
        r0: radius,
        r1: radius + thickness,
      });
      radius += thickness + 3;
    }
    return radius;
  }

  /** Fill the annular sector spanning leaf rows [rowA, rowB]. */
  private fillWedge(
    ctx: CanvasRenderingContext2D,
    rInner: number,
    rOuter: number,
    rowA: number,
    rowB: number,
    n: number,
    halfStep: number,
    fill: string,
  ): void {
    const a0 = this.leafAngle(rowA, n) + halfStep;
    const a1 = this.leafAngle(rowB, n) - halfStep;
    const lo = Math.min(a0, a1);
    const hi = Math.max(a0, a1);
    ctx.beginPath();
    ctx.arc(0, 0, Math.max(0, rInner), lo, hi);
    ctx.arc(0, 0, rOuter, hi, lo, true);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }

  private drawUnrooted(skip: Uint8Array): void {
    const t = this.tree as Tree;
    const lo = this.unrooted as UnrootedLayout;
    if (!lo) return;
    const ctx = this.ctx;
    const W = this.width;
    const H = this.height;
    const { zoom, panX, panY } = this.view;
    const R = (Math.min(W, H) * CIRC_RADIUS_FRACTION) / (lo.maxR || 1);

    ctx.save();
    ctx.translate(W / 2 + panX, H / 2 + panY);
    ctx.scale(zoom, zoom);
    ctx.lineWidth = this.style.branchWidth / zoom;

    for (let id = 0; id < t.count; id++) {
      if (skip[id] === 2) continue;
      for (let c = t.firstChild[id]; c !== -1; c = t.nextSib[c]) {
        if (skip[c] === 2) continue;
        ctx.strokeStyle = this.branchColor(c);
        const dx = (lo.x[c] - lo.x[id]) * R * zoom;
        const dy = (lo.y[c] - lo.y[id]) * R * zoom;
        if (Math.hypot(dx, dy) < 1) continue; // sub-pixel segment
        ctx.beginPath();
        ctx.moveTo(lo.x[id] * R, lo.y[id] * R);
        ctx.lineTo(lo.x[c] * R, lo.y[c] * R);
        ctx.stroke();
      }
    }

    // Annotation tracks, as markers on the tips themselves.
    //
    // There is no rim to hang rings from here: an unrooted layout scatters its
    // tips at every radius and angle, so a concentric ring would have nothing
    // to do with which tip it passed. Marking each tip in place keeps the
    // annotation attached to the thing it describes, which is the only reading
    // that survives this layout.
    if (this.tracks.length) {
      const size = Math.max(2, 4 / zoom);
      let ring = 0;
      for (const track of this.tracks) {
        if (!track.visible) continue;
        const def = getTrack(track.type);
        if (!def) continue;
        const off = ring * (size + 1.5);
        for (let i = 0; i < t.leaves.length; i++) {
          const id = t.leaves[i];
          if (skip[id] === 2) continue;
          const x = lo.x[id] * R;
          const y = lo.y[id] * R;
          const n = Math.hypot(x, y) || 1;
          // Push each successive track a little further out along the tip's
          // own direction from the centre, so several can coexist.
          def.drawCell(
            ctx,
            x + (x / n) * off - size / 2,
            y + (y / n) * off - size / 2,
            size,
            size,
            i,
            track as never,
          );
        }
        this.trackHits.push({ track, mode: "unrooted", x0: 0, x1: 0 });
        ring++;
      }
    }

    // Selected tips get the same caret as in the other layouts, pointing back
    // along the tip's own direction from the centre.
    const sel = this.highlight.selection;
    if (sel && sel.size && sel.size <= POINTER_MAX_MARKS) {
      const R = (Math.min(this.width, this.height) * CIRC_RADIUS_FRACTION) / (lo.maxR || 1);
      for (const row of sel) {
        const id = t.leaves[row];
        if (id === undefined) continue;
        const x = lo.x[id] * R;
        const y = lo.y[id] * R;
        const a = Math.atan2(y, x);
        this.drawPointerCaret(
          x + 4 * Math.cos(a),
          y + 4 * Math.sin(a),
          this.style.selected,
          a,
        );
      }
    }

    ctx.restore();
  }

  // -- interaction -----------------------------------------------------------

  /**
   * Node under a screen point, or -1.
   *
   * O(depth) in rectangular and circular modes: the leaf row is found by
   * arithmetic and only that leaf's root path is tested. garrigue scanned all
   * N nodes on every mousemove, which is what capped it at ~20k leaves.
   */
  pick(sx: number, sy: number, tolerance = 14): number {
    const t = this.tree;
    if (!t || !this.rect) return -1;
    if (this.view.mode === "rect") return this.pickRect(sx, sy, tolerance);
    if (this.view.mode === "circular") return this.pickCircular(sx, sy, tolerance);
    return this.pickUnrooted(sx, sy, tolerance);
  }

  private pickRect(sx: number, sy: number, tol: number): number {
    const t = this.tree as Tree;
    const m = this.lastMetrics ?? this.metrics();
    if (!m) return -1;
    if (m.sy <= 0) return -1;

    // The row under the cursor is arithmetic, so only that leaf's ancestors
    // need testing — O(depth), not O(nodes).
    const est = Math.round(
      (sy - this.height / 2 - this.view.panY) / this.view.vZoom / m.sy - m.originY / m.sy,
    );
    const leafIdx = clampInt(est, 0, t.leaves.length - 1);

    // Measure to the BRANCH, not to the node.
    //
    // A rectangular branch is an elbow: a vertical connector at the parent's x
    // spanning parent.y to child.y, then a horizontal run at the child's y out
    // to child.x. Testing only vertex positions means a click a few pixels
    // along a branch misses everything, which at these row heights is most of
    // the tree — you would have to hit a bifurcation exactly.
    let best = -1;
    let bestD = Infinity;
    let node = t.leaves[leafIdx];

    while (node !== -1) {
      const c = this.screenOf(m, node);
      const parent = t.parent[node];

      let d: number;
      if (parent === -1) {
        d = Math.hypot(sx - c.x, sy - c.y);
      } else {
        const p = this.screenOf(m, parent);
        d = Math.min(
          pointToSegment(sx, sy, p.x, p.y, p.x, c.y), // vertical connector
          pointToSegment(sx, sy, p.x, c.y, c.x, c.y), // horizontal branch
        );
      }

      // `<=` so ties go to the ancestor. A child's connector begins exactly at
      // its parent's position, so clicking a bifurcation is a genuine tie; the
      // larger clade is the more useful thing to hand back, and the walk runs
      // child-to-root.
      if (d <= bestD) {
        bestD = d;
        best = node;
      }
      node = parent;
    }
    return bestD <= tol ? best : -1;
  }

  /**
   * How far out a node sits, as a fraction of the drawn radius.
   *
   * The circular layout borrows the rectangular layout's depths and scales them
   * by `fitX` — the quantile the view frames on — not by `maxX`. Drawing and
   * picking each worked this out for themselves and drifted apart: picking
   * divided by `maxX`, so with one deep outlier every node it tested sat far
   * closer to the centre than the node actually drawn there, and hovering a
   * long branch near the middle matched some unrelated small clade instead.
   * Both go through here now.
   */
  private radialFraction(lo: RectLayout, id: number): number {
    return lo.fitX > 0 ? Math.min(1, lo.x[id] / lo.fitX) : 0;
  }

  /**
   * Which leaf row a screen angle falls on — the inverse of `rectToPolar`.
   *
   * The wrap is the whole difficulty. `atan2` reports an angle in (-pi, pi],
   * but a tip's angle runs `start - ((row + 0.5) / n) * arc`, which for the
   * default 350-degree arc leaves the principal value a full TURN away from
   * the value that generated it. Normalising the row fraction into [0, 1] --
   * the obvious repair, and what this did -- shifts by one arc rather than one
   * turn, so every row past the halfway point came back off by one and the
   * pick walked up the wrong leaf's ancestry entirely.
   *
   * Returns -1 for an angle in the gap the arc leaves open.
   */
  private leafRowAtAngle(angle: number, n: number): number {
    const start = (this.view.rotation * Math.PI) / 180;
    const span = (this.view.arc * Math.PI) / 180;
    const TURN = Math.PI * 2;
    // Radians travelled from the start angle, brought into one honest turn.
    let travelled = (start - angle) % TURN;
    if (travelled < 0) travelled += TURN;
    const row = Math.round((travelled / span) * n - 0.5);
    return row >= 0 && row < n ? row : -1;
  }

  private pickCircular(sx: number, sy: number, tol: number): number {
    const t = this.tree as Tree;
    const lo = this.rect as RectLayout;
    const { zoom, panX, panY, rotation, arc } = this.view;
    const W = this.width;
    const H = this.height;
    const R = Math.min(W, H) * CIRC_RADIUS_FRACTION;
    const n = t.leaves.length || 1;

    const wx = (sx - W / 2 - panX) / zoom;
    const wy = (sy - H / 2 - panY) / zoom;

    // Which leaf row the cursor's angle falls on — O(1), as in rect mode.
    const row = this.leafRowAtAngle(Math.atan2(wy, wx), n);
    const leafIdx = clampInt(row < 0 ? 0 : row, 0, n - 1);

    const pt = (id: number) =>
      rectToPolar(this.radialFraction(lo, id), lo.y[id], n, R, rotation, arc);

    // Measure to the BRANCH. A circular branch is a radial run at the child's
    // angle plus an arc at the parent's radius; testing only vertex positions
    // means a click anywhere along a branch misses, which on a large tree is
    // almost every click.
    let best = -1;
    let bestD = Infinity;
    let node = t.leaves[leafIdx];

    while (node !== -1) {
      const c = pt(node);
      const parent = t.parent[node];

      let d: number;
      if (parent === -1) {
        d = Math.hypot(wx - c.x, wy - c.y);
      } else {
        const p = pt(parent);
        const radialFromX = p.radius * Math.cos(c.angle);
        const radialFromY = p.radius * Math.sin(c.angle);
        d = Math.min(
          pointToSegment(wx, wy, radialFromX, radialFromY, c.x, c.y),
          pointToArc(wx, wy, p.radius, p.angle, c.angle),
        );
      }

      // Ties go to the ancestor, as in rect mode: a child's arc begins at its
      // parent's position, so a bifurcation is a genuine tie.
      if (d <= bestD) {
        bestD = d;
        best = node;
      }
      node = parent;
    }
    return bestD <= tol / zoom ? best : -1;
  }

  /**
   * Unrooted picking uses a uniform spatial grid.
   *
   * This is the one mode where neither source viewer had a shortcut — mytol
   * scanned every node on every mousemove here, same as garrigue. The grid is
   * built once per layout and reused.
   */
  private grid: { cell: number; minX: number; minY: number; cols: number; rows: number; buckets: number[][] } | null = null;

  private buildGrid(): void {
    const t = this.tree as Tree;
    const lo = this.unrooted as UnrootedLayout;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < t.count; i++) {
      if (lo.x[i] < minX) minX = lo.x[i];
      if (lo.x[i] > maxX) maxX = lo.x[i];
      if (lo.y[i] < minY) minY = lo.y[i];
      if (lo.y[i] > maxY) maxY = lo.y[i];
    }
    const cols = Math.max(1, Math.min(256, Math.ceil(Math.sqrt(t.count))));
    const cell = Math.max((maxX - minX) / cols, (maxY - minY) / cols, 1e-9);
    const rows = Math.max(1, Math.ceil((maxY - minY) / cell) + 1);
    const buckets: number[][] = Array.from({ length: (cols + 1) * rows }, () => []);
    for (let i = 0; i < t.count; i++) {
      const cx = Math.min(cols, Math.floor((lo.x[i] - minX) / cell));
      const cy = Math.min(rows - 1, Math.floor((lo.y[i] - minY) / cell));
      buckets[cy * (cols + 1) + cx].push(i);
    }
    this.grid = { cell, minX, minY, cols, rows, buckets };
  }

  private pickUnrooted(sx: number, sy: number, tol: number): number {
    const lo = this.unrooted;
    if (!lo) return -1;
    if (!this.grid) this.buildGrid();
    const g = this.grid;
    if (!g) return -1;

    const { zoom, panX, panY } = this.view;
    const R = (Math.min(this.width, this.height) * CIRC_RADIUS_FRACTION) / (lo.maxR || 1);
    const wx = (sx - this.width / 2 - panX) / zoom / R;
    const wy = (sy - this.height / 2 - panY) / zoom / R;

    const cx = Math.floor((wx - g.minX) / g.cell);
    const cy = Math.floor((wy - g.minY) / g.cell);

    let best = -1;
    let bestD = Infinity;
    for (let j = cy - 1; j <= cy + 1; j++) {
      if (j < 0 || j >= g.rows) continue;
      for (let i = cx - 1; i <= cx + 1; i++) {
        if (i < 0 || i > g.cols) continue;
        for (const id of g.buckets[j * (g.cols + 1) + i]) {
          const d = Math.hypot(wx - lo.x[id], wy - lo.y[id]);
          if (d < bestD) {
            bestD = d;
            best = id;
          }
        }
      }
    }
    return bestD * R * zoom <= tol ? best : -1;
  }

  /**
   * Screen position of a node in the current view, or null.
   *
   * Hosts need this to anchor tooltips and context menus to the thing that was
   * clicked, and it makes the picking path testable without pixel inspection.
   */
  screenPosition(id: number): { x: number; y: number } | null {
    const t = this.tree;
    if (!t || id < 0 || id >= t.count) return null;

    if (this.view.mode === "rect") {
      const m = this.lastMetrics ?? this.metrics();
      if (!m) return null;
      return this.screenOf(m, id);
    }

    if (this.view.mode === "circular") {
      const lo = this.rect;
      if (!lo) return null;
      const R = Math.min(this.width, this.height) * CIRC_RADIUS_FRACTION;
      const n = t.leaves.length || 1;
      const p = rectToPolar(
        this.radialFraction(lo, id),
        lo.y[id],
        n,
        R,
        this.view.rotation,
        this.view.arc,
      );
      return {
        x: this.width / 2 + this.view.panX + p.x * this.view.zoom,
        y: this.height / 2 + this.view.panY + p.y * this.view.zoom,
      };
    }

    const lo = this.unrooted;
    if (!lo) return null;
    const R = (Math.min(this.width, this.height) * CIRC_RADIUS_FRACTION) / (lo.maxR || 1);
    return {
      x: this.width / 2 + this.view.panX + lo.x[id] * R * this.view.zoom,
      y: this.height / 2 + this.view.panY + lo.y[id] * R * this.view.zoom,
    };
  }

  /**
   * What lies under the cursor in an annotation track, if anything.
   *
   * Returns the track and the leaf row it belongs to, so a host can say both
   * which protein and which annotation the pointer is over. Tracks sit outside
   * the tree, so a plain node pick never reaches them and the two hit tests
   * have to be separate.
   */
  trackAt(sx: number, sy: number): TrackHover | null {
    const t = this.tree;
    if (!t || !this.trackHits.length) return null;

    if (this.view.mode === "rect") {
      // Markers sit in the gap beside their strip and are only a few pixels
      // across, so they are tested first and with a little slack.
      for (const mk of this.trackMarkers) {
        if (sx >= mk.x0 - 2 && sx <= mk.x1 + 2 && Math.abs(sy - mk.y) <= 5) {
          return {
            track: mk.track,
            leafIndex: -1,
            hiddenCategory: mk.category,
            hiddenCount: mk.count,
          };
        }
      }
      for (const hit of this.trackHits) {
        if (hit.mode !== "rect") continue;
        if (sx < hit.x0 || sx > hit.x1) continue;
        // When the strip is aggregated, report the leaf whose value is actually
        // painted on this pixel row rather than whichever leaf the row maps to
        // arithmetically — otherwise the tooltip names a different value from
        // the colour under the cursor.
        const bands = this.bandLeaf.get(hit.track);
        if (bands) {
          const b = Math.floor(sy) - bands.top;
          if (b < 0 || b >= bands.leaf.length) return null;
          const leaf = bands.leaf[b] >= 0 ? bands.leaf[b] : bands.any[b];
          if (leaf < 0) return null;
          return { track: hit.track, leafIndex: leaf };
        }
        const leafIndex = this.leafIndexAt(sy);
        if (leafIndex < 0) return null;
        return { track: hit.track, leafIndex };
      }
      return null;
    }

    if (this.view.mode === "circular") {
      const { zoom, panX, panY } = this.view;
      const wx = (sx - this.width / 2 - panX) / zoom;
      const wy = (sy - this.height / 2 - panY) / zoom;
      const r = Math.hypot(wx, wy);
      const n = t.leaves.length || 1;

      for (const hit of this.trackHits) {
        if (hit.mode !== "circular" || hit.r0 === undefined || hit.r1 === undefined) continue;
        if (r < hit.r0 || r > hit.r1) continue;
        const row = this.leafRowAtAngle(Math.atan2(wy, wx), n);
        if (row < 0) return null;
        return { track: hit.track, leafIndex: row };
      }
      return null;
    }

    // Unrooted: tracks are drawn as markers at the tips themselves, so the
    // nearest tip is the answer.
    const leaf = this.pickUnrootedLeaf(sx, sy);
    if (leaf < 0) return null;
    const first = this.trackHits.find((h) => h.mode === "unrooted");
    return first ? { track: first.track, leafIndex: leaf } : null;
  }

  /** Nearest tip to a screen point in the unrooted layout. */
  private pickUnrootedLeaf(sx: number, sy: number, tol = 10): number {
    const t = this.tree;
    const lo = this.unrooted;
    if (!t || !lo) return -1;
    const { zoom, panX, panY } = this.view;
    const R = (Math.min(this.width, this.height) * CIRC_RADIUS_FRACTION) / (lo.maxR || 1);
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < t.leaves.length; i++) {
      const id = t.leaves[i];
      const x = this.width / 2 + panX + lo.x[id] * R * zoom;
      const y = this.height / 2 + panY + lo.y[id] * R * zoom;
      const d = Math.hypot(sx - x, sy - y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return bestD <= tol ? best : -1;
  }

  /** Leaf index at a screen y, rectangular mode. -1 when outside the tree. */
  leafIndexAt(sy: number): number {
    const t = this.tree;
    const m = this.lastMetrics ?? this.metrics();
    if (!t || !m || this.view.mode !== "rect") return -1;
    const est = Math.round(
      (sy - this.height / 2 - this.view.panY) / this.view.vZoom / m.sy - m.originY / m.sy,
    );
    if (est < 0 || est >= t.leaves.length) return -1;
    return est;
  }

  /** Fit the whole tree in view. */
  fit(): void {
    if (!this.tree) return;
    if (this.view.mode === "rect") {
      this.setView({ panX: 0, panY: 0, vZoom: 1 });
    } else {
      this.setView({ panX: 0, panY: 0, zoom: 1 });
    }
  }

  /** Invalidate cached spatial structures; call after a tree edit. */
  invalidate(): void {
    this.grid = null;
    this.recomputeLayouts();
    this.requestDraw();
  }
}

/** Distance from a point to a circular arc centred on the origin. */
function pointToArc(
  px: number,
  py: number,
  radius: number,
  a0: number,
  a1: number,
): number {
  const r = Math.hypot(px, py);
  const lo = Math.min(a0, a1);
  const hi = Math.max(a0, a1);
  let a = Math.atan2(py, px);
  // bring the angle into the same turn as the arc before comparing
  while (a < lo - Math.PI) a += 2 * Math.PI;
  while (a > lo + Math.PI) a -= 2 * Math.PI;
  if (a >= lo && a <= hi) return Math.abs(r - radius);
  return Math.min(
    Math.hypot(px - radius * Math.cos(lo), py - radius * Math.sin(lo)),
    Math.hypot(px - radius * Math.cos(hi), py - radius * Math.sin(hi)),
  );
}

/** Distance from a point to a line segment. */
function pointToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Parse #rgb or #rrggbb into channels. */
export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.trim().replace("#", "");
  if (h.length === 3) {
    return [
      parseInt(h[0] + h[0], 16),
      parseInt(h[1] + h[1], 16),
      parseInt(h[2] + h[2], 16),
    ];
  }
  const m = /^([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(h);
  if (!m) return [128, 128, 128];
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

/** Blend two colours, `t` of the way from a to b. */
function mix(a: [number, number, number], b: [number, number, number], t: number): string {
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * u)},${Math.round(
    a[1] + (b[1] - a[1]) * u,
  )},${Math.round(a[2] + (b[2] - a[2]) * u)})`;
}

/** How finely the support ramp is quantised for the lookup table. */
const RAMP_STEPS = 128;

const DEFAULT_RAMP = { low: "#d73027", mid: "#fee08b", high: "#1a9850" };

/** Channels for a support value on a three-stop ramp. */
export function supportRgb(
  v: number,
  ramp: { low: string; mid: string; high: string } = DEFAULT_RAMP,
  midpoint = 0.5,
): [number, number, number] {
  const x = Math.max(0, Math.min(1, v));
  const m = Math.max(0.001, Math.min(0.999, midpoint));
  const lerp = (
    a: [number, number, number],
    b: [number, number, number],
    t: number,
  ): [number, number, number] => [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
  return x <= m
    ? lerp(hexToRgb(ramp.low), hexToRgb(ramp.mid), x / m)
    : lerp(hexToRgb(ramp.mid), hexToRgb(ramp.high), (x - m) / (1 - m));
}

/** Colour for a support value on a three-stop ramp. */
export function supportColor(
  v: number,
  ramp: { low: string; mid: string; high: string } = DEFAULT_RAMP,
  midpoint = 0.5,
): string {
  const [r, g, b] = supportRgb(v, ramp, midpoint);
  return `rgb(${r},${g},${b})`;
}
