#!/usr/bin/env node
// Writes the scripted, clearly labelled SYNTHETIC demonstration session for The Forge:
//   demo/recordings/forge-demo-session.events.jsonl  (~10 minutes of recording time, 10 story stages)
// It enters the engine through the same generic event record every adapter produces (alexandria.event/1),
// so nothing in the page is a hard-coded animation. Every event carries provenance.synthetic = true and a
// human-readable payload.label; payload.stage names the story stage. No real development records are used.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateEvent } from "../packages/event-engine/src/schema.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = process.argv[2] || path.join(root, "demo/recordings/forge-demo-session.events.jsonl");

const T0 = Date.UTC(2026, 10, 9, 10, 0, 0);
const TIME_SCALE = 1.2; // stretches the script to roughly ten minutes of recording time
const SESSION = { id: "synthetic-demo-forge-0001", project: "demo-notes-app" };
const TASK = { id: "demo-task-1", title: "Build and verify the saved-searches feature" };
const FORGE = { type: "main", model: "synthetic-planner", modelConfidence: "declared" };
const SCOUT = { type: "subagent", agentId: "scout-1", agentType: "researcher", model: "synthetic-researcher", modelConfidence: "declared" };
const SMITH = { type: "subagent", agentId: "smith-1", agentType: "implementer", model: "synthetic-coder", modelConfidence: "declared" };
const HELPER = { type: "subagent", agentId: "smith-helper-1", agentType: "implementer", model: "synthetic-coder", modelConfidence: "declared" };
const TESTER = { type: "subagent", agentId: "smith-tests-1", agentType: "test-runner", model: "synthetic-runner", modelConfidence: "declared" };

const events = [];
let n = 0, tu = 0;
const cls = (scheme, value, confidence = 0.9, basis = "observed") => ({ scheme, value, basis, confidence, by: "synthetic-demo" });
const ev = (sec, kind, actor, extra = {}) => {
  const e = { schema: "alexandria.event/1", id: `demo-${String(++n).padStart(3, "0")}`, ts: new Date(T0 + Math.round(sec * TIME_SCALE * 1000)).toISOString(), source: "synthetic", kind, session: SESSION, actor, ...extra, provenance: { observed: false, adapter: "synthetic-demo@1", confidence: 1, synthetic: true } };
  const errs = validateEvent(e); if (errs.length) throw new Error(`${kind} @${sec}: ${errs.join("; ")}`);
  events.push(e); return e;
};
// a tool call + result pair (durations in seconds), with operation/category/language classification
const LANG = (p) => (/\.jsx?$/.test(p) ? "javascript" : /\.md$/.test(p) ? "markdown" : null);
function tool(sec, actor, toolName, op, category, { paths = [], dur = 2, label, stage, signature = null, fail = false, catConf = 0.75 } = {}) {
  const id = `tu_${++tu}`;
  const classification = [cls("operation", op, 0.95)];
  if (category) classification.push(cls("work-category", category, catConf, "inferred"));
  if (paths[0] && LANG(paths[0])) classification.push(cls("language", LANG(paths[0]), 0.95));
  ev(sec, "tool.call", actor, { parent: { toolUseId: id }, payload: { tool: toolName, paths, label, stage } });
  ev(sec + dur, fail ? "tool.failure" : "tool.result", actor, { parent: { toolUseId: id }, payload: { tool: toolName, paths, signature, label, stage }, classification, durationMs: dur * 1000 });
}
const structure = (sec, actor, name, kind, pathName, stage) => ev(sec, "code.structure", actor, { source: "parser", payload: { name, kind, path: pathName, stage, label: `${kind} ${name} added` }, classification: [cls("code-structure", kind === "function" ? "function" : kind === "test" ? "test-case" : "module", 0.95)] });

// ---------------- the story ----------------
const S1 = "1 · Forge receives the objective and plans";
ev(0, "session.start", { type: "system" }, { payload: { sourceOfStart: "startup", label: "Synthetic demonstration session", stage: S1 } });
ev(2, "prompt.submit", { type: "human" }, { parent: { promptId: "p1" }, payload: { promptLen: 940, label: "Owner brief: saved-searches feature", stage: S1 } });
ev(2, "task.start", { type: "system" }, { source: "marks", task: TASK, payload: { label: "Objective opened", stage: S1 } });
ev(3, "task.estimate", FORGE, { source: "marks", task: TASK, payload: { p50Min: 9, p90Min: 14, calls: 60, basis: "declared", label: "Forge estimates 9–14 minutes", stage: S1 }, classification: [cls("task-type", "feature", 0.8, "declared")] });
tool(4, FORGE, "Read", "read", "planning", { paths: ["README.md"], dur: 3, label: "Forge reads the project overview", stage: S1 });
tool(9, FORGE, "Read", "read", "planning", { paths: ["src/api/routes.js"], dur: 4, label: "Forge reads the routing layer", stage: S1 });
tool(15, FORGE, "Read", "read", "planning", { paths: ["src/store/index.js"], dur: 4, label: "Forge reads the store", stage: S1 });
tool(21, FORGE, "Grep", "search", "planning", { paths: ["src/ui/SearchBar.jsx"], dur: 2, label: "Forge finds the search UI entry point", stage: S1, signature: "grep -n" });
tool(26, FORGE, "Read", "read", "planning", { paths: ["src/ui/SearchBar.jsx"], dur: 4, label: "Forge reads the search bar", stage: S1 });
tool(33, FORGE, "Plan", "plan", "planning", { dur: 14, label: "Forge drafts the plan: store → API → UI → tests", stage: S1, catConf: 0.9 });
tool(50, FORGE, "Plan", "plan", "planning", { dur: 8, label: "Forge defines acceptance: 43 tests green", stage: S1, catConf: 0.9 });

const S2 = "2 · Scout researches and returns findings";
ev(60, "agent.start", SCOUT, { parent: { toolUseId: "tu_scout" }, payload: { agentType: "researcher", label: "Scout dispatched: API conventions and storage limits", stage: S2 } });
tool(62, SCOUT, "WebSearch", "browse", "research", { dur: 6, label: "Scout searches for local-storage quota guidance", stage: S2 });
tool(70, SCOUT, "Read", "read", "research", { paths: ["docs/api-conventions.md"], dur: 5, label: "Scout reads the API conventions", stage: S2 });
tool(78, SCOUT, "Grep", "search", "research", { paths: ["src/store/schema.js"], dur: 3, label: "Scout traces the store schema", stage: S2, signature: "grep -n" });
tool(84, SCOUT, "Read", "read", "research", { paths: ["src/store/schema.js"], dur: 5, label: "Scout reads the schema", stage: S2 });
tool(93, SCOUT, "WebFetch", "browse", "research", { dur: 9, label: "Scout follows a lead that times out (dead end)", stage: S2, fail: true });
tool(106, SCOUT, "WebSearch", "browse", "research", { dur: 6, label: "Scout redirects: finds the pagination convention", stage: S2 });
tool(115, SCOUT, "Read", "read", "research", { paths: ["src/api/routes.js"], dur: 5, label: "Scout confirms route naming", stage: S2 });
tool(124, SCOUT, "Read", "read", "documentation", { paths: ["docs/testing.md"], dur: 6, label: "Scout reads the testing guide", stage: S2 });
tool(134, SCOUT, "Write", "create", "documentation", { paths: ["docs/research/saved-searches.md"], dur: 10, label: "Scout writes the findings note", stage: S2 });
ev(150, "agent.stop", SCOUT, { parent: { toolUseId: "tu_scout" }, payload: { label: "Scout returns findings to Forge", stage: S2 } });
tool(152, FORGE, "Read", "read", "planning", { paths: ["docs/research/saved-searches.md"], dur: 3, label: "Forge reads Scout's findings", stage: S2 });

const S3 = "3 · Smith begins implementation";
ev(157, "agent.start", SMITH, { parent: { toolUseId: "tu_smith" }, payload: { agentType: "implementer", label: "Smith dispatched with the plan and findings", stage: S3 } });
tool(159, SMITH, "Read", "read", "backend", { paths: ["src/store/index.js"], dur: 3, label: "Smith reads the store entry", stage: S3 });
tool(164, SMITH, "Read", "read", "api", { paths: ["src/api/routes.js"], dur: 3, label: "Smith reads the routes", stage: S3 });
tool(169, SMITH, "Read", "read", "frontend", { paths: ["src/ui/SearchBar.jsx"], dur: 3, label: "Smith reads the search bar", stage: S3 });

const S4 = "4 · Smith creates and modifies files";
tool(176, SMITH, "Write", "create", "backend", { paths: ["src/store/savedSearches.js"], dur: 9, label: "Smith creates the saved-searches store module", stage: S4 });
structure(186, SMITH, "saveSearch", "function", "src/store/savedSearches.js", S4);
structure(186, SMITH, "listSearches", "function", "src/store/savedSearches.js", S4);
tool(190, SMITH, "Edit", "edit", "backend", { paths: ["src/store/index.js"], dur: 4, label: "Smith registers the module in the store", stage: S4 });
tool(198, SMITH, "Write", "create", "api", { paths: ["src/api/savedSearches.js"], dur: 10, label: "Smith creates the API handlers", stage: S4 });
structure(209, SMITH, "handleSaveSearch", "function", "src/api/savedSearches.js", S4);
tool(212, SMITH, "Edit", "edit", "api", { paths: ["src/api/routes.js"], dur: 4, label: "Smith wires the new routes", stage: S4 });
tool(220, SMITH, "Edit", "edit", "frontend", { paths: ["src/ui/SearchBar.jsx"], dur: 6, label: "Smith adds the save control to the search bar", stage: S4 });
tool(230, SMITH, "Write", "create", "frontend", { paths: ["src/ui/SavedSearches.jsx"], dur: 11, label: "Smith creates the saved-searches panel", stage: S4 });
structure(242, SMITH, "SavedSearches", "function", "src/ui/SavedSearches.jsx", S4);
tool(246, SMITH, "Bash", "run", "tooling", { dur: 5, label: "Smith runs the linter", stage: S4, signature: "npm run lint" });
tool(255, SMITH, "Edit", "edit", "frontend", { paths: ["src/ui/SavedSearches.jsx"], dur: 4, label: "Smith fixes a lint warning", stage: S4 });
tool(263, SMITH, "Write", "create", "testing", { paths: ["test/savedSearches.test.js"], dur: 12, label: "Smith writes the store and API tests", stage: S4 });
structure(276, SMITH, "saves and lists a search", "test", "test/savedSearches.test.js", S4);

const S5 = "5 · Subagents assist with implementation and testing";
ev(282, "agent.start", HELPER, { parent: { toolUseId: "tu_helper", agentId: "smith-1" }, payload: { agentType: "implementer", label: "Smith delegates the UI tests to a helper", stage: S5 } });
tool(285, HELPER, "Read", "read", "frontend", { paths: ["src/ui/SavedSearches.jsx"], dur: 3, label: "Helper reads the panel", stage: S5 });
tool(291, HELPER, "Write", "create", "testing", { paths: ["test/ui.test.js"], dur: 10, label: "Helper writes the UI tests", stage: S5 });
structure(302, HELPER, "renders saved searches", "test", "test/ui.test.js", S5);
tool(305, HELPER, "Edit", "edit", "frontend", { paths: ["src/ui/SavedSearches.jsx"], dur: 4, label: "Helper adds a test id to the panel", stage: S5 });
ev(312, "agent.stop", HELPER, { parent: { toolUseId: "tu_helper", agentId: "smith-1" }, payload: { label: "Helper hands the UI tests back to Smith", stage: S5 } });
ev(315, "agent.start", TESTER, { parent: { toolUseId: "tu_tests", agentId: "smith-1" }, payload: { agentType: "test-runner", label: "Smith starts a test runner", stage: S5 } });

const S6 = "6 · A test fails";
tool(318, TESTER, "Bash", "test", "testing", { dur: 14, label: "Test runner executes the suite", stage: S6, signature: "npm test" });
ev(333, "test.run", TESTER, { source: "tests", payload: { framework: "node:test", passed: 41, failed: 2, skipped: 0, ok: false, label: "2 of 43 tests fail: saved search not persisted", stage: S6 }, classification: [cls("operation", "test", 1), cls("work-category", "testing", 0.9)], durationMs: 14000 });

const S7 = "7 · Smith diagnoses and fixes";
tool(338, SMITH, "Read", "read", "debugging", { paths: ["test/savedSearches.test.js"], dur: 4, label: "Smith reads the failing assertions", stage: S7, catConf: 0.85 });
tool(345, SMITH, "Grep", "search", "debugging", { paths: ["src/store/savedSearches.js"], dur: 3, label: "Smith searches for the persistence call", stage: S7, signature: "grep -n", catConf: 0.85 });
tool(351, SMITH, "Read", "read", "debugging", { paths: ["src/store/savedSearches.js"], dur: 5, label: "Smith finds the missing await", stage: S7, catConf: 0.85 });
tool(360, SMITH, "Edit", "edit", "backend", { paths: ["src/store/savedSearches.js"], dur: 5, label: "Smith fixes the persistence call", stage: S7 });
tool(369, SMITH, "Edit", "edit", "api", { paths: ["src/api/savedSearches.js"], dur: 4, label: "Smith returns the stored id from the handler", stage: S7 });

const S8 = "8 · Tests pass and verified structures stabilize";
tool(377, TESTER, "Bash", "test", "testing", { dur: 13, label: "Test runner re-executes the suite", stage: S8, signature: "npm test" });
ev(391, "test.run", TESTER, { source: "tests", payload: { framework: "node:test", passed: 43, failed: 0, skipped: 0, ok: true, label: "43 of 43 tests pass", stage: S8 }, classification: [cls("operation", "test", 1), cls("work-category", "testing", 0.9)], durationMs: 13000 });
ev(395, "agent.stop", TESTER, { parent: { toolUseId: "tu_tests", agentId: "smith-1" }, payload: { label: "Test runner reports back", stage: S8 } });
tool(398, SMITH, "Bash", "build", "tooling", { dur: 8, label: "Smith builds the app", stage: S8, signature: "npm run build" });
ev(410, "git.commit", SMITH, { source: "git", payload: { hash: "synthetic-0a1b2c", files: 7, insertions: 212, deletions: 9, label: "Smith commits the feature on its branch", stage: S8 }, classification: [cls("operation", "commit", 1)] });
ev(414, "agent.stop", SMITH, { parent: { toolUseId: "tu_smith" }, payload: { label: "Smith hands the branch back to Forge", stage: S8 } });

const S9 = "9 · Forge reviews the results";
tool(418, FORGE, "Read", "read", "planning", { paths: ["src/store/savedSearches.js"], dur: 6, label: "Forge reviews the store module", stage: S9 });
tool(427, FORGE, "Read", "read", "planning", { paths: ["src/api/savedSearches.js"], dur: 5, label: "Forge reviews the API handlers", stage: S9 });
tool(435, FORGE, "Read", "read", "security", { paths: ["src/api/routes.js"], dur: 5, label: "Forge checks input validation on the new routes", stage: S9, catConf: 0.7 });
tool(444, FORGE, "Read", "read", "frontend", { paths: ["src/ui/SavedSearches.jsx"], dur: 5, label: "Forge reviews the panel", stage: S9 });
tool(452, FORGE, "Bash", "test", "testing", { dur: 13, label: "Forge runs the full suite once more", stage: S9, signature: "npm test" });
ev(466, "test.run", FORGE, { source: "tests", payload: { framework: "node:test", passed: 43, failed: 0, skipped: 0, ok: true, label: "Independent verification: 43 of 43 pass", stage: S9 }, classification: [cls("operation", "test", 1), cls("work-category", "testing", 0.9)], durationMs: 13000 });
tool(470, FORGE, "Edit", "edit", "documentation", { paths: ["docs/CHANGELOG.md"], dur: 5, label: "Forge records the change", stage: S9 });

const S10 = "10 · Objective completed";
ev(480, "git.commit", FORGE, { source: "git", payload: { hash: "synthetic-3d4e5f", files: 1, insertions: 6, deletions: 0, label: "Forge commits the changelog", stage: S10 }, classification: [cls("operation", "commit", 1)] });
ev(486, "task.end", { type: "system" }, { source: "marks", task: TASK, payload: { label: "Objective completed: saved-searches feature built and verified", stage: S10 } });
ev(487, "turn.stop", FORGE, { payload: { label: "Forge reports completion", stage: S10 } });
ev(500, "session.end", { type: "system" }, { payload: { reason: "other", label: "Session ends", stage: S10 } });

fs.writeFileSync(out, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
const kinds = {}; for (const e of events) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
console.log(`wrote ${events.length} synthetic events (${((Date.parse(events.at(-1).ts) - Date.parse(events[0].ts)) / 60000).toFixed(1)} min) to ${path.relative(root, out)}`);
console.log(kinds);
