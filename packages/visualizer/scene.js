// Scene model for the Alexandria geometric visualizer. Renderer-independent and DOM-free:
// feed it events (ingest) and time (primitives) and it returns drawable primitives in unit space
// (origin at the centre, x right, y down, the visible disc has radius 1). Canvas (viz.js) or a future
// WebGL renderer only has to draw these primitives.
//
// All times are in scene milliseconds supplied by the caller (wall clock, frozen while paused).
import { hintsFor } from "../taxonomy/src/index.js";

export const DEFAULT_MAPPING = {
  categoryHue: {},
  shapeSizes: { default: 0.035 },
  motionSpeeds: {},
  layerOpacity: { persistent: 0.85, continuous: 1, lanes: 0.55 },
  timing: { intervalWindow: 8, minPeriodMs: 180, maxPeriodMs: 2400, elementLifeMs: [1000, 3600], laneResolveMs: 1400 },
  palettes: { active: "taxonomy", presets: { taxonomy: { hueShift: 0, saturation: 72, lightness: 62, neutralHue: 210, neutralSaturation: 14, subagentLightnessDelta: -14, subagentSaturationScale: 0.75, subagentAlpha: 0.65, failHue: 2, background: "#07090d" } } },
};

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// Deterministic 32-bit FNV-1a hash -> [0,1)
export function hash01(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return (h >>> 0) / 4294967296;
}

export function mergeMapping(overrides = {}) {
  const m = DEFAULT_MAPPING;
  return {
    categoryHue: { ...m.categoryHue, ...(overrides.categoryHue || {}) },
    shapeSizes: { ...m.shapeSizes, ...(overrides.shapeSizes || {}) },
    motionSpeeds: { ...m.motionSpeeds, ...(overrides.motionSpeeds || {}) },
    layerOpacity: { ...m.layerOpacity, ...(overrides.layerOpacity || {}) },
    timing: { ...m.timing, ...(overrides.timing || {}) },
    palettes: {
      active: overrides.palettes?.active || m.palettes.active,
      presets: { ...m.palettes.presets, ...(overrides.palettes?.presets || {}) },
    },
  };
}

// Motion curves. u in [0,1) is progress through the element's life. Each returns parts:
// { dr, da (polar offsets from the spawn point), scale, rot, alpha }.
const MOTIONS = {
  drift: (u) => [{ dr: 0.12 * u, da: 0.1 * u, scale: 1, rot: 0, alpha: 1 - u }],
  sweep: (u) => [{ dr: 0, da: 1.3 * u, scale: 1, rot: 0, alpha: Math.sin(Math.PI * u) }],
  pulse: (u) => [{ dr: 0, da: 0, scale: 1 + 0.5 * Math.sin(3 * Math.PI * u), rot: 0, alpha: 1 - 0.7 * u }],
  bloom: (u) => [{ dr: 0, da: 0, scale: 0.4 + 1.8 * u, rot: 0, alpha: Math.pow(1 - u, 1.5) }],
  spin: (u) => [{ dr: 0, da: 0.3 * u, scale: 1, rot: TAU * 2 * u, alpha: 1 - u }],
  split: (u) => [{ dr: 0, da: 0.4 * u, scale: 1 - 0.3 * u, rot: 0, alpha: 1 - u }, { dr: 0, da: -0.4 * u, scale: 1 - 0.3 * u, rot: 0, alpha: 1 - u }],
  hold: (u) => [{ dr: 0, da: 0, scale: 1, rot: 0, alpha: Math.min(1, u * 8) * (1 - u * u * u) * 0.8 }],
  flash: (u) => [{ dr: 0, da: 0, scale: 0.6 + 0.8 * u, rot: 0, alpha: Math.pow(1 - u, 3) }],
  stack: (u) => [{ dr: 0.04 * Math.floor(u * 4), da: 0, scale: 1, rot: 0, alpha: 1 - 0.6 * u }],
  seal: (u) => [{ dr: 0, da: 0, scale: 2 - Math.min(1, u * 3), rot: u * 0.8, alpha: Math.min(1, u * 6) * (1 - u * u) }],
  tick: (u) => [{ dr: 0.02 * u, da: 0, scale: 0.5, rot: 0, alpha: (Math.floor(u * 6) % 2 === 0 ? 1 : 0.25) * (1 - u) }],
};

export class Scene {
  constructor({ mapping = {}, hints = hintsFor } = {}) {
    this.mapping = mergeMapping(mapping);
    this.hints = hints;
    this.reset();
  }

  reset() {
    this.elements = [];        // short-lived continuous-layer elements
    this.lanes = new Map();    // active subagent lanes by agentId
    this.laneLog = [];         // history of lane open/close (never pruned)
    this.marks = [];           // persistent composition layer (append-only)
    this.markBuckets = new Map();
    this.intervals = [];       // recent wall-time gaps between events
    this.lastEventAt = null;
    this.lastTick = null;
    this.mainTheta = 0;
    this.completed = false;     // task.end seen (closing frame)
    this.frameBorn = null;
    this.turnComplete = false;  // main-thread turn.stop seen (soft completion)
    this.turnBorn = null;
    this.waiting = false;
    this.dim = 1;               // smoothed dim factor (1 normal, <1 waiting)
    this.pulses = [];           // one-shot expanding rings (turn complete, task end, commit, tests)
    this.stats = { elementsCreated: 0, lanesOpened: 0, lanesClosed: 0, marksTotal: 0, eventsSeen: 0 };
  }

  get palette() { return this.mapping.palettes.presets[this.mapping.palettes.active] || Object.values(this.mapping.palettes.presets)[0]; }
  setPalette(name) { if (this.mapping.palettes.presets[name]) this.mapping.palettes.active = name; }

  // Pulse period (ms) from the mean of the last N inter-event gaps.
  get period() {
    const t = this.mapping.timing;
    if (!this.intervals.length) return 900;
    const mean = this.intervals.reduce((a, b) => a + b, 0) / this.intervals.length;
    return clamp(mean * 2, t.minPeriodMs, t.maxPeriodMs);
  }

  classify(e) {
    const cls = e.classification || [];
    const best = (scheme) => cls.filter((c) => c.scheme === scheme).sort((a, b) => b.confidence - a.confidence)[0]?.value || null;
    const category = best("work-category");
    const operation = best("operation");
    const structure = best("code-structure");
    const catHints = category ? this.hints("work-category", category) : {};
    const motion = (operation && this.hints("operation", operation).motion) || "drift";
    const hue = this.mapping.categoryHue[category] ?? catHints.hue ?? null;
    const shape = catHints.shape || (structure ? this.hints("code-structure", structure).geometry : null) || "ring";
    return { category, operation, structure, hue, shape, motion };
  }

  color(hue, { sub = false, failed = false } = {}) {
    const p = this.palette;
    if (failed) return { hue: p.failHue, sat: p.saturation, light: p.lightness, alpha: sub ? p.subagentAlpha : 1 };
    const neutral = hue == null;
    const h = neutral ? p.neutralHue : (hue + p.hueShift + 360) % 360;
    let s = neutral ? p.neutralSaturation : p.saturation;
    let l = p.lightness;
    let a = 1;
    if (sub) { l += p.subagentLightnessDelta; s *= p.subagentSaturationScale; a = p.subagentAlpha; }
    return { hue: h, sat: s, light: l, alpha: a };
  }

  noteEvent(now) {
    if (this.lastEventAt != null) {
      const gap = now - this.lastEventAt;
      if (gap > 0) { this.intervals.push(gap); if (this.intervals.length > this.mapping.timing.intervalWindow) this.intervals.shift(); }
    }
    this.lastEventAt = now;
  }

  openLane(agentId, now, agentType) {
    if (this.lanes.has(agentId)) return this.lanes.get(agentId);
    const used = new Set([...this.lanes.values()].map((l) => l.index));
    let index = 0; while (used.has(index)) index++;
    const lane = { agentId, agentType, index, radius: 0.5 + 0.1 * index, openedAt: now, closedAt: null,
      theta: hash01("lane|" + agentId) * TAU, phaseOffset: hash01("phase|" + agentId) * TAU, hue: Math.floor(hash01("hue|" + agentId) * 360) };
    this.lanes.set(agentId, lane);
    this.laneLog.push({ agentId, openedAt: now, closedAt: null });
    this.stats.lanesOpened++;
    return lane;
  }

  closeLane(agentId, now) {
    const lane = this.lanes.get(agentId);
    if (!lane || lane.closedAt != null) return;
    lane.closedAt = now;
    const log = this.laneLog.find((l) => l.agentId === agentId && l.closedAt == null);
    if (log) log.closedAt = now;
    this.stats.lanesClosed++;
  }

  // Feed one event. `quiet` (seek fast-forward / catch-up) updates persistent state only, no animation.
  ingest(e, now, { quiet = false, delay = 0 } = {}) {
    const at = now + delay;
    this.stats.eventsSeen++;
    const sub = e.actor?.type === "subagent";
    if (!quiet) this.noteEvent(now);
    switch (e.kind) {
      case "agent.start": this.openLane(e.actor.agentId, at, e.actor.agentType); break;
      case "agent.stop": this.closeLane(e.actor.agentId, at); break; // resolves the lane only, never completion
      case "notification":
        if (e.payload?.kind === "permission_prompt") this.waiting = true;
        break;
      case "prompt.submit": this.waiting = false; this.turnComplete = false; break;
      case "tool.call": case "tool.result": case "tool.failure": {
        const failed = e.kind === "tool.failure";
        if (e.kind !== "tool.call") this.waiting = false;
        const c = this.classify(e);
        let lane = null;
        if (sub && e.actor.agentId) lane = this.lanes.get(e.actor.agentId) || this.openLane(e.actor.agentId, at, e.actor.agentType);
        if (!quiet) this.spawn(e, c, lane, failed, at);
        if (e.kind !== "tool.call") this.addMark(e, c, sub, failed, at, failed ? "tool-fail" : "tool");
        break;
      }
      case "test.run": {
        const ok = e.payload?.ok === true;
        const c = this.classify(e);
        this.addMark(e, { ...c, category: c.category || "testing", shape: "ring" }, sub, !ok, at, ok ? "test-pass" : "test-fail");
        if (!quiet) this.pulses.push({ born: at, hue: ok ? 120 : this.palette.failHue, life: 1400, r0: 0.1, r1: 0.9 });
        break;
      }
      case "git.commit": {
        this.addMark(e, { category: "commit", hue: 48, shape: "ring", operation: "commit", motion: "seal" }, false, false, at, "commit");
        if (!quiet) this.pulses.push({ born: at, hue: 48, life: 1600, r0: 0.9, r1: 0.1 });
        break;
      }
      case "turn.stop":
        if (!sub) { this.turnComplete = true; this.turnBorn = at; if (!quiet) this.pulses.push({ born: at, hue: 150, life: 1800, r0: 0.05, r1: 1.0 }); }
        break;
      case "task.end":
        this.completed = true; this.frameBorn = at; this.turnComplete = true; this.turnBorn = at;
        if (!quiet) this.pulses.push({ born: at, hue: 150, life: 2200, r0: 0.05, r1: 1.05 });
        break;
      case "task.start": this.completed = false; this.frameBorn = null; break;
      default: break;
    }
  }

  spawn(e, c, lane, failed, at) {
    const t = this.mapping.timing;
    const life = clamp(this.period * 4, t.elementLifeMs[0], t.elementLifeMs[1]);
    const key = (lane ? lane.agentId : "main") + "|" + (c.category || c.operation || "x");
    this.elements.push({
      id: e.id, born: at, life, speed: this.mapping.motionSpeeds[c.motion] ?? 1, motion: c.motion, shape: c.shape, hue: c.hue, failed,
      lane: lane ? lane.agentId : null,
      r0: lane ? lane.radius : 0.12 + 0.3 * hash01(key + "|r"),
      a0: lane ? (hash01(e.id) - 0.5) * 0.9 : hash01(key + "|a") * TAU,
      size: this.mapping.shapeSizes[c.shape] ?? this.mapping.shapeSizes.default,
      call: e.kind === "tool.call",
    });
    this.stats.elementsCreated++;
  }

  addMark(e, c, sub, failed, at, kind) {
    const actor = sub ? e.actor.agentId || "sub" : "main";
    const cat = c.category || c.operation || "other";
    const bucket = actor + "|" + cat;
    const n = this.markBuckets.get(bucket) || 0;
    this.markBuckets.set(bucket, n + 1);
    // Same actor + category -> same region; later marks spiral gently outward from the bucket centre.
    const a = hash01(bucket + "|a") * TAU;
    const r = 0.22 + 0.62 * Math.sqrt(hash01(bucket + "|r"));
    const sr = 0.012 * Math.sqrt(n), sa = n * 2.399963;
    let x = Math.cos(a) * r + Math.cos(sa) * sr, y = Math.sin(a) * r + Math.sin(sa) * sr;
    if (kind === "commit") { x = Math.cos(n * 1.1) * 0.015 * n; y = Math.sin(n * 1.1) * 0.015 * n; }
    const d = Math.hypot(x, y); if (d > 0.92) { x *= 0.92 / d; y *= 0.92 / d; }
    const sizeBase = this.mapping.shapeSizes[c.shape] ?? this.mapping.shapeSizes.default;
    const size = kind === "test-pass" || kind === "test-fail" ? 0.05 : kind === "commit" ? 0.07 : sizeBase * 0.5;
    this.marks.push({ id: e.id, born: at, x, y, size, kind, shape: c.shape || "ring", hue: c.hue, failed, sub, agentId: sub ? e.actor.agentId : null });
    this.stats.marksTotal = this.marks.length;
  }

  // Produce drawable primitives for scene time `now`. Advances lane orbits and prunes expired state.
  primitives(now) {
    const dt = this.lastTick == null ? 0 : clamp(now - this.lastTick, 0, 250);
    this.lastTick = now;
    const period = this.period;
    const omega = TAU / (period * 6); // orbit speed shares the main tempo
    this.mainTheta += dt * omega;
    this.dim += ((this.waiting ? 0.4 : 1) - this.dim) * Math.min(1, dt / 300);
    const lo = this.mapping.layerOpacity;
    const out = [];

    // persistent layer
    for (const m of this.marks) {
      const age = now - m.born; if (age < 0) continue;
      const grow = clamp(age / 600, 0, 1);
      const col = this.color(m.hue, { sub: m.sub, failed: m.failed });
      const type = m.kind === "test-fail" || m.kind === "tool-fail" ? "crack" : m.kind === "commit" ? "seal" : m.kind === "test-pass" ? "ring" : "shape";
      out.push({ layer: "persistent", type, shape: m.shape, x: m.x, y: m.y, size: m.size * (0.5 + 0.5 * grow), rot: 0,
        hue: col.hue, sat: col.sat, light: m.kind === "test-pass" ? col.light + 14 : col.light,
        alpha: col.alpha * lo.persistent * grow * (0.55 + 0.45 * this.dim), width: m.kind === "test-pass" ? 1.6 : 1, kind: m.kind });
    }
    if (this.completed || this.turnComplete) {
      const born = this.completed ? this.frameBorn : this.turnBorn;
      out.push({ layer: "persistent", type: "frame", x: 0, y: 0, size: 0.97, progress: clamp((now - born) / 1500, 0, 1), hue: 150, sat: 55, light: 70,
        alpha: (this.completed ? 0.9 : 0.25) * lo.persistent, width: this.completed ? 1.6 : 1 });
    }

    // subagent lanes
    const resolveMs = this.mapping.timing.laneResolveMs;
    for (const [id, lane] of [...this.lanes]) {
      lane.theta += dt * omega * (1 + 0.15 * lane.index);
      if (now - lane.openedAt < 0) continue;
      const open = clamp((now - lane.openedAt) / 700, 0, 1);
      let resolve = 0;
      if (lane.closedAt != null) {
        resolve = clamp((now - lane.closedAt) / resolveMs, 0, 1);
        if (resolve >= 1) { this.lanes.delete(id); continue; }
      }
      const col = this.color(lane.hue, { sub: true });
      out.push({ layer: "lane", type: "lane", x: 0, y: 0, size: lane.radius, theta: lane.theta, open, resolve,
        hue: col.hue, sat: col.sat, light: col.light, alpha: col.alpha * lo.lanes * this.dim * (1 - resolve), width: 1 });
      if (resolve > 0) out.push({ layer: "lane", type: "ring", x: 0, y: 0, size: lane.radius * (1 - resolve), rot: 0,
        hue: col.hue, sat: col.sat, light: col.light + 10, alpha: col.alpha * lo.lanes * (1 - resolve), width: 1 });
    }

    // continuous elements
    this.elements = this.elements.filter((el) => now - el.born < el.life);
    for (const el of this.elements) {
      const age = now - el.born; if (age < 0) continue;
      const u = age / el.life * el.speed; if (u >= 1) continue;
      const lane = el.lane ? this.lanes.get(el.lane) : null;
      const baseA = lane ? lane.theta + el.a0 : el.a0 + this.mainTheta * 0.1;
      const col = this.color(el.hue, { sub: !!el.lane, failed: el.failed });
      for (const p of (MOTIONS[el.motion] || MOTIONS.drift)(u)) {
        const a = baseA + p.da, r = (lane ? lane.radius : el.r0) + p.dr;
        out.push({ layer: "continuous", type: "shape", shape: el.shape, x: Math.cos(a) * r, y: Math.sin(a) * r,
          size: el.size * p.scale * (el.call ? 0.7 : 1), rot: p.rot + a, hue: col.hue, sat: col.sat, light: col.light,
          alpha: clamp(p.alpha, 0, 1) * col.alpha * lo.continuous * this.dim, width: 1, motion: el.motion });
      }
    }

    // one-shot pulses
    this.pulses = this.pulses.filter((p) => now - p.born < p.life);
    for (const p of this.pulses) {
      const u = (now - p.born) / p.life; if (u < 0) continue;
      out.push({ layer: "continuous", type: "ring", x: 0, y: 0, size: p.r0 + (p.r1 - p.r0) * u, rot: 0, hue: p.hue, sat: 60, light: 68, alpha: (1 - u) * 0.7 * lo.continuous, width: 1.2 });
    }

    // heartbeat at the centre: period follows event cadence, frozen while waiting
    const beat = this.waiting ? 0 : 0.5 + 0.5 * Math.sin((now / period) * TAU);
    out.push({ layer: "continuous", type: "ring", x: 0, y: 0, size: 0.03 + 0.012 * beat, rot: 0, hue: this.palette.neutralHue, sat: 30, light: 70, alpha: (0.35 + 0.4 * beat) * this.dim, width: 1.2, heartbeat: true });
    return out;
  }
}
