// Tests for forge-music.js: the deterministic shared composition (ForgeScore) and the Node-safe ForgeSynth shell.
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import { ForgeScore, ForgeSynth, themeVariation, voiceForIdentity, pitchForPath } from "../src/forge-music.js";
import { FORGE_INSTRUMENTS } from "../src/forge-instruments.js";
import { MODES, projectCharacter } from "../src/music.js";

const base = JSON.parse(fs.readFileSync(new URL("../../forge/identities.json", import.meta.url), "utf8"));
const identities = base; // identities.json carries forge, smith, scout and core presets (instrument names are Forge instruments)
const noCore = { ...base, presets: Object.fromEntries(Object.entries(base.presets).filter(([k]) => k !== "core")) };
let n = 0;
const T0 = Date.parse("2026-11-08T14:00:00.000Z");
const ev = (kind, o = {}) => ({ id: `e${++n}`, ts: new Date(T0 + (o.at || 0)).toISOString(), kind, actor: o.actor || { type: "main" }, payload: o.payload, classification: o.cls, task: { id: "t1" } });
const sub = (id, type) => ({ type: "subagent", agentId: id, agentType: type });
const cat = (c, op = "edit") => [{ scheme: "work-category", value: c, confidence: 0.8 }, { scheme: "operation", value: op, confidence: 0.9 }];
const mk = (seed = "s1", ids = noCore) => new ForgeScore({ project: "demo-shop-app", identities: ids, seed });
const FORGE = { identity: "forge" }, SMITH = { identity: "smith", agentIndex: 1 }, SCOUT = { identity: "scout", agentIndex: 2 };
// Feed an event with the scene clock set from its offset.
// Smith and Scout identities act as subagents (the main thread is Forge) unless an actor is given.
const AUTO = { smith: sub("sm", "implementer"), scout: sub("sc", "scout") };
const fire = (s, kind, at, o = {}, ctx = {}) => s.onEvent(ev(kind, { at, ...o, actor: o.actor || AUTO[ctx.identity] }), { t: at / 1000, ...ctx });
const paths = (p) => ({ paths: [p] });
const pitchClass = (hz) => ((Math.round(69 + 12 * Math.log2(hz / 440)) % 12) + 12) % 12;
const maxStep = (a, b) => Math.max(...a.map((m, i) => Math.abs(m - b[i])));

function sequence(score) {
  const out = [];
  out.push(fire(score, "task.start", 0, {}, { ...FORGE, nodeId: 1 }));
  out.push(fire(score, "agent.start", 500, { actor: sub("a1", "scout") }, SCOUT));
  for (let i = 0; i < 20; i++) {
    out.push(fire(score, "tool.result", 1000 + i * 700, { cls: cat("backend"), payload: paths(`src/f${i % 5}.js`) }, { ...SMITH, nodeId: i, verified: i % 3 === 0 }));
    score.setState({ verifiedFraction: i / 20, tension: 0.1, agents: [{ id: "main", identity: "forge", active: true, docked: false }], phase: "execute" });
    out.push(score.tick(1 + i * 0.7));
  }
  out.push(fire(score, "test.run", 16000, { payload: { ok: false } }, SMITH));
  out.push(fire(score, "test.run", 18000, { payload: { ok: true } }, SMITH));
  score.setState({ verifiedFraction: 1, resolved: true });
  out.push(score.tick(20));
  return out;
}

test("(a) determinism: same seed, events and setState give identical notes and state; seeds differ", () => {
  n = 0; const a = mk("alpha"), ra = sequence(a);
  n = 0; const b = mk("alpha"), rb = sequence(b);
  assert.deepEqual(ra, rb);
  assert.deepEqual(a.state(), b.state());
  const themes = new Set(["alpha", "beta", "gamma", "delta"].map((s) => fire(mk(s), "task.start", 0, {}, FORGE).theme.join(",")));
  assert.ok(themes.size > 1, "different seeds should give different themes");
});

test("(b) task.start yields a 6-8 degree theme, the theme phase, a drone, and shared chord state", () => {
  for (const s of ["a", "b", "c", "d", "e", "f"]) {
    const sc = mk(s), r = fire(sc, "task.start", 0, {}, FORGE);
    assert.ok(r.theme.length >= 6 && r.theme.length <= 8, `theme length ${r.theme.length}`);
    assert.equal(r.phase, "theme"); assert.ok(r.theme.every(Number.isInteger));
    assert.ok(r.notes.filter((x) => x.instrument === "additivePad").length >= 3 && r.notes.every((x) => x.instrument === "additivePad" || x.instrument === "coreSine"));
    assert.ok(r.notes.every((x) => x.time >= 0 && x.time < 0.5), "the drone starts on the first free slot");
    assert.ok(r.chord && r.chord.pcs.length === 3);
  }
});

test("(c) grid: every note lands on a 16th slot; bpm changes only at bar lines and stays in 60-112", () => {
  const s = mk("grid"), notes = [];
  notes.push(...fire(s, "task.start", 0, {}, FORGE).notes);
  let at = 200;
  for (let i = 0; i < 90; i++) { // fast burst, then a slow stretch, so the pace-driven tempo has to move
    at += i < 45 ? 180 : 3500;
    notes.push(...fire(s, "tool.result", at, { cls: cat("backend", "edit"), payload: paths(`a${i % 7}.js`) }, i % 2 ? SMITH : { ...SCOUT }).notes);
    notes.push(...s.tick(at / 1000));
  }
  assert.ok(notes.length > 40);
  for (const x of notes) {
    const info = s.barInfo(x.bar);
    assert.ok(Number.isInteger(x.sixteenth) && x.sixteenth >= 0 && x.sixteenth < 16);
    assert.equal(x.time, info.start + x.sixteenth * (15 / info.bpm), `note ${x.id} off grid`);
    assert.equal(x.bpm, info.bpm);
  }
  const bpms = new Set();
  let prev = null;
  for (let t = 0; t <= s.lastT; t += 0.05) {
    const g = s.grid(t); bpms.add(g.bpm);
    assert.ok(g.bpm >= 60 && g.bpm <= 112 && g.sixteenth >= 0 && g.sixteenth < 16 && g.beat >= 0 && g.beat < 4 && g.nextSlotTime >= t - 1e-9);
    if (prev && prev.bpm !== g.bpm) assert.ok(g.bar > prev.bar && g.sixteenth <= 1, "bpm changed inside a bar");
    prev = g;
  }
  assert.ok(bpms.size > 1, `tempo never moved: ${[...bpms]}`);
  const g0 = s.grid(5.01); assert.ok(g0.nextSlotTime >= 5.01 && g0.nextSlotTime - 5.01 < 15 / g0.bpm + 1e-9);
});

test("(d) pitchForPath is stable, in a 2-octave range, and shared by every voice", () => {
  const ch = projectCharacter("demo-shop-app"), nDeg = MODES[ch.mode].length;
  assert.equal(pitchForPath("src/app.js", ch), pitchForPath("src/app.js", ch));
  const seen = new Set();
  for (let i = 0; i < 60; i++) { const d = pitchForPath(`src/file${i}.js`, ch); assert.ok(Number.isInteger(d) && d >= 0 && d < 2 * nDeg); seen.add(d); }
  assert.ok(seen.size > 4);
  const s = mk("fp"); fire(s, "task.start", 0, {}, FORGE);
  s.onEvent(ev("agent.start", { at: 100, actor: sub("a1", "scout") }), { t: 0.1, ...SCOUT });
  const p = "src/shared.js";
  const smith = fire(s, "tool.result", 8000, { cls: cat("backend", "edit"), payload: paths(p) }, SMITH).notes.find((x) => x.role === "rhythm");
  const scout = fire(s, "tool.result", 9000, { actor: sub("a1", "scout"), cls: cat("research", "read"), payload: paths(p) }, SCOUT).notes.find((x) => x.role === "motif");
  assert.ok(smith && scout);
  assert.ok(Math.abs(smith.hz - scout.hz) < 1e-9, "same file, same pitch for Smith and Scout");
  assert.equal(s.state().filePitches[p], pitchForPath(p, s.character));
  fire(s, "tool.failure", 10000, { payload: paths("src/boom.js") }, SMITH);
  assert.ok("src/boom.js" in s.state().filePitches);
});

test("(e) Smith rings longer and beats when material is unverified, short and clean when verified", () => {
  const hit = (verified) => { const s = mk("sm"); fire(s, "task.start", 0, {}, FORGE); return fire(s, "tool.result", 5000, { cls: cat("backend", "edit"), payload: paths("x.js") }, { ...SMITH, verified }).notes.find((x) => x.role === "rhythm"); };
  const u = hit(false), v = hit(true), d = hit(undefined);
  assert.ok(u.durationSec > v.durationSec * 2, `${u.durationSec} vs ${v.durationSec}`);
  assert.ok(u.detuneCents > 0 && v.detuneCents === 0 && u.verified === false && v.verified === true);
  assert.equal(d.durationSec, u.durationSec); // default is unverified
  assert.equal(u.partials.length, 4); assert.ok(u.partials.every((r, i) => r === [1, 2.32, 3.73, 5.01][i]));
  assert.equal(u.instrument, "metalStrike");
});

test("(f) Smith plays at most one note per slot and stays under the per-bar budget", () => {
  const s = mk("pat"); fire(s, "task.start", 0, {}, FORGE);
  s.onEvent(ev("agent.start", { at: 100, actor: sub("a2", "implementer") }), { t: 0.1, identity: "smith", agentIndex: 1 });
  const smiths = [];
  for (let i = 0; i < 60; i++) {
    smiths.push(...fire(s, "tool.result", 1000 + i * 40, { cls: cat("backend", "edit") }, SMITH).notes, ...fire(s, "tool.result", 1020 + i * 40, { actor: sub("a2", "implementer"), cls: cat("backend", "edit") }, { identity: "smith", agentIndex: 1 }).notes);
  }
  const hits = smiths.filter((x) => x.role === "rhythm"), keys = hits.map((x) => `${x.bar}:${x.sixteenth}`);
  assert.equal(new Set(keys).size, keys.length, "two Smith notes shared a slot");
  const perBar = new Map(); for (const h of hits) perBar.set(h.bar, (perBar.get(h.bar) || 0) + 1);
  assert.ok(Math.max(...perBar.values()) <= 8);
});

test("(g) Scout glides from its previous pitch (60-120 ms); a dead end glides down and fades", () => {
  const s = mk("sc"); fire(s, "task.start", 0, {}, FORGE);
  s.onEvent(ev("agent.start", { at: 100, actor: sub("a1", "scout") }), { t: 0.1, ...SCOUT });
  const a = fire(s, "tool.result", 6000, { actor: sub("a1", "scout"), cls: cat("research", "read"), payload: paths("one.js") }, SCOUT).notes.find((x) => x.role === "motif");
  const b = fire(s, "tool.result", 9000, { actor: sub("a1", "scout"), cls: cat("research", "read"), payload: paths("two.js") }, SCOUT).notes.find((x) => x.role === "motif");
  assert.ok(a && b);
  assert.ok(Math.abs(b.glideFromHz - a.hz) < 1e-9 && b.glideSec >= 0.06 && b.glideSec <= 0.12, `glide ${b.glideFromHz} ${b.glideSec}`);
  assert.equal(b.instrument, "glideFlute");
  const d = fire(s, "tool.failure", 12000, { actor: sub("a1", "scout"), payload: paths("three.js") }, SCOUT).notes.find((x) => x.deadEnd);
  assert.ok(d && d.glideFromHz && d.hz < d.glideFromHz && d.fade === true);
  // a search without follow-up dead-ends on a later tick
  const s2 = mk("sc2"); fire(s2, "task.start", 0, {}, FORGE);
  s2.onEvent(ev("agent.start", { at: 100, actor: sub("a1", "scout") }), { t: 0.1, ...SCOUT });
  fire(s2, "tool.result", 4000, { actor: sub("a1", "scout"), cls: cat("research", "search") }, SCOUT);
  const late = s2.tick(30);
  assert.ok(late.some((x) => x.deadEnd && x.hz < x.glideFromHz));
});

test("(h) discovery lands on a chord tone for 2 beats and Forge adds the tone to the drone", () => {
  const s = mk("disc"); fire(s, "task.start", 0, {}, FORGE);
  s.onEvent(ev("agent.start", { at: 100, actor: sub("a1", "scout") }), { t: 0.1, ...SCOUT });
  s.onEvent(ev("agent.start", { at: 200, actor: sub("a2", "implementer") }), { t: 0.2, identity: "smith", agentIndex: 2 });
  const before = s.state().droneTones.length, p = "lib/found.js";
  fire(s, "tool.result", 8000, { actor: sub("a1", "scout"), cls: cat("research", "read"), payload: paths(p) }, SCOUT);
  const r = fire(s, "tool.result", 12000, { actor: sub("a2", "implementer"), cls: cat("backend", "edit"), payload: paths(p) }, { identity: "smith", agentIndex: 2 });
  const land = r.notes.find((x) => x.discovery);
  assert.ok(land, "no landing note");
  assert.ok(r.chord.pcs.includes(pitchClass(land.hz)), "landing is not a chord tone");
  assert.ok(Math.abs(land.durationSec - 2 * 60 / land.bpm) < 1e-9);
  assert.equal(land.voice, "a1");
  assert.ok(s.state().droneTones.length > before);
  assert.ok(r.notes.some((x) => x.instrument === "additivePad"), "drone tone note missing");
  // explicit ctx.discovery
  const s2 = mk("disc2"); fire(s2, "task.start", 0, {}, FORGE);
  s2.onEvent(ev("agent.start", { at: 100, actor: sub("a1", "scout") }), { t: 0.1, ...SCOUT });
  const b2 = s2.state().droneTones.length;
  const r2 = fire(s2, "tool.result", 5000, { actor: sub("a1", "scout"), cls: cat("research", "read") }, { ...SCOUT, discovery: true });
  assert.ok(r2.notes.some((x) => x.discovery) && s2.state().droneTones.length > b2);
});

test("(i) chord changes are structural and voice-led: held tones move by at most 5 semitones", () => {
  const s = mk("vl"); fire(s, "task.start", 0, {}, FORGE);
  const seen = [s.state()], tonesPerChange = [];
  let at = 0;
  for (let i = 0; i < 6; i++) {
    at += 20000; // many bars apart, so the 2-bar structural gate is open
    const before = s.state().droneTones, idx = s.state().chord.index;
    const r = s.onEvent(ev("agent.start", { at, actor: sub(`v${i}`, "scout") }), { t: at / 1000, ...SCOUT });
    const after = s.state();
    assert.notEqual(after.chord.index, idx, "agent.start should advance the chord");
    assert.equal(after.droneTones.length, before.length);
    assert.ok(maxStep(before, after.droneTones) <= 5, `jump ${before} -> ${after.droneTones}`);
    assert.ok(after.chord.pcs.every((pc) => after.droneTones.some((m) => m % 12 === pc)), "chord tone missing from the voicing");
    assert.ok(r.notes.some((x) => x.instrument === "additivePad"));
    tonesPerChange.push(after.droneTones.join(","));
  }
  assert.ok(new Set(tonesPerChange).size > 2);
  // non-structural events never move the chord; a 2-bar gate protects against rapid structural bursts
  const s2 = mk("gate"); fire(s2, "task.start", 0, {}, FORGE);
  const i0 = s2.state().chord.index;
  for (let i = 0; i < 20; i++) fire(s2, "tool.result", 500 + i * 200, { cls: cat("backend") }, SMITH);
  assert.equal(s2.state().chord.index, i0);
  fire(s2, "agent.start", 5000, { actor: sub("g1", "scout") }, SCOUT);
  const i1 = s2.state().chord.index;
  fire(s2, "agent.start", 5200, { actor: sub("g2", "scout") }, SCOUT);
  assert.equal(s2.state().chord.index, i1);
});

test("(j) verifiedFraction opens the drone brightness and raises the core gain", () => {
  const s = mk("br", identities); fire(s, "task.start", 0, {}, FORGE);
  s.setState({ verifiedFraction: 0 }); const lo = s.state();
  s.setState({ verifiedFraction: 0.9 }); const hi = s.state();
  assert.ok(hi.droneBrightness > lo.droneBrightness + 0.5 && hi.coreGain > lo.coreGain);
  const notes = s.tick(20), pads = notes.filter((x) => x.instrument === "additivePad"), core = notes.filter((x) => x.instrument === "coreSine");
  assert.ok(pads.length >= 3 && pads.every((x) => Math.abs(x.brightness - hi.droneBrightness) < 1e-9));
  assert.ok(core.length === 1 && core[0].gain === hi.coreGain && core[0].gain < 0.1);
  assert.ok(Math.abs(core[0].hz - 440 * Math.pow(2, (s.character.root - 12 - 69) / 12)) < 1e-6);
  // core is silent when no task is open
  const idle = mk("idle", identities); idle.setState({ verifiedFraction: 1 });
  assert.deepEqual(idle.tick(5), []);
});

test("(k) failures raise tension; passing tests lower it with a quench figure and pull the chord to the tonic", () => {
  const s = mk("tn"); fire(s, "task.start", 0, {}, FORGE);
  fire(s, "agent.start", 30000, { actor: sub("a1", "scout") }, SCOUT); // move off the tonic
  assert.notEqual(s.state().chord.index, 0);
  const f = fire(s, "test.run", 40000, { payload: { ok: false } }, SMITH);
  assert.ok(f.tensionDelta > 0 && s.state().tension > 0);
  const hi = s.state().tension;
  const p = fire(s, "test.run", 42000, { payload: { ok: true } }, SMITH);
  assert.ok(p.tensionDelta < 0 && s.state().tension < hi);
  assert.equal(p.phase, "resolution"); assert.equal(s.state().chord.index, 0);
  const q = p.notes.find((x) => x.instrument === "quenchNoise"), dyad = p.notes.filter((x) => x.consonant);
  assert.ok(q && q.sweepFromHz > q.sweepToHz);
  assert.equal(dyad.length, 2); assert.ok(Math.abs(dyad[1].hz / dyad[0].hz - Math.pow(2, 7 / 12)) < 1e-6);
  assert.ok(fire(s, "tool.failure", 44000, {}, SMITH).tensionDelta > 0);
  // setState drives tension from the composer
  s.setState({ tension: 0.9 }); assert.equal(s.state().tension, 0.9);
});

test("(l) resolved triggers the closing once, then the score is ended and silent until a new task.start", () => {
  const s = mk("cl", identities);
  fire(s, "task.start", 0, {}, FORGE);
  fire(s, "agent.start", 500, { actor: sub("a1", "implementer") }, { identity: "smith", agentIndex: 1 });
  fire(s, "agent.start", 900, { actor: sub("a2", "scout") }, { identity: "scout", agentIndex: 2 });
  s.setState({ verifiedFraction: 1, resolved: true, agents: [{ id: "main", identity: "forge", active: true }, { id: "a1", identity: "smith", active: true }, { id: "a2", identity: "scout", active: true }] });
  const closing = s.tick(6);
  assert.ok(closing.length > 8);
  const voices = new Set(closing.map((x) => x.voice));
  assert.ok(voices.has("a1") && voices.has("a2"), "every active voice takes part");
  const lead = closing.filter((x) => x.closing && x.degree != null).map((x) => x.degree);
  assert.deepEqual(lead, s.state().theme, "the theme is restated");
  const drone = closing.filter((x) => x.instrument === "additivePad" && x.decay);
  assert.ok(drone.length >= 3 && drone.every((x) => x.durationSec - x.holdSec <= 8 * 60 / x.bpm + 1e-9));
  assert.equal(s.state().ended, true); assert.equal(s.state().phase, "ended");
  assert.deepEqual(s.tick(7), []); assert.deepEqual(s.tick(60), []);
  const after = fire(s, "tool.result", 9000, { cls: cat("backend") }, SMITH);
  assert.equal(after.notes.length, 0); assert.equal(after.phase, "ended");
  s.setState({ resolved: false });
  assert.ok(fire(s, "task.start", 20000, {}, FORGE).notes.length > 0, "new task.start restarts");
  assert.equal(s.state().ended, false);
  // task.end converges too
  const e = mk("end"); fire(e, "task.start", 0, {}, FORGE);
  const r = fire(e, "task.end", 4000, {}, FORGE);
  assert.equal(r.phase, "closing"); assert.ok(r.notes.length > 4); assert.equal(e.state().ended, true);
});

test("(m) agent.stop yields no cadence, only a releaseVoice instruction", () => {
  const s = mk(); fire(s, "task.start", 0, {}, FORGE);
  fire(s, "agent.start", 500, { actor: sub("a1", "scout") }, SCOUT);
  const r = fire(s, "agent.stop", 4000, { actor: sub("a1", "scout") }, SCOUT);
  assert.equal(r.notes.length, 0);
  assert.deepEqual(r.instructions, [{ releaseVoice: "a1" }]);
  assert.equal(s.state().ended, false); assert.equal(s.state().voices.find((v) => v.id === "a1").active, false);
});

test("(n) voice cap: a dense 200-event burst never exceeds 10 voices or 3 per agent", () => {
  const s = mk("dense", identities); fire(s, "task.start", 0, {}, FORGE);
  const ids = ["a1", "a2", "a3"], all = [], steals = [];
  ids.forEach((id, i) => fire(s, "agent.start", 100 + i * 10, { actor: sub(id, i === 2 ? "scout" : "implementer") }, { identity: i === 2 ? "scout" : "smith", agentIndex: i + 1 }));
  for (let i = 0; i < 200; i++) {
    const k = i % 3, r = fire(s, "tool.result", 1000 + i * 90, { actor: sub(ids[k], "x"), cls: cat("backend", i % 5 ? "edit" : "create"), payload: i % 2 ? paths(`d${i % 9}.js`) : undefined }, { identity: k === 2 ? "scout" : "smith", agentIndex: k + 1, verified: false });
    all.push(...r.notes); steals.push(...r.instructions.filter((x) => x.stealVoice));
  }
  const arts = all.filter((x) => x.role === "rhythm" || x.role === "motif");
  assert.ok(arts.length > 40);
  const end = new Map(arts.map((x) => [x.id, x.time + x.durationSec]));
  for (const st of steals) end.set(st.stealVoice, Math.min(end.get(st.stealVoice), st.at));
  const peak = (filter) => { let m = 0; for (const a of arts.filter(filter)) { const c = arts.filter((b) => filter(b) && b.time <= a.time && end.get(b.id) > a.time).length; m = Math.max(m, c); } return m; };
  assert.ok(peak(() => true) + 2 <= 10, `peak ${peak(() => true)}`);
  for (const id of ids) assert.ok(peak((x) => x.voice === id) <= 3, `agent ${id}`);
  assert.ok(s.state().maxVoices <= 10 && s.state().maxPerAgent <= 3);
});

test("(o) fatigue: the per-minute budget shrinks over 30 minutes of event time and floors at 0.4", () => {
  const s = mk("fat"); fire(s, "task.start", 0, {}, FORGE);
  const minuteNotes = (startSec) => { let c = 0; for (let i = 0; i < 300; i++) c += fire(s, "tool.result", (startSec + i * 0.2) * 1000, { cls: cat("backend", "edit"), payload: paths(`m${i % 11}.js`) }, i % 2 ? SMITH : SCOUT).notes.filter((x) => x.role === "rhythm" || x.role === "motif").length; return c; };
  s.onEvent(ev("agent.start", { at: 50, actor: sub("a1", "scout") }), { t: 0.05, ...SCOUT });
  const b0 = s.state().budgetPerMinute, early = minuteNotes(1);
  fire(s, "agent.start", 1800000, { actor: sub("a9", "scout") }, SCOUT);
  const late = minuteNotes(1800 + 1), b30 = s.state().budgetPerMinute;
  assert.ok(b30 < b0 * 0.7 && b30 >= Math.round(b0 * 0.4), `${b0} -> ${b30}`);
  assert.ok(late < early, `articulations ${early} -> ${late}`);
  fire(s, "tool.result", 100000 * 1000, { cls: cat("backend") }, SMITH);
  assert.equal(s.state().fatigue, 0.4);
});

test("(p) silence is a state: after 2 bars only drone and core remain, and the drone fades 3 dB per bar", () => {
  const s = mk("sil", identities); fire(s, "task.start", 0, {}, FORGE);
  const barSec = 240 / s.state().bpm, gains = [];
  fire(s, "tool.result", 1000, { cls: cat("backend") }, SMITH);
  const ids = new Set();
  for (let t = 2; t < 2 + barSec * 12; t += 0.25) for (const x of s.tick(t)) { ids.add(x.instrument); if (x.instrument === "additivePad" && x.hz === s.state().droneTones.map((m) => 440 * Math.pow(2, (m - 69) / 12))[0]) gains.push({ t: x.time, g: x.gain }); }
  assert.deepEqual([...ids].sort(), ["additivePad", "coreSine"]);
  assert.ok(gains.length >= 5);
  const first = gains[0].g, later = gains[gains.length - 1].g;
  assert.ok(later < first * 0.5, `drone did not decay ${first} -> ${later}`);
  const steps = gains.map((x, i) => (i ? 20 * Math.log10(x.g / gains[i - 1].g) : 0)).filter((d) => d < -0.1);
  assert.ok(steps.every((d) => Math.abs(d + 3) < 0.2), `steps ${steps}`);
  assert.ok(s.state().silent);
  fire(s, "tool.result", 200000, { cls: cat("backend") }, SMITH);
  assert.equal(s.state().silent, false); assert.equal(s.state().droneDb, 0);
});

test("(q) ducking instructions are 6-9 dB and recover over one bar", () => {
  const s = mk("duck"); fire(s, "task.start", 0, {}, FORGE);
  const r = fire(s, "tool.result", 3000, { cls: cat("backend", "edit"), payload: paths("d.js") }, SMITH);
  const d = r.instructions.find((x) => x.duck);
  assert.ok(d && d.duck.db >= 6 && d.duck.db <= 9 && Math.abs(d.duck.recoverSec - 240 / r.bpm) < 0.5);
  assert.ok(s.duckAt(d.duck.at) >= 6 && s.duckAt(d.duck.at + d.duck.recoverSec + 0.1) === 0);
});

test("(r) identity voices: roles choose instruments; presets keep their legacy instrument name", () => {
  const f = voiceForIdentity(base.presets.forge, 0), sm = voiceForIdentity(base.presets.smith, 0), sc = voiceForIdentity(base.presets.scout, 1);
  assert.deepEqual([f.synthInstrument, sm.synthInstrument, sc.synthInstrument], ["additivePad", "metalStrike", "glideFlute"]);
  assert.equal(f.instrument, "additivePad"); assert.equal(voiceForIdentity({ music: { instrument: "pad", register: 0, role: "motif" } }, 0).synthInstrument, "glideFlute");
  assert.equal(voiceForIdentity(identities.presets.core, 0).synthInstrument, "coreSine");
  const th = [0, 2, 4, 5]; assert.deepEqual(themeVariation(th, 0), th); assert.deepEqual(themeVariation(th, 3), [5, 4, 2, 0]);
});

test("(s) every note carries ref.eventId and a finite pitch (except noise)", () => {
  n = 0; const all = sequence(mk()).flatMap((r) => (Array.isArray(r) ? r : r.notes));
  assert.ok(all.length > 30);
  assert.ok(all.every((x) => typeof x.ref.eventId === "string" && x.ref.eventId.length > 0 && Number.isFinite(x.hz) && Number.isFinite(x.time) && Number.isFinite(x.durationSec) && "glideFromHz" in x && x.identity && x.voice && x.instrument));
  assert.ok(all.some((x) => x.ref.path), "file refs are carried");
});

test("tempo clamps to 60-112 and turn.stop (main only) advances the harmony", () => {
  const s = mk(); fire(s, "task.start", 0, {}, FORGE);
  for (let i = 1; i < 60; i++) fire(s, "notification", 5000 + i * 50, {}, FORGE);
  assert.ok(s.state().bpm <= 112 && s.state().bpm >= 60);
  const c0 = s.state().chord.index;
  fire(s, "turn.stop", 60000, {}, FORGE);
  assert.notEqual(s.state().chord.index, c0);
  const sub1 = fire(s, "turn.stop", 90000, { actor: sub("a1", "scout") }, SCOUT);
  assert.equal(sub1.notes.length, 0);
});

test("instruments schedule against a stub AudioContext without throwing", () => {
  const log = [];
  const node = () => new Proxy(function () {}, { get: (t, k) => (k === "connect" ? (d) => d : k === "getChannelData" ? () => new Float32Array(64) : k in t ? t[k] : (t[k] = typeof k === "string" && /^(start|stop|set|linear|exponential|cancel)/.test(k) ? (...a) => { log.push(k); } : node())), set: (t, k, v) => { t[k] = v; return true; } });
  const ctx = new Proxy({ currentTime: 1, sampleRate: 8000 }, { get: (t, k) => (k in t ? t[k] : String(k).startsWith("create") ? () => node() : undefined) });
  const dest = node();
  const notes = { additivePad: { hz: 110, durationSec: 4, gain: 0.07, brightness: 0.8 }, metalStrike: { hz: 220, durationSec: 0.4, gain: 0.2, detuneCents: 7 }, glideFlute: { hz: 440, glideFromHz: 392, glideSec: 0.08, durationSec: 1, gain: 0.2 }, coreSine: { hz: 55, durationSec: 4, gain: 0.02 }, quenchNoise: { hz: 0, durationSec: 0.7, gain: 0.1 } };
  for (const [name, fn] of Object.entries(FORGE_INSTRUMENTS)) { fn(ctx, dest, notes[name], { when: 1.2 }); fn(ctx, dest, { ...notes[name], decay: true, holdSec: 1, fade: true }, {}); }
  assert.equal(Object.keys(FORGE_INSTRUMENTS).length, 5); assert.ok(log.length > 40);
});

test("ForgeSynth imports in Node, maps scene time to audio time, and stays silent without enable()", () => {
  assert.equal(typeof globalThis.AudioContext, "undefined");
  const f = new ForgeSynth({ project: "demo-shop-app", identities, seed: "x" });
  const r = f.onEvent(ev("task.start"), { ...FORGE, t: 10 });
  assert.ok(r.notes.length > 0); assert.equal(f.queue.length, 0); assert.equal(f.enabled, false);
  assert.ok(Array.isArray(f.tick(11)));
  assert.equal(f.audioTimeFor(12.5), 12.5);
  f.anchorClock(100, 5); assert.equal(f.audioTimeFor(102.5), 7.5);
  f.setState({ verifiedFraction: 0.5, tension: 0.2 }); assert.equal(f.score.state().verifiedFraction, 0.5);
  f.setSeed("y"); assert.equal(f.score.seed, "y");
});
