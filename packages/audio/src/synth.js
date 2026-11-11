// Web Audio synthesizer for the generative music prototype. Browser only. Everything is procedural:
// oscillators, simple partials, envelopes, a noise burst for percussion, one shared lowpass and a light reverb
// made from a decaying feedback delay. Nothing is loaded from disk. Audio is OFF until enable() is called
// from a user gesture, and the master gain honours mute and volume.
import { INSTRUMENTS, notesForEvent, tempoFromPace, projectCharacter } from "./music.js";

export class Synth {
  constructor() { this.ctx = null; this.master = null; this.muted = false; this.volume = 0.5; this.enabled = false; this.bpm = 72; this.tension = 0; this.counter = 0; this.agents = new Map(); this.intervals = []; this.lastTs = null; this.character = projectCharacter("alexandria"); this.scheduled = 0; }

  // Must be called from a click/keypress handler (autoplay policy).
  async enable() {
    if (this.enabled) return;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    this.ctx = new AC();
    this.master = this.ctx.createGain(); this.master.gain.value = this.muted ? 0 : this.volume;
    this.lowpass = this.ctx.createBiquadFilter(); this.lowpass.type = "lowpass"; this.lowpass.frequency.value = 6000;
    this.delay = this.ctx.createDelay(1.0); this.delay.delayTime.value = 0.31; this.feedback = this.ctx.createGain(); this.feedback.gain.value = 0.28; this.wet = this.ctx.createGain(); this.wet.gain.value = 0.22;
    this.lowpass.connect(this.master); this.lowpass.connect(this.delay); this.delay.connect(this.feedback); this.feedback.connect(this.delay); this.delay.connect(this.wet); this.wet.connect(this.master);
    this.master.connect(this.ctx.destination);
    await this.ctx.resume();
    this.enabled = true;
  }
  disable() { if (this.ctx) { this.ctx.close(); this.ctx = null; } this.enabled = false; }
  setMuted(m) { this.muted = m; if (this.master) this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx.currentTime, 0.02); }
  setVolume(v) { this.volume = Math.max(0, Math.min(1, v)); if (this.master && !this.muted) this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02); }
  setProject(project) { this.character = projectCharacter(project); }

  // Feed one normalized event; returns the musical decision (for display) whether or not audio is enabled.
  onEvent(event) {
    const ts = Date.parse(event.ts);
    if (this.lastTs != null && ts > this.lastTs) { this.intervals.push(ts - this.lastTs); if (this.intervals.length > 16) this.intervals.shift(); this.bpm = tempoFromPace(this.intervals); }
    this.lastTs = ts;
    if (event.actor?.type === "subagent" && !this.agents.has(event.actor.agentId)) this.agents.set(event.actor.agentId, this.agents.size);
    const agentIndex = event.actor?.type === "subagent" ? this.agents.get(event.actor.agentId) : 0;
    const decision = notesForEvent(event, { character: this.character, tension: this.tension, agentIndex, counter: this.counter });
    if (event.kind === "tool.result") this.counter++;
    this.tension = Math.max(0, Math.min(1, this.tension + decision.tensionDelta * 0.5));
    if (this.enabled && !this.muted) for (const n of decision.notes) this.play(n);
    return { ...decision, bpm: this.bpm, tension: this.tension };
  }

  play(note) {
    const ctx = this.ctx, beat = 60 / this.bpm;
    const t0 = ctx.currentTime + 0.02 + note.startBeat * beat;
    const inst = INSTRUMENTS[note.instrument] || INSTRUMENTS.pad;
    const dur = Math.max(0.05, note.lengthBeats * beat);
    const env = ctx.createGain(); env.gain.setValueAtTime(0.0001, t0); env.gain.exponentialRampToValueAtTime(Math.max(0.0002, note.gain), t0 + inst.attack); env.gain.setValueAtTime(Math.max(0.0002, note.gain), t0 + inst.attack + dur * 0.6); env.gain.exponentialRampToValueAtTime(0.0001, t0 + inst.attack + dur * 0.6 + inst.release);
    let out = env;
    if (inst.lowpass) { const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = inst.lowpass; env.connect(lp); out = lp; }
    out.connect(this.lowpass);
    const partials = inst.partials || [1];
    partials.forEach((ratio, i) => {
      const osc = ctx.createOscillator(); osc.type = inst.wave; osc.frequency.value = note.hz * ratio;
      if (inst.detune) osc.detune.value = (i % 2 ? -1 : 1) * inst.detune;
      if (inst.vibrato) { const lfo = ctx.createOscillator(); const lg = ctx.createGain(); lfo.frequency.value = inst.vibrato; lg.gain.value = 3; lfo.connect(lg); lg.connect(osc.frequency); lfo.start(t0); lfo.stop(t0 + dur + inst.release + 0.1); }
      const pg = ctx.createGain(); pg.gain.value = 1 / (i + 1) / partials.length; osc.connect(pg); pg.connect(env);
      osc.start(t0); osc.stop(t0 + inst.attack + dur * 0.6 + inst.release + 0.05);
    });
    if (inst.chord) for (const semis of inst.chord.slice(1)) { const o = ctx.createOscillator(); o.type = inst.wave; o.frequency.value = note.hz * Math.pow(2, (semis * 2) / 12); const g = ctx.createGain(); g.gain.value = 0.5; o.connect(g); g.connect(env); o.start(t0); o.stop(t0 + inst.attack + dur * 0.6 + inst.release + 0.05); }
    if (inst.noise) { const len = Math.floor(ctx.sampleRate * 0.08); const buf = ctx.createBuffer(1, len, ctx.sampleRate); const d = buf.getChannelData(0); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len); const src = ctx.createBufferSource(); src.buffer = buf; const ng = ctx.createGain(); ng.gain.value = 0.6; src.connect(ng); ng.connect(env); src.start(t0); }
    this.scheduled++;
  }
}
