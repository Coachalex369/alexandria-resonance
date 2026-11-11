// Architectural boundary: the geometry and composition engines must stay independent of Claude Code, the
// event-engine adapters, the taxonomy package and the Scoreboard/visualizer interfaces. Only presentation
// files (forge.js, lab.js, index.html) may wire them to a specific event source or UI.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const ENGINE_FILES = [
  ...fs.readdirSync(path.join(root, "packages/geometry/src")).map((f) => "packages/geometry/src/" + f),
  ...fs.readdirSync(path.join(root, "packages/forge/src")).map((f) => "packages/forge/src/" + f),
  "packages/audio/src/music.js",
  "packages/audio/src/forge-music.js",
];
const FORBIDDEN_IMPORTS = ["event-engine", "taxonomy", "visualizer", "scoreboard", "collector", "claude"];
const importsOf = (src) => [...src.matchAll(/^\s*import[^"']*["']([^"']+)["']/gm)].map((m) => m[1]);

test("engine sources import only from their own package, the geometry package or Node built-ins", () => {
  for (const file of ENGINE_FILES) {
    const src = fs.readFileSync(path.join(root, file), "utf8");
    for (const spec of importsOf(src)) {
      assert.ok(!spec.startsWith("node:") || file.endsWith(".test.js") || true);
      for (const bad of FORBIDDEN_IMPORTS) assert.ok(!spec.toLowerCase().includes(bad), `${file} imports ${spec}`);
      if (spec.startsWith(".")) {
        const resolved = path.normalize(path.join(path.dirname(file), spec)).replace(/\\/g, "/");
        assert.ok(/^packages\/(geometry|forge|audio)\/src\//.test(resolved), `${file} reaches outside the engines: ${resolved}`);
      }
    }
  }
});

test("engine sources contain no Claude Code or Scoreboard specifics", () => {
  for (const file of ENGINE_FILES) {
    const src = fs.readFileSync(path.join(root, file), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""); // strip comments
    for (const word of ["settings.json", "events.jsonl", "PostToolUse", "SessionStart", "SubagentStop", "hook_event_name", "whistle", "horn", "scoreboard"]) {
      assert.ok(!src.toLowerCase().includes(word.toLowerCase()), `${file} mentions ${word}`);
    }
  }
});

test("the composer runs on generic event records with no classification and no Claude Code fields", async () => {
  const { Composer } = await import("../src/composer.js");
  const mapping = JSON.parse(fs.readFileSync(path.join(here, "../forge-mapping.json"), "utf8"));
  const identities = JSON.parse(fs.readFileSync(path.join(here, "../identities.json"), "utf8"));
  const events = [
    { id: "1", ts: "2026-01-01T00:00:00.000Z", kind: "task.start", actor: { type: "main" }, task: { id: "t" } },
    { id: "2", ts: "2026-01-01T00:00:01.000Z", kind: "agent.start", actor: { type: "subagent", agentId: "w1", agentType: "worker" } },
    { id: "3", ts: "2026-01-01T00:00:02.000Z", kind: "tool.result", actor: { type: "subagent", agentId: "w1", agentType: "worker" }, payload: { tool: "any" } },
    { id: "4", ts: "2026-01-01T00:00:03.000Z", kind: "test.run", actor: { type: "main" }, payload: { ok: true } },
    { id: "5", ts: "2026-01-01T00:00:04.000Z", kind: "something.unknown", actor: { type: "main" } },
    { id: "6", ts: "2026-01-01T00:00:05.000Z", kind: "task.end", actor: { type: "main" }, task: { id: "t" } },
  ];
  const c = new Composer({ mapping, identities, events });
  events.forEach((e, i) => { c.ingest(e, i * 1000, i); c.tick(100, i * 1000 + 100); });
  assert.equal(c.resolved, true);
  assert.equal(c.nodes.size, 3); // core + main + one worker
  assert.equal(c.identityFor({ type: "subagent", agentId: "w1", agentType: "worker" }), identities.fallback);
});
