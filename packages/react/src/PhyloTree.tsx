/**
 * <PhyloTree> — the React binding.
 *
 * Presentational and controlled: it owns the canvas, the renderer and the raw
 * pointer events, and nothing else. Tree edits live in treeState.ts and the
 * selection rules in interaction.ts, so this file stays about wiring.
 *
 * mytol's equivalent was a 3694-line component taking zero props and emitting
 * no events, which is why it could not be embedded in anything.
 */

import { useCallback, useEffect, useImperativeHandle, useRef, forwardRef } from "react";
import type { Tree } from "@mytol/core";
import {
  TreeRenderer,
  ELEVATOR_RESERVE,
  type ViewState,
  type StyleTokens,
  type TrackInstance,
  type RangeInstance,
  type RangeDisplayMode,
} from "@mytol/renderer";

/** What the pointer is over: a node, or a cell in an annotation track. */
export interface HoverTarget {
  nodeId: number;
  /** Set when the pointer is over an annotation track rather than the tree. */
  track?: {
    label: string;
    type: string;
    leafIndex: number;
    value: unknown;
    /** Set when the pointer is over a marker for a category the zoom hides. */
    hiddenCategory?: string;
    hiddenCount?: number;
    /** Set over a domain-layout track: the domain under the cursor. */
    domain?: { name: string; acc?: string; start: number; end: number };
    /** Set over a neighbourhood track: the gene under the cursor. */
    gene?: LocusGene;
    /** Set in a neighbourhood track's domain mode: the domain under it. */
    geneDomain?: LocusDomain;
  };
  /** Leaf row under the pointer, when there is one. */
  leafIndex?: number;
}
import type { LocusDomain, LocusGene, TrackHover } from "@mytol/renderer";
import {
  applyClick,
  applyBoxSelect,
  applyWheelZoom,
  contextRequest,
  emptySelection,
  type SelectionState,
  type ContextMenuRequest,
} from "./interaction";

export interface PhyloTreeHandle {
  /** Node under a screen point, or -1. */
  pick(x: number, y: number): number;
  trackAt(x: number, y: number): TrackHover | null;
  screenPosition(nodeId: number): { x: number; y: number } | null;
  fit(): void;
  /** Centre the view on a leaf and zoom in enough to read it. */
  focusLeaf(leafIndex: number): void;
  /** Frame a run of leaf rows, so the whole clade fills the view. */
  focusRows(from: number, to: number): void;
  redraw(): void;
  renderer(): TreeRenderer | null;
}

export interface PhyloTreeProps {
  tree: Tree | null;
  view?: Partial<ViewState>;
  style?: Partial<StyleTokens>;
  tracks?: TrackInstance[];
  ranges?: RangeInstance[];
  rangeMode?: RangeDisplayMode;
  collapsed?: Set<number>;
  /** One byte per leaf index; 1 = passes the host's filter. */
  highlightMask?: Uint8Array;
  selection?: SelectionState;
  onSelectionChange?(next: SelectionState): void;
  onViewChange?(next: ViewState): void;
  /**
   * A shift-wheel happened; `moved` says whether it could do anything.
   *
   * Worth surfacing rather than swallowing: `vZoom` is not usually persisted,
   * so a fresh load starts with every row on screen, and the first thing a
   * user tries the shortcut on is exactly the state where it can do nothing.
   */
  onVerticalScroll?(moved: boolean): void;
  /**
   * A click that landed in an annotation column.
   *
   * Return true to claim it — the click then does not also select a leaf.
   */
  onTrackClick?(hover: TrackHover): boolean | void;
  onHoverNode?(nodeId: number): void;
  /** Richer hover, including annotation tracks. Fires on every move. */
  onHoverTarget?(target: HoverTarget | null): void;
  onContextMenu?(req: ContextMenuRequest): void;
  /**
   * Whether to call preventDefault on the context-menu event.
   *
   * Leave it on for standalone use, so the browser menu does not appear over
   * the tree. Turn it OFF when an external menu component wraps the tree:
   * a menu library needs to act on the same event, and most bail out when it
   * arrives already default-prevented.
   */
  suppressNativeContextMenu?: boolean;
  onDoubleClickNode?(nodeId: number): void;
  className?: string;
  cssStyle?: React.CSSProperties;
}

export const PhyloTree = forwardRef<PhyloTreeHandle, PhyloTreeProps>(function PhyloTree(
  props,
  ref,
) {
  const {
    tree,
    view,
    style,
    tracks,
    ranges,
    rangeMode = "background",
    collapsed,
    highlightMask,
    selection,
    onSelectionChange,
    onViewChange,
    onVerticalScroll,
    onTrackClick,
    onHoverNode,
    onHoverTarget,
    onContextMenu,
    onDoubleClickNode,
    suppressNativeContextMenu = true,
    className,
    cssStyle,
  } = props;

  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const labelsRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<TreeRenderer | null>(null);

  // Live copies for event handlers, which are registered once.
  const selRef = useRef<SelectionState>(selection ?? emptySelection());
  const treeRef = useRef<Tree | null>(tree);
  const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const boxRef = useRef<{ fromLeaf: number; toLeaf: number } | null>(null);
  /** True while a drag started inside the locator, which navigates rather than pans. */
  const mapRef = useRef(false);
  /** True while the elevator's thumb is being dragged. */
  const liftRef = useRef(false);

  selRef.current = selection ?? selRef.current;
  treeRef.current = tree;

  // -- renderer lifecycle ---------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const r = new TreeRenderer(canvas);
    rendererRef.current = r;
    r.setLabelLayer(labelsRef.current);
    return () => {
      r.setLabelLayer(null);
      r.dispose();
      rendererRef.current = null;
    };
  }, []);

  /**
   * Track the element's size.
   *
   * Without this a canvas laid out inside a hidden tab has zero dimensions when
   * it mounts and never repaints when the tab is shown — the exact failure mode
   * a dashboard with tabbed panels produces.
   */
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const r = rendererRef.current;
      if (!r) return;
      r.resize(host.clientWidth, host.clientHeight);
    });
    ro.observe(host);
    r0(); // initial size
    function r0() {
      const r = rendererRef.current;
      if (r) r.resize(host!.clientWidth, host!.clientHeight);
    }
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    rendererRef.current?.setTree(tree);
    rendererRef.current?.invalidate();
  }, [tree]);

  useEffect(() => {
    if (view) rendererRef.current?.setView(view);
  }, [view]);

  useEffect(() => {
    if (style) rendererRef.current?.setStyle(style);
  }, [style]);

  useEffect(() => {
    rendererRef.current?.setTracks(tracks ?? []);
  }, [tracks, tree]);

  useEffect(() => {
    rendererRef.current?.setRanges(ranges ?? [], rangeMode);
  }, [ranges, rangeMode]);

  useEffect(() => {
    rendererRef.current?.setCollapsed(collapsed ?? new Set());
  }, [collapsed]);

  useEffect(() => {
    rendererRef.current?.setHighlight({
      mask: highlightMask,
      selection: selection?.leaves,
      pinned: selection?.pinned ?? -1,
    });
  }, [highlightMask, selection]);

  // -- helpers --------------------------------------------------------------

  const localPoint = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const emitSelection = useCallback(
    (next: SelectionState) => {
      selRef.current = next;
      onSelectionChange?.(next);
      rendererRef.current?.setHighlight({ selection: next.leaves, pinned: next.pinned });
    },
    [onSelectionChange],
  );

  // -- pointer events -------------------------------------------------------

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const p = localPoint(e);
    const r = rendererRef.current;
    // The locator first: a press inside it means "go there", and treating it
    // as the start of a pan would drag the tree instead of jumping to it.
    if (r?.minimapHit(p.x, p.y)) {
      mapRef.current = true;
      r.minimapGoTo(p.x, p.y);
      onViewChange?.(r.getView());
      return;
    }
    if (r?.elevatorHit(p.x, p.y)) {
      liftRef.current = true;
      r.elevatorGoTo(p.y);
      onViewChange?.(r.getView());
      return;
    }
    if (e.shiftKey) {
      const leaf = r?.leafIndexAt(p.y) ?? -1;
      boxRef.current = { fromLeaf: leaf, toLeaf: leaf };
    } else {
      dragRef.current = { x: p.x, y: p.y, moved: false };
    }
  }, [onViewChange]);

  /**
   * Move and up are bound to the window, not the canvas, so a drag that leaves
   * the panel keeps working — garrigue does the same and it matters in a
   * dashboard where the panel is small.
   */
  useEffect(() => {
    function onMove(e: MouseEvent) {
      const r = rendererRef.current;
      if (!r) return;
      const p = localPoint(e);

      // Dragging inside the locator scrubs the view, which is how a map like
      // this is expected to behave and costs nothing on top of the click.
      if (mapRef.current) {
        r.minimapGoTo(p.x, p.y);
        onViewChange?.(r.getView());
        return;
      }
      if (liftRef.current) {
        r.elevatorGoTo(p.y);
        onViewChange?.(r.getView());
        return;
      }

      if (boxRef.current) {
        const leaf = r.leafIndexAt(p.y);
        if (leaf >= 0) boxRef.current.toLeaf = leaf;
        return;
      }

      const drag = dragRef.current;
      if (drag) {
        const dx = p.x - drag.x;
        const dy = p.y - drag.y;
        if (dx !== 0 || dy !== 0) drag.moved = true;
        const v = r.getView();
        r.setView({ panX: v.panX + dx, panY: v.panY + dy });
        drag.x = p.x;
        drag.y = p.y;
        onViewChange?.(r.getView());
        return;
      }

      /*
       * A pointer that is not over the canvas is not hovering the tree.
       *
       * This listener is on `window` — it has to be, so that a drag continues
       * when the pointer leaves the canvas — but the hover half of it was
       * running for every mousemove anywhere on the page. Each one called
       * `setHighlight`, which repaints unconditionally, so moving the mouse
       * over an unrelated panel repainted the whole tree. Measured on the SIR2
       * tree: forty pointer moves over the left rail cost 371,920 fill
       * operations and pushed frame times past 30 ms.
       *
       * Dragging and box-select return above this point, so they are unaffected.
       */
      const rect = canvasRef.current?.getBoundingClientRect();
      const outside =
        !rect || p.x < 0 || p.y < 0 || p.x > rect.width || p.y > rect.height;
      if (outside) {
        // Leaving the canvas has to clear the hover, or the last-hovered branch
        // stays lit while the pointer is somewhere else entirely.
        r.setHighlight({ hover: -1 });
        onHoverNode?.(-1);
        onHoverTarget?.(null);
        return;
      }

      // Tracks sit outside the tree, so they need their own hit test; a node
      // pick never reaches them.
      const overTrack = r.trackAt(p.x, p.y);
      if (overTrack) {
        r.setHighlight({ hover: -1 });
        onHoverNode?.(-1);
        onHoverTarget?.({
          nodeId: -1,
          leafIndex: overTrack.leafIndex,
          track: {
            label: overTrack.track.label,
            type: overTrack.track.type,
            leafIndex: overTrack.leafIndex,
            value:
              overTrack.leafIndex < 0
                ? null
                : (overTrack.track.values?.[overTrack.leafIndex] ??
                  overTrack.track.numeric?.[overTrack.leafIndex] ??
                  null),
            hiddenCategory: overTrack.hiddenCategory,
            hiddenCount: overTrack.hiddenCount,
            domain: overTrack.domain,
            gene: overTrack.gene,
            geneDomain: overTrack.geneDomain,
          },
        });
        return;
      }

      const hit = r.pick(p.x, p.y);
      r.setHighlight({ hover: hit });
      onHoverNode?.(hit);
      onHoverTarget?.(
        hit >= 0 ? { nodeId: hit, leafIndex: r.leafIndexAt(p.y) } : null,
      );
    }

    function onUp(e: MouseEvent) {
      const r = rendererRef.current;
      const t = treeRef.current;
      const p = localPoint(e);

      // A press that started in the locator has already done its work, and
      // must not fall through to the click handler and select a leaf.
      if (mapRef.current) {
        mapRef.current = false;
        return;
      }
      if (liftRef.current) {
        liftRef.current = false;
        r?.elevatorRelease();
        return;
      }

      if (boxRef.current && r && t) {
        const { fromLeaf, toLeaf } = boxRef.current;
        boxRef.current = null;
        if (fromLeaf >= 0 && toLeaf >= 0) {
          emitSelection(applyBoxSelect(selRef.current, fromLeaf, toLeaf, t.leaves.length));
        }
        return;
      }

      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag || drag.moved || !r || !t) return;

      // a click, not a drag.
      //
      // A click that lands in an annotation column is about that column, not
      // about the tree: selecting a leaf because someone clicked a gene arrow
      // beside it would be an answer to a question they did not ask. So the
      // track gets first refusal, and only an unclaimed click falls through to
      // picking a node.
      const overTrack = r.trackAt(p.x, p.y);
      if (overTrack && onTrackClick?.(overTrack)) return;

      const hit = r.pick(p.x, p.y);
      emitSelection(applyClick(t, selRef.current, hit, { additive: e.metaKey || e.ctrlKey }));
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [emitSelection, onHoverNode, onHoverTarget, onViewChange, onTrackClick]);

  /**
   * Wheel must be non-passive to preventDefault, so it is bound manually.
   *
   * On the HOST, not the canvas. The leaf labels are DOM spans that take
   * pointer events — that is what makes them selectable — and they are
   * siblings of the canvas, not children of it. A listener on the canvas
   * therefore never fires while the pointer is over a label, so neither zoom
   * nor shift-scroll did anything in the whole label column.
   */
  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    function onWheel(e: WheelEvent) {
      const r = rendererRef.current;
      if (!r) return;
      e.preventDefault();
      const rect = canvas!.getBoundingClientRect();
      const v = r.getView();
      /*
       * Shift scrolls instead of zooming.
       *
       * Zoom stays on the bare wheel because it is what the tree is mostly
       * driven by, and a modifier on the common gesture would be the wrong way
       * round. `deltaX` as well as `deltaY`: with shift held, some browsers
       * report a vertical wheel on the horizontal axis, and a scroll that does
       * nothing on half the mice is worse than no scroll at all.
       */
      if (e.shiftKey) {
        const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
        // Reported either way. Silence when there is nowhere to go is
        // indistinguishable from a broken shortcut — and a host that says so
        // has to be told when it starts working again, or the notice sticks.
        const moved = r.scrollByPixels(d);
        if (moved) onViewChange?.(r.getView());
        onVerticalScroll?.(moved);
        return;
      }
      const next = applyWheelZoom(
        v.mode,
        v,
        e.deltaY,
        e.clientX - rect.left,
        e.clientY - rect.top,
        { width: rect.width, height: rect.height },
      );
      r.setView(next);
      onViewChange?.(r.getView());
    }
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => host.removeEventListener("wheel", onWheel);
  }, [onViewChange, onVerticalScroll]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (suppressNativeContextMenu) e.preventDefault();
      const r = rendererRef.current;
      const t = treeRef.current;
      if (!r || !t) return;
      const p = localPoint(e);
      const hit = r.pick(p.x, p.y, 16);
      const req = contextRequest(t, hit, p.x, p.y);
      if (!req) return;
      r.setHighlight({ pinned: hit });
      emitSelection({ ...selRef.current, pinned: hit });
      onContextMenu?.(req);
    },
    [emitSelection, onContextMenu, suppressNativeContextMenu],
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const r = rendererRef.current;
      if (!r) return;
      const p = localPoint(e);
      const hit = r.pick(p.x, p.y);
      if (hit >= 0) onDoubleClickNode?.(hit);
    },
    [onDoubleClickNode],
  );

  const handleMouseLeave = useCallback(() => {
    rendererRef.current?.setHighlight({ hover: -1 });
    onHoverNode?.(-1);
    onHoverTarget?.(null);
  }, [onHoverNode, onHoverTarget]);

  // -- imperative handle ----------------------------------------------------

  useImperativeHandle(
    ref,
    (): PhyloTreeHandle => ({
      pick: (x, y) => rendererRef.current?.pick(x, y) ?? -1,
      trackAt: (x, y) => rendererRef.current?.trackAt(x, y) ?? null,
      screenPosition: (id) => rendererRef.current?.screenPosition(id) ?? null,
      fit: () => rendererRef.current?.fit(),
      focusLeaf: (leafIndex) => {
        const r = rendererRef.current;
        const t = treeRef.current;
        if (!r || !t) return;
        const v = r.getView();
        const vZoom = Math.max(v.vZoom, 8);
        r.setView({ vZoom, panY: 0 });
        const pos = r.screenPosition(t.leaves[leafIndex]);
        if (pos) {
          const host = hostRef.current;
          const h = host ? host.clientHeight : 0;
          r.setView({ panY: r.getView().panY + (h / 2 - pos.y) });
        }
        onViewChange?.(r.getView());
      },
      /**
       * Frame rows [from, to) — enough zoom for the clade to fill the pane,
       * and no more.
       *
       * Distinct from focusLeaf, which always zooms in hard because a single
       * tip is a point. A clade has an extent, and zooming past it hides the
       * very thing being pointed at.
       */
      focusRows: (from, to) => {
        const r = rendererRef.current;
        const t = treeRef.current;
        if (!r || !t) return;
        const rows = Math.max(1, to - from);
        const host = hostRef.current;
        const h = host ? host.clientHeight : 0;
        if (!h) return;
        // vZoom 1 fits every leaf in the pane, so filling it with `rows` of
        // them is that ratio — held back a little so the clade is not flush
        // against the edges, and never below 1, which would zoom OUT.
        const target = Math.max(1, (t.leaves.length / rows) * 0.85);
        r.setView({ vZoom: target, panY: 0 });
        const mid = Math.floor((from + to) / 2);
        const pos = r.screenPosition(t.leaves[Math.min(mid, t.leaves.length - 1)]);
        if (pos) r.setView({ panY: r.getView().panY + (h / 2 - pos.y) });
        onViewChange?.(r.getView());
      },
      redraw: () => rendererRef.current?.requestDraw(),
      renderer: () => rendererRef.current,
    }),
    [onViewChange],
  );

  return (
    <div
      ref={hostRef}
      className={className}
      style={{ position: "relative", width: "100%", height: "100%", ...cssStyle }}
    >
      <canvas
        ref={canvasRef}
        style={{ display: "block", width: "100%", height: "100%" }}
        onMouseDown={onMouseDown}
        onContextMenu={handleContextMenu}
        onDoubleClick={handleDoubleClick}
        onMouseLeave={handleMouseLeave}
      />
      {/* Leaf labels, as real text.
          The renderer writes into this layer instead of painting them, so an
          accession you can read is one you can select and copy. The container
          takes no pointer events — dragging anywhere but on a label still pans
          the tree — while the spans themselves do, which is what makes a
          selection possible at all. */}
      <div
        ref={labelsRef}
        className="mytol-leaf-labels"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          bottom: 0,
          // Everything but the strip the elevator owns. The spans take pointer
          // events, so a layer over the whole canvas puts a label on top of
          // the thumb and dragging it selects an accession instead of
          // scrolling — which is exactly what happened.
          right: ELEVATOR_RESERVE,
          pointerEvents: "none",
          overflow: "hidden",
        }}
      />
    </div>
  );
});
