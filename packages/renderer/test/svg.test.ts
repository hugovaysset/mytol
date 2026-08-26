/**
 * The SVG recorder.
 *
 * These check the two things that would silently produce a wrong figure rather
 * than an obviously broken one: geometry baked through the wrong transform, and
 * a clip that never closes. A picture that is subtly displaced looks fine until
 * someone measures it.
 */

import { describe, it, expect } from "vitest";
import { SvgContext, fontSize, fontFamily } from "../src/svg";

/** Every number in an attribute, in document order. */
function nums(svg: string, attr: string): number[] {
  const out: number[] = [];
  const rx = new RegExp(`${attr}="([-0-9.]+)"`, "g");
  let m: RegExpExecArray | null;
  while ((m = rx.exec(svg))) out.push(parseFloat(m[1]));
  return out;
}

describe("SvgContext", () => {
  it("bakes the current transform into a rect rather than emitting one", () => {
    const c = new SvgContext(100, 100);
    c.translate(10, 20);
    c.scale(2, 2);
    c.fillStyle = "#ff0000";
    c.fillRect(1, 1, 3, 4);
    const svg = c.toSVG();
    // Translation then a 2x scale: the rect lands at (12, 22) and is 6 x 8.
    expect(nums(svg, "x")).toEqual([12]);
    expect(nums(svg, "y")).toEqual([22]);
    expect(nums(svg, "width")).toContain(6);
    expect(nums(svg, "height")).toContain(8);
    expect(svg).not.toContain("transform=");
  });

  it("restores the transform, so a save/restore pair leaves no drift", () => {
    const c = new SvgContext(100, 100);
    c.save();
    c.translate(50, 50);
    c.fillRect(0, 0, 1, 1);
    c.restore();
    c.fillRect(0, 0, 1, 1);
    const xs = nums(c.toSVG(), "x");
    expect(xs).toEqual([50, 0]);
  });

  it("closes a clip group at the matching restore, not at the end", () => {
    const c = new SvgContext(100, 100);
    c.save();
    c.beginPath();
    c.rect(0, 0, 10, 10);
    c.clip();
    c.fillRect(1, 1, 1, 1);   // inside the clip
    c.restore();
    c.fillRect(5, 5, 1, 1);   // outside it
    const svg = c.toSVG();
    const open = svg.indexOf("<g clip-path");
    const close = svg.indexOf("</g>");
    const inside = svg.indexOf(`x="1"`);
    const outside = svg.indexOf(`x="5"`);
    expect(open).toBeGreaterThan(-1);
    expect(inside).toBeGreaterThan(open);
    expect(inside).toBeLessThan(close);
    expect(outside).toBeGreaterThan(close);
  });

  it("closes an unbalanced clip rather than emitting malformed XML", () => {
    const c = new SvgContext(50, 50);
    c.beginPath();
    c.rect(0, 0, 10, 10);
    c.clip();          // never restored
    const svg = c.toSVG();
    const opens = (svg.match(/<g /g) ?? []).length;
    const closes = (svg.match(/<\/g>/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  it("emits a whole-turn arc as a circle, not a polyline", () => {
    const c = new SvgContext(100, 100);
    c.beginPath();
    c.arc(30, 40, 5, 0, Math.PI * 2);
    c.fill();
    const svg = c.toSVG();
    expect(svg).toContain(`<circle cx="30" cy="40" r="5"`);
    expect(svg).not.toContain("<path");
  });

  it("scales a circle's radius by the transform", () => {
    const c = new SvgContext(100, 100);
    c.scale(3, 3);
    c.beginPath();
    c.arc(10, 10, 2, 0, Math.PI * 2);
    c.fill();
    expect(c.toSVG()).toContain(`<circle cx="30" cy="30" r="6"`);
  });

  it("falls back to a polyline when the transform is not a similarity", () => {
    // A non-uniform scale turns a circle into an ellipse, which the arc form
    // cannot express with one radius.
    const c = new SvgContext(100, 100);
    c.scale(3, 1);
    c.beginPath();
    c.arc(10, 10, 2, 0, Math.PI);
    c.stroke();
    const svg = c.toSVG();
    expect(svg).toContain("<path");
    expect(svg).not.toContain("<circle");
  });

  it("scales stroke width and dash by the transform", () => {
    const c = new SvgContext(100, 100);
    c.scale(4, 4);
    c.lineWidth = 0.5;
    c.setLineDash([3, 2]);
    c.strokeRect(0, 0, 5, 5);
    const svg = c.toSVG();
    expect(svg).toContain(`stroke-width="2"`);
    expect(svg).toContain(`stroke-dasharray="12 8"`);
  });

  it("keeps text as text, folding a uniform scale into the font size", () => {
    const c = new SvgContext(100, 100);
    c.font = "12px monospace";
    c.textAlign = "center";
    c.scale(2, 2);
    c.fillText("SIR2", 10, 20);
    const svg = c.toSVG();
    expect(svg).toContain(">SIR2</text>");
    expect(svg).toContain(`font-size="24"`);
    expect(svg).toContain(`text-anchor="middle"`);
    expect(svg).toContain(`x="20"`);
  });

  it("gives rotated text a matrix, since folding it would lose the angle", () => {
    const c = new SvgContext(100, 100);
    c.rotate(Math.PI / 4);
    c.fillText("tip", 5, 5);
    expect(c.toSVG()).toContain("<text transform=\"matrix(");
  });

  it("escapes markup in a label rather than emitting it", () => {
    const c = new SvgContext(100, 100);
    c.fillText('a<b & "c"', 0, 0);
    const svg = c.toSVG();
    expect(svg).toContain("a&lt;b &amp; &quot;c&quot;");
    expect(svg).not.toContain('a<b');
  });

  it("reads the size and family out of a CSS font shorthand", () => {
    expect(fontSize("bold 13.5px Inter, sans-serif")).toBe(13.5);
    expect(fontFamily("bold 13.5px Inter, sans-serif")).toBe("Inter, sans-serif");
    // Canvas's own default when the shorthand carries no px size.
    expect(fontSize("monospace")).toBe(10);
    expect(fontFamily("monospace")).toBe("sans-serif");
  });
});
