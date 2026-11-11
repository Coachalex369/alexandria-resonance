// Vector and matrix mathematics for N dimensions (3 and 4 in practice). Plain arrays, no classes, no
// dependencies, Node- and browser-safe. Matrices are row-major arrays of rows: m[r][c]. A rotation in the
// plane spanned by axes i and j is the only primitive needed to rotate in any dimension; 3D rotations are
// the planes (1,2)=x-axis, (0,2)=y-axis, (0,1)=z-axis and 4D adds the three planes that involve w.

export const EPS = 1e-9;

export const add = (a, b) => a.map((v, i) => v + b[i]);
export const sub = (a, b) => a.map((v, i) => v - b[i]);
export const scale = (a, s) => a.map((v) => v * s);
export const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
export const length = (a) => Math.sqrt(dot(a, a));
export const distance = (a, b) => length(sub(a, b));
export const normalize = (a) => { const l = length(a); return l < EPS ? a.map(() => 0) : scale(a, 1 / l); };
export const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
export const negate = (a) => a.map((v) => -v);
export const centroid = (pts) => pts.length ? scale(pts.reduce((s, p) => add(s, p), pts[0].map(() => 0)), 1 / pts.length) : [];
export const approxEqual = (a, b, eps = 1e-9) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= eps);

// 3D only
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// ---- matrices (square, n×n) ----
export const identity = (n) => Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => (r === c ? 1 : 0)));

export function multiply(a, b) {
  const n = a.length, m = b[0].length, k = b.length;
  const out = Array.from({ length: n }, () => new Array(m).fill(0));
  for (let r = 0; r < n; r++) for (let c = 0; c < m; c++) { let s = 0; for (let i = 0; i < k; i++) s += a[r][i] * b[i][c]; out[r][c] = s; }
  return out;
}
export const compose = (...ms) => ms.reduce((acc, m) => multiply(m, acc)); // apply left-to-right: compose(A,B) applies A then B
export const transpose = (m) => m[0].map((_, c) => m.map((row) => row[c]));
export const apply = (m, v) => m.map((row) => dot(row, v));
export const applyAll = (m, pts) => pts.map((p) => apply(m, p));

// Rotation by `angle` in the plane of axes i and j (Givens rotation). Right-handed for (i<j).
export function rotation(n, i, j, angle) {
  const m = identity(n), c = Math.cos(angle), s = Math.sin(angle);
  m[i][i] = c; m[j][j] = c; m[i][j] = -s; m[j][i] = s;
  return m;
}
// Named planes. 3D: "xy" (about z), "xz" (about y), "yz" (about x). 4D adds "xw", "yw", "zw".
export const AXES = ["x", "y", "z", "w"];
export const PLANES_3D = ["xy", "xz", "yz"];
export const PLANES_4D = ["xy", "xz", "yz", "xw", "yw", "zw"];
export function rotationPlane(n, plane, angle) {
  const i = AXES.indexOf(plane[0]), j = AXES.indexOf(plane[1]);
  if (i < 0 || j < 0 || i >= n || j >= n || i === j) throw new Error(`bad plane ${plane} for dimension ${n}`);
  return rotation(n, Math.min(i, j), Math.max(i, j), i < j ? angle : -angle);
}
// Several plane rotations at once: { xy: a, zw: b, ... } composed in key order.
export function rotations(n, angles) {
  let m = identity(n);
  for (const [plane, a] of Object.entries(angles)) if (a) m = multiply(rotationPlane(n, plane, a), m);
  return m;
}
export const scaling = (n, s) => identity(n).map((row, r) => row.map((v, c) => (r === c ? (Array.isArray(s) ? s[r] : s) : 0)));

// 3D rotation about an arbitrary unit axis (Rodrigues).
export function rotationAxis3(axis, angle) {
  const [x, y, z] = normalize(axis), c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ];
}

export function determinant(m) {
  const n = m.length;
  if (n === 1) return m[0][0];
  if (n === 2) return m[0][0] * m[1][1] - m[0][1] * m[1][0];
  let d = 0;
  for (let c = 0; c < n; c++) {
    const minor = m.slice(1).map((row) => row.filter((_, cc) => cc !== c));
    d += (c % 2 ? -1 : 1) * m[0][c] * determinant(minor);
  }
  return d;
}
export function isOrthonormal(m, eps = 1e-9) {
  const p = multiply(m, transpose(m)), n = m.length;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (Math.abs(p[r][c] - (r === c ? 1 : 0)) > eps) return false;
  return true;
}
