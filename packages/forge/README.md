# @alexandria/forge

The Forge: event-driven multidimensional geometric composition. See `docs/FORGE.md` for the full description,
measurements and limitations.

```
npm run demo
  http://127.0.0.1:4331/packages/forge/lab.html   Geometry Laboratory (standalone experiments)
  http://127.0.0.1:4331/packages/forge/            The Forge (recording replay → composition)
node --test "packages/forge/test/*.test.js"
node tools/forge-bench.js [events] [agents] [ticksPerEvent]
```

Files

- `src/composer.js` — events → structures (per agent + satellites), bounded growth, dynamics, ripples, provenance, deterministic snapshots.
- `src/ripples.js` — graph waves with interference and hue blending; screen rings; bounded.
- `src/render2d.js` — Canvas 2D wire renderer (depth cue, additive glow, faces, nodes, rings, picking).
- `src/fingerprint.js` — session fingerprint, seeded PRNG, stable JSON, snapshot hash.
- `src/labModel.js` — pure state model for the laboratory.
- `forge-mapping.json` — operations/categories → geometric operations, growth stages and caps, dynamics, ripple styles, layout.
- `identities.json` — agent identity presets (Forge, Smith, Scout) and the agentType → identity table.
- `index.html`, `forge.js`, `forge.css` — The Forge page. `lab.html`, `lab.js`, `lab.css` — the laboratory.

Rules kept everywhere: a subagent stop docks its structure and never completes the composition; only the main
task's end resolves it. No event content is stored or displayed; the inspector shows metadata and provenance only.
Audio is optional, off by default, muted until unmuted, and independent of other apps' alerts.

## As above, so below (`universe.html`)

One universe in a shared coordinate system: the reference plane spreads as planning accumulates, crystals rise from
its sites as files are created and edited, research roots grow beneath, verified crystals gain reflections beneath
the plane, commits seal membranes, and a four-dimensional field turns through the origin. A camera director tells the
story of discovery (grounded, curiosity, revelation, expansion, completion); drag to take over, Resume director to
hand back. WebGL (Three.js) renderer; music optional and off by default. See docs/FORGE.md.
