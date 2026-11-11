// Geometry Laboratory model: pure state and helpers (no DOM, no canvas) for packages/forge/lab.html.
// Holds the default lab state, builds structures for the select values, applies complexity (subdivide /
// connect nearest) behind an edge guard, advances the auto rotations, derives the 3D/4D rotation matrices
// and chooses colours. lab.js wires this to the DOM, the WireRenderer and the RippleField.
import {
  PLATONIC, POLYTOPES, starTetrahedron, metatronArrangement, flowerOfLife, sphericalLattice,
  nested, withDual, subdivide, connectNearest, rotations, stats,
} from "../../geometry/src/index.js";

export const EDGE_GUARD = 4000;

// Select values -> label (display order).
export const STRUCTURES = {
  tetrahedron: "Tetrahedron", cube: "Cube", octahedron: "Octahedron", dodecahedron: "Dodecahedron", icosahedron: "Icosahedron",
  "star-tetrahedron": "Star tetrahedron", "metatron-all": "Metatron (all 78 lines)", "metatron-sparse": "Metatron (sparse)",
  "flower-of-life": "Flower of Life", "spherical-lattice": "Spherical lattice",
  "nested": "Nested (icosa > dodeca > icosa)", "cube+dual": "Cube + dual",
  tesseract: "Tesseract", "16-cell": "16-cell", "24-cell": "24-cell", "600-cell": "600-cell",
};
export const FOUR_D = new Set(["tesseract", "16-cell", "24-cell", "600-cell"]);
export const isFourD = (name) => FOUR_D.has(name);

// The geometry package overwrites meta.parts with a count for compounds, so part vertex ranges are recorded here.
const withRanges = (s, sizes) => {
  let from = 0;
  return { ...s, partRanges: sizes.map((n) => { const r = { from, to: from + n }; from += n; return r; }) };
};

export function buildStructure(name) {
  if (PLATONIC[name]) return PLATONIC[name]();
  if (POLYTOPES[name]) return POLYTOPES[name]();
  switch (name) {
    case "star-tetrahedron": return withRanges(starTetrahedron(), [4, 4]);
    case "metatron-all": return metatronArrangement({ connectAll: true });
    case "metatron-sparse": return metatronArrangement({ connectAll: false });
    case "flower-of-life": return flowerOfLife({ rings: 2, segments: 48 });
    case "spherical-lattice": return sphericalLattice({ points: 60, neighbours: 4 });
    case "nested": {
      const i = PLATONIC.icosahedron, d = PLATONIC.dodecahedron;
      return withRanges(nested([i, d, i], { ratio: 0.62 }), [12, 20, 12]);
    }
    case "cube+dual": return withRanges(withDual(PLATONIC.cube()), [8, 6]);
    default: throw new Error(`unknown structure: ${name}`);
  }
}

// Apply `subdivisions` rounds of spherized subdivision then optional nearest connections. Refuses a further
// subdivision once the edge count exceeds the guard. Returns the structure with `labInfo` = { applied, refused, edges }.
export function applyComplexity(structure, { subdivisions = 0, connect = 0, guard = EDGE_GUARD } = {}) {
  let s = structure, applied = 0, refused = false;
  for (let i = 0; i < subdivisions; i++) {
    if (s.dim === 4 || s.edges.length > guard) { refused = true; break; }
    s = subdivide(s, { spherize: true }); applied++;
  }
  for (let i = 0; i < connect; i++) {
    if (s.edges.length > guard) { refused = true; break; }
    s = connectNearest(s, 1);
  }
  return { ...s, labInfo: { applied, refused, edges: s.edges.length } };
}

export const structureStats = (s) => stats(s);

export function defaultState({ reducedMotion = false, structure = "icosahedron" } = {}) {
  const four = isFourD(structure);
  return {
    structure, paused: false, reducedMotion,
    angles: { xy: 0, xz: 0, yz: 0, xw: 0, yw: 0, zw: 0 },
    auto3D: !reducedMotion, speed: 1, auto4D: four && !reducedMotion, autoOrbit: !reducedMotion,
    proj4: { mode: "perspective", distance: 3.5 },
    cam: { mode: "perspective", fov: 0.9, distance: 4 },
    subdivisions: 0, connect: 0,
    fx: { faces: false, faceAlpha: 0.08, glow: true, nodes: true },
    colorMode: "w", hue: 200,
  };
}

// Advance auto rotations by dtMs. Returns a new angles object; never mutates. No-op when paused or reducedMotion.
export function stepAngles(state, dtMs) {
  const a = { ...state.angles };
  if (state.paused || state.reducedMotion || !(dtMs > 0)) return a;
  const dt = Math.min(dtMs, 100) / 1000, TAU = Math.PI * 2;
  const wrap = (v) => ((v % TAU) + TAU) % TAU;
  if (state.auto3D) { a.xy = wrap(a.xy + 0.10 * state.speed * dt); a.xz = wrap(a.xz + 0.35 * state.speed * dt); a.yz = wrap(a.yz + 0.04 * state.speed * dt); }
  if (state.auto4D && isFourD(state.structure)) { a.xw = wrap(a.xw + 0.30 * state.speed * dt); a.zw = wrap(a.zw + 0.21 * state.speed * dt); }
  return a;
}

export function rotationMatrices(state) {
  const { xy, xz, yz, xw, yw, zw } = state.angles;
  return {
    rot3: rotations(3, { xy, xz, yz }),
    rot4: isFourD(state.structure) ? rotations(4, { xw, yw, zw }) : null,
  };
}

// Part index per vertex from structure.partRanges; vertices added by subdivision inherit from a neighbour.
export function vertexParts(structure) {
  const n = structure.vertices.length, out = new Array(n).fill(-1);
  const ranges = structure.partRanges;
  if (!ranges) return out.fill(0);
  ranges.forEach((r, p) => { for (let i = r.from; i < r.to && i < n; i++) out[i] = p; });
  for (let pass = 0; pass < 4; pass++) {
    for (const [a, b] of structure.edges) {
      if (out[a] < 0 && out[b] >= 0) out[a] = out[b]; else if (out[b] < 0 && out[a] >= 0) out[b] = out[a];
    }
    if (!out.includes(-1)) break;
  }
  return out.map((p) => (p < 0 ? 0 : p));
}

// Base colour for an edge/face. colorMode "w": hue follows 4D depth (w in about [-1,1]); "part": per compound
// part; "single": state.hue. Returns { hue, sat, light }.
export function colorFor(state, structure, { edgeIndex = 0, w = null, partIndex = 0 } = {}) {
  void structure; void edgeIndex;
  if (state.colorMode === "w") {
    if (w == null) return { hue: state.hue, sat: 70, light: 62 };
    const t = Math.max(-1.5, Math.min(1.5, w));
    return { hue: (((state.hue + 90 * t) % 360) + 360) % 360, sat: 75, light: 62 };
  }
  if (state.colorMode === "part") return { hue: (state.hue + partIndex * 110) % 360, sat: 72, light: 62 };
  return { hue: state.hue, sat: 70, light: 62 };
}
