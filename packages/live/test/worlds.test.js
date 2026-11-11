// LiveWorlds: one universe per session, chunked catch-up, dormancy that freezes without ending, endings and resumes,
// and determinism against a fresh adapter + universe with the same compressed-time stepping.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LiveWorlds, buildSessionUniverse } from "../src/worlds.js";
import { universeConfig } from "../src/adapter.js";
import { parseHookLog } from "../../event-engine/src/adapters/claudeHooks.js";
import { Universe } from "../../forge/src/universe.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const mapping = JSON.parse(fs.readFileSync(path.join(root, "packages/forge/forge-mapping.json"), "utf8"));
const identities = JSON.parse(fs.readFileSync(path.join(root, "packages/forge/identities.json"), "utf8"));
const createUniverse = (id) => new Universe({ mapping, identities, config: universeConfig(id) });

const T0 = Date.parse("2026-11-10T18:00:00.000Z");
let clock = T0, tu = 0;
const line = (ev, extra = {}, sid) => JSON.stringify({ ts: new Date((clock += (extra.dt ?? 2) * 1000)).toISOString(), ev, sid, v: 3, proj: extra.proj || "demo-proj", ...extra, dt: undefined });
const tool = (t, extra, sid) => line("PostToolUse", { tool: t, tuid: "toolu_" + ++tu, durMs: 300, ...extra }, sid);
const testPass = (sid, proj) => tool("Bash", { proj, sig: "npm test", tests: { framework: "node:test", passed: 12, failed: 0, skipped: 0, ok: true } }, sid);
const parse = (lines) => parseHookLog(lines.join("\n") + "\n", { file: "events.jsonl" });
const work = (sid, proj) => [line("SessionStart", { source: "startup", proj }, sid), line("UserPromptSubmit", { proj }, sid), tool("Read", { proj }, sid), tool("Edit", { proj }, sid), tool("Write", { proj }, sid), testPass(sid, proj), tool("Edit", { proj }, sid), testPass(sid, proj)];
const more = (sid) => [line("UserPromptSubmit", {}, sid), tool("Write", {}, sid), tool("Edit", {}, sid), testPass(sid)];
const drain = (w, now = T0) => { while (w.pending) w.step(now); };

test("two interleaved sessions get separate universes with different fingerprints", () => {
  clock = T0;
  const a = parse(work("s-a", "alpha")), b = parse(work("s-b", "beta"));
  const mixed = []; for (let i = 0; i < Math.max(a.length, b.length); i++) { if (a[i]) mixed.push(a[i]); if (b[i]) mixed.push(b[i]); }
  const w = new LiveWorlds({ createUniverse });
  w.enqueue(mixed); drain(w);
  assert.equal(w.worlds.size, 2);
  const A = w.world("s-a"), B = w.world("s-b");
  assert.notEqual(A.universe, B.universe);
  assert.notEqual(A.universe.fingerprint, B.universe.fingerprint);
  assert.equal(A.project, "alpha"); assert.equal(B.project, "beta");
  assert.ok(A.universe.bodies.size > 3 && B.universe.bodies.size > 3);
  assert.ok(A.events.every((e) => e.session.id === "s-a"));
});

test("catch-up is chunked: pending stays above zero after one step and drains", () => {
  clock = T0;
  const w = new LiveWorlds({ createUniverse, catchUpPerStep: 3 });
  w.enqueue(parse(work("s-c")));
  const r = w.step(T0);
  assert.equal(r.processed, 3); assert.ok(r.pending > 0);
  assert.equal(w.list(T0)[0].catchingUp, true);
  let guard = 0; while (w.step(T0).pending > 0 && guard++ < 100);
  assert.equal(w.pending, 0); assert.equal(w.list(T0)[0].catchingUp, false);
});

test("dormant worlds freeze, then wake on new activity with their bodies preserved", () => {
  clock = T0;
  const w = new LiveWorlds({ createUniverse });
  w.enqueue(parse(work("s-d"))); drain(w);
  const W = w.world("s-d"), last = Date.parse(W.events[W.events.length - 1].ts);
  const bodies = W.universe.bodies.size;
  // active: the focused world advances
  const c0 = W.sceneClock; w.tick(100, last + 1000, "s-d"); assert.equal(W.sceneClock, c0 + 100);
  // dormant: frozen, not ended
  const late = last + 21 * 60 * 1000;
  assert.equal(w.dormant("s-d", late), true);
  const c1 = W.sceneClock; w.tick(100, late, "s-d"); w.tick(1000, late, null);
  assert.equal(W.sceneClock, c1);
  assert.equal(W.universe.resolved, false); assert.equal(w.list(late)[0].ended, false); assert.equal(w.list(late)[0].dormant, true);
  // wakes on new activity
  clock = late; w.enqueue(parse(more("s-d"))); drain(w, late);
  assert.equal(w.dormant("s-d", late + 1000), false);
  assert.ok(W.universe.bodies.size >= bodies, "bodies preserved");
  const c2 = W.sceneClock; w.tick(100, late + 1000, "s-d"); assert.equal(W.sceneClock, c2 + 100);
});

test("background worlds tick every 250 ms; session end resolves and later activity resumes", () => {
  clock = T0;
  const w = new LiveWorlds({ createUniverse });
  w.enqueue(parse(work("s-e"))); w.enqueue(parse(work("s-f"))); drain(w);
  const F = w.world("s-f"), c = F.sceneClock;
  w.tick(100, T0 + 60000, "s-e"); assert.equal(F.sceneClock, c);
  w.tick(200, T0 + 60000, "s-e"); assert.equal(F.sceneClock, c + 250);
  // end
  const E = w.world("s-e");
  w.enqueue(parse([line("SessionEnd", { reason: "prompt_input_exit" }, "s-e")])); drain(w);
  assert.equal(E.universe.resolved, true); assert.equal(E.ended, true);
  assert.equal(w.list(clock).find((r) => r.id === "s-e").ended, true);
  const bodies = E.universe.bodies.size;
  w.enqueue(parse([line("SessionStart", { source: "resume" }, "s-e"), line("UserPromptSubmit", {}, "s-e"), tool("Write", {}, "s-e")])); drain(w);
  assert.equal(E.universe.resolved, false); assert.equal(E.ended, false);
  assert.equal(w.list(clock).find((r) => r.id === "s-e").ended, false);
  assert.ok(E.universe.bodies.size > bodies);
});

test("deterministic: a world equals a fresh adapter + universe over that session's events, whatever the batching", () => {
  clock = T0;
  const a = parse(work("s-x", "alpha").concat(more("s-x"))), b = parse(work("s-y", "beta"));
  const w = new LiveWorlds({ createUniverse, catchUpPerStep: 4 });
  w.enqueue(a.slice(0, 5)); w.enqueue(b); w.enqueue(a.slice(5)); drain(w);
  for (const [id, evs] of [["s-x", a], ["s-y", b]]) {
    const ref = buildSessionUniverse(evs, createUniverse);
    assert.equal(w.world(id).universe.snapshotHash(), ref.universe.snapshotHash(), id);
    assert.equal(w.world(id).universe.fingerprint, ref.universe.fingerprint);
  }
  assert.equal(buildSessionUniverse(a, createUniverse).universe.snapshotHash(), buildSessionUniverse([...a].reverse(), createUniverse).universe.snapshotHash());
});

test("a long idle gap is compressed to maxGapMs of scene time", () => {
  clock = T0;
  const w = new LiveWorlds({ createUniverse });
  w.enqueue(parse([line("SessionStart", {}, "s-g"), line("UserPromptSubmit", {}, "s-g")])); drain(w);
  const W = w.world("s-g"), c = W.sceneClock;
  w.enqueue(parse([tool("Edit", { dt: 3600 }, "s-g")])); drain(w);
  assert.equal(W.sceneClock - c, 2000);
});

test("focus follows the most active session and a pin overrides it", () => {
  clock = T0;
  const w = new LiveWorlds({ createUniverse });
  w.enqueue(parse(work("s-p"))); w.enqueue(parse(work("s-q").concat(more("s-q")))); drain(w);
  const now = clock;
  assert.equal(w.focusId(now), "s-q");
  w.focus.pin("s-p"); assert.equal(w.focusId(now), "s-p");
  assert.equal(w.list(now).find((r) => r.id === "s-p").pinned, true);
});

test("a replayed backlog (SSE reconnect) is not ingested twice", () => {
  clock = T0;
  const ev = parse(work("s-dup"));
  const w = new LiveWorlds({ createUniverse });
  w.enqueue(ev); drain(w);
  const n = w.world("s-dup").events.length, bodies = w.world("s-dup").universe.bodies.size;
  w.enqueue(ev); assert.equal(w.pending, 0); drain(w);
  assert.equal(w.world("s-dup").events.length, n); assert.equal(w.world("s-dup").universe.bodies.size, bodies);
});

test("a session is named after the folder where most of its activity happened, not where it started", () => {
  const stub = () => ({ tick() {}, ingest() {} });
  const w = new LiveWorlds({ createUniverse: stub });
  const ev = (i, project) => ({ schema: "alexandria.event/1", id: "n" + i, ts: new Date(Date.parse("2026-11-10T10:00:00.000Z") + i * 1000).toISOString(), source: "claude-hooks", kind: "tool.result", session: { id: "s-name", project }, actor: { type: "main" }, payload: { tool: "Read" }, provenance: { observed: true, adapter: "t" } });
  w.enqueue([ev(0, "home"), ev(1, "home"), ev(2, "repo"), ev(3, "repo"), ev(4, "repo"), ev(5, "notes")]);
  w.step(0);
  assert.equal(w.world("s-name").project, "repo");
});
