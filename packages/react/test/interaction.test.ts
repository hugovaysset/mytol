/**
 * Interaction and tree-edit semantics.
 *
 * These are the behaviours ported from garrigue that mytol did not have. They
 * are tested as pure functions, with no DOM.
 */

import { describe, it, expect } from "vitest";
import { parseNewick, cladeSize, nodeByUid, type Tree } from "@mytol/core";
import {
  applyClick,
  applyBoxSelect,
  applyWheelZoom,
  selectClade,
  selectionIntervals,
  pinnedInterval,
  addIntervals,
  contextRequest,
  leafLabelsOf,
  emptySelection,
} from "../src/interaction";
import {
  initTreeState,
  isEdited,
  canUndo,
  reroot,
  midpointRoot,
  ladderize,
  rotate,
  pruneSelection,
  keepOnly,
  undo,
  resetEdits,
} from "../src/treeState";

const T = "((A:0.1,B:0.2)0.95:0.3,(C:0.1,D:0.2)0.72:0.1)0.88;";

function tree(): Tree {
  return parseNewick(T);
}

describe("click selection", () => {
  it("selecting an internal node takes the whole clade and pins it", () => {
    const t = tree();
    const ab = t.parent[t.nameToNode.get("A")!];
    const s = applyClick(t, emptySelection(), ab, { additive: false });
    expect(Array.from(s.leaves).sort()).toEqual([0, 1]);
    expect(s.pinned).toBe(ab);
  });

  it("selecting a leaf selects just that leaf", () => {
    const t = tree();
    const c = t.nameToNode.get("C")!;
    const s = applyClick(t, emptySelection(), c, { additive: false });
    expect(Array.from(s.leaves)).toEqual([2]);
  });

  it("a plain click replaces the previous selection", () => {
    const t = tree();
    const first = applyClick(t, emptySelection(), t.nameToNode.get("A")!, { additive: false });
    const second = applyClick(t, first, t.nameToNode.get("D")!, { additive: false });
    expect(Array.from(second.leaves)).toEqual([3]);
  });

  it("ctrl/cmd click adds to the selection", () => {
    const t = tree();
    const first = applyClick(t, emptySelection(), t.nameToNode.get("A")!, { additive: false });
    const second = applyClick(t, first, t.nameToNode.get("D")!, { additive: true });
    expect(Array.from(second.leaves).sort()).toEqual([0, 3]);
  });

  it("ctrl/cmd click on an already selected leaf removes it", () => {
    const t = tree();
    const a = t.nameToNode.get("A")!;
    const first = applyClick(t, emptySelection(), a, { additive: false });
    const second = applyClick(t, first, a, { additive: true });
    expect(second.leaves.size).toBe(0);
  });

  it("clicking empty space clears the selection and unpins", () => {
    const t = tree();
    const s = applyClick(t, selectClade(t, t.root), -1, { additive: false });
    expect(s.leaves.size).toBe(0);
    expect(s.pinned).toBe(-1);
  });

  it("ctrl-clicking empty space keeps the selection", () => {
    const t = tree();
    const before = selectClade(t, t.root);
    const after = applyClick(t, before, -1, { additive: true });
    expect(after).toBe(before);
  });
});

describe("box selection", () => {
  it("selects the row range regardless of drag direction", () => {
    const s = applyBoxSelect(emptySelection(), 3, 1, 4);
    expect(Array.from(s.leaves).sort()).toEqual([1, 2, 3]);
  });

  it("is additive — it never clears what is already selected", () => {
    const start = applyBoxSelect(emptySelection(), 0, 0, 4);
    const after = applyBoxSelect(start, 2, 3, 4);
    expect(Array.from(after.leaves).sort()).toEqual([0, 2, 3]);
  });

  it("clamps to the leaf range", () => {
    const s = applyBoxSelect(emptySelection(), -10, 99, 4);
    expect(Array.from(s.leaves).sort()).toEqual([0, 1, 2, 3]);
  });
});

describe("selection to intervals", () => {
  it("turns a clade into one interval", () => {
    const t = tree();
    const ab = t.parent[t.nameToNode.get("A")!];
    expect(selectionIntervals(selectClade(t, ab))).toEqual([[0, 2]]);
  });

  it("turns a scattered selection into several intervals", () => {
    const s = addIntervals(emptySelection(), [[0, 1], [3, 4]]);
    expect(selectionIntervals(s)).toEqual([[0, 1], [3, 4]]);
  });

  it("reports the pinned clade as one interval", () => {
    const t = tree();
    const cd = t.parent[t.nameToNode.get("C")!];
    expect(pinnedInterval(t, selectClade(t, cd))).toEqual([2, 4]);
    expect(pinnedInterval(t, emptySelection())).toBe(null);
  });

  it("an empty selection has no intervals", () => {
    expect(selectionIntervals(emptySelection())).toEqual([]);
  });
});

describe("wheel zoom", () => {
  const bounds = { width: 800, height: 600 };

  it("scales only the vertical axis in rectangular mode", () => {
    const v = { vZoom: 1, zoom: 1, panX: 0, panY: 0 };
    const out = applyWheelZoom("rect", v, -100, 400, 300, bounds);
    expect(out.vZoom).toBeGreaterThan(1);
    expect(out.zoom).toBe(1);
    expect(out.panX).toBe(0);
  });

  it("scales uniformly in circular mode", () => {
    const v = { vZoom: 1, zoom: 1, panX: 0, panY: 0 };
    const out = applyWheelZoom("circular", v, -100, 400, 300, bounds);
    expect(out.zoom).toBeGreaterThan(1);
    expect(out.vZoom).toBe(1);
  });

  it("keeps the point under the cursor fixed", () => {
    const v = { vZoom: 1, zoom: 1, panX: 0, panY: 0 };
    const cursorY = 500;
    const out = applyWheelZoom("rect", v, -200, 400, cursorY, bounds);
    // world y under the cursor before and after must match
    const centre = bounds.height / 2;
    const before = (cursorY - centre - v.panY) / v.vZoom;
    const after = (cursorY - centre - out.panY) / out.vZoom;
    expect(after).toBeCloseTo(before, 6);
  });

  it("clamps to the zoom limits", () => {
    const huge = applyWheelZoom("rect", { vZoom: 1e9, zoom: 1, panX: 0, panY: 0 }, -1000, 0, 0, bounds);
    expect(huge.vZoom).toBeLessThanOrEqual(20000);
    const tiny = applyWheelZoom("rect", { vZoom: 1e-9, zoom: 1, panX: 0, panY: 0 }, 1000, 0, 0, bounds);
    expect(tiny.vZoom).toBeGreaterThanOrEqual(0.05);
  });

  it("zooming out then in returns to the starting view", () => {
    const v = { vZoom: 1, zoom: 1, panX: 0, panY: 0 };
    const out = applyWheelZoom("rect", v, 120, 400, 300, bounds);
    const back = applyWheelZoom("rect", out, -120, 400, 300, bounds);
    expect(back.vZoom).toBeCloseTo(1, 9);
    expect(back.panY).toBeCloseTo(0, 6);
  });
});

describe("context menu", () => {
  it("describes a clade", () => {
    const t = tree();
    const ab = t.parent[t.nameToNode.get("A")!];
    const req = contextRequest(t, ab, 10, 20)!;
    expect(req.isLeaf).toBe(false);
    expect(req.nLeaves).toBe(2);
    expect(req.label).toBe("clade · 2 leaves");
    expect(req.uid).toBe(t.uid[ab]);
  });

  it("describes a leaf", () => {
    const t = tree();
    const req = contextRequest(t, t.nameToNode.get("B")!, 0, 0)!;
    expect(req.isLeaf).toBe(true);
    expect(req.label).toBe("B");
  });

  it("returns null in empty space", () => {
    expect(contextRequest(tree(), -1, 0, 0)).toBe(null);
  });

  it("copies the leaf labels under a clade", () => {
    const t = tree();
    expect(leafLabelsOf(t, t.root).split("\n")).toEqual(["A", "B", "C", "D"]);
  });
});

describe("tree edit state", () => {
  it("starts unedited", () => {
    const s = initTreeState(tree());
    expect(isEdited(s)).toBe(false);
    expect(canUndo(s)).toBe(false);
  });

  it("marks the tree edited after a reroot", () => {
    const s0 = initTreeState(tree());
    const s1 = reroot(s0, s0.tree.nameToNode.get("C")!);
    expect(isEdited(s1)).toBe(true);
    expect(s1.tree.leaves.length).toBe(4);
  });

  it("resets every edit back to the original", () => {
    const s0 = initTreeState(tree());
    let s = reroot(s0, s0.tree.nameToNode.get("C")!);
    s = ladderize(s, "desc");
    s = resetEdits(s);
    expect(s.tree).toBe(s0.original);
    expect(isEdited(s)).toBe(false);
  });

  it("undoes one edit at a time", () => {
    const s0 = initTreeState(tree());
    const s1 = ladderize(s0, "desc");
    const s2 = rotate(s1, s1.tree.root);
    const back = undo(s2);
    expect(back.tree).toBe(s1.tree);
    expect(undo(back).tree).toBe(s0.tree);
  });

  it("undo on a fresh tree is a no-op", () => {
    const s = initTreeState(tree());
    expect(undo(s)).toBe(s);
  });

  it("prunes the selected leaves", () => {
    const s0 = initTreeState(tree());
    const s = pruneSelection(s0, new Set([0]));
    expect(s.tree.leaves.length).toBe(3);
    expect(Array.from(s.tree.leaves).map((i) => s.tree.name[i])).toEqual(["B", "C", "D"]);
  });

  it("keeps only the selected leaves", () => {
    const s0 = initTreeState(tree());
    const s = keepOnly(s0, new Set([0, 1]));
    expect(Array.from(s.tree.leaves).map((i) => s.tree.name[i])).toEqual(["A", "B"]);
  });

  it("refuses a prune that would empty the tree", () => {
    const s0 = initTreeState(tree());
    expect(keepOnly(s0, new Set())).toBe(s0);
  });

  it("midpoint rooting is recorded as an edit", () => {
    const s0 = initTreeState(parseNewick("((A:0.1,B:0.1):0.1,(C:5.0,D:0.1):0.1);"));
    const s = midpointRoot(s0);
    expect(isEdited(s)).toBe(true);
  });

  it("keeps the canonical leaf order across edits", () => {
    const s0 = initTreeState(tree());
    const canonicalA = s0.canonical.get(s0.tree.uid[s0.tree.nameToNode.get("A")!]);
    const s = rotate(s0, s0.tree.root);
    // the map is unchanged; the tree's own ordering has moved
    expect(s.canonical.get(s0.tree.uid[s0.tree.nameToNode.get("A")!])).toBe(canonicalA);
    expect(Array.from(s.tree.leaves).map((i) => s.tree.name[i])).toEqual(["C", "D", "A", "B"]);
  });

  it("a pinned clade survives a reroot elsewhere, addressed by uid", () => {
    const s0 = initTreeState(tree());
    const cd = s0.tree.parent[s0.tree.nameToNode.get("C")!];
    const pinnedUid = s0.tree.uid[cd];
    const s = reroot(s0, s0.tree.nameToNode.get("A")!);
    const again = nodeByUid(s.tree, pinnedUid);
    expect(again).not.toBe(-1);
    expect(cladeSize(s.tree, again)).toBe(2);
  });
});
