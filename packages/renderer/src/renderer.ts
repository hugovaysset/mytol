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
  defaultStyle,
  emptyHighlight,
} from "./types";
import { getTrack, initTrack } from "./registry";

const PADDING = 40;
const LABEL_RESERVE_PX = 150;
/** Rows shorter than this cannot carry a readable label, so none is drawn. */
const LABEL_MIN_ROW_PX = 7;
const CIRC_RADIUS_FRACTION = 0.45;
const MIN_EDGE_PIXELS = 0.5;
const TRACK_GAP = 6;

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
  private width = 0;
  private height = 0;
  private lastMetrics: RectMetrics | null = null;

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
    if (view.phylogram !== undefined && view.phylogram !== before.phylogram) {
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
    this.rect = layoutRectangular(this.tree, this.view.phylogram);
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
    const sx = usableW / Math.max(1e-9, this.rect.maxX);

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
    const trackStartX = this.view.panX + PADDING + sx * this.rect.maxX + TRACK_GAP;
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
    const lw = s.branchWidth;
    for (let id = 0; id < t.count; id++) {
      if (skip[id] === 2) continue;
      if (t.R[id] <= m.visibleLeafStart || t.L[id] >= m.visibleLeafEnd) continue;

      // Level of detail: drop clades too short to register on screen.
      if (id !== t.root && skip[id] === 0 && s.lodMinPx > 0) {
        const cladePx = (t.R[id] - t.L[id]) * rowH;
        if (cladePx < s.lodMinPx) continue;
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

      const colorP = this.branchColor(id);
      for (let c = t.firstChild[id]; c !== -1; c = t.nextSib[c]) {
        if (skip[c] === 2) continue;
        const pc = this.screenOf(m, c);
        // vertical connector
        if (Math.abs(pc.y - p.y) >= MIN_EDGE_PIXELS) {
          ctx.fillStyle = colorP;
          const yA = Math.min(p.y, pc.y);
          ctx.fillRect(p.x - lw / 2, yA, lw, Math.abs(pc.y - p.y));
        }
        // horizontal branch
        if (Math.abs(pc.x - p.x) >= MIN_EDGE_PIXELS) {
          ctx.fillStyle = this.branchColor(c);
          const xA = Math.min(p.x, pc.x);
          ctx.fillRect(xA, pc.y - lw / 2, Math.abs(pc.x - p.x), lw);
        }
      }
    }

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
    this.drawLeafLabels(m, rowH);
    this.drawSupport(m, rowH, skip);
  }

  private rowY(m: RectMetrics, leafIndex: number): number {
    const wy = m.originY + m.sy * leafIndex;
    return this.height / 2 + this.view.panY + wy * this.view.vZoom;
  }

  private drawTracks(m: RectMetrics, rowH: number): void {
    if (!this.tracks.length) return;
    const ctx = this.ctx;

    // LOD: when rows are sub-pixel, sample every Nth leaf instead of drawing
    // every one. This is what keeps track drawing O(screen height).
    const step = Math.max(1, Math.floor(this.style.lodMinPx / Math.max(rowH, 1e-6)));

    let colX = m.trackStartX;
    for (const track of this.tracks) {
      if (!track.visible) continue;
      const def = getTrack(track.type);
      if (!def) continue;
      const w = track.width ?? def.width;

      // header
      if (this.style.showLeafLabels) {
        ctx.fillStyle = this.style.textMuted;
        ctx.font = `10px ${this.style.fontFamily}`;
        ctx.textBaseline = "alphabetic";
        ctx.save();
        ctx.beginPath();
        ctx.rect(colX, 0, w + TRACK_GAP, 14);
        ctx.clip();
        ctx.fillText(track.label, colX, 11);
        ctx.restore();
      }

      for (let i = m.visibleLeafStart; i < m.visibleLeafEnd; i += step) {
        const y = this.rowY(m, i) - rowH / 2;
        def.drawCell(ctx, colX, y, w, Math.max(1, rowH * step), i, track as never);
      }
      colX += w + TRACK_GAP;
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
      rectToPolar(lo.maxX > 0 ? lo.x[id] / lo.maxX : 0, lo.y[id], n, R, rotation, arc);

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
      ctx.strokeStyle = this.branchColor(id);
      ctx.lineWidth = lw;

      for (let c = t.firstChild[id]; c !== -1; c = t.nextSib[c]) {
        if (skip[c] === 2) continue;
        const q = pt(c);
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
      ctx.strokeStyle = this.branchColor(id);
      for (let c = t.firstChild[id]; c !== -1; c = t.nextSib[c]) {
        if (skip[c] === 2) continue;
        const dx = (lo.x[c] - lo.x[id]) * R * zoom;
        const dy = (lo.y[c] - lo.y[id]) * R * zoom;
        if (Math.hypot(dx, dy) < 1) continue; // sub-pixel segment
        ctx.beginPath();
        ctx.moveTo(lo.x[id] * R, lo.y[id] * R);
        ctx.lineTo(lo.x[c] * R, lo.y[c] * R);
        ctx.stroke();
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
    const angle = Math.atan2(wy, wx);
    const start = (rotation * Math.PI) / 180;
    const span = (arc * Math.PI) / 180;
    let frac = (start - angle) / span;
    while (frac < 0) frac += 1;
    while (frac > 1) frac -= 1;
    const leafIdx = clampInt(Math.round(frac * n - 0.5), 0, n - 1);

    const pt = (id: number) =>
      rectToPolar(lo.maxX > 0 ? lo.x[id] / lo.maxX : 0, lo.y[id], n, R, rotation, arc);

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
        lo.maxX > 0 ? lo.x[id] / lo.maxX : 0,
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
