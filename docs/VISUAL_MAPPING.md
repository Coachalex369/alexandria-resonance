# Visual mapping system (`packages/visualizer/`)

Prototype built on Canvas 2D with zero dependencies. Scene logic (`scene.js`) is pure and renderer-independent;
`viz.js` draws it. A WebGL/Three.js renderer can later consume the same primitives.

## Two layers, one canvas

| Layer | Driven by | Behaviour |
|---|---|---|
| Continuous | every `tool.call` / `tool.result` / `tool.failure` | spawns a short-lived element: hue and shape from the event's work-category (taxonomy hints), motion from the operation (drift, sweep, pulse, bloom, spin, split, hold, flash, stack, seal, tick); subagents orbit in their own lane per `agentId` with a dimmer palette and the same tempo at an offset phase; `agent.start` opens the lane, `agent.stop` resolves it |
| Persistent composition | every `tool.result` | a permanent mark placed by a deterministic hash of actor + category (the same kind of work always lands in the same region); `test.run ok` adds a bright ring, `ok:false` a red crack; `git.commit` a seal; main-thread `turn.stop` a faint frame; `task.end` the closing frame ("task complete"); `notification permission_prompt` dims everything until the next `tool.result` or `prompt.submit` |

Rhythm: the pulse period is the mean of the last eight event intervals (clamped 180–2400 ms), so a busy
agent breathes faster. Only the main thread completes.

## Mapping configuration (`mapping.json`, overrides the taxonomy defaults)

`categoryHue` (per work-category), `shapeSizes` (per shape), `motionSpeeds` (per motion), `layerOpacity`
(persistent / continuous / lanes), `timing` (interval window, min/max period, element lifetime),
`palettes` (presets). Key-by-key notes are in the header comment of `viz.js`.

## Transport and inputs

Recording dropdown (the two files under `demo/recordings/`) or any `.events.jsonl` via the file picker;
speeds 1×/10×/30×/100×; play/pause; seek slider; footer readout from `LiveState` (open tools, running
agents, open tasks, marks, pulse, waiting/complete). "Live tail" polls the live recording every 2 s for new
lines, which is how a collector log can feed it until a proper in-process event bus exists.

## Verified

7 scene tests (elements per tool event, lane open/close per agent, monotonic marks, deterministic region,
failed test mark, task.end completes while agent.stop does not, permission dimming). Browser check on
2026-11-08: both layers animate at 30×, no console errors, closing frame drawn at task end.

## Next

Code-structure geometry (spoke/ring/spiral/fork from Tree-sitter events) is only a fallback shape today;
seek replays from the start (slow on large files); live tail untested against a growing file; palettes are
provisional; the eventual 3D agent environment is explicitly out of scope for this prototype.
