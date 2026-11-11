import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Universe } from "../src/universe.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const mapping = JSON.parse(fs.readFileSync(path.join(here, "../forge-mapping.json"), "utf8"));
const identities = JSON.parse(fs.readFileSync(path.join(here, "../identities.json"), "utf8"));
const recording = fs.readFileSync(path.join(here, "../../../demo/recordings/forge-demo-session.events.jsonl"), "utf8").split(String.fromCharCode(10)).filter(Boolean).map((l) => JSON.parse(l));

function run(events, { step = 250 } = {}) {
  const u = new Universe({ mapping, identities, events });
  const t0 = Date.parse(events[0].ts); let clock = 0, prev = t0;
  events.forEach((e, i) => { const ts = Date.parse(e.ts); while (prev + step <= ts) { prev += step; clock += step; u.tick(step, clock); } u.ingest(e, clock, i); });
  for (let k = 0; k < 40; k++) { clock += step; u.tick(step, clock); }
  return u;
}

test("deterministic: the same recording and configuration reproduce the same snapshot hash", () => {
  assert.equal(run(recording).snapshotHash(), run(recording).snapshotHash());
});
test("one shared universe: every body is connected to the origin through links and bodies (spatial continuity)", () => {
  const u = run(recording);
  const adj = new Map(); const add = (a, b) => { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a).add(b); };
  for (const l of u.links) { add(l.a.bodyId, l.b.bodyId); add(l.b.bodyId, l.a.bodyId); }
  const seen = new Set(["origin"]), q = ["origin"];
  while (q.length) { const x = q.shift(); for (const y of adj.get(x) || []) if (!seen.has(y)) { seen.add(y); q.push(y); } }
  for (const id of u.order) assert.ok(seen.has(id), `${id} is not connected to the origin`);
  assert.ok(u.bodies.size <= u.U.caps.bodies);
});
test("as above, so below: the plane lies at y = 0, crystals rise above it, roots and reflections lie beneath", () => {
  const u = run(recording);
  assert.ok(u.plane.structure.vertices.every((v) => v[1] === 0));
  assert.ok(u.plane.rings >= 2, "planning spread the plane");
  const kinds = (k) => [...u.bodies.values()].filter((b) => b.kind === k);
  assert.ok(kinds("crystal").length >= 5, "implementation produced crystals");
  for (const c of kinds("crystal")) assert.ok(u.worldVertices(c).points.every((p) => p[1] >= -1e-6), `${c.id} above the plane`);
  assert.ok(kinds("root").length >= 1, "research produced a root network");
  for (const r of kinds("root")) assert.ok(u.worldVertices(r).points.slice(1).every((p) => p[1] <= 1e-6), `${r.id} beneath the plane`);
  assert.ok(kinds("reflection").length >= 3, "verified crystals gained reflections");
  for (const r of kinds("reflection")) assert.ok(u.worldVertices(r).points.every((p) => p[1] <= 1e-6), `${r.id} beneath the plane`);
  const s = u.state(); assert.ok(s.above > 0 && s.below > 0);
  assert.ok(kinds("field").length === 1 && u.field.structure.dim === 4);
});
test("development events matter: verification, failure, commit and completion leave their marks", () => {
  const u = run(recording);
  assert.equal(u.resolved, true);
  assert.ok(u.verifiedFraction() > 0.4, `verified ${u.verifiedFraction()}`);
  assert.ok(u.tests.passed >= 2 && u.tests.failed >= 1);
  assert.ok(u.milestones.firstFail && u.milestones.firstPass && u.milestones.firstPass > u.milestones.firstFail);
  assert.ok([...u.bodies.values()].some((b) => b.kind === "membrane"), "a commit sealed a membrane");
  assert.ok(u.origin.stage >= 1, "the objective gained structure");
  const smith = [...u.agents.values()].find((a) => a.identity === "smith" && a.crystals.length);
  assert.ok(smith.crystals.every((id) => u.bodies.get(id).verified.every((v) => v === 1)), "Smith's crystals are fully verified at the end");
  const scoutRoot = [...u.bodies.values()].find((b) => b.kind === "root");
  assert.ok(scoutRoot.verified.includes(-1), "the dead-end fetch is marked");
  assert.ok(u.links.some((l) => l.kind === "closure") && u.links.some((l) => l.kind === "collaboration") && u.links.some((l) => l.kind === "review"));
});
test("provenance: every vertex and link traces to an event; edits transform existing crystals instead of adding bodies", () => {
  const u = run(recording);
  for (const b of u.bodies.values()) for (const r of b.refs.vertices) assert.ok(r && r.eventId, `${b.id} vertex without provenance`);
  for (const l of u.links) assert.ok(l.ref.eventId);
  const routes = u.bodies.get("crystal:src/ui/SavedSearches.jsx");
  assert.ok(routes && routes.structure.meta.stages >= 2, "repeated edits added stages to the same crystal");
  assert.equal([...u.bodies.keys()].filter((k) => k.includes("SavedSearches.jsx") && !k.startsWith("reflection")).length, 1);
  const d = u.describe(routes.id, routes.structure.meta.apexIndex);
  assert.equal(d.body.path, "src/ui/SavedSearches.jsx"); assert.ok(d.event && d.event.label);
});
test("bounded complexity and a generic record with no classification", () => {
  const u = run(recording);
  const c = u.counts(); assert.ok(c.edges < 6000 && c.bodies <= 90 && c.links <= 400, JSON.stringify(c));
  const events = [
    { id: "1", ts: "2026-01-01T00:00:00.000Z", kind: "task.start", actor: { type: "main" }, task: { id: "t" } },
    { id: "2", ts: "2026-01-01T00:00:01.000Z", kind: "agent.start", actor: { type: "subagent", agentId: "w1", agentType: "worker" } },
    { id: "3", ts: "2026-01-01T00:00:02.000Z", kind: "tool.result", actor: { type: "subagent", agentId: "w1", agentType: "worker" }, payload: { tool: "any", paths: ["a.js"] } },
    { id: "4", ts: "2026-01-01T00:00:03.000Z", kind: "test.run", actor: { type: "subagent", agentId: "w1", agentType: "worker" }, payload: { ok: true } },
    { id: "5", ts: "2026-01-01T00:00:04.000Z", kind: "something.unknown", actor: { type: "main" } },
    { id: "6", ts: "2026-01-01T00:00:05.000Z", kind: "task.end", actor: { type: "main" }, task: { id: "t" } },
  ];
  const g = run(events);
  assert.equal(g.resolved, true); assert.ok(g.bodies.has("plane") && g.bodies.has("origin") && g.bodies.has("field") && g.bodies.has("seed:w1"));
});
