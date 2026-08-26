/**
 * A 2D context that writes SVG instead of pixels.
 *
 * The renderer draws through one `CanvasRenderingContext2D`. Rather than write
 * a second, vector-shaped drawing routine that would drift from the first, this
 * stands in for the context and records what it is asked to draw. The picture
 * is then the same picture by construction — anything the canvas gains, the SVG
 * gains with it.
 *
 * Two simplifications, both deliberate:
 *
 * - **Coordinates are baked.** Every point is pushed through the current
 *   transform as it is recorded, so the output carries no nested `transform`
 *   attributes and can be opened, edited and re-saved by an illustration tool
 *   without the geometry moving. Text is the exception: a rotated label needs a
 *   matrix, and it gets one.
 * - **Arcs stay arcs while the matrix is a similarity** — a rotation, a uniform
 *   scale, a reflection — because that is the only case the renderer ever
 *   produces, and it maps a circle to a circle. A full turn becomes a
 *   `<circle>`; anything less becomes an `A` command. Under a matrix that
 *   genuinely skews, the arc falls back to a polyline stepped so the chord
 *   never departs from the true curve by more than a quarter pixel: an
 *   elliptical arc with a rotated axis is not worth the error surface for a
 *   case nothing here reaches.
 *
 * Only the members the renderer actually uses are implemented. A missing one
 * should fail loudly at the type level rather than silently draw nothing, which
 * is why this declares the subset rather than claiming to be the whole
 * interface.
 */

/** The context members the tree renderer draws through. */
export interface DrawTarget {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  globalAlpha: number;
  lineDashOffset?: number;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(a: number): void;
  scale(x: number, y: number): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw?: boolean): void;
  fill(): void;
  stroke(): void;
  clip(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  setLineDash(segments: number[]): void;
}

type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function mul(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/** How much the matrix scales lengths — used for stroke width and font size. */
function meanScale(m: Matrix): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
}

/** True when the matrix only translates and scales, so a rect stays a rect. */
function axisAligned(m: Matrix): boolean {
  return Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Three decimals is a tenth of a pixel at any zoom anyone exports at. */
function n(v: number): string {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? "0" : String(r);
}

interface State {
  m: Matrix;
  fill: string;
  stroke: string;
  lineWidth: number;
  font: string;
  align: CanvasTextAlign;
  baseline: CanvasTextBaseline;
  alpha: number;
  dash: number[];
  /** Groups opened since the matching save(), closed by restore(). */
  opened: number;
}

type Seg =
  | { t: "M"; x: number; y: number }
  | { t: "L"; x: number; y: number }
  | { t: "A"; x: number; y: number; r: number; a0: number; a1: number }
  | { t: "Z" };

/**
 * True when the matrix maps circles to circles: the two basis vectors are the
 * same length and at right angles. Rotation, uniform scale and reflection all
 * qualify; a non-uniform scale or a skew does not.
 */
function similarity(m: Matrix): boolean {
  const l1 = m[0] * m[0] + m[1] * m[1];
  const l2 = m[2] * m[2] + m[3] * m[3];
  const dot = m[0] * m[2] + m[1] * m[3];
  return Math.abs(l1 - l2) <= 1e-9 * (l1 + l2 + 1) && Math.abs(dot) <= 1e-9 * (l1 + l2 + 1);
}

const ANCHOR: Record<string, string> = {
  left: "start", start: "start", center: "middle",
  right: "end", end: "end",
};

/** Canvas baselines that SVG's `dominant-baseline` can express directly. */
const BASELINE: Record<string, string> = {
  alphabetic: "", top: "text-before-edge", hanging: "hanging",
  middle: "central", bottom: "text-after-edge", ideographic: "text-after-edge",
};

export class SvgContext implements DrawTarget {
  private body: string[] = [];
  private defs: string[] = [];
  private stack: State[] = [];
  private st: State;
  private path: Seg[] = [];
  private clipId = 0;

  constructor(
    readonly width: number,
    readonly height: number,
    private background = "#ffffff",
  ) {
    this.st = {
      m: [...IDENTITY] as Matrix,
      fill: "#000000", stroke: "#000000", lineWidth: 1,
      font: "10px sans-serif", align: "start", baseline: "alphabetic",
      alpha: 1, dash: [], opened: 0,
    };
  }

  // -- the properties the renderer sets --------------------------------------

  get fillStyle(): string { return this.st.fill; }
  set fillStyle(v: string | CanvasGradient | CanvasPattern) {
    if (typeof v === "string") this.st.fill = v;
  }
  get strokeStyle(): string { return this.st.stroke; }
  set strokeStyle(v: string | CanvasGradient | CanvasPattern) {
    if (typeof v === "string") this.st.stroke = v;
  }
  get lineWidth(): number { return this.st.lineWidth; }
  set lineWidth(v: number) { this.st.lineWidth = v; }
  get font(): string { return this.st.font; }
  set font(v: string) { this.st.font = v; }
  get textAlign(): CanvasTextAlign { return this.st.align; }
  set textAlign(v: CanvasTextAlign) { this.st.align = v; }
  get textBaseline(): CanvasTextBaseline { return this.st.baseline; }
  set textBaseline(v: CanvasTextBaseline) { this.st.baseline = v; }
  get globalAlpha(): number { return this.st.alpha; }
  set globalAlpha(v: number) { this.st.alpha = v; }
  lineDashOffset = 0;
  setLineDash(segments: number[]): void { this.st.dash = segments.slice(); }
  getLineDash(): number[] { return this.st.dash.slice(); }

  // -- state -----------------------------------------------------------------

  save(): void {
    this.stack.push(this.st);
    this.st = { ...this.st, m: [...this.st.m] as Matrix, opened: 0 };
  }

  restore(): void {
    for (let i = 0; i < this.st.opened; i++) this.body.push("</g>");
    const prev = this.stack.pop();
    if (prev) this.st = prev;
  }

  translate(x: number, y: number): void {
    this.st.m = mul(this.st.m, [1, 0, 0, 1, x, y]);
  }
  rotate(a: number): void {
    const c = Math.cos(a), s = Math.sin(a);
    this.st.m = mul(this.st.m, [c, s, -s, c, 0, 0]);
  }
  scale(x: number, y: number): void {
    this.st.m = mul(this.st.m, [x, 0, 0, y, 0, 0]);
  }
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.st.m = [a, b, c, d, e, f];
  }

  // -- paths -----------------------------------------------------------------

  beginPath(): void { this.path = []; }
  closePath(): void { this.path.push({ t: "Z" }); }
  moveTo(x: number, y: number): void { this.path.push({ t: "M", x, y }); }
  lineTo(x: number, y: number): void { this.path.push({ t: "L", x, y }); }

  rect(x: number, y: number, w: number, h: number): void {
    this.path.push({ t: "M", x, y }, { t: "L", x: x + w, y },
                   { t: "L", x: x + w, y: y + h }, { t: "L", x, y: y + h },
                   { t: "Z" });
  }

  arc(x: number, y: number, r: number, a0: number, a1: number, ccw = false): void {
    let sweep = a1 - a0;
    if (!ccw && sweep < 0) sweep += Math.PI * 2 * Math.ceil(-sweep / (Math.PI * 2));
    if (ccw && sweep > 0) sweep -= Math.PI * 2 * Math.ceil(sweep / (Math.PI * 2));
    if (similarity(this.st.m)) {
      this.path.push({ t: "A", x, y, r, a0, a1: a0 + sweep });
      return;
    }
    // Chord error for a step t is r(1 - cos(t/2)); solve for a quarter pixel in
    // device space, then clamp so a huge radius cannot ask for a million points.
    const rDev = Math.max(r * meanScale(this.st.m), 1e-6);
    const step = Math.min(Math.PI / 8, 2 * Math.acos(Math.max(0, 1 - 0.25 / rDev)) || Math.PI / 8);
    const steps = Math.min(4096, Math.max(2, Math.ceil(Math.abs(sweep) / step)));
    for (let i = 0; i <= steps; i++) {
      const a = a0 + (sweep * i) / steps;
      const px = x + r * Math.cos(a);
      const py = y + r * Math.sin(a);
      // An arc after a moveTo continues the subpath, exactly as canvas does.
      this.path.push({ t: i === 0 && this.path.length === 0 ? "M" : "L", x: px, y: py });
    }
  }

  /** A whole-turn arc on its own — by far the commonest, a plotted point. */
  private soleCircle(): { cx: number; cy: number; r: number } | null {
    if (this.path.length !== 1) return null;
    const s = this.path[0];
    if (s.t !== "A" || Math.abs(s.a1 - s.a0) < Math.PI * 2 - 1e-9) return null;
    const m = this.st.m;
    return {
      cx: m[0] * s.x + m[2] * s.y + m[4],
      cy: m[1] * s.x + m[3] * s.y + m[5],
      r: s.r * meanScale(m),
    };
  }

  private d(): string {
    const m = this.st.m;
    const scale = meanScale(m);
    // A reflection turns a canvas arc's direction round on screen, so the
    // sweep flag has to follow the determinant as well as the angle.
    const flip = m[0] * m[3] - m[1] * m[2] < 0;
    const at = (px: number, py: number) =>
      `${n(m[0] * px + m[2] * py + m[4])} ${n(m[1] * px + m[3] * py + m[5])}`;
    const out: string[] = [];
    let started = false;
    for (const s of this.path) {
      if (s.t === "Z") { out.push("Z"); continue; }
      if (s.t !== "A") {
        out.push(`${s.t}${at(s.x, s.y)}`);
        started = true;
        continue;
      }
      const r = s.r * scale;
      const pt = (a: number) => at(s.x + s.r * Math.cos(a), s.y + s.r * Math.sin(a));
      out.push(`${started ? "L" : "M"}${pt(s.a0)}`);
      started = true;
      const sweep = s.a1 - s.a0;
      const flag = (sweep > 0) !== flip ? 1 : 0;
      // SVG cannot express a full turn in one arc — the endpoints coincide and
      // the command degenerates to nothing — so it goes as two halves.
      const cuts = Math.abs(sweep) >= Math.PI * 2 - 1e-9 ? 2 : 1;
      for (let k = 1; k <= cuts; k++) {
        const a = s.a0 + (sweep * k) / cuts;
        const large = Math.abs(sweep / cuts) > Math.PI ? 1 : 0;
        out.push(`A${n(r)} ${n(r)} 0 ${large} ${flag} ${pt(a)}`);
      }
    }
    return out.join(" ");
  }

  fill(): void {
    if (!this.path.length) return;
    const c = this.soleCircle();
    if (c) {
      this.body.push(
        `<circle cx="${n(c.cx)}" cy="${n(c.cy)}" r="${n(c.r)}" ` +
        `fill="${esc(this.st.fill)}"${this.alphaAttr("fill")}/>`);
      return;
    }
    this.body.push(
      `<path d="${this.d()}" fill="${esc(this.st.fill)}"${this.alphaAttr("fill")}/>`);
  }

  stroke(): void {
    if (!this.path.length) return;
    const c = this.soleCircle();
    if (c) {
      this.body.push(
        `<circle cx="${n(c.cx)}" cy="${n(c.cy)}" r="${n(c.r)}" fill="none" ` +
        `${this.strokeAttrs()}/>`);
      return;
    }
    this.body.push(`<path d="${this.d()}" fill="none" ${this.strokeAttrs()}/>`);
  }

  /** Stroke colour, width and dash, all in device units. */
  private strokeAttrs(): string {
    const s = meanScale(this.st.m);
    const dash = this.st.dash.length
      ? ` stroke-dasharray="${this.st.dash.map((v) => n(v * s)).join(" ")}"`
      : "";
    return (
      `stroke="${esc(this.st.stroke)}" stroke-width="${n(this.st.lineWidth * s)}"` +
      dash + this.alphaAttr("stroke")
    );
  }

  strokeRect(x: number, y: number, w: number, h: number): void {
    const saved = this.path;
    this.path = [];
    this.rect(x, y, w, h);
    this.body.push(`<path d="${this.d()}" fill="none" ${this.strokeAttrs()}/>`);
    this.path = saved;
  }

  clip(): void {
    if (!this.path.length) return;
    const id = `mtclip${++this.clipId}`;
    this.defs.push(`<clipPath id="${id}"><path d="${this.d()}"/></clipPath>`);
    this.body.push(`<g clip-path="url(#${id})">`);
    this.st.opened++;
  }

  // -- the shorthands --------------------------------------------------------

  fillRect(x: number, y: number, w: number, h: number): void {
    if (w === 0 || h === 0) return;
    const m = this.st.m;
    if (axisAligned(m)) {
      const x0 = m[0] * x + m[4];
      const y0 = m[3] * y + m[5];
      const w0 = m[0] * w;
      const h0 = m[3] * h;
      this.body.push(
        `<rect x="${n(Math.min(x0, x0 + w0))}" y="${n(Math.min(y0, y0 + h0))}" ` +
        `width="${n(Math.abs(w0))}" height="${n(Math.abs(h0))}" ` +
        `fill="${esc(this.st.fill)}"${this.alphaAttr("fill")}/>`);
      return;
    }
    const saved = this.path;
    this.path = [];
    this.rect(x, y, w, h);
    this.fill();
    this.path = saved;
  }

  fillText(text: string, x: number, y: number): void {
    if (!text) return;
    const m = this.st.m;
    const size = fontSize(this.st.font);
    const anchor = ANCHOR[this.st.align] ?? "start";
    const base = BASELINE[this.st.baseline] ?? "";
    const attrs =
      `font-family="${esc(fontFamily(this.st.font))}" ` +
      `font-size="${n(size)}"` +
      (anchor === "start" ? "" : ` text-anchor="${anchor}"`) +
      (base ? ` dominant-baseline="${base}"` : "") +
      ` fill="${esc(this.st.fill)}"${this.alphaAttr("fill")}`;
    if (axisAligned(m) && Math.abs(m[0] - m[3]) < 1e-9) {
      // Translation and a uniform scale: fold both into the position and the
      // size, so the text stays plain text that an editor can retype.
      const s = m[0];
      this.body.push(
        `<text x="${n(m[0] * x + m[4])}" y="${n(m[3] * y + m[5])}" ` +
        attrs.replace(`font-size="${n(size)}"`, `font-size="${n(size * s)}"`) +
        `>${esc(text)}</text>`);
      return;
    }
    this.body.push(
      `<text transform="matrix(${m.map(n).join(" ")})" x="${n(x)}" y="${n(y)}" ` +
      attrs + `>${esc(text)}</text>`);
  }

  private alphaAttr(kind: "fill" | "stroke"): string {
    return this.st.alpha >= 1 ? "" : ` ${kind}-opacity="${n(this.st.alpha)}"`;
  }

  // -- output ----------------------------------------------------------------

  /** The finished document. Safe to call once; further drawing is undefined. */
  toSVG(): string {
    // Anything still open — an unbalanced clip — is closed here rather than
    // emitted as malformed XML that no viewer will show at all.
    let open = this.st.opened;
    for (const s of this.stack) open += s.opened;
    const tail = "</g>".repeat(open);
    const defs = this.defs.length ? `<defs>${this.defs.join("")}</defs>` : "";
    return (
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" ` +
      `width="${n(this.width)}" height="${n(this.height)}" ` +
      `viewBox="0 0 ${n(this.width)} ${n(this.height)}">` +
      defs +
      (this.background
        ? `<rect width="${n(this.width)}" height="${n(this.height)}" fill="${esc(this.background)}"/>`
        : "") +
      this.body.join("") + tail +
      `</svg>\n`
    );
  }
}

/** The px size out of a CSS font shorthand, defaulting to canvas's own 10px. */
export function fontSize(font: string): number {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  return m ? parseFloat(m[1]) : 10;
}

/** Everything after the size — the family list, with any weight dropped. */
export function fontFamily(font: string): string {
  const m = /\d+(?:\.\d+)?px\s+(.*)$/.exec(font);
  return (m ? m[1] : "sans-serif").trim() || "sans-serif";
}
