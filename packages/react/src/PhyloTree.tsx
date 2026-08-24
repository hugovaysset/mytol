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
  };
  /** Leaf row under the pointer, when there is one. */
  leafIndex?: number;
}
import type { TrackHover } from "@mytol/renderer";
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
  const rendererRef = useRef<TreeRenderer | null>(null);

  // Live copies for event handlers, which are registered once.
  const selRef = useRef<SelectionState>(selection ?? emptySelection());
  const treeRef = useRef<Tree | null>(tree);
  const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const boxRef = useRef<{ fromLeaf: number; toLeaf: number } | null>(null);

  selRef.current = selection ?? selRef.current;
  treeRef.current = tree;

  // -- renderer lifecycle ---------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const r = new TreeRenderer(canvas);
    rendererRef.current = r;
    return () => {
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
    if (e.shiftKey) {
      const r = rendererRef.current;
      const leaf = r?.leafIndexAt(p.y) ?? -1;
      boxRef.current = { fromLeaf: leaf, toLeaf: leaf };
    } else {
      dragRef.current = { x: p.x, y: p.y, moved: false };
    }
  }, []);

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

      // a click, not a drag
      const hit = r.pick(p.x, p.y);
      emitSelection(applyClick(t, selRef.current, hit, { additive: e.metaKey || e.ctrlKey }));
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [emitSelection, onHoverNode, onHoverTarget, onViewChange]);

  /** Wheel must be non-passive to preventDefault, so it is bound manually. */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    function onWheel(e: WheelEvent) {
      const r = rendererRef.current;
      if (!r) return;
      e.preventDefault();
      const rect = canvas!.getBoundingClientRect();
      const v = r.getView();
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
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [onViewChange]);

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
    </div>
  );
});
