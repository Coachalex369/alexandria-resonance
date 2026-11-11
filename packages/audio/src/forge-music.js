// Forge music: one shared composition for "The Forge" visualizer. Forge = harmony, Smith = rhythm, Scout = melody,
// all driven by the same composition state as the geometry. Built on music.js (key, modes, pitch helpers) and
// synth.js (Web Audio base); neither is modified. No samples, no Math.random in the score.
//
// Layer 1, ForgeScore: pure, deterministic, DOM-free. Same seed + same events + same setState calls => same notes.
//   TWO CLOCKS. Events arrive irregularly; the score keeps a stable 4/4 musical clock. bpm follows the observed
//     event pace (clamped 60-112, at most 4 bpm per bar) but the next bar's bpm is locked on entering the current
//     bar, so tempo only ever changes at a bar line. Every articulation is quantized to a 16th-note slot: an event
//     claims the next free slot for its voice (Smith: one note per slot overall, on a parity lane per agent so
//     parallel Smiths interlock; tension flips the lane for displaced rhythm).
//   SHARED KEY. projectCharacter() gives root + mode. Harmony is a slow progression of chord regions in that mode
//     (I IV V vi style, modal variants). It advances only at structural events (task.start, a plan phase, agent.start,
//     main turn.stop, ctx.structural) with at least 2 bars between changes, otherwise at most every 8 bars.
//     Chord changes take effect on the next bar line and are voice-led: each held Forge tone moves to the nearest
//     chord tone (unique pitches, no jump larger than a fourth in practice).
//   FILE PITCHES. pitchForPath(path, character) hashes a path into a scale degree (2 octaves). tool.result and
//     tool.failure use payload.paths[0] (or ctx.path); the same file has the same pitch for every voice.
//   VOICES (role -> instrument in forge-instruments.js):
//     foundation  Forge  additivePad drone of 3-6 chord tones, re-voiced only on chord change; brightness = verifiedFraction;
//                        ducked 6-9 dB (instruction) while Smith/Scout articulate, recovering over one bar.
//     rhythm      Smith  metalStrike (modal synthesis). Unverified material rings long and beats; verified is short and
//                        clean. Per-bar hit budget, so fast edits fill an interlocking 16th pattern, not a pile of hits.
//     motif       Scout  glideFlute line with portamento (60-120 ms) over fragments of the theme or file pitches.
//                        Dead end (tool.failure, or a search with no follow-up for 2 bars) glides down and fades.
//                        Discovery (first read of a file later edited by another voice, or ctx.discovery) lands on a
//                        chord tone, holds 2 beats, and Forge adds that tone to the drone.
//     core        Core   coreSine, very quiet root fundamental, gain rises with verifiedFraction, silent without a task.
//   TENSION. Failures raise it (displaced lane, minor-second colour, flattened third at the next voicing); passing tests
//     lower it with a quench figure (noise sweep down + consonant dyad) and pull the chord region to the tonic.
//   CONVERGENCE. setState({resolved:true}) (or task.end) restates the theme over the tonic chord with every active
//     voice, the drone decays to silence within ~8 beats, then the score is `ended` until the next task.start.
//   LIMITS. 10 simultaneous voices (pad and core count one each, the rest are articulations), 3 per agent, stealing
//     the oldest sounding note; per-minute articulation budget x0.85 per 10 minutes of event time (floor 0.4).
//     Silence is a state: after 2 bars without events only drone and core remain and the drone loses 3 dB per bar.
//     agent.stop only returns { releaseVoice }.
// Layer 2, ForgeSynth: thin Web Audio layer (extends Synth) with a lookahead scheduler, a DynamicsCompressor on the
// music bus, ducking and per-agent buses. OFF until enable() from a user gesture.
import { MODES, INSTRUMENTS, CELLS, projectCharacter, degreeToMidi, midiToHz, tempoFromPace } from "./music.js";
import { Synth } from "./synth.js";
import { seedRandom, fnv1a } from "../../forge/src/fingerprint.js";
import { FORGE_INSTRUMENTS } from "./forge-instruments.js";

const WORK_KINDS = new Set(["tool.result", "tool.failure", "test.run", "build.run", "git.commit", "turn.stop", "agent.start"]);
const BPM_MIN = 60, BPM_MAX = 112, BPM_STEP = 4;
const TOTAL_VOICES = 10, MAX_PER_AGENT = 3;
const BASE_PER_MIN = 96, SMITH_BAR_CAP = 6;
const MELODIC_EVERY = 3;
const DRONE_REFRESH_BARS = 4, SILENCE_BARS = 2, SILENCE_FLOOR_DB = -30;
const PARTIALS = [1, 2.32, 3.73, 5.01];
const ROLE_INSTRUMENT = { foundation: "additivePad", rhythm: "metalStrike", motif: "glideFlute", core: "coreSine" };
// Chord regions as scale-degree indexes (0 = tonic). Pentatonic has only 5 degrees.
const PROGRESSIONS = { ionian: [0, 3, 4, 5], lydian: [0, 1, 4, 5], mixolydian: [0, 6, 3, 4], dorian: [0, 3, 6, 4], aeolian: [0, 5, 6, 3], pentatonic: [0, 2, 3, 4] };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const pcOf = (m) => ((m % 12) + 12) % 12;
const dbToGain = (db) => Math.pow(10, db / 20);
const isPlan = (v) => typeof v === "string" && /plan/i.test(v);

// Deterministic scale degree (0 .. 2n-1, two octaves) for a path; stable across sessions, independent of voice.
export function pitchForPath(path, character) {
  const n = (MODES[(character || {}).mode] || MODES.ionian).length;
  let h = fnv1a(String(path || "").replace(/\\/g, "/"));
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b) >>> 0; h ^= h >>> 16;
  return (h >>> 0) % (2 * n);
}

// Theme variations: 0 original, 1 transposition, 2 inversion (around the first degree), 3 retrograde.
// Higher indexes add a further shift so each satellite or subtask differs. Returns scale degrees.
export function themeVariation(theme, variation = 0) {
  const k = Math.floor(variation / 4);
  switch (((variation % 4) + 4) % 4) {
    case 1: return theme.map((d) => d + 2 + k);
    case 2: return theme.map((d) => 2 * theme[0] - d + k);
    case 3: return [...theme].reverse().map((d) => d + k);
    default: return theme.map((d) => d + k);
  }
}

// Voice from an identity preset ({ music: { instrument, register, role } }). `instrument` is the preset's name (a
// music.js legacy name or a Forge instrument); `synthInstrument` is what the Forge plays: the preset's own Forge
// instrument if it names one, otherwise chosen by role.
export function voiceForIdentity(identity, agentIndex = 0) {
  const m = (identity && identity.music) || { instrument: "pluck", register: 1, role: "rhythm" };
  const role = m.role || "rhythm";
  return {
    identity: (identity && (identity.id || identity.label)) || "custom",
    instrument: INSTRUMENTS[m.instrument] || FORGE_INSTRUMENTS[m.instrument] ? m.instrument : "pluck",
    synthInstrument: FORGE_INSTRUMENTS[m.instrument] ? m.instrument : (ROLE_INSTRUMENT[role] || "metalStrike"), // presets may name a Forge instrument directly
    register: m.register | 0, role, index: agentIndex, phase: agentIndex > 0 ? 0.5 * ((agentIndex % 3) + 1) / 3 : 0, gainScale: agentIndex > 0 ? 0.75 : 1,
  };
}

export class ForgeScore {
  constructor({ project = "alexandria", identities = {}, seed = "forge" } = {}) {
    this.project = project; this.identities = identities; this.seed = String(seed);
    this.character = projectCharacter(project);
    this.rng = seedRandom(this.seed);
    this.prog = PROGRESSIONS[this.character.mode] || PROGRESSIONS.ionian;
    this.theme = []; this.phase = "idle"; this.ended = false; this.tension = 0; this.verifiedFraction = 0; this.composerPhase = null;
    this.voices = new Map(); this.intervals = []; this.cursor = 0; this.sinceStart = 0; this.lastRef = { eventId: null, nodeId: null };
    // musical clock
    this.origin = null; this.lastT = null; this.tsBase = null; this.lastEvtT = null; this.lastEvtBar = 0;
    this.bar = 0; this.barStart = 0; this.bpm = 72; this.nextBpm = 72; this.frozen = false; this.barLog = new Map(); this.slots = new Map();
    // harmony
    this.chordIdx = 0; this.chordBar = 0; this.chord = null; this.droneTones = []; this.gen = 0; this.droneDue = 0; this.coreDue = 0;
    this.filePitches = {}; this.firstRead = new Map(); this.pendingStructural = false; this.closingPending = false; this.resolvedFlag = false;
    // limits
    this.sounding = []; this.noteSeq = 0; this.win = -1; this.winCount = 0; this.smithBar = new Map(); this.recent = [];
    this.duck = { at: 0, db: 0, recoverSec: 1 }; this.stats = { maxVoices: 0, maxPerAgent: 0 }; this.pendingInstr = [];
    this.counters = { events: 0, results: 0, melodic: 0, nudged: 0, notes: 0, tasks: 0, dropped: 0, steals: 0 };
  }

  // ---- state -------------------------------------------------------------------------------------------------
  _coreOn() { return [...this.voices.values()].some((v) => v.role === "core") || Object.values(this.identities.presets || {}).some((p) => p && p.music && p.music.role === "core"); }
  _brightness() { return 0.2 + 0.8 * this.verifiedFraction; }
  _fatigue(t) { return Math.max(0.4, Math.pow(0.85, Math.max(0, t - (this.origin || 0)) / 600)); }
  _silentBars(t) { return this.lastEvtT == null ? 0 : Math.floor((t - this.lastEvtT) / (240 / this.bpm)); }
  _droneDb(bar) { return -3 * Math.max(0, bar - this.lastEvtBar - SILENCE_BARS); }
  duckAt(t) { const d = this.duck; return d.db * Math.max(0, 1 - (t - d.at) / d.recoverSec) * (t >= d.at ? 1 : 0); }

  state() {
    const t = this.lastT == null ? 0 : this.lastT;
    return JSON.parse(JSON.stringify({
      project: this.project, seed: this.seed, character: this.character, theme: this.theme, tension: this.tension, bpm: this.bpm, bar: this.bar,
      phase: this.phase, composerPhase: this.composerPhase, ended: this.ended, cursor: this.cursor, harmonyIdx: this.chordIdx, counters: this.counters,
      chord: this.chord, droneTones: this.droneTones, droneBrightness: this._brightness(), verifiedFraction: this.verifiedFraction,
      coreGain: this._coreGain(), droneDb: this.origin == null ? 0 : this._droneDb(this.bar), silent: this.origin != null && this._silentBars(t) >= SILENCE_BARS,
      budgetPerMinute: Math.round(BASE_PER_MIN * this._fatigue(t)), fatigue: this._fatigue(t), filePitches: this.filePitches,
      duckDb: this.duckAt(t), maxVoices: this.stats.maxVoices, maxPerAgent: this.stats.maxPerAgent,
      voices: [...this.voices.values()].map((v) => ({ id: v.id, identity: v.identity, instrument: v.synthInstrument, register: v.register, role: v.role, index: v.index, active: v.active, docked: v.docked, count: v.count, triggers: v.triggers })),
    }));
  }

  // Called by the page every animation tick from the composer. Never emits notes itself; tick() does.
  setState(s = {}) {
    if (Number.isFinite(s.verifiedFraction)) this.verifiedFraction = clamp(s.verifiedFraction, 0, 1);
    if (Number.isFinite(s.tension)) this.tension = clamp(s.tension, 0, 1);
    if (typeof s.phase === "string") { if (isPlan(s.phase) && !isPlan(this.composerPhase)) this.pendingStructural = true; this.composerPhase = s.phase; }
    if (Array.isArray(s.agents)) {
      s.agents.forEach((a, i) => {
        if (!a || a.id == null) return;
        let v = this.voices.get(a.id);
        if (!v) v = this._addVoice(a.id, a.identity, i);
        v.active = a.active !== false; v.docked = !!a.docked;
      });
    }
    if (typeof s.resolved === "boolean") {
      if (s.resolved && !this.resolvedFlag && this.theme.length && !this.ended) this.closingPending = true;
      this.resolvedFlag = s.resolved;
    }
  }

  // ---- clock -------------------------------------------------------------------------------------------------
  _stepBpm() {
    if (this.frozen) return this.bpm;
    const target = clamp(tempoFromPace(this.intervals), BPM_MIN, BPM_MAX);
    return Math.round(clamp(this.bpm + clamp(target - this.bpm, -BPM_STEP, BPM_STEP), BPM_MIN, BPM_MAX));
  }
  _advance(t) {
    if (this.origin == null) { this.origin = t; this.barStart = t; this.bar = 0; this.barLog.set(0, { start: t, bpm: this.bpm }); this.nextBpm = this._stepBpm(); }
    while (t >= this.barStart + 240 / this.bpm - 1e-9) {
      this.barStart += 240 / this.bpm; this.bar++; this.bpm = this.nextBpm;
      this.barLog.set(this.bar, { start: this.barStart, bpm: this.bpm });
      this.barLog.delete(this.bar - 700); this.nextBpm = this._stepBpm();
    }
    this.lastT = this.lastT == null ? t : Math.max(this.lastT, t);
  }
  // Start time and bpm of bar k (logged, or projected: the next bar's bpm is already locked).
  barInfo(k) {
    if (this.barLog.has(k)) return this.barLog.get(k);
    let start = this.barStart, bpm = this.bpm, b = this.bar;
    while (b < k) { start += 240 / bpm; bpm = this.nextBpm; b++; }
    return { start, bpm };
  }
  // Pure query: where is t on the grid? nextSlotTime is the first 16th slot at or after t.
  grid(t) {
    if (this.origin == null || t < this.origin) return { bpm: this.bpm, bar: 0, beat: 0, sixteenth: 0, nextSlotTime: t };
    let bar, start, bpm;
    if (t >= this.barStart) {
      bar = this.bar; start = this.barStart; bpm = this.bpm;
      while (t >= start + 240 / bpm - 1e-9) { start += 240 / bpm; bpm = this.nextBpm; bar++; }
    } else {
      bar = this.bar - 1; while (bar > 0 && !(this.barLog.has(bar) && t >= this.barLog.get(bar).start)) bar--;
      ({ start, bpm } = this.barLog.get(bar) || { start: this.origin, bpm: this.bpm });
    }
    const sx = 15 / bpm, idx = clamp(Math.floor((t - start) / sx + 1e-9), 0, 15), s = Math.ceil((t - start) / sx - 1e-9);
    return { bpm, bar, beat: Math.floor(idx / 4), sixteenth: idx, nextSlotTime: s < 16 ? start + Math.max(0, s) * sx : start + 240 / bpm };
  }
  _slot(bar, s) { while (s >= 16) { s -= 16; bar++; } const b = this.barInfo(bar); return { bar, s, bpm: b.bpm, time: b.start + s * (15 / b.bpm) }; }
  _first(t) { const sx = 15 / this.bpm; let s = Math.ceil((t - this.barStart) / sx - 1e-6); return { bar: this.bar, s: Math.max(0, s) }; }
  // Claim the next free slot at/after t for voiceId. opts: smith (global one-per-slot), parity lane. Null if none within the next bar.
  _claim(t, voiceId, opts = {}) {
    const p0 = this._first(t);
    for (const pass of opts.parity == null ? [1] : [0, 1]) {
      for (let k = 0; k < (pass === 0 ? 12 : 32); k++) {
        const slot = this._slot(p0.bar, p0.s + k);
        if (slot.bar > this.bar + 1) return null;
        if (pass === 0 && slot.s % 2 !== opts.parity) continue;
        const rec = this.slots.get(slot.bar) || { smith: 0, voices: {} };
        if (opts.smith && (rec.smith >> slot.s) & 1) continue;
        if ((rec.voices[voiceId] || 0) >> slot.s & 1) continue;
        if (opts.smith) rec.smith |= 1 << slot.s;
        rec.voices[voiceId] = (rec.voices[voiceId] || 0) | (1 << slot.s); this.slots.set(slot.bar, rec);
        for (const key of this.slots.keys()) if (key < this.bar - 2) this.slots.delete(key);
        return slot;
      }
    }
    return null;
  }
  _time(event, ctx) {
    let t = null;
    if (Number.isFinite(ctx.t)) t = ctx.t;
    else { const ms = Date.parse(event.ts); if (Number.isFinite(ms)) { if (this.tsBase == null) this.tsBase = ms - (this.lastT || 0) * 1000; t = (ms - this.tsBase) / 1000; } }
    if (t == null) t = this.lastT == null ? 0 : this.lastT;
    return this.lastT == null ? t : Math.max(t, this.lastT);
  }

  // ---- harmony -----------------------------------------------------------------------------------------------
  _scale() { return MODES[this.character.mode] || MODES.ionian; }
  _midi(deg, oct, colour = true) {
    const n = this._scale().length;
    let m = degreeToMidi(this.character.root, this.character.mode, deg, oct);
    if (colour && this.tension > 0.6 && ((deg % n) + n) % n === 2 && this._scale()[2] === 4) m -= 1; // flattened third under tension
    while (m > 84) m -= 12; while (m < 36) m += 12;
    return m;
  }
  _fileMidi(path) { return degreeToMidi(this.character.root, this.character.mode, this._filePitch(path), 0); }
  _filePitch(path) {
    if (!(path in this.filePitches)) {
      const keys = Object.keys(this.filePitches); if (keys.length >= 256) delete this.filePitches[keys[0]];
      this.filePitches[path] = pitchForPath(path, this.character);
    }
    return this.filePitches[path];
  }
  _chordFor(idx) {
    const d0 = this.prog[idx % this.prog.length], m = [d0, d0 + 2, d0 + 4].map((d) => degreeToMidi(this.character.root, this.character.mode, d, 0));
    if (this.tension > 0.6 && pcOf(m[1] - m[0]) === 4) m[1] -= 1; // flattened third colour (taken at the next re-voicing)
    return { index: idx % this.prog.length, degree: d0, pcs: m.map(pcOf) };
  }
  _initialVoicing(pcs) {
    const above = (floor, pc) => { let m = floor; while (pcOf(m) !== pc) m++; return m; };
    const r = above(43, pcs[0]), th = above(r + 1, pcs[1]), fi = above(th + 1, pcs[2]);
    return [r, th, fi, r + 12];
  }
  _revoice(pcs) {
    const old = this.droneTones, cands = [];
    for (let m = 36; m <= 84; m++) if (pcs.includes(pcOf(m))) cands.push(m);
    const used = new Set(), res = new Array(old.length);
    [...old.keys()].sort((a, b) => old[a] - old[b] || a - b).forEach((i) => {
      let best = null, bd = 1e9;
      for (const c of cands) if (!used.has(c)) { const d = Math.abs(c - old[i]); if (d < bd || (d === bd && c < best)) { best = c; bd = d; } }
      used.add(best); res[i] = best;
    });
    for (const pc of pcs) { // keep every chord tone present when a duplicate can move there cheaply
      if (res.some((m) => pcOf(m) === pc)) continue;
      let bi = -1, bd = 1e9, bc = null;
      res.forEach((m, i) => { if (res.filter((x) => pcOf(x) === pcOf(m)).length > 1) for (const c of cands) if (pcOf(c) === pc && !res.includes(c)) { const d = Math.abs(c - old[i]); if (d < bd) { bd = d; bi = i; bc = c; } } });
      if (bi >= 0 && bd <= 5) res[bi] = bc;
    }
    return res;
  }
  // Move to chord region idx. Takes effect on the next bar line; emits the re-voiced drone there.
  _setChord(idx, sink, at) {
    this.chordIdx = idx; this.chordBar = this.bar; this.chord = this._chordFor(idx);
    this.droneTones = this.droneTones.length ? this._revoice(this.chord.pcs) : this._initialVoicing(this.chord.pcs);
    this.gen++;
    this._pushDrone(sink, at || this._slot(this.bar + 1, 0), {});
    this.droneDue = this.bar + 1 + DRONE_REFRESH_BARS;
  }
  _advanceChord(sink, { tonic = false } = {}) {
    if (!tonic && this.bar - this.chordBar < 2) return false;
    const idx = tonic ? 0 : (this.chordIdx + 1) % this.prog.length;
    if (idx === this.chordIdx && this.chord && this.chord.index === idx && tonic) return false;
    this._setChord(idx, sink); return true;
  }
  _droneVoice() { const f = [...this.voices.values()].find((v) => v.role === "foundation"); return f || { id: "forge", identity: "forge", role: "foundation" }; }
  _coreGain() { return 0.012 + 0.05 * this.verifiedFraction; }
  _pushDrone(sink, slot, o = {}) {
    const v = this._droneVoice(), db = o.db != null ? o.db : 0;
    const tones = o.tones || this.droneTones, barSec = 240 / slot.bpm, gain = 0.075 * dbToGain(db);
    tones.forEach((m) => sink.notes.push(this._mk(v, slot, {
      hz: midiToHz(m), midi: m, durationSec: o.durationSec || (o.bars || DRONE_REFRESH_BARS) * barSec + barSec, gain, brightness: this._brightness(), gen: this.gen, fadeSec: barSec,
      instrument: "additivePad", decay: !!o.decay, holdSec: o.holdSec || 0,
    })));
    this.counters.notes += tones.length;
  }
  _pushCore(sink, slot, o = {}) {
    const v = { id: "core", identity: "core", role: "core" }, barSec = 240 / slot.bpm;
    sink.notes.push(this._mk(v, slot, { hz: midiToHz(this.character.root - 12), midi: this.character.root - 12, durationSec: o.durationSec || DRONE_REFRESH_BARS * barSec + 1.5, gain: this._coreGain(), instrument: "coreSine", decay: !!o.decay, holdSec: o.holdSec || 0 }));
    this.counters.notes++;
  }

  // ---- voices ------------------------------------------------------------------------------------------------
  _resolveIdentity(identity) {
    const presets = this.identities.presets || {};
    let id = typeof identity === "string" ? identity : null, preset = id ? presets[id] : null;
    if (!preset && identity && typeof identity === "object" && identity.music) { preset = identity; id = identity.id || identity.label || "custom"; }
    if (!preset) { id = this.identities.fallback || "smith"; preset = presets[id] || null; }
    return { ...(preset || {}), id };
  }
  _addVoice(id, identity, agentIndex) {
    const v = { id, ...voiceForIdentity(this._resolveIdentity(identity), agentIndex), active: true, docked: false, count: 0, triggers: 0, lastCategory: null, lastHz: null, lastMidi: null, frag: null, fi: 0, pendingSearch: null };
    this.voices.set(id, v); return v;
  }
  _voice(event, ctx) {
    const id = (event.actor || {}).agentId || "main";
    return this.voices.get(id) || this._addVoice(id, ctx.identity, ctx.agentIndex != null ? ctx.agentIndex : (id === "main" ? 0 : this.voices.size));
  }
  _mk(v, slot, props) {
    return {
      id: `n${++this.noteSeq}`, time: slot.time, hz: 0, glideFromHz: null, glideSec: 0, durationSec: 0.5, instrument: v.synthInstrument || props.instrument, gain: 0.2,
      voice: v.id, identity: v.identity, role: v.role, ref: { ...this.lastRef }, bar: slot.bar, sixteenth: slot.s, bpm: slot.bpm, ...props,
    };
  }

  // Admit an articulation: budget, polyphony (10 total, 3 per agent, steal oldest), ducking. Returns true if it sounds.
  _emit(sink, n, { priority = false } = {}) {
    if (!priority) {
      const w = Math.floor((n.time - this.origin) / 60); if (w !== this.win) { this.win = w; this.winCount = 0; }
      if (this.winCount >= Math.round(BASE_PER_MIN * this._fatigue(n.time))) { this.counters.dropped++; return false; }
    }
    const a = n.time, b = a + n.durationSec, cap = TOTAL_VOICES - 1 - (this._coreOn() ? 1 : 0), steals = [];
    this.sounding = this.sounding.filter((s) => s.end > a - 30);
    for (let guard = 0; guard < 24; guard++) {
      const act = this.sounding.filter((s) => s.end > a && s.start < b), pts = [a, ...act.filter((s) => s.start > a).map((s) => s.start)];
      let bad = null;
      for (const p of pts) {
        const at = act.filter((s) => s.start <= p && s.end > p), mine = at.filter((s) => s.agent === n.voice);
        if (mine.length + 1 > MAX_PER_AGENT) { bad = mine; break; }
        if (at.length + 1 > cap) { bad = at; break; }
      }
      if (!bad) break;
      const victim = bad.filter((s) => s.start <= a).sort((x, y) => x.start - y.start || (x.id < y.id ? -1 : 1))[0];
      if (!victim) { this.counters.dropped++; return false; }
      victim.end = a; steals.push({ stealVoice: victim.id, at: a }); this.counters.steals++;
    }
    this.sounding.push({ id: n.id, agent: n.voice, start: a, end: b });
    const live = this.sounding.filter((s) => s.start <= a && s.end > a);
    this.stats.maxVoices = Math.max(this.stats.maxVoices, live.length + 1 + (this._coreOn() ? 1 : 0));
    this.stats.maxPerAgent = Math.max(this.stats.maxPerAgent, live.filter((s) => s.agent === n.voice).length);
    this.winCount++; this.counters.notes++;
    sink.notes.push(n); sink.instructions.push(...steals);
    this.recent = this.recent.filter((x) => x > a - 240 / n.bpm); this.recent.push(a);
    const db = 6 + 3 * clamp(this.recent.length / 8, 0, 1); this.duck = { at: a, db, recoverSec: 240 / n.bpm };
    sink.instructions.push({ duck: { db, at: a, recoverSec: 240 / n.bpm } });
    return true;
  }

  // ---- tasks -------------------------------------------------------------------------------------------------
  _startTask(sink) {
    const len = 6 + Math.floor(this.rng() * 3), th = [0];
    let d = 0;
    for (let i = 1; i < len - 1; i++) { d = clamp(d + this.rng.pick([-2, -1, -1, 1, 1, 2, 3]), -2, 9); th.push(d); }
    th.push(this.rng.pick([0, 2, 4]));
    this.theme = th; this.ended = false; this.frozen = false; this.closingPending = false; this.tension = 0; this.sinceStart = 0; this.cursor = 0;
    this.droneTones = []; this.counters.tasks++;
    for (const v of this.voices.values()) { v.frag = null; v.fi = 0; v.pendingSearch = null; }
    const p = this._first(this.lastT), at = this._slot(p.bar, p.s);
    this._setChord(0, sink, at);
    if (this._coreOn()) this._pushCore(sink, at, {});
    this.coreDue = this.bar + 1 + DRONE_REFRESH_BARS;
  }

  onEvent(event, ctx = {}) {
    const kind = event.kind, actor = event.actor || {}, payload = event.payload || {};
    const t = this._time(event, ctx); this._advance(t);
    this.counters.events++;
    const path = typeof ctx.path === "string" ? ctx.path : (Array.isArray(payload.paths) && typeof payload.paths[0] === "string" ? payload.paths[0] : null);
    this.lastRef = { eventId: event.id, nodeId: ctx.nodeId != null ? ctx.nodeId : null }; if (path) this.lastRef.path = path;
    const gap = this.lastEvtT == null ? null : t - this.lastEvtT;
    if (gap != null && gap > 0) { this.intervals.push(gap * 1000); if (this.intervals.length > 16) this.intervals.shift(); }
    this.lastEvtT = t; this.lastEvtBar = this.bar;
    const out = { notes: [], tensionDelta: 0, bpm: this.bpm, theme: [], phase: this.phase, instructions: [], chord: null };
    const finish = (resolved) => {
      this.tension = clamp(this.tension + out.tensionDelta * 0.5, 0, 1);
      if (this.ended) this.phase = "ended";
      else if (!this.theme.length) this.phase = "idle";
      else if (resolved) this.phase = "resolution";
      else if (this.tension >= 0.5) this.phase = "tension";
      else this.phase = this.sinceStart <= 4 ? "theme" : "development";
      out.phase = kind === "task.end" ? "closing" : this.phase; out.theme = [...this.theme]; out.bpm = this.bpm; out.chord = this.chord ? { ...this.chord } : null;
      return out;
    };
    if (this.closingPending && kind !== "task.start" && !this.ended) this._close(t, out);
    if (this.ended && kind !== "task.start") { out.theme = [...this.theme]; out.phase = "ended"; out.chord = this.chord ? { ...this.chord } : null; return out; }
    if (kind !== "task.start" && !this.theme.length) { if (!WORK_KINDS.has(kind)) return finish(false); this._startTask(out); }
    this.sinceStart++;
    const structural = ctx.structural === true || kind === "agent.start" || (kind === "turn.stop" && actor.type === "main");

    switch (kind) {
      case "task.start": {
        this._startTask(out); this.sinceStart = 0;
        const v = this._voice(event, ctx);
        if (v.role === "rhythm" || v.role === "motif") this._statement(v, t, out);
        out.instructions.push({ newTheme: [...this.theme] });
        return finish(false);
      }
      case "task.end": this._close(t, out); out.tensionDelta = -1; return finish(false);
      case "agent.start": {
        const v = this._voice(event, ctx); v.active = true; v.docked = false;
        this._advanceChord(out);
        const slot = this._claim(t, v.id, v.role === "rhythm" ? { smith: true, parity: v.index % 2 } : {});
        if (slot && v.role === "rhythm") this._emit(out, this._smithNote(v, slot, this._midi(this.chord.degree, 0), true, 0.6, false), { priority: true });
        else if (slot && v.role === "motif") this._emit(out, this._scoutNote(v, slot, this._midi(this.chord.degree + 4, 1), { hold: 1.5, gain: 0.5 }), { priority: true });
        return finish(false);
      }
      case "agent.stop": {
        const id = actor.agentId || ctx.agentId || "main", v = this.voices.get(id);
        if (v) v.active = false;
        out.instructions.push({ releaseVoice: id }); // fade only: no cadence, no notes
        return finish(false);
      }
      case "turn.stop": {
        if (actor.type !== "main") return finish(false);
        this._advanceChord(out); out.tensionDelta = -0.5;
        return finish(true);
      }
      case "git.commit": case "test.run": case "build.run": {
        const v = this._voice(event, ctx), ok = kind === "git.commit" ? true : payload.ok;
        if (structural) this._advanceChord(out);
        if (ok === true) { this._quench(v, t, out); out.tensionDelta = kind === "git.commit" ? -0.8 : -0.6; this._advanceChord(out, { tonic: true }); return finish(true); }
        if (ok === false) { this._failure(v, t, out); out.tensionDelta = 0.6; return finish(false); }
        return finish(false);
      }
      case "tool.failure": {
        const v = this._voice(event, ctx); if (path) this._filePitch(path);
        this._failure(v, t, out); out.tensionDelta = 0.4; return finish(false);
      }
      case "tool.result": {
        const v = this._voice(event, ctx);
        const op = ((event.classification || []).find((c) => c.scheme === "operation") || {}).value, plan = op === "plan" && this.lastOp !== "plan"; this.lastOp = op;
        if (structural || plan) this._advanceChord(out);
        this._result(event, ctx, gap, path, t, v, out);
        return finish(false);
      }
      default:
        if (structural) this._advanceChord(out);
        return finish(false);
    }
  }

  // ---- articulations -----------------------------------------------------------------------------------------
  _smithNote(v, slot, midi, verified, accent, unverifiedRing = true) {
    const clean = verified || !unverifiedRing;
    return this._mk(v, slot, {
      hz: midiToHz(midi), midi, durationSec: clean ? 0.4 : 2.0, gain: clamp(0.3 * accent * v.gainScale, 0.03, 0.4), partials: PARTIALS, verified: !!verified, detuneCents: clean ? 0 : 7,
    });
  }
  _scoutNote(v, slot, midi, o = {}) {
    const hz = midiToHz(midi), prev = v.lastHz, semis = prev ? Math.abs(12 * Math.log2(hz / prev)) : 0, beat = 60 / slot.bpm;
    const n = this._mk(v, slot, {
      hz, midi, glideFromHz: prev && prev !== hz ? prev : null, glideSec: prev && prev !== hz ? clamp(0.06 + 0.005 * semis, 0.06, 0.12) : 0,
      durationSec: (o.hold || 1.25) * beat, gain: clamp((o.gain || 0.3) * v.gainScale, 0.03, 0.4), degree: o.degree,
    });
    v.lastHz = hz; v.lastMidi = midi;
    return n;
  }
  // Theme statement on task.start by a rhythm or motif voice, in 8th notes.
  _statement(v, t, out) {
    let pos = this._first(t);
    this.theme.forEach((d, i) => {
      const slot = this._slot(pos.bar, pos.s + i * 2); if (slot.bar > this.bar + 1) return;
      const m = this._midi(d, v.role === "motif" ? 1 : 0);
      const n = v.role === "motif" ? this._scoutNote(v, slot, m, { hold: 0.9, gain: 0.26, degree: d }) : this._smithNote(v, slot, m, true, 0.55);
      n.degree = d; this._emit(out, n, { priority: true });
    });
  }
  _result(event, ctx, gap, path, t, v, out) {
    const cls = event.classification || [], op = (cls.find((c) => c.scheme === "operation") || {}).value || "other";
    const cat = (cls.filter((c) => c.scheme === "work-category").sort((a, b) => b.confidence - a.confidence)[0] || {}).value || "research";
    this.counters.results++; v.count++;
    const catChanged = v.lastCategory !== cat; v.lastCategory = cat;
    if (path) this._filePitch(path);
    // discovery bookkeeping
    let reader = null;
    if (path) {
      const rec = this.firstRead.get(path);
      if (op === "read" || op === "search") { if (!rec) { if (this.firstRead.size >= 256) this.firstRead.delete(this.firstRead.keys().next().value); this.firstRead.set(path, { voice: v.id, done: false }); } }
      else if ((op === "edit" || op === "create") && rec && !rec.done && rec.voice !== v.id) { rec.done = true; reader = this.voices.get(rec.voice) || null; }
    }
    if (ctx.discovery === true) reader = v.role === "motif" ? v : ([...this.voices.values()].find((x) => x.role === "motif" && x.active && !x.docked) || v);
    if (v.role === "motif") { if (op === "search") v.pendingSearch = { t, ref: { ...this.lastRef } }; else v.pendingSearch = null; }
    const beat = 60 / this.bpm, fast = gap != null && gap < beat;
    if (v.active && !v.docked) {
      if (v.role === "rhythm") this._smith(v, op, ctx, path, fast, catChanged, t, out);
      else if (v.role === "motif") {
        if (fast && !(catChanged || v.count % MELODIC_EVERY === 0 || ctx.discovery === true)) this.counters.nudged++;
        else this._scout(v, op, ctx, path, t, out);
      }
    }
    if (reader) this._land(reader, path, t, out);
  }
  _smith(v, op, ctx, path, fast, catChanged, t, out) {
    if (fast && !(catChanged || v.count % 2 === 0)) { this.counters.nudged++; return; }
    const slot = this._claim(t, v.id, { smith: true, parity: (v.index + (this.tension > 0.5 ? 1 : 0)) % 2 });
    const smiths = [...this.voices.values()].filter((x) => x.role === "rhythm" && x.active).length, cap = SMITH_BAR_CAP + (smiths > 1 ? 2 : 0);
    if (!slot || (this.smithBar.get(slot.bar) || 0) >= cap) { this.counters.dropped++; return; }
    this.smithBar.set(slot.bar, (this.smithBar.get(slot.bar) || 0) + 1); for (const k of this.smithBar.keys()) if (k < this.bar - 2) this.smithBar.delete(k);
    let midi, degree;
    if (path) midi = this._fileMidi(path);
    else { degree = this.theme[(this.cursor + (ctx.variation || 0)) % this.theme.length]; midi = this._midi(degree, 0); }
    this.cursor++; v.triggers++; this.counters.melodic++;
    const n = this._smithNote(v, slot, midi, ctx.verified === true, (CELLS[op] || CELLS.other).accent);
    if (degree != null) n.degree = degree;
    this._emit(out, n);
  }
  _scout(v, op, ctx, path, t, out) {
    const slot = this._claim(t, v.id);
    if (!slot) { this.counters.dropped++; return; }
    let midi, degree;
    if (path) midi = this._fileMidi(path);
    else {
      if (!v.frag || v.fi >= v.frag.length) {
        const variant = themeVariation(this.theme, ctx.variation != null ? ctx.variation : v.index + 1 + v.triggers), off = (v.triggers * 2) % Math.max(1, this.theme.length - 3);
        v.frag = variant.slice(off, off + 4); v.fi = 0;
      }
      degree = v.frag[v.fi++]; midi = this._midi(degree, 1);
      while (midi > 84) midi -= 12; while (midi < 57) midi += 12;
    }
    v.triggers++; this.counters.melodic++;
    this._emit(out, this._scoutNote(v, slot, midi, { hold: (CELLS[op] || CELLS.other).lengthBeats >= 1 ? 1.5 : 1, gain: 0.3, degree }));
  }
  // Dead end: glide down a fourth and fade.
  _deadEnd(v, t, ref, sink) {
    const slot = this._claim(t, v.id); if (!slot) return;
    const from = v.lastHz || midiToHz(this._midi(this.theme[0] || 0, 1)), to = from * Math.pow(2, -5 / 12), beat = 60 / slot.bpm;
    const n = this._mk(v, slot, { hz: to, midi: null, glideFromHz: from, glideSec: 0.4, durationSec: 2 * beat, gain: clamp(0.2 * v.gainScale, 0.03, 0.4), fade: true, deadEnd: true });
    if (ref) n.ref = { ...ref };
    v.lastHz = to; this._emit(sink, n, { priority: true });
  }
  // Discovery: land on the nearest chord tone, hold 2 beats; Forge adds the tone to the drone.
  _land(reader, path, t, out) {
    if (!this.chord) return;
    const target = path ? this._fileMidi(path) : (reader.lastMidi || this.character.root + 12);
    let best = null, bd = 1e9;
    for (let m = 57; m <= 84; m++) if (this.chord.pcs.includes(pcOf(m))) { const d = Math.abs(m - target); if (d < bd) { bd = d; best = m; } }
    const voice = reader.role === "motif" ? reader : ([...this.voices.values()].find((x) => x.role === "motif" && x.active && !x.docked) || null);
    let slot = null;
    if (voice && voice.active && !voice.docked) {
      slot = this._claim(t, voice.id);
      if (slot) { const n = this._scoutNote(voice, slot, best, { hold: 2, gain: 0.38 }); n.discovery = true; n.durationSec = 2 * 60 / slot.bpm; this._emit(out, n, { priority: true }); }
    }
    if (!slot) slot = this._slot(this._first(t).bar, this._first(t).s);
    let tone = null;
    const mean = this.droneTones.reduce((a, m) => a + m, 0) / Math.max(1, this.droneTones.length);
    for (let m = 36; m <= 76; m++) if (pcOf(m) === pcOf(best) && !this.droneTones.includes(m) && (tone == null || Math.abs(m - mean) < Math.abs(tone - mean))) tone = m;
    if (tone != null && this.droneTones.length < 6) {
      this.droneTones.push(tone);
      this._pushDrone(out, slot, { tones: [tone] }); out.instructions.push({ discovery: { midi: tone, path: path || null } });
    }
  }
  // Failure: displaced minor-second colour for Smith, dead end for Scout, a dissonant pad dyad for Forge.
  _failure(v, t, out) {
    if (!v.active || v.docked) return;
    if (v.role === "motif") { this._deadEnd(v, t, null, out); return; }
    const base = this.theme.length ? this._midi(this.theme[this.cursor % this.theme.length], 0, false) : this.character.root;
    if (v.role === "rhythm") {
      for (const semis of [0, 1]) {
        const slot = this._claim(t, v.id, { smith: true, parity: 1 });
        if (slot) this._emit(out, this._smithNote(v, slot, base + semis, false, 0.8), { priority: true });
      }
      return;
    }
    const slot = this._claim(t, v.id);
    if (slot) for (const semis of [0, 1]) this._emit(out, this._mk(v, slot, { hz: midiToHz(base - 12 + semis), midi: base - 12 + semis, durationSec: 2 * 60 / slot.bpm, gain: 0.05, brightness: 0.4, instrument: "additivePad", gen: this.gen }), { priority: true });
  }
  // Passing tests: filtered noise sweep down, then a consonant dyad (root + fifth of the tonic).
  _quench(v, t, out) {
    const slot = this._claim(t, "__quench");
    if (!slot) return;
    const q = this._mk({ id: v.id, identity: v.identity, role: v.role, synthInstrument: "quenchNoise" }, slot, { hz: 0, durationSec: 0.7, gain: 0.12, sweepFromHz: 6500, sweepToHz: 250 });
    this._emit(out, q, { priority: true });
    const rootM = this.character.root + 12, p = this._first(slot.time + 0.01), dyadSlot = this._slot(p.bar, p.s + 2);
    if (dyadSlot.bar > this.bar + 1) return;
    const inst = v.role === "foundation" ? "additivePad" : v.role === "motif" ? "glideFlute" : "metalStrike";
    for (const m of [rootM, rootM + 7]) {
      const n = this._mk({ id: v.id, identity: v.identity, role: v.role, synthInstrument: inst }, dyadSlot, { hz: midiToHz(m), midi: m, durationSec: inst === "metalStrike" ? 0.6 : 1.5 * 60 / dyadSlot.bpm, gain: 0.16, partials: PARTIALS, verified: true, detuneCents: 0, brightness: 0.6, gen: this.gen, consonant: true });
      this._emit(out, n, { priority: true });
    }
  }

  // ---- convergence -------------------------------------------------------------------------------------------
  _close(t, sink) {
    this.closingPending = false;
    if (this.ended || !this.theme.length) return;
    this.frozen = true;
    const act = [...this.voices.values()].filter((v) => v.active && !v.docked && v.role !== "core");
    if (!act.length) act.push(this._droneVoice());
    const lead = act.find((v) => v.role === "motif") || act.find((v) => v.role === "rhythm") || act[0];
    const p0 = { bar: this.bar + 1, s: 0 }, len = this.theme.length;
    this.chordIdx = 0; this.chordBar = this.bar; this.chord = this._chordFor(0);
    this.droneTones = this.droneTones.length ? this._revoice(this.chord.pcs) : this._initialVoicing(this.chord.pcs); this.gen++;
    const s0 = this._slot(p0.bar, 0), beatSec = 60 / s0.bpm, themeSec = len * 2 * (15 / s0.bpm);
    const o = { decay: true, holdSec: themeSec + 2 * beatSec, durationSec: themeSec + 2 * beatSec + 8 * beatSec };
    this._pushDrone(sink, s0, o); this._pushCore(sink, s0, o);
    this.theme.forEach((d, i) => { // theme restated in 8th notes by the lead voice
      const slot = this._slot(p0.bar, i * 2);
      const m = this._midi(d, lead.role === "motif" ? 1 : 0, false);
      let n;
      if (lead.role === "motif") n = this._scoutNote(lead, slot, m, { hold: 0.9, gain: 0.3, degree: d });
      else if (lead.role === "rhythm") n = this._smithNote(lead, slot, m, true, 0.6);
      else n = this._mk(lead, slot, { hz: midiToHz(m), midi: m, durationSec: 0.9 * beatSec, gain: 0.07, brightness: 0.7, instrument: "additivePad", gen: this.gen });
      n.degree = d; n.closing = true; sink.notes.push(n); this.counters.notes++;
    });
    const tonic = this._slot(p0.bar, len * 2), pcs = this.chord.pcs, tones = [0, 1, 2, 3].map((i) => this._initialVoicing(pcs)[i] + 12);
    act.forEach((v, i) => { // every active voice joins the tonic chord
      if (v.role === "foundation") return;
      const m = tones[i % tones.length];
      const n = v.role === "motif" ? this._scoutNote(v, tonic, m, { hold: 4, gain: 0.3 }) : this._smithNote(v, tonic, m, true, 0.7);
      n.closing = true; n.durationSec = v.role === "motif" ? 4 * beatSec : 1.2; sink.notes.push(n); this.counters.notes++;
    });
    this.ended = true; this.phase = "ended"; sink.instructions.push({ converge: true });
  }

  // ---- background --------------------------------------------------------------------------------------------
  // Sparse scheduled notes: drone and core refreshes (every 4 bars, every bar while silent), closing after
  // setState({ resolved }), dead ends for searches without follow-up, automatic chord changes (>= 8 bars).
  tick(tSeconds) {
    if (this.origin == null || !Number.isFinite(tSeconds)) return [];
    const t = Math.max(tSeconds, this.lastT); this._advance(t);
    const sink = { notes: [], instructions: this.pendingInstr }; this.pendingInstr = [];
    const done = () => { this.pendingInstr = sink.instructions; return sink.notes; };
    if (this.closingPending) this._close(t, sink);
    if (this.ended || !this.theme.length) return done();
    const silent = this._silentBars(t) >= SILENCE_BARS, barSec = 240 / this.bpm;
    for (const v of this.voices.values()) if (v.pendingSearch && t - v.pendingSearch.t > 2 * barSec) { const ref = v.pendingSearch.ref; v.pendingSearch = null; if (v.active && !v.docked) this._deadEnd(v, t, ref, sink); }
    if (this.pendingStructural) { this.pendingStructural = false; this._advanceChord(sink); }
    else if (!silent && this.bar - this.chordBar >= 8) this._advanceChord(sink);
    const interval = silent ? 1 : DRONE_REFRESH_BARS;
    if (this.bar + 1 >= this.droneDue) {
      const db = this._droneDb(this.bar + 1);
      if (db >= SILENCE_FLOOR_DB) { this.gen++; this._pushDrone(sink, this._slot(this.bar + 1, 0), { db, bars: interval }); }
      this.droneDue = this.bar + 1 + interval;
    }
    if (this._coreOn() && this.bar + 1 >= this.coreDue) { this._pushCore(sink, this._slot(this.bar + 1, 0), { durationSec: interval * 240 / this.bpm + 1.5 }); this.coreDue = this.bar + 1 + interval; }
    return done();
  }
  // Instructions produced during tick() (steals, ducks) that the caller should apply; drained on read.
  takeInstructions() { const r = this.pendingInstr; this.pendingInstr = []; return r; }
}

// Browser-only audio layer. Holds a ForgeScore and schedules its notes with a lookahead against the AudioContext
// clock. Silent until enable() is called from a user gesture; honours setMuted / setVolume. Music bus:
//   instruments -> (drone generation bus | agent bus) -> musicBus -> DynamicsCompressor -> Synth lowpass/reverb -> master
export class ForgeSynth extends Synth {
  constructor({ project = "alexandria", identities = {}, seed = "forge", lookahead = 0.3 } = {}) {
    super();
    this.opts = { project, identities, seed }; this.lookahead = lookahead;
    this.score = new ForgeScore(this.opts); this.queue = []; this.identityResolver = null; this.agentIdx = new Map();
    this.clock = null; this.gens = new Map(); this.agentBuses = new Map(); this.musicBus = null; this.droneBus = null; this.compressor = null;
  }
  setIdentityResolver(fn) { this.identityResolver = fn; }
  setProject(project) { this.opts.project = project; this.reset(); }
  setSeed(seed) { this.opts.seed = seed; this.reset(); }
  reset() { this.score = new ForgeScore(this.opts); this.queue = []; this.agentIdx.clear(); this.gens.clear(); this.agentBuses.clear(); }
  setState(state) { this.score.setState(state); this.tension = this.score.tension; }

  async enable() {
    if (this.enabled) return;
    await super.enable();
    const c = this.ctx;
    this.musicBus = c.createGain(); this.droneBus = c.createGain(); this.compressor = c.createDynamicsCompressor();
    this.compressor.threshold.value = -20; this.compressor.knee.value = 12; this.compressor.ratio.value = 3.5; this.compressor.attack.value = 0.01; this.compressor.release.value = 0.25;
    this.droneBus.connect(this.musicBus); this.musicBus.connect(this.compressor); this.compressor.connect(this.lowpass);
  }
  disable() { super.disable(); this.musicBus = this.droneBus = this.compressor = null; this.clock = null; this.gens.clear(); this.agentBuses.clear(); }

  // Map the page's scene clock (seconds) to AudioContext time. Anchored on the first tick (or anchorClock()).
  anchorClock(sceneSeconds, audioSeconds) { this.clock = { scene: sceneSeconds, audio: audioSeconds }; }
  audioTimeFor(sceneSeconds) {
    if (!this.ctx) return this.clock ? this.clock.audio + (sceneSeconds - this.clock.scene) : sceneSeconds;
    if (!this.clock) this.anchorClock(sceneSeconds, this.ctx.currentTime + 0.05);
    return this.clock.audio + (sceneSeconds - this.clock.scene);
  }

  _enqueue(notes, instructions = []) {
    if (!this.enabled || this.muted || !this.ctx) return;
    for (const n of notes) this.queue.push({ t: n.time, note: n });
    for (const i of instructions) { const at = i.duck ? i.duck.at : i.at; this.queue.push({ t: at != null ? at : (this.score.lastT || 0), instr: i }); }
    this.queue.sort((a, b) => a.t - b.t);
  }

  // ctx: { identity?: preset name | preset object, agentIndex?, nodeId?, variation?, t?, verified?, discovery?, path? }.
  onEvent(event, ctx = {}) {
    const id = (event.actor || {}).agentId || "main";
    if (!this.agentIdx.has(id)) this.agentIdx.set(id, id === "main" ? 0 : this.agentIdx.size + 1);
    const full = { ...ctx, identity: ctx.identity != null ? ctx.identity : (this.identityResolver ? this.identityResolver(event) : undefined), agentIndex: ctx.agentIndex != null ? ctx.agentIndex : this.agentIdx.get(id) };
    const res = this.score.onEvent(event, full);
    this.bpm = res.bpm; this.tension = this.score.tension;
    this._enqueue(res.notes, res.instructions);
    return res;
  }

  // Call from the page's animation loop with the scene clock. Returns the notes the score scheduled this tick.
  tick(tSeconds) {
    const t = Number.isFinite(tSeconds) ? tSeconds : (this.ctx ? this.ctx.currentTime : 0);
    const notes = this.score.tick(t), instr = this.score.takeInstructions();
    this.bpm = this.score.bpm;
    if (!this.enabled || !this.ctx) return notes;
    const now = this.ctx.currentTime;
    if (!this.clock) this.anchorClock(t, now + 0.05);
    else if (this.clock.audio + (t - this.clock.scene) < now - 0.25) this.anchorClock(t, now + 0.05); // scene clock stalled: re-anchor
    this._enqueue(notes, instr);
    while (this.queue.length) {
      const q = this.queue[0], at = this.audioTimeFor(q.t);
      if (at > now + this.lookahead) break;
      this.queue.shift();
      if (this.muted) continue;
      const when = Math.max(at, now + 0.005);
      if (q.note) this.play(q.note, when); else this._instruction(q.instr, when);
    }
    return notes;
  }

  _agentBus(id) {
    let b = this.agentBuses.get(id);
    if (!b) {
      b = this.ctx.createGain();
      const pan = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
      if (pan) { b.connect(pan); pan.connect(this.musicBus); pan.pan.value = (this.pans && this.pans.get(id)) || 0; b.pan = pan; } else b.connect(this.musicBus);
      this.agentBuses.set(id, b);
    }
    return b;
  }
  // Spatial presentation driven by the composition rather than by the notes: `pans` maps a voice id (agent id or
  // "main") to a stereo position in -1..1 taken from where that agent's region sits in the current view, so a
  // rotating camera moves the sound; `resonance` 0..1 (ripple activity) opens the shared lowpass and deepens the
  // reverb. The drone (foundation) and core stay centred.
  setSpace({ pans = {}, resonance = 0 } = {}) {
    if (!this.pans) this.pans = new Map();
    for (const [id, p] of Object.entries(pans)) {
      const v = Math.max(-1, Math.min(1, Number(p) || 0)); this.pans.set(id, v);
      const b = this.agentBuses.get(id); if (b && b.pan && this.ctx) b.pan.pan.setTargetAtTime(v, this.ctx.currentTime, 0.25);
    }
    if (this.ctx && this.lowpass) {
      const r = Math.max(0, Math.min(1, Number(resonance) || 0));
      this.lowpass.frequency.setTargetAtTime(5000 + 4000 * r, this.ctx.currentTime, 0.3);
      if (this.wet) this.wet.gain.setTargetAtTime(0.2 + 0.2 * r, this.ctx.currentTime, 0.3);
    }
  }
  _genBus(note, when) {
    let g = this.gens.get(note.gen);
    if (!g) {
      g = this.ctx.createGain(); g.connect(this.droneBus); this.gens.set(note.gen, g);
      const fade = note.fadeSec || 1.5;
      for (const [k, old] of [...this.gens]) if (k < note.gen) { old.gain.setTargetAtTime(0, when, fade / 3); this.gens.delete(k); setTimeout(() => { try { old.disconnect(); } catch (e) { /* closed */ } }, (fade * 3 + 1) * 1000); }
    }
    return g;
  }
  _instruction(i, when) {
    if (i.duck && this.droneBus) {
      const g = this.droneBus.gain, d = Math.pow(10, -i.duck.db / 20);
      g.setTargetAtTime(d, when, 0.04); g.setTargetAtTime(1, when + 0.15, Math.max(0.1, i.duck.recoverSec / 3));
    } else if (i.releaseVoice != null) {
      const b = this.agentBuses.get(i.releaseVoice);
      if (b) { b.gain.setTargetAtTime(0, when, 0.4); this.agentBuses.delete(i.releaseVoice); setTimeout(() => { try { b.disconnect(); } catch (e) { /* closed */ } }, 4000); }
    }
  }
  // Play one Forge note (scene time already mapped to `when`). Legacy music.js notes (startBeat) fall back to Synth.play.
  play(note, when) {
    const fn = FORGE_INSTRUMENTS[note.instrument];
    if (!fn) return super.play(note);
    if (!this.ctx || !this.musicBus) return;
    const w = when != null ? when : Math.max(this.audioTimeFor(note.time), this.ctx.currentTime + 0.005);
    let dest;
    if (note.instrument === "additivePad") dest = this._genBus(note, w);
    else if (note.instrument === "coreSine") dest = this.droneBus;
    else dest = this._agentBus(note.voice);
    fn(this.ctx, dest, note, { when: w });
    this.scheduled++;
  }
}
