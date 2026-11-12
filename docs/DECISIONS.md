# Alexandria Resonance · decision register

Owner decisions that shape the first public release. Each entry has a date and a status. A later proposal that
conflicts with an entry here is flagged for owner approval; it never replaces an entry silently. This register holds
no personal information, local paths, client names or client project structures.

Status: **decided** (owner approved) · **gate** (a release requirement to verify by measurement) ·
**open** (awaiting an owner decision).

## Product

**D1 · 2026-11-12 · decided.** Crystal Metropolis is the artistic foundation of the first public desktop release.
Before release, the Metropolis scenes come into this repository as fresh, reviewed files. Private data and
experimental configuration stay out.

**D2 · 2026-11-12 · decided.** The earlier "As Above, So Below" crystals-and-roots visualizer will not ship as 1.0
in place of Metropolis just to ship sooner. It receives no further polish.

**D3 · 2026-11-12 · decided.** The artistic direction is preserved through optimization:
- an organic, interconnected crystalline civilization rather than isolated groups of crystals;
- cinematic aerial views, close-ups and fly-throughs, both above and below the reflection plane;
- an architecturally meaningful world below, not a reflection or a starburst.

Optimization must not reduce the city to generic low-detail geometry to reach a benchmark.

**D4 · 2026-11-12 · decided.** Ambient life and major transformations are kept apart:
- Ambient life continues between development events, and is visibly ambient.
- Significant structural change happens only in response to observed development activity. No progress is
  fabricated.

**D5 · 2026-11-12 · decided.** Original procedural music is part of the core experience, not decoration:
- It evolves with the city.
- It is never replaced by generic background tracks.
- It respects the user's mute and volume choices.

**D6 · 2026-11-12 · decided.** The Crystal Inspector leads from the artwork to the observable development evidence
that produced it, within the privacy model (D9).

## Modes and performance

**D7 · 2026-11-12 · gate.** Rendering modes:

- **Watching** (focused window):
  - Steady 30 fps at Medium quality on Intel Iris Xe-class integrated graphics, with p95 frame time under 40 ms.
  - Target 60 fps at High quality on the reference machine, a Snapdragon X Elite laptop (Adreno X1-85).
  - Frame-time consistency matters more than peak frame rate.
  - Cinematic camera, recognizable architecture, visual richness and music are preserved.
- **Ambient** (visible, unfocused):
  - 15–20 fps, and under 25% GPU on the reference machine.
  - Event processing and music continue; post-processing and other visual costs are reduced.
- **Hidden** (minimized or not visible):
  - Rendering pauses or nearly stops.
  - Event processing continues and no meaningful event is lost.
  - Music follows the user's preference.
  - The scene is restored correctly when the window is shown again.

**D8 · 2026-11-12 · gate.** These targets are verified by measurement on real representative hardware before
release. Estimates never count as passing evidence.
- Recorded each time: fps, the frame-time distribution, GPU utilization, memory behavior, and power and thermal
  observations.
- The 25% GPU budget is a starting point. If measurements show another threshold better captures sustainable
  all-day use, the change goes to the owner for approval.
- Hardware for development and for the release gate: see D15.

**D15 · 2026-11-12 · decided.** Hardware for development and for the release gate:
- **No lower-powered test hardware for now.** None is bought or required at this stage. Development and
  optimization continue on the reference machine (Snapdragon X Elite, Adreno X1-85).
- **Development proxy target**, for guidance only and never as gate evidence: the Medium tier holds a steady 60 fps
  on the reference machine, with p95 frame time under 20 ms and GPU 3D load at or below 50%. Every performance
  measurement reports this target labelled "proxy", never "verified".
- **Release checklist item**, one item covering both:
  - Real measurements on a lower-powered x64 (Intel or AMD) integrated-graphics laptop, against the D7 Watching,
    Ambient and Hidden gates.
  - Verification on that same machine that the x64 desktop build installs and runs.
- **Estimates** never count as passing evidence (D8).

## Privacy

**D9 · 2026-11-12 · decided.** The five-part privacy model:

| | Live mode (events only) | Optional repository analysis (opt-in per project) |
|---|---|---|
| **Read** | Content-free Claude Code events from the shared collector: no prompts, responses, code, file contents or transcripts | The project root only, parsed in memory with tree-sitter. No symlinks out of the root. Default excludes (`.env*`, keys, `node_modules`, build output) plus `.resonanceignore`. Contents are never stored |
| **Store** | Derived facts with privacy-safe identifiers | A hashed structural model only: ids salted per project, kinds, sizes, import edges, nesting. Human-readable names go in a separate local label store. Raw code is never written |
| **Display** | Project labels from the local label store; privacy mode hides them | Names only in the Inspector, only locally; privacy mode hides them |
| **Export** | Privacy mode forced on; no labels | The hashed model only; never labels; privacy mode forced on |
| **Transmit** | Never | Never |

Repository analysis requires explicit consent for each project, a "What Resonance knows" viewer, and controls to
revoke consent and delete what was derived. Automated tests enforce two rules: no network access, and no labels in
exports.

**D10 · 2026-11-12 · decided.** Public materials never contain private client repositories, client project
structures, real recordings, private labels or personal paths. This covers code, fixtures, docs, screenshots, demos
and releases. The public demo city comes from an open-source repository, starting with this one. Shipped recordings
are synthetic and marked `provenance.synthetic`.

**D11 · 2026-11-12 · decided.** A privacy scan guards this repository:
- Recordings must be synthetic.
- A private denylist kept outside every repository is checked.
- Generic detectors for personal paths, email addresses and credential patterns run without the denylist
  (implemented 2026-11-12; see RELEASE_PLAN.md section 4).

Exceptions are narrow and visible: an inline marker excuses only the line it sits on, there is one listed detector
exception, and there are no folder or file exemptions. Local pre-commit and pre-push hooks run the scan. Missing
optional denylist coverage is reported as skipped, never as passing.

The one detector exception (owner approved 2026-11-12): the email detector only is not applied to
`package-lock.json`, whose maintainer addresses are third-party npm registry metadata. Every other detector, and
the denylist, still apply to that file. Revisit this when external contributors are added.

## Architecture and distribution

**D12 · 2026-11-12 · decided.** Resonance uses the shared Alexandria Collector and the independently versioned
Alexandria Protocol semantic engine:

hooks → collector → canonical content-free events → semantic engine → derived facts → Resonance and Scoreboard

- For live operation, Metropolis consumes the derived facts. It does not parse raw hook logs or run a semantic
  collector of its own.
- New event or fact types are proposed through the protocol's contract review. Resonance does not change the
  protocol on its own.

**D13 · 2026-11-12 · decided.** Resonance is an independently installed desktop application.
- Its Claude Code plugin is a separate integration in the shared Alexandria plugin marketplace, and it depends on
  the shared collector plugin.
- `/resonance` and `/resonance-status` launch or diagnose the app. They never download, install or update anything
  themselves.
- Resonance and Scoreboard run independently and at the same time.

## Release governance

**D14 · 2026-11-12 · decided.** The following require explicit owner approval:
- destructive history changes and force-pushes;
- a public release;
- publishing plugins or installers;
- deleting private builds, recordings or screenshots.

**D16 · 2026-11-12 · decided (not implemented in this release).** First-launch audio:
- Music fades in gently to about 40% volume.
- Mute and volume controls are clearly visible.
- The user's choice is remembered.

The actual Electron autoplay behavior on the development machine is verified when audio integration is authorized.
The alternative, starting muted, was considered and not chosen.

**D17 · 2026-11-12 · decided and executed.** Public history remediation.
- `main` of the public repository was rewritten to replace project-derived names in three files: a documentation
  example, a synthetic-recording generator, and the recording it produced. Authors, dates and messages were kept.
- Copies made before the rewrite may still hold the old history. The rewrite stops further distribution; it cannot
  recall existing copies.
- **Accepted residual risk** (owner decision, 2026-11-12):
  - The replaced commits remain reachable on GitHub by exact commit hash until GitHub's own cleanup. No support
    request will be made to remove them.
  - Third-party clones made before the rewrite may keep the old history.
