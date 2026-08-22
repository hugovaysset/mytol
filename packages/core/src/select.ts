/**
 * Selection as leaf-index intervals.
 *
 * A clade is a contiguous run of leaf indices, so a clade selection is one
 * interval — the fact the whole Zahir integration rests on. Sending
 * `[[L, R)]` instead of 40 000 accession strings is the difference between a
 * few bytes and a multi-megabyte request.
 *
 * The subtlety: leaf INDEX is a property of the current display ordering, and
 * rerooting or rotating changes that ordering. The server's ordering is fixed
 * at load time. So anything crossing the wire is expressed in *canonical*
 * indices, obtained by mapping display leaves back through their stable uid.
 */

import type { Tree, Uid } from "./types";

/** Half-open interval of leaf indices: [start, end). */
export type Interval = readonly [number, number];

/** The clade under `id`, as one interval. */
export function cladeInterval(t: Tree, id: number): Interval {
  return [t.L[id], t.R[id]];
}

/** Merge overlapping/adjacent intervals; input need not be sorted. */
export function normaliseIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = intervals
    .filter(([a, b]) => b > a)
    .slice()
    .sort((p, q) => p[0] - q[0]);
  if (sorted.length === 0) return [];

  const out: Array<[number, number]> = [[sorted[0][0], sorted[0][1]]];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    const cur = sorted[i];
    if (cur[0] <= last[1]) {
      if (cur[1] > last[1]) last[1] = cur[1];
    } else {
      out.push([cur[0], cur[1]]);
    }
  }
  return out;
}

/** Total number of leaves covered. */
export function intervalCount(intervals: Interval[]): number {
  let n = 0;
  for (const [a, b] of intervals) n += b - a;
  return n;
}

/** Run-length compress a sorted list of indices into intervals. */
export function indicesToIntervals(indices: ArrayLike<number>): Interval[] {
  const n = indices.length;
  if (n === 0) return [];
  const sorted = Array.from(indices as ArrayLike<number>).sort((a, b) => a - b);
  const out: Array<[number, number]> = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < n; i++) {
    const v = sorted[i];
    if (v === prev) continue;
    if (v === prev + 1) {
      prev = v;
      continue;
    }
    out.push([start, prev + 1]);
    start = v;
    prev = v;
  }
  out.push([start, prev + 1]);
  return out;
}

/** Expand intervals into a flat list of leaf indices. */
export function intervalsToIndices(intervals: Interval[]): Int32Array {
  const total = intervalCount(intervals);
  const out = new Int32Array(total);
  let k = 0;
  for (const [a, b] of intervals) for (let i = a; i < b; i++) out[k++] = i;
  return out;
}

/** Membership test over sorted, normalised intervals. Binary search. */
export function intervalsContain(intervals: Interval[], index: number): boolean {
  let lo = 0;
  let hi = intervals.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = intervals[mid];
    if (index < a) hi = mid - 1;
    else if (index >= b) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * Translate a selection expressed in the CURRENT display order into the
 * canonical order the server knows about.
 *
 * `canonicalIndexOfUid` comes from the tree as originally loaded. After a
 * reroot or rotate the same clade can map to several disjoint canonical runs,
 * which is exactly why the wire format is a list of intervals rather than one.
 */
export function toCanonicalIntervals(
  t: Tree,
  intervals: Interval[],
  canonicalIndexOfUid: Map<Uid, number>,
): Interval[] {
  const indices: number[] = [];
  for (const [a, b] of intervals) {
    for (let i = a; i < b; i++) {
      const nodeId = t.leaves[i];
      const canonical = canonicalIndexOfUid.get(t.uid[nodeId]);
      if (canonical !== undefined) indices.push(canonical);
    }
  }
  return indicesToIntervals(indices);
}

/**
 * Build the uid -> leaf-index map that defines the canonical ordering.
 * Call this once on the tree as loaded, and keep it across edits.
 */
export function canonicalLeafOrder(t: Tree): Map<Uid, number> {
  const m = new Map<Uid, number>();
  for (let i = 0; i < t.leaves.length; i++) m.set(t.uid[t.leaves[i]], i);
  return m;
}

/**
 * The smallest set of nodes whose clades exactly cover `intervals`.
 * Used to draw a selection as a few highlighted clades instead of thousands
 * of individual leaf rows.
 */
export function coveringNodes(t: Tree, intervals: Interval[]): number[] {
  const norm = normaliseIntervals(intervals);
  const out: number[] = [];
  for (const [a, b] of norm) {
    let i = a;
    while (i < b) {
      // climb while the parent's clade still fits inside [a,b)
      let node = t.leaves[i];
      for (;;) {
        const p = t.parent[node];
        if (p === -1) break;
        if (t.L[p] < a || t.R[p] > b) break;
        node = p;
      }
      out.push(node);
      i = t.R[node];
    }
  }
  return out;
}

/**
 * Base64 for the packed leaf mask.
 *
 * Implemented by hand rather than through `atob`/`Buffer` so the package stays
 * environment-agnostic: the same code runs in a browser, in Node and in a Web
 * Worker with no DOM lib and no Node types.
 */
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  const n = bytes.length;
  for (let i = 0; i < n; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < n ? bytes[i + 1] : 0;
    const b2 = i + 2 < n ? bytes[i + 2] : 0;
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < n ? B64[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < n ? B64[b2 & 63] : "=";
  }
  return out;
}

function base64ToBytes(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, "");
  const n = clean.length;
  const out = new Uint8Array((n * 3) >> 2);
  let k = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < n; i++) {
    acc = (acc << 6) | B64.indexOf(clean[i]);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[k++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, k);
}

/**
 * Decode Zahir's packed leaf mask: one bit per leaf index, MSB first,
 * 1 meaning the leaf passes the current dashboard filter.
 */
export function decodeMask(base64: string, nLeaves: number): Uint8Array {
  const bytes = base64ToBytes(base64);
  const out = new Uint8Array(nLeaves);
  for (let i = 0; i < nLeaves; i++) {
    const byte = bytes[i >> 3];
    if (byte === undefined) break;
    out[i] = (byte >> (7 - (i & 7))) & 1;
  }
  return out;
}

/** Inverse of decodeMask. Used by tests and by the standalone app. */
export function encodeMask(bits: ArrayLike<number>): string {
  const n = bits.length;
  const bytes = new Uint8Array((n + 7) >> 3);
  for (let i = 0; i < n; i++) {
    if (bits[i]) bytes[i >> 3] |= 1 << (7 - (i & 7));
  }
  return bytesToBase64(bytes);
}
