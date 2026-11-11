// Camera director for "as above, so below": the camera tells the story of discovery. Pure and DOM-free: given
// the composition's milestones and the elapsed scene time it produces an orbit camera pose (azimuth, elevation,
// distance, target). Phases advance on composition milestones (with a minimum dwell), and as a fallback on
// replay progress so a recording without a milestone still completes the arc:
//   A grounded    near-ground view of the origin and the spreading plane (architecture)
//   B curiosity   gentle lateral drift and rotation; depth appears (first structures rise)
//   C revelation  the camera gains height and swings beneath the plane: geometry below is revealed
//   D expansion   a slow, deliberate orbit at varying height around the whole multidimensional structure
//   E completion  settles into a three-quarter view framing the entire artwork
// Reduced motion: no continuous orbit; the camera eases to each phase's pose and rests. Manual control pauses
// the director; `ground()` and `overview()` return fixed poses the page can ease to.
export const PHASES = ["grounded", "curiosity", "revelation", "expansion", "completion"];

export const DEFAULT_PHASE_RULES = {
  minDwellSec: { grounded: 14, curiosity: 16, revelation: 24, expansion: 20, completion: 0 },
  fallbackProgress: { curiosity: 0.18, revelation: 0.38, expansion: 0.62 },
};

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const smooth = (x) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
const approach = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

export class CameraDirector {
  constructor({ reduced = false, rules = DEFAULT_PHASE_RULES, start = { azimuth: 0.6, elevation: 0.06, distance: 7.5, target: [0, 0.4, 0] } } = {}) {
    this.reduced = reduced; this.rules = rules;
    this.phase = "grounded"; this.phaseIndex = 0; this.phaseStart = 0; this.t = 0;
    this.pose = { azimuth: start.azimuth, elevation: start.elevation, distance: start.distance, target: [...start.target] };
    this.manual = false; this.history = [{ phase: "grounded", t: 0, reason: "start" }];
  }

  // Decide the phase from milestones (scene ms), progress (0..1 of the replay) and extent; returns the pose.
  update(dt, { milestones = {}, progress = 0, extent = { radius: 3, yMin: -1, yMax: 1 }, resolved = false, time = null } = {}) {
    this.t += dt; if (time != null) this.t = time;
    this.advance(milestones, progress, resolved);
    const target = this.poseFor(this.phase, extent, this.t - this.phaseStart);
    if (this.manual) return this.pose;
    const rate = this.reduced ? 1.2 : 0.7, ds = dt / 1000; // per-second rates; dt arrives in ms
    const p = this.pose;
    p.elevation = approach(p.elevation, target.elevation, rate, ds);
    p.distance = approach(p.distance, target.distance, rate * 0.8, ds);
    p.target = p.target.map((v, i) => approach(v, target.target[i], rate, ds));
    p.azimuth = approach(p.azimuth, target.azimuth, this.reduced ? rate : rate * 0.8, ds);
    return p;
  }

  advance(m, progress, resolved) {
    const dwell = (this.t - this.phaseStart) / 1000, R = this.rules;
    const go = (phase, reason) => { if (PHASES.indexOf(phase) <= this.phaseIndex) return; this.phase = phase; this.phaseIndex = PHASES.indexOf(phase); this.phaseStart = this.t; this.history.push({ phase, t: this.t, reason }); };
    if (resolved || m.resolved) { go("completion", "objective completed"); return; }
    const can = (phase) => dwell >= (R.minDwellSec[this.phase] ?? 0) && PHASES.indexOf(phase) === this.phaseIndex + 1;
    if (this.phase === "grounded" && can("curiosity") && (m.firstCrystal || m.firstAgent || progress >= R.fallbackProgress.curiosity)) go("curiosity", m.firstCrystal ? "first structure rises" : m.firstAgent ? "first agent arrives" : "progress");
    if (this.phase === "curiosity" && can("revelation") && (m.firstBelow || progress >= R.fallbackProgress.revelation)) go("revelation", m.firstBelow ? "geometry beneath the plane" : "progress");
    if (this.phase === "revelation" && can("expansion") && (m.firstPass || m.firstCommit || progress >= R.fallbackProgress.expansion)) go("expansion", m.firstPass ? "first verification" : m.firstCommit ? "first commit" : "progress");
  }

  // Target pose for a phase at `since` ms into it. Distances scale with the composition's extent.
  poseFor(phase, extent, since) {
    const s = since / 1000, R = Math.max(2.5, extent.radius), depth = Math.max(1, extent.yMax - extent.yMin);
    const drift = this.reduced ? 0 : 1;
    switch (phase) {
      case "grounded": return { azimuth: 0.6 + drift * 0.12 * Math.sin(s * 0.08), elevation: 0.06 + drift * 0.015 * Math.sin(s * 0.11), distance: 1.3 * R + 4.2, target: [0, 0.45, 0] };
      case "curiosity": return { azimuth: 0.6 + drift * (0.045 * s), elevation: 0.17 + drift * 0.03 * Math.sin(s * 0.09), distance: 1.35 * R + 4.6, target: [0, 0.5, 0] };
      case "revelation": { // climb, then sweep beneath the plane and back up, again and again: the ground is only one plane
        const climb = smooth(clamp(s / 8, 0, 1)), dip = s > 8 ? smooth(0.5 - 0.5 * Math.cos(TAU * (s - 8) / 48)) : 0; // a dip every 48 s
        const el = 0.55 * climb - 0.95 * dip;
        return { azimuth: 1.3 + drift * 0.07 * s, elevation: this.reduced ? -0.25 : clamp(el, -0.42, 0.6), distance: 1.6 * R + 5 + 0.6 * depth, target: [0, 0.2 - 0.25 * depth * dip, 0] };
      }
      case "expansion": return { azimuth: 3.0 + drift * 0.05 * s, elevation: this.reduced ? 0.3 : 0.12 + 0.42 * Math.sin(s * 0.07 + 1), distance: 1.5 * R + 4 + 0.6 * depth, target: [0, 0.5 * (extent.yMax + extent.yMin), 0] };
      case "completion": default: return { azimuth: this.pose.azimuth + (this.reduced ? 0 : 0.012 * Math.sin(s * 0.05)), elevation: 0.38, distance: 1.45 * R + 3.5 + 0.7 * depth, target: [0, 0.4 * (extent.yMax + extent.yMin), 0] };
    }
  }

  // Fixed poses the presentation can ease to; both pause the director.
  ground(extent) { this.manual = true; return { azimuth: this.pose.azimuth, elevation: 0.05, distance: 1.3 * Math.max(2.5, extent.radius) + 4.2, target: [0, 0.45, 0] }; }
  overview(extent) { this.manual = true; return { azimuth: this.pose.azimuth, elevation: 1.25, distance: 2.2 * Math.max(2.5, extent.radius) + 4, target: [0, 0, 0] }; }
  resume(fromPose) { this.manual = false; if (fromPose) this.pose = { ...fromPose, target: [...fromPose.target] }; }
  state() { return { phase: this.phase, phaseIndex: this.phaseIndex, since: this.t - this.phaseStart, manual: this.manual, reduced: this.reduced, history: this.history.slice() }; }
}
