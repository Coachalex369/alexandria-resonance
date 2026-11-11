// Regular convex 4-polytopes with genuine 4D coordinates: tesseract (8-cell), 16-cell, 24-cell and
// 600-cell. Vertices live in R^4; edges are the shortest vertex pairs; faces are polygons; cells are the
// 3D facets. Rotation happens in 4D coordinate planes (vec.js rotationPlane with n = 4) and projection to
// 3D is a separate step (projection.js). Nothing here is a 3D object pretending to be four-dimensional.
import { makeStructure, shortestEdges, triangles, cliques4, cellsFromCentres, facesFromNormals } from "./structure.js";
import { PHI } from "./polyhedra.js";

const signs = (k) => { const out = []; for (let i = 0; i < 1 << k; i++) out.push(Array.from({ length: k }, (_, b) => ((i >> b) & 1 ? -1 : 1))); return out; };
const uniq = (pts) => { const seen = new Set(), out = []; for (const p of pts) { const k = p.map((x) => x.toFixed(9)).join(","); if (!seen.has(k)) { seen.add(k); out.push(p); } } return out; };
const permutations = (arr) => arr.length <= 1 ? [arr] : arr.flatMap((x, i) => permutations([...arr.slice(0, i), ...arr.slice(i + 1)]).map((p) => [x, ...p]));
const parity = (perm) => { let inv = 0; for (let i = 0; i < perm.length; i++) for (let j = i + 1; j < perm.length; j++) if (perm[i] > perm[j]) inv++; return inv % 2; };
const evenPermutations = (arr) => permutations(arr.map((_, i) => i)).filter((p) => parity(p) === 0).map((p) => p.map((i) => arr[i]));

// Square faces of a tesseract-like vertex set: 4-cycles where two coordinates vary and the rest are fixed.
function tesseractFaces(vertices) {
  const faces = [];
  const index = new Map(vertices.map((v, i) => [v.join(","), i]));
  for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) {
    const fixed = [0, 1, 2, 3].filter((k) => k !== a && k !== b);
    for (const [s0, s1] of signs(2)) {
      const at = (pa, pb) => { const v = [0, 0, 0, 0]; v[fixed[0]] = s0; v[fixed[1]] = s1; v[a] = pa; v[b] = pb; return index.get(v.join(",")); };
      faces.push([at(1, 1), at(1, -1), at(-1, -1), at(-1, 1)]);
    }
  }
  return faces;
}

export function tesseract() {
  const vertices = signs(4);
  const edges = shortestEdges(vertices);
  const cells = [];
  for (let k = 0; k < 4; k++) for (const s of [1, -1]) cells.push(vertices.map((v, i) => (v[k] === s ? i : -1)).filter((i) => i >= 0));
  return normalize4(makeStructure({ id: "tesseract", dim: 4, vertices, edges, faces: tesseractFaces(vertices), cells, meta: { schlafli: "{4,3,3}" } }));
}

export function cell16() {
  const vertices = [];
  for (let k = 0; k < 4; k++) for (const s of [1, -1]) { const v = [0, 0, 0, 0]; v[k] = s; vertices.push(v); }
  const edges = shortestEdges(vertices);
  return makeStructure({ id: "16-cell", dim: 4, vertices, edges, faces: triangles(8, edges), cells: cliques4(8, edges), meta: { schlafli: "{3,3,4}" } });
}

export function cell24() {
  // vertices: all permutations of (±1, ±1, 0, 0) → 24 points at radius √2
  const vertices = uniq([0, 1, 2, 3].flatMap((a) => [0, 1, 2, 3].filter((b) => b > a).flatMap((b) => signs(2).map(([s, t]) => { const v = [0, 0, 0, 0]; v[a] = s; v[b] = t; return v; }))));
  const edges = shortestEdges(vertices);
  // the 24 octahedral cells are centred on the vertices of the dual 24-cell: (±1,0,0,0) perms and (±½,±½,±½,±½)
  const centres = [...signs(4).map((s) => s.map((x) => x / 2)), ...[0, 1, 2, 3].flatMap((k) => [1, -1].map((s) => { const v = [0, 0, 0, 0]; v[k] = s; return v; }))];
  const cells = cellsFromCentres(vertices, centres, 6);
  return normalize4(makeStructure({ id: "24-cell", dim: 4, vertices, edges, faces: triangles(24, edges), cells, meta: { schlafli: "{3,4,3}" } }));
}

export function cell600() {
  const half = signs(4).map((s) => s.map((x) => x / 2));
  const axes = [0, 1, 2, 3].flatMap((k) => [1, -1].map((s) => { const v = [0, 0, 0, 0]; v[k] = s; return v; }));
  const golden = signs(3).flatMap(([a, b, c]) => evenPermutations([(a * PHI) / 2, b / 2, c / (2 * PHI), 0]));
  const vertices = uniq([...half, ...axes, ...golden]);
  const edges = shortestEdges(vertices, 1e-6);
  return makeStructure({ id: "600-cell", dim: 4, vertices, edges, faces: triangles(vertices.length, edges), cells: cliques4(vertices.length, edges), meta: { schlafli: "{3,3,5}" } });
}

export const POLYTOPES = { tesseract, "16-cell": cell16, "24-cell": cell24, "600-cell": cell600 };

// Normalize a 4-polytope to circumradius 1 (keeps the shapes comparable in the laboratory).
export function normalize4(s) {
  const r = Math.max(...s.vertices.map((v) => Math.hypot(...v)));
  return { ...s, vertices: s.vertices.map((v) => v.map((x) => x / r)) };
}

// The facesFromNormals import is kept available for custom 4D figures built in the laboratory.
export { facesFromNormals };
