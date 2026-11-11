// Ripples and resonance. Two kinds, both pure and testable (no DOM):
//   • graph waves — travel along a structure's edges from an origin vertex using hop distances, so a ripple
//     "propagates through the surrounding geometry" and interferes with other waves (signed amplitudes add);
//   • rings — expand in screen space from a point into the empty field, blending colour where they overlap.
// A ripple keeps `meta` (the event that caused it) so even transient effects remain explorable.
import { hopDistances } from "../../geometry/src/structure.js";

export const DEFAULT_RIPPLE = { speed: 2.4, wavelength: 1.6, life: 4200, fade: 1.0, strength: 1 }; // speed in hops/second

export function mixHue(h1, h2, t) {
  let d = ((h2 - h1 + 540) % 360) - 180; // shortest arc
  return (((h1 + d * Math.max(0, Math.min(1, t))) % 360) + 360) % 360;
}

export class RippleField {
  constructor({ maxWaves = 48, maxRings = 64, defaults = {} } = {}) {
    this.maxWaves = maxWaves; this.maxRings = maxRings; this.defaults = { ...DEFAULT_RIPPLE, ...defaults };
    this.waves = []; this.rings = []; this.seq = 0;
  }
  // Wave along `structure` from vertex `origin` starting at time `born` (ms).
  addGraphWave(structure, origin, { born, hue = 200, strength, speed, wavelength, life, meta = null, sign = 1 } = {}) {
    const d = this.defaults;
    const wave = { id: `w${++this.seq}`, structureId: structure.id, origin, born, hue, sign, strength: strength ?? d.strength, speed: speed ?? d.speed, wavelength: wavelength ?? d.wavelength, life: life ?? d.life, hops: hopDistances(structure, origin), meta };
    this.waves.push(wave);
    if (this.waves.length > this.maxWaves) this.waves.splice(0, this.waves.length - this.maxWaves);
    return wave;
  }
  // Screen-space ring: centre in NDC, radius from r0 to r1 over `life` ms.
  addRing(centre, { born, hue = 200, life = 2600, r0 = 0.02, r1 = 0.9, alpha = 0.5, width = 1.5, meta = null } = {}) {
    const ring = { id: `r${++this.seq}`, centre: [...centre], born, hue, life, r0, r1, alpha, width, meta };
    this.rings.push(ring);
    if (this.rings.length > this.maxRings) this.rings.splice(0, this.rings.length - this.maxRings);
    return ring;
  }

  // Signed amplitude of one wave at a hop distance `h` at time t: a travelling crest with a soft envelope.
  static waveAt(w, h, t) {
    if (h < 0) return 0;
    const age = (t - w.born) / 1000; if (age < 0 || age * 1000 > w.life) return 0;
    const front = w.speed * age, x = (h - front) / w.wavelength; // 0 at the crest, negative behind, positive ahead
    if (x > 0.5 || x < -2.5) return 0;
    const env = Math.exp(-(x * x) * 1.6) * Math.exp(-age * 1000 / w.life * 2.2);
    return w.sign * w.strength * env * Math.cos(Math.PI * x);
  }
  // Interference: amplitudes of all waves on a structure at vertex i. Returns { amp, hue } where hue is the
  // amplitude-weighted blend of the contributing waves' hues (null when nothing is active).
  vertexState(structureId, i, t) {
    let amp = 0, wsum = 0, hue = null;
    for (const w of this.waves) {
      if (w.structureId !== structureId) continue;
      const a = RippleField.waveAt(w, w.hops[i], t); if (a === 0) continue;
      amp += a; const wgt = Math.abs(a);
      hue = hue == null ? w.hue : mixHue(hue, w.hue, wgt / (wsum + wgt)); wsum += wgt;
    }
    return { amp, hue, energy: wsum };
  }
  edgeState(structureId, a, b, t) {
    const sa = this.vertexState(structureId, a, t), sb = this.vertexState(structureId, b, t);
    return { amp: (sa.amp + sb.amp) / 2, energy: (sa.energy + sb.energy) / 2, hue: sa.hue == null ? sb.hue : sb.hue == null ? sa.hue : mixHue(sa.hue, sb.hue, 0.5) };
  }
  // Active rings with their current radius and alpha.
  activeRings(t) {
    const out = [];
    for (const r of this.rings) {
      const u = (t - r.born) / r.life; if (u < 0 || u > 1) continue;
      out.push({ ...r, radius: r.r0 + (r.r1 - r.r0) * Math.sqrt(u), alpha: r.alpha * (1 - u) * (1 - u), u });
    }
    return out;
  }
  // Where two rings overlap, colour blends: returns pairwise blended hues for the renderer's interference pass.
  interferences(t) {
    const act = this.activeRings(t), out = [];
    for (let i = 0; i < act.length; i++) for (let j = i + 1; j < act.length; j++) {
      const a = act[i], b = act[j], d = Math.hypot(a.centre[0] - b.centre[0], a.centre[1] - b.centre[1]);
      if (d < a.radius + b.radius && d > Math.abs(a.radius - b.radius)) out.push({ a: a.id, b: b.id, hue: mixHue(a.hue, b.hue, 0.5), alpha: Math.min(a.alpha, b.alpha), point: [(a.centre[0] + b.centre[0]) / 2, (a.centre[1] + b.centre[1]) / 2] });
    }
    return out;
  }
  prune(t) {
    this.waves = this.waves.filter((w) => t - w.born <= w.life);
    this.rings = this.rings.filter((r) => t - r.born <= r.life);
  }
  get size() { return { waves: this.waves.length, rings: this.rings.length }; }
}
