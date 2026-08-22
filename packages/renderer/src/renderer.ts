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
    this.requestDraw();
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
    const labelW = this.style.showLeafLabels ? LABEL_RESERVE_PX : 0;
    const usableW = Math.max(10, W - 2 * PADDING - trackWidth - labelW);
    const sx = usableW / Math.max(1e-9, this.rect.maxX);
    const sy = (H - 2 * PADDING) / Math.max(1, this.rect.height);

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
    if (s.colorBySupport) {
      const v = t.support[id];
      if (!Number.isNaN(v)) return supportColor(v);
    }
    const mask = this.highlight.mask;
    if (mask) {
      // A clade is dimmed only when NO leaf under it passes the filter.
      let any = false;
      for (let i = t.L[id]; i < t.R[id]; i++) {
        if (mask[i]) {
          any = true;
          break;
        }
      }
      if (!any) return s.dimmed;
    }
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
    if (!this.style.showLeafLabels) return;
    // Labels are only legible above ~7px of row height; below that they would
    // be an unreadable smear that costs a measureText per leaf.
    if (rowH < 7) return;
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

  private drawCircular(skip: Uint8Array): void {
    const t = this.tree as Tree;
    const lo = this.rect as RectLayout;
    const ctx = this.ctx;
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
    const lw = this.style.branchWidth / zoom;

    for (let id = 0; id < t.count; id++) {
      if (skip[id] === 2) continue;
      if (id !== t.root && skip[id] === 0 && this.style.lodMinPx > 0) {
        if ((t.R[id] - t.L[id]) * arcPerLeaf < this.style.lodMinPx) continue;
      }
      const p = pt(id);
      ctx.strokeStyle = this.branchColor(id);
      ctx.lineWidth = lw;

      for (let c = t.firstChild[id]; c !== -1; c = t.nextSib[c]) {
        if (skip[c] === 2) continue;
        const q = pt(c);
        // radial segment
        ctx.beginPath();
        ctx.moveTo(p.radius * Math.cos(q.angle), p.radius * Math.sin(q.angle));
        ctx.lineTo(q.x, q.y);
        ctx.stroke();
        // arc segment joining parent to child angle
        ctx.beginPath();
        ctx.arc(0, 0, p.radius, Math.min(p.angle, q.angle), Math.max(p.angle, q.angle));
        ctx.stroke();
      }
    }
    ctx.restore();
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
    const rowH = m.sy * this.view.vZoom;
    if (rowH <= 0) return -1;

    const est = Math.round(
      (sy - this.height / 2 - this.view.panY) / this.view.vZoom / m.sy - m.originY / m.sy,
    );
    const leafIdx = clampInt(est, 0, t.leaves.length - 1);
    let node = t.leaves[leafIdx];

    let best = -1;
    let bestD = Infinity;
    while (node !== -1) {
      const p = this.screenOf(m, node);
      const d = Math.hypot(sx - p.x, sy - p.y);
      if (d < bestD) {
        bestD = d;
        best = node;
      }
      node = t.parent[node];
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

    let angle = Math.atan2(wy, wx);
    const start = (rotation * Math.PI) / 180;
    const span = (arc * Math.PI) / 180;
    let frac = (start - angle) / span;
    while (frac < 0) frac += 1;
    while (frac > 1) frac -= 1;
    const leafIdx = clampInt(Math.round(frac * n - 0.5), 0, n - 1);

    let node = t.leaves[leafIdx];
    let best = -1;
    let bestD = Infinity;
    while (node !== -1) {
      const p = rectToPolar(lo.maxX > 0 ? lo.x[node] / lo.maxX : 0, lo.y[node], n, R, rotation, arc);
      const d = Math.hypot(wx - p.x, wy - p.y);
      if (d < bestD) {
        bestD = d;
        best = node;
      }
      node = t.parent[node];
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

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Red (low) to green (high) support ramp, matching garrigue. */
export function supportColor(v: number): string {
  const x = Math.max(0, Math.min(1, v));
  return `rgb(${Math.round(220 * (1 - x))},${Math.round(160 * x + 40)},60)`;
}
