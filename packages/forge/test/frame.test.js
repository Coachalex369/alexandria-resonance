import test from "node:test";
import assert from "node:assert/strict";
import { FrameBuilder, hslToRgb } from "../src/frame.js";

const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);

test("hslToRgb known values", () => {
  assert.ok(near(hslToRgb(0, 100, 50), [1, 0, 0]));
  assert.ok(near(hslToRgb(120, 100, 50), [0, 1, 0]));
  assert.ok(near(hslToRgb(240, 100, 50), [0, 0, 1]));
  assert.ok(near(hslToRgb(0, 0, 50), [0.5, 0.5, 0.5]));
  assert.ok(near(hslToRgb(60, 100, 50), [1, 1, 0]));
});

test("hslToRgb wraps hue", () => {
  assert.ok(near(hslToRgb(480, 100, 50), hslToRgb(120, 100, 50)));
  assert.ok(near(hslToRgb(-120, 80, 40), hslToRgb(240, 80, 40)));
});

test("line layout and premultiplied colour", () => {
  const f = new FrameBuilder();
  f.line([0, 0, 0], [1, 2, 3], [1, 0.5, 0], 0.5, 2);
  const b = f.build();
  assert.equal(b.lines.count, 1);
  assert.deepEqual([...b.lines.positions.slice(0, 6)], [0, 0, 0, 1, 2, 3]);
  assert.deepEqual([...b.lines.colors.slice(0, 6)], [0.5, 0.25, 0, 0.5, 0.25, 0]);
  assert.equal(b.lines.widths[0], 2);
});

test("tri and point layout", () => {
  const f = new FrameBuilder();
  f.tri([0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 1], 0.5);
  f.point([1, 2, 3], [1, 0, 0], 1, 0.2);
  const b = f.build();
  assert.equal(b.faces.count, 1);
  assert.equal(b.points.count, 1);
  assert.deepEqual([...b.faces.positions.slice(0, 9)], [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  assert.equal(b.faces.colors[8], 0.5);
  assert.deepEqual([...b.points.positions.slice(0, 3)], [1, 2, 3]);
  assert.ok(Math.abs(b.points.sizes[0] - 0.2) < 1e-6);
});

test("polygon fans into n-2 triangles; ring yields 48 lines", () => {
  const f = new FrameBuilder();
  f.polygon([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0.5, 1.5, 0], [0, 1, 0]], [1, 1, 1], 1);
  assert.equal(f.counts.faces, 3);
  f.reset();
  f.ring([0, 0, 0], [0, 1, 0], 2, [1, 1, 1]);
  assert.equal(f.counts.lines, 48);
  const b = f.build();
  for (let i = 0; i < 48; i++) {
    const o = i * 6;
    assert.ok(Math.abs(Math.hypot(b.lines.positions[o], b.lines.positions[o + 1], b.lines.positions[o + 2]) - 2) < 1e-5);
    assert.ok(Math.abs(b.lines.positions[o + 1]) < 1e-6);
  }
  // closed loop
  assert.ok(Math.abs(b.lines.positions[47 * 6 + 3] - b.lines.positions[0]) < 1e-5);
});

test("capacity drops excess", () => {
  const f = new FrameBuilder({ maxLines: 2 });
  for (let i = 0; i < 3; i++) f.line([0, 0, 0], [1, 1, 1], [1, 1, 1]);
  assert.equal(f.counts.lines, 2);
  assert.equal(f.counts.dropped, 1);
});

test("reset keeps array identity and zeroes counts", () => {
  const f = new FrameBuilder();
  f.line([0, 0, 0], [1, 1, 1], [1, 1, 1]);
  const a = f.build().lines.positions;
  f.reset();
  assert.equal(f.counts.lines, 0);
  assert.equal(f.build().lines.positions, a);
  assert.equal(f.build().lines.count, 0);
});
