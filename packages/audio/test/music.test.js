import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import { projectCharacter, degreeToMidi, midiToHz, voiceFor, tempoFromPace, notesForEvent, MODES, MOTIFS, INSTRUMENTS } from "../src/music.js";

test("a project always gets the same key and mode; different projects usually differ", () => {
  const a = projectCharacter("demo-shop-app"), b = projectCharacter("demo-shop-app"), c = projectCharacter("sample-api");
  assert.deepEqual(a, b);
  assert.ok(Object.keys(MODES).includes(a.mode));
  assert.ok(a.root >= 48 && a.root < 60);
  assert.ok(a.root !== c.root || a.mode !== c.mode);
});

test("scale degrees wrap octaves inside the mode; frequencies are A440-based", () => {
  assert.equal(degreeToMidi(60, "ionian", 0), 60);
  assert.equal(degreeToMidi(60, "ionian", 7), 72, "degree 7 of a 7-note mode is the octave");
  assert.equal(degreeToMidi(60, "ionian", -1), 59);
  assert.equal(degreeToMidi(60, "pentatonic", 5), 72);
  assert.equal(Math.round(midiToHz(69)), 440);
});

test("voices: main thread leads, subagents take alternating registers with phase offsets", () => {
  assert.equal(voiceFor({ type: "main" }).register, 0);
  const a = voiceFor({ type: "subagent", agentId: "a", agentType: "implementer" }, 0), b = voiceFor({ type: "subagent", agentId: "b" }, 1);
  assert.ok(a.register > 0 && b.register < 0 && a.gainScale < 1 && a.phase !== 0);
});

test("tempo follows event pace within a musical band", () => {
  assert.equal(tempoFromPace([]), 72);
  assert.ok(tempoFromPace([1000, 1000, 1000]) >= 120);
  assert.equal(tempoFromPace([60000, 60000]), 56);
});

test("events map to notes: motif on task start, cadence on task end, dissonance on failure, nothing on agent stop cadence", () => {
  const ch = projectCharacter("demo");
  const ctx = { character: ch, tension: 0, agentIndex: 0, counter: 0 };
  const ev = (kind, extra = {}) => ({ kind, ts: "2026-11-08T12:00:00.000Z", actor: { type: "main" }, classification: [], ...extra });
  const start = notesForEvent(ev("task.start", { classification: [{ scheme: "work-category", value: "backend", confidence: 0.8 }] }), ctx);
  assert.equal(start.notes.length, MOTIFS.backend.length); assert.equal(start.instrument, "bass");
  const end = notesForEvent(ev("task.end"), ctx);
  assert.equal(end.notes.length, 4); assert.ok(end.tensionDelta < 0, "cadence resolves");
  const fail = notesForEvent(ev("test.run", { payload: { ok: false } }), ctx);
  assert.ok(fail.tensionDelta > 0 && fail.notes.length === 2);
  const pass = notesForEvent(ev("test.run", { payload: { ok: true } }), ctx);
  assert.ok(pass.tensionDelta < 0);
  const agentStop = notesForEvent(ev("agent.stop", { actor: { type: "subagent", agentId: "x" } }), { ...ctx, agentIndex: 1 });
  assert.equal(agentStop.notes.length, 1, "a subagent finishing is a single resolving tone, not a cadence");
  assert.equal(agentStop.tensionDelta, 0);
  const call = notesForEvent(ev("tool.call"), ctx);
  assert.equal(call.notes.length, 0, "sound on completion, not on call");
  const result = notesForEvent(ev("tool.result", { classification: [{ scheme: "operation", value: "edit", confidence: 0.9 }, { scheme: "work-category", value: "frontend", confidence: 0.6 }, { scheme: "code-structure", value: "loop", confidence: 0.9 }] }), ctx);
  assert.ok(result.notes.length >= 3, "edit pulse plus loop ornament");
  assert.equal(result.instrument, "pluck");
  for (const n of [...start.notes, ...result.notes]) { assert.ok(n.hz > 20 && n.hz < 8000); assert.ok(INSTRUMENTS[n.instrument]); }
});

test("the synthetic recording produces a coherent piece: every event is handled and tension stays bounded", () => {
  const events = fs.readFileSync(new URL("../../../demo/recordings/synthetic-multi-agent.events.jsonl", import.meta.url), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const ch = projectCharacter(events[0].session.project);
  let tension = 0, total = 0, voices = new Set();
  const agents = new Map();
  events.forEach((e, i) => {
    if (e.actor.type === "subagent" && !agents.has(e.actor.agentId)) agents.set(e.actor.agentId, agents.size);
    const d = notesForEvent(e, { character: ch, tension, agentIndex: agents.get(e.actor.agentId) || 0, counter: i });
    tension = Math.max(0, Math.min(1, tension + d.tensionDelta * 0.5));
    total += d.notes.length; voices.add(d.voice);
  });
  assert.ok(total > 50);
  assert.ok(voices.has("main") && voices.has("implementer") && voices.has("reviewer"));
  assert.ok(tension >= 0 && tension <= 1);
});
