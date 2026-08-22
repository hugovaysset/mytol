import { describe, it, expect } from "vitest";
import { parseNewick, layoutRectangular, reroot, totalBranchLength } from "../src/index";
import { readFileSync, existsSync } from "node:fs";

/**
 * A real tree to check against, if one is to hand.
 *
 * Env-driven rather than hardcoded: this is a library test, and the path to
 * somebody's SIR2 run has no business in it. Skips silently when unset.
 */
const REAL = process.env.MYTOL_REAL_TREE ?? "";

describe("40k-tip scale", () => {
  it("parses and lays out a 40k-tip tree in reasonable time", () => {
    // synthetic stand-in with realistic label length (Aleph accessions)
    const n = 40578;
    let nodes: string[] = [];
    for (let i = 0; i < n; i++) {
      nodes.push(`GTDB~B~GCA_${(100000 + i).toString().padStart(9, "0")}~00015~${(i % 99999).toString().padStart(5, "0")}:0.0${(i % 89) + 10}`);
    }
    while (nodes.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < nodes.length; i += 2) {
        next.push(i + 1 < nodes.length ? `(${nodes[i]},${nodes[i + 1]})${(i % 50) + 50}:0.05` : nodes[i]);
      }
      nodes = next;
    }
    const src = nodes[0] + ";";

    const t0 = Date.now();
    const tree = parseNewick(src);
    const tParse = Date.now() - t0;
    const t1 = Date.now();
    const lo = layoutRectangular(tree, true);
    const tLayout = Date.now() - t1;

    expect(tree.leaves.length).toBe(n);
    expect(lo.y[tree.leaves[n - 1]]).toBe(n - 1);
    console.log(`  synthetic 40k: parse ${tParse}ms, layout ${tLayout}ms, newick ${(src.length / 1e6).toFixed(1)}MB`);
    expect(tParse).toBeLessThan(5000);
    expect(tLayout).toBeLessThan(2000);
  });

  it("handles a real tree when MYTOL_REAL_TREE points at one", () => {
    if (!REAL || !existsSync(REAL)) return;
    const src = readFileSync(REAL, "utf8");
    if (src.trim().length === 0) return;
    const t0 = Date.now();
    const tree = parseNewick(src);
    const tParse = Date.now() - t0;
    const lo = layoutRectangular(tree, true);
    console.log(`  real tree: ${tree.leaves.length} tips, parse ${tParse}ms, ${(src.length / 1e6).toFixed(1)}MB`);
    expect(tree.leaves.length).toBeGreaterThan(1000);
    expect(Number.isFinite(lo.maxX)).toBe(true);
    // a reroot in the middle must not lose tips
    const r = reroot(tree, tree.leaves[Math.floor(tree.leaves.length / 2)]);
    expect(r.leaves.length).toBe(tree.leaves.length);
    expect(totalBranchLength(r)).toBeCloseTo(totalBranchLength(tree), 4);
  });
});
