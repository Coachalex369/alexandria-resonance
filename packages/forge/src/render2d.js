// Canvas 2D wireframe/luminous-surface renderer for projected structures. Renderer only: it receives screen
// points (normalized device coordinates from @alexandria/geometry Camera) and draws edges, faces and nodes
// with depth cues and additive glow. A WebGL/Three.js renderer could replace this file without touching the
// geometry engine, composer or laboratory logic (see docs/FORGE.md "Rendering evaluation").

export function hsla(h, s, l, a = 1) { return `hsla(${((h % 360) + 360) % 360},${s}%,${l}%,${Math.max(0, Math.min(1, a))})`; }

export class WireRenderer {
  constructor(canvas, { background = "#05060a", glow = true, quality = 1 } = {}) {
    this.canvas = canvas; this.ctx = canvas.getContext("2d");
    this.background = background; this.glow = glow; this.quality = quality;
    this.dpr = 1; this.w = 0; this.h = 0; this.cx = 0; this.cy = 0; this.scale = 1;
    this.frameStats = { edges: 0, faces: 0, nodes: 0, ms: 0 };
  }
  resize(dpr = Math.min(2, globalThis.devicePixelRatio || 1)) {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr * this.quality)), h = Math.max(1, Math.round(rect.height * dpr * this.quality));
    if (w !== this.canvas.width || h !== this.canvas.height) { this.canvas.width = w; this.canvas.height = h; }
    this.dpr = dpr; this.w = w; this.h = h; this.cx = w / 2; this.cy = h / 2; this.scale = Math.min(w, h) / 2;
  }
  // NDC → pixels (y up in NDC, down on canvas)
  px(p) { return [this.cx + p.x * this.scale, this.cy - p.y * this.scale]; }

  begin() { const c = this.ctx; c.globalCompositeOperation = "source-over"; c.fillStyle = this.background; c.fillRect(0, 0, this.w, this.h); this.frameStats = { edges: 0, faces: 0, nodes: 0, ms: performance.now() }; }
  end() { this.frameStats.ms = performance.now() - this.frameStats.ms; return this.frameStats; }

  // Depth cue factor in [0.35, 1]: nearer points brighter. depth range is taken from the points supplied.
  static depthRange(screen) {
    let lo = Infinity, hi = -Infinity;
    for (const p of screen) if (p.visible) { if (p.depth < lo) lo = p.depth; if (p.depth > hi) hi = p.depth; }
    return hi > lo ? [lo, hi] : [lo, lo + 1];
  }
  cue(depth, [lo, hi]) { return 1 - 0.65 * Math.max(0, Math.min(1, (depth - lo) / (hi - lo))); }

  // Faces: translucent luminous fills, painter-sorted far → near. `faceStyle(faceIndex)` → { hue, sat, light, alpha } or null.
  drawFaces(screen, faces, faceStyle, { range = WireRenderer.depthRange(screen) } = {}) {
    const c = this.ctx, order = [];
    for (let i = 0; i < faces.length; i++) {
      const f = faces[i]; if (f.some((v) => !screen[v]?.visible)) continue;
      let d = 0; for (const v of f) d += screen[v].depth; order.push([d / f.length, i]);
    }
    order.sort((a, b) => b[0] - a[0]);
    c.globalCompositeOperation = "lighter";
    for (const [depth, i] of order) {
      const st = faceStyle(i); if (!st || st.alpha <= 0.002) continue;
      const f = faces[i], k = this.cue(depth, range);
      c.beginPath();
      const [x0, y0] = this.px(screen[f[0]]); c.moveTo(x0, y0);
      for (let j = 1; j < f.length; j++) { const [x, y] = this.px(screen[f[j]]); c.lineTo(x, y); }
      c.closePath();
      c.fillStyle = hsla(st.hue, st.sat, st.light, st.alpha * k);
      c.fill(); this.frameStats.faces++;
    }
  }

  // Edges: additive glow pass (wide, faint) plus core pass (thin, bright). `edgeStyle(edgeIndex)` → { hue, sat, light, alpha, width } or null.
  drawEdges(screen, edges, edgeStyle, { range = WireRenderer.depthRange(screen), glow = this.glow } = {}) {
    const c = this.ctx;
    c.globalCompositeOperation = "lighter"; c.lineCap = "round";
    const passes = glow ? [[3.2, 0.16], [1, 1]] : [[1, 1]];
    for (const [wmul, amul] of passes) {
      for (let i = 0; i < edges.length; i++) {
        const [a, b] = edges[i]; const pa = screen[a], pb = screen[b]; if (!pa?.visible || !pb?.visible) continue;
        const st = edgeStyle(i); if (!st || st.alpha <= 0.002) continue;
        const k = this.cue((pa.depth + pb.depth) / 2, range);
        c.strokeStyle = hsla(st.hue, st.sat, st.light, st.alpha * amul * k);
        c.lineWidth = Math.max(0.4, (st.width ?? 1.2) * wmul * k * this.dpr);
        const [x0, y0] = this.px(pa), [x1, y1] = this.px(pb);
        c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
        if (amul === 1) this.frameStats.edges++;
      }
    }
  }

  // Nodes: small radial glows. `nodeStyle(vertexIndex)` → { hue, sat, light, alpha, radius } or null.
  drawNodes(screen, nodeStyle, { range = WireRenderer.depthRange(screen) } = {}) {
    const c = this.ctx; c.globalCompositeOperation = "lighter";
    for (let i = 0; i < screen.length; i++) {
      const p = screen[i]; if (!p.visible) continue;
      const st = nodeStyle(i); if (!st || st.alpha <= 0.002) continue;
      const k = this.cue(p.depth, range), [x, y] = this.px(p), r = (st.radius ?? 2.2) * k * this.dpr;
      const g = c.createRadialGradient(x, y, 0, x, y, r * 3);
      g.addColorStop(0, hsla(st.hue, st.sat, Math.min(96, st.light + 25), st.alpha * k));
      g.addColorStop(0.35, hsla(st.hue, st.sat, st.light, st.alpha * 0.5 * k));
      g.addColorStop(1, hsla(st.hue, st.sat, st.light, 0));
      c.fillStyle = g; c.beginPath(); c.arc(x, y, r * 3, 0, Math.PI * 2); c.fill(); this.frameStats.nodes++;
    }
  }

  // Expanding ring in screen space (ripples that leave the geometry). centre is NDC, radius in NDC units.
  drawRing(centre, radius, { hue, sat = 70, light = 65, alpha = 0.4, width = 1.5 }) {
    const c = this.ctx; const [x, y] = this.px(centre);
    c.globalCompositeOperation = "lighter";
    c.strokeStyle = hsla(hue, sat, light, alpha); c.lineWidth = width * this.dpr;
    c.beginPath(); c.arc(x, y, Math.max(0, radius * this.scale), 0, Math.PI * 2); c.stroke();
  }

  // Composite an offscreen layer (e.g. the persistent trace field) with the given alpha.
  drawLayer(source, alpha = 1, composite = "lighter") {
    const c = this.ctx; c.globalCompositeOperation = composite; c.globalAlpha = alpha; c.drawImage(source, 0, 0, this.w, this.h); c.globalAlpha = 1;
  }

  // Nearest projected vertex to a canvas pixel position (for inspection). Returns { index, dist } or null.
  pick(screen, clientX, clientY, maxPx = 14) {
    const rect = this.canvas.getBoundingClientRect();
    const x = (clientX - rect.left) * (this.w / rect.width), y = (clientY - rect.top) * (this.h / rect.height);
    let best = null;
    for (let i = 0; i < screen.length; i++) { const p = screen[i]; if (!p.visible) continue; const [px, py] = this.px(p); const d = Math.hypot(px - x, py - y); if (d <= maxPx * this.dpr && (!best || d < best.dist)) best = { index: i, dist: d }; }
    return best;
  }
}
