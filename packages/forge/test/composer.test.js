import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Composer } from "../src/composer.js";
import { RippleField, mixHue } from "../src/ripples.js";
import { fingerprint, seedRandom, stableStringify } from "../src/fingerprint.js";
import { cube } from "../../geometry/src/polyhedra.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const mapping = JSON.parse(fs.readFileSync(path.join(here, "../forge-mapping.json"), "utf8"));
const identities = JSON.parse(fs.readFileSync(path.join(here, "../identities.json"), "utf8"));
const recording = fs.readFileSync(path.join(root, "demo/recordings/synthetic-multi-agent.events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);

const ev = (kind, extra = {}) => ({ schema: "alexandria.event/1", id: extra.id || `e-${kind}-${Math.random().toString(36).slice(2, 8)}`, ts: extra.ts || "2026-11-08T14:00:00.000Z", source: "synthetic", kind, session: { id: "s", project: "p" }, actor: { type: "main" }, provenance: { observed: true, adapter: "t", confidence: 1 }, ...extra });
const cls = (scheme, value) => ({ scheme, value, basis: "observed", confidence: 0.9, by: "test" });

function run(events, ticksPerEvent = 5) {
  const c = new Composer({ mapping, identities, events });
  let t = 0;
  events.forEach((e, i) => { c.ingest(e, t, i); for (let k = 0; k < ticksPerEvent; k++) { t += 100; c.tick(100, t); } });
  return c;
}

test("replaying the same recording twice gives identical snapshots; a different config gives a different fingerprint", () => {
  const a = run(recording), b = run(recording);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(a.snapshotHash(), b.snapshotHash());
  const c = new Composer({ mapping, identities, events: recording, config: { palette: "other" } });
  assert.notEqual(c.fingerprint, a.fingerprint);
  assert.equal(fingerprint(recording, { x: 1, y: 2 }), fingerprint(recording, { y: 2, x: 1 }));
  const r1 = seedRandom("seed"), r2 = seedRandom("seed");
  assert.equal(r1(), r2());
  assert.equal(stableStringify({ b: 1, a: [1, { d: 2, c: 3 }] }), '{"a":[1,{"c":3,"d":2}],"b":1}');
});

test("identities come from configuration and agent metadata, never from text", () => {
  const c = new Composer({ mapping, identities });
  assert.equal(c.identityFor({ type: "main" }), "forge");
  assert.equal(c.identityFor({ type: "subagent", agentId: "x", agentType: "implementer" }), "smith");
  assert.equal(c.identityFor({ type: "subagent", agentId: "x", agentType: "researcher" }), "scout");
  assert.equal(c.identityFor({ type: "subagent", agentId: "x", agentType: "unknown-type" }), identities.fallback);
  const pinned = new Composer({ mapping, identities: { ...identities, byAgentId: { x: "scout" } } });
  assert.equal(pinned.identityFor({ type: "subagent", agentId: "x", agentType: "implementer" }), "scout");
});

test("the synthetic session grows a main 4D structure, two agent structures and resolves at task.end only", () => {
  const c = run(recording);
  assert.ok(c.main.structure.dim === 4, "Forge identity seeds a 4-polytope");
  const agents = [...c.nodes.values()].filter((n) => n.kind === "agent" && n.id !== "main");
  assert.equal(agents.length, 2);
  assert.ok(agents.every((a) => a.docked), "both subagents docked after agent.stop");
  assert.ok(agents.every((a) => a.parentId === "main"));
  assert.ok(c.main.structure.edges.length > 96, "main grew beyond the seed 24-cell");
  assert.equal(c.resolved, true);
  const comp = c.complexity();
  assert.ok(comp.edges < mapping.growth.maxEdges * 1.6 * comp.nodes);
});

test("subagent stop never resolves the composition; main task.end does", () => {
  const events = [ev("task.start", { id: "t", task: { id: "T1", title: "x" } }), ev("agent.start", { id: "a", actor: { type: "subagent", agentId: "A", agentType: "implementer" } }), ev("tool.result", { id: "r", actor: { type: "subagent", agentId: "A", agentType: "implementer" }, payload: { tool: "Edit" }, classification: [cls("operation", "edit")] }), ev("agent.stop", { id: "s", actor: { type: "subagent", agentId: "A", agentType: "implementer" } }), ev("turn.stop", { id: "ts", actor: { type: "subagent", agentId: "A", agentType: "implementer" } })];
  const c = run(events);
  assert.equal(c.resolved, false);
  assert.equal(c.node("agent:A").docked, true);
  c.ingest(ev("task.end", { id: "end", task: { id: "T1" } }), c.time, 99);
  assert.equal(c.resolved, true);
  const before = c.main.offsets.map((o) => [...o]);
  for (let i = 0; i < 80; i++) c.tick(100);
  assert.ok(c.main.offsets.every((o) => Math.hypot(...o) <= 1e-6), "distortions relax to zero after resolution");
  assert.ok(before.length === c.main.offsets.length);
});

test("event mappings: debugging distorts, tests send waves and reinforce or weaken, failures weaken, commits seal", () => {
  const base = [ev("task.start", { id: "t", task: { id: "T" } })];
  const dbg = run([...base, ev("tool.result", { id: "d", payload: { tool: "Read" }, classification: [cls("operation", "read"), cls("work-category", "debugging")] })], 0);
  assert.ok(dbg.main.offsets.some((o) => Math.hypot(...o) > 0), "debugging displaces vertices");
  assert.ok(dbg.main.tension > 0);
  const pass = run([...base, ev("test.run", { id: "p", payload: { ok: true, passed: 3, failed: 0 } })], 0);
  assert.ok(pass.main.edgeWeight.some((w) => w > 0), "passing tests reinforce connections");
  assert.equal(pass.ripples.waves.filter((w) => w.meta.kindKey === "testPass").length, 2, "the actor and the core both ripple");
  assert.ok(pass.ripples.rings.length >= 1, "a test produces a ring into the empty field");
  const fail = run([...base, ev("test.run", { id: "f", payload: { ok: false, passed: 1, failed: 2 } })], 0);
  assert.ok(fail.main.edgeWeight.some((w) => w < 0), "failing tests weaken connections");
  assert.ok(fail.main.offsets.some((o) => Math.hypot(...o) > 0), "failing tests expose an unstable region");
  const seal = run([...base, ev("git.commit", { id: "g", payload: { hash: "abc" } })], 0);
  assert.ok(seal.ripples.waves.some((w) => w.meta.kindKey === "commit"));
  const edit = run([...base, ev("tool.result", { id: "e", payload: { tool: "Edit", paths: ["a.js"] }, classification: [cls("operation", "edit")] })], 0);
  assert.equal(edit.main.transforms, 1, "editing transforms the existing structure");
  assert.equal(edit.main.structure.vertices.length, 24, "...without adding unrelated objects");
});

test("complexity is bounded: thousands of events never exceed the edge cap or the satellite cap", () => {
  const events = [ev("task.start", { id: "t", task: { id: "T" } })];
  for (let i = 0; i < 1500; i++) events.push(ev("tool.result", { id: "r" + i, ts: new Date(Date.UTC(2026, 10, 8, 14, 0, i)).toISOString(), payload: { tool: i % 3 ? "Edit" : "Write" }, classification: [cls("operation", i % 3 ? "edit" : "create"), cls("work-category", i % 7 === 0 ? "research" : "frontend")] }));
  const c = run(events, 1);
  for (const n of c.nodes.values()) {
    assert.ok(n.structure.edges.length <= mapping.growth.maxEdges * 1.6, `${n.id} edges ${n.structure.edges.length}`);
    assert.ok(n.satellites.length <= mapping.growth.maxSatellites);
  }
  assert.ok(c.ripples.waves.length <= 64 && c.ripples.rings.length <= 48);
  assert.equal(c.main.stage, mapping.growth.thresholds.length, "all growth stages consumed, then only motion");
});

test("every vertex and edge keeps provenance to the event that created it; describe() returns it", () => {
  const c = run(recording);
  for (const n of c.nodes.values()) {
    assert.equal(n.refs.vertices.length, n.structure.vertices.length);
    assert.equal(n.refs.edges.length, n.structure.edges.length);
    assert.ok(n.refs.vertices.every((r) => typeof r.eventId === "string"), n.id + " vertex refs");
    assert.ok(n.refs.edges.every((r) => typeof r.eventId === "string"), n.id + " edge refs");
  }
  const d = c.describe("main", 5);
  assert.equal(d.node.identity, "forge");
  assert.ok(d.vertex.ref.eventId);
  assert.ok(d.edges.length > 0);
  assert.equal(d.fingerprint, c.fingerprint);
  assert.ok(!JSON.stringify(d).includes("prompt text"), "no content is ever carried");
  const sat = [...c.nodes.values()].find((n) => n.kind === "satellite");
  if (sat) assert.equal(c.describe(sat.id, 0).node.parentId, sat.parentId);
});

test("world vertices place agents away from the main structure and docked agents move inward", () => {
  const c = run(recording);
  const main = c.worldVertices(c.main);
  assert.ok(main.w && main.w.length === c.main.structure.vertices.length, "4D w kept for depth cues");
  for (const n of c.nodes.values()) if (n.kind === "agent" && n.id !== "main") {
    const r = Math.hypot(n.position[0], n.position[2]);
    assert.ok(Math.abs(r - mapping.layout.agentOrbit * mapping.layout.dockedOrbitScale) < 0.25, `docked orbit ${r}`);
    assert.ok(n.tethers.length === mapping.layout.tetherEdges + 1, "tethers to the core plus a thin link to the spawner");
    assert.ok(n.tethers.filter((th) => th.toNodeId === "core").length === mapping.layout.tetherEdges);
  }
});

test("ripple field: graph waves travel along hops, interfere, blend hue, and rings expand then expire", () => {
  const f = new RippleField();
  const c = cube();
  const w = f.addGraphWave(c, 0, { born: 0, hue: 120, strength: 1 });
  assert.equal(w.hops[0], 0);
  const early = f.vertexState(c.id, 0, 50).amp, far0 = f.vertexState(c.id, 7, 50).amp;
  assert.ok(Math.abs(early) > 0 && far0 === 0, "crest at origin first, far vertex quiet");
  const tFar = (3 / w.speed) * 1000; // crest reaches the opposite corner (3 hops)
  assert.ok(Math.abs(f.vertexState(c.id, 7, tFar).amp) > 0);
  f.addGraphWave(c, 7, { born: 0, hue: 0, strength: 1, sign: -1 });
  const mid = f.vertexState(c.id, 1, (1.5 / w.speed) * 1000);
  assert.ok(mid.energy > 0 && Math.abs(mid.amp) < mid.energy, "opposite-signed waves interfere");
  assert.ok(mid.hue != null);
  assert.equal(mixHue(350, 10, 0.5), 0);
  f.addRing([0, 0], { born: 0, life: 1000, r0: 0, r1: 1 });
  assert.ok(f.activeRings(250)[0].radius > 0.4 && f.activeRings(250)[0].radius < 0.6);
  assert.equal(f.activeRings(1500).length, 0);
  f.prune(20000);
  assert.deepEqual(f.size, { waves: 0, rings: 0 });
});

test("the objective core sits at the origin, gains structure only through verification, and children orbit their parent", () => {
  const base = [ev("task.start", { id: "t", task: { id: "T", title: "objective" } })];
  const c0 = run(base, 0);
  assert.ok(c0.core && c0.core.kind === "core");
  assert.deepEqual(c0.core.position, [0, 0, 0]);
  assert.ok(Math.hypot(...c0.main.position) > 1, "the main agent orbits the core");
  const edits = Array.from({ length: 30 }, (_, i) => ev("tool.result", { id: "e" + i, payload: { tool: "Edit", paths: ["src/x.js"] }, classification: [cls("operation", "edit")] }));
  const c1 = run([...base, ...edits], 0);
  assert.equal(c1.core.stage, 0, "edits alone do not grow the core");
  const c2 = run([...base, ev("test.run", { id: "p1", payload: { ok: true } }), ev("test.run", { id: "p2", payload: { ok: true } })], 0);
  assert.ok(c2.core.stage >= 1, "passing tests grow the core");
  assert.ok(c2.core.verified.some((v) => v === 1), "the core carries verified material");
  const child = run([...base,
    ev("agent.start", { id: "a", actor: { type: "subagent", agentId: "P", agentType: "implementer" } }),
    ev("agent.start", { id: "b", actor: { type: "subagent", agentId: "C", agentType: "test-runner" }, parent: { agentId: "P" } }),
    ev("test.run", { id: "tr", actor: { type: "subagent", agentId: "C", agentType: "test-runner" }, payload: { ok: false } }),
  ], 20);
  const P = child.node("agent:P"), C = child.node("agent:C");
  assert.equal(C.parentId, "agent:P");
  assert.ok(C.tethers.every((th) => th.toNodeId === "agent:P"), "children tether to their parent");
  assert.ok(G_dist(C.position, P.position) < G_dist(C.position, [0, 0, 0]), "the child is nearer its parent than the core");
  assert.ok(P.verified.some((v) => v === -1), "a helper's failing test marks the parent's work unstable");
  assert.ok(child.core.verified.some((v) => v === -1));
});

test("heat and verification: touched material is hot and unverified, passing tests verify and cool it, heat decays", () => {
  const base = [ev("task.start", { id: "t", task: { id: "T" } })];
  const c = run([...base, ev("tool.result", { id: "w", payload: { tool: "Write", paths: ["src/new.js"] }, classification: [cls("operation", "create")] })], 0);
  assert.ok(c.main.heat.some((h) => h === 1), "created material is hot");
  const hotBefore = c.main.heat.reduce((a, b) => a + b, 0);
  for (let i = 0; i < 1500; i++) c.tick(100); // 150 s of scene time (dt is clamped per tick)
  assert.ok(c.main.heat.reduce((a, b) => a + b, 0) < hotBefore * 0.6, "heat cools over time");
  c.ingest(ev("test.run", { id: "p", payload: { ok: true } }), c.time, 5);
  assert.ok(c.main.verified.filter((v) => v === 1).length > 0);
  assert.ok(c.verifiedFraction() > 0 && c.verifiedFraction() <= 1);
  const st = c.state();
  assert.equal(st.phase, "working"); assert.ok(st.agents.length === 1 && st.agents[0].id === "main");
  c.ingest(ev("tool.result", { id: "w2", payload: { tool: "Edit", paths: ["src/new.js"] }, classification: [cls("operation", "edit")] }), c.time, 6);
  assert.ok(c.main.heat.some((h) => h === 1), "editing re-heats");
});
const G_dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

test("the scripted demo session replays deterministically into a resolved, mostly verified composition", () => {
  const demo = fs.readFileSync(path.join(root, "demo/recordings/forge-demo-session.events.jsonl"), "utf8").trim().split(String.fromCharCode(10)).map(JSON.parse);
  assert.ok(demo.every((e) => e.provenance.synthetic === true && e.source !== "claude-hooks"), "clearly labelled synthetic events only");
  const replay = () => { const c = new Composer({ mapping, identities, events: demo }); let t = 0, prev = Date.parse(demo[0].ts); demo.forEach((e, i) => { const ts = Date.parse(e.ts); while (prev + 250 <= ts) { prev += 250; t += 250; c.tick(250, t); } c.ingest(e, t, i); }); return c; };
  const a = replay(), b = replay();
  assert.equal(a.snapshotHash(), b.snapshotHash());
  assert.equal(a.resolved, true);
  assert.ok(a.verifiedFraction() > 0.5, "most material verified: " + a.verifiedFraction());
  assert.ok(a.core.stage >= 1, "the objective gained structure from verification");
  const ids = [...a.nodes.keys()];
  assert.ok(ids.includes("agent:scout-1") && ids.includes("agent:smith-1") && ids.includes("agent:smith-helper-1") && ids.includes("agent:smith-tests-1"));
  assert.equal(a.node("agent:smith-helper-1").parentId, "agent:smith-1");
  assert.equal(a.node("agent:smith-tests-1").parentId, "agent:smith-1");
  assert.equal(a.node("agent:scout-1").identity, "scout"); assert.equal(a.node("agent:smith-1").identity, "smith"); assert.equal(a.main.identity, "forge");
  assert.ok([...a.nodes.values()].filter((n) => n.kind === "agent").every((n) => n.id === "main" || n.docked), "every subagent returned");
  // the failing test left a trace: unstable material existed at some point, and the fix verified it
  const smith = a.node("agent:smith-1");
  assert.equal(smith.verified.filter((v) => v === -1).length, 0);
  assert.ok(smith.verified.every((v) => v === 1), "Smith's structure is fully verified at the end");
});
