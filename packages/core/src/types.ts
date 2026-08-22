/**
 * Core tree types.
 *
 * The model is a struct-of-arrays: every per-node field lives in its own typed
 * array indexed by node id. This is deliberate and differs from the original
 * mytol model (an array of `Node` objects):
 *
 *  - a 500k-leaf tree is ~1M nodes, which as objects costs >100 MB and heavy GC
 *    pressure; as typed arrays it is a few tens of MB with none;
 *  - the renderer's hot loops read numbers, not object properties;
 *  - typed arrays are *transferable*, so parsing can move to a Web Worker and
 *    hand the result back with no structured-clone copy.
 *
 * Node ids are pre-order indices into these arrays. They are NOT stable across
 * edits — use `uid` for anything that must survive a reroot, prune or rotate.
 */

/** A node's stable identity, preserved across reroot / prune / rotate. */
export type Uid = number;

export interface Tree {
  /** Number of nodes. Every typed array below has this length. */
  readonly count: number;
  /** Node id of the root. */
  readonly root: number;

  // -- topology (child list as first-child / next-sibling) ------------------
  /** Parent node id; -1 at the root. */
  readonly parent: Int32Array;
  /** First child id; -1 when the node is a leaf. */
  readonly firstChild: Int32Array;
  /** Next sibling id; -1 when the node is its parent's last child. */
  readonly nextSib: Int32Array;

  // -- per-node data --------------------------------------------------------
  /** Branch length to the parent. NaN when the Newick gave none. */
  readonly length: Float64Array;
  /** Branch support in [0,1]. NaN when absent. */
  readonly support: Float64Array;
  /** 1 for leaves, 0 for internal nodes. */
  readonly isLeaf: Uint8Array;
  /** Edges from the root (root = 0). */
  readonly depth: Int32Array;
  /** Cumulative branch length from the root; missing lengths count as 0. */
  readonly cumLen: Float64Array;
  /** Stable identity — survives reroot, prune and rotate. */
  readonly uid: Int32Array;

  // -- leaf ordering and clade intervals ------------------------------------
  /**
   * Position of a leaf in left-to-right order; -1 for internal nodes.
   * This ordering is what makes a clade a contiguous interval.
   */
  readonly leafIndex: Int32Array;
  /** Leftmost leaf index in this node's subtree. */
  readonly L: Int32Array;
  /** One past the rightmost leaf index in this node's subtree. */
  readonly R: Int32Array;

  // -- things that cannot live in a typed array ------------------------------
  /** Node label, exactly as written in the Newick. Empty string when unnamed. */
  readonly name: string[];
  /** leafIndex -> node id. Length is the number of leaves. */
  readonly leaves: Int32Array;
  /** Leaf/……node name -> node id. First occurrence wins on duplicates. */
  readonly nameToNode: Map<string, number>;
  /** uid -> node id, for resolving stable references after an edit. */
  readonly uidToId: Map<Uid, number>;
}

/** Number of leaves in the tree. */
export function leafCount(t: Tree): number {
  return t.leaves.length;
}

/** Number of leaves under `id` — O(1), from the clade interval. */
export function cladeSize(t: Tree, id: number): number {
  return t.R[id] - t.L[id];
}

/** Whether `descendant` lies inside the clade rooted at `ancestor` — O(1). */
export function inClade(t: Tree, ancestor: number, descendant: number): boolean {
  return t.L[descendant] >= t.L[ancestor] && t.R[descendant] <= t.R[ancestor];
}

/** Iterate the children of `id` without allocating. */
export function* childrenOf(t: Tree, id: number): Generator<number> {
  for (let c = t.firstChild[id]; c !== -1; c = t.nextSib[c]) yield c;
}

/** Children of `id` as an array. */
export function childArray(t: Tree, id: number): number[] {
  const out: number[] = [];
  for (let c = t.firstChild[id]; c !== -1; c = t.nextSib[c]) out.push(c);
  return out;
}

/** Number of direct children of `id`. */
export function childCount(t: Tree, id: number): number {
  let n = 0;
  for (let c = t.firstChild[id]; c !== -1; c = t.nextSib[c]) n++;
  return n;
}

// ============================================================
// Annotation / track types
// ============================================================

export type AnnotationRow = { id: string; [key: string]: unknown };

export type TrackKind = "categorical" | "continuous";

export interface TrackConfig {
  key: string;
  label: string;
  type: TrackKind;
  height: number;
  maxVal?: number;
  visible: boolean;
}

/** A clade painted a colour, addressed by stable uid so it survives edits. */
export interface ColoredRange {
  nodeUid: Uid;
  color: string;
  label?: string;
}
