// Renderer-neutral frame buffer. World-space primitives are accumulated into reusable typed arrays so a
// renderer (WebGL or Canvas fallback) can draw them without per-frame allocation. No DOM, no dependencies.

export function hslToRgb(h, s, l) {
  const hh = ((((h % 360) + 360) % 360)) / 360, ss = s / 100, ll = l / 100;
  const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss, p = 2 * ll - q;
  const f = (t) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(hh + 1 / 3), f(hh), f(hh - 1 / 3)];
}

export class FrameBuilder {
  constructor({ maxLines = 60000, maxTriangles = 60000, maxPoints = 20000 } = {}) {
    this.maxLines = maxLines; this.maxTriangles = maxTriangles; this.maxPoints = maxPoints;
    this._lp = new Float32Array(maxLines * 6); this._lc = new Float32Array(maxLines * 6); this._lw = new Float32Array(maxLines);
    this._fp = new Float32Array(maxTriangles * 9); this._fc = new Float32Array(maxTriangles * 9);
    this._pp = new Float32Array(maxPoints * 3); this._pc = new Float32Array(maxPoints * 3); this._ps = new Float32Array(maxPoints);
    this._out = {
      lines: { count: 0, positions: this._lp, colors: this._lc, widths: this._lw },
      faces: { count: 0, positions: this._fp, colors: this._fc },
      points: { count: 0, positions: this._pp, colors: this._pc, sizes: this._ps },
    };
    this._n = { lines: 0, faces: 0, points: 0, dropped: 0 };
  }
  reset() { const n = this._n; n.lines = 0; n.faces = 0; n.points = 0; n.dropped = 0; }
  line(a, b, rgb, alpha = 1, width = 1) {
    const n = this._n;
    if (n.lines >= this.maxLines) { n.dropped++; return; }
    const i = n.lines++, o = i * 6, p = this._lp, c = this._lc;
    p[o] = a[0]; p[o + 1] = a[1]; p[o + 2] = a[2]; p[o + 3] = b[0]; p[o + 4] = b[1]; p[o + 5] = b[2];
    const r = rgb[0] * alpha, g = rgb[1] * alpha, bl = rgb[2] * alpha;
    c[o] = r; c[o + 1] = g; c[o + 2] = bl; c[o + 3] = r; c[o + 4] = g; c[o + 5] = bl;
    this._lw[i] = width;
  }
  polyline(points, rgb, alpha = 1, width = 1) {
    for (let i = 1; i < points.length; i++) this.line(points[i - 1], points[i], rgb, alpha, width);
  }
  tri(a, b, c, rgb, alpha = 1) {
    const n = this._n;
    if (n.faces >= this.maxTriangles) { n.dropped++; return; }
    const o = n.faces++ * 9, p = this._fp, col = this._fc;
    p[o] = a[0]; p[o + 1] = a[1]; p[o + 2] = a[2]; p[o + 3] = b[0]; p[o + 4] = b[1]; p[o + 5] = b[2]; p[o + 6] = c[0]; p[o + 7] = c[1]; p[o + 8] = c[2];
    const r = rgb[0] * alpha, g = rgb[1] * alpha, bl = rgb[2] * alpha;
    for (let k = 0; k < 9; k += 3) { col[o + k] = r; col[o + k + 1] = g; col[o + k + 2] = bl; }
  }
  polygon(points, rgb, alpha = 1) {
    for (let i = 1; i + 1 < points.length; i++) this.tri(points[0], points[i], points[i + 1], rgb, alpha);
  }
  point(p, rgb, alpha = 1, size = 0.05) {
    const n = this._n;
    if (n.points >= this.maxPoints) { n.dropped++; return; }
    const i = n.points++, o = i * 3;
    this._pp[o] = p[0]; this._pp[o + 1] = p[1]; this._pp[o + 2] = p[2];
    this._pc[o] = rgb[0] * alpha; this._pc[o + 1] = rgb[1] * alpha; this._pc[o + 2] = rgb[2] * alpha;
    this._ps[i] = size;
  }
  ring(centre, normal, radius, rgb, alpha = 1, width = 1) {
    const SEG = 48;
    let nx = normal[0], ny = normal[1], nz = normal[2];
    const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
    // any vector not parallel to the normal, then an orthonormal basis (u, v) of the ring plane
    let ax = 0, ay = 0, az = 0;
    if (Math.abs(nx) <= Math.abs(ny) && Math.abs(nx) <= Math.abs(nz)) ax = 1; else if (Math.abs(ny) <= Math.abs(nz)) ay = 1; else az = 1;
    let ux = ny * az - nz * ay, uy = nz * ax - nx * az, uz = nx * ay - ny * ax;
    const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
    const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
    let prev = null;
    for (let i = 0; i <= SEG; i++) {
      const t = (i / SEG) * Math.PI * 2, c = Math.cos(t) * radius, s = Math.sin(t) * radius;
      const cur = i === SEG ? first : [centre[0] + ux * c + vx * s, centre[1] + uy * c + vy * s, centre[2] + uz * c + vz * s];
      if (i === 0) var first = cur;
      if (prev) this.line(prev, cur, rgb, alpha, width);
      prev = cur;
    }
  }
  build() {
    const o = this._out, n = this._n;
    o.lines.count = n.lines; o.faces.count = n.faces; o.points.count = n.points;
    return o;
  }
  get counts() { const n = this._n; return { lines: n.lines, faces: n.faces, points: n.points, dropped: n.dropped }; }
}
