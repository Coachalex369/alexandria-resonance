// Platonic solids and inspired arrangements (star tetrahedron, Metatron-style cuboctahedral arrangement,
// Flower-of-Life circle lattice, spherical lattices, nested polyhedra). All original procedural geometry
// expressed as Structures; nothing is loaded from an external model. Circumradius-normalized to 1.
//
// Note on the references: "Metatron's Cube" and the "Flower of Life" are historical geometric figures; here
// they are treated purely as mathematics (a complete graph on 13 points of a cuboctahedron plus centre, and a
// hexagonal circle lattice). No symbolic or physical claims are attached to them.
import { makeStructure, shortestEdges, triangles, facesFromNormals, mergeStructures, normalizeRadius, dual, uniqueEdges, scaleStructure, adjacency } from "./structure.js";
import { normalize, scale, add, length } from "./vec.js";

export const PHI = (1 + Math.sqrt(5)) / 2;

const signs = (k) => { const out = []; for (let i = 0; i < 1 << k; i++) out.push(Array.from({ length: k }, (_, b) => ((i >> b) & 1 ? -1 : 1))); return out; };
const cyclic = (v) => [v, [v[2], v[0], v[1]], [v[1], v[2], v[0]]];
const uniq = (pts) => { const seen = new Set(), out = []; for (const p of pts) { const k = p.map((x) => x.toFixed(9)).join(","); if (!seen.has(k)) { seen.add(k); out.push(p); } } return out; };

export function tetrahedron() {
  const vertices = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]];
  return normalizeRadius(makeStructure({ id: "tetrahedron", vertices, edges: shortestEdges(vertices), faces: [[0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2]] }));
}
export function cube() {
  const vertices = signs(3);
  return normalizeRadius(makeStructure({ id: "cube", vertices, edges: shortestEdges(vertices), faces: facesFromNormals(vertices, [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]], 4) }));
}
export function octahedron() {
  const vertices = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const edges = shortestEdges(vertices);
  return makeStructure({ id: "octahedron", vertices, edges, faces: triangles(6, edges) });
}
export function icosahedron() {
  const vertices = uniq(signs(2).flatMap(([a, b]) => cyclic([0, a, b * PHI])));
  const edges = shortestEdges(vertices);
  return normalizeRadius(makeStructure({ id: "icosahedron", vertices, edges, faces: triangles(12, edges) }));
}
export function dodecahedron() {
  const vertices = uniq([...signs(3), ...signs(2).flatMap(([a, b]) => cyclic([0, a / PHI, b * PHI]))]);
  const edges = shortestEdges(vertices);
  return normalizeRadius(makeStructure({ id: "dodecahedron", vertices, edges, faces: pentagonFaces(vertices.length, edges) }));
}
// Pentagonal faces from the edge graph: for a vertex v with neighbours a and b, the face through a-v-b closes
// with a neighbour x of a and a neighbour y of b that are adjacent (v,a,x,y,b in polygon order).
export function pentagonFaces(n, edges) {
  const adj = adjacency(n, edges), seen = new Set(), faces = [];
  for (let v = 0; v < n; v++) {
    const nb = [...adj[v]];
    for (let i = 0; i < nb.length; i++) for (let j = i + 1; j < nb.length; j++) {
      const a = nb[i], b = nb[j];
      for (const x of adj[a]) if (x !== v && x !== b) for (const y of adj[b]) if (y !== v && y !== a && adj[x].has(y)) {
        const key = [v, a, x, y, b].sort((p, q) => p - q).join(",");
        if (!seen.has(key)) { seen.add(key); faces.push([v, a, x, y, b]); }
      }
    }
  }
  return faces;
}
export const PLATONIC = { tetrahedron, cube, octahedron, dodecahedron, icosahedron };

// Star tetrahedron (stella octangula): a tetrahedron and its point reflection, as a compound.
export function starTetrahedron() {
  const t = tetrahedron(), u = { ...t, id: "tetrahedron-inverted", vertices: t.vertices.map((v) => scale(v, -1)) };
  const m = mergeStructures([t, u], "star-tetrahedron"); return { ...m, meta: { ...m.meta, partCount: 2, compound: true } };
}

// Metatron-style arrangement: 13 points (cuboctahedron vertices + centre) with every pair connected
// (78 lines). The classical 2D figure is a projection of this; here it is a genuine 3D object whose
// projection changes with the viewing angle. Vertex 0 is the centre.
export function metatronArrangement({ connectAll = true } = {}) {
  const pts = uniq(signs(2).flatMap(([a, b]) => [[a, b, 0], [a, 0, b], [0, a, b]])).map((p) => normalize(p));
  const vertices = [[0, 0, 0], ...pts];
  const edges = [];
  if (connectAll) for (let i = 0; i < vertices.length; i++) for (let j = i + 1; j < vertices.length; j++) edges.push([i, j]);
  else edges.push(...shortestEdges(pts).map(([a, b]) => [a + 1, b + 1]), ...pts.map((_, i) => [0, i + 1]));
  return makeStructure({ id: "metatron", vertices, edges, meta: { nodes: 13, lines: edges.length } });
}

// Flower of Life: overlapping circles on a hexagonal lattice in the xy plane (z = 0), as polygon edges.
export function flowerOfLife({ rings = 2, segments = 48, radius = 1 } = {}) {
  const centres = [];
  for (let q = -rings; q <= rings; q++) for (let r = -rings; r <= rings; r++) if (Math.abs(q + r) <= rings) centres.push([radius * Math.sqrt(3) * (q + r / 2), radius * 1.5 * r, 0]);
  const vertices = [], edges = [], faces = [];
  for (const c of centres) {
    const base = vertices.length;
    for (let i = 0; i < segments; i++) { const a = (i / segments) * Math.PI * 2; vertices.push(add(c, [radius * Math.cos(a), radius * Math.sin(a), 0])); edges.push([base + i, base + ((i + 1) % segments)]); }
    faces.push(Array.from({ length: segments }, (_, i) => base + i));
  }
  return normalizeRadius(makeStructure({ id: "flower-of-life", vertices, edges, faces, meta: { circles: centres.length } }), 1);
}

// Spherical lattice: n points on a sphere by the Fibonacci spiral, each joined to its k nearest neighbours.
export function sphericalLattice({ points = 60, neighbours = 4 } = {}) {
  const vertices = [];
  for (let i = 0; i < points; i++) { const y = 1 - (2 * (i + 0.5)) / points, r = Math.sqrt(1 - y * y), a = i * Math.PI * (3 - Math.sqrt(5)); vertices.push([r * Math.cos(a), y, r * Math.sin(a)]); }
  const edges = [];
  vertices.forEach((v, i) => vertices.map((u, j) => [length(add(v, scale(u, -1))), j]).filter(([, j]) => j !== i).sort((a, b) => a[0] - b[0]).slice(0, neighbours).forEach(([, j]) => edges.push([Math.min(i, j), Math.max(i, j)])));
  return makeStructure({ id: "spherical-lattice", vertices, edges: uniqueEdges(edges) });
}

// Nested polyhedra: solids at decreasing radii (inner complexity, same outline).
export function nested(builders, { ratio = 0.62, id = "nested" } = {}) {
  const parts = builders.map((b, i) => { const s = typeof b === "function" ? b() : b; return { ...scaleStructure(normalizeRadius(s), Math.pow(ratio, i)), id: `${s.id}@${i}` }; });
  const m = mergeStructures(parts, id); return { ...m, meta: { ...m.meta, partCount: parts.length, ratio } };
}
// A solid with its dual inscribed: the classic interlocking pair.
export function withDual(s, ratio = 0.7) { return nested([s, dual(s)], { ratio, id: `${s.id}+dual` }); }
