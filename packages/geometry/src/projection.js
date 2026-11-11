// Projections and camera. 4D → 3D (perspective from a viewpoint on the +w axis, or orthographic drop of w),
// then 3D → 2D through an orbiting camera (perspective or orthographic). Output is in normalized device
// coordinates: x,y in [-1,1] for the visible square, depth = distance along the view axis (larger = farther),
// plus the 4D depth (w) when it exists so renderers can colour or thin edges by it.
import { sub, cross, normalize, dot, scale, add } from "./vec.js";

// Perspective 4D→3D: a viewer at w = distance looking toward the origin. Points nearer the viewer (larger w)
// appear larger. Orthographic: w is dropped. Returns [x, y, z] and keeps w in the 4th slot for depth cues.
export function project4to3(v, { mode = "perspective", distance = 3 } = {}) {
  const [x, y, z, w] = v;
  if (mode === "orthographic") return [x, y, z, w];
  const f = distance / Math.max(1e-3, distance - w);
  return [x * f, y * f, z * f, w];
}
export const projectAll4to3 = (pts, opts) => pts.map((p) => project4to3(p, opts));

export class Camera {
  constructor({ azimuth = 0.6, elevation = 0.35, distance = 4, target = [0, 0, 0], fov = 0.9, mode = "perspective", zoom = 1, up = [0, 1, 0] } = {}) {
    Object.assign(this, { azimuth, elevation, distance, target: [...target], fov, mode, zoom, up: [...up] });
  }
  get position() {
    const ce = Math.cos(this.elevation);
    return add(this.target, scale([ce * Math.sin(this.azimuth), Math.sin(this.elevation), ce * Math.cos(this.azimuth)], this.distance));
  }
  orbit(dAz, dEl) { this.azimuth += dAz; this.elevation = Math.max(-1.55, Math.min(1.55, this.elevation + dEl)); return this; }
  dolly(factor) { this.distance = Math.max(0.5, Math.min(60, this.distance * factor)); return this; }
  // Camera basis: right, up, back (view axis points from target to camera).
  basis() {
    const back = normalize(sub(this.position, this.target));
    let right = cross(this.up, back); if (dot(right, right) < 1e-9) right = [1, 0, 0]; right = normalize(right);
    const up = cross(back, right);
    return { right, up, back };
  }
  // Project one 3D point → { x, y, depth, visible }. depth = distance from the camera along the view axis.
  project(p, basis = this.basis()) {
    const rel = sub(p, this.position);
    const xc = dot(rel, basis.right), yc = dot(rel, basis.up), zc = -dot(rel, basis.back); // zc > 0 in front
    if (this.mode === "orthographic") { const s = this.zoom / this.distance * 2; return { x: xc * s, y: yc * s, depth: zc, visible: true }; }
    const focal = this.zoom / Math.tan(this.fov / 2);
    if (zc < 0.05) return { x: 0, y: 0, depth: zc, visible: false };
    return { x: (xc * focal) / zc, y: (yc * focal) / zc, depth: zc, visible: true };
  }
  projectAll(pts) { const b = this.basis(); return pts.map((p) => this.project(p, b)); }
  toJSON() { const { azimuth, elevation, distance, target, fov, mode, zoom } = this; return { azimuth, elevation, distance, target, fov, mode, zoom }; }
}

// Full pipeline for a Structure: optional 4D rotation matrix → 4D→3D projection → optional 3D matrix →
// camera. Returns screen points aligned with structure.vertices plus per-vertex 3D positions.
export function projectStructure(s, { camera, rot4 = null, rot3 = null, proj4 = {} } = {}) {
  let pts3;
  let w = null;
  if (s.dim === 4) {
    const rotated = rot4 ? s.vertices.map((v) => rot4.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2] + row[3] * v[3])) : s.vertices;
    const p = projectAll4to3(rotated, proj4);
    pts3 = p.map((q) => [q[0], q[1], q[2]]); w = p.map((q) => q[3]);
  } else pts3 = s.vertices;
  if (rot3) pts3 = pts3.map((v) => rot3.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]));
  const screen = camera.projectAll(pts3);
  return { screen, points3: pts3, w };
}
