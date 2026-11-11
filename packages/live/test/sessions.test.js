import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionFocus } from "../src/sessions.js";

const S = 1000, M = 60 * S;

test("score decays with a 3 minute half-life", () => {
  const f = new SessionFocus(); f.observe("a", 0, 4);
  assert.equal(f.score("a", 0), 4);
  assert.ok(Math.abs(f.score("a", 3 * M) - 2) < 1e-9);
  assert.ok(Math.abs(f.score("a", 6 * M) - 1) < 1e-9);
  f.observe("a", 3 * M, 1); assert.ok(Math.abs(f.score("a", 3 * M) - 3) < 1e-9);
  f.observe("a", 0, 1); // late event adds its already-decayed weight
  assert.ok(Math.abs(f.score("a", 3 * M) - 3.5) < 1e-9);
});

test("dormancy after 20 minutes is not an ending, and activity wakes it", () => {
  const f = new SessionFocus(); f.observe("a", 0);
  assert.equal(f.dormant("a", 19 * M), false);
  assert.equal(f.dormant("a", 20 * M), true);
  assert.equal(f.ended("a"), false);
  f.observe("a", 25 * M); assert.equal(f.dormant("a", 26 * M), false);
  assert.equal(f.dormant("nope", 0), true);
});

test("ended bookkeeping: markEnded / markResumed", () => {
  const f = new SessionFocus(); f.observe("a", 0);
  f.markEnded("a"); assert.equal(f.ended("a"), true);
  f.observe("a", M); assert.equal(f.ended("a"), true, "activity alone does not resume an ended session");
  f.markResumed("a"); assert.equal(f.ended("a"), false);
});

test("initial focus is the highest score; ties break by id", () => {
  const f = new SessionFocus(); f.observe("b", 0, 1); f.observe("a", 0, 1); f.observe("c", 0, 0.5);
  assert.equal(f.focus(0), "a");
  const g = new SessionFocus(); g.observe("x", 0, 1); g.observe("y", 0, 5); assert.equal(g.focus(0), "y");
  assert.equal(new SessionFocus().focus(0), null);
});

test("pinned wins while it exists; unpin returns to normal rules without an instant flip", () => {
  const f = new SessionFocus(); f.observe("a", 0, 10); f.observe("b", 0, 1);
  f.pin("b"); assert.equal(f.focus(0), "b");
  assert.equal(f.focus(10 * M), "b"); assert.equal(f.pinned, "b");
  f.pin("ghost"); assert.equal(f.focus(10 * M), "b", "a pin on a session that does not exist is ignored");
  f.unpin(); assert.equal(f.pinned, null);
  f.observe("b", 10 * M, 1); f.observe("a", 10 * M, 1);
  assert.equal(f.focus(10 * M), "b", "keeps the current focus after unpin");
});

test("no switch to a higher-scoring session before 90 s of dominance and 3 min of hold", () => {
  const f = new SessionFocus(); f.observe("a", 0, 1); assert.equal(f.focus(0), "a");
  f.observe("b", 10 * S, 10); // b is far ahead (>= 2x)
  assert.equal(f.focus(10 * S), "a");
  assert.equal(f.focus(60 * S), "a", "dominant for only 50 s");
  assert.equal(f.focus(100 * S), "a", "dominant 90 s but a held < 3 min");
  // keep b dominant until a has been held 3 min
  f.observe("b", 150 * S, 10);
  assert.equal(f.focus(170 * S), "a", "held 170 s < 180 s");
  assert.equal(f.focus(180 * S), "b", "both conditions now met");
});

test("dominance must be continuous: dipping below 2x resets the 90 s clock", () => {
  const f = new SessionFocus({ minHoldMs: 0 }); f.observe("a", 0, 4); f.focus(0);
  f.observe("b", 0, 20); f.focus(0);                 // b = 5x a
  assert.equal(f.focus(60 * S), "a");
  f.observe("a", 60 * S, 100);                       // a surges: b no longer 2x
  assert.equal(f.focus(61 * S), "a");
  assert.equal(f.focus(120 * S), "a");
  f.observe("b", 120 * S, 1000); f.focus(120 * S);   // b dominant again, clock restarts here
  assert.equal(f.focus(200 * S), "a", "only 80 s since dominance resumed");
  assert.equal(f.focus(210 * S), "b");
});

test("rule (a): dormant or ended focus yields immediately to an active session", () => {
  const f = new SessionFocus(); f.observe("a", 0, 5); f.observe("b", 0, 1); assert.equal(f.focus(0), "a");
  // a goes dormant at 20 min; b was kept alive
  f.observe("b", 19 * M, 1);
  assert.equal(f.focus(20 * M), "b");
  // ended
  const g = new SessionFocus(); g.observe("a", 0, 5); g.observe("b", 0, 1); g.focus(0);
  g.markEnded("a"); assert.equal(g.focus(1 * S), "b");
  // nobody else active: stay put
  const h = new SessionFocus(); h.observe("a", 0); h.observe("b", 0, 0.1); h.focus(0);
  assert.equal(h.focus(30 * M), "a", "both dormant: no active alternative, keep the focus");
  h.observe("b", 31 * M); assert.equal(h.focus(31 * M), "b", "b wakes and takes over a dormant focus");
});

test("no flip-flopping when two sessions alternate bursts", () => {
  const f = new SessionFocus(); const seen = new Set(); let switches = 0, last = null;
  for (let t = 0; t <= 60 * M; t += 5 * S) {
    const burst = Math.floor(t / (60 * S)) % 2 === 0 ? "a" : "b"; // alternate every minute
    f.observe(burst, t, 1);
    const cur = f.focus(t); seen.add(cur);
    if (last && cur !== last) switches++; last = cur;
  }
  assert.equal(switches, 0, `focus stayed on ${last}`);
  assert.equal(seen.size, 1);
});

test("list: sorted by score then id, with focused / pinned / dormant / ended flags", () => {
  const f = new SessionFocus(); f.observe("b", 0, 2); f.observe("a", 0, 2); f.observe("c", 0, 5); f.observe("old", -30 * M, 9);
  f.markEnded("b"); f.pin("a");
  const rows = f.list(0);
  assert.deepEqual(rows.map((r) => r.id), ["c", "a", "b", "old"]);
  assert.deepEqual(rows.map((r) => r.focused), [false, true, false, false]);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId.a.pinned, true); assert.equal(byId.b.ended, true); assert.equal(byId.old.dormant, true); assert.equal(byId.c.dormant, false);
  assert.equal(byId.c.lastTs, 0);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["dormant", "ended", "focused", "id", "lastTs", "pinned", "score"]);
});

test("deterministic: same inputs give the same focus history", () => {
  const run = () => { const f = new SessionFocus(); const out = []; for (let t = 0; t < 30 * M; t += 7 * S) { f.observe(t % 3 ? "x" : "y", t, 1 + (t % 5)); out.push(f.focus(t)); } return out; };
  assert.deepEqual(run(), run());
});
