# First public release · plan (Crystal Metropolis)

Status: **plan, 2026-11-12.** Sections 4 (privacy scanner) and 8 (dependency advisory) are in effect; the rest is
not implemented yet. The decisions it
serves are in [DECISIONS.md](DECISIONS.md).

## 1. Baseline and method

**Method** (the same before and after every meaningful optimization):
- Chrome, Balanced preset, 1036×892 window, fixed camera poses: a wide aerial view and a close-up.
- 14 s of `requestAnimationFrame` intervals per pose, giving fps, median and p95 frame time, and the share of
  frames over 20 ms.
- Sampled once a second at the same time: browser CPU (share of the whole machine), GPU 3D-engine utilization,
  browser memory and GPU memory.
- A static page is measured first as a baseline.
- Results are reported with the hardware, and with whether the machine was on battery.

**Baseline**, 2026-11-12, on the reference machine: Snapdragon X Elite X1E80100, Adreno X1-85, 16 GB, on mains power.
The three test cities are labelled L, M and S (large, medium, small). Their sources are withheld.

| Scene | fps | Median / p95 (ms) | Frames > 20 ms | Draw calls | Triangles | CPU | GPU 3D | JS heap |
|---|---|---|---|---|---|---|---|---|
| Static page (baseline) | – | – | – | – | – | 1.5% | 13% | – |
| City L | 44 | 20.2 / 44 | 50% | 460 | 2.2M | 7.6% | 99% | 163 MB |
| City M | 49 | 17.2 / 36 | 35% | 449 | 2.3M | 8.3% | 99% | 181 MB |
| City S | 59 | 16.7 / 24 | 12% | 304 | 1.5M | 7.7% | 83% | 134 MB |
| Growth, events only (1,741 events, 72 structures) | 42 | 22.1 / 37 | 75% | 2,152 | 2.3M | 14.2% | 89% | 230 MB |

The GPU is the bottleneck. Iris Xe-class graphics has roughly half this GPU's throughput, so an *estimate* is about
22–35 fps there. That is not a measurement, and the release gate (D7) still needs real hardware.

**Development proxy (D15), not verified:** the Medium tier at a steady 60 fps on the reference machine, with p95
under 20 ms and GPU 3D at or below 50%. Baseline at Balanced: **no scene meets the proxy.** The best is City S at
p95 24 ms with GPU 3D at 83%.

## 2. Performance plan (staged; Growth first)

Each stage is measured with the method above, with before-and-after screenshots at each quality tier. Visual
regressions are reported alongside the gains.

1. **Growth batching.**
   - Merge settled structures (the static bake the cities already use) and instance repeated parts.
   - Keep only structures that are still changing as separate draws, and rebake incrementally when they settle.
   - Goal: from about 2,150 to under 500 draw calls, with no visible change.
2. **Quality tiers (Low, Medium, High).**
   - Each tier sets pixel ratio, transmission resolution, shadows, reflection resolution, bloom, mist and motes, and
     crystal shader detail.
   - Automatic selection from a short benchmark at startup and on GPU change, with a user override that is
     remembered.
   - Low keeps the architecture and the world below; it trims effects, not form.
3. **Shared world costs.** Measure the lake reflection, terrain, lighting and post-processing one at a time, then:
   - lower the reflection resolution and update rate when the camera is still;
   - level of detail for distant terrain and natural crystal fields;
   - cap the number of lights per tier;
   - cheaper bloom on Low and Medium.
4. **Ambient mode.**
   - Cap at 15–20 fps and drop the most expensive passes (transmission, half the bloom, reflection updates).
   - Frame-rate independent animation, so movement stays smooth.
5. **Hidden mode.**
   - Stop the render loop when the window is not visible.
   - Keep processing facts and keep the music clock in a timer independent of rendering.
   - On restore, render the current state; replay nothing.
6. **Camera smoothness.** Changing tier never cuts a shot. Transitions keep continuous velocity, which the existing
   director tests enforce.

## 3. Live Metropolis in the desktop app

- **Architecture:** the shared collector log → the shared semantic derivation library, in incremental mode, inside
  the app → derived facts → a Metropolis adapter → city state → the renderer and the score. There is no daemon and
  no separate fact file (request 1 in section 7).
- **The adapter:**
  - consumes facts incrementally, keyed by fact id, so a fact seen twice changes nothing;
  - applies them to deterministic city state, so the same facts always give the same city.
- **Migration:**
  1. Port the Metropolis renderer, the Growth scene, the camera director, the music and the Inspector as fresh,
     reviewed files (after the history remediation).
  2. Replace the snapshot loader with the fact adapter.
  3. Add a desktop entry point: the default window and a menu item.
  4. Add a synthetic first-run demonstration, then offer Live mode.
- **Recovery:**
  - On restart, rebuild deterministically from the supported fact history, then continue.
  - On disconnection, resume from the last fact id.
  - With no activity, keep ambient life only.
  - Multiple sessions and subagents follow the protocol's session and actor facts.
- **Tests:**
  - replaying a fact stream gives an identical city to applying it incrementally;
  - duplicated and out-of-order facts are idempotent;
  - a restart in the middle of a stream gives the same result;
  - an idle period triggers no major transformation;
  - mode transitions keep the event queue intact;
  - music and visuals stay in sync on the same fact clock.

## 4. Privacy scanner (implemented 2026-11-12)

`tools/privacy-scan.mjs` runs its generic detectors without any private file:

| Detector | Finds | Not flagged |
|---|---|---|
| `user-path` | Windows `C:\Users\<name>`, macOS `/Users/<name>` and Linux `/home/<name>` | Placeholder names: `<name>`, `you`, `someone`, `user`, `runner`, and the like |
| `email` | Email addresses | Reserved example domains, `*.invalid`, `*.test`, GitHub noreply addresses, `git@github.com` |
| `credential:*` | Private key blocks; GitHub, AWS, Slack, Stripe, Google, OpenAI and Anthropic token formats; JWTs; high-entropy values assigned to secret-like names | `process.env` references, placeholders, and self-describing canaries (a value that contains "secret", "probe" and similar words) |
| `recording:*` | JSON Lines events without `provenance.synthetic`; raw hook-log lines | A raw hook fixture only while its exact content matches the hash pinned in `PROTOCOL_VERSION.json` |

The private denylist (`~/.alexandria/denylist.txt`) adds a second layer on top.

- **Exceptions:**
  - An inline marker (`privacy-scan: allow <reason>`) excuses only the line it sits on, and only when that line has a
    finding. It can never excuse a denylist hit.
  - One detector exception exists (owner approved): the email detector only is not applied to `package-lock.json`,
    which holds third-party npm registry metadata. Every other detector, and the denylist, still apply to it. This
    is revisited when external contributors are added.
  - Every run lists all excused lines and the detector exception. There are no folder or file exemptions.
- **Output:** `file:line kind` only. Matched values, paths and denylist terms are never printed.
- **Where it runs:**
  - `npm test`, as `test/privacy-scan.test.js`: the generic scan of every tracked file, recording provenance, and the
    denylist scan. Without the denylist file that check is reported as "skipped", never as passing.
  - `npm run privacy:scan`: the full working-tree scan.
  - `npm run privacy:hooks` installs two local hooks, which are never committed:
    - **pre-commit:** scans the staged content of added and changed files. A missing denylist only warns.
    - **pre-push:** scans every outgoing commit (its changed files, message, author and committer) and each pushed
      tip's full tree. It refuses to push without the denylist unless `ALEXANDRIA_ALLOW_NO_DENYLIST=1` is set.
- **Tests** cover positive and negative fixtures for each detector, narrow exceptions, staged additions, a leak in
  an outgoing historical commit behind a clean tip, a new branch, and an end-to-end blocked commit and push. The
  sensitive-looking fixtures are assembled at runtime, so the test file contains no matches itself.

## 5. Audio reliability plan

The plan tests each of the following inside the packaged Electron app, not only in a browser:
- first-launch start, including whether the app may start audio without a gesture;
- mute and volume persistence;
- ambient and hidden behavior;
- sleep and wake;
- the default audio device changing;
- a multi-hour session with no silent gaps;
- music following facts after scene and camera transitions.

Desktop packaging is not assumed to lift browser audio-start rules; the actual behavior is verified.

## 6. Plugin and desktop separation

- `alexandria-resonance` in the shared Alexandria plugin marketplace depends on `alexandria-collector`. Claude Code's
  current plugin dependency support is checked in the official documentation before this is relied on.
- `/resonance` launches the installed app, or prints install instructions.
- `/resonance-status` reports whether the collector is live, the last event time, and whether the app is installed.
- Neither command downloads, installs or makes network calls.
- First-run guidance, and diagnostics when no events arrive.

## 7. Requests to the shared Protocol (for the Scoreboard / Protocol workstream)

These are requests through the protocol contract review, not Resonance implementations. Resonance does not change
the shared Protocol and does not build a semantic engine of its own.

1. **Derived facts.**
   - Live consumers use the shared, pure semantic derivation library in its incremental mode, over the shared
     collector log.
   - There is no persistent daemon, no separate canonical fact file and no background fact stream.
   - Metropolis needs the facts in order, with stable ids, so applying them is idempotent.
2. **History.**
   - Define how the raw log is rotated and retained, and deterministic replay after a restart.
   - Consumer-side snapshot caches are optional. They are always rebuildable from the log and can never become a
     competing source of truth.
3. **Project labels.**
   - One shared, local-only project-label store, with consent and deletion controls.
   - Each application keeps its own privacy-mode presentation settings.
4. **Repository analysis** stays Resonance-only and opt-in for now. The shared Protocol is not extended for it
   prematurely.

Hardware is settled by D15 (reference machine for development; the lower-powered x64 measurement on the release
checklist). First-launch audio is decided (D16: a gentle fade-in to about 40%, with visible controls and a remembered
preference), but not implemented in this release.

## 8. Dependency advisory (accepted 2026-11-12)

`npm audit` reports six moderate findings. All come from one advisory, GHSA-g3hv-75wg-m249: a denial-of-service in
`minimatch`, reached through `electron-builder` → `app-builder-lib` → `@electron/universal`.

**Accepted for now**, because:
- it is a development-only, build-time dependency;
- the production dependency tree contains no `minimatch`, so it does not ship in the packaged app;
- `@electron/universal` builds macOS universal binaries, which the Windows build does not use;
- exploiting it would require attacker-controlled glob patterns in our own build configuration.

`npm audit fix --force` would *downgrade* `electron-builder` from 26.18 to 25.1, so it is not used. No dependency
override is applied without a tested build. This is rechecked whenever `electron-builder` updates.
