/**
 * Interaction logic, as pure functions.
 *
 * Kept out of the component so the semantics can be tested without a DOM.
 * These rules are garrigue's, which are in turn iToL's, and they are the piece
 * mytol was missing entirely: it tracked a single `selectedNode` and had no
 * multi-select, no pinning, no additive click and no box select.
 */

import type { Tree } from "@mytol/core";
import { cladeInterval, indicesToIntervals, normaliseIntervals, type Interval } from "@mytol/core";

export interface SelectionState {
  /** Selected LEAF INDICES (not node ids). */
  leaves: Set<number>;
  /** Node id whose clade is pinned, or -1. */
  pinned: number;
}

export function emptySelection(): SelectionState {
  return { leaves: new Set(), pinned: -1 };
}

export interface ClickModifiers {
  /** ctrl or cmd — add to the selection instead of replacing it. */
  additive: boolean;
}

/**
 * Result of clicking at a picked node.
 *
 * Semantics, matching garrigue:
 *  - clicking an internal node REPLACES the selection with that whole clade
 *    and pins it;
 *  - clicking a leaf TOGGLES that leaf;
 *  - clicking empty space clears the selection and unpins;
 *  - ctrl/cmd makes any of the above additive and never clears.
 */
export function applyClick(
  tree: Tree,
  state: SelectionState,
  nodeId: number,
  mods: ClickModifiers,
): SelectionState {
  if (nodeId < 0) {
    // empty space
    if (mods.additive) return state;
    return { leaves: new Set(), pinned: -1 };
  }

  const leaves = mods.additive ? new Set(state.leaves) : new Set<number>();

  if (!tree.isLeaf[nodeId]) {
    for (let i = tree.L[nodeId]; i < tree.R[nodeId]; i++) leaves.add(i);
    return { leaves, pinned: nodeId };
  }

  const idx = tree.leafIndex[nodeId];
  if (mods.additive && leaves.has(idx)) leaves.delete(idx);
  else leaves.add(idx);
  return { leaves, pinned: nodeId };
}

/**
 * Box selection over a row range.
 *
 * garrigue's box select ignores the box's x extent entirely — only the rows it
 * spans matter — and is always additive. Both are deliberate: a phylogeny's
 * meaningful axis is the leaf order, and a box drag is a gesture for widening
 * a selection.
 */
export function applyBoxSelect(
  state: SelectionState,
  fromLeaf: number,
  toLeaf: number,
  nLeaves: number,
): SelectionState {
  const lo = Math.max(0, Math.min(fromLeaf, toLeaf));
  const hi = Math.min(nLeaves - 1, Math.max(fromLeaf, toLeaf));
  const leaves = new Set(state.leaves);
  for (let i = lo; i <= hi; i++) leaves.add(i);
  return { leaves, pinned: state.pinned };
}

/** Select every leaf under a node, replacing the selection. */
export function selectClade(tree: Tree, nodeId: number): SelectionState {
  const leaves = new Set<number>();
  for (let i = tree.L[nodeId]; i < tree.R[nodeId]; i++) leaves.add(i);
  return { leaves, pinned: nodeId };
}

/** The selection as leaf-index intervals — the form Zahir's API accepts. */
export function selectionIntervals(state: SelectionState): Interval[] {
  if (state.leaves.size === 0) return [];
  return indicesToIntervals(Array.from(state.leaves));
}

/** The pinned clade as a single interval, when one is pinned. */
export function pinnedInterval(tree: Tree, state: SelectionState): Interval | null {
  if (state.pinned < 0 || state.pinned >= tree.count) return null;
  return cladeInterval(tree, state.pinned);
}

/** Merge extra intervals into a selection. */
export function addIntervals(state: SelectionState, intervals: Interval[]): SelectionState {
  const leaves = new Set(state.leaves);
  for (const [a, b] of normaliseIntervals(intervals)) {
    for (let i = a; i < b; i++) leaves.add(i);
  }
  return { leaves, pinned: state.pinned };
}

// ============================================================
// Zoom
// ============================================================

export interface ZoomResult {
  vZoom: number;
  zoom: number;
  panX: number;
  panY: number;
}

/**
 * Wheel zoom anchored at the cursor.
 *
 * In rectangular mode only the vertical axis scales. That is mytol's model and
 * it is the right one for a phylogeny: the horizontal axis carries branch
 * length and stays fitted to the panel, while zooming separates leaf rows.
 * garrigue's single uniform zoom cannot express this, so its behaviour is
 * deliberately not carried over.
 */
export function applyWheelZoom(
  mode: "rect" | "circular" | "unrooted",
  view: { vZoom: number; zoom: number; panX: number; panY: number },
  deltaY: number,
  cursorX: number,
  cursorY: number,
  bounds: { width: number; height: number },
  limits: { min: number; max: number } = { min: 0.05, max: 20000 },
): ZoomResult {
  const factor = Math.exp(-deltaY * 0.0015);

  if (mode === "rect") {
    const next = clamp(view.vZoom * factor, limits.min, limits.max);
    const applied = next / view.vZoom;
    // keep the point under the cursor fixed
    const centreY = bounds.height / 2;
    const panY = cursorY - centreY - (cursorY - centreY - view.panY) * applied;
    return { vZoom: next, zoom: view.zoom, panX: view.panX, panY };
  }

  const next = clamp(view.zoom * factor, limits.min, limits.max);
  const applied = next / view.zoom;
  const cx = bounds.width / 2;
  const cy = bounds.height / 2;
  const panX = cursorX - cx - (cursorX - cx - view.panX) * applied;
  const panY = cursorY - cy - (cursorY - cy - view.panY) * applied;
  return { vZoom: view.vZoom, zoom: next, panX, panY };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ============================================================
// Context menu
// ============================================================

export type ContextAction =
  | "copy-labels"
  | "copy-uid"
  | "rotate"
  | "reroot"
  | "collapse"
  | "color-range"
  | "select-clade"
  | "prune"
  | "keep-only";

export interface ContextMenuRequest {
  nodeId: number;
  uid: number;
  isLeaf: boolean;
  nLeaves: number;
  label: string;
  /** Screen coordinates for placing the menu. */
  x: number;
  y: number;
}

/** Describe the node a context menu was opened on. */
export function contextRequest(
  tree: Tree,
  nodeId: number,
  x: number,
  y: number,
): ContextMenuRequest | null {
  if (nodeId < 0 || nodeId >= tree.count) return null;
  const isLeaf = tree.isLeaf[nodeId] === 1;
  const n = tree.R[nodeId] - tree.L[nodeId];
  return {
    nodeId,
    uid: tree.uid[nodeId],
    isLeaf,
    nLeaves: n,
    label: isLeaf ? tree.name[nodeId] || "(unnamed leaf)" : `clade · ${n} leaves`,
    x,
    y,
  };
}

/** Leaf labels under a node, newline joined — the "copy leaf labels" action. */
export function leafLabelsOf(tree: Tree, nodeId: number): string {
  const out: string[] = [];
  for (let i = tree.L[nodeId]; i < tree.R[nodeId]; i++) {
    const name = tree.name[tree.leaves[i]];
    if (name) out.push(name);
  }
  return out.join("\n");
}
