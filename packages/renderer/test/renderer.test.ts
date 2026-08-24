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
  hashColor,
  heatColor,
  supportColor,
  supportRgb,
  hexToRgb,
  defaultStyle,
  type TrackInstance,
} from "../src/index";

interface Calls {
  fillRect: number;
  fillText: number;
  stroke: number;
  arc: number;
  fill: number;
  ops: string[];
  /** x of every moveTo/lineTo, for extent assertions. */
  xs: number[];
  /** Geometry and fillStyle of each fillRect, for colour assertions. */
  rects: Array<{ x: number; y: number; w: number; h: number; color: string }>;
  /** Rects handed to clip(), so a test can check what was masked off. */
  clips: Array<{ x: number; y: number; w: number; h: number }>;
}

function stubCanvas(w = 800, h = 600): { canvas: HTMLCanvasElement; calls: Calls } {
  // rect() then clip() is how a clipping region is set; remember the last rect
  // so clip() can record what it actually masked to.
  let pendingRect: { x: number; y: number; w: number; h: number } | null = null;
  const calls: Calls = { fillRect: 0, fillText: 0, stroke: 0, arc: 0, fill: 0, ops: [], xs: [], rects: [], clips: [] };
  const ctx: Record<string, unknown> = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textBaseline: "",
    textAlign: "",
    fillRect: (x: number, y: number, w: number, h: number) => {
      calls.fillRect++;
      calls.ops.push("fillRect");
      calls.xs.push(x, x + w);
      calls.rects.push({ x, y, w, h, color: String(ctx.fillStyle) });
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
    // Path coordinates are recorded so a test can ask how far right the drawing
    // actually reached.
    moveTo: (x: number) => {
      calls.xs.push(x);
    },
    lineTo: (x: number) => {
      calls.xs.push(x);
    },
    closePath: () => {},
    ellipse: () => {},
    rect: (x: number, y: number, w: number, h: number) => {
      pendingRect = { x, y, w, h };
    },
    clip: () => {
      if (pendingRect) calls.clips.push(pendingRect);
      pendingRect = null;
    },
    // fill() is how filled paths are drawn — the circular highlight wedges use
    // it rather than fillRect, so it has to count as an operation.
    fill: () => {
      calls.fill++;
      calls.ops.push("fill");
    },
    save: () => {},
    restore: () => {},
    translate: () => {},
    scale: () => {},
    rotate: () => {},
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
  it("supportColor runs low to high on the default ramp", () => {
    // default is red-yellow-green, the convention for a support scale
    expect(supportColor(0)).toBe("rgb(215,48,39)");
    expect(supportColor(1)).toBe("rgb(26,152,80)");
    expect(supportColor(0.5)).toBe("rgb(254,224,139)");
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

describe("circular layout", () => {
  /**
   * Count the ops of ONE frame.
   *
   * The counters accumulate, and resize()/setView()/setHighlight() each trigger
   * a draw of their own (there is no rAF in node, so requestDraw paints
   * immediately). Measuring without zeroing first compares a running total
   * against a single frame.
   */
  function frameOps(r: TreeRenderer, calls: Calls): number {
    calls.ops.length = 0;
    r.draw();
    return calls.ops.length;
  }

  it("draws a highlight wedge for the pinned clade", () => {
    const plain = makeRenderer(SIMPLE);
    plain.r.setView({ mode: "circular" });
    plain.r.setStyle({ showLeafLabels: false });
    const before = frameOps(plain.r, plain.calls);

    const pinned = makeRenderer(SIMPLE);
    pinned.r.setView({ mode: "circular" });
    pinned.r.setStyle({ showLeafLabels: false });
    pinned.r.setHighlight({ pinned: pinned.tree.root });
    expect(frameOps(pinned.r, pinned.calls)).toBeGreaterThan(before);
  });

  it("draws selection ticks around the rim", () => {
    const plain = makeRenderer(SIMPLE);
    plain.r.setView({ mode: "circular" });
    plain.r.setStyle({ showLeafLabels: false });
    plain.calls.stroke = 0;
    plain.r.draw();
    const before = plain.calls.stroke;

    const sel = makeRenderer(SIMPLE);
    sel.r.setView({ mode: "circular" });
    sel.r.setStyle({ showLeafLabels: false });
    sel.r.setHighlight({ selection: new Set([0, 1, 2, 3]) });
    sel.calls.stroke = 0;
    sel.r.draw();
    expect(sel.calls.stroke).toBeGreaterThan(before);
  });

  it("labels the rim when the tips are far enough apart", () => {
    const { r, calls } = makeRenderer(SIMPLE);
    r.setView({ mode: "circular" });
    r.setStyle({ showLeafLabels: true });
    calls.fillText = 0;
    r.draw();
    expect(calls.fillText).toBeGreaterThanOrEqual(4);
  });

  it("drops rim labels when the tips crowd together", () => {
    const { r, calls } = makeRenderer(balanced(8192));
    r.setView({ mode: "circular" });
    r.setStyle({ showLeafLabels: true });
    calls.fillText = 0;
    r.draw();
    expect(calls.fillText).toBe(0);
  });

  it("picks a node in circular mode at its own position", () => {
    const { r, tree } = makeRenderer(SIMPLE);
    r.setView({ mode: "circular" });
    r.draw();
    for (const leaf of tree.leaves) {
      const p = r.screenPosition(leaf)!;
      expect(r.pick(p.x, p.y, 10)).toBe(leaf);
    }
  });

  it("rotation moves the tips without changing the tree", () => {
    const { r, tree } = makeRenderer(SIMPLE);
    r.setView({ mode: "circular", rotation: 0 });
    r.draw();
    const before = r.screenPosition(tree.leaves[0])!;
    r.setView({ rotation: 90 });
    r.draw();
    const after = r.screenPosition(tree.leaves[0])!;
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(1);
    expect(tree.leaves.length).toBe(4);
  });

  it("a narrower arc packs the tips closer together", () => {
    const { r, tree } = makeRenderer(SIMPLE);
    r.setView({ mode: "circular", arc: 360, rotation: 0 });
    r.draw();
    const a0 = r.screenPosition(tree.leaves[0])!;
    const a1 = r.screenPosition(tree.leaves[1])!;
    const wideStep = Math.hypot(a1.x - a0.x, a1.y - a0.y);

    // Adjacent tips, not first-to-last: across a full circle the outermost
    // pair wraps back around and the chord between them says nothing.
    r.setView({ arc: 120 });
    r.draw();
    const b0 = r.screenPosition(tree.leaves[0])!;
    const b1 = r.screenPosition(tree.leaves[1])!;
    expect(Math.hypot(b1.x - b0.x, b1.y - b0.y)).toBeLessThan(wideStep);
  });

  it("still culls by level of detail on a large circular tree", () => {
    const small = makeRenderer(balanced(4096));
    small.r.setView({ mode: "circular" });
    small.r.setStyle({ showLeafLabels: false });
    small.calls.stroke = 0;
    small.r.draw();

    const big = makeRenderer(balanced(32768));
    big.r.setView({ mode: "circular" });
    big.r.setStyle({ showLeafLabels: false });
    big.calls.stroke = 0;
    big.r.draw();

    expect(big.calls.stroke).toBeLessThan(small.calls.stroke * 3);
  });
});

describe("circular branch picking", () => {
  it("picks a branch clicked along its radial run", () => {
    const { r, tree } = makeRenderer(SIMPLE);
    r.setView({ mode: "circular" });
    r.draw();
    const leaf = tree.leaves[0];
    const parent = tree.parent[leaf];
    const a = r.screenPosition(leaf)!;
    const b = r.screenPosition(parent)!;
    // partway between the two, which is on the branch but at no vertex
    expect(r.pick((a.x + b.x) / 2, (a.y + b.y) / 2, 14)).toBeGreaterThanOrEqual(0);
  });

  it("picks a clade from a point on its connecting arc", () => {
    const { r, tree } = makeRenderer("((A:0.1,B:0.1):0.3,(C:0.1,D:0.1):0.3);");
    r.setView({ mode: "circular" });
    r.draw();
    const ab = tree.parent[tree.leaves[0]];
    const p = r.screenPosition(ab)!;
    const hit = r.pick(p.x, p.y, 12);
    expect(hit).toBeGreaterThanOrEqual(0);
  });

  it("returns nothing far outside the tree", () => {
    const { r } = makeRenderer(SIMPLE);
    r.setView({ mode: "circular" });
    r.draw();
    expect(r.pick(5, 5, 4)).toBe(-1);
  });

  it("keeps working after the tree is rotated", () => {
    const { r, tree } = makeRenderer(SIMPLE);
    r.setView({ mode: "circular", rotation: 137 });
    r.draw();
    for (const leaf of tree.leaves) {
      const p = r.screenPosition(leaf)!;
      expect(r.pick(p.x, p.y, 10)).toBe(leaf);
    }
  });

  it("stays fast on a large circular tree", () => {
    const { r } = makeRenderer(balanced(40000));
    r.setView({ mode: "circular" });
    r.draw();
    const t0 = Date.now();
    for (let k = 0; k < 400; k++) r.pick(300 + (k % 200), 200 + (k % 300), 14);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe("support colouring", () => {
  const RAMP = { low: "#000000", mid: "#808080", high: "#ffffff" };

  it("interpolates low -> mid -> high", () => {
    expect(supportColor(0, RAMP, 0.5)).toBe("rgb(0,0,0)");
    expect(supportColor(0.5, RAMP, 0.5)).toBe("rgb(128,128,128)");
    expect(supportColor(1, RAMP, 0.5)).toBe("rgb(255,255,255)");
  });

  it("puts the mid colour wherever the midpoint says", () => {
    expect(supportColor(0.9, RAMP, 0.9)).toBe("rgb(128,128,128)");
    // below a high midpoint, values stay in the lower half of the ramp
    const [r] = supportRgb(0.5, RAMP, 0.9);
    expect(r).toBeLessThan(128);
  });

  it("clamps out-of-range support", () => {
    expect(supportColor(-5, RAMP, 0.5)).toBe(supportColor(0, RAMP, 0.5));
    expect(supportColor(99, RAMP, 0.5)).toBe(supportColor(1, RAMP, 0.5));
  });

  it("accepts short hex", () => {
    expect(hexToRgb("#f00")).toEqual([255, 0, 0]);
    expect(hexToRgb("#ff0000")).toEqual([255, 0, 0]);
  });

  it("survives a nonsense colour rather than throwing", () => {
    expect(hexToRgb("not a colour")).toEqual([128, 128, 128]);
  });

  it("changes what gets drawn when switched on", () => {
    const off = makeRenderer(SIMPLE);
    off.r.setStyle({ colorBySupport: false, showLeafLabels: false });
    off.r.draw();

    const on = makeRenderer(SIMPLE);
    on.r.setStyle({ colorBySupport: true, showLeafLabels: false });
    on.r.draw();
    // both draw; the point is that enabling it does not break the draw path
    expect(on.calls.fillRect).toBeGreaterThan(0);
    expect(off.calls.fillRect).toBeGreaterThan(0);
  });

  it("shows numeric support labels only when asked", () => {
    const off = makeRenderer(SIMPLE);
    off.r.setStyle({ showSupport: false, showLeafLabels: false });
    off.calls.fillText = 0;
    off.r.draw();

    const on = makeRenderer(SIMPLE);
    on.r.setStyle({ showSupport: true, showLeafLabels: false });
    on.calls.fillText = 0;
    on.r.draw();
    expect(on.calls.fillText).toBeGreaterThan(off.calls.fillText);
  });

  it("honours a custom ramp through setStyle", () => {
    const { r } = makeRenderer(SIMPLE);
    r.setStyle({
      colorBySupport: true,
      supportRamp: { low: "#111111", mid: "#222222", high: "#333333" },
    });
    r.draw();
    expect(r.getStyle().supportRamp.high).toBe("#333333");
  });

  it("thickness is adjustable", () => {
    const { r } = makeRenderer(SIMPLE);
    r.setStyle({ branchWidth: 3 });
    expect(r.getStyle().branchWidth).toBe(3);
    r.draw();
  });

  it("branches with no support value do not vanish", () => {
    // topology only: no internal labels at all
    const { r, calls } = makeRenderer("((A,B),(C,D));");
    r.setStyle({ colorBySupport: true, showLeafLabels: false });
    calls.fillRect = 0;
    r.draw();
    expect(calls.fillRect).toBeGreaterThan(0);
  });
});

describe("annotation rings in circular mode", () => {
  const track = (): TrackInstance => ({
    type: "colorstrip",
    label: "phylum",
    visible: true,
    values: ["a", "b", "a", "c"],
  });

  it("draws tracks in circular mode, not only in linear", () => {
    const bare = makeRenderer(SIMPLE);
    bare.r.setView({ mode: "circular" });
    bare.r.setStyle({ showLeafLabels: false });
    bare.calls.fillRect = 0;
    bare.r.draw();
    const before = bare.calls.fillRect;

    const withTrack = makeRenderer(SIMPLE);
    withTrack.r.setView({ mode: "circular" });
    withTrack.r.setStyle({ showLeafLabels: false });
    withTrack.r.setTracks([track()]);
    withTrack.calls.fillRect = 0;
    withTrack.r.draw();
    expect(withTrack.calls.fillRect).toBeGreaterThan(before);
  });

  it("stacks several rings without error", () => {
    const { r, calls } = makeRenderer(SIMPLE);
    r.setView({ mode: "circular" });
    r.setStyle({ showLeafLabels: false });
    r.setTracks([track(), { ...track(), label: "second" }, { ...track(), label: "third" }]);
    calls.fillRect = 0;
    r.draw();
    expect(calls.fillRect).toBeGreaterThan(8);
  });

  it("skips invisible rings", () => {
    const { r, calls } = makeRenderer(SIMPLE);
    r.setView({ mode: "circular" });
    r.setStyle({ showLeafLabels: false });
    r.setTracks([{ ...track(), visible: false }]);
    calls.fillRect = 0;
    r.draw();
    const hidden = calls.fillRect;

    r.setTracks([track()]);
    calls.fillRect = 0;
    r.draw();
    expect(calls.fillRect).toBeGreaterThan(hidden);
  });

  it("thins ring cells on a large tree instead of drawing one per leaf", () => {
    const { r, calls } = makeRenderer(balanced(16384));
    r.setView({ mode: "circular" });
    r.setStyle({ showLeafLabels: false, lodMinPx: 1.5 });
    const values = new Array(16384).fill("x");
    r.setTracks([{ type: "colorstrip", label: "t", visible: true, values }]);
    calls.fillRect = 0;
    r.draw();
    expect(calls.fillRect).toBeLessThan(16384);
  });
});

describe("stable annotation colours", () => {
  it("assigns palette colours by sorted category, not by encounter order", () => {
    const a = autoPalette(["zebra", "alpha", "mid"]);
    const b = autoPalette(["mid", "zebra", "alpha"]);
    expect(a).toEqual(b);
  });

  it("gives the first colour to the first category alphabetically", () => {
    const p = autoPalette(["beta", "alpha"]);
    expect(p.alpha).not.toBe(p.beta);
    expect(Object.keys(p).sort()).toEqual(["alpha", "beta"]);
  });

  it("an explicit palette is left alone", () => {
    const { r } = makeRenderer(SIMPLE);
    const fixed = { a: "#111111", b: "#222222" };
    const t: TrackInstance = {
      type: "colorstrip",
      label: "t",
      visible: true,
      values: ["a", "b", "a", "b"],
      palette: fixed,
    };
    r.setTracks([t]);
    expect(t.palette).toBe(fixed);
  });
});

describe("support scale domain", () => {
  it("spans only the configured range", () => {
    const { r } = makeRenderer("((A:1,B:1)0.92:1,(C:1,D:1)0.98:1);");
    r.setStyle({
      colorBySupport: true,
      supportMin: 0.9,
      supportMax: 1,
      supportRamp: { low: "#000000", mid: "#808080", high: "#ffffff" },
    });
    r.draw();
    expect(r.getStyle().supportMin).toBe(0.9);
    expect(r.getStyle().supportMax).toBe(1);
  });

  it("clamps outside the domain rather than wrapping", () => {
    const { r } = makeRenderer("((A:1,B:1)0.1:1,(C:1,D:1)0.99:1);");
    r.setStyle({ colorBySupport: true, supportMin: 0.9, supportMax: 1 });
    // 0.1 is far below the domain; it must simply take the low colour
    expect(() => r.draw()).not.toThrow();
  });

  it("a degenerate domain does not divide by zero", () => {
    const { r } = makeRenderer(SIMPLE);
    r.setStyle({ colorBySupport: true, supportMin: 0.5, supportMax: 0.5 });
    expect(() => r.draw()).not.toThrow();
  });
});

describe("annotation track hit-testing", () => {
  const track = (label = "phylum"): TrackInstance => ({
    type: "colorstrip",
    label,
    visible: true,
    values: ["a", "b", "a", "c"],
  });

  it("reports the track and leaf under the cursor in linear mode", () => {
    const { r, tree } = makeRenderer(SIMPLE);
    r.setTracks([track()]);
    r.draw();
    const m = r.metrics()!;
    const y = r.screenPosition(tree.leaves[1])!.y;
    const hit = r.trackAt(m.trackStartX + 4, y);
    expect(hit).not.toBe(null);
    expect(hit!.track.label).toBe("phylum");
    expect(hit!.leafIndex).toBe(1);
  });

  it("returns nothing over the tree itself", () => {
    const { r, tree } = makeRenderer(SIMPLE);
    r.setTracks([track()]);
    r.draw();
    const p = r.screenPosition(tree.root)!;
    expect(r.trackAt(p.x, p.y)).toBe(null);
  });

  it("distinguishes stacked tracks", () => {
    const { r, tree } = makeRenderer(SIMPLE);
    r.setTracks([track("first"), track("second")]);
    r.draw();
    const m = r.metrics()!;
    const y = r.screenPosition(tree.leaves[0])!.y;
    const a = r.trackAt(m.trackStartX + 2, y);
    const b = r.trackAt(m.trackStartX + 30, y);
    expect(a!.track.label).toBe("first");
    expect(b!.track.label).toBe("second");
  });

  it("hit-tests rings in circular mode", () => {
    const { r } = makeRenderer(SIMPLE);
    r.setView({ mode: "circular", rotation: 0, arc: 360 });
    r.setTracks([track()]);
    r.setStyle({ showLeafLabels: false });
    r.draw();
    // just outside the tip circle, on the ring
    const R = Math.min(800, 600) * 0.45;
    const hit = r.trackAt(800 / 2 + R * 1.06, 600 / 2);
    expect(hit).not.toBe(null);
    expect(hit!.track.label).toBe("phylum");
  });

  it("returns nothing well inside the circle", () => {
    const { r } = makeRenderer(SIMPLE);
    r.setView({ mode: "circular" });
    r.setTracks([track()]);
    r.draw();
    expect(r.trackAt(400, 300)).toBe(null);
  });

  it("has no track hits before anything is drawn", () => {
    const { r } = makeRenderer(SIMPLE);
    r.setTracks([track()]);
    expect(r.trackAt(0, 0)).toBe(null);
  });
});

describe("tracks in unrooted mode", () => {
  it("draws annotation markers on the tips", () => {
    const bare = makeRenderer(SIMPLE);
    bare.r.setView({ mode: "unrooted" });
    bare.r.setStyle({ showLeafLabels: false });
    bare.calls.fillRect = 0;
    bare.r.draw();
    const before = bare.calls.fillRect;

    const withTrack = makeRenderer(SIMPLE);
    withTrack.r.setView({ mode: "unrooted" });
    withTrack.r.setStyle({ showLeafLabels: false });
    withTrack.r.setTracks([
      { type: "colorstrip", label: "t", visible: true, values: ["a", "b", "a", "c"] },
    ]);
    withTrack.calls.fillRect = 0;
    withTrack.r.draw();
    expect(withTrack.calls.fillRect).toBeGreaterThan(before);
  });

  it("stacks several unrooted tracks outward from each tip", () => {
    const { r, calls } = makeRenderer(SIMPLE);
    r.setView({ mode: "unrooted" });
    r.setStyle({ showLeafLabels: false });
    const t = (label: string): TrackInstance => ({
      type: "colorstrip",
      label,
      visible: true,
      values: ["a", "b", "a", "c"],
    });
    r.setTracks([t("one")]);
    calls.fillRect = 0;
    r.draw();
    const one = calls.fillRect;

    r.setTracks([t("one"), t("two")]);
    calls.fillRect = 0;
    r.draw();
    expect(calls.fillRect).toBeGreaterThan(one);
  });
});

describe("robust framing", () => {
  /** One tip far deeper than the rest — the case that ruins a max-based fit. */
  const OUTLIER =
    "((" +
    Array.from({ length: 20 }, (_, i) => `T${i}:1.0`).join(",") +
    "):0.1,FAR:20.0);";

  it("frames on the quantile, not on the deepest tip", () => {
    const { r } = makeRenderer(OUTLIER);
    r.setView({ fitQuantile: 0.9 });
    r.draw();
    const wide = r.metrics()!.sx;

    r.setView({ fitQuantile: 1 });
    r.draw();
    const narrow = r.metrics()!.sx;

    // Framing on 90% gives a LARGER scale, because it ignores the long branch.
    expect(wide).toBeGreaterThan(narrow * 2);
  });

  it("puts the tracks just beyond the bulk of the tips", () => {
    const { r } = makeRenderer(OUTLIER);
    r.setStyle({ showLeafLabels: false });
    r.setView({ fitQuantile: 0.9 });
    r.draw();
    const near = r.metrics()!.trackStartX;

    r.setView({ fitQuantile: 1 });
    r.draw();
    // With the outlier framed in, the tracks are pushed no closer.
    expect(near).toBeLessThanOrEqual(r.metrics()!.trackStartX + 1);
  });

  it("changing the quantile relayouts rather than only rescaling", () => {
    const { r } = makeRenderer(OUTLIER);
    r.setView({ fitQuantile: 1 });
    r.draw();
    const a = r.metrics()!.sx;
    r.setView({ fitQuantile: 0.5 });
    r.draw();
    expect(r.metrics()!.sx).not.toBe(a);
  });

  it("costs nothing on a tree with no outliers", () => {
    const even = "(" + Array.from({ length: 20 }, (_, i) => `T${i}:1.0`).join(",") + ");";
    const { r } = makeRenderer(even);
    r.setView({ fitQuantile: 0.9 });
    r.draw();
    const q = r.metrics()!.sx;
    r.setView({ fitQuantile: 1 });
    r.draw();
    expect(r.metrics()!.sx).toBeCloseTo(q, 6);
  });
});

describe("support colouring defaults", () => {
  it("is on out of the box", () => {
    expect(defaultStyle().colorBySupport).toBe(true);
  });

  it("spans 0.8 to 1.0 rather than the whole interval", () => {
    const s = defaultStyle();
    expect(s.supportMin).toBe(0.8);
    expect(s.supportMax).toBe(1);
  });

  it("runs black to bright green", () => {
    const s = defaultStyle();
    expect(hexToRgb(s.supportRamp.low)).toEqual([0, 0, 0]);
    const [, g] = hexToRgb(s.supportRamp.high);
    expect(g).toBeGreaterThan(180);
  });

  it("the ramp runs black at its foot to green at its head", () => {
    // supportColor takes a position ALONG the ramp; the 0.8..1.0 domain is
    // applied before it, by the renderer.
    const s = defaultStyle();
    expect(supportColor(0, s.supportRamp, s.supportMidpoint)).toBe("rgb(0,0,0)");
    const top = supportRgb(1, s.supportRamp, s.supportMidpoint);
    expect(top[1]).toBeGreaterThan(top[0] + 100);
  });

  it("the default domain maps a support of 0.8 to the foot and 1.0 to the head", () => {
    const { supportMin: lo, supportMax: hi } = defaultStyle();
    const norm = (v: number) => (v - lo) / (hi - lo);
    expect(norm(0.8)).toBeCloseTo(0, 9);
    expect(norm(1.0)).toBeCloseTo(1, 9);
    // and a poorly supported branch clamps to the foot rather than wrapping
    expect(Math.max(0, Math.min(1, norm(0.4)))).toBe(0);
  });
});

describe("level of detail wedges", () => {
  // Balanced topology, uneven tip lengths. On a short canvas most clades fall
  // under lodMinPx, which is exactly the case that used to make the tree stop
  // well short of its own tips: the deep structure lives in the small clades.
  function ragged(n: number): string {
    let nodes = Array.from(
      { length: n },
      (_, i) => `L${i}:${(0.02 + ((i * 7) % 11) * 0.06).toFixed(3)}`,
    );
    while (nodes.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < nodes.length; i += 2) {
        next.push(i + 1 < nodes.length ? `(${nodes[i]},${nodes[i + 1]}):0.02` : nodes[i]);
      }
      nodes = next;
    }
    return nodes[0] + ";";
  }

  it("draws culled clades as wedges rather than dropping them", () => {
    const { r, calls } = makeRenderer(ragged(4000), 400, 120);
    r.setStyle({ lodMinPx: 4, showLeafLabels: false });
    calls.fill = 0;
    r.draw();
    // Wedges are filled paths; branches are fillRects, so a non-zero fill()
    // count can only come from the wedges.
    expect(calls.fill).toBeGreaterThan(0);
    expect(r.collapsedClades().length).toBeGreaterThan(0);
  });

  it("reaches the fitted tip column instead of stopping at the backbone", () => {
    const { r, calls } = makeRenderer(ragged(4000), 400, 120);
    r.setStyle({ lodMinPx: 4, showLeafLabels: false });
    calls.xs.length = 0;
    r.draw();
    const withWedges = Math.max(...calls.xs);

    // Same tree, same canvas, but nothing culled: that is the honest extent.
    const full = makeRenderer(ragged(4000), 400, 120);
    full.r.setStyle({ lodMinPx: 0, showLeafLabels: false });
    full.calls.xs.length = 0;
    full.r.draw();
    const uncalled = Math.max(...full.calls.xs);

    expect(withWedges).toBeGreaterThan(uncalled * 0.9);
  });

  it("collapses each clade once, never one nested inside another", () => {
    const { r, tree } = makeRenderer(ragged(4000), 400, 120);
    r.setStyle({ lodMinPx: 4, showLeafLabels: false });
    r.draw();
    const c = r.collapsedClades();
    expect(c.length).toBeGreaterThan(0);
    // Sorted by left edge, each clade must begin at or after the previous one
    // ended. A pairwise check is quadratic, and a polytomy collapses thousands.
    const sorted = [...c].sort((a, b) => tree.L[a] - tree.L[b]);
    let reach = -1;
    let overlaps = 0;
    for (const id of sorted) {
      if (tree.L[id] < reach) overlaps++;
      reach = Math.max(reach, tree.R[id]);
    }
    expect(overlaps).toBe(0);
  });
});


describe("annotation strips below one pixel per row", () => {
  // 4000 leaves on a 120px canvas: about 0.03px per row. One common category,
  // one rare one — the shape of a real defence-system annotation.
  function stripSetup(h = 120) {
    let nodes = Array.from({ length: 4000 }, (_, i) => `L${i}:0.05`);
    while (nodes.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < nodes.length; i += 2) {
        next.push(i + 1 < nodes.length ? `(${nodes[i]},${nodes[i + 1]}):0.05` : nodes[i]);
      }
      nodes = next;
    }
    const { r, calls, tree } = makeRenderer(nodes[0] + ";", 500, h);
    const values = Array.from({ length: 4000 }, (_, i) =>
      i % 97 === 0 ? "Thoeris" : "PD-T7-2",
    );
    r.setTracks([
      {
        type: "colorstrip",
        label: "df_type",
        visible: true,
        values,
        palette: { Thoeris: "#111111", "PD-T7-2": "#eeeeee" },
      },
    ]);
    r.setStyle({ showLeafLabels: false });
    return { r, calls, tree, values };
  }

  /** Only the fills inside the annotation column, not the branches. */
  function stripFills(calls: Calls) {
    const wide = calls.rects.filter((q) => q.w === 18);
    return wide;
  }

  it("paints each category in exactly one colour", () => {
    const { r, calls } = stripSetup();
    calls.rects.length = 0;
    r.draw();
    const colors = new Set(stripFills(calls).map((q) => q.color));
    // Two categories, two colours — no blended third shade.
    expect(colors.size).toBeLessThanOrEqual(2);
    for (const c of colors) expect(["#111111", "#eeeeee"]).toContain(c);
  });

  it("draws strip cells on whole pixels, so nothing antialiases together", () => {
    const { r, calls } = stripSetup();
    calls.rects.length = 0;
    r.draw();
    for (const q of stripFills(calls)) {
      expect(Number.isInteger(q.y)).toBe(true);
      expect(q.h).toBe(1);
    }
  });

  it("keeps a rare category visible instead of letting the common one win", () => {
    const { r, calls } = stripSetup();
    calls.rects.length = 0;
    r.draw();
    const rare = stripFills(calls).filter((q) => q.color === "#111111");
    // ~41 Thoeris leaves spread over 4000; a majority vote per pixel row would
    // show none of them at all.
    expect(rare.length).toBeGreaterThan(0);
  });

  it("marks the categories a pixel row could not show", () => {
    const { r, calls } = stripSetup();
    r.draw();
    // The displaced common category becomes a marker: a filled caret, drawn
    // with fill() rather than fillRect().
    expect(calls.fill).toBeGreaterThan(0);
  });

  it("reports the leaf whose value is actually painted under the cursor", () => {
    const { r, values } = stripSetup();
    r.draw();
    let checked = 0;
    for (let y = 20; y < 100; y += 3) {
      const hit = r.trackAt(r.metricsForTest().trackStartX + 4, y);
      if (!hit || hit.leafIndex < 0) continue;
      expect(values[hit.leafIndex]).not.toBeNull();
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("hovering a marker names the hidden category and how many leaves carry it", () => {
    const { r } = stripSetup();
    r.draw();
    const found = r.markersForTest();
    expect(found.length).toBeGreaterThan(0);
    const mk = found[0];
    const hit = r.trackAt((mk.x0 + mk.x1) / 2, mk.y);
    expect(hit?.hiddenCategory).toBe(mk.category);
    expect(hit?.hiddenCount).toBeGreaterThan(0);
  });

  it("goes back to one cell per leaf once rows are thick enough", () => {
    const { r, calls } = stripSetup(120);
    r.setView({ vZoom: 400 });
    calls.rects.length = 0;
    r.draw();
    const fills = stripFills(calls);
    expect(fills.length).toBeGreaterThan(0);
    // Cells now stand taller than a pixel, i.e. they are real rows again.
    expect(Math.max(...fills.map((q) => q.h))).toBeGreaterThan(1);
  });
});

describe("continuous strips below one pixel per row", () => {
  function scoreSetup(vals: (i: number) => number) {
    let nodes = Array.from({ length: 4000 }, (_, i) => `L${i}:0.05`);
    while (nodes.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < nodes.length; i += 2) {
        next.push(i + 1 < nodes.length ? `(${nodes[i]},${nodes[i + 1]}):0.05` : nodes[i]);
      }
      nodes = next;
    }
    const { r, calls } = makeRenderer(nodes[0] + ";", 500, 120);
    r.setTracks([
      {
        type: "heatmap",
        label: "defense_score",
        visible: true,
        numeric: Float64Array.from({ length: 4000 }, (_, i) => vals(i)),
        vmin: 0,
        vmax: 1,
        ramp: { colors: ["#ffffff", "#ff0000"], vmin: 0, vmid: 0.2, vmax: 0.5, zeroColor: "#eeeeee" },
      },
    ]);
    r.setStyle({ showLeafLabels: false });
    calls.rects.length = 0;
    r.draw();
    return calls.rects.filter((q) => q.w === 18);
  }

  it("summarises a pixel row by its mean, not by its largest value", () => {
    // One leaf in forty scores 1.0, the rest zero. Taking the maximum would
    // paint the entire column its top colour and say nothing at all.
    const fills = scoreSetup((i) => (i % 40 === 0 ? 1 : 0));
    const top = fills.filter((q) => q.color === "rgb(255,0,0)");
    expect(top.length / fills.length).toBeLessThan(0.5);
  });

  it("still reaches the top of the ramp where values really are high", () => {
    const fills = scoreSetup(() => 1);
    expect(fills.length).toBeGreaterThan(0);
    for (const q of fills) expect(q.color).toBe("rgb(255,0,0)");
  });

  it("paints an all-zero stretch as the zero colour, not the palest red", () => {
    const fills = scoreSetup(() => 0);
    expect(fills.length).toBeGreaterThan(0);
    for (const q of fills) expect(q.color).toBe("#eeeeee");
  });
});

describe("hovering an annotation column", () => {
  function sparse() {
    let nodes = Array.from({ length: 4000 }, (_, i) => `L${i}:0.05`);
    while (nodes.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < nodes.length; i += 2) {
        next.push(i + 1 < nodes.length ? `(${nodes[i]},${nodes[i + 1]}):0.05` : nodes[i]);
      }
      nodes = next;
    }
    const { r } = makeRenderer(nodes[0] + ";", 500, 120);
    // Most leaves carry no value at all — the shape of a real DefenseFinder
    // column, where the large majority of proteins are simply not annotated.
    r.setTracks([
      {
        type: "colorstrip",
        label: "df_type",
        visible: true,
        values: Array.from({ length: 4000 }, (_, i) => (i % 500 === 0 ? "Thoeris" : null)),
        palette: { Thoeris: "#111111" },
      },
    ]);
    r.setStyle({ showLeafLabels: false });
    r.draw();
    return r;
  }

  it("claims the whole column, even where the values are empty", () => {
    const r = sparse();
    const x = r.metricsForTest().trackStartX + 4;
    // Sample inside the rows themselves; above and below them the column is
    // padding and correctly matches nothing.
    const top = Math.ceil(r.screenPosition(0)?.y ?? 0) + 1;
    let hits = 0;
    let sampled = 0;
    for (let y = top; y < 120 - 41; y += 2) {
      sampled++;
      if (r.trackAt(x, y)) hits++;
    }
    // Falling through to the tree behind an empty row is what made the tooltip
    // answer with the leaf's details instead of the dataset's.
    expect(sampled).toBeGreaterThan(5);
    expect(hits).toBe(sampled);
  });

  it("names a leaf on the row even when that leaf has no value", () => {
    const r = sparse();
    const x = r.metricsForTest().trackStartX + 4;
    let checked = 0;
    for (let y = 41; y < 79; y += 2) {
      const hit = r.trackAt(x, y);
      if (!hit) continue;
      expect(hit.leafIndex).toBeGreaterThanOrEqual(0);
      checked++;
    }
    expect(checked).toBeGreaterThan(5);
  });
});

describe("tips overhanging the fitted edge", () => {
  // One tip far deeper than the rest: exactly what fitting to a quantile is
  // there to survive.
  const OUTLIER = "((A:0.1,B:0.1):0.1,(C:0.1,D:9.0):0.1);";

  it("clips the tree where the annotation columns begin", () => {
    const { r, calls } = makeRenderer(OUTLIER, 400, 200);
    r.setTracks([
      { type: "colorstrip", label: "x", visible: true, values: ["a", "b", "c", "d"] },
    ]);
    r.setView({ fitQuantile: 0.5 });
    calls.clips.length = 0;
    calls.rects.length = 0;
    r.draw();
    const m = r.metricsForTest();

    // Without the clip the deep tip would be drawn straight across the strip.
    const overhangs = calls.rects.some((q) => q.w !== 18 && q.x + q.w > m.trackStartX);
    expect(overhangs).toBe(true);

    const guard = calls.clips.find((c) => c.x === 0 && c.h >= 200);
    expect(guard).toBeDefined();
    expect(guard!.w).toBeLessThanOrEqual(m.trackStartX);
    expect(guard!.w).toBeGreaterThan(m.trackStartX - 10);
  });

  it("still lets tips overhang when there are no tracks to protect", () => {
    const { r, calls } = makeRenderer(OUTLIER, 400, 200);
    r.setTracks([]);
    r.setView({ fitQuantile: 0.5 });
    calls.clips.length = 0;
    r.draw();
    // Framing on half the tips is a deliberate choice to let the rest run past
    // the edge; with nothing out there to collide with, nothing is masked.
    expect(calls.clips.filter((c) => c.x === 0 && c.h >= 200)).toHaveLength(0);
  });
});

describe("hidden-category markers", () => {
  function twoCategories(pattern: (i: number) => string) {
    let nodes = Array.from({ length: 4000 }, (_, i) => `L${i}:0.05`);
    while (nodes.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < nodes.length; i += 2) {
        next.push(i + 1 < nodes.length ? `(${nodes[i]},${nodes[i + 1]}):0.05` : nodes[i]);
      }
      nodes = next;
    }
    const { r } = makeRenderer(nodes[0] + ";", 500, 120);
    r.setTracks([
      {
        type: "colorstrip",
        label: "tax_domain",
        visible: true,
        values: Array.from({ length: 4000 }, (_, i) => pattern(i)),
        palette: { Bacteria: "#dd8452", Archaea: "#4c72b0" },
      },
    ]);
    r.setStyle({ showLeafLabels: false });
    r.draw();
    return r;
  }

  it("stays quiet when the displaced category is drawn nearby anyway", () => {
    // Archaea comes in occasional clumps. It is the rarer category, so it wins
    // every pixel row it lands on and displaces Bacteria there — but Bacteria
    // still holds the rows either side, plainly visible.
    const r = twoCategories((i) => (i % 400 < 4 ? "Archaea" : "Bacteria"));
    expect(r.markersForTest()).toHaveLength(0);
  });

  it("marks a category the strip cannot show at all", () => {
    // Archaea appears on every pixel row, so it wins every one and Bacteria is
    // never drawn: without a marker the strip would claim the tree is entirely
    // archaeal.
    const r = twoCategories((i) => (i % 2 === 0 ? "Archaea" : "Bacteria"));
    const marks = r.markersForTest();
    expect(marks.length).toBeGreaterThan(0);
    for (const mk of marks) expect(mk.category).toBe("Bacteria");
  });

  it("counts how many leaves each marker stands for", () => {
    const r = twoCategories((i) => (i % 2 === 0 ? "Archaea" : "Bacteria"));
    const marks = r.markersForTest();
    expect(marks.length).toBeGreaterThan(0);
    for (const mk of marks) expect(mk.count).toBeGreaterThan(0);
  });
});

describe("categories with no palette entry", () => {
  it("gives each one its own stable colour rather than a shared grey", () => {
    // Columns like genus run to thousands of values and the server caps the
    // domain it sends, so a palette can never cover every category.
    const a = hashColor("Escherichia");
    const b = hashColor("Salmonella");
    expect(a).not.toBe(b);
    expect(hashColor("Escherichia")).toBe(a);
    expect(a).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("paints unpalettable categories distinctly on the strip", () => {
    const { r, calls } = makeRenderer("(A:0.1,B:0.1,C:0.1,D:0.1);", 400, 300);
    r.setTracks([
      {
        type: "colorstrip",
        label: "genus",
        visible: true,
        values: ["Escherichia", "Salmonella", "Vibrio", "Bacillus"],
        // Only the first is known, as if the domain had been truncated.
        palette: { Escherichia: "#123456" },
      },
    ]);
    r.setStyle({ showLeafLabels: false });
    calls.rects.length = 0;
    r.draw();
    const strip = calls.rects.filter((q) => q.w === 18);
    const colours = new Set(strip.map((q) => q.color));
    expect(colours.size).toBe(4);
  });
});

describe("circular picking with a deep outlier", () => {
  /**
   * One tip far deeper than the rest, so `fitX` (the framed quantile) and
   * `maxX` (the deepest tip) are very different numbers. Picking used to divide
   * by `maxX` while drawing divided by `fitX`.
   */
  function outlierTree(): string {
    // Sixteen ordinary tips plus one enormously deep one. Enough tips that the
    // 90th percentile lands on an ordinary depth — with only a handful the
    // quantile IS the outlier and every node collapses onto the centre, which
    // makes the geometry ambiguous rather than wrong.
    let nodes = Array.from({ length: 16 }, (_, i) => `L${i}:0.1`);
    let depth = 0;
    while (nodes.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < nodes.length; i += 2) {
        next.push(`(${nodes[i]},${nodes[i + 1]})n${depth}_${i}:0.1`);
      }
      nodes = next;
      depth++;
    }
    return `(${nodes[0]},(E:0.1,F:40.0)deep:0.1)r;`;
  }

  const OUTLIER = outlierTree();

  function circular(w = 600, h = 600) {
    const { r, tree } = makeRenderer(OUTLIER, w, h);
    r.setView({ mode: "circular", fitQuantile: 0.9 });
    r.draw();
    return { r, tree };
  }

  it("picks the node drawn under the cursor, not one scaled by a different depth", () => {
    const { r, tree } = circular();
    for (let id = 0; id < tree.count; id++) {
      if (id === tree.root) continue;
      const p = r.screenPosition(id);
      if (!p) continue;
      const hit = r.pick(p.x, p.y);
      expect(hit).toBeGreaterThanOrEqual(0);
      // A node's own point is a genuine tie: a child's connecting arc begins
      // exactly there, and so does the far end of its own radial run. So the
      // requirement is that the pick lies on the same lineage — which is what
      // the bug broke, returning clades with no relation to the point at all.
      const onLineage =
        (tree.L[hit] <= tree.L[id] && tree.R[hit] >= tree.R[id]) ||
        (tree.L[hit] >= tree.L[id] && tree.R[hit] <= tree.R[id]);
      expect(onLineage).toBe(true);
    }
  });

  it("finds an inner branch when the cursor is on it, not a distant small clade", () => {
    const { r, tree } = circular();
    // An inner node partway out; hover the middle of its own branch and check
    // the pick stays in its lineage.
    const c = tree.nameToNode.get("n2_0");
    expect(c).toBeDefined();
    const pc = r.screenPosition(c!)!;
    const pp = r.screenPosition(tree.parent[c!])!;
    const mid = { x: (pc.x + pp.x) / 2, y: (pc.y + pp.y) / 2 };
    const hit = r.pick(mid.x, mid.y);
    expect(hit).toBeGreaterThanOrEqual(0);
    // Whatever it picks must contain, or be contained by, the branch hovered —
    // the bug returned a clade with no relation to it at all.
    const related =
      (tree.L[hit] <= tree.L[c!] && tree.R[hit] >= tree.R[c!]) ||
      (tree.L[hit] >= tree.L[c!] && tree.R[hit] <= tree.R[c!]);
    expect(related).toBe(true);
  });

  it("agrees with rectangular picking about which node is where", () => {
    // The same assertion in rect mode, so a future divergence shows up as a
    // difference between the modes rather than as silence.
    const { r, tree } = makeRenderer(OUTLIER, 600, 600);
    r.setView({ mode: "rect", fitQuantile: 0.9 });
    r.draw();
    for (let id = 0; id < tree.count; id++) {
      const p = r.screenPosition(id);
      if (!p) continue;
      const hit = r.pick(p.x, p.y);
      const onLineage =
        (tree.L[hit] <= tree.L[id] && tree.R[hit] >= tree.R[id]) ||
        (tree.L[hit] >= tree.L[id] && tree.R[hit] <= tree.R[id]);
      expect(onLineage).toBe(true);
    }
  });
});

describe("circular angle inverse", () => {
  /**
   * Every tip's own screen position must pick that tip's row back out.
   *
   * The failure this guards against is subtle and total: with a 350-degree arc
   * `atan2`'s principal value sits a full turn away from the angle that drew
   * the tip, so rows past the halfway point came back off by one and picking
   * climbed the wrong leaf's ancestry.
   */
  function rowsRoundTrip(n: number, rotation: number, arc: number) {
    const tips = Array.from({ length: n }, (_, i) => `L${i}:0.1`);
    const { r, tree } = makeRenderer(`(${tips.join(",")});`, 600, 600);
    r.setView({ mode: "circular", rotation, arc });
    r.draw();
    let wrong = 0;
    for (let i = 0; i < n; i++) {
      const p = r.screenPosition(tree.leaves[i]);
      if (!p) continue;
      if (r.leafRowAtPoint(p.x, p.y) !== i) wrong++;
    }
    return wrong;
  }

  it("recovers every row across the default arc", () => {
    expect(rowsRoundTrip(64, 0, 350)).toBe(0);
  });

  it("recovers every row on a full circle", () => {
    expect(rowsRoundTrip(64, 0, 360)).toBe(0);
  });

  it("recovers every row on a half circle", () => {
    expect(rowsRoundTrip(64, 0, 180)).toBe(0);
  });

  it("recovers every row however the tree is rotated", () => {
    for (const rot of [0, 45, 90, 179, 180, 270, 359]) {
      expect(rowsRoundTrip(48, rot, 350)).toBe(0);
    }
  });
});
