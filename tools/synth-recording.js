#!/usr/bin/env node
// Generates a synthetic but realistic multi-agent recording for demos and tests.
//   node tools/synth-recording.js demo/recordings/synthetic-multi-agent.events.jsonl [--seed 7]
// Shape (based on measured phase-2 statistics): one human brief → recon reads → a build phase with edits and
// test runs → a Sonnet implementer and an Opus reviewer in parallel → integration → tests → commit → stop.
// Pace: ~20–30 s per main-thread tool call; subagents at their measured medians. No text, only names and counts.
import fs from "node:fs";
import path from "node:path";
import { makeEvent } from "../packages/event-engine/src/schema.js";
import { stableId } from "../packages/event-engine/src/ids.js";
import { classifyToolEvent } from "../packages/taxonomy/src/index.js";

const out = process.argv[2] || "demo/recordings/synthetic-multi-agent.events.jsonl";
const seedArg = process.argv.indexOf("--seed"); let seed = seedArg >= 0 ? Number(process.argv[seedArg + 1]) : 11;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const jitter = (ms, f = 0.4) => Math.round(ms * (1 - f + rnd() * 2 * f));

const session = { id: "synthetic-session-0001", project: "demo-shop-app" };
let t = Date.parse("2026-11-08T14:00:00.000Z");
let n = 0;
const events = [];
const emit = (kind, actor, { payload, parent, task, durationMs, classification, source = "synthetic", observed = true } = {}) => {
  n++;
  events.push(makeEvent({ id: stableId("evt", "synth", n), ts: t, source, kind, session, actor, payload, parent, task, durationMs, classification, provenance: { observed, adapter: "synthetic@1", confidence: 1, synthetic: true } }));
};
const advance = (ms) => { t += ms; };
const main = { type: "main", model: "claude-fable-5-1", modelConfidence: "declared" };
const human = { type: "human" };
// an invented shop application (the "demo-shop-app" of the recording); the same path categories as a real web app
const FILES = { backend: ["src/server/app.js", "src/orders/history.js", "src/orders/filters.js"], frontend: ["public/cart.js", "public/styles.css", "public/index.html"], tests: ["test/app.test.js", "test/date-format.test.js"], docs: ["docs/ARCHITECTURE.md", "README.md"], i18n: ["src/i18n/es.js", "src/i18n/fr.js", "src/i18n/ja.js"] };

function toolCall(tool, { paths = [], signature = null, durationMs = jitter(900), actor = main, parent = {} } = {}) {
  const tuid = `tu_${n + 1}`;
  const cls = classifyToolEvent({ toolName: tool, paths, signature });
  emit("tool.call", actor, { payload: { tool, paths, signature }, parent: { ...parent, toolUseId: tuid }, classification: cls });
  advance(durationMs);
  emit("tool.result", actor, { payload: { tool, paths, signature }, parent: { ...parent, toolUseId: tuid }, durationMs, classification: cls });
  advance(jitter(actor === main ? 22000 : 12000)); // thinking + generation between calls
  return tuid;
}

// 1. owner brief and task
emit("session.start", { type: "system" }, { payload: { sourceOfStart: "startup" } }); advance(1500);
emit("prompt.submit", human, { payload: { promptLen: 1480 }, parent: { promptId: "p1" } });
emit("task.start", { type: "system" }, { task: { id: "task-1", title: "Localize server errors and unify date formatting" }, source: "marks" });
emit("task.estimate", main, { task: { id: "task-1" }, payload: { p50Min: 14, p90Min: 30, calls: 28, basis: "declared" }, observed: false, source: "marks" });
advance(jitter(20000));
// 2. recon
for (let i = 0; i < 6; i++) toolCall(pick(["Read", "Grep", "Glob", "Bash"]), { paths: [pick([...FILES.backend, ...FILES.tests])], signature: "grep -n", durationMs: jitter(300) });
// 3. delegate: implementer (Sonnet) + reviewer (Opus) in parallel
const tuImpl = `tu_${n + 1}`;
emit("tool.call", main, { payload: { tool: "Agent", subagentType: "implementer", subagentModel: "sonnet" }, parent: { toolUseId: tuImpl }, classification: classifyToolEvent({ toolName: "Agent" }) });
const impl = { type: "subagent", agentId: "agent-impl-1", agentType: "implementer", model: "claude-sonnet-5-5", modelConfidence: "declared" };
emit("agent.start", impl, { payload: { agentType: "implementer" }, parent: { toolUseId: tuImpl } });
const tuRev = `tu_${n + 1}`;
emit("tool.call", main, { payload: { tool: "Agent", subagentType: "reviewer", subagentModel: "opus" }, parent: { toolUseId: tuRev }, classification: classifyToolEvent({ toolName: "Agent" }) });
const rev = { type: "subagent", agentId: "agent-rev-1", agentType: "reviewer", model: "claude-opus-5-5", modelConfidence: "declared" };
emit("agent.start", rev, { payload: { agentType: "reviewer" }, parent: { toolUseId: tuRev } });
// interleave subagent work on their own clocks
const tStart = t; let tImpl = t, tRev = t;
const implCalls = [], revCalls = [];
for (let i = 0; i < 14; i++) implCalls.push([pick(["Read", "Edit", "Edit", "Write", "Bash"]), pick([...FILES.backend, ...FILES.i18n, ...FILES.tests])]);
for (let i = 0; i < 9; i++) revCalls.push([pick(["Read", "Grep", "Read", "Bash"]), pick([...FILES.backend, ...FILES.frontend])]);
const sub = [];
for (const [tool, p] of implCalls) { const d = tool === "Bash" ? jitter(9000) : jitter(400); sub.push({ ts: tImpl, actor: impl, tool, p, d, parent: { agentId: impl.agentId } }); tImpl += d + jitter(11000); }
for (const [tool, p] of revCalls) { const d = jitter(500); sub.push({ ts: tRev, actor: rev, tool, p, d, parent: { agentId: rev.agentId } }); tRev += d + jitter(16000); }
sub.sort((a, b) => a.ts - b.ts);
for (const s of sub) { t = s.ts; const tuid = `tu_${n + 1}`; const sig = s.tool === "Bash" ? "npm test" : null; const cls = classifyToolEvent({ toolName: s.tool, paths: [s.p], signature: sig }); emit("tool.call", s.actor, { payload: { tool: s.tool, paths: [s.p], signature: sig }, parent: { ...s.parent, toolUseId: tuid }, classification: cls }); t += s.d; emit("tool.result", s.actor, { payload: { tool: s.tool, paths: [s.p], signature: sig }, parent: { ...s.parent, toolUseId: tuid }, durationMs: s.d, classification: cls }); }
t = tImpl; emit("test.run", impl, { payload: { framework: "node:test", passed: 464, failed: 0, skipped: 0, ok: true, label: "npm test" }, durationMs: 9200, classification: [{ scheme: "operation", value: "test", basis: "observed", confidence: 1, by: "adapter" }, { scheme: "work-category", value: "testing", basis: "observed", confidence: 0.9, by: "adapter" }], source: "tests" });
advance(3000); emit("agent.stop", impl, { parent: { toolUseId: tuImpl } }); emit("tool.result", main, { payload: { tool: "Agent", subagentType: "implementer" }, parent: { toolUseId: tuImpl }, durationMs: t - tStart, classification: classifyToolEvent({ toolName: "Agent" }) });
t = Math.max(t, tRev); emit("agent.stop", rev, { parent: { toolUseId: tuRev } }); emit("tool.result", main, { payload: { tool: "Agent", subagentType: "reviewer" }, parent: { toolUseId: tuRev }, durationMs: t - tStart, classification: classifyToolEvent({ toolName: "Agent" }) });
advance(jitter(25000));
// 4. integration by the main thread: edits, a failing then passing test run, a permission wait, commit
for (let i = 0; i < 5; i++) toolCall(pick(["Edit", "Edit", "Read"]), { paths: [pick([...FILES.backend, ...FILES.frontend])], durationMs: jitter(350) });
toolCall("Bash", { signature: "npm test", durationMs: 9400 });
emit("test.run", main, { payload: { framework: "node:test", passed: 463, failed: 1, skipped: 0, ok: false, label: "npm test" }, durationMs: 9400, source: "tests", classification: [{ scheme: "operation", value: "test", basis: "observed", confidence: 1, by: "adapter" }, { scheme: "work-category", value: "debugging", basis: "inferred", confidence: 0.6, by: "rule:failed-test" }] });
advance(jitter(30000));
for (let i = 0; i < 2; i++) toolCall("Edit", { paths: [FILES.backend[0]], durationMs: jitter(300) });
toolCall("Bash", { signature: "npm test", durationMs: 9100 });
emit("test.run", main, { payload: { framework: "node:test", passed: 466, failed: 0, skipped: 0, ok: true, label: "npm test" }, durationMs: 9100, source: "tests", classification: [{ scheme: "operation", value: "test", basis: "observed", confidence: 1, by: "adapter" }, { scheme: "work-category", value: "testing", basis: "observed", confidence: 0.9, by: "adapter" }] });
advance(jitter(15000));
emit("notification", { type: "system" }, { payload: { kind: "permission_prompt" } }); advance(48000); // the human approves after 48 s
toolCall("Bash", { signature: "git commit -q -m", durationMs: 700 });
emit("git.commit", human, { payload: { hash: "abc123def456", files: 9, added: 120, removed: 31, authored: "assistant" }, classification: [{ scheme: "operation", value: "commit", basis: "observed", confidence: 1, by: "git" }], source: "git" });
toolCall("Write", { paths: [FILES.docs[0]], durationMs: jitter(200) });
emit("task.end", { type: "system" }, { task: { id: "task-1" }, payload: { outcome: "pass" }, source: "marks" });
emit("turn.stop", main, { payload: { stopHookActive: false } }); advance(500);
emit("session.end", { type: "system" }, { payload: { reason: "other" } });

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
console.log(`wrote ${events.length} events spanning ${((t - Date.parse(events[0].ts)) / 60000).toFixed(1)} min → ${out}`);
