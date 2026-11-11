import test from "node:test";
import assert from "node:assert/strict";
import { hexLattice, extendHexLattice, hexRingPoints, crystal, extendCrystal, helix, torus, membrane, mirrorY, addVertex, tips, triangulate, nearestLatticeVertex } from "../src/forms.js";
import { eulerCharacteristic } from "../src/structure.js";

test("hex lattice: ring k has 6k points, 1+3R(R+1) vertices, planar, 6-neighbour interior", () => {
  assert.equal(hexRingPoints(3).length, 18);
  const s = hexLattice({ rings: 3 });
  assert.equal(s.vertices.length, 1 + 3 * 3 * 4);
  assert.ok(s.vertices.every((v) => v[1] === 0));
  const deg = new Array(s.vertices.length).fill(0); for (const [a, b] of s.edges) { deg[a]++; deg[b]++; }
  assert.equal(deg[0], 6);
  assert.equal(s.edges.length, 3 * 3 * (3 * 3 + 1)); // edges of a hex patch: 3R(3R+1)
  assert.equal(s.faces.length, 6 * 9); // 6R^2 triangles
  assert.equal(eulerCharacteristic(s), 1); // a disc
});
test("extending a lattice keeps existing indices and adds the next ring", () => {
  const a = hexLattice({ rings: 1 }), b = extendHexLattice(a);
  assert.equal(b.vertices.length, 1 + 3 * 2 * 3);
  assert.deepEqual(b.vertices.slice(0, 7), a.vertices);
  assert.equal(b.meta.rings, 2); assert.equal(b.meta.ring.at(-1), 2);
  assert.equal(nearestLatticeVertex(b, [1.9, 5, 0.1]), b.vertices.findIndex((v) => Math.abs(v[0] - 2) < 1e-9 && Math.abs(v[2]) < 1e-9));
});
test("crystal: stacked rings plus apex, closed surface, extension keeps old indices", () => {
  const c = crystal({ sides: 6, stages: 2 });
  assert.equal(c.vertices.length, 6 * 3 + 1);
  assert.equal(c.faces.length, 6 * 2 + 6 + 1);
  assert.equal(eulerCharacteristic(c), 2); // sphere-like
  assert.ok(c.vertices.every((v) => v[1] >= 0));
  const d = extendCrystal(c);
  assert.equal(d.meta.stages, 3); assert.equal(d.vertices.length, 6 * 4 + 1);
  assert.deepEqual(d.vertices.slice(0, 18), c.vertices.slice(0, 18));
  assert.ok(d.vertices[d.meta.apexIndex][1] > c.vertices[c.meta.apexIndex][1]);
  assert.equal(eulerCharacteristic(d), 2);
});
test("helix, torus, membrane, mirror, branches", () => {
  const h = helix({ turns: 2, pointsPerTurn: 10, pitch: 1 });
  assert.equal(h.vertices.length, 21); assert.ok(Math.abs(h.vertices.at(-1)[1] - 2) < 1e-9);
  const t = torus({ segU: 12, segV: 6 });
  assert.equal(t.vertices.length, 72); assert.equal(t.edges.length, 144); assert.equal(t.faces.length, 72); assert.equal(eulerCharacteristic(t), 0);
  const m = membrane([[1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1]]);
  assert.equal(m.faces.length, 1); assert.equal(m.faces[0].length, 4); assert.equal(m.edges.length, 4);
  assert.equal(triangulate(m.faces[0]).length, 2);
  const c = crystal({ stages: 1 }), r = mirrorY(c);
  assert.ok(r.vertices.every((v) => v[1] <= 0)); assert.equal(r.meta.mirrorOf, c.id);
  let b = { id: "b", dim: 3, vertices: [[0, 0, 0]], edges: [], faces: [], cells: [], meta: {} };
  b = addVertex(b, [0, -1, 0], [0]); b = addVertex(b, [1, -1.5, 0], [1]); b = addVertex(b, [-1, -1.5, 0], [1]);
  assert.deepEqual(tips(b, new Set([0])), [2, 3]);
});
