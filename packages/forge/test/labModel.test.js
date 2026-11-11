// Tests for the pure Geometry Laboratory model (packages/forge/src/labModel.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STRUCTURES, buildStructure, applyComplexity, stepAngles, rotationMatrices, colorFor, defaultState, EDGE_GUARD,
} from "../src/labModel.js";

test("every select value builds a structure with vertices and dim 3 or 4", () => {
  for (const name of Object.keys(STRUCTURES)) {
    const s = buildStructure(name);
    assert.ok(s.vertices.length > 0, name);
    assert.ok(s.dim === 3 || s.dim === 4, name);
  }
});

test("stepAngles advances xw/zw only for 4D shapes with auto4D", () => {
  const s4 = { ...defaultState({ structure: "tesseract" }), auto3D: false };
  const a4 = stepAngles(s4, 100);
  assert.ok(a4.xw > 0 && a4.zw > 0);
  const s3 = { ...defaultState({ structure: "cube" }), auto4D: true };
  const a3 = stepAngles(s3, 100);
  assert.equal(a3.xw, 0);
  assert.equal(a3.zw, 0);
  assert.ok(a3.xz > 0);
});

test("stepAngles does nothing when reducedMotion or paused", () => {
  const s = { ...defaultState({ structure: "tesseract" }), reducedMotion: true, auto3D: true, auto4D: true };
  assert.deepEqual(stepAngles(s, 100), s.angles);
  const p = { ...defaultState({ structure: "tesseract" }), paused: true };
  assert.deepEqual(stepAngles(p, 100), p.angles);
});

test("applyComplexity refuses beyond the edge guard", () => {
  const out = applyComplexity(buildStructure("icosahedron"), { subdivisions: 10 });
  assert.ok(out.labInfo.refused);
  assert.ok(out.labInfo.applied < 10);
  assert.ok(out.edges.length > EDGE_GUARD);
  const four = applyComplexity(buildStructure("tesseract"), { subdivisions: 1 });
  assert.equal(four.labInfo.applied, 0);
  assert.equal(applyComplexity(buildStructure("cube"), { subdivisions: 1 }).labInfo.applied, 1);
});

test("colorFor by w gives different hues for w=-1 and w=+1", () => {
  const st = { ...defaultState({ structure: "tesseract" }), colorMode: "w" };
  const s = buildStructure("tesseract");
  assert.notEqual(colorFor(st, s, { w: -1 }).hue, colorFor(st, s, { w: 1 }).hue);
  const part = { ...st, colorMode: "part" };
  assert.notEqual(colorFor(part, s, { partIndex: 0 }).hue, colorFor(part, s, { partIndex: 1 }).hue);
});

test("rotationMatrices gives 3x3 and (4D only) 4x4", () => {
  assert.equal(rotationMatrices(defaultState({ structure: "cube" })).rot4, null);
  const m = rotationMatrices(defaultState({ structure: "24-cell" }));
  assert.equal(m.rot3.length, 3);
  assert.equal(m.rot4.length, 4);
});
