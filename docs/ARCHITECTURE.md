# Shared event engine — architecture and data sources

## Principles

1. **Local-first.** Everything is read and stored on the user's machine. No network transmission exists in
   any package; the only outbound calls in the whole system are the ones Claude Code itself makes.
2. **Facts before inferences.** Every event carries `provenance.observed` (true = taken directly from a
   source) and every classification carries `basis` (observed / inferred / declared) and a `confidence`.
   A fact can wear uncertain labels without the fact becoming uncertain.
3. **No content.** Payloads hold names, ids, counts, durations, paths and hashes. Never prompt text, tool
   inputs/outputs, file contents, assistant messages or secrets. The schema validator rejects payload keys
   such as `content`, `stdout`, `prompt`, `code`, `token`, `password`.
4. **UI-independent.** The engine is plain ES modules; the browser-safe core (schema, ids, replay, live
   state, task linking, test-output parsing) has no Node imports, so the same code runs in other Alexandria applications,
   Resonance and the CLI.
5. **Extensible by adapters.** A source becomes an adapter that emits normalized events; other coding
   agents (Codex, Cursor, Aider…) would be new adapters, not new schemas.

## Normalized event (schema `alexandria.event/1`, `packages/event-engine/src/schema.js`)

```
id            stable or random id (stable ids make re-ingestion idempotent)
ts            ISO-8601 UTC with milliseconds
source        claude-hooks | claude-transcript | claude-statusline | otel | git | tests | build | parser | marks | synthetic | manual
kind          session.start/end, prompt.submit, turn.stop, notification, tool.call/result/failure, agent.start/stop,
              task.start/end/estimate/scope-change, git.commit, code.change, test.run, build.run, code.structure, eta.update, state.change
session       { id, project }
actor         { type: main|subagent|human|system|ci, agentId?, agentType?, model?, modelConfidence: observed|declared|inferred|unknown }
parent        explicit links: { promptId?, toolUseId?, agentId?, taskId?, commit? }
task          { id, title }
payload       kind-specific, content-free
classification[] { scheme, value, basis, confidence, by }   schemes: work-category, language, code-structure, operation, task-type, complexity
durationMs
provenance    { observed, adapter, confidence, raw: { file, line | hash } }
```

Hierarchy is expressed by ids, not nesting: project → session (`session.id`) → task (`task.id`) → prompt
(`parent.promptId`) → tool call (`parent.toolUseId`) → agent (`actor.agentId`, spawned by `parent.toolUseId`).

## Components

| Module | Role |
|---|---|
| `store.js` | append-only JSONL with id dedupe; stats; per-session summary |
| `replay.js` `Replayer` | plays a sorted event list on a scaled clock (speed, pause/resume, seek, drain); injectable timers for tests |
| `replay.js` `LiveState` | the shared model: open tools, running agents, open tasks, waiting flag, counts; `agent.stop` never closes a task |
| `tasks.js` | explicit marks → exact tasks; otherwise inferred tasks from prompt/stop boundaries (brief length, long gaps); waiting-time subtraction; tool-call pace |
| `adapters/claudeHooks.js` | collector hook log → facts (sessions, prompts with length only, tool results with duration, subagents, notifications) |
| `adapters/git.js` | `git log --numstat` → `git.commit` + per-file `code.change` with path classifications; working-tree status |
| `adapters/testOutput.js` | node:test, Godot runner, Jest, TAP, pytest, pass/fail totals, GitHub Actions runs → `test.run` / `build.run` |
| `bin/engine.js` | `ingest`, `stats`, `tasks`, `replay` |
| taxonomy `bin/structure.js` | git change → Tree-sitter `code.structure` events (deltas, names, enclosing functions) |

## Data sources evaluated

| Source | Status | What it gives | Limits |
|---|---|---|---|
| Claude Code hooks (collector log) | **implemented, live** | session/prompt/stop lifecycle, every tool result with `duration_ms`, subagent start/stop with ids, permission/idle notifications, prompt length | no model name on the main thread; hook timestamps are the hook's own clock (~0.2 s after the event); ~0.25 s process spawn per tool call (~1% of turn time) |
| Claude transcripts (`~/.claude/projects/*.jsonl`) | **used for research**, adapter not yet ported | 30 days of history: per-message model and token usage, `turn_duration`, `cost-state`, subagent meta with `toolUseId` | undocumented, version-dependent format; 30-day retention; contains text (must be stripped on ingest) |
| Statusline JSON | evaluated, not wired | `cost.total_duration_ms`, `total_api_duration_ms`, lines added/removed, rate-limit windows, model | only while a session renders; a statusline command would have to forward it |
| OpenTelemetry | evaluated, not wired | `api_request.duration_ms`, `tool_result.duration_ms`, `active_time`, beta traces with `tool.blocked_on_user` | needs a collector; duplicates what hooks give; useful for API-time split |
| Git | **implemented** | commits, files, lines; working-tree changes for the parser | author identity only |
| Test results / build output | **implemented** (parsers) | pass/fail counts, duration, CI step conclusions | output must be captured by the runner (hook `PostToolUse` does not expose stdout, by design) |
| Code structure (Tree-sitter) | **proof of concept** | structures added/removed and the functions/classes/methods enclosing changed lines, for JS/JSX | JavaScript grammar only (TypeScript/GDScript next); WASM load ~100 ms; grammar packages are runtime deps |
| Task/subagent relationships | **implemented** | `toolUseId` links agent to spawning call; agents attached to the task window | subagent model is `declared` (from the Agent call's `model` argument) or unknown |
| Model identity and performance history | partial | subagent model from Agent call args; main model from transcripts; per-type/model durations from earlier research | hooks give no main-thread model; keep `modelConfidence` honest |

## Verification

34 tests (`npm test`): schema validation and content rejection, stable ids, store dedupe/persistence,
replay ordering and speed with fake timers, live-state semantics (subagent stop ≠ task end), task linking
(explicit and inferred, waiting subtraction, pace), each adapter's parsing, taxonomy rules, Tree-sitter
summaries/diffs/enclosing attribution, visualizer scene model, music mapping over a full recording.

Repeatable demonstration: `npm run demo` with the recordings in `demo/recordings/`. Your own live recording can be
produced by `engine ingest claude-hooks ~/.claude/eta/events.jsonl` from a recorded development session (131 events,
2 sessions, 15 subagent events).

## Layering rule (2026-11-08)

Engines (geometry, Forge composition, music score) are independent of Claude Code and of any presentation
interface; they consume the generic event record only. Adapters translate sources (Claude Code hooks,
transcripts, git, tests, CI) into that record. Presentations (Resonance pages,
laboratory) wire engines to adapters. Enforced by `packages/forge/test/boundary.test.js`; see `FORGE.md`.

## The Forge universe (2026-11-08)

Layering is unchanged: engines (`packages/geometry`, `packages/forge/src/universe.js`, `director.js`, `frame.js`,
`packages/audio/src/forge-music.js`) know nothing about Claude Code, adapters or any presentation UI (enforced by
`packages/forge/test/boundary.test.js`); `render-gl.js` is a renderer adapter that consumes FrameBuilder output and
imports only Three.js; `packages/forge/universe.js` (the page) is the only place where the Replayer, the engine, the
director, the renderer and the synth are wired together. A real session enters through the same event records the
synthetic demo uses.
