// Generative music mapping: taxonomy events → musical decisions. Pure functions, browser- and Node-safe.
// No recordings, samples or copyrighted material: everything is synthesized from scales and envelopes.
//
// Nested structure (Priority 5):
//   project  → key (root note) and mode: the overall character of the piece
//   session  → tempo band from the observed event pace
//   task     → a section: opens with a motif statement, closes with a cadence (resolution)
//   agent    → a voice: the main thread carries the lead register, each subagent gets its own register and
//              rhythmic offset so parallel agents interlock instead of colliding
//   work category → instrument (timbre) and motif contour
//   code structure → ornament: functions add a rising figure, loops a repeated figure, conditions a fork (two notes)
//   operation → rhythmic cell (edit = short pulse, run = sustained, read = soft tick, delegate = split chord)
//   testing / errors / completion → tension (dissonant interval, minor shift) and resolution (tonic chord, bell)

export const MODES = {
  ionian: [0, 2, 4, 5, 7, 9, 11], dorian: [0, 2, 3, 5, 7, 9, 10], lydian: [0, 2, 4, 6, 7, 9, 11], mixolydian: [0, 2, 4, 5, 7, 9, 10], aeolian: [0, 2, 3, 5, 7, 8, 10], pentatonic: [0, 2, 4, 7, 9],
};

// Deterministic character per project name: root note and mode. Same project → same key every session.
export function projectCharacter(project) {
  let h = 7; for (const ch of String(project || "alexandria")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const modes = Object.keys(MODES);
  return { root: 48 + (h % 12), mode: modes[(h >>> 4) % modes.length], brightness: ((h >>> 8) % 100) / 100 };
}

export const INSTRUMENTS = {
  pad: { wave: "sine", attack: 0.6, release: 2.5, gain: 0.25, detune: 6 },
  bell: { wave: "sine", attack: 0.005, release: 1.8, gain: 0.3, partials: [1, 2.76, 5.4] },
  pluck: { wave: "triangle", attack: 0.004, release: 0.5, gain: 0.35 },
  bass: { wave: "sawtooth", attack: 0.02, release: 0.6, gain: 0.3, octave: -1, lowpass: 400 },
  percussion: { wave: "square", attack: 0.001, release: 0.12, gain: 0.25, noise: true },
  "low-brass": { wave: "sawtooth", attack: 0.08, release: 0.9, gain: 0.28, octave: -1, lowpass: 900 },
  arp: { wave: "triangle", attack: 0.01, release: 0.3, gain: 0.3, octave: 1 },
  flute: { wave: "sine", attack: 0.08, release: 0.7, gain: 0.3, octave: 1, vibrato: 5 },
  chord: { wave: "triangle", attack: 0.05, release: 1.5, gain: 0.22, chord: [0, 2, 4] },
};

// Rhythmic cells per operation (fractions of a beat, note lengths in beats).
export const CELLS = {
  edit: { lengthBeats: 0.25, accent: 0.9 }, create: { lengthBeats: 0.5, accent: 1.0 }, read: { lengthBeats: 0.125, accent: 0.4 }, search: { lengthBeats: 0.25, accent: 0.5 },
  run: { lengthBeats: 1.0, accent: 0.7 }, test: { lengthBeats: 1.5, accent: 0.8 }, build: { lengthBeats: 2.0, accent: 0.7 }, commit: { lengthBeats: 2.0, accent: 1.0 },
  delegate: { lengthBeats: 1.0, accent: 0.9, split: true }, browse: { lengthBeats: 0.5, accent: 0.5 }, ask: { lengthBeats: 3.0, accent: 0.3 }, plan: { lengthBeats: 2.0, accent: 0.4 },
  publish: { lengthBeats: 1.0, accent: 0.8 }, schedule: { lengthBeats: 0.125, accent: 0.3 }, other: { lengthBeats: 0.25, accent: 0.4 },
};

// Scale degree contour per work category (motif). Degrees index the mode; octaves wrap.
export const MOTIFS = {
  research: [0, 2, 4, 2], planning: [0, 4, 2, 5], "ui-design": [4, 6, 4, 2], frontend: [0, 2, 4, 6], backend: [0, -3, 0, -3], database: [0, -3, -5, -3], api: [0, 3, 0, 3],
  testing: [4, 4, 4, 4], debugging: [1, 0, 1, 0], security: [0, -7, -4, -7], performance: [0, 4, 7, 11], documentation: [2, 4, 5, 4], "deployment-prep": [0, 4, 7, 12], tooling: [0, 7, 0, 7], localization: [2, 3, 5, 3], "data-analysis": [0, 1, 2, 3],
};

export function degreeToMidi(root, mode, degree, octave = 0) {
  const scale = MODES[mode] || MODES.ionian;
  const n = scale.length;
  const oct = Math.floor(degree / n) + octave;
  const idx = ((degree % n) + n) % n;
  return root + scale[idx] + 12 * oct;
}
export const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

// Voice assignment: main thread lead register; subagents alternate above and below, with a phase offset.
export function voiceFor(actor, agentIndex = 0) {
  if (!actor || actor.type !== "subagent") return { register: 0, phase: 0, gainScale: 1.0, name: "main" };
  const sign = agentIndex % 2 === 0 ? 1 : -1;
  return { register: sign * (1 + Math.floor(agentIndex / 2)), phase: 0.5 * ((agentIndex % 3) + 1) / 3, gainScale: 0.6, name: actor.agentType || actor.agentId || "agent" };
}

// Tempo from the recent event pace: more events per minute → faster, clamped to a musical band.
export function tempoFromPace(intervalsMs) {
  if (!intervalsMs.length) return 72;
  const med = [...intervalsMs].sort((a, b) => a - b)[Math.floor(intervalsMs.length / 2)];
  const bpm = 60000 / Math.max(250, Math.min(8000, med / 4)); // one event ≈ a bar of four beats
  return Math.round(Math.max(56, Math.min(132, bpm)));
}

// The main decision: an event → a list of notes { hz, startBeat, lengthBeats, instrument, gain, voice } plus
// a tension delta (positive = more dissonance pending, negative = resolve). Pure: no audio here.
export function notesForEvent(event, ctx) {
  const { character, tension = 0, agentIndex = 0 } = ctx;
  const notes = [];
  const cls = event.classification || [];
  const category = cls.filter((c) => c.scheme === "work-category").sort((a, b) => b.confidence - a.confidence)[0]?.value || "research";
  const operation = cls.find((c) => c.scheme === "operation")?.value || (event.kind === "test.run" ? "test" : event.kind === "git.commit" ? "commit" : "other");
  const structures = cls.filter((c) => c.scheme === "code-structure").map((c) => c.value);
  const voice = voiceFor(event.actor, agentIndex);
  const inst = INSTRUMENTS[({ research: "pad", planning: "pad", "ui-design": "bell", frontend: "pluck", backend: "bass", database: "bass", api: "pluck", testing: "percussion", debugging: "percussion", security: "low-brass", performance: "arp", documentation: "flute", "deployment-prep": "chord", tooling: "arp", localization: "flute", "data-analysis": "pad" })[category] || "pad"];
  const instName = Object.keys(INSTRUMENTS).find((k) => INSTRUMENTS[k] === inst);
  const cell = CELLS[operation] || CELLS.other;
  const motif = MOTIFS[category] || MOTIFS.research;
  let tensionDelta = 0;
  const base = (deg, octaveShift = 0, start = 0, len = cell.lengthBeats, gain = cell.accent) =>
    notes.push({ hz: midiToHz(degreeToMidi(character.root, character.mode, deg + (tension > 0.5 ? 1 : 0), voice.register + octaveShift + (inst.octave || 0))), startBeat: start + voice.phase, lengthBeats: len, instrument: instName, gain: gain * voice.gainScale * inst.gain, voice: voice.name });

  switch (event.kind) {
    case "task.start": for (let i = 0; i < motif.length; i++) base(motif[i], 0, i * 0.5, 0.5, 0.8); break; // motif statement
    case "task.end": for (const d of [0, 2, 4, 7]) base(d, 0, 0, 3, 0.9); tensionDelta = -1; break;            // cadence: tonic chord
    case "turn.stop": base(0, 0, 0, 2, 0.7); base(4, 0, 0, 2, 0.5); tensionDelta = -0.5; break;
    case "agent.start": base(motif[0], 0, 0, 1, 0.6); base(motif[0] + 4, 0, 0.5, 1, 0.5); break;                 // a new voice enters on a fifth
    case "agent.stop": base(motif[0] + 2, 0, 0, 1.5, 0.5); break;                                                 // voice resolves, no cadence
    case "test.run": if (event.payload?.ok) { for (const d of [0, 4]) base(d, 1, 0, 1.5, 0.8); tensionDelta = -0.6; } else { base(0, 0, 0, 1.5, 0.9); base(1, 0, 0, 1.5, 0.9); tensionDelta = 0.6; } break; // consonant vs minor second
    case "tool.failure": base(0, 0, 0, 0.5, 0.8); base(6, -1, 0, 0.5, 0.8); tensionDelta = 0.4; break;              // tritone
    case "git.commit": for (const d of [0, 4, 7]) base(d, 0, 0, 2.5, 0.9); tensionDelta = -0.8; break;              // seal: major triad
    case "notification": base(0, 1, 0, 3, 0.3); break;                                                             // held tone while waiting
    case "tool.result": case "tool.call": {
      if (event.kind === "tool.call") break; // sound on completion only, so the rhythm follows real durations
      const i = (ctx.counter || 0) % motif.length;
      base(motif[i], 0, 0, cell.lengthBeats, cell.accent);
      if (cell.split) base(motif[i] + 4, 0, 0, cell.lengthBeats, cell.accent * 0.8);
      // ornaments from code structures
      if (structures.includes("function")) base(motif[i] + 2, 0, cell.lengthBeats * 0.5, 0.25, 0.5);
      if (structures.includes("loop")) for (let k = 1; k <= 2; k++) base(motif[i], 0, cell.lengthBeats * 0.33 * k, 0.15, 0.4);
      if (structures.includes("condition")) base(motif[i] + 1, 0, 0, 0.25, 0.4);
      if (structures.includes("test-case")) base(motif[i] + 7, 1, 0, 0.2, 0.5);
      break;
    }
    default: break;
  }
  return { notes, tensionDelta, category, operation, voice: voice.name, instrument: instName };
}
