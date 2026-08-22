/**
 * Tree-edit state: the current tree, the pristine original, and whether the
 * two differ.
 *
 * garrigue's "Reset all tree edits" is all-or-nothing — it restores the
 * original and drops everything. That is cheap and predictable, but it is not
 * an undo stack. Here the history is kept explicitly, so a single edit can be
 * undone as well, which the data model already supported: trees are immutable
 * and every edit returns a new one, so a history is just an array.
 */

import {
  type Tree,
  type Uid,
  reroot as coreReroot,
  midpointRoot as coreMidpoint,
  ladderize as coreLadderize,
  rotateChildren as coreRotate,
  pruneLeaves,
  canonicalLeafOrder,
  type LadderDir,
} from "@mytol/core";

export interface TreeEditState {
  tree: Tree;
  original: Tree;
  /** Past trees, most recent last. */
  history: Tree[];
  /**
   * uid -> leaf index in the ORIGINAL ordering.
   *
   * The server's leaf ordering is fixed at load time, but rerooting and
   * rotating reorder leaves in the browser. Keeping this map lets a selection
   * made after an edit be translated back into indices the server recognises.
   */
  canonical: Map<Uid, number>;
}

export function initTreeState(tree: Tree): TreeEditState {
  return {
    tree,
    original: tree,
    history: [],
    canonical: canonicalLeafOrder(tree),
  };
}

export const isEdited = (s: TreeEditState): boolean => s.tree !== s.original;
export const canUndo = (s: TreeEditState): boolean => s.history.length > 0;

function push(s: TreeEditState, next: Tree): TreeEditState {
  if (next === s.tree) return s;
  return { ...s, tree: next, history: [...s.history, s.tree] };
}

export function reroot(s: TreeEditState, nodeId: number): TreeEditState {
  return push(s, coreReroot(s.tree, nodeId));
}

export function midpointRoot(s: TreeEditState): TreeEditState {
  return push(s, coreMidpoint(s.tree));
}

export function ladderize(s: TreeEditState, dir: LadderDir): TreeEditState {
  return push(s, coreLadderize(s.tree, dir));
}

export function rotate(s: TreeEditState, nodeId: number): TreeEditState {
  return push(s, coreRotate(s.tree, nodeId));
}

/** Remove the given leaf indices. Returns the state unchanged if all would go. */
export function pruneSelection(s: TreeEditState, leafIndices: Set<number>): TreeEditState {
  const t = s.tree;
  const next = pruneLeaves(t, (id) => !leafIndices.has(t.leafIndex[id]));
  return next ? push(s, next) : s;
}

/** Keep only the given leaf indices. */
export function keepOnly(s: TreeEditState, leafIndices: Set<number>): TreeEditState {
  const t = s.tree;
  const next = pruneLeaves(t, (id) => leafIndices.has(t.leafIndex[id]));
  return next ? push(s, next) : s;
}

export function undo(s: TreeEditState): TreeEditState {
  if (!s.history.length) return s;
  const history = s.history.slice();
  const prev = history.pop() as Tree;
  return { ...s, tree: prev, history };
}

/** Restore the pristine tree, discarding every edit. */
export function resetEdits(s: TreeEditState): TreeEditState {
  if (s.tree === s.original) return s;
  return { ...s, tree: s.original, history: [] };
}
