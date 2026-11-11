// A Structure is a plain, serializable graph of geometry: vertices in N dimensions, edges (vertex index
// pairs), optional faces (ordered vertex index lists) and, for 4-polytopes, cells (vertex index lists).
// Every element can carry `meta` (provenance of what created it) so the artwork stays explorable.
import { add, applyAll, centroid, distance, dot, normalize, sub, cross, scale, lerp } from "./vec.js";

export function makeStructure({ id = "structure", dim, vertices, edges = [], faces = [], cells = [], meta = {} }) {
  const d = dim ?? (vertices[0] ? vertices[0].length : 3);
  for (const v of vertices) if (v.length !== d) throw new Error(`vertex dimension ${v.length} != ${d}`);
  return { id, dim: d, vertices: vertices.map((v) => [...v]), edges: edges.map(([a, b]) => (a < b ? [a, b] : [b, a])), faces: faces.map((f) => [...f]), cells: cells.map((c) => [...c]), meta: { ...meta } };
}

export const edgeKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);

// All vertex pairs whose distance is within tol of d.
export function edgesByDistance(vertices, d, tol = 1e-6) {
  const out = [];
  for (let i = 0; i < vertices.length; i++) for (let j = i + 1; j < vertices.length; j++) if (Math.abs(distance(vertices[i], vertices[j]) - d) <= tol) out.push([i, j]);
  return out;
}
export function shortestDistance(vertices) {
  let best = Infinity;
  for (let i = 0; i < vertices.length; i++) for (let j = i + 1; j < vertices.length; j++) best = Math.min(best, distance(vertices[i], vertices[j]));
  return best;
}
// Edges of a regular figure: every pair at the minimum pairwise distance.
export const shortestEdges = (vertices, tol = 1e-6) => edgesByDistance(vertices, shortestDistance(vertices), tol);

export function adjacency(n, edges) {
  const adj = Array.from({ length: n }, () => new Set());
  for (const [a, b] of edges) { adj[a].add(b); adj[b].add(a); }
  return adj;
}
export const degreeOf = (s) => adjacency(s.vertices.length, s.edges).map((a) => a.size);

// 3-cliques of the edge graph (triangular faces of simplicial figures).
export function triangles(n, edges) {
  const adj = adjacency(n, edges), out = [];
  for (let a = 0; a < n; a++) for (const b of adj[a]) if (b > a) for (const c of adj[b]) if (c > b && adj[a].has(c)) out.push([a, b, c]);
  return out;
}
// 4-cliques (tetrahedral cells of simplicial 4-polytopes).
export function cliques4(n, edges) {
  const adj = adjacency(n, edges), out = [];
  for (const [a, b, c] of triangles(n, edges)) for (const d of adj[c]) if (d > c && adj[a].has(d) && adj[b].has(d)) out.push([a, b, c, d]);
  return out;
}

// Faces of a convex figure given outward normals: the k vertices with the largest dot product with each
// normal, ordered around the normal so polygons draw correctly (3D only for ordering).
export function facesFromNormals(vertices, normals, k) {
  return normals.map((nrm) => {
    const idx = vertices.map((v, i) => [dot(v, nrm), i]).sort((a, b) => b[0] - a[0]).slice(0, k).map((p) => p[1]);
    if (vertices[0].length !== 3) return idx;
    const c = centroid(idx.map((i) => vertices[i])), n = normalize(nrm);
    const u = normalize(sub(vertices[idx[0]], c)), w = cross(n, u);
    const ang = (i) => Math.atan2(dot(sub(vertices[i], c), w), dot(sub(vertices[i], c), u));
    return idx.sort((a, b) => ang(a) - ang(b));
  });
}

// Vertex sets (cells) given cell-centre directions: the k nearest vertices to each direction.
export const cellsFromCentres = (vertices, centres, k) => centres.map((c) => vertices.map((v, i) => [dot(normalize(v), normalize(c)), i]).sort((a, b) => b[0] - a[0]).slice(0, k).map((p) => p[1]).sort((a, b) => a - b));

export function transformStructure(s, matrix) { return { ...s, vertices: applyAll(matrix, s.vertices) }; }
export function translateStructure(s, offset) { return { ...s, vertices: s.vertices.map((v) => add(v, offset)) }; }
export function scaleStructure(s, k) { return { ...s, vertices: s.vertices.map((v) => scale(v, k)) }; }
export function normalizeRadius(s, r = 1) { const m = Math.max(...s.vertices.map((v) => Math.sqrt(dot(v, v)))); return m > 0 ? scaleStructure(s, r / m) : s; }

// Combine structures into one (vertex indices re-based). Element meta is kept per part through `parts`.
export function mergeStructures(parts, id = "compound") {
  const vertices = [], edges = [], faces = [], cells = [], ranges = [];
  for (const p of parts) {
    const off = vertices.length;
    ranges.push({ id: p.id, from: off, to: off + p.vertices.length, meta: p.meta });
    vertices.push(...p.vertices.map((v) => [...v]));
    edges.push(...p.edges.map(([a, b]) => [a + off, b + off]));
    faces.push(...p.faces.map((f) => f.map((i) => i + off)));
    cells.push(...p.cells.map((c) => c.map((i) => i + off)));
  }
  return { id, dim: parts[0]?.dim ?? 3, vertices, edges, faces, cells, meta: { parts: ranges } };
}

// Dual polyhedron: one vertex per face (at the face centroid), edges between faces sharing an edge.
export function dual(s) {
  const owners = new Map();
  s.faces.forEach((f, fi) => { for (let i = 0; i < f.length; i++) { const k = edgeKey(f[i], f[(i + 1) % f.length]); if (!owners.has(k)) owners.set(k, []); owners.get(k).push(fi); } });
  const vertices = s.faces.map((f) => centroid(f.map((i) => s.vertices[i])));
  const edges = [...owners.values()].filter((o) => o.length === 2).map(([a, b]) => (a < b ? [a, b] : [b, a]));
  // dual faces: one per original vertex, ordered around it
  const faces = s.vertices.map((v, vi) => {
    const around = s.faces.map((f, fi) => (f.includes(vi) ? fi : -1)).filter((x) => x >= 0);
    if (around.length < 3 || s.dim !== 3) return around;
    const n = normalize(v), u = normalize(sub(vertices[around[0]], scale(n, dot(vertices[around[0]], n)))), w = cross(n, u);
    const ang = (i) => Math.atan2(dot(vertices[i], w), dot(vertices[i], u));
    return around.sort((a, b) => ang(a) - ang(b));
  });
  return { id: `${s.id}-dual`, dim: s.dim, vertices, edges, faces, cells: [], meta: { dualOf: s.id } };
}

// Internal complexity: insert a midpoint on every edge (optionally pushed to the circumsphere) and split
// faces into fans around their centroids. Vertex and edge counts grow; the outline does not.
export function subdivide(s, { spherize = false } = {}) {
  const vertices = s.vertices.map((v) => [...v]);
  const radius = spherize ? Math.max(...vertices.map((v) => Math.sqrt(dot(v, v)))) : 0;
  const mid = new Map(), edges = [];
  const midpoint = (a, b) => {
    const k = edgeKey(a, b);
    if (!mid.has(k)) { let m = lerp(vertices[a], vertices[b], 0.5); if (spherize) m = scale(normalize(m), radius); vertices.push(m); mid.set(k, vertices.length - 1); }
    return mid.get(k);
  };
  for (const [a, b] of s.edges) { const m = midpoint(a, b); edges.push([a, m], [m, b]); }
  const faces = [];
  for (const f of s.faces) {
    const c = centroid(f.map((i) => vertices[i])); vertices.push(spherize ? scale(normalize(c), radius) : c); const ci = vertices.length - 1;
    for (let i = 0; i < f.length; i++) { const a = f[i], b = f[(i + 1) % f.length], m = midpoint(a, b); edges.push([m, ci]); faces.push([a, m, ci], [m, b, ci]); }
  }
  return { ...s, id: `${s.id}+`, vertices, edges: uniqueEdges(edges), faces, cells: [], meta: { ...s.meta, subdivided: (s.meta.subdivided || 0) + 1 } };
}

// Internal connections: link each vertex to its k nearest vertices that are not already neighbours.
export function connectNearest(s, k = 1) {
  const adj = adjacency(s.vertices.length, s.edges), edges = [...s.edges];
  s.vertices.forEach((v, i) => {
    const cand = s.vertices.map((u, j) => [distance(v, u), j]).filter(([, j]) => j !== i && !adj[i].has(j)).sort((a, b) => a[0] - b[0]).slice(0, k);
    for (const [, j] of cand) { edges.push([Math.min(i, j), Math.max(i, j)]); adj[i].add(j); adj[j].add(i); }
  });
  return { ...s, edges: uniqueEdges(edges) };
}

export function uniqueEdges(edges) {
  const seen = new Set(), out = [];
  for (const [a, b] of edges) { if (a === b) continue; const k = edgeKey(a, b); if (!seen.has(k)) { seen.add(k); out.push(a < b ? [a, b] : [b, a]); } }
  return out;
}

// Breadth-first hop distances from a vertex along edges (for graph-based wave propagation). -1 = unreachable.
export function hopDistances(s, from) {
  const adj = adjacency(s.vertices.length, s.edges), dist = new Array(s.vertices.length).fill(-1), q = [from];
  dist[from] = 0;
  while (q.length) { const a = q.shift(); for (const b of adj[a]) if (dist[b] < 0) { dist[b] = dist[a] + 1; q.push(b); } }
  return dist;
}
// Geodesic (edge-length weighted) distances: Dijkstra on the edge graph.
export function geodesicDistances(s, from) {
  const adj = adjacency(s.vertices.length, s.edges), dist = new Array(s.vertices.length).fill(Infinity), done = new Array(s.vertices.length).fill(false);
  dist[from] = 0;
  for (;;) {
    let a = -1, best = Infinity;
    for (let i = 0; i < dist.length; i++) if (!done[i] && dist[i] < best) { best = dist[i]; a = i; }
    if (a < 0) break; done[a] = true;
    for (const b of adj[a]) { const nd = dist[a] + distance(s.vertices[a], s.vertices[b]); if (nd < dist[b]) dist[b] = nd; }
  }
  return dist;
}

export const eulerCharacteristic = (s) => s.vertices.length - s.edges.length + s.faces.length - (s.dim === 4 ? s.cells.length : 0);
export const stats = (s) => ({ dim: s.dim, vertices: s.vertices.length, edges: s.edges.length, faces: s.faces.length, cells: s.cells.length, euler: eulerCharacteristic(s) });
