# Privacy, security, copyright and dependency licensing

## Privacy

- **Collected:** timestamps, event kinds, session/prompt/tool-use/agent ids, project folder name, tool
  names, tool durations, prompt *length*, subagent type and declared model, notification kind, git
  hashes/paths/line counts, test counts, parser counts and identifier names.
- **Never collected:** prompt text, tool inputs (commands, file contents, URLs), tool outputs, assistant
  messages, notification text, transcript paths, environment variables, credentials. The schema validator
  rejects payload keys that would carry content; the hook logger was verified with marker strings.
- **Storage:** JSONL files under the user's home (`~/.claude/eta/events.jsonl`, repo `demo/recordings/`).
  Nothing is sent anywhere. Sharing a recording is a deliberate file hand-off by the user.
- **Identifier names from Tree-sitter** (function/class/test names) are the one semi-sensitive item; they
  are needed for the Workflow view. A per-project `redactNames` option is an easy addition if required.

## Security

- The hook command is `node <fixed path>` with a 5 s timeout, exits 0 with empty stdout, never blocks or
  injects context; it reads stdin only. Rollback: restore the backups the installer writes to `~/.claude/backups/`.
- No package in this repo opens network connections. The demo server binds 127.0.0.1 only and serves the
  repository root read-only.
- The only third-party runtime code is Tree-sitter WASM (sandboxed by design) and the JavaScript grammar.
  `npm install` pulled 5 packages with no install scripts executed.
- External repository review (claude-load) was done from a shallow clone in a scratch directory; nothing
  installed or executed.

## Copyright

- No copyrighted music, melodies, recordings or sound assets are used or reproduced; the audio is
  synthesized from scales at run time. Any colour presets must stay colours only (no
  logos, names or trademarks).
- Ideas borrowed from claude-load (two clocks, log-median calibration, p50/p90) are re-implemented; no code
  was copied. If any `core.ts` function is copied later, keep the MIT notice (Copyright 2026 Aaron Levin).

## Dependency licences (as installed 2026-11-08)

| Package | Version | Licence | Use |
|---|---|---|---|
| web-tree-sitter | 0.27.2 | MIT | parser runtime (WASM) |
| tree-sitter-javascript | 0.25.0 | MIT | JavaScript grammar (WASM shipped in the package) |
| node-addon-api, node-gyp-build | transitive | MIT | pulled by the grammar's native binding metadata; not built or used |

Candidates evaluated, not installed: three 0.187.0 (MIT), electron 45.2.3 (MIT), @tauri-apps/cli 2.12.4
(Apache-2.0 OR MIT), Tone.js (MIT), midi-writer-js (MIT), tree-sitter-wasms 0.1.13 (Unlicense). All permit
commercial redistribution with attribution where required; Tauri's Rust toolchain adds build-time
dependencies with their own (permissive) licences that must be inventoried at adoption time.
