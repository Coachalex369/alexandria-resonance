// Forge instruments: original procedural Web Audio voices for the Forge score. Browser only at call time, but the
// module itself is plain ES and imports in Node (nothing touches AudioContext until a function is called).
// Every function has the signature (ctx, destination, note, opts) => void and schedules its own nodes; nothing is
// returned, nothing is loaded, no samples. note.time is in the scene clock; the caller passes the matching
// AudioContext time in opts.when (default ctx.currentTime).
//
// Design (timbre follows the role):
//   additivePad  Forge, harmony. Harmonic partials 1..N with 1/k^p amplitudes; brightness (0..1) sets both the
//                partial count (3..7) and the lowpass cutoff, so verifiedFraction literally opens the spectrum.
//                Slow attack, two detuned oscillators on the lowest partials for a gentle chorus. note.decay holds
//                for note.holdSec and then fades to silence by note.durationSec (closing convergence).
//   metalStrike  Smith, rhythm. Modal synthesis: inharmonic partials (default 1, 2.32, 3.73, 5.01), each with its
//                own exponential decay (higher partials die faster). Unverified material adds a detuned twin per
//                partial (note.detuneCents) which beats and rings long; verified material is clean and short.
//   glideFlute   Scout, melody. Sine plus weak 2nd/3rd harmonics, breath noise, delayed vibrato, and portamento from
//                note.glideFromHz over note.glideSec. note.fade makes a dead end: glide down, lowpass closes, fade.
//   coreSine     Core, quiet sine fundamental on the key root, slow attack and release.
//   quenchNoise  Filtered noise sweep downwards (hot metal in water) used when tests pass.
// Gains are conservative; the caller routes everything through a DynamicsCompressor on the music bus.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const FLOOR = 0.0001;

// Deterministic noise (xorshift32) so a given note always renders the same hiss. Sample-level noise only.
function noiseBuffer(ctx, seconds, seed = 1) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
  let x = (seed | 0) || 1;
  for (let i = 0; i < len; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; d[i] = ((x >>> 0) / 4294967296) * 2 - 1; }
  return buf;
}
const seedOf = (note) => Math.floor((note.hz || 1) * 1000) ^ Math.floor((note.time || 0) * 1000);

function osc(ctx, type, hz, when, stop, dest, gain = 1, cents = 0) {
  const o = ctx.createOscillator(); o.type = type; o.frequency.value = hz; if (cents) o.detune.value = cents;
  const g = ctx.createGain(); g.gain.value = gain; o.connect(g); g.connect(dest);
  o.start(when); o.stop(stop);
  return o;
}

export function additivePad(ctx, destination, note, opts = {}) {
  const when = opts.when != null ? opts.when : ctx.currentTime, dur = Math.max(0.2, note.durationSec || 4);
  const b = clamp(note.brightness != null ? note.brightness : 0.5, 0, 1), peak = Math.max(FLOOR * 2, note.gain || 0.08);
  const nPart = 3 + Math.round(4 * b), attack = clamp(dur * 0.25, 0.3, 1.4), rel = clamp(dur * 0.25, 0.4, 1.8);
  const env = ctx.createGain(); env.gain.setValueAtTime(FLOOR, when);
  env.gain.exponentialRampToValueAtTime(peak, when + attack);
  if (note.decay) { const hold = clamp(note.holdSec || 0, attack, dur - 0.1); env.gain.setValueAtTime(peak, when + hold); env.gain.exponentialRampToValueAtTime(FLOOR, when + dur); }
  else { env.gain.setValueAtTime(peak, when + Math.max(attack, dur - rel)); env.gain.exponentialRampToValueAtTime(FLOOR, when + dur); }
  const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 500 + 3500 * b * b; lp.Q.value = 0.4;
  env.connect(lp); lp.connect(destination);
  const stop = when + dur + 0.1, p = 1.6 - 0.8 * b;
  for (let k = 1; k <= nPart; k++) {
    const a = 1 / Math.pow(k, p) / 2.2, hz = note.hz * k;
    if (hz > 12000) break;
    osc(ctx, "sine", hz, when, stop, env, a, k <= 2 ? 3 + k : 0);
    if (k <= 2) osc(ctx, "sine", hz, when, stop, env, a * 0.8, -(3 + k));
  }
}

export function metalStrike(ctx, destination, note, opts = {}) {
  const when = opts.when != null ? opts.when : ctx.currentTime, dur = Math.max(0.1, note.durationSec || 0.5);
  const ratios = note.partials && note.partials.length ? note.partials : [1, 2.32, 3.73, 5.01];
  const amps = [1, 0.7, 0.45, 0.28, 0.18], detune = Math.abs(note.detuneCents || 0), peak = Math.max(FLOOR * 2, note.gain || 0.25);
  const out = ctx.createGain(); out.gain.value = peak / 2; out.connect(destination);
  const stop = when + dur + 0.1;
  ratios.forEach((r, i) => {
    const hz = note.hz * r;
    if (hz > 14000) return;
    const td = Math.max(0.05, dur / (1 + 0.55 * i)), a = amps[i % amps.length];
    const g = ctx.createGain(); g.gain.setValueAtTime(FLOOR, when); g.gain.linearRampToValueAtTime(a, when + 0.002);
    g.gain.exponentialRampToValueAtTime(FLOOR, when + td); g.connect(out);
    osc(ctx, "sine", hz, when, stop, g, 1);
    if (detune > 0) osc(ctx, "sine", hz, when, stop, g, 0.8, detune * (1 + 0.35 * i)); // twin beats against the first
  });
  const n = ctx.createBufferSource(); n.buffer = noiseBuffer(ctx, 0.02, seedOf(note));
  const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 2500;
  const ng = ctx.createGain(); ng.gain.setValueAtTime(0.35, when); ng.gain.exponentialRampToValueAtTime(FLOOR, when + 0.02);
  n.connect(hp); hp.connect(ng); ng.connect(out); n.start(when);
}

export function glideFlute(ctx, destination, note, opts = {}) {
  const when = opts.when != null ? opts.when : ctx.currentTime, dur = Math.max(0.15, note.durationSec || 1);
  const peak = Math.max(FLOOR * 2, note.gain || 0.22), glide = clamp(note.glideSec || 0.09, 0.03, 1.2);
  const env = ctx.createGain(); env.gain.setValueAtTime(FLOOR, when); env.gain.exponentialRampToValueAtTime(peak, when + 0.07);
  const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.setValueAtTime(3200, when);
  if (note.fade) { env.gain.exponentialRampToValueAtTime(FLOOR, when + dur); lp.frequency.exponentialRampToValueAtTime(350, when + dur); }
  else { env.gain.setValueAtTime(peak, when + Math.max(0.07, dur - 0.25)); env.gain.exponentialRampToValueAtTime(FLOOR, when + dur); }
  env.connect(lp); lp.connect(destination);
  const stop = when + dur + 0.1;
  [[1, 1], [2, 0.22], [3, 0.07]].forEach(([k, a]) => {
    const o = osc(ctx, "sine", note.hz * k, when, stop, env, a);
    if (note.glideFromHz && note.glideFromHz !== note.hz) {
      o.frequency.setValueAtTime(note.glideFromHz * k, when);
      o.frequency.exponentialRampToValueAtTime(note.hz * k, when + glide);
    }
    if (k === 1) { // vibrato fades in after the glide
      const lfo = ctx.createOscillator(); lfo.frequency.value = 5.2; const lg = ctx.createGain();
      lg.gain.setValueAtTime(0, when); lg.gain.linearRampToValueAtTime(7, when + Math.min(dur, 0.35 + glide)); lfo.connect(lg); lg.connect(o.detune);
      lfo.start(when); lfo.stop(stop);
    }
  });
  const br = ctx.createBufferSource(); br.buffer = noiseBuffer(ctx, Math.min(dur + 0.1, 2), seedOf(note));
  const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = clamp(note.hz * 2, 400, 6000); bp.Q.value = 1.2;
  const bg = ctx.createGain(); bg.gain.value = 0.05; br.connect(bp); bp.connect(bg); bg.connect(env); br.start(when);
}

export function coreSine(ctx, destination, note, opts = {}) {
  const when = opts.when != null ? opts.when : ctx.currentTime, dur = Math.max(0.5, note.durationSec || 4);
  const peak = Math.max(FLOOR * 2, note.gain || 0.02), att = clamp(dur * 0.3, 0.4, 1.5);
  const env = ctx.createGain(); env.gain.setValueAtTime(FLOOR, when); env.gain.exponentialRampToValueAtTime(peak, when + att);
  if (note.decay) { const hold = clamp(note.holdSec || 0, att, dur - 0.1); env.gain.setValueAtTime(peak, when + hold); }
  else env.gain.setValueAtTime(peak, when + Math.max(att, dur - att));
  env.gain.exponentialRampToValueAtTime(FLOOR, when + dur);
  env.connect(destination);
  osc(ctx, "sine", note.hz, when, when + dur + 0.1, env, 1);
}

export function quenchNoise(ctx, destination, note, opts = {}) {
  const when = opts.when != null ? opts.when : ctx.currentTime, dur = Math.max(0.2, note.durationSec || 0.7);
  const peak = Math.max(FLOOR * 2, note.gain || 0.12), from = note.sweepFromHz || 6500, to = note.sweepToHz || 250;
  const src = ctx.createBufferSource(); src.buffer = noiseBuffer(ctx, dur, seedOf(note));
  const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.Q.value = 1.5;
  bp.frequency.setValueAtTime(from, when); bp.frequency.exponentialRampToValueAtTime(to, when + dur);
  const g = ctx.createGain(); g.gain.setValueAtTime(FLOOR, when); g.gain.exponentialRampToValueAtTime(peak, when + 0.03);
  g.gain.exponentialRampToValueAtTime(FLOOR, when + dur);
  src.connect(bp); bp.connect(g); g.connect(destination); src.start(when);
}

export const FORGE_INSTRUMENTS = { additivePad, metalStrike, glideFlute, coreSine, quenchNoise };
