# @alexandria/audio — generative music prototype

Turns the shared event stream into an original, evolving piece using only procedural Web Audio synthesis
(oscillators, envelopes, a noise burst, a feedback-delay reverb). No samples, no MIDI files, no
copyrighted melodies or sound assets. Audio is **disabled until the user presses Enable** (a user
gesture is also what the browser autoplay policy requires); mute and volume are always available.

Run: `node tools/serve-demo.js` then open http://127.0.0.1:4331/packages/audio/ , pick a recording, Play.
Enable audio to hear it; without enabling, the page still shows every musical decision in the log.

## Mapping (src/music.js, pure functions, unit-tested)

| Level | Musical role |
|---|---|
| project | key (root) and mode, deterministic from the project name |
| session | tempo band from the recent event pace (56–132 bpm) |
| main task | section: motif statement on `task.start`, tonic cadence on `task.end` |
| agent | voice: main thread in the lead register; each subagent in its own register with a phase offset so parallel agents interlock |
| work category | instrument (pad, bell, pluck, bass, percussion, low brass, arp, flute, chord) and motif contour |
| code structure | ornament: function → rising figure, loop → repeated figure, condition → fork, test-case → high tick |
| operation | rhythmic cell: edit short pulse, run sustained, read soft tick, delegate split chord, ask held tone |
| tests, errors, completion | tension (minor-second or tritone, raised degree) and resolution (consonant fifth, major triad seal, cadence) |

Subagent `agent.stop` is a single resolving tone, never a cadence: only the main task completes a section.

## Files
- `src/music.js` — decisions (`notesForEvent`, `projectCharacter`, `tempoFromPace`, `voiceFor`), Node-safe.
- `src/synth.js` — Web Audio engine (`Synth`): enable/disable, mute, volume, scheduling.
- `index.html` — demo page using the engine's `Replayer`.
- `test/music.test.js` — mapping tests including a full pass over the synthetic recording.

## Not done
- No persistence of the piece (export to MIDI/WAV would be a later feature; MIDI generation would use the same decisions).
- No per-project instrument presets beyond key/mode; no mixing against the visualizer's clock yet (both consume the same Replayer, so synchronizing is a wiring task).

## Forge music
One shared composition for The Forge visualizer, driven by the same composition state as the geometry: **Forge = harmony, Smith = rhythm, Scout = melody** (Core = a quiet root fundamental). First experimental version. `src/forge-music.js` (`ForgeScore`, `ForgeSynth`) builds on `music.js` and `synth.js` (unchanged); `src/forge-instruments.js` holds the procedural Web Audio instruments. No samples, no Math.random in the score.

- **Two clocks.** Events arrive irregularly; the score keeps a stable 4/4 clock. bpm follows the event pace (60-112, at most 4 bpm per bar) and changes only at bar lines (the next bar's bpm is locked on entering a bar). Every note sits on a 16th slot; `score.grid(t)` returns `{ bpm, bar, beat, sixteenth, nextSlotTime }`. Smith gets at most one note per slot, on a parity lane per agent (tension flips the lane) and a per-bar budget, so fast edits become an interlocking pattern.
- **Shared key and harmony.** `projectCharacter` gives root and mode. Chord regions (I IV V vi style, modal variants) advance only at structural events (`task.start`, a plan phase, `agent.start`, main `turn.stop`, `ctx.structural`), at least 2 bars apart, otherwise every 8 bars. A change lands on the next bar line and is voice-led: each held Forge tone moves to the nearest chord tone.
- **File pitches.** `pitchForPath(path, character)` maps a path to a scale degree (2 octaves). `tool.result`/`tool.failure` use `payload.paths[0]` (or `ctx.path`); every voice plays the same pitch for the same file (`state().filePitches`).
- **Voices.** Forge (`additivePad`): 3-6 tone drone, brightness follows `verifiedFraction`, ducked 6-9 dB while others articulate. Smith (`metalStrike`, modal synthesis, partials 1, 2.32, 3.73, 5.01): long and beating when `ctx.verified` is false (default), short and clean when true. Scout (`glideFlute`): portamento 60-120 ms (`glideFromHz`), theme fragments; a dead end (failure, or a search with no follow-up for 2 bars) glides down and fades; a discovery (first read of a file later edited by another voice, or `ctx.discovery`) lands on a chord tone for 2 beats and Forge adds that tone to the drone. Core (`coreSine`, only when a preset with role `core` exists): silent without a task, gain rises with `verifiedFraction`.
- **Tension and verification.** Failures raise tension (displaced lane, minor-second colour, flattened third at the next voicing); passing tests lower it with a quench figure (`quenchNoise` sweep + consonant dyad) and pull the chord region to the tonic. `setState({ resolved: true })` (or `task.end`) plays the closing once: theme restated over the tonic with every active voice, drone decays within about 8 beats, then `ended` (no notes until a new `task.start`).
- **Limits and fatigue.** 10 simultaneous voices (pad and core count one each), 3 per agent, oldest voice stolen (`{ stealVoice, at }` instruction). Per-minute articulation budget (96) x0.85 per 10 minutes of event time, floor 0.4. After 2 silent bars only drone and core remain and the drone loses 3 dB per bar. `agent.stop` yields only `{ releaseVoice }`.

API
- `new ForgeScore({ project, identities, seed })`
  - `onEvent(event, ctx)` -> `{ notes, tensionDelta, bpm, theme, phase, instructions, chord }`. `ctx`: `{ identity, agentIndex, nodeId, t, verified, discovery, path, variation, structural }`; `t` is the scene clock in seconds (falls back to `event.ts` relative to the first event).
  - `tick(tSeconds)` -> sparse scheduled notes (drone and core refreshes, closing, dead ends, automatic chord changes); `takeInstructions()` drains instructions produced by `tick`.
  - `setState({ verifiedFraction, tension, resolved, agents: [{ id, identity, active, docked }], phase })`: call every animation tick; emits nothing itself.
  - `state()` (serializable; includes `droneTones`, `droneBrightness`, `chord`, `filePitches`, `budgetPerMinute`), `grid(t)`, `barInfo(bar)`, `duckAt(t)`.
- Note: `{ id, time, hz, glideFromHz, glideSec, durationSec, instrument, gain, voice, identity, role, ref: { eventId, nodeId, path? }, bar, sixteenth, bpm, ... }` plus instrument fields (`partials`, `detuneCents`, `verified`, `brightness`, `gen`, `decay`/`holdSec`, `fade`, `degree`, `sweepFromHz`/`sweepToHz`). `time` is absolute seconds in the page's scene clock.
- Instructions: `{ duck: { db, at, recoverSec } }`, `{ releaseVoice }`, `{ stealVoice, at }`, `{ discovery }`, `{ converge }`, `{ newTheme }`.
- `new ForgeSynth({ project, identities, seed })` extends `Synth` (browser only): `onEvent`, `tick(tSeconds)`, `setState`, `audioTimeFor(sceneSeconds)` / `anchorClock(scene, audio)`, `setIdentityResolver`, `reset/setSeed/setProject`, inherited `enable()` (user gesture), `setMuted`, `setVolume`. Notes are scheduled with a 0.3 s lookahead; the music bus runs through a `DynamicsCompressor`. Silent until enabled; no Scoreboard alert sounds.
- Instruments: `(ctx, destination, note, opts) => void` for `additivePad`, `metalStrike`, `glideFlute`, `coreSine`, `quenchNoise` (`opts.when` = AudioContext time).
- Tests: `test/forge-music.test.js`.
