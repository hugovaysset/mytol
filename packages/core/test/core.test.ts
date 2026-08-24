/**
 * Conformance suite for @mytol/core.
 *
 * Seeded from garrigue's tests/test_core.js, which is the closest thing either
 * source project has to a written spec for tree-edit semantics. The invariants
 * it asserts (reroot conserves total branch length, leaf sets are preserved,
 * no degree-2 knuckles survive, labels are verbatim) are the ones that matter
 * for a viewer wired into a database.
 */

import { describe, it, expect } from "vitest";
import {
  parseNewick,
  splitNewick,
  toNewick,
  supportFromLabel,
  finaliseTree,
  inferMeta,
  leavesOf,
  nodeByUid,
  lca,
  enclosingClade,
  layoutRectangular,
  layoutUnrooted,
  rectToPolar,
  reroot,
  midpointRoot,
  ladderize,
  rotateChildren,
  pruneLeaves,
  totalBranchLength,
  uidSet,
  cladeInterval,
  normaliseIntervals,
  indicesToIntervals,
  intervalsToIndices,
  intervalsContain,
  coveringNodes,
  canonicalLeafOrder,
  toCanonicalIntervals,
  encodeMask,
  decodeMask,
  cladeSize,
  inClade,
  childArray,
  type Tree,
} from "../src/index";

const SIMPLE = "((A:0.1,B:0.2)0.95:0.3,(C:0.1,D:0.2)0.72:0.1)0.88;";

function leafNames(t: Tree): string[] {
  return Array.from(t.leaves).map((id) => t.name[id]);
}

// ============================================================
// Parsing
// ============================================================

describe("parseNewick", () => {
  it("reads names, lengths and topology", () => {
    const t = parseNewick(SIMPLE);
    expect(t.leaves.length).toBe(4);
    expect(leafNames(t)).toEqual(["A", "B", "C", "D"]);
    const a = t.nameToNode.get("A")!;
    expect(t.length[a]).toBeCloseTo(0.1, 12);
    expect(t.isLeaf[a]).toBe(1);
  });

  it("reads support from internal labels and normalises to [0,1]", () => {
    const t = parseNewick(SIMPLE);
    const supports = Array.from(t.support).filter((s) => !Number.isNaN(s)).sort();
    expect(supports).toEqual([0.72, 0.88, 0.95]);
  });

  it("treats a numeric LEAF label as a name, not a support value", () => {
    const t = parseNewick("(100:0.1,200:0.2);");
    for (let i = 0; i < t.count; i++) {
      if (t.isLeaf[i]) expect(Number.isNaN(t.support[i])).toBe(true);
    }
    expect(leafNames(t)).toEqual(["100", "200"]);
  });

  it("handles IQ-TREE SH-aLRT/UFBoot labels, taking UFBoot", () => {
    const t = parseNewick("((A:1,B:1)95/100:1,(C:1,D:1)80/60:1);");
    const supports = Array.from(t.support).filter((s) => !Number.isNaN(s)).sort();
    expect(supports).toEqual([0.6, 1]);
  });

  it("keeps leaf names verbatim — no underscore-to-space", () => {
    const t = parseNewick("(WP_001234.1_hyp:0.1,GCF_000005845.2:0.2);");
    const names = leafNames(t);
    expect(names).toContain("WP_001234.1_hyp");
    expect(names).toContain("GCF_000005845.2");
    expect(names.join(" ")).not.toContain("WP 001234");
  });

  it("parses Aleph accessions, which contain ~ @ and -", () => {
    const acc = "GTDB~B~GCF_000005845_2~001~00141";
    const region = "GTDA~A~GCA_000010565_1~001~00042@58-369";
    const t = parseNewick(`(${acc}:0.1,${region}:0.2);`);
    expect(leafNames(t).sort()).toEqual([region, acc].sort());
  });

  it("handles quoted labels with spaces and escaped quotes", () => {
    const t = parseNewick("('a b':0.1,'it''s':0.2);");
    expect(leafNames(t)).toEqual(["a b", "it's"]);
  });

  it("strips [comments] and NHX blocks", () => {
    const t = parseNewick("((A:0.1[&&NHX:S=human],B:0.2)[note]:0.3,C:0.4);");
    expect(leafNames(t)).toEqual(["A", "B", "C"]);
    expect(t.leaves.length).toBe(3);
  });

  it("tolerates a missing trailing semicolon", () => {
    expect(parseNewick("(A:1,B:1)").leaves.length).toBe(2);
  });

  it("accepts scientific notation in branch lengths", () => {
    const t = parseNewick("(A:1.5e-8,B:2E3);");
    expect(t.length[t.nameToNode.get("A")!]).toBeCloseTo(1.5e-8, 20);
    expect(t.length[t.nameToNode.get("B")!]).toBeCloseTo(2000, 9);
  });

  it("records missing branch lengths as NaN rather than 0", () => {
    const t = parseNewick("(A,B);");
    expect(Number.isNaN(t.length[t.nameToNode.get("A")!])).toBe(true);
  });

  it("rejects unbalanced parentheses", () => {
    expect(() => parseNewick("((A,B);")).toThrow();
  });

  it("does not overflow on a deep ladder tree", () => {
    // The recursion in both source viewers died well below this.
    const depth = 20000;
    let s = "leaf0";
    for (let i = 1; i < depth; i++) s = `(${s},leaf${i})`;
    const t = parseNewick(s + ";");
    expect(t.leaves.length).toBe(depth);
  });
});

describe("splitNewick", () => {
  it("splits multi-tree files", () => {
    expect(splitNewick("(A,B);(C,D);").length).toBe(2);
  });
  it("does not split on a semicolon inside a quoted label", () => {
    const parts = splitNewick("(A,'x;y');(C,D);");
    expect(parts.length).toBe(2);
    expect(parseNewick(parts[0]).nameToNode.has("x;y")).toBe(true);
  });
  it("does not split on a semicolon inside a comment", () => {
    expect(splitNewick("(A,B)[a;b];(C,D);").length).toBe(2);
  });
});

describe("toNewick", () => {
  it("round-trips topology and leaf names", () => {
    const t = parseNewick(SIMPLE);
    const again = parseNewick(toNewick(t));
    expect(leafNames(again)).toEqual(leafNames(t));
    expect(again.count).toBe(t.count);
  });

  it("round-trips names that need quoting", () => {
    const t = parseNewick("('a b':0.1,'c,d':0.2);");
    expect(leafNames(parseNewick(toNewick(t))).sort()).toEqual(["a b", "c,d"]);
  });

  it("leaves Aleph accessions unquoted and unchanged", () => {
    const acc = "GTDB~B~GCF_000005845_2~001~00141@58-369";
    const out = toNewick(parseNewick(`(${acc}:0.1,B:0.2);`));
    expect(out).toContain(acc);
    expect(out).not.toContain(`'${acc}'`);
  });

  it("emits sibling separators so the result reparses", () => {
    const t = parseNewick("((A,B,C),(D,E));");
    const again = parseNewick(toNewick(t));
    expect(leafNames(again)).toEqual(["A", "B", "C", "D", "E"]);
  });
});

// ============================================================
// Model
// ============================================================

describe("model", () => {
  it("assigns clade intervals that make a clade contiguous", () => {
    const t = parseNewick(SIMPLE);
    const ab = t.parent[t.nameToNode.get("A")!];
    expect(cladeInterval(t, ab)).toEqual([0, 2]);
    expect(cladeSize(t, ab)).toBe(2);
    expect(cladeInterval(t, t.root)).toEqual([0, 4]);
  });

  it("computes cumulative branch length", () => {
    const t = parseNewick(SIMPLE);
    // A sits 0.3 below the root then 0.1 more
    expect(t.cumLen[t.nameToNode.get("A")!]).toBeCloseTo(0.4, 12);
  });

  it("gives every node a distinct uid", () => {
    const t = parseNewick(SIMPLE);
    expect(uidSet(t).size).toBe(t.count);
  });

  it("resolves nodes by uid", () => {
    const t = parseNewick(SIMPLE);
    const id = t.nameToNode.get("C")!;
    expect(nodeByUid(t, t.uid[id])).toBe(id);
    expect(nodeByUid(t, 999999)).toBe(-1);
  });

  it("leavesOf returns the clade's leaves in order", () => {
    const t = parseNewick(SIMPLE);
    const cd = t.parent[t.nameToNode.get("C")!];
    expect(Array.from(leavesOf(t, cd)).map((i) => t.name[i])).toEqual(["C", "D"]);
  });

  it("inClade agrees with the interval test", () => {
    const t = parseNewick(SIMPLE);
    const ab = t.parent[t.nameToNode.get("A")!];
    expect(inClade(t, ab, t.nameToNode.get("B")!)).toBe(true);
    expect(inClade(t, ab, t.nameToNode.get("C")!)).toBe(false);
  });

  it("finds the lowest common ancestor", () => {
    const t = parseNewick(SIMPLE);
    const a = t.nameToNode.get("A")!;
    const d = t.nameToNode.get("D")!;
    expect(lca(t, a, d)).toBe(t.root);
    expect(lca(t, a, t.nameToNode.get("B")!)).toBe(t.parent[a]);
  });

  it("infers FastTree from [0,1] support", () => {
    expect(inferMeta(parseNewick(SIMPLE)).algorithm).toBe("FastTree");
  });

  it("infers IQ-TREE from support spanning into [0,100]", () => {
    const t = parseNewick("((A:1,B:1)95:1,(C:1,D:1)100:1);");
    const m = inferMeta(t);
    expect(m.algorithm).toBe("IQ-TREE");
    expect(m.supportScale).toEqual([0, 100]);
  });
});

// ============================================================
// Layout
// ============================================================

describe("layout", () => {
  it("places leaves at sequential y and internals at the mean of their children", () => {
    const t = parseNewick(SIMPLE);
    const lo = layoutRectangular(t, true);
    const ys = Array.from(t.leaves).map((id) => lo.y[id]);
    expect(ys).toEqual([0, 1, 2, 3]);
    const ab = t.parent[t.nameToNode.get("A")!];
    expect(lo.y[ab]).toBeCloseTo(0.5, 12);
    expect(lo.y[t.root]).toBeCloseTo(1.5, 12);
  });

  it("centres an unbalanced parent on its children, not on its leaf span", () => {
    // ((A,B),C): the root's children sit at y=0.5 and y=2, so the root belongs
    // at 1.25. Its leaf span midpoint would be 1, which is a different place.
    const t = parseNewick("((A,B),C);");
    const lo = layoutRectangular(t, false);
    const ab = t.parent[t.nameToNode.get("A")!];
    expect(lo.y[ab]).toBeCloseTo(0.5, 12);
    expect(lo.y[t.root]).toBeCloseTo(1.25, 12);
  });

  it("a parent always lies between its outermost children", () => {
    const t = parseNewick("(((A,B),C),(D,(E,(F,G))));");
    const lo = layoutRectangular(t, false);
    for (let id = 0; id < t.count; id++) {
      if (t.isLeaf[id]) continue;
      let lo_ = Infinity;
      let hi = -Infinity;
      for (let c = t.firstChild[id]; c !== -1; c = t.nextSib[c]) {
        lo_ = Math.min(lo_, lo.y[c]);
        hi = Math.max(hi, lo.y[c]);
      }
      expect(lo.y[id]).toBeGreaterThanOrEqual(lo_ - 1e-9);
      expect(lo.y[id]).toBeLessThanOrEqual(hi + 1e-9);
    }
  });

  it("phylogram x follows cumulative length; cladogram flushes leaves right", () => {
    const t = parseNewick(SIMPLE);
    const phy = layoutRectangular(t, true);
    expect(phy.x[t.nameToNode.get("A")!]).toBeCloseTo(0.4, 12);
    const cla = layoutRectangular(t, false);
    for (const id of t.leaves) expect(cla.x[id]).toBe(cla.maxX);
  });

  it("unrooted layout is finite and non-degenerate", () => {
    const t = parseNewick(SIMPLE);
    const lo = layoutUnrooted(t, false);
    for (let i = 0; i < t.count; i++) {
      expect(Number.isFinite(lo.x[i])).toBe(true);
      expect(Number.isFinite(lo.y[i])).toBe(true);
    }
    expect(lo.maxR).toBeGreaterThan(0);
  });

  it("unrooted layout survives a deep tree without recursing", () => {
    let s = "leaf0";
    for (let i = 1; i < 8000; i++) s = `(${s},leaf${i})`;
    const t = parseNewick(s + ";");
    expect(() => layoutUnrooted(t, true)).not.toThrow();
  });

  it("rectToPolar maps the root to the centre and tips to the radius", () => {
    const centre = rectToPolar(0, 0, 4, 100, 0, 360);
    expect(Math.hypot(centre.x, centre.y)).toBeCloseTo(0, 9);
    const tip = rectToPolar(1, 0, 4, 100, 0, 360);
    expect(Math.hypot(tip.x, tip.y)).toBeCloseTo(100, 9);
  });
});

// ============================================================
// Edits
// ============================================================

describe("reroot", () => {
  it("preserves the leaf set and total branch length", () => {
    const t = parseNewick(SIMPLE);
    const target = t.nameToNode.get("C")!;
    const r = reroot(t, target);
    expect(leafNames(r).sort()).toEqual(leafNames(t).sort());
    expect(totalBranchLength(r)).toBeCloseTo(totalBranchLength(t), 9);
  });

  it("produces a bifurcating root", () => {
    const t = parseNewick(SIMPLE);
    const r = reroot(t, t.nameToNode.get("C")!);
    expect(childArray(r, r.root).length).toBe(2);
  });

  it("puts the selected clade as the root's first child", () => {
    const t = parseNewick("((A:1,B:1):1,(C:1,D:1):1);");
    const ab = t.parent[t.nameToNode.get("A")!];
    const r = reroot(t, ab);
    const first = childArray(r, r.root)[0];
    expect(Array.from(leavesOf(r, first)).map((i) => r.name[i]).sort()).toEqual(["A", "B"]);
  });

  it("leaves no degree-2 knuckle behind when rerooting a rooted tree", () => {
    const t = parseNewick(SIMPLE);
    const r = reroot(t, t.nameToNode.get("D")!);
    for (let i = 0; i < r.count; i++) {
      if (i === r.root) continue;
      expect(childArray(r, i).length).not.toBe(1);
    }
  });

  it("keeps uids, so a pinned clade survives", () => {
    const t = parseNewick(SIMPLE);
    const cd = t.parent[t.nameToNode.get("C")!];
    const pinned = t.uid[cd];
    const r = reroot(t, t.nameToNode.get("A")!);
    const found = nodeByUid(r, pinned);
    expect(found).not.toBe(-1);
    expect(Array.from(leavesOf(r, found)).map((i) => r.name[i]).sort()).toEqual(["C", "D"]);
  });

  it("is a no-op at the root", () => {
    const t = parseNewick(SIMPLE);
    expect(reroot(t, t.root)).toBe(t);
  });
});

describe("midpointRoot", () => {
  it("preserves leaves and total branch length", () => {
    const t = parseNewick("((A:0.1,B:0.2):0.3,(C:5.0,D:0.2):0.1);");
    const m = midpointRoot(t);
    expect(leafNames(m).sort()).toEqual(["A", "B", "C", "D"]);
    expect(totalBranchLength(m)).toBeCloseTo(totalBranchLength(t), 9);
  });

  it("balances the two sides of the root", () => {
    const t = parseNewick("((A:0.1,B:0.1):0.1,(C:5.0,D:0.1):0.1);");
    const m = midpointRoot(t);
    // the deepest leaf on each side of the root should be near-equal
    const kids = childArray(m, m.root);
    const deepest = (id: number): number => {
      let best = 0;
      for (const leaf of leavesOf(m, id)) best = Math.max(best, m.cumLen[leaf]);
      return best;
    };
    expect(Math.abs(deepest(kids[0]) - deepest(kids[1]))).toBeLessThan(1e-6);
  });
});

describe("ladderize / rotate", () => {
  it("orders children by clade size", () => {
    const t = parseNewick("(((A,B),C),(D,E));");
    const asc = ladderize(t, "asc");
    const kids = childArray(asc, asc.root);
    expect(cladeSize(asc, kids[0])).toBeLessThanOrEqual(cladeSize(asc, kids[1]));
    const desc = ladderize(t, "desc");
    const dk = childArray(desc, desc.root);
    expect(cladeSize(desc, dk[0])).toBeGreaterThanOrEqual(cladeSize(desc, dk[1]));
  });

  it("preserves the leaf set and uids", () => {
    const t = parseNewick("(((A,B),C),(D,E));");
    const l = ladderize(t, "desc");
    expect(leafNames(l).sort()).toEqual(leafNames(t).sort());
    expect(uidSet(l)).toEqual(uidSet(t));
  });

  it("rotateChildren reverses one node's children and keeps its uid", () => {
    const t = parseNewick("((A,B),(C,D));");
    const before = leafNames(t);
    const r = rotateChildren(t, t.root);
    expect(leafNames(r)).toEqual([before[2], before[3], before[0], before[1]]);
    expect(uidSet(r)).toEqual(uidSet(t));
  });
});

describe("pruneLeaves", () => {
  it("keeps only the requested leaves", () => {
    const t = parseNewick(SIMPLE);
    const keep = new Set(["A", "C"]);
    const p = pruneLeaves(t, (id) => keep.has(t.name[id]))!;
    expect(leafNames(p).sort()).toEqual(["A", "C"]);
  });

  it("merges branch lengths through suppressed nodes", () => {
    const t = parseNewick("((A:0.1,B:0.2):0.3,C:0.4);");
    const p = pruneLeaves(t, (id) => t.name[id] !== "B")!;
    // A was 0.1 below a node that was 0.3 below the root
    expect(p.cumLen[p.nameToNode.get("A")!]).toBeCloseTo(0.4, 12);
  });

  it("returns null when everything would be removed", () => {
    const t = parseNewick(SIMPLE);
    expect(pruneLeaves(t, () => false)).toBe(null);
  });

  it("drops the uids of pruned nodes but keeps survivors'", () => {
    const t = parseNewick(SIMPLE);
    const aUid = t.uid[t.nameToNode.get("A")!];
    const bUid = t.uid[t.nameToNode.get("B")!];
    const p = pruneLeaves(t, (id) => t.name[id] !== "B")!;
    expect(nodeByUid(p, aUid)).not.toBe(-1);
    expect(nodeByUid(p, bUid)).toBe(-1);
  });

  it("leaves no degree-2 nodes", () => {
    const t = parseNewick("(((A,B),(C,D)),(E,F));");
    const keep = new Set(["A", "C", "E"]);
    const p = pruneLeaves(t, (id) => keep.has(t.name[id]))!;
    for (let i = 0; i < p.count; i++) {
      expect(childArray(p, i).length).not.toBe(1);
    }
  });
});

// ============================================================
// Selection intervals — the Zahir wire format
// ============================================================

describe("selection intervals", () => {
  it("expresses a clade as a single interval", () => {
    const t = parseNewick(SIMPLE);
    const ab = t.parent[t.nameToNode.get("A")!];
    expect(cladeInterval(t, ab)).toEqual([0, 2]);
  });

  it("normalises overlapping and adjacent intervals", () => {
    expect(normaliseIntervals([[0, 2], [2, 4], [10, 12]])).toEqual([[0, 4], [10, 12]]);
    expect(normaliseIntervals([[5, 9], [0, 6]])).toEqual([[0, 9]]);
    expect(normaliseIntervals([[3, 3]])).toEqual([]);
  });

  it("round-trips indices through intervals", () => {
    const idx = [0, 1, 2, 7, 8, 20];
    const iv = indicesToIntervals(idx);
    expect(iv).toEqual([[0, 3], [7, 9], [20, 21]]);
    expect(Array.from(intervalsToIndices(iv))).toEqual(idx);
  });

  it("tests membership by binary search", () => {
    const iv = normaliseIntervals([[0, 3], [7, 9]]);
    expect(intervalsContain(iv, 2)).toBe(true);
    expect(intervalsContain(iv, 3)).toBe(false);
    expect(intervalsContain(iv, 8)).toBe(true);
    expect(intervalsContain(iv, 99)).toBe(false);
  });

  it("covers an interval with the fewest whole clades", () => {
    const t = parseNewick("((A,B),(C,D));");
    const nodes = coveringNodes(t, [[0, 2]]);
    expect(nodes.length).toBe(1);
    expect(cladeSize(t, nodes[0])).toBe(2);
    expect(coveringNodes(t, [[0, 4]])).toEqual([t.root]);
  });

  it("maps a selection back to canonical order after a rotate", () => {
    const t = parseNewick("((A,B),(C,D));");
    const canonical = canonicalLeafOrder(t); // A=0 B=1 C=2 D=3
    const rotated = rotateChildren(t, t.root); // now C,D,A,B
    expect(leafNames(rotated)).toEqual(["C", "D", "A", "B"]);
    // leaves 0..1 of the ROTATED tree are C,D — canonically 2..3
    const canon = toCanonicalIntervals(rotated, [[0, 2]], canonical);
    expect(canon).toEqual([[2, 4]]);
  });

  it("yields several canonical intervals when an edit splits a clade", () => {
    const t = parseNewick("((A,B),(C,D));");
    const canonical = canonicalLeafOrder(t);
    const rotated = rotateChildren(t, t.root); // C,D,A,B
    // pick display leaves 1..2 => D,A => canonical 3 and 0
    const canon = toCanonicalIntervals(rotated, [[1, 3]], canonical);
    expect(canon).toEqual([[0, 1], [3, 4]]);
  });
});

describe("leaf mask codec", () => {
  it("round-trips a bitmask", () => {
    const bits = new Uint8Array(20);
    for (const i of [0, 3, 7, 8, 19]) bits[i] = 1;
    const decoded = decodeMask(encodeMask(bits), 20);
    expect(Array.from(decoded)).toEqual(Array.from(bits));
  });

  it("handles a large mask at dashboard scale", () => {
    const n = 43739;
    const bits = new Uint8Array(n);
    for (let i = 0; i < n; i += 3) bits[i] = 1;
    const b64 = encodeMask(bits);
    // ~5.5 KB raw -> ~7.3 KB base64, versus megabytes as accession strings
    expect(b64.length).toBeLessThan(8000);
    expect(Array.from(decodeMask(b64, n))).toEqual(Array.from(bits));
  });
});

describe("supportFromLabel", () => {
  it("reads plain and percentage values", () => {
    expect(supportFromLabel("0.95")).toBeCloseTo(0.95, 12);
    expect(supportFromLabel("95")).toBeCloseTo(0.95, 12);
  });
  it("takes UFBoot from an IQ-TREE pair", () => {
    expect(supportFromLabel("80/100")).toBeCloseTo(1, 12);
  });
  it("returns NaN for a real clade name", () => {
    expect(Number.isNaN(supportFromLabel("Enterobacterales"))).toBe(true);
    expect(Number.isNaN(supportFromLabel(""))).toBe(true);
  });
});

describe("finaliseTree", () => {
  it("builds a usable tree from raw arrays", () => {
    const t = finaliseTree({
      parent: [-1, 0, 0],
      firstChild: [1, -1, -1],
      nextSib: [-1, 2, -1],
      length: [NaN, 1, 2],
      name: ["", "X", "Y"],
      root: 0,
    });
    expect(t.leaves.length).toBe(2);
    expect(leafNames(t)).toEqual(["X", "Y"]);
    expect(t.cumLen[2]).toBe(2);
  });
});

// ============================================================
// Scale
// ============================================================

describe("scale", () => {
  function randomTree(nLeaves: number): string {
    // balanced-ish, so depth stays logarithmic
    let nodes: string[] = [];
    for (let i = 0; i < nLeaves; i++) nodes.push(`L${i}:${(0.01 + (i % 7) / 100).toFixed(3)}`);
    while (nodes.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < nodes.length; i += 2) {
        if (i + 1 < nodes.length) next.push(`(${nodes[i]},${nodes[i + 1]}):0.05`);
        else next.push(nodes[i]);
      }
      nodes = next;
    }
    return nodes[0] + ";";
  }

  it("parses and lays out 50k leaves quickly", () => {
    const src = randomTree(50000);
    const t0 = Date.now();
    const t = parseNewick(src);
    const lo = layoutRectangular(t, true);
    const ms = Date.now() - t0;
    expect(t.leaves.length).toBe(50000);
    expect(lo.y[t.leaves[49999]]).toBe(49999);
    expect(ms).toBeLessThan(4000);
  });

  it("reroots a 50k-leaf tree without losing leaves", () => {
    const t = parseNewick(randomTree(50000));
    const r = reroot(t, t.leaves[25000]);
    expect(r.leaves.length).toBe(50000);
    expect(totalBranchLength(r)).toBeCloseTo(totalBranchLength(t), 6);
  });
});

describe("enclosingClade", () => {
  it("returns the deepest clade covering a selection", () => {
    const t = parseNewick("(((A,B),(C,D)),((E,F),(G,H)));");
    // A and B -> their own parent, not the root
    const ab = enclosingClade(t, [0, 1]);
    expect(cladeSize(t, ab)).toBe(2);
    // A and D -> the clade of ABCD
    const abcd = enclosingClade(t, [0, 3]);
    expect(cladeSize(t, abcd)).toBe(4);
    // A and H -> only the root encloses both
    expect(enclosingClade(t, [0, 7])).toBe(t.root);
  });

  it("a single leaf encloses itself", () => {
    const t = parseNewick("((A,B),(C,D));");
    expect(enclosingClade(t, [2])).toBe(t.leaves[2]);
  });

  it("a scattered selection still yields one clade, not many paths", () => {
    const t = parseNewick("(((A,B),(C,D)),((E,F),(G,H)));");
    // non-contiguous, but the answer is still a single enclosing clade
    const n = enclosingClade(t, [1, 5]);
    expect(cladeSize(t, n)).toBe(8);
  });

  it("is empty for an empty selection", () => {
    const t = parseNewick("((A,B),(C,D));");
    expect(enclosingClade(t, [])).toBe(-1);
  });

  it("ignores indices outside the tree", () => {
    const t = parseNewick("((A,B),(C,D));");
    expect(enclosingClade(t, [99])).toBe(-1);
  });

  it("covers the whole tree when everything is selected", () => {
    const t = parseNewick("(((A,B),(C,D)),((E,F),(G,H)));");
    expect(enclosingClade(t, [0, 1, 2, 3, 4, 5, 6, 7])).toBe(t.root);
  });
});
