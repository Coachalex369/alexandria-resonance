#!/usr/bin/env node
// Performance and determinism benchmark for the Forge composer (no browser): generates a long synthetic
// multi-agent event stream, replays it through the Composer with animation ticks between events, and reports
// ingest/tick cost, complexity growth, memory, and that two replays produce identical snapshot hashes.
//   node tools/forge-bench.js [events=6000] [agents=5] [ticksPerEvent=6]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Composer } from "../packages/forge/src/composer.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mapping = JSON.parse(fs.readFileSync(path.join(root, "packages/forge/forge-mapping.json"), "utf8"));
const identities = JSON.parse(fs.readFileSync(path.join(root, "packages/forge/identities.json"), "utf8"));
const N = Number(process.argv[2] || 6000), AGENTS = Number(process.argv[3] || 5), TICKS = Number(process.argv[4] || 6);

// deterministic synthetic stream
let seed = 12345; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const types = ["implementer", "reviewer", "scout", "researcher", "test-runner"];
const cats = ["research", "planning", "frontend", "backend", "testing", "debugging", "documentation", "tooling"];
const ops = ["read", "search", "edit", "create", "run", "test", "plan", "browse"];
const events = [];
let t = Date.UTC(2026, 10, 8, 9, 0, 0);
const push = (kind, extra) => events.push({ schema: "alexandria.event/1", id: "b" + events.length, ts: new Date(t).toISOString(), source: "synthetic", kind, session: { id: "bench", project: "bench" }, actor: { type: "main" }, provenance: { observed: true, adapter: "bench", confidence: 1 }, ...extra });
push("session.start", {}); push("task.start", { task: { id: "T", title: "benchmark" } });
const agents = [];
for (let i = 0; i < N; i++) {
  t += 2000 + Math.floor(rnd() * 40000);
  const r = rnd();
  if (r < 0.01 && agents.length < AGENTS) { const a = { id: "ag" + agents.length, type: types[agents.length % types.length] }; agents.push(a); push("agent.start", { actor: { type: "subagent", agentId: a.id, agentType: a.type } }); continue; }
  if (r < 0.015 && agents.length) { const a = agents[Math.floor(rnd() * agents.length)]; push("agent.stop", { actor: { type: "subagent", agentId: a.id, agentType: a.type } }); continue; }
  const actor = agents.length && rnd() < 0.5 ? { type: "subagent", agentId: agents[Math.floor(rnd() * agents.length)].id, agentType: "implementer" } : { type: "main" };
  if (r < 0.06) { push("test.run", { actor, payload: { ok: rnd() < 0.75, passed: 10, failed: 1 } }); continue; }
  if (r < 0.08) { push("tool.failure", { actor, payload: { tool: "Bash" }, classification: [{ scheme: "operation", value: "run", basis: "observed", confidence: 0.9, by: "b" }] }); continue; }
  if (r < 0.09) { push("git.commit", { payload: { hash: "abc" } }); continue; }
  const op = ops[Math.floor(rnd() * ops.length)], cat = cats[Math.floor(rnd() * cats.length)];
  push("tool.result", { actor, payload: { tool: "X", paths: ["src/a.js"] }, classification: [{ scheme: "operation", value: op, basis: "observed", confidence: 0.9, by: "b" }, { scheme: "work-category", value: cat, basis: "inferred", confidence: 0.6, by: "b" }], durationMs: 300 });
}
push("task.end", { task: { id: "T" } });

function replay() {
  const c = new Composer({ mapping, identities, events });
  let clock = 0, ingestMs = 0, tickMs = 0, worldMs = 0, worst = 0;
  const mem0 = process.memoryUsage().heapUsed;
  for (let i = 0; i < events.length; i++) {
    let s = performance.now(); c.ingest(events[i], clock, i); const d = performance.now() - s; ingestMs += d; worst = Math.max(worst, d);
    for (let k = 0; k < TICKS; k++) { clock += 50; s = performance.now(); c.tick(50, clock); tickMs += performance.now() - s; }
    if (i % 500 === 0) { s = performance.now(); for (const n of c.nodes.values()) c.worldVertices(n); worldMs += performance.now() - s; }
  }
  const mem1 = process.memoryUsage().heapUsed;
  return { c, ingestMs, tickMs, worldMs, worst, heapDeltaMB: (mem1 - mem0) / 1048576 };
}
const a = replay(), b = replay();
const cx = a.c.complexity();
const out = {
  events: events.length, agents: agents.length, ticksPerEvent: TICKS,
  ingest: { totalMs: +a.ingestMs.toFixed(1), perEventMs: +(a.ingestMs / events.length).toFixed(4), worstEventMs: +a.worst.toFixed(2) },
  tick: { totalMs: +a.tickMs.toFixed(1), perTickMs: +(a.tickMs / (events.length * TICKS)).toFixed(4) },
  worldVerticesAllNodesMs: +(a.worldMs / Math.ceil(events.length / 500)).toFixed(3),
  complexity: cx, perNode: [...a.c.nodes.values()].map((n) => ({ id: n.id, identity: n.identity, v: n.structure.vertices.length, e: n.structure.edges.length, stage: n.stage, satellites: n.satellites.length })),
  heapDeltaMB: +a.heapDeltaMB.toFixed(1), rssMB: +(process.memoryUsage().rss / 1048576).toFixed(0),
  deterministic: a.c.snapshotHash() === b.c.snapshotHash(), snapshotHash: a.c.snapshotHash(), fingerprint: a.c.fingerprint, resolved: a.c.resolved,
};
console.log(JSON.stringify(out, null, 2));
