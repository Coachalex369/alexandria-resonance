import test from "node:test";
import assert from "node:assert/strict";
import * as G from "../src/index.js";

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test("plane rotations are orthonormal with determinant +1 and preserve length (3D and 4D)", () => {
  for (const n of [3, 4]) {
    const planes = n === 3 ? G.PLANES_3D : G.PLANES_4D;
    const angles = Object.fromEntries(planes.map((p, i) => [p, 0.3 + 0.41 * i]));
    const m = G.rotations(n, angles);
    assert.ok(G.isOrthonormal(m));
    near(G.determinant(m), 1, 1e-9);
    const v = Array.from({ length: n }, (_, i) => i + 0.5);
    near(G.length(G.apply(m, v)), G.length(v), 1e-9);
  }
});

test("a 4D rotation in the zw plane leaves x and y untouched and mixes z and w", () => {
  const m = G.rotationPlane(4, "zw", Math.PI / 2);
  const out = G.apply(m, [1, 2, 3, 4]);
  near(out[0], 1); near(out[1], 2); near(out[2], -4); near(out[3], 3);
});

test("rotation by 2π is the identity; inverse plane order undoes it", () => {
  const m = G.rotationPlane(4, "xw", Math.PI * 2);
  assert.ok(G.identity(4).every((row, r) => row.every((v, c) => Math.abs(v - m[r][c]) < 1e-9)));
  const a = G.rotationPlane(4, "yw", 0.7), b = G.rotationPlane(4, "yw", -0.7);
  const p = G.multiply(a, b);
  assert.ok(G.identity(4).every((row, r) => row.every((v, c) => Math.abs(v - p[r][c]) < 1e-9)));
});

test("Rodrigues axis rotation agrees with the z-plane rotation", () => {
  const a = G.rotationAxis3([0, 0, 1], 0.9), b = G.rotationPlane(3, "xy", 0.9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) near(a[r][c], b[r][c], 1e-12);
});

test("Platonic solids have the right counts and Euler characteristic 2", () => {
  const expected = { tetrahedron: [4, 6, 4], cube: [8, 12, 6], octahedron: [6, 12, 8], dodecahedron: [20, 30, 12], icosahedron: [12, 30, 20] };
  for (const [name, [v, e, f]] of Object.entries(expected)) {
    const s = G.PLATONIC[name]();
    const st = G.stats(s);
    assert.deepEqual([st.vertices, st.edges, st.faces], [v, e, f], name);
    assert.equal(st.euler, 2, name);
    // regular: every vertex at radius 1, every edge the same length, every face the same size
    for (const p of s.vertices) near(G.length(p), 1, 1e-9);
    const lens = s.edges.map(([a, b]) => G.distance(s.vertices[a], s.vertices[b]));
    near(Math.max(...lens), Math.min(...lens), 1e-9);
    assert.ok(s.faces.every((face) => face.length === s.faces[0].length), name + " faces uniform");
  }
});

test("dodecahedron faces are planar pentagons ordered around their centroid", () => {
  const d = G.dodecahedron();
  for (const f of d.faces) {
    const pts = f.map((i) => d.vertices[i]), c = G.centroid(pts), n = G.normalize(c);
    for (const p of pts) near(G.dot(G.sub(p, c), n), 0, 1e-9);           // planar
    const consecutive = pts.map((p, i) => G.distance(p, pts[(i + 1) % 5])); // ordered: equal consecutive sides
    near(Math.max(...consecutive), Math.min(...consecutive), 1e-9);
  }
});

test("dual of the cube is an octahedron; dual of the dodecahedron is an icosahedron", () => {
  const o = G.dual(G.cube()), i = G.dual(G.dodecahedron());
  assert.deepEqual([o.vertices.length, o.edges.length, o.faces.length], [6, 12, 8]);
  assert.deepEqual([i.vertices.length, i.edges.length, i.faces.length], [12, 30, 20]);
});

test("star tetrahedron is a compound of two tetrahedra on the cube's corners", () => {
  const s = G.starTetrahedron();
  assert.deepEqual([s.vertices.length, s.edges.length, s.faces.length], [8, 12, 8]);
  const c = G.cube();
  for (const v of s.vertices) assert.ok(c.vertices.some((u) => G.approxEqual(u, v, 1e-9)));
});

test("Metatron arrangement: 13 nodes, 78 lines, cuboctahedral shell", () => {
  const m = G.metatronArrangement();
  assert.equal(m.vertices.length, 13); assert.equal(m.edges.length, 78);
  const shell = G.shortestEdges(m.vertices.slice(1));
  assert.equal(shell.length, 24); // cuboctahedron has 24 edges
  const sparse = G.metatronArrangement({ connectAll: false });
  assert.equal(sparse.edges.length, 24 + 12);
});

test("flower of life and spherical lattice build connected, bounded structures", () => {
  const f = G.flowerOfLife({ rings: 1, segments: 12 });
  assert.equal(f.meta.circles, 7); assert.equal(f.edges.length, 7 * 12);
  const l = G.sphericalLattice({ points: 40, neighbours: 3 });
  assert.equal(l.vertices.length, 40);
  assert.ok(G.hopDistances(l, 0).every((d) => d >= 0), "lattice connected");
  for (const p of l.vertices) near(G.length(p), 1, 1e-9);
});

test("regular 4-polytopes: vertex/edge/face/cell counts and Euler–Poincaré V-E+F-C = 0", () => {
  const expected = { tesseract: [16, 32, 24, 8], "16-cell": [8, 24, 32, 16], "24-cell": [24, 96, 96, 24], "600-cell": [120, 720, 1200, 600] };
  for (const [name, counts] of Object.entries(expected)) {
    const s = G.POLYTOPES[name]();
    const st = G.stats(s);
    assert.equal(st.dim, 4);
    assert.deepEqual([st.vertices, st.edges, st.faces, st.cells], counts, name);
    assert.equal(st.euler, 0, name);
    const lens = s.edges.map(([a, b]) => G.distance(s.vertices[a], s.vertices[b]));
    near(Math.max(...lens), Math.min(...lens), 1e-9);
    const degrees = G.degreeOf(s);
    assert.equal(Math.max(...degrees), Math.min(...degrees), name + " vertex-transitive degree");
  }
});

test("4D rotation of a tesseract preserves all edge lengths and the circumradius", () => {
  const t = G.tesseract();
  const m = G.rotations(4, { xw: 0.8, yz: 0.3, zw: 1.1 });
  const r = G.transformStructure(t, m);
  for (const [a, b] of t.edges) near(G.distance(r.vertices[a], r.vertices[b]), G.distance(t.vertices[a], t.vertices[b]), 1e-9);
  for (const v of r.vertices) near(G.length(v), 1, 1e-9);
  // and the rotated vertex set differs from the original (a genuine 4D motion, not a 3D one)
  assert.ok(r.vertices.some((v, i) => !G.approxEqual(v, t.vertices[i], 1e-6)));
  // a rotation involving w changes the w coordinates; a pure xy rotation does not
  const onlyXY = G.transformStructure(t, G.rotationPlane(4, "xy", 0.5));
  assert.ok(onlyXY.vertices.every((v, i) => Math.abs(v[3] - t.vertices[i][3]) < 1e-12));
  assert.ok(r.vertices.some((v, i) => Math.abs(v[3] - t.vertices[i][3]) > 1e-6));
});

test("perspective 4D→3D projection enlarges the near cube and shrinks the far cube of a tesseract", () => {
  const t = G.tesseract();
  const p = G.projectAll4to3(t.vertices, { distance: 3 });
  const near4 = t.vertices.map((v, i) => [v, p[i]]).filter(([v]) => v[3] > 0).map(([, q]) => Math.hypot(q[0], q[1], q[2]));
  const far4 = t.vertices.map((v, i) => [v, p[i]]).filter(([v]) => v[3] < 0).map(([, q]) => Math.hypot(q[0], q[1], q[2]));
  assert.ok(Math.min(...near4) > Math.max(...far4));
  const o = G.projectAll4to3(t.vertices, { mode: "orthographic" });
  for (let i = 0; i < o.length; i++) assert.deepEqual(o[i].slice(0, 3), t.vertices[i].slice(0, 3));
});

test("camera: points in front project inside the frame, farther points have larger depth, orbit moves the camera", () => {
  const cam = new G.Camera({ azimuth: 0, elevation: 0, distance: 5, fov: 1.0 });
  const a = cam.project([0, 0, 0]), b = cam.project([0.5, 0, 0]), c = cam.project([0, 0, -2]);
  near(a.x, 0); near(a.y, 0);
  assert.ok(b.x > 0 && Math.abs(b.x) < 1);
  assert.ok(c.depth > a.depth);
  const before = cam.position; cam.orbit(0.5, 0.2);
  assert.ok(!G.approxEqual(before, cam.position, 1e-6));
  cam.mode = "orthographic";
  const d = cam.project([0.5, 0, 0]); assert.ok(d.x > 0);
  const behind = new G.Camera({ distance: 1 }).project([0, 0, 50]);
  assert.equal(behind.visible, false);
});

test("projectStructure runs the full 4D pipeline and keeps w for depth cues", () => {
  const cam = new G.Camera();
  const out = G.projectStructure(G.cell24(), { camera: cam, rot4: G.rotations(4, { xw: 0.4 }), proj4: { distance: 3 } });
  assert.equal(out.screen.length, 24); assert.equal(out.w.length, 24);
  assert.ok(out.screen.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
});

test("subdivide adds internal detail without changing the outline; connectNearest adds edges only", () => {
  const i = G.icosahedron();
  const s = G.subdivide(i, { spherize: true });
  assert.equal(s.vertices.length, 12 + 30 + 20);
  assert.equal(s.faces.length, 120); // each triangle → 6 (midpoints + centroid)
  assert.equal(s.edges.length, 60 + 60); // every edge split in two (60) plus midpoint→centroid spokes (3 per face)
  for (const p of s.vertices) near(G.length(p), 1, 1e-9);
  const c = G.connectNearest(G.cube(), 1);
  assert.equal(c.vertices.length, 8); assert.ok(c.edges.length > 12);
});

test("hop and geodesic distances propagate along the graph", () => {
  const c = G.cube();
  const hops = G.hopDistances(c, 0);
  assert.deepEqual([...hops].sort((a, b) => a - b), [0, 1, 1, 1, 2, 2, 2, 3]);
  const geo = G.geodesicDistances(c, 0);
  near(Math.max(...geo), 3 * G.distance(c.vertices[c.edges[0][0]], c.vertices[c.edges[0][1]]), 1e-9);
});

test("merge and nested keep vertex ranges for provenance", () => {
  const n = G.nested([G.cube, G.octahedron, G.cube], { ratio: 0.5 });
  assert.equal(n.vertices.length, 8 + 6 + 8);
  assert.equal(n.meta.partCount, 3); assert.equal(n.meta.parts.length, 3);
  const m = G.mergeStructures([G.cube(), G.tetrahedron()]);
  assert.deepEqual(m.meta.parts.map((p) => [p.from, p.to]), [[0, 8], [8, 12]]);
});
