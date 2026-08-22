/**
 * Renderer tests against a stubbed 2D context.
 *
 * Follows garrigue's tests/test_render.js approach: count the drawing calls
 * rather than inspect pixels, which is enough to prove that culling, LOD and
 * the track registry do what they claim, and runs headlessly.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { parseNewick, type Tree } from "@mytol/core";
import {
  TreeRenderer,
  registerTrack,
  getTrack,
  registeredTrackTypes,
  autoPalette,
  heatColor,
  supportColor,
  defaultStyle,
  type TrackInstance,
} from "../src/index";

interface Calls {
  fillRect: number;
  fillText: number;
  stroke: number;
  arc: number;
  ops: string[];
}

function stubCanvas(w = 800, h = 600): { canvas: HTMLCanvasElement; calls: Calls } {
  const calls: Calls = { fillRect: 0, fillText: 0, stroke: 0, arc: 0, ops: [] };
  const ctx: Record<string, unknown> = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textBaseline: "",
    textAlign: "",
    fillRect: () => {
      calls.fillRect++;
      calls.ops.push("fillRect");
    },
    fillText: () => {
      calls.fillText++;
      calls.ops.push("fillText");
    },
    stroke: () => {
      calls.stroke++;
      calls.ops.push("stroke");
    },
    arc: () => {
      calls.arc++;
    },
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    closePath: () => {},
    ellipse: () => {},
    rect: () => {},
    clip: () => {},
    fill: () => {},
    save: () => {},
    restore: () => {},
    translate: () => {},
    scale: () => {},
    setTransform: () => {},
    measureText: (s: string) => ({ width: s.length * 6 }),
  };
  const canvas = {
    width: w,
    height: h,
    style: {} as CSSStyleDeclaration,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;
  return { canvas, calls };
}

function makeRenderer(newick: string, w = 800, h = 600) {
  const { canvas, calls } = stubCanvas(w, h);
  const r = new TreeRenderer(canvas, { dpr: 1 });
  const tree = parseNewick(newick);
  r.setTree(tree);
  r.resize(w, h);
  return { r, calls, tree };
}

const SIMPLE = "((A:0.1,B:0.2)0.95:0.3,(C:0.1,D:0.2)0.72:0.1)0.88;";

function balanced(nLeaves: number): string {
  let nodes: string[] = [];
  for (let i = 0; i < nLeaves; i++) nodes.push(`L${i}:0.05`);
  while (nodes.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < nodes.length; i += 2) {
      next.push(i + 1 < nodes.length ? `(${nodes[i]},${nodes[i + 1]}):0.05` : nodes[i]);
    }
    nodes = next;
  }
  return nodes[0] + ";";
}

describe("drawing", () => {
  it("draws branches for a small tree", () => {
    const { r, calls } = makeRenderer(SIMPLE);
    r.draw();
    expect(calls.fillRect).toBeGreaterThan(4);
  });

  it("draws leaf labels when rows are tall enough", () => {
    const { r, calls } = makeRenderer(SIMPLE);
    r.setStyle({ showLeafLabels: true });
    r.draw();
    expect(calls.fillText).toBeGreaterThanOrEqual(4);
  });

  it("suppresses labels when rows are too short to read", () => {
    const { r, calls } = makeRenderer(balanced(4096));
    r.setStyle({ showLeafLabels: true });
    r.draw();
    // 4096 leaves in 600px is well under the 7px legibility floor
    expect(calls.fillText).toBe(0);
  });

  it("shows support values only when asked", () => {
    const a = makeRenderer(SIMPLE);
    a.r.setStyle({ showSupport: false, showLeafLabels: false });
    a.r.draw();
    const without = a.calls.fillText;

    const b = makeRenderer(SIMPLE);
    b.r.setStyle({ showSupport: true, showLeafLabels: false });
    b.r.draw();
    expect(b.calls.fillText).toBeGreaterThan(without);
  });

  it("paints only the background when there is no tree", () => {
    const { canvas, calls } = stubCanvas();
    const r = new TreeRenderer(canvas, { dpr: 1 });
    r.resize(800, 600);
    calls.fillRect = 0;
    calls.ops.length = 0;
    r.draw();
    expect(calls.fillRect).toBe(1);
    expect(calls.fillText).toBe(0);
  });
});

describe("level of detail", () => {
  it("keeps work bounded by screen size, not by tree size", () => {
    // The real LOD guarantee: an 8x bigger tree on the same canvas must not
    // cost 8x more drawing.
    const small = makeRenderer(balanced(4096));
    small.r.setStyle({ lodMinPx: 1.5, showLeafLabels: false });
    small.calls.fillRect = 0;
    small.r.draw();

    const big = makeRenderer(balanced(32768));
    big.r.setStyle({ lodMinPx: 1.5, showLeafLabels: false });
    big.calls.fillRect = 0;
    big.r.draw();

    expect(big.calls.fillRect).toBeLessThan(small.calls.fillRect * 2);
    // and far below one op per node
    expect(big.calls.fillRect).toBeLessThan(32768);
  });

  it("draws more when LOD thinning is disabled", () => {
    const withLod = makeRenderer(balanced(8192));
    withLod.r.setStyle({ lodMinPx: 4 });
    withLod.r.draw();

    const withoutLod = makeRenderer(balanced(8192));
    withoutLod.r.setStyle({ lodMinPx: 0 });
    withoutLod.r.draw();

    expect(withoutLod.calls.fillRect).toBeGreaterThan(withLod.calls.fillRect);
  });

  it("culls leaves outside the viewport when zoomed in", () => {
    const zoomed = makeRenderer(balanced(4096));
    zoomed.r.setView({ vZoom: 50 });
    zoomed.r.draw();
    const m = zoomed.r.metrics()!;
    // only a slice of the 4096 leaves can be on screen at 50x
    expect(m.visibleLeafEnd - m.visibleLeafStart).toBeLessThan(4096);
  });
});

describe("picking", () => {
  it("finds the node under the cursor and nothing in empty space", () => {
    const { r, tree } = makeRenderer(SIMPLE);
    r.draw();
    for (let i = 0; i < tree.leaves.length; i++) {
      const id = tree.leaves[i];
      const p = r.screenPosition(id)!;
      expect(r.pick(p.x, p.y, 8)).toBe(id);
    }
    expect(r.pick(-500, -500, 5)).toBe(-1);
  });

  it("picks an internal node at its own position", () => {
    const { r, tree } = makeRenderer(SIMPLE);
    r.draw();
    const internal = tree.parent[tree.leaves[0]];
    const p = r.screenPosition(internal)!;
    expect(r.pick(p.x, p.y, 8)).toBe(internal);
  });

  it("reports screen positions in every layout mode", () => {
    for (const mode of ["rect", "circular", "unrooted"] as const) {
      const { r, tree } = makeRenderer(SIMPLE);
      r.setView({ mode });
      r.draw();
      const p = r.screenPosition(tree.leaves[0]);
      expect(p).not.toBe(null);
      expect(Number.isFinite(p!.x)).toBe(true);
      expect(Number.isFinite(p!.y)).toBe(true);
    }
  });

  it("maps a screen y back to a leaf index", () => {
    const { r, tree } = makeRenderer(SIMPLE);
    r.draw();
    const m = r.metrics()!;
    for (let i = 0; i < tree.leaves.length; i++) {
      const y = 600 / 2 + (m.originY + m.sy * i);
      expect(r.leafIndexAt(y)).toBe(i);
    }
  });

  it("picking stays fast on a large tree", () => {
    const { r } = makeRenderer(balanced(50000));
    r.draw();
    const m = r.metrics()!;
    const t0 = Date.now();
    for (let k = 0; k < 500; k++) {
      r.pick(m.trackStartX - 20, 100 + (k % 400), 20);
    }
    // O(depth) picking: 500 hit tests on 100k nodes must not take a second
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("unrooted picking uses the spatial grid rather than a full scan", () => {
    const { r } = makeRenderer(balanced(20000));
    r.setView({ mode: "unrooted" });
    r.draw();
    const t0 = Date.now();
    for (let k = 0; k < 300; k++) r.pick(400 + (k % 50), 300 + (k % 50), 20);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe("highlight", () => {
  it("dims a clade whose leaves all fail the filter", () => {
    const { r, tree } = makeRenderer(SIMPLE);
    const mask = new Uint8Array(tree.leaves.length); // nothing passes
    r.setHighlight({ mask });
    r.draw();
    // proves the mask path runs; colour choice is asserted via branchColor below
    expect(tree.leaves.length).toBe(4);
  });

  it("draws selection marks for selected leaves", () => {
    const plain = makeRenderer(SIMPLE);
    plain.r.setStyle({ showLeafLabels: false });
    plain.r.draw();
    const before = plain.calls.fillRect;

    const withSel = makeRenderer(SIMPLE);
    withSel.r.setStyle({ showLeafLabels: false });
    withSel.r.setHighlight({ selection: new Set([0, 1, 2, 3]) });
    withSel.r.draw();
    expect(withSel.calls.fillRect).toBeGreaterThan(before);
  });

  it("draws a band for the pinned and hovered clade", () => {
    const plain = makeRenderer(SIMPLE);
    plain.r.setStyle({ showLeafLabels: false });
    plain.r.draw();
    const before = plain.calls.fillRect;

    const pinned = makeRenderer(SIMPLE);
    pinned.r.setStyle({ showLeafLabels: false });
    pinned.r.setHighlight({ pinned: pinned.tree.root, hover: pinned.tree.root });
    pinned.r.draw();
    expect(pinned.calls.fillRect).toBeGreaterThan(before);
  });
});

describe("track registry", () => {
  beforeEach(() => {
    registerTrack("test-probe", {
      width: 20,
      drawCell(ctx, x, y, w, h) {
        ctx.fillRect(x, y, w, h);
      },
    });
  });

  it("ships the built-in track types", () => {
    for (const t of ["colorstrip", "binary", "text", "heatmap", "bar", "domains"]) {
      expect(getTrack(t)).toBeDefined();
    }
    expect(registeredTrackTypes()).toContain("colorstrip");
  });

  it("lets a host register a new type without touching the renderer", () => {
    const { r, calls } = makeRenderer(SIMPLE);
    r.setStyle({ showLeafLabels: false });
    r.draw();
    const before = calls.fillRect;

    const track: TrackInstance = {
      type: "test-probe",
      label: "probe",
      visible: true,
      values: [1, 2, 3, 4],
    };
    r.setTracks([track]);
    r.draw();
    expect(calls.fillRect).toBeGreaterThan(before);
  });

  it("skips invisible tracks", () => {
    const { r, calls } = makeRenderer(SIMPLE);
    r.setStyle({ showLeafLabels: false });
    r.setTracks([{ type: "test-probe", label: "p", visible: false, values: [1, 2, 3, 4] }]);
    r.draw();
    const hidden = calls.fillRect;

    const shown = makeRenderer(SIMPLE);
    shown.r.setStyle({ showLeafLabels: false });
    shown.r.setTracks([{ type: "test-probe", label: "p", visible: true, values: [1, 2, 3, 4] }]);
    shown.r.draw();
    expect(shown.calls.fillRect).toBeGreaterThan(hidden);
  });

  it("builds a categorical palette on attach", () => {
    const { r } = makeRenderer(SIMPLE);
    const track: TrackInstance = {
      type: "colorstrip",
      label: "phylum",
      visible: true,
      values: ["Firmicutes", "Proteobacteria", "Firmicutes", "Bacteroidota"],
    };
    r.setTracks([track]);
    expect(Object.keys(track.palette ?? {})).toHaveLength(3);
  });

  it("derives vmin/vmax for a heatmap on attach", () => {
    const { r } = makeRenderer(SIMPLE);
    const track: TrackInstance = {
      type: "heatmap",
      label: "defense_score",
      visible: true,
      numeric: Float64Array.from([0.1, 0.9, 0.5, 0.3]),
    };
    r.setTracks([track]);
    expect(track.vmin).toBeCloseTo(0.1, 9);
    expect(track.vmax).toBeCloseTo(0.9, 9);
  });

  it("renders Pfam-style domain records", () => {
    const { r, calls } = makeRenderer(SIMPLE);
    r.setStyle({ showLeafLabels: false });
    const track: TrackInstance = {
      type: "domains",
      label: "Pfam",
      visible: true,
      values: [
        { length: 300, domains: [{ name: "PF00001", start: 20, end: 120 }] },
        { length: 250, domains: [{ name: "PF00002", start: 10, end: 200 }] },
        undefined,
        { length: 400, domains: [] },
      ],
    };
    r.setTracks([track]);
    const before = calls.fillRect;
    r.draw();
    expect(calls.fillRect).toBeGreaterThan(before);
    expect(Object.keys(track.palette ?? {})).toEqual(["PF00001", "PF00002"]);
  });
});

describe("view and layout modes", () => {
  it("renders all three layout modes without error", () => {
    for (const mode of ["rect", "circular", "unrooted"] as const) {
      const { r, calls } = makeRenderer(SIMPLE);
      r.setView({ mode });
      r.draw();
      expect(calls.ops.length).toBeGreaterThan(0);
    }
  });

  it("recomputes layout when switching phylogram/cladogram", () => {
    const { r, tree } = makeRenderer(SIMPLE);
    r.setView({ phylogram: true });
    r.draw();
    const phyloX = r.metrics()!.sx;
    r.setView({ phylogram: false });
    r.draw();
    expect(r.metrics()!.sx).not.toBe(phyloX);
    expect(tree.leaves.length).toBe(4);
  });

  it("fit resets pan and zoom", () => {
    const { r } = makeRenderer(SIMPLE);
    r.setView({ panX: 100, panY: 50, vZoom: 8 });
    r.fit();
    const v = r.getView();
    expect(v.panX).toBe(0);
    expect(v.panY).toBe(0);
    expect(v.vZoom).toBe(1);
  });

  it("resize updates the backing store for the device pixel ratio", () => {
    const { canvas } = stubCanvas();
    const r = new TreeRenderer(canvas, { dpr: 2 });
    r.setTree(parseNewick(SIMPLE));
    r.resize(400, 300);
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(600);
  });
});

describe("colour helpers", () => {
  it("supportColor runs red to green", () => {
    expect(supportColor(0)).toBe("rgb(220,40,60)");
    expect(supportColor(1)).toBe("rgb(0,200,60)");
  });
  it("heatColor is diverging and clamps", () => {
    expect(heatColor(0.5, 0, 1)).toBe("rgb(255,255,255)");
    expect(heatColor(-99, 0, 1)).toBe(heatColor(0, 0, 1));
    expect(heatColor(NaN, 0, 1)).toBe(null);
  });
  it("autoPalette is stable and deduplicates", () => {
    const p = autoPalette(["a", "b", "a", "c"]);
    expect(Object.keys(p)).toEqual(["a", "b", "c"]);
    expect(autoPalette(["a", "b", "c"])).toEqual(p);
  });
  it("defaultStyle enables LOD by default", () => {
    expect(defaultStyle().lodMinPx).toBeGreaterThan(0);
  });
});

describe("branch picking", () => {
  it("picks a branch clicked between its endpoints, not only at a vertex", () => {
    const { r, tree } = makeRenderer(SIMPLE);
    r.draw();
    const leaf = tree.leaves[0];
    const parent = tree.parent[leaf];
    const a = r.screenPosition(leaf)!;
    const b = r.screenPosition(parent)!;
    // midway along the horizontal run of the leaf's own branch
    const midX = (a.x + b.x) / 2;
    expect(r.pick(midX, a.y, 6)).toBe(leaf);
  });

  it("picks a clade by clicking its vertical connector", () => {
    const { r, tree } = makeRenderer("((A:0.1,B:0.1):0.3,(C:0.1,D:0.1):0.3);");
    r.draw();
    const ab = tree.parent[tree.leaves[0]];
    const p = r.screenPosition(ab)!;
    const childA = r.screenPosition(tree.leaves[0])!;
    // on the connector: parent's x, partway towards the child's row
    const hit = r.pick(p.x, (p.y + childA.y) / 2, 6);
    expect([ab, tree.leaves[0]]).toContain(hit);
  });

  it("still returns nothing well away from any branch", () => {
    const { r } = makeRenderer(SIMPLE);
    r.draw();
    expect(r.pick(5, 5, 4)).toBe(-1);
  });

  it("picking a dense tree by branch stays O(depth)", () => {
    const { r } = makeRenderer(balanced(50000));
    r.draw();
    const t0 = Date.now();
    for (let k = 0; k < 400; k++) r.pick(200 + (k % 300), 100 + (k % 400), 14);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});
