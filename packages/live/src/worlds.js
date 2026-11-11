// Alexandria Resonance — live worlds. Browser-safe, DOM-free, tested in Node.
//
// One Universe per Claude Code session. Raw normalized events are queued, then fed to each session's own
// LiveAdapter-driven Universe in bounded chunks (so a big backlog catches up over several frames). Between two events
// of a world its clock is advanced in compressed time (the gap, capped at maxGapMs, in stepMs ticks), which keeps
// the artwork deterministic: the same events always give the same snapshotHash, whatever the wall clock did.
//
// Dormancy (no activity for SessionFocus.dormantAfterMs) freezes a world; it is NOT an ending. A later event wakes it
// and everything it grew is kept. Endings come only from session.end events.
import { LiveAdapter } from "./adapter.js";
import { SessionFocus } from "./sessions.js";

const tsOf = (e) => Date.parse(e.ts);
const byTsThenId = (a, b) => tsOf(a) - tsOf(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const focusWeight = (e) => (/^(tool|test|agent)\./.test(e.kind) ? 1 : 0.5);

export function newWorld(id, universe, project = null) {
  return { id, project, universe, sceneClock: 0, index: 0, events: [], lastTs: null, ended: false, liveAdvance: 0, bgAcc: 0 };
}

// Advance the world's clock across the gap before an output event (compressed), then ingest it. Shared by
// LiveWorlds.step and buildSessionUniverse so both are the same computation.
function advanceTo(world, tsMs, { stepMs, maxGapMs }) {
  if (world.lastTs != null && Number.isFinite(tsMs) && tsMs > world.lastTs) {
    // time the live frame loop already ran for this world since its last event is not played twice
    let remaining = Math.min(tsMs - world.lastTs, maxGapMs) - world.liveAdvance;
    while (remaining >= stepMs) { world.sceneClock += stepMs; world.universe.tick(stepMs, world.sceneClock); remaining -= stepMs; }
  }
  if (Number.isFinite(tsMs) && (world.lastTs == null || tsMs > world.lastTs)) world.lastTs = tsMs;
  world.liveAdvance = 0;
}
function feedOutput(world, out, opts) {
  advanceTo(world, tsOf(out), opts);
  const index = world.index++;
  world.universe.ingest(out, world.sceneClock, index);
  if (opts.onIngest) opts.onIngest(world, out, index);
}

// Replay one session's raw events through a fresh adapter + universe with the same compressed-time stepping.
export function buildSessionUniverse(events, createUniverse, { adapter = new LiveAdapter(), stepMs = 250, maxGapMs = 2000 } = {}) {
  const sorted = [...events].sort(byTsThenId);
  const id = sorted[0]?.session?.id ?? "unknown";
  const world = newWorld(id, createUniverse(id), sorted[0]?.session?.project ?? null);
  for (const e of sorted) {
    world.events.push(e);
    for (const out of adapter.process(e)) feedOutput(world, out, { stepMs, maxGapMs });
  }
  return world;
}

export class LiveWorlds {
  constructor({ onIngest = null, createUniverse, adapter = new LiveAdapter(), focus = new SessionFocus(), catchUpPerStep = 300, maxGapMs = 2000, stepMs = 250 } = {}) {
    if (typeof createUniverse !== "function") throw new Error("LiveWorlds needs createUniverse(sessionId)");
    Object.assign(this, { onIngest, createUniverse, adapter, focus, catchUpPerStep, maxGapMs, stepMs });
    this.worlds = new Map();
    this.queue = []; this.qHead = 0;
    this.pendingBy = new Map();
    this.seen = new Set(); // event ids already queued: an SSE reconnect replays the backlog
    this.clock = 0; // total ms advanced through tick()
  }

  world(id) { return this.worlds.get(id) || null; }
  get pending() { return this.queue.length - this.qHead; }
  pendingFor(id) { return this.pendingBy.get(id) || 0; }

  enqueue(batch) {
    const items = [...(batch || [])].filter((e) => e && e.kind && e.ts && e.session && e.session.id != null && Number.isFinite(tsOf(e))).sort(byTsThenId);
    for (const e of items) {
      if (e.id != null) { if (this.seen.has(e.id)) continue; this.seen.add(e.id); }
      this.queue.push(e); this.pendingBy.set(e.session.id, (this.pendingBy.get(e.session.id) || 0) + 1);
    }
  }

  #world(e) {
    const id = e.session.id;
    let w = this.worlds.get(id);
    if (!w) { w = newWorld(id, this.createUniverse(id), e.session.project ?? null); this.worlds.set(id, w); }
    if (e.session.project) { // a session is named after the folder where most of its activity happened (sessions start in the home folder and cd elsewhere)
      const tally = w.projects || (w.projects = new Map());
      tally.set(e.session.project, (tally.get(e.session.project) || 0) + 1);
      if (!w.project || tally.get(e.session.project) > (tally.get(w.project) || 0)) w.project = e.session.project;
    }
    return w;
  }

  // Process at most catchUpPerStep queued events. nowMs is accepted for symmetry with tick(); event time drives the work.
  step(nowMs) { // eslint-disable-line no-unused-vars
    let processed = 0;
    while (processed < this.catchUpPerStep && this.qHead < this.queue.length) {
      const e = this.queue[this.qHead++]; processed++;
      const id = e.session.id, w = this.#world(e);
      this.pendingBy.set(id, Math.max(0, (this.pendingBy.get(id) || 1) - 1));
      w.events.push(e);
      const opts = { stepMs: this.stepMs, maxGapMs: this.maxGapMs, onIngest: this.onIngest };
      for (const out of this.adapter.process(e)) feedOutput(w, out, opts);
      this.focus.observe(id, tsOf(e), focusWeight(e));
      if (w.ended && e.kind !== "session.end") { w.ended = false; this.focus.markResumed(id); }
      if (e.kind === "session.end") { w.ended = true; this.focus.markEnded(id); }
    }
    if (this.qHead > 4096 && this.qHead * 2 > this.queue.length) { this.queue = this.queue.slice(this.qHead); this.qHead = 0; }
    return { processed, pending: this.pending };
  }

  // Frame advance: the focused world every frame, background worlds every stepMs, dormant worlds not at all.
  tick(dtMs, nowMs, focusedId) {
    this.clock += dtMs;
    for (const w of this.worlds.values()) {
      if (this.focus.dormant(w.id, nowMs)) continue;
      if (w.id === focusedId) { w.sceneClock += dtMs; w.liveAdvance += dtMs; w.universe.tick(dtMs, w.sceneClock); w.bgAcc = 0; continue; }
      w.bgAcc += dtMs;
      while (w.bgAcc >= this.stepMs) { w.bgAcc -= this.stepMs; w.sceneClock += this.stepMs; w.liveAdvance += this.stepMs; w.universe.tick(this.stepMs, w.sceneClock); }
    }
  }

  focusId(nowMs) { return this.focus.focus(nowMs); }
  dormant(id, nowMs) { return this.focus.dormant(id, nowMs); }

  list(nowMs) {
    return this.focus.list(nowMs).map((row) => {
      const w = this.worlds.get(row.id);
      return { ...row, project: w?.project ?? null, ended: w ? w.ended : row.ended, catchingUp: this.pendingFor(row.id) > 0 };
    });
  }
}
