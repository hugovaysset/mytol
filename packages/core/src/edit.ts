/**
 * Tree edits: reroot, midpoint root, ladderize, rotate, prune.
 *
 * Two deliberate departures from both source viewers:
 *
 *  1. Every operation returns a NEW Tree. mytol mutated in place and then did
 *     `setTree({...tree})` to force a React render, which left `tree` identity
 *     useless as a memo key. A fresh object makes change detection honest.
 *
 *  2. `uid` is carried across every edit, so a colour range or a selection
 *     pinned to a clade survives rerooting and rotation, and is dropped only
 *     when the node itself is pruned away. mytol's fingerprint scheme
 *     ("firstLeafName\\0lastLeafName") could not do this: rerooting changes
 *     which leaves sit at the edges of a clade.
 */

import type { Tree, Uid } from "./types";
import { finaliseTree, maxUid } from "./model";

/** Rebuild a Tree from an explicit parent/child description, keeping uids. */
function rebuild(
  order: number[],
  parentOf: (id: number) => number,
  childrenOf: (id: number) => number[],
  src: Tree,
  lengthOf: (id: number) => number,
  newRoot: number,
): Tree {
  // Map old node ids to compact new ids in the given order.
  const remap = new Map<number, number>();
  order.forEach((oldId, k) => remap.set(oldId, k));

  const n = order.length;
  const parent: number[] = new Array(n).fill(-1);
  const firstChild: number[] = new Array(n).fill(-1);
  const nextSib: number[] = new Array(n).fill(-1);
  const length: number[] = new Array(n).fill(NaN);
  const name: string[] = new Array(n).fill("");
  const uid: number[] = new Array(n).fill(-1);

  for (let k = 0; k < n; k++) {
    const oldId = order[k];
    name[k] = src.name[oldId];
    uid[k] = src.uid[oldId];
    length[k] = lengthOf(oldId);
    const p = parentOf(oldId);
    parent[k] = p === -1 ? -1 : (remap.get(p) as number);
  }

  for (let k = 0; k < n; k++) {
    const kids = childrenOf(order[k]).map((c) => remap.get(c) as number);
    if (kids.length) {
      firstChild[k] = kids[0];
      for (let j = 0; j < kids.length - 1; j++) nextSib[kids[j]] = kids[j + 1];
    }
  }

  return finaliseTree({
    parent,
    firstChild,
    nextSib,
    length,
    name,
    uid,
    root: remap.get(newRoot) as number,
  });
}

// ============================================================
// Ladderize and rotate
// ============================================================

export type LadderDir = "asc" | "desc";

/** Sort every node's children by subtree size. Returns a new tree. */
export function ladderize(t: Tree, dir: LadderDir): Tree {
  const size = new Int32Array(t.count);
  // reverse pre-order == post-order
  const pre = preOrder(t);
  for (let k = pre.length - 1; k >= 0; k--) {
    const id = pre[k];
    if (t.isLeaf[id]) size[id] = 1;
    const p = t.parent[id];
    if (p !== -1) size[p] += size[id];
  }

  const childCache = new Map<number, number[]>();
  for (const id of pre) {
    if (t.isLeaf[id]) continue;
    const kids: number[] = [];
    for (let c = t.firstChild[id]; c !== -1; c = t.nextSib[c]) kids.push(c);
    kids.sort((a, b) => (dir === "asc" ? size[a] - size[b] : size[b] - size[a]));
    childCache.set(id, kids);
  }

  const order = reorderPreOrder(t.root, (id) => childCache.get(id) ?? []);
  return rebuild(
    order,
    (id) => t.parent[id],
    (id) => childCache.get(id) ?? [],
    t,
    (id) => t.length[id],
    t.root,
  );
}

/** Reverse the child order at one node. Returns a new tree. */
export function rotateChildren(t: Tree, id: number): Tree {
  if (t.isLeaf[id]) return t;
  const childCache = new Map<number, number[]>();
  for (let i = 0; i < t.count; i++) {
    if (t.isLeaf[i]) continue;
    const kids: number[] = [];
    for (let c = t.firstChild[i]; c !== -1; c = t.nextSib[c]) kids.push(c);
    if (i === id) kids.reverse();
    childCache.set(i, kids);
  }
  const order = reorderPreOrder(t.root, (n) => childCache.get(n) ?? []);
  return rebuild(
    order,
    (n) => t.parent[n],
    (n) => childCache.get(n) ?? [],
    t,
    (n) => t.length[n],
    t.root,
  );
}

function preOrder(t: Tree): number[] {
  const out: number[] = [];
  const stack = [t.root];
  while (stack.length) {
    const id = stack.pop() as number;
    out.push(id);
    const kids: number[] = [];
    for (let c = t.firstChild[id]; c !== -1; c = t.nextSib[c]) kids.push(c);
    for (let k = kids.length - 1; k >= 0; k--) stack.push(kids[k]);
  }
  return out;
}

function reorderPreOrder(root: number, kidsOf: (id: number) => number[]): number[] {
  const out: number[] = [];
  const stack = [root];
  while (stack.length) {
    const id = stack.pop() as number;
    out.push(id);
    const kids = kidsOf(id);
    for (let k = kids.length - 1; k >= 0; k--) stack.push(kids[k]);
  }
  return out;
}

// ============================================================
// Reroot
// ============================================================

interface Edge {
  to: number;
  len: number;
}

function adjacency(t: Tree): Edge[][] {
  const adj: Edge[][] = Array.from({ length: t.count }, () => []);
  for (let id = 0; id < t.count; id++) {
    const p = t.parent[id];
    if (p === -1) continue;
    const len = t.length[id];
    adj[p].push({ to: id, len });
    adj[id].push({ to: p, len });
  }
  return adj;
}

/**
 * Reroot on the branch above `target`.
 *
 * A real bifurcating root node is inserted at the midpoint of that branch
 * (`ratio` moves it along), the selected clade becoming the root's first child.
 * The former root, now a degree-2 knuckle, is suppressed and its two branch
 * lengths merged — so repeated rerooting never accumulates spurious nodes.
 */
export function reroot(t: Tree, target: number, ratio = 0.5): Tree {
  if (target === t.root) return t;
  const parentOfTarget = t.parent[target];
  if (parentOfTarget === -1) return t;

  const adj = adjacency(t);
  const branch = t.length[target];
  const hasLen = !Number.isNaN(branch);
  const lenToTarget = hasLen ? branch * ratio : NaN;
  const lenToRest = hasLen ? branch * (1 - ratio) : NaN;

  const newRootId = t.count; // synthetic node appended
  const parent: number[] = new Array(t.count + 1).fill(-1);
  const childLists: number[][] = Array.from({ length: t.count + 1 }, () => []);
  const length: number[] = new Array(t.count + 1).fill(NaN);
  const name: string[] = new Array(t.count + 1).fill("");
  const uid: number[] = new Array(t.count + 1).fill(-1);

  for (let i = 0; i < t.count; i++) {
    name[i] = t.name[i];
    uid[i] = t.uid[i];
  }
  name[newRootId] = "";
  uid[newRootId] = maxUid(t) + 1;

  // BFS outward from the new root through the undirected graph, but never
  // traversing the target--parent edge (the new root now sits on it).
  const visited = new Uint8Array(t.count);
  const queue: Array<[number, number, number]> = []; // [node, newParent, branchLen]

  parent[target] = newRootId;
  length[target] = lenToTarget;
  childLists[newRootId].push(target);
  visited[target] = 1;
  queue.push([target, newRootId, lenToTarget]);

  parent[parentOfTarget] = newRootId;
  length[parentOfTarget] = lenToRest;
  childLists[newRootId].push(parentOfTarget);
  visited[parentOfTarget] = 1;
  queue.push([parentOfTarget, newRootId, lenToRest]);

  for (let qi = 0; qi < queue.length; qi++) {
    const [node] = queue[qi];
    for (const e of adj[node]) {
      if (visited[e.to]) continue;
      visited[e.to] = 1;
      parent[e.to] = node;
      length[e.to] = e.len;
      childLists[node].push(e.to);
      queue.push([e.to, node, e.len]);
    }
  }

  parent[newRootId] = -1;
  length[newRootId] = NaN;

  const suppressed = suppressUnifurcations(newRootId, parent, childLists, length);
  return buildFromChildLists(suppressed.root, parent, childLists, length, name, uid);
}

/**
 * Remove degree-2 nodes, merging their branch lengths into the surviving
 * child. The root is exempt only when it genuinely has two or more children.
 */
function suppressUnifurcations(
  root: number,
  parent: number[],
  childLists: number[][],
  length: number[],
): { root: number } {
  const stack = [root];
  while (stack.length) {
    const id = stack.pop() as number;
    const kids = childLists[id];
    for (let k = 0; k < kids.length; k++) {
      let c = kids[k];
      while (childLists[c].length === 1) {
        const g = childLists[c][0];
        const a = length[g];
        const b = length[c];
        length[g] = Number.isNaN(a) && Number.isNaN(b) ? NaN : (Number.isNaN(a) ? 0 : a) + (Number.isNaN(b) ? 0 : b);
        parent[g] = id;
        childLists[c] = [];
        c = g;
      }
      kids[k] = c;
      parent[c] = id;
      stack.push(c);
    }
  }
  return { root };
}

function buildFromChildLists(
  root: number,
  parent: number[],
  childLists: number[][],
  length: number[],
  name: string[],
  uid: number[],
): Tree {
  const order: number[] = [];
  const stack = [root];
  while (stack.length) {
    const id = stack.pop() as number;
    order.push(id);
    const kids = childLists[id];
    for (let k = kids.length - 1; k >= 0; k--) stack.push(kids[k]);
  }

  const remap = new Map<number, number>();
  order.forEach((oldId, k) => remap.set(oldId, k));

  const n = order.length;
  const outParent: number[] = new Array(n).fill(-1);
  const outFirst: number[] = new Array(n).fill(-1);
  const outNext: number[] = new Array(n).fill(-1);
  const outLen: number[] = new Array(n).fill(NaN);
  const outName: string[] = new Array(n).fill("");
  const outUid: number[] = new Array(n).fill(-1);

  for (let k = 0; k < n; k++) {
    const oldId = order[k];
    outName[k] = name[oldId];
    outUid[k] = uid[oldId];
    outLen[k] = length[oldId];
    const p = parent[oldId];
    outParent[k] = p === -1 ? -1 : (remap.get(p) as number);
    const kids = childLists[oldId].map((c) => remap.get(c) as number);
    if (kids.length) {
      outFirst[k] = kids[0];
      for (let j = 0; j < kids.length - 1; j++) outNext[kids[j]] = kids[j + 1];
    }
  }

  return finaliseTree({
    parent: outParent,
    firstChild: outFirst,
    nextSib: outNext,
    length: outLen,
    name: outName,
    uid: outUid,
    root: remap.get(root) as number,
  });
}

/**
 * Root at the midpoint of the longest leaf-to-leaf path.
 * Uses branch lengths; missing lengths count as 0.
 */
export function midpointRoot(t: Tree): Tree {
  if (t.leaves.length < 2) return t;
  const adj = adjacency(t);
  const w = (e: Edge): number => (Number.isNaN(e.len) ? 0 : e.len);

  const farthest = (from: number): { node: number; dist: number; prev: Int32Array } => {
    const dist = new Float64Array(t.count).fill(-1);
    const prev = new Int32Array(t.count).fill(-1);
    const stack = [from];
    dist[from] = 0;
    while (stack.length) {
      const id = stack.pop() as number;
      for (const e of adj[id]) {
        if (dist[e.to] >= 0) continue;
        dist[e.to] = dist[id] + w(e);
        prev[e.to] = id;
        stack.push(e.to);
      }
    }
    let best = from;
    for (let i = 0; i < t.count; i++) {
      if (t.isLeaf[i] && dist[i] > dist[best]) best = i;
    }
    return { node: best, dist: dist[best], prev };
  };

  const a = farthest(t.leaves[0]).node;
  const b = farthest(a);
  const total = b.dist;
  if (!(total > 0)) return t;

  // Walk back from the far end to the halfway point.
  const path: number[] = [];
  for (let cur = b.node; cur !== -1; cur = b.prev[cur]) path.push(cur);
  path.reverse(); // a ... b

  const half = total / 2;
  let acc = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const from = path[i];
    const to = path[i + 1];
    const edge = adj[from].find((e) => e.to === to);
    const len = edge ? w(edge) : 0;
    if (acc + len >= half - 1e-12) {
      // The root goes on the from--to edge. Express it as a ratio along the
      // branch above whichever of the two is the child.
      const offset = half - acc;
      const child = t.parent[to] === from ? to : from;
      const branch = Number.isNaN(t.length[child]) ? 0 : t.length[child];
      if (!(branch > 0)) return reroot(t, child, 0.5);
      // `offset` is measured from `from` along the from->to edge. When the
      // child is `to`, the branch runs from->to, so the new root sits
      // (branch - offset) above the child; when the child is `from`, the
      // branch runs to->from and the root sits `offset` above it.
      const ratio = child === to ? (branch - offset) / branch : offset / branch;
      return reroot(t, child, Math.min(1, Math.max(0, ratio)));
    }
    acc += len;
  }
  return t;
}

// ============================================================
// Prune
// ============================================================

/**
 * Keep only the leaves for which `keep` is true.
 *
 * Internal nodes left with a single child are suppressed and their branch
 * lengths merged, so distances stay correct. Returns null when nothing would
 * remain. uids of surviving nodes are preserved.
 */
export function pruneLeaves(t: Tree, keep: (leafNodeId: number) => boolean): Tree | null {
  const alive = new Uint8Array(t.count);
  for (let k = 0; k < t.leaves.length; k++) {
    const id = t.leaves[k];
    if (keep(id)) alive[id] = 1;
  }

  // Propagate liveness upward.
  const pre = preOrder(t);
  for (let k = pre.length - 1; k >= 0; k--) {
    const id = pre[k];
    const p = t.parent[id];
    if (alive[id] && p !== -1) alive[p] = 1;
  }
  if (!alive[t.root]) return null;

  const parent: number[] = new Array(t.count).fill(-1);
  const childLists: number[][] = Array.from({ length: t.count }, () => []);
  const length: number[] = new Array(t.count).fill(NaN);
  const name: string[] = new Array(t.count).fill("");
  const uid: number[] = new Array(t.count).fill(-1);
  for (let i = 0; i < t.count; i++) {
    name[i] = t.name[i];
    uid[i] = t.uid[i];
    length[i] = t.length[i];
    parent[i] = t.parent[i];
  }
  for (let i = 0; i < t.count; i++) {
    if (!alive[i]) continue;
    for (let c = t.firstChild[i]; c !== -1; c = t.nextSib[c]) {
      if (alive[c]) childLists[i].push(c);
    }
  }

  const { root } = suppressUnifurcations(t.root, parent, childLists, length);
  // The root itself may now be a knuckle.
  let realRoot = root;
  while (childLists[realRoot].length === 1) {
    const only = childLists[realRoot][0];
    const a = length[only];
    const b = length[realRoot];
    length[only] = Number.isNaN(a) && Number.isNaN(b) ? NaN : (Number.isNaN(a) ? 0 : a) + (Number.isNaN(b) ? 0 : b);
    parent[only] = -1;
    realRoot = only;
  }
  length[realRoot] = NaN;
  parent[realRoot] = -1;

  return buildFromChildLists(realRoot, parent, childLists, length, name, uid);
}

/** Total branch length, treating missing lengths as 0. Used by tests. */
export function totalBranchLength(t: Tree): number {
  let sum = 0;
  for (let i = 0; i < t.count; i++) {
    if (i === t.root) continue;
    const l = t.length[i];
    if (!Number.isNaN(l)) sum += l;
  }
  return sum;
}

/** Set of uids currently present. */
export function uidSet(t: Tree): Set<Uid> {
  const s = new Set<Uid>();
  for (let i = 0; i < t.count; i++) s.add(t.uid[i]);
  return s;
}
