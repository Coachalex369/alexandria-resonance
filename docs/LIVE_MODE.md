# Live mode (Alexandria Resonance)

Resonance reads the shared Claude Code collector log (`~/.claude/eta/events.jsonl`, collector v3, protocol 3.0.0)
**read-only** and turns each running session into its own universe. Nothing is written, the collector and its
settings are untouched, and no other Alexandria application is required.

## Data path

```
collector log ──(1 s polling tail, read-only)──► tools/live-feed.js ──SSE /live/stream──► page
                     parseHookLog (protocol 3.0.0)        /live/sessions, /live/session?id=
page: LiveWorlds (packages/live/src/worlds.js)
        └─ per session: LiveAdapter (adapter.js) → Universe engine (unchanged) → director → renderer / music
      SessionFocus (sessions.js) chooses which universe is shown
```

The server answers `/live/*` only for `Host: 127.0.0.1:<port>` or `localhost:<port>`, so another website can't read
it through DNS rebinding. It sends no CORS header and listens on loopback only.

## Meaning

| Activity | Artwork |
|---|---|
| Session | One objective (one universe). Session end resolves it (finale); later activity reopens the same artwork |
| 20 min without activity | Dormant: frozen and dimmed, not resolved; wakes on the next event |
| Prompt | A new phase (`Phase n` in the story and history) |
| Edit / Write / MultiEdit / NotebookEdit | Implementation stretch = one crystal. A stretch ends at a test run, commit, end of turn/agent, new prompt or a 5 min gap; reads in between don't split it |
| Read / Grep / Glob / web | Research roots beneath the plane |
| Test run with counts | Pass: reflection (verified). Fail: fracture |
| Successful command whose signature is exactly `git commit` | Inferred commit: membrane over verified crystals |
| Subagents | Seeds, with identities from `identities.json` |
| Permission / idle prompt | Waiting dim |

Synthetic records carry `provenance.observed = false, adapter = "resonance-live@1"`.

## Focus and sessions

- **Initial pick and switching:** the page starts on the most active session. It switches only if the shown session is dormant or ended, or if another has been at least twice as active for 90 s after the current one has been shown for 3 min.
- **Pinning:** clicking a chip pins that session; **Follow most active** unpins.
- **Naming:** a session is named after the folder where most of its activity happened. Several sessions in one project are numbered.
- **Privacy mode** (View panel; remembered per browser): names become "Session A/B/…" in the strip, the stage, the history, the inspector, the readout and the manifest. PNGs contain no text.

## Replay

**Replay** keeps the demo recordings exactly as before (same engine config, same snapshot hashes). **Real sessions**
replays any session in the log through the same adapter with the same engine configuration as live mode.

## Performance (measured 2026-11-10, Chrome, Windows on ARM laptop)

- **Load:** 5 live sessions and 1,457 real events, caught up over several frames.
- **Frame rate:** 60 fps. Median frame 16.7 ms, p95 16.9 ms, p99 17.3 ms, worst 33 ms (during catch-up).
- **Render time:** 0.3–0.8 ms per frame.
- **How it scales:**
  - Only the focused universe is drawn.
  - Background universes advance at 4 Hz, and dormant ones are frozen.
  - Catch-up adapts its batch size to stay near 8 ms per frame.
  - The existing slow-frame fallback turns bloom off.

## Known limitations (collector data, not fixable without a collector change)

- **No file paths:** crystals are implementation stretches, not files.
- **Only the first command of a chain is recorded:**
  - `git add … && git commit …` arrives as `git add`, so most commits are invisible.
  - `node --test …` arrives as `node`, so only `npm test`-style runs (and other recognised runners) count as verification. The verified share is therefore usually low.
- **No task boundaries:** the session is the objective.
- **Model names:** the hook log has none per tool call; transcripts are deliberately not read.
