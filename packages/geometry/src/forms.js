// Procedural forms for compositions that share one coordinate system: planar lattices that grow ring by ring,
// crystals (stacked, twisted, tapered prisms that gain stages), helices, tori, membranes, reflections and
// incremental branch growth. All original procedural geometry expressed as Structures (y is "up"; the plane
// y = 0 is the natural reference plane). Renderer-independent; nothing here knows about events or agents.
import { makeStructure, uniqueEdges, triangles } from "./structure.js";
import { add, scale, sub, normalize, length, distance } from "./vec.js";

const TAU = Math.PI * 2;

// ---------- hexagonal lattice in the plane y = 0 ----------
// Points of ring k (k >= 1) of a hexagonal (triangular) lattice with the given spacing, ordered around the ring.
export function hexRingPoints(k, spacing = 1) {
  if (k === 0) return [[0, 0, 0]];
  const corners = Array.from({ length: 6 }, (_, i) => [Math.cos((i * TAU) / 6) * k * spacing, 0, Math.sin((i * TAU) / 6) * k * spacing]);
  const out = [];
  for (let i = 0; i < 6; i++) { const a = corners[i], b = corners[(i + 1) % 6]; for (let j = 0; j < k; j++) out.push(add(a, scale(sub(b, a), j / k))); }
  return out;
}
// Lattice with `rings` rings (ring 0 is the centre). Vertices are ordered centre first then ring by ring;
// meta.ring[i] gives the ring of vertex i. Edges join neighbours at the lattice spacing; faces are the triangles.
export function hexLattice({ rings = 2, spacing = 1 } = {}) {
  const vertices = [], ring = [];
  for (let k = 0; k <= rings; k++) for (const p of hexRingPoints(k, spacing)) { vertices.push(p); ring.push(k); }
  const edges = latticeEdges(vertices, 0, spacing);
  return makeStructure({ id: `hex-lattice-${rings}`, dim: 3, vertices, edges, faces: triangles(vertices.length, edges), meta: { ring, spacing, rings } });
}
// Edges between vertices at (approximately) `spacing` where at least one endpoint has index >= from.
export function latticeEdges(vertices, from, spacing, tol = 1e-6) {
  const out = [];
  for (let j = Math.max(1, from); j < vertices.length; j++) for (let i = 0; i < j; i++) if (Math.abs(distance(vertices[i], vertices[j]) - spacing) <= tol) out.push([i, j]);
  return out;
}
// Add the next ring to a lattice structure (new vertices connect to existing ones; faces recomputed).
export function extendHexLattice(s) {
  const rings = (s.meta.rings ?? 0) + 1, spacing = s.meta.spacing ?? 1;
  const pts = hexRingPoints(rings, spacing), from = s.vertices.length;
  const vertices = [...s.vertices.map((v) => [...v]), ...pts];
  const edges = uniqueEdges([...s.edges, ...latticeEdges(vertices, from, spacing)]);
  return { ...s, id: `hex-lattice-${rings}`, vertices, edges, faces: triangles(vertices.length, edges), meta: { ...s.meta, rings, ring: [...(s.meta.ring || []), ...pts.map(() => rings)] } };
}
// Index of the lattice vertex nearest a world point (ignores y).
export function nearestLatticeVertex(s, p) {
  let best = -1, bd = Infinity;
  s.vertices.forEach((v, i) => { const d = Math.hypot(v[0] - p[0], v[2] - p[2]); if (d < bd) { bd = d; best = i; } });
  return best;
}

// ---------- crystals: stacked prisms with twist and taper ----------
// A crystal stands on y = 0. Ring r (r = 0 .. stages) sits at height r*stageHeight, rotated r*twist, scaled
// taper^r; an apex caps it. Vertices: rings first (sides each) then the apex. meta.rings/sides/stageHeight/twist/taper.
export function crystal({ sides = 4, radius = 0.35, stages = 1, stageHeight = 0.8, twist = Math.PI / 12, taper = 0.9, apex = 0.6 } = {}) {
  const vertices = [], edges = [], faces = [];
  for (let r = 0; r <= stages; r++) vertices.push(...ringPoints(sides, radius * Math.pow(taper, r), r * stageHeight, r * twist));
  const apexIndex = vertices.length; vertices.push([0, stages * stageHeight + apex * radius * Math.pow(taper, stages), 0]);
  crystalTopology(sides, stages, apexIndex, edges, faces);
  return makeStructure({ id: `crystal-${sides}-${stages}`, dim: 3, vertices, edges, faces, meta: { form: "crystal", sides, stages, radius, stageHeight, twist, taper, apex, apexIndex } });
}
function ringPoints(sides, radius, y, rot) { return Array.from({ length: sides }, (_, i) => [Math.cos(rot + (i * TAU) / sides) * radius, y, Math.sin(rot + (i * TAU) / sides) * radius]); }
function crystalTopology(sides, stages, apexIndex, edges, faces) {
  const at = (r, i) => r * sides + ((i % sides) + sides) % sides;
  for (let r = 0; r <= stages; r++) for (let i = 0; i < sides; i++) edges.push([at(r, i), at(r, i + 1)]);
  for (let r = 0; r < stages; r++) for (let i = 0; i < sides; i++) { edges.push([at(r, i), at(r + 1, i)]); faces.push([at(r, i), at(r, i + 1), at(r + 1, i + 1), at(r + 1, i)]); }
  for (let i = 0; i < sides; i++) { edges.push([at(stages, i), apexIndex]); faces.push([at(stages, i), at(stages, i + 1), apexIndex]); }
  faces.push(Array.from({ length: sides }, (_, i) => at(0, i)));
}
// One more stage on top: the previous rings keep their indices (so per-vertex state survives); the apex is
// re-created as the last vertex. Bounded by the caller.
export function extendCrystal(s, { twist = s.meta.twist, taper = s.meta.taper } = {}) {
  const m = s.meta, stages = m.stages + 1;
  const ringsOnly = s.vertices.slice(0, m.apexIndex).map((v) => [...v]);
  const r = stages, vertices = [...ringsOnly, ...ringPoints(m.sides, m.radius * Math.pow(taper, r), r * m.stageHeight, cumulativeTwist(m, twist))];
  const apexIndex = vertices.length; vertices.push([0, stages * m.stageHeight + m.apex * m.radius * Math.pow(taper, stages), 0]);
  const edges = [], faces = [];
  crystalTopology(m.sides, stages, apexIndex, edges, faces);
  return { ...s, id: `crystal-${m.sides}-${stages}`, vertices, edges, faces, meta: { ...m, stages, apexIndex, twists: [...(m.twists || [])] } };
}
function cumulativeTwist(m, twist) { return m.stages * m.twist + twist; }

// ---------- helix, torus, membrane ----------
export function helix({ turns = 2, pointsPerTurn = 12, radius = 0.5, pitch = 0.6, phase = 0, direction = 1 } = {}) {
  const n = Math.max(2, Math.round(turns * pointsPerTurn)), vertices = [], edges = [];
  for (let i = 0; i <= n; i++) { const a = phase + (i / pointsPerTurn) * TAU; vertices.push([Math.cos(a) * radius, direction * (i / pointsPerTurn) * pitch, Math.sin(a) * radius]); if (i) edges.push([i - 1, i]); }
  return makeStructure({ id: "helix", dim: 3, vertices, edges, meta: { form: "helix", turns, pointsPerTurn, radius, pitch } });
}
export function torus({ major = 1, minor = 0.3, segU = 16, segV = 8 } = {}) {
  const vertices = [], edges = [], faces = [];
  for (let i = 0; i < segU; i++) for (let j = 0; j < segV; j++) { const u = (i / segU) * TAU, v = (j / segV) * TAU, r = major + minor * Math.cos(v); vertices.push([Math.cos(u) * r, minor * Math.sin(v), Math.sin(u) * r]); }
  const at = (i, j) => ((i + segU) % segU) * segV + ((j + segV) % segV);
  for (let i = 0; i < segU; i++) for (let j = 0; j < segV; j++) { edges.push([at(i, j), at(i + 1, j)], [at(i, j), at(i, j + 1)]); faces.push([at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]); }
  return makeStructure({ id: "torus", dim: 3, vertices, edges: uniqueEdges(edges), faces, meta: { form: "torus", major, minor } });
}
// A translucent membrane spanning a set of points: ordered around their centroid, one polygon face.
export function membrane(points) {
  if (points.length < 3) return makeStructure({ id: "membrane", dim: 3, vertices: points, edges: points.length === 2 ? [[0, 1]] : [], faces: [] });
  const c = points.reduce((s, p) => add(s, p), [0, 0, 0]).map((x) => x / points.length);
  let n = [0, 1, 0]; for (let i = 1; i < points.length; i++) { const a = sub(points[i - 1], c), b = sub(points[i], c), cr = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; if (length(cr) > 1e-6) { n = normalize(cr); break; } }
  const u = normalize(sub(points[0], c)), w = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  const order = points.map((p, i) => [Math.atan2(dot3(sub(p, c), w), dot3(sub(p, c), u)), i]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const vertices = order.map((i) => [...points[i]]);
  const edges = vertices.map((_, i) => [i, (i + 1) % vertices.length]);
  return makeStructure({ id: "membrane", dim: 3, vertices, edges: uniqueEdges(edges), faces: [vertices.map((_, i) => i)], meta: { form: "membrane", centroid: c, normal: n } });
}
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// ---------- reflection and incremental growth ----------
// Mirror through the plane y = 0 (as above, so below). Faces are reversed so winding stays consistent.
export function mirrorY(s) { return { ...s, id: `${s.id}-mirror`, vertices: s.vertices.map((v) => [v[0], -v[1], v[2], ...v.slice(3)]), faces: s.faces.map((f) => [...f].reverse()), meta: { ...s.meta, mirrorOf: s.id } }; }

// Add one vertex connected to the given existing vertices (branching networks grow one segment at a time).
export function addVertex(s, p, connectTo = []) {
  const vertices = [...s.vertices.map((v) => [...v]), [...p]], i = vertices.length - 1;
  return { ...s, vertices, edges: uniqueEdges([...s.edges, ...connectTo.map((j) => [j, i])]), faces: s.faces };
}
// Degree-1 vertices (branch tips) of a structure, excluding `exclude`.
export function tips(s, exclude = new Set()) {
  const deg = new Array(s.vertices.length).fill(0);
  for (const [a, b] of s.edges) { deg[a]++; deg[b]++; }
  return deg.map((d, i) => (d === 1 && !exclude.has(i) ? i : -1)).filter((i) => i >= 0);
}
// Fan-triangulate polygon faces (for renderers that need triangles).
export function triangulate(face) { const out = []; for (let i = 1; i + 1 < face.length; i++) out.push([face[0], face[i], face[i + 1]]); return out; }
