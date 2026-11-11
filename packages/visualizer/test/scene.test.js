import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Scene, hash01 } from "../scene.js";

const rec = fileURLToPath(new URL("../../../demo/recordings/synthetic-multi-agent.events.jsonl", import.meta.url));
const events = fs.readFileSync(rec, "utf8").trim().split("\n").map((l) => JSON.parse(l))
  .sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id));

function run(list, onStep) {
  const scene = new Scene();
  let now = 0;
  list.forEach((e, i) => { now += 100; scene.ingest(e, now); scene.primitives(now); onStep?.(e, scene, i); });
  return { scene, now };
}

test("an element is created per tool event", () => {
  const n = events.filter((e) => e.kind === "tool.call" || e.kind === "tool.result" || e.kind === "tool.failure").length;
  assert.ok(n > 0);
  const { scene } = run(events);
  assert.equal(scene.stats.elementsCreated, n);
});

test("a lane opens and closes per agent", () => {
  const starts = events.filter((e) => e.kind === "agent.start").length;
  const stops = events.filter((e) => e.kind === "agent.stop").length;
  const { scene, now } = run(events);
  assert.ok(starts > 0);
  assert.equal(scene.stats.lanesOpened, starts);
  assert.equal(scene.stats.lanesClosed, stops);
  assert.ok(scene.laneLog.every((l) => l.closedAt != null && l.closedAt >= l.openedAt));
  scene.primitives(now + 10_000); // resolve animation finished: lanes are gone
  assert.equal(scene.lanes.size, 0);
});

test("persistent marks accumulate monotonically", () => {
  let prev = 0;
  const { scene } = run(events, (e, s) => { assert.ok(s.marks.length >= prev); prev = s.marks.length; });
  const expected = events.filter((e) => ["tool.result", "tool.failure", "test.run", "git.commit"].includes(e.kind)).length;
  assert.equal(scene.marks.length, expected);
  // marks never disappear from the drawn output as time passes
  const drawn = scene.primitives(1e9).filter((p) => p.layer === "persistent" && p.type !== "frame").length;
  assert.equal(drawn, scene.marks.length);
});

test("same actor + category lands in the same region", () => {
  const mk = (id) => ({ schema: "alexandria.event/1", id, ts: "2026-01-01T00:00:00.000Z", kind: "tool.result", actor: { type: "main" }, classification: [{ scheme: "work-category", value: "testing", confidence: 0.9 }] });
  const s = new Scene();
  s.ingest(mk("evt_aaaaaaaa"), 0); s.ingest(mk("evt_bbbbbbbb"), 10);
  const [a, b] = s.marks;
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 0.05);
  assert.equal(hash01("x"), hash01("x"));
});

test("a failed test.run produces a mark flagged failed", () => {
  const s = new Scene();
  const ev = (ok) => ({ schema: "alexandria.event/1", id: "evt_" + ok + "xxxxxxx", ts: "2026-01-01T00:00:00.000Z", kind: "test.run", actor: { type: "main" }, payload: { ok, passed: 1, failed: ok ? 0 : 2 } });
  s.ingest(ev(true), 0); s.ingest(ev(false), 100);
  assert.equal(s.marks[0].failed, false);
  assert.equal(s.marks[0].kind, "test-pass");
  assert.equal(s.marks[1].failed, true);
  assert.equal(s.marks[1].kind, "test-fail");
  assert.ok(s.primitives(1000).some((p) => p.type === "crack"));
});

test("task.end sets completed; agent.stop does not", () => {
  let sawStopNotCompleted = false;
  const { scene } = run(events, (e, s) => {
    if (e.kind === "agent.stop") { sawStopNotCompleted = true; assert.equal(s.completed, false); assert.equal(s.turnComplete, false); }
    if (e.kind === "task.end") assert.equal(s.completed, true);
  });
  assert.ok(sawStopNotCompleted);
  assert.equal(scene.completed, true);
  assert.ok(scene.primitives(1e6).some((p) => p.type === "frame"));
});

test("permission prompt dims until the next tool.result", () => {
  const s = new Scene();
  s.ingest({ kind: "notification", id: "evt_nnnnnnnn", actor: { type: "system" }, payload: { kind: "permission_prompt" } }, 0);
  assert.equal(s.waiting, true);
  s.ingest({ kind: "tool.result", id: "evt_rrrrrrrr", actor: { type: "main" } }, 100);
  assert.equal(s.waiting, false);
});
