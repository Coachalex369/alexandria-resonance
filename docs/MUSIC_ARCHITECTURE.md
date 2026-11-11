# Original generative music — architecture (`packages/audio/`)

## Research summary

Options considered: (1) **procedural synthesis in the browser with the Web Audio API** (no dependency, no
assets, deterministic, runs in Electron/Tauri webviews); (2) **Tone.js** (MIT, 12k+ stars; a scheduler and
instrument layer over Web Audio, useful later for polish but not needed for a prototype); (3) **MIDI
generation** (e.g. `midi-writer-js`, MIT) for exporting the piece to a DAW; (4) sample-based or
soundfont playback (rejected for now: licence review per asset and larger downloads). The prototype uses
option 1 only; option 3 is the natural export path since every decision is already a note list.

Copyright: nothing is reproduced. Scales, modes and chord shapes are not copyrightable; all melodic material
is generated from the taxonomy at run time; no recordings, soundfonts or sample packs are included.

## Nested structure

| Level | Musical role | Implemented |
|---|---|---|
| project | key and mode, deterministic from the name (same project, same sound every session) | yes |
| session | tempo from the recent event pace, clamped 56–132 bpm | yes (calibration needed: replay compresses gaps) |
| main task | section: motif statement at `task.start`, tonic cadence at `task.end` | yes |
| agents | voices: main thread leads; each subagent gets its own register and phase offset so parallel agents interlock | yes |
| work category | instrument and motif contour (pad, bell, pluck, bass, percussion, low brass, arp, flute, chord) | yes |
| code structure | ornaments (function rising figure, loop repeat, condition fork, test-case tick) | yes |
| operation | rhythmic cell (edit pulse, run sustained, read tick, delegate split chord, ask held tone) | yes |
| tests / errors / completion | tension up on failed test (minor second) or tool failure (tritone); resolution on passing test, commit (major triad) and cadence | yes |

Subagent completion is a single resolving tone, never a cadence. Only the main task completes.

## Engine

`src/music.js` is pure (Node-tested): `projectCharacter`, `tempoFromPace`, `voiceFor`, `notesForEvent`.
`src/synth.js` is the Web Audio engine: oscillators with partials, envelopes, per-instrument lowpass, a
noise burst for percussion, a feedback-delay reverb, one master gain. `enable()` must be called from a
user gesture; `setMuted`, `setVolume` always work; default state is **disabled**.

## Verified

6 tests including a full pass over the synthetic recording (every event handled, three voices present,
tension bounded). Browser check 2026-11-08: the page streams decisions per event with audio off; audio was
not enabled during the automated check (requires a user click by design).

## Next

Tempo from recording-time pace with a smoothing window; per-project instrument presets; synchronize with
the visualizer's Replayer (both already consume the same clock); MIDI export; a "render to WAV" offline
path for sharing a finished task's piece; optional Tone.js for scheduling precision if needed.
