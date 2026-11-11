# Alexandria Resonance: Canvas 2D visualizer (early prototype)

Zero-dependency geometric visualizer: plain ES modules, Canvas 2D, no build step.

## Run

    node tools/serve-demo.js      # from the repo root
    # open http://127.0.0.1:4331/packages/visualizer/

Test: `node --test "packages/visualizer/test/*.test.js"` (no DOM needed).

## Files

- `scene.js` - renderer-independent scene model. `ingest(event, now)` + `primitives(now)` -> drawable primitives in unit space. A WebGL renderer can reuse it.
- `viz.js` - Canvas drawing, recording loader, transport, live tail. Documents every mapping key in its header comment.
- `mapping.json` - configuration overrides (see below). `index.html`, `style.css` - page.

## Controls

Recording dropdown (the recordings in `/demo/recordings/`) or "Open file" for any `.events.jsonl`; Play/Pause; speed 1x/10x/30x/100x (default 30x); seek slider; palette preset; "live tail" polls `/demo/recordings/live-hooks.events.jsonl` (your own recording, written by `npm run demo:record`; not shipped) every 2 s and animates new lines (no server is implemented; the file only grows when the engine ingests again). The footer shows LiveState: open tools, running agents, open tasks, waiting flag.

## How events map

Continuous layer (short-lived): each `tool.call`/`tool.result`/`tool.failure` spawns an element. Hue and shape come from the work-category (`hintsFor`), motion from the operation (drift, sweep, pulse, bloom, spin, split, hold, flash, stack, seal, tick). Subagent events orbit in a per-agentId lane (dimmer palette, offset phase, orbit speed tied to the main tempo). `agent.start` opens the lane, `agent.stop` only resolves it (contracting ring, no frame). The centre heartbeat period is the mean of the last N event gaps.

Persistent layer (never fades): each `tool.result` adds a small mark at a position hashed from actor + category (same work lands in the same region). `test.run` ok adds a bright ring, failed a red crack; `git.commit` a seal; `task.end` a closing frame (a faint frame on main-thread `turn.stop`). A `permission_prompt` notification dims everything and freezes the heartbeat until the next `tool.result` or `prompt.submit`.

## Mapping

`mapping.json` is read at startup; taxonomy hints are the defaults. Keys: `categoryHue`, `shapeSizes`, `motionSpeeds`, `layerOpacity`, `timing`, `palettes` (active + presets). Details in the `viz.js` header.

## Intentionally not done

No 3D / WebGL / Three.js, no audio, no server, no code-structure geometry beyond a shape fallback, no persistence of view settings, no polish pass on shape art or layout.
