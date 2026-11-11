// Live adapter: objectives, phases, implementation stretches, inferred commits — and that the unchanged Universe
// engine turns real-shaped collector activity into crystals, reflections, membranes, a finale and a resumption.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LiveAdapter, universeConfig, ADAPTER } from "../src/adapter.js";
import { parseHookLog } from "../../event-engine/src/adapters/claudeHooks.js";
import { validateEvent } from "../../event-engine/src/schema.js";
import { Universe } from "../../forge/src/universe.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const mapping = JSON.parse(fs.readFileSync(path.join(root, "packages/forge/forge-mapping.json"), "utf8"));
const identities = JSON.parse(fs.readFileSync(path.join(root, "packages/forge/identities.json"), "utf8"));

// Collector v3 lines (content-free, as the installed hook writes them).
let clock = Date.parse("2026-11-10T18:00:00.000Z");
const at = (s) => new Date((clock += s * 1000)).toISOString();
function line(ev, extra = {}, sid = "s-one") { return JSON.stringify({ ts: at(extra.dt ?? 2), ev, sid, v: 3, proj: "demo-proj", ...extra, dt: undefined }); }
let tu = 0;
const tool = (tool, extra = {}, sid) => line("PostToolUse", { tool, tuid: "toolu_" + ++tu, durMs: 300, ...extra }, sid);
const testPass = (sid) => tool("Bash", { sig: "npm test", tests: { framework: "node:test", passed: 12, failed: 0, skipped: 0, ok: true } }, sid);

function sessionLines(sid = "s-one") {
  return [
    line("SessionStart", { source: "startup" }, sid),
    line("UserPromptSubmit", { promptLen: 400 }, sid),
    tool("Read", {}, sid), tool("Grep", {}, sid), tool("Read", {}, sid),
    tool("Edit", {}, sid), tool("Read", {}, sid), tool("Edit", {}, sid), tool("Write", {}, sid), // one stretch: reads do not split it
    testPass(sid),
    tool("Edit", {}, sid), testPass(sid),                                                       // stretch 2
    tool("Write", {}, sid), testPass(sid),                                                      // stretch 3
    tool("Bash", { sig: "git commit" }, sid),
    line("Stop", {}, sid),
  ];
}
const parse = (lines) => parseHookLog(lines.join("\n") + "\n", { file: "events.jsonl" });

function build(events, sid = "s-one") {
  const u = new Universe({ mapping, identities, config: universeConfig(sid) });
  let t = 0;
  new LiveAdapter().processAll(events).forEach((e, i) => { t += 500; u.ingest(e, t, i); u.tick(500, t); });
  return u;
}

test("every record the adapter emits is a valid alexandria.event/1 record; synthetic ones say so", () => {
  const out = new LiveAdapter().processAll(parse(sessionLines()));
  for (const e of out) assert.deepEqual(validateEvent(e), [], `${e.kind} ${e.id}`);
  const synthetic = out.filter((e) => e.provenance.adapter === ADAPTER);
  assert.deepEqual(synthetic.map((e) => e.kind), ["task.start", "git.commit"]);
  assert.ok(synthetic.every((e) => e.provenance.observed === false));
});

test("the session is the objective, prompts are phases, labels come from tool names and signatures only", () => {
  const out = new LiveAdapter().processAll(parse(sessionLines()));
  assert.equal(out[0].kind, "session.start"); assert.equal(out[1].kind, "task.start"); assert.equal(out[1].task.id, "session:s-one");
  assert.equal(out[0].payload.stage, "Opening");
  assert.ok(out.slice(2).every((e) => e.payload.stage === "Phase 1"));
  assert.ok(out.some((e) => e.payload.label === "Bash · npm test"));
  assert.ok(out.some((e) => e.kind === "test.run" && e.payload.label === "npm test · 12 passed"));
});

test("implementation stretches: reads don't split, verification and gaps do; subagents have their own", () => {
  const sid = "s-st";
  const lines = [line("SessionStart", {}, sid), line("UserPromptSubmit", {}, sid), tool("Edit", {}, sid), tool("Read", {}, sid), tool("Edit", {}, sid), testPass(sid), tool("Edit", {}, sid),
    tool("Edit", { dt: 6 * 60 }, sid), // gap > 5 min → new stretch
    line("SubagentStart", { agent: "a1b2c3d4e5", agentType: "implementer" }, sid), tool("Write", { agent: "a1b2c3d4e5", agentType: "implementer" }, sid), tool("Edit", {}, sid)];
  const paths = new LiveAdapter().processAll(parse(lines)).filter((e) => e.payload?.path).map((e) => e.payload.path);
  assert.deepEqual(paths, ["stretch 1", "stretch 1", "stretch 2", "stretch 3", "implementer a1b2c3 · stretch 1", "stretch 3"]);
});

test("only a successful 'git commit' signature infers a commit", () => {
  const sid = "s-c";
  const lines = [line("SessionStart", {}, sid), tool("Bash", { sig: "git push" }, sid), tool("Bash", { sig: "git checkout" }, sid), line("PostToolUseFailure", { tool: "Bash", sig: "git commit", tuid: "t-f", failed: true }, sid), tool("Bash", { sig: "git commit" }, sid)];
  const commits = new LiveAdapter().processAll(parse(lines)).filter((e) => e.kind === "git.commit");
  assert.equal(commits.length, 1);
  assert.equal(commits[0].classification[0].basis, "inferred");
});

test("the unchanged engine grows crystals from stretches, reflects verified ones and seals a commit membrane", () => {
  const u = build(parse(sessionLines()));
  const kinds = [...u.bodies.values()].map((b) => b.kind);
  assert.equal(kinds.filter((k) => k === "crystal").length, 3);
  assert.equal(kinds.filter((k) => k === "reflection").length, 3);
  assert.equal(kinds.filter((k) => k === "membrane").length, 1);
  assert.ok(u.task && !u.resolved, "the objective is open and not resolved by a turn ending");
  assert.ok(u.verifiedFraction() > 0.5);
});

test("session end resolves (finale); later activity resumes the same artwork without losing it", () => {
  const sid = "s-r";
  const a = new LiveAdapter(), u = new Universe({ mapping, identities, config: universeConfig(sid) });
  let t = 0, i = 0;
  const feed = (lines) => { for (const e of a.processAll(parse(lines))) { t += 500; u.ingest(e, t, i++); u.tick(500, t); } };
  feed([line("SessionStart", {}, sid), line("UserPromptSubmit", {}, sid), tool("Edit", {}, sid), testPass(sid), line("SessionEnd", { reason: "prompt_input_exit" }, sid)]);
  assert.equal(u.resolved, true);
  const before = u.bodies.size;
  feed([line("SessionStart", { source: "resume" }, sid), line("UserPromptSubmit", {}, sid), tool("Write", {}, sid)]);
  assert.equal(u.resolved, false);
  assert.ok(u.bodies.size > before, "the resumed session keeps growing the same universe");
  assert.ok([...u.events.values()].some((e) => e.label === "Session resumed"));
});

test("deterministic: the same events build the same snapshot; different sessions build different universes", () => {
  const ev = parse(sessionLines("s-det"));
  assert.equal(build(ev, "s-det").snapshotHash(), build(ev, "s-det").snapshotHash());
  assert.notEqual(build(ev, "s-det").fingerprint, build(ev, "s-other").fingerprint);
});

// Collector v4 (protocol 3.1): the hook emits an observed git.commit itself, so inference applies to older collectors only.
const v4 = { v: 4 };
const commitsOf = (lines) => new LiveAdapter().processAll(parse(lines)).filter((e) => e.kind === "git.commit");

test("collector v3: a single 'git commit' tool.result still yields exactly one inferred git.commit", () => {
  const sid = "s-v3c";
  const commits = commitsOf([line("SessionStart", {}, sid), tool("Edit", {}, sid), tool("Bash", { sig: "git commit" }, sid)]);
  assert.equal(commits.length, 1); assert.equal(commits[0].provenance.observed, false); assert.equal(commits[0].classification[0].basis, "inferred");
});

test("collector v4: a 'git commit' tool.result plus its observed git.commit yields ONE commit, the observed one", () => {
  const sid = "s-v4a";
  const commits = commitsOf([line("SessionStart", v4, sid), tool("Edit", v4, sid), tool("Bash", { ...v4, sig: "git commit", segs: ["git commit"], commit: { hash: "a1b2c3d4e5f6" } }, sid)]);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].provenance.observed, true); assert.equal(commits[0].source, "claude-hooks"); assert.equal(commits[0].payload.hash, "a1b2c3d4e5f6"); assert.equal(commits[0].payload.label, "Commit");
  assert.equal(validateEvent(commits[0]).length, 0);
});

test("collector v4: a chained 'git add && git commit' yields one git.commit and closes the stretch", () => {
  const sid = "s-v4b";
  const out = new LiveAdapter().processAll(parse([
    line("SessionStart", v4, sid), tool("Edit", v4, sid), tool("Edit", v4, sid),
    tool("Bash", { ...v4, sig: "git add", segs: ["git add", "git commit"], commit: { hash: "0123456789ab" } }, sid),
    tool("Edit", v4, sid),
  ]));
  assert.equal(out.filter((e) => e.kind === "git.commit").length, 1);
  const paths = out.filter((e) => e.payload && e.payload.tool === "Edit").map((e) => e.payload.path);
  assert.deepEqual(paths, ["stretch 1", "stretch 1", "stretch 2"], "the edit after the commit starts a new stretch");
});

test("collector v4: a 'git commit' tool.result with no observed commit (nothing to commit) yields no commit", () => {
  const sid = "s-v4c";
  assert.equal(commitsOf([line("SessionStart", v4, sid), tool("Edit", v4, sid), tool("Bash", { ...v4, sig: "git commit", segs: ["git commit"] }, sid)]).length, 0);
});
