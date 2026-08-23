/**
 * Layout: assigning coordinates to nodes. Pure maths, no canvas, no DOM.
 *
 * All three layouts are iterative. mytol's unrooted layout recursed, which put
 * a ceiling on tree depth; that is gone.
 */

import type { Tree } from "./types";

export interface RectLayout {
  /** x per node id (branch-length or depth units). */
  x: Float64Array;
  /** y per node id, in leaf-index units. */
  y: Float64Array;
  /** Largest x in the tree — the deepest tip, outliers included. */
  maxX: number;
  /**
   * The x a view should scale to: a quantile of the LEAF positions.
   *
   * Scaling to `maxX` lets one long branch decide the layout for everything
   * else. On the SIR2 tree the deepest tip sits at 15.9 while the 90th
   * percentile is 4.9 — so a single outlier squeezes nine tenths of the tree
   * into under a third of the panel. Framing on the quantile keeps the bulk of
   * the tree legible; the few tips beyond it are clipped at the edge and
   * marked, not hidden.
   */
  fitX: number;
  /** Vertical extent in leaf-index units. */
  height: number;
}

/**
 * Rectangular layout.
 *
 * `phylogram` puts x at cumulative branch length; otherwise it is a cladogram
 * where leaves are flush right and internal nodes sit as far right as the
 * topology allows.
 */
export function layoutRectangular(
  t: Tree,
  phylogram: boolean,
  fitQuantile = 0.9,
): RectLayout {
  const x = new Float64Array(t.count);
  const y = new Float64Array(t.count);

  let maxX = 0;
  if (phylogram) {
    for (let i = 0; i < t.count; i++) {
      x[i] = t.cumLen[i];
      if (x[i] > maxX) maxX = x[i];
    }
    if (maxX === 0) maxX = 1;
  } else {
    // subtreeHeight = longest edge count to a descendant leaf
    const h = new Int32Array(t.count);
    const pre = preOrder(t);
    for (let k = pre.length - 1; k >= 0; k--) {
      const id = pre[k];
      const p = t.parent[id];
      if (p !== -1 && h[id] + 1 > h[p]) h[p] = h[id] + 1;
    }
    maxX = h[t.root] || 1;
    for (let i = 0; i < t.count; i++) x[i] = maxX - h[i];
  }

  // Internal nodes sit at the MEAN of their children, not at the midpoint of
  // their leaf span.
  //
  // The two agree on a balanced tree and diverge sharply on an unbalanced one,
  // and the difference is visible: a parent placed at its leaf-span midpoint
  // meets the connector joining its children off-centre, which in the circular
  // layout reads as the radial branch attaching to one side of the arc rather
  // than to the middle of it. The mean is the classic dendrogram convention
  // and makes the join land where the eye expects.
  const pre = preOrder(t);
  for (const id of pre) {
    if (t.isLeaf[id]) y[id] = t.leafIndex[id];
  }
  for (let k = pre.length - 1; k >= 0; k--) {
    const id = pre[k];
    if (t.isLeaf[id]) continue;
    let sum = 0;
    let n = 0;
    for (let c = t.firstChild[id]; c !== -1; c = t.nextSib[c]) {
      sum += y[c];
      n++;
    }
    y[id] = n ? sum / n : 0;
  }

  // The framing extent, over leaves only: internal nodes are never the
  // rightmost thing, and a quantile over all nodes would be dragged left by
  // the many shallow ones.
  let fitX = maxX;
  const q = Math.min(1, Math.max(0, fitQuantile));
  if (q < 1 && t.leaves.length > 1) {
    const leafX = new Float64Array(t.leaves.length);
    for (let i = 0; i < t.leaves.length; i++) leafX[i] = x[t.leaves[i]];
    leafX.sort();
    const at = leafX[Math.min(leafX.length - 1, Math.round(q * (leafX.length - 1)))];
    // On a tree without outliers the quantile and the max nearly coincide, so
    // this costs nothing there and only bites when there is a long tail.
    if (at > 0) fitX = at;
  }
  if (!(fitX > 0)) fitX = maxX || 1;

  const height = t.leaves.length > 0 ? t.leaves.length - 1 : 1;
  return { x, y, maxX, fitX, height };
}

function preOrder(t: Tree): Int32Array {
  const out = new Int32Array(t.count);
  let n = 0;
  const stack = [t.root];
  while (stack.length) {
    const id = stack.pop() as number;
    out[n++] = id;
    for (let c = t.firstChild[id]; c !== -1; c = t.nextSib[c]) stack.push(c);
  }
  return out.subarray(0, n) as Int32Array;
}

export interface PolarPoint {
  x: number;
  y: number;
  angle: number;
  radius: number;
}

/**
 * Map a rectangular coordinate onto a circle. The circular layout is derived
 * from the rectangular one rather than computed separately, so the two stay
 * consistent and only one layout has to be recomputed on edit.
 *
 * @param xNorm  x in [0,1], 0 at the root
 * @param yLeaf  leaf-index coordinate
 * @param n      leaf count
 * @param radius outer radius in pixels
 * @param startAngleDeg where the arc begins, degrees clockwise from +x
 * @param arcDeg how much of the circle the leaves span
 */
export function rectToPolar(
  xNorm: number,
  yLeaf: number,
  n: number,
  radius: number,
  startAngleDeg: number,
  arcDeg: number,
): PolarPoint {
  const start = (startAngleDeg * Math.PI) / 180;
  const arc = (arcDeg * Math.PI) / 180;
  const t = n > 0 ? (yLeaf + 0.5) / n : 0;
  const angle = start - t * arc;
  const r = xNorm * radius;
  return { x: r * Math.cos(angle), y: r * Math.sin(angle), angle, radius: r };
}

export interface UnrootedLayout {
  x: Float64Array;
  y: Float64Array;
  angle: Float64Array;
  maxR: number;
}

/**
 * Felsenstein equal-angle unrooted layout, iterative.
 *
 * Each subtree receives an angular wedge proportional to its leaf count. The
 * wedge for a node is known from its clade interval (R-L), so no separate
 * leaf-count pass is needed.
 */
export function layoutUnrooted(t: Tree, ignoreBranchLength: boolean): UnrootedLayout {
  const x = new Float64Array(t.count);
  const y = new Float64Array(t.count);
  const angle = new Float64Array(t.count);

  const nLeaves = t.leaves.length || 1;
  const step = (2 * Math.PI) / nLeaves;

  // Each frame carries the wedge start for the node being expanded.
  const wedgeStart = new Float64Array(t.count);
  wedgeStart[t.root] = 0;
  x[t.root] = 0;
  y[t.root] = 0;
  angle[t.root] = 0;

  const stack = [t.root];
  let maxR = 0;

  while (stack.length) {
    const id = stack.pop() as number;
    let a = wedgeStart[id];

    for (let c = t.firstChild[id]; c !== -1; c = t.nextSib[c]) {
      const span = (t.R[c] - t.L[c]) * step;
      const mid = a + span / 2;
      const rawLen = t.length[c];
      const len = ignoreBranchLength ? 0.1 : Number.isNaN(rawLen) ? 0.01 : rawLen || 0.01;

      x[c] = x[id] + len * Math.cos(mid);
      y[c] = y[id] + len * Math.sin(mid);
      angle[c] = mid;

      const r = Math.hypot(x[c], y[c]);
      if (r > maxR) maxR = r;

      if (!t.isLeaf[c]) {
        wedgeStart[c] = a;
        stack.push(c);
      }
      a += span;
    }
  }

  return { x, y, angle, maxR: maxR || 1 };
}
