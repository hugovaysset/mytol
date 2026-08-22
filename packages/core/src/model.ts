/**
 * Turning raw parsed arrays into a finished `Tree`.
 *
 * Everything here is iterative. `finaliseTree` runs two explicit-stack passes:
 * a pre-order pass for depth/cumLen and a post-order pass for the clade
 * intervals. No recursion, so depth is bounded by memory rather than by the
 * JS call stack.
 */

import type { Tree, Uid } from "./types";
import { supportFromLabel } from "./newick";

export interface RawTree {
  parent: number[];
  firstChild: number[];
  nextSib: number[];
  length: number[];
  name: string[];
  root: number;
  /** First uid to assign; uids are handed out in pre-order. */
  startUid?: number;
  /** Pre-existing uids to preserve, indexed like the other arrays. */
  uid?: number[];
}

/**
 * Build the derived fields (depth, cumLen, leaf order, clade intervals, uid
 * maps) and freeze everything into typed arrays.
 */
export function finaliseTree(raw: RawTree): Tree {
  const count = raw.parent.length;
  const root = raw.root;

  const parent = Int32Array.from(raw.parent);
  const firstChild = Int32Array.from(raw.firstChild);
  const nextSib = Int32Array.from(raw.nextSib);
  const length = Float64Array.from(raw.length);
  const name = raw.name.slice();

  const isLeaf = new Uint8Array(count);
  const depth = new Int32Array(count);
  const cumLen = new Float64Array(count);
  const support = new Float64Array(count).fill(NaN);
  const leafIndex = new Int32Array(count).fill(-1);
  const L = new Int32Array(count);
  const R = new Int32Array(count);
  const uid = new Int32Array(count);

  for (let i = 0; i < count; i++) isLeaf[i] = firstChild[i] === -1 ? 1 : 0;

  // Support is only meaningful on internal nodes: a numeric *leaf* label is a
  // name that happens to look like a number, not a bootstrap value.
  for (let i = 0; i < count; i++) {
    if (!isLeaf[i]) support[i] = supportFromLabel(name[i]);
  }

  // -- pre-order: depth, cumLen, uid, leaf order ----------------------------
  // Children are visited left to right, so leafIndex assignment yields the
  // ordering that makes every clade a contiguous interval.
  const nextUid = raw.startUid ?? 0;
  const preserve = raw.uid;
  let uidCounter = nextUid;

  const leavesOut: number[] = [];
  const order = new Int32Array(count); // pre-order sequence, reused below
  let orderLen = 0;

  {
    const stack: number[] = [root];
    depth[root] = 0;
    cumLen[root] = 0;
    while (stack.length) {
      const id = stack.pop() as number;
      order[orderLen++] = id;
      uid[id] = preserve ? preserve[id] : uidCounter++;

      if (isLeaf[id]) {
        leafIndex[id] = leavesOut.length;
        leavesOut.push(id);
      }

      // push children reversed so the leftmost is popped first
      const kids: number[] = [];
      for (let c = firstChild[id]; c !== -1; c = nextSib[c]) kids.push(c);
      for (let k = kids.length - 1; k >= 0; k--) {
        const c = kids[k];
        depth[c] = depth[id] + 1;
        const bl = length[c];
        cumLen[c] = cumLen[id] + (Number.isNaN(bl) ? 0 : bl);
        stack.push(c);
      }
    }
  }

  // -- post-order (reverse pre-order): clade intervals ----------------------
  for (let i = 0; i < count; i++) {
    if (isLeaf[i]) {
      L[i] = leafIndex[i];
      R[i] = leafIndex[i] + 1;
    } else {
      L[i] = 0x7fffffff;
      R[i] = -0x7fffffff;
    }
  }
  for (let k = orderLen - 1; k >= 0; k--) {
    const id = order[k];
    const par = parent[id];
    if (par !== -1) {
      if (L[id] < L[par]) L[par] = L[id];
      if (R[id] > R[par]) R[par] = R[id];
    }
  }

  const leaves = Int32Array.from(leavesOut);

  const nameToNode = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const nm = name[i];
    if (nm && !nameToNode.has(nm)) nameToNode.set(nm, i);
  }

  const uidToId = new Map<Uid, number>();
  for (let i = 0; i < count; i++) uidToId.set(uid[i], i);

  return {
    count,
    root,
    parent,
    firstChild,
    nextSib,
    length,
    support,
    isLeaf,
    depth,
    cumLen,
    uid,
    leafIndex,
    L,
    R,
    name,
    leaves,
    nameToNode,
    uidToId,
  };
}

/** The largest uid in use, so a rebuild can keep handing out fresh ones. */
export function maxUid(t: Tree): number {
  let m = -1;
  for (let i = 0; i < t.count; i++) if (t.uid[i] > m) m = t.uid[i];
  return m;
}

/** Node id for a uid, or -1 if that node no longer exists. */
export function nodeByUid(t: Tree, u: Uid): number {
  const id = t.uidToId.get(u);
  return id === undefined ? -1 : id;
}

/**
 * Leaf node ids under `id`, in left-to-right order.
 * O(k) via the leaf-order array rather than a subtree walk.
 */
export function leavesOf(t: Tree, id: number): Int32Array {
  return t.leaves.subarray(t.L[id], t.R[id]);
}

/** Every node id in the subtree rooted at `id`, pre-order. */
export function descendantsOf(t: Tree, id: number): number[] {
  const out: number[] = [];
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop() as number;
    out.push(cur);
    for (let c = t.firstChild[cur]; c !== -1; c = t.nextSib[c]) stack.push(c);
  }
  return out;
}

/** Lowest common ancestor of two nodes. */
export function lca(t: Tree, a: number, b: number): number {
  const seen = new Set<number>();
  for (let cur = a; cur !== -1; cur = t.parent[cur]) seen.add(cur);
  for (let cur = b; cur !== -1; cur = t.parent[cur]) if (seen.has(cur)) return cur;
  return t.root;
}

/**
 * Infer which tool built the tree from the range of its support values.
 * Mirrors garrigue's heuristic: FastTree reports SH-like support in [0,1],
 * IQ-TREE reports UFBoot in [0,100].
 */
export interface TreeMeta {
  nLeaves: number;
  nNodes: number;
  algorithm: "FastTree" | "IQ-TREE" | "unknown";
  supportType: string;
  supportScale: [number, number] | null;
  supportRange: [number, number] | null;
}

export function inferMeta(t: Tree): TreeMeta {
  let lo = Infinity;
  let hi = -Infinity;
  let n = 0;
  // Whether the ORIGINAL labels were percentages. `support` is already
  // normalised to [0,1], so the raw label is the only place this survives.
  let sawPercent = false;

  for (let i = 0; i < t.count; i++) {
    const s = t.support[i];
    if (Number.isNaN(s)) continue;
    n++;
    if (s < lo) lo = s;
    if (s > hi) hi = s;

    const label = t.name[i];
    const slash = label.indexOf("/");
    const rawText = slash === -1 ? label : label.slice(slash + 1);
    const raw = Number.parseFloat(rawText);
    if (!Number.isNaN(raw) && raw > 1) sawPercent = true;
  }

  if (n === 0) {
    return {
      nLeaves: t.leaves.length,
      nNodes: t.count,
      algorithm: "unknown",
      supportType: "none",
      supportScale: null,
      supportRange: null,
    };
  }

  return {
    nLeaves: t.leaves.length,
    nNodes: t.count,
    algorithm: sawPercent ? "IQ-TREE" : "FastTree",
    supportType: sawPercent ? "UFBoot" : "SH-like local support",
    supportScale: sawPercent ? [0, 100] : [0, 1],
    supportRange: [lo, hi],
  };
}
