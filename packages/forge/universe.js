// Alexandria Resonance — "As above, so below" demonstration page.
// Presentation only: feeds a recording through the Replayer into the Universe engine, lets the CameraDirector
// choose the view, styles the engine's state into a frame (lines, membranes, points, rings) and hands it to the
// WebGL renderer. The optional music reads the same engine state. Nothing here decides geometry.
import { Replayer } from "../event-engine/src/replay.js";
import { Camera } from "../geometry/src/projection.js";
import { FrameBuilder, hslToRgb } from "./src/frame.js";
import { GLRenderer } from "./src/render-gl.js";
import { Universe } from "./src/universe.js";
import { CameraDirector } from "./src/director.js";
import { mixHue } from "./src/ripples.js";
import { LiveWorlds } from "../live/src/worlds.js";
import { LiveAdapter, universeConfig } from "../live/src/adapter.js";

const $ = (id) => document.getElementById(id);
const canvas = $("cv");
const params = new URLSearchParams(location.search);
const RECORDING = params.get("recording") || "forge-demo-session.events.jsonl";
const [mapping, identities] = await Promise.all([fetch("forge-mapping.json", { cache: "no-store" }).then((r) => r.json()), fetch("identities.json", { cache: "no-store" }).then((r) => r.json())]);

const prefersReduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const ui = { director: true, faces: true, links: true, bloom: true, reduced: prefersReduced, autoGallery: true, mode: "live", hidden: new Set() };
$("reduced").checked = ui.reduced;

const gl = new GLRenderer(canvas, { background: "#04050a", bloom: true });
if (!gl.available) $("nogl").hidden = false;
const fb = new FrameBuilder({ maxLines: 80000, maxTriangles: 60000, maxPoints: 20000 });
const camera = new Camera({ azimuth: 0.6, elevation: 0.06, distance: 7.5, fov: 0.85, target: [0, 0.4, 0] });
let director = new CameraDirector({ reduced: ui.reduced });
let universe = new Universe({ mapping, identities });
let replayer = null, events = [];
let sceneClock = 0, lastFrame = performance.now(), fps = 60, slowFrames = 0;
let selected = null, lastScreens = [], galleryEntered = null, lastExtent = { radius: 3, yMin: -1, yMax: 1 }, lastExtentAt = 0, frameState = null;
let synth = null, musicOn = false, lastMusic = null, musicMod = null;
let agentIndex = new Map();

// ---------- source (live | replay), privacy, naming ----------
const DORMANT_TEXT = "Dormant: no activity for 20 min. Resumes when the session continues.";
const SIDE_NOTE_DEMO = "Every structure is traceable to a labelled synthetic event. Artistic interpretation of observed activity, not a depiction of thought. All data stays local.";
const SIDE_NOTE_REAL = SIDE_NOTE_DEMO.replace("labelled synthetic event", "labelled event");
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable: the setting just does not persist */ } } };
let privacy = store.get("resonance.privacy") === "1";
let source = "replay";                    // what feeds the artwork: "live" Claude Code activity or a "replay"
let replayConfig = { page: "universe" };  // Universe config for the replay in progress (demo recordings stay exactly as before)
let replaySession = null;                 // { id, project } while a real session is replayed
let savedReplay = null;                   // replay state parked while the live source is shown
let sessionList = [], lastObj = null;
let worlds = null, focusedId = null, liveEs = null, feedUp = false, helloWaiters = [];
const pageWorlds = new Map();             // sessionId -> { director, agentIndex, last }: page-side state per world
const arrivals = [];                      // { t, n } wall-clock arrivals of live batches, for the event rate
let placeholder = null, placeholderDirector = null;
let lastElect = 0, lastUi = 0, uiDirty = false, dormantShown = false, adaptive = 300;
const aliases = new Map();
const folderOf = (p) => String(p).split(/[\/]/).filter(Boolean).pop() || String(p);
function aliasOf(key) {
  if (!aliases.has(key)) aliases.set(key, aliases.size);
  const n = aliases.get(key);
  return n < 26 ? `Session ${String.fromCharCode(65 + n)}` : `Session ${n + 1}`;
}
// The only way a session or project is ever named on screen: the project folder, or a stable alias in privacy mode.
// Several sessions in one project are numbered by first appearance ("alexandria-visualizer · 2").
const projectSessions = new Map(), nameOfSession = new Map();
function displayName(id, project) {
  if (privacy || !project) return aliasOf(id);
  const name = folderOf(project), prev = nameOfSession.get(id);
  if (prev !== name) { if (prev) projectSessions.set(prev, (projectSessions.get(prev) || []).filter((x) => x !== id)); nameOfSession.set(id, name); } // a session whose main folder changed leaves its old name's numbering
  if (!projectSessions.has(name)) projectSessions.set(name, []);
  const ids = projectSessions.get(name); if (!ids.includes(id)) ids.push(id);
  return ids.length > 1 ? `${name} · ${ids.indexOf(id) + 1}` : name;
}
function currentRef() {
  if (source === "live") { const w = worlds && focusedId != null ? worlds.world(focusedId) : null; return { id: focusedId, project: w?.project ?? null, real: true }; }
  if (replaySession) return { id: replaySession.id, project: replaySession.project, real: true };
  return { id: "recording", project: universe.project || "demo", real: false };
}
function currentName() { const r = currentRef(); return r.id == null ? "" : displayName(r.id, r.project); }
const isReal = () => currentRef().real;
const eventCount = () => (source === "live" ? worlds?.world(focusedId)?.events.length ?? 0 : events.length);
function pageWorld(id) {
  let p = pageWorlds.get(id);
  if (!p) pageWorlds.set(id, p = { director: new CameraDirector({ reduced: ui.reduced }), agentIndex: new Map(), last: null });
  return p;
}
const focusedDormant = () => source === "live" && focusedId != null && !!worlds && worlds.dormant(focusedId, Date.now());

// ---------- loading and replay ----------
const parseJsonl = (t) => t.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e && e.kind && e.ts);
function newUniverse(config = replayConfig) { universe = new Universe({ mapping, identities, events, config }); agentIndex.clear(); director = new CameraDirector({ reduced: ui.reduced }); if (synth) { synth.opts.project = currentName() || "demo"; synth.setSeed?.(universe.fingerprint); } }
async function load() {
  const res = await fetch("/demo/recordings/" + RECORDING, { cache: "no-store" });
  if (!res.ok) { $("stage").textContent = privacy ? "Recording not found" : "Recording not found: " + RECORDING; return; }
  events = parseJsonl(await res.text());
  replaySession = null; $("realSessions").value = "";
  restart({ page: "universe" });
}
// Replay of a real session: the collector's events go through a fresh LiveAdapter (objective, phases, stretches, commits),
// then the existing Replayer path plays the output, with the same Universe config live mode uses for that session.
async function loadSession(id) {
  $("stage").textContent = "Loading session…";
  let raw;
  try { const r = await fetch("/live/session?id=" + encodeURIComponent(id), { cache: "no-store" }); if (!r.ok) throw new Error(String(r.status)); raw = await r.json(); } catch { $("stage").textContent = "Session not available"; return; }
  const listed = sessionList.find((s) => s.id === id);
  events = new LiveAdapter().processAll(raw);
  replaySession = { id, project: raw[raw.length - 1]?.session?.project ?? listed?.project ?? null };
  restart(universeConfig(id));
}
function restart(config = replayConfig) {
  replayConfig = config;
  if (replayer) replayer.pause();
  newUniverse(config); selected = null; renderInspect(); sceneClock = 0; galleryEntered = null;
  Object.assign(camera, { azimuth: 0.6, elevation: 0.06, distance: 7.5, target: [0, 0.4, 0] });
  setMode("live");
  replayer = new Replayer(events, { speed: Number($("speed").value) });
  if (replaySession) replayer.events = events; // keep the adapter's own order (objective before the event that opens it)
  replayer.on("event", ({ event, index }) => onEvent(event, index));
  replayer.on("state", updatePlay);
  replayer.start(); updatePlay(); renderAgents(); updateBrand(); renderSessionOptions();
}
function musicEvent(event, u, aIdx, clockMs) {
  if (!(synth && musicOn)) return;
  const a = event.actor?.type === "subagent" ? u.agents.get("agent:" + event.actor.agentId) : u.agents.get("main");
  const crystals = a ? a.crystals.map((id) => u.body(id)).filter(Boolean) : [];
  const verifiedShare = crystals.length ? crystals.reduce((s, c) => s + c.verified.filter((v) => v === 1).length, 0) / crystals.reduce((s, c) => s + c.verified.length, 0) : 0;
  const structural = ["agent.start", "git.commit", "task.start"].includes(event.kind) || (event.kind === "tool.result" && u.classify(event).op === "scaffold");
  try { lastMusic = synth.onEvent(event, { identity: u.identityFor(event.actor), agentIndex: event.actor?.type === "subagent" ? aIdx.get(event.actor.agentId) : 0, nodeId: a?.key || "main", t: clockMs / 1000, verified: verifiedShare > 0.6, path: event.payload?.paths?.[0] || null, structural }); } catch (err) { console.warn("music", err); }
}
function onEvent(event, index) {
  universe.ingest(event, sceneClock, index);
  if (event.actor?.type === "subagent" && !agentIndex.has(event.actor.agentId)) agentIndex.set(event.actor.agentId, agentIndex.size + 1);
  musicEvent(event, universe, agentIndex, sceneClock);
  renderAgents(); renderObjective(event);
}
// Rebuild deterministically up to a recording offset, interleaving engine ticks and director updates.
function rebuildTo(targetMs) {
  const wasPlaying = replayer.state === "playing"; if (wasPlaying) replayer.pause();
  newUniverse(); selected = null; renderInspect(); sceneClock = 0;
  const t0 = replayer.t0, step = 250;
  let prev = t0, i = 0;
  const cap = replaySession ? 2000 : Infinity; // real sessions: idle gaps are compressed so a seek stays quick
  const tickAll = () => { prev += step; sceneClock += step; universe.tick(step, sceneClock); if (sceneClock % 1000 === 0) steerCamera(step * 4, true); };
  for (; i < events.length && Date.parse(events[i].ts) - t0 <= targetMs; i++) {
    const ts = Date.parse(events[i].ts);
    if (ts - prev > cap) prev = ts - cap;
    while (prev + step <= ts) tickAll();
    universe.ingest(events[i], sceneClock, i);
    if (events[i].actor?.type === "subagent" && !agentIndex.has(events[i].actor.agentId)) agentIndex.set(events[i].actor.agentId, agentIndex.size + 1);
  }
  if (t0 + targetMs - prev > cap) prev = t0 + targetMs - cap;
  while (prev + step <= t0 + targetMs) tickAll();
  replayer.index = i; replayer.virtual = t0 + targetMs; replayer.wallAnchor = replayer.now();
  if (i >= events.length) { replayer.setState("done"); } else if (replayer.state === "done" || replayer.state === "idle") replayer.setState("paused");
  if (wasPlaying && replayer.state === "paused") replayer.resume();
  if (synth) synth.reset?.();
  renderAgents(); renderObjective(events[Math.max(0, i - 1)]);
}
function updatePlay() { $("play").textContent = replayer && replayer.state === "playing" ? "Pause" : replayer && replayer.state === "done" ? "Replay" : "Play"; }
function position() { if (!replayer) return 0; let p = replayer.position; if (replayer.state === "playing" && replayer.wallAnchor != null) p += (replayer.now() - replayer.wallAnchor) * replayer.speed; return Math.min(replayer.duration, Math.max(0, p)); }

$("play").addEventListener("click", togglePlay);
function togglePlay() { if (source !== "replay" || !replayer) return; if (replayer.state === "playing") replayer.pause(); else if (replayer.state === "done") restart(); else if (replayer.state === "paused") replayer.resume(); else replayer.start(); }
$("restart").addEventListener("click", () => restart());
$("speed").addEventListener("input", () => { $("speedv").textContent = $("speed").value + "×"; if (replayer) replayer.setSpeed(Number($("speed").value)); });
$("preview").addEventListener("click", () => { if (!replayer) return; const s = Math.max(1, Math.min(60, Math.round(replayer.duration / 90000))); $("speed").value = s; $("speedv").textContent = s + "×"; replayer.setSpeed(s); if (replayer.state !== "playing") { if (replayer.state === "done") restart(); else replayer.resume?.(); if (replayer.state === "idle") replayer.start(); } });
$("seek").addEventListener("change", () => { if (replayer) rebuildTo((Number($("seek").value) / 1000) * replayer.duration); });
$("finale").addEventListener("click", jumpToFinale);
function jumpToFinale() { if (!replayer) return; rebuildTo(replayer.duration + 60000); replayer.setState("done"); for (let k = 0; k < 40; k++) { sceneClock += 250; universe.tick(250, sceneClock); } director.manual = false; setMode("art"); }
for (const [id, key] of [["director", "director"], ["facesOn", "faces"], ["linksOn", "links"], ["bloomOn", "bloom"], ["autoGallery", "autoGallery"], ["reduced", "reduced"]]) $(id).addEventListener("change", () => { ui[key] = $(id).checked; if (key === "bloom") gl.setQuality(ui.bloom ? 1 : 0); if (key === "reduced") { director.reduced = ui.reduced; for (const p of pageWorlds.values()) p.director.reduced = ui.reduced; } if (key === "director") { if (ui.director) director.resume(poseOf(camera)); else director.manual = true; } });
$("panelToggle").addEventListener("click", () => { const h = !$("side").hidden; $("side").hidden = h; $("panelToggle").setAttribute("aria-expanded", String(!h)); });
addEventListener("keydown", (e) => { if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return; if (e.code === "Space") { e.preventDefault(); togglePlay(); } if (e.key === "g" || e.key === "G") setMode(ui.mode === "live" ? "art" : "live"); if (e.key === "l" || e.key === "L") setSource(source === "live" ? "replay" : "live"); });


// ---------- live source: one Universe per session (LiveWorlds), the focused one is on screen ----------
function onIngest(world, out) {
  const pw = pageWorld(world.id);
  if (out.actor?.type === "subagent" && !pw.agentIndex.has(out.actor.agentId)) pw.agentIndex.set(out.actor.agentId, pw.agentIndex.size + 1);
  pw.last = out;
  if (world.id !== focusedId) return;
  uiDirty = true;
  if (worlds.pendingFor(world.id) < 15) musicEvent(out, world.universe, pw.agentIndex, world.sceneClock); // no fanfare while catching up a backlog
}
function ensureLive() {
  if (!worlds) {
    worlds = new LiveWorlds({ createUniverse: (id) => new Universe({ mapping, identities, config: universeConfig(id) }), onIngest });
    placeholder = new Universe({ mapping, identities, config: { page: "universe" } }); placeholderDirector = new CameraDirector({ reduced: ui.reduced });
  }
  if (!liveEs && typeof EventSource !== "undefined") connectFeed();
}
function connectFeed() {
  const parse = (m) => { try { const v = JSON.parse(m.data); return Array.isArray(v) ? v : []; } catch { return []; } };
  const es = liveEs = new EventSource("/live/stream");
  es.addEventListener("hello", () => { feedUp = true; for (const f of helloWaiters.splice(0)) f(true); });
  es.addEventListener("backlog", (m) => worlds.enqueue(parse(m)));
  es.addEventListener("events", (m) => { const b = parse(m); if (b.length) arrivals.push({ t: Date.now(), n: b.length }); worlds.enqueue(b); });
  es.addEventListener("error", () => { feedUp = false; });
}
function disconnectFeed() { if (liveEs) { liveEs.close(); liveEs = null; } feedUp = false; }
// Resolves true as soon as the feed says hello, false after `ms`.
function probeFeed(ms) {
  ensureLive();
  return new Promise((resolve) => {
    if (feedUp) return resolve(true);
    const done = (v) => { clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => { helloWaiters = helloWaiters.filter((f) => f !== done); resolve(false); }, ms);
    helloWaiters.push(done);
  });
}
function activate(id) {
  const w = worlds.world(id); if (!w) return;
  const pw = pageWorld(id);
  focusedId = id; universe = w.universe; director = pw.director; agentIndex = pw.agentIndex;
  selected = null; renderInspect(); lastExtent = universe.extent(); lastExtentAt = performance.now();
  if (!director.manual && ui.director) easeTo = { ...director.pose, target: [...director.pose.target] }; // glide to this world's own camera arc
  else easeTo = null;
  galleryEntered = universe.resolved && ui.mode === "live" ? performance.now() : null; // arriving on a finished session must not throw the gallery open
  if (synth) { synth.opts.project = currentName() || "demo"; synth.setSeed?.(universe.fingerprint); }
  lastObj = pw.last; renderAgents(); renderObjective(pw.last); renderStrip(); updateBrand();
}
function elect() {
  if (worlds.pending) return; // wait for the catch-up so the first pick sees whole sessions
  const id = worlds.focusId(Date.now());
  if (id != null && id !== focusedId) activate(id);
}
function liveFrame(now, dt) {
  const wall = Date.now(), t0 = performance.now();
  const r = worlds.step(wall);
  if (r.processed) { const per = (performance.now() - t0) / r.processed; adaptive = Math.max(20, Math.min(300, Math.floor(8 / Math.max(per, 0.01)))); worlds.catchUpPerStep = adaptive; } // keep catch-up inside ~8 ms a frame
  worlds.tick(dt, wall, focusedId);
  if (wall - lastElect >= 1000) { lastElect = wall; elect(); renderStrip(); }
  if (focusedId != null) sceneClock = worlds.world(focusedId).sceneClock; else { sceneClock += dt; universe.tick(dt, sceneClock); }
  const dm = focusedDormant(); if (dm !== dormantShown) { dormantShown = dm; uiDirty = true; }
  if (uiDirty && now - lastUi > 250) { uiDirty = false; lastUi = now; renderAgents(); renderObjective(focusedId != null ? pageWorld(focusedId).last : null); }
  if (!universe.resolved && ui.mode === "live") galleryEntered = null;
  updateStatus(wall);
  return universe.resolved ? Math.min(1, (sceneClock - universe.resolvedAt) / (mapping.dynamics.resolveSeconds * 1000)) : 0;
}
function updateStatus(wall) {
  while (arrivals.length && wall - arrivals[0].t > 60000) arrivals.shift();
  const rate = arrivals.reduce((s, a) => s + a.n, 0), pend = worlds?.pending || 0;
  $("liveStatus").textContent = pend ? `LIVE · catching up ${pend} events…` : `LIVE · ${feedUp ? `${rate} events/min` : "feed reconnecting…"}`;
}
function renderStrip() {
  if (!worlds) return;
  const rows = worlds.list(Date.now()), box = $("chips");
  box.replaceChildren();
  if (!rows.length) { const s = document.createElement("span"); s.className = "empty"; s.textContent = worlds.pending ? "Reading recent activity…" : "Waiting for Claude Code activity…"; box.append(s); }
  for (const r of rows) {
    const b = document.createElement("button"); b.className = "chip" + (r.dormant ? " dormant" : ""); b.dataset.id = r.id; b.setAttribute("aria-pressed", String(r.id === focusedId));
    const dot = document.createElement("span"); dot.className = "dot"; dot.style.opacity = String(0.2 + 0.8 * Math.min(1, r.score / 5));
    const nm = document.createElement("span"); nm.textContent = displayName(r.id, r.project);
    b.append(dot, nm);
    const badge = r.ended ? "ended" : r.dormant ? "dormant" : r.catchingUp ? "catching up" : "";
    if (badge) { const bd = document.createElement("span"); bd.className = "badge"; bd.textContent = badge; b.append(bd); }
    if (r.pinned) b.title = "Pinned";
    box.append(b);
  }
  const pinned = worlds.focus.pinned, has = !!pinned && worlds.focus.has(pinned);
  $("pinState").textContent = has ? `Pinned: ${displayName(pinned, worlds.world(pinned)?.project)}` : "Following the most active session";
  $("follow").disabled = !has;
}
$("chips").addEventListener("click", (e) => { const b = e.target.closest?.(".chip"); if (!b || !worlds) return; worlds.focus.pin(b.dataset.id); const id = worlds.focusId(Date.now()); if (id != null && id !== focusedId) activate(id); renderStrip(); });
$("follow").addEventListener("click", () => { if (!worlds) return; worlds.focus.unpin(); elect(); renderStrip(); });

async function setSource(next, { force = false, load: doLoad = true } = {}) {
  if (next === source && !force) return;
  if (source === "replay" && replayer && universe) { replayer.pause(); savedReplay = { universe, director, sceneClock, agentIndex, galleryEntered, lastObj }; }
  source = next; dormantShown = false; document.body.dataset.source = next; setMode("live");
  $("srcLive").setAttribute("aria-selected", String(next === "live")); $("srcReplay").setAttribute("aria-selected", String(next === "replay"));
  $("liveStatus").hidden = next !== "live"; $("sourceNote").textContent = "";
  try { const u = new URL(location.href); u.searchParams.set("source", next); history.replaceState(null, "", u); } catch { /* not essential */ }
  if (next === "live") {
    ensureLive(); selected = null; renderInspect();
    if (focusedId != null && worlds.world(focusedId)) activate(focusedId);
    else { focusedId = null; universe = placeholder; director = placeholderDirector; agentIndex = new Map(); lastObj = null; renderAgents(); renderObjective(null); }
    renderStrip(); updateBrand();
  } else if (savedReplay) {
    ({ universe, director, sceneClock, agentIndex, galleryEntered, lastObj } = savedReplay); selected = null; renderInspect();
    if (synth) { synth.opts.project = currentName() || "demo"; synth.setSeed?.(universe.fingerprint); }
    updatePlay(); renderAgents(); renderObjective(lastObj); updateBrand();
  } else { updateBrand(); if (doLoad) await load(); }
}
$("srcLive").addEventListener("click", () => setSource("live")); $("srcReplay").addEventListener("click", () => setSource("replay"));

function updateBrand() {
  $("brandTag").textContent = source === "live" ? "live" : replaySession ? "real session replay" : "recording";
  $("sideNote").textContent = source === "live" || replaySession ? SIDE_NOTE_REAL : SIDE_NOTE_DEMO;
}
async function fillSessions() {
  try { const r = await fetch("/live/sessions", { cache: "no-store" }); sessionList = r.ok ? await r.json() : []; } catch { sessionList = []; }
  if (!Array.isArray(sessionList)) sessionList = [];
  renderSessionOptions();
}
function renderSessionOptions() {
  const sel = $("realSessions"), cur = replaySession ? replaySession.id : "";
  sel.replaceChildren(new Option("Demo recording", ""));
  for (const s of [...sessionList].sort((a, b) => Date.parse(b.last) - Date.parse(a.last))) {
    const when = new Date(s.last).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    sel.append(new Option(`${displayName(s.id, s.project)} · ${when} · ${s.count} events`, s.id));
  }
  sel.value = cur;
  $("replayHint").textContent = sessionList.length ? "Replays a past Claude Code session from the local activity log." : "No real sessions available from the activity log.";
}
$("realSessions").addEventListener("change", async () => {
  const id = $("realSessions").value;
  try { const u = new URL(location.href); if (id) u.searchParams.set("session", id); else u.searchParams.delete("session"); history.replaceState(null, "", u); } catch { /* not essential */ }
  if (id) await loadSession(id); else await load();
});
$("privacyOn").checked = privacy;
$("privacyOn").addEventListener("change", () => {
  privacy = $("privacyOn").checked; store.set("resonance.privacy", privacy ? "1" : "0");
  renderSessionOptions(); renderStrip(); renderObjective(lastObj); if (ui.mode === "art") setMode("art");
  if (synth) synth.opts.project = currentName() || "demo";
});

// ---------- camera: director + manual ----------
const poseOf = (c) => ({ azimuth: c.azimuth, elevation: c.elevation, distance: c.distance, target: [...c.target] });
let easeTo = null;
function applyPose(p) { camera.azimuth = p.azimuth; camera.elevation = p.elevation; camera.distance = p.distance; camera.target = [...p.target]; }
function steerCamera(dt, silent = false) {
  const st = frameState = universe.state();
  if (silent && sceneClock % 2000 === 0) lastExtent = universe.extent();
  const pose = director.update(dt, { milestones: st.milestones, progress: st.progress ?? (source === "replay" && replayer ? position() / Math.max(1, replayer.duration) : 0), extent: lastExtent, resolved: universe.resolved, time: sceneClock });
  if (silent) { applyPose(pose); return; }
  if (easeTo) { const k = 1 - Math.exp(-dt / 600); camera.azimuth += (easeTo.azimuth - camera.azimuth) * k; camera.elevation += (easeTo.elevation - camera.elevation) * k; camera.distance += (easeTo.distance - camera.distance) * k; camera.target = camera.target.map((v, i) => v + (easeTo.target[i] - v) * k); if (Math.abs(easeTo.elevation - camera.elevation) < 0.002 && Math.abs(easeTo.distance - camera.distance) < 0.01) easeTo = null; return; }
  if (!director.manual && ui.director) applyPose(pose);
}
$("camGround").addEventListener("click", () => { easeTo = director.ground(lastExtent); });
$("camOverview").addEventListener("click", () => { easeTo = director.overview(lastExtent); });
$("camResume").addEventListener("click", () => { easeTo = null; ui.director = true; $("director").checked = true; director.resume(poseOf(camera)); });
let drag = null;
canvas.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, moved: false }; });
canvas.addEventListener("pointermove", (e) => { if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 3) { drag.moved = true; director.manual = true; easeTo = null; } camera.orbit(-dx * 0.005, dy * 0.005); drag.x = e.clientX; drag.y = e.clientY; });
canvas.addEventListener("pointerup", (e) => { if (drag && !drag.moved) pick(e.clientX, e.clientY); drag = null; });
canvas.addEventListener("wheel", (e) => { camera.dolly(Math.exp(e.deltaY * 0.001)); director.manual = true; easeTo = null; e.preventDefault(); }, { passive: false });

// ---------- modes ----------
function setMode(mode) {
  ui.mode = mode; document.body.dataset.mode = mode;
  $("modeLive").setAttribute("aria-selected", String(mode === "live")); $("modeArt").setAttribute("aria-selected", String(mode === "art"));
  if (mode === "art") { galleryEntered = performance.now(); const c = universe.counts(); const real = isReal(); $("gTask").textContent = universe.task?.title ? `“${universe.task.title}”` : real ? `Finished artwork · ${currentName()}` : "Finished artwork"; $("gMeta").textContent = `${eventCount()} ${real ? "events" : "synthetic events"} · ${c.bodies} structures · ${c.links} links · ${c.above} vertices above, ${c.below} below · verified ${(universe.verifiedFraction() * 100).toFixed(0)}% · ${universe.fingerprint.slice(0, 12)}`; renderHistory(); }
}
$("modeLive").addEventListener("click", () => setMode("live")); $("modeArt").addEventListener("click", () => setMode("art")); $("gBack").addEventListener("click", () => setMode("live"));
$("gHistory").addEventListener("click", () => { $("history").hidden = !$("history").hidden; });

// ---------- music (optional; off by default; independent of other apps' alerts) ----------
$("musicToggle").addEventListener("click", async () => {
  if (!synth) { try { musicMod = await import("../audio/src/forge-music.js"); synth = new musicMod.ForgeSynth({ identities, project: currentName() || "demo", seed: universe.fingerprint }); } catch (err) { $("music").textContent = "music module unavailable: " + err.message; return; } }
  if (!musicOn) { await synth.enable(); synth.setMuted(false); synth.setVolume(Number($("volume").value) / 100); musicOn = true; $("musicToggle").textContent = "Mute music"; $("music").textContent = "music playing (Forge harmony · Smith rhythm · Scout melody · panned by position)"; }
  else { synth.setMuted(true); musicOn = false; $("musicToggle").textContent = "Enable music"; $("music").textContent = "music muted"; }
});
$("volume").addEventListener("input", () => { if (synth) synth.setVolume(Number($("volume").value) / 100); });

// ---------- inspection, agents, objective, history ----------
function pxOf(p) { const r = canvas.getBoundingClientRect(); return [r.width / 2 + p.x * (r.height / 2), r.height / 2 - p.y * (r.height / 2)]; }
function pick(x, y) {
  const r = canvas.getBoundingClientRect(), cx = x - r.left, cy = y - r.top;
  let best = null;
  for (const { bodyId, screen } of lastScreens) screen.forEach((p, i) => { if (!p.visible) return; const [px, py] = pxOf(p); const d = Math.hypot(px - cx, py - cy); if (d <= 14 && (!best || d < best.d)) best = { bodyId, index: i, d }; });
  selected = best ? { bodyId: best.bodyId, index: best.index } : null;
  renderInspect(); if (ui.mode === "art") { $("history").hidden = false; renderHistory(); }
}
const VER = { 1: "verified", 0: "untested", "-1": "unstable" };
const KIND_LABEL = { origin: "the objective", plane: "the reference plane (planning)", field: "four-dimensional field (planning)", seed: "agent arrival", crystal: "implementation", root: "research network (beneath the plane)", reflection: "foundation: reflection of verified work", membrane: "commit seal" };
function describeLines(d) {
  const ref = d.vertex.ref || {}, ev = d.event, b = d.body;
  return [
    `<b>${b.label}</b> · ${KIND_LABEL[b.kind] || b.kind}${b.path ? " · " + b.path : ""}${b.mirrorOf ? " · mirrors " + b.mirrorOf.replace("crystal:", "") : ""}${b.agentType && b.kind !== "origin" ? " · " + b.agentType : ""}${b.model ? " · " + b.model : ""}`,
    `<b>material</b> ${VER[d.vertex.verified]} · heat ${d.vertex.heat.toFixed(2)} · vertex #${d.vertex.index} of ${b.vertices} · ${b.verified} verified, ${b.failed} unstable · at [${d.vertex.world.map((v) => v.toFixed(2)).join(", ")}]${d.vertex.world[1] < -0.05 ? " (below)" : d.vertex.world[1] > 0.05 ? " (above)" : " (on the plane)"}`,
    `<b>created by</b> ${ref.kind || "?"} ${ref.eventId || ""} · replay #${ref.replayIndex ?? "?"}${ref.lastEventId ? `\n<b>last touched by</b> ${ref.lastKind} ${ref.lastEventId}` : ""}${ref.deadEnd ? " · dead end" : ""}`,
    ref.tool || ref.path ? `<b>tool</b> ${ref.tool || "-"} · <b>file</b> ${ref.path || "-"}` : null,
    ref.structure ? `<b>code structure</b> ${ref.structureKind || ""} ${ref.structure}` : null,
    ev ? `<b>event</b> ${ev.label || ev.kind}${ev.payload?.stage ? ` · stage ${ev.payload.stage}` : ""}\n${ev.classification.map((c) => `${c.scheme}=${c.value}@${c.confidence}`).join(" ")}` : null,
    d.links.length ? `<b>links</b> ${d.links.map((l) => `${l.kind} → ${l.to}`).join(", ")}` : null,
    `<b>edges here</b> ${d.edges.map((e) => `${e.edge[0]}-${e.edge[1]} (${e.ref.kind}${e.weight ? ", w " + e.weight.toFixed(2) : ""})`).join(", ")}`,
    `<b>recent history</b> ${d.history.map((h) => h.kind).join(" → ")}`,
    `<b>fingerprint</b> ${d.fingerprint}`,
  ].filter(Boolean);
}
function renderInspect() {
  if (!selected) { $("inspect").textContent = "nothing selected"; $("inspect").className = "mono hint"; return; }
  const d = universe.describe(selected.bodyId, selected.index); if (!d) return;
  $("inspect").innerHTML = describeLines(d).join("\n"); $("inspect").className = "mono";
}
function renderAgents() {
  const items = [];
  for (const a of universe.agents.values()) {
    const P = universe.preset(a.identity), color = `hsl(${P.hue} ${P.sat}% ${P.light}%)`;
    const crystals = a.crystals.map((id) => universe.body(id)).filter(Boolean), ver = crystals.reduce((s, c) => s + c.verified.filter((v) => v === 1).length, 0), tot = crystals.reduce((s, c) => s + c.verified.length, 0);
    const root = a.rootId ? universe.body(a.rootId) : null;
    const st = `${a.agentType || "main"}${a.docked ? " · returned" : " · active"}${crystals.length ? ` · ${crystals.length} structures, ${tot ? Math.round((100 * ver) / tot) : 0}% verified` : ""}${root ? ` · ${root.structure.vertices.length} research nodes` : ""}${a.parentKey && a.parentKey !== "main" ? " · helper" : ""}`;
    items.push(`<li><span class="sw" style="color:${color};background:${color}"></span><span class="nm">${P.label}</span><span class="st">${st}</span><input type="checkbox" data-agent="${a.key}" ${ui.hidden.has(a.key) ? "" : "checked"} aria-label="show ${P.label}" /></li>`);
  }
  $("agents").innerHTML = items.join("") || '<li class="hint">waiting for the objective…</li>';
  for (const cb of $("agents").querySelectorAll("input")) cb.addEventListener("change", () => { if (cb.checked) ui.hidden.delete(cb.dataset.agent); else ui.hidden.add(cb.dataset.agent); });
}
function renderObjective(event) {
  lastObj = event || null;
  const stage = event?.payload?.stage || (universe.resolved ? "Objective completed" : universe.task?.title || "");
  const title = universe.task ? universe.task.title || (isReal() ? currentName() : "") : "";
  if (source === "live" && focusedId == null) { $("stage").textContent = "Waiting for Claude Code activity…"; $("now").textContent = ""; return; }
  $("stage").textContent = title ? `${title}${stage ? "  —  " + stage : ""}` : stage;
  const a = event?.actor?.type === "subagent" ? universe.agents.get("agent:" + event.actor.agentId) : null;
  const who = a ? universe.preset(a.identity).label : event?.actor?.type === "main" ? universe.preset(identities.main).label : "";
  $("now").textContent = focusedDormant() ? DORMANT_TEXT : event?.payload?.label ? `${who ? who + ": " : ""}${event.payload.label}` : event ? `${who} ${event.kind}` : "";
}
const PHASE_TEXT = { grounded: "camera · grounded — the plane spreads", curiosity: "camera · curiosity — structures rise", revelation: "camera · revelation — as above, so below", expansion: "camera · expansion — growth in all directions", completion: "camera · completion" };
function renderHistory() {
  const stages = new Map();
  for (const e of universe.events.values()) { const s = e.payload?.stage; if (!s) continue; if (!stages.has(s)) stages.set(s, []); if (e.label && e.kind !== "tool.call") stages.get(s).push(e); }
  const parts = [];
  if (selected) { const d = universe.describe(selected.bodyId, selected.index); if (d) parts.push(`<div class="h">Selected element</div>` + describeLines(d).slice(0, 7).join("\n")); }
  parts.push(`<div class="h">Story</div>` + [...stages.entries()].map(([s, list]) => `${s}\n` + list.map((e) => `   ${new Date(e.ts).toISOString().slice(11, 19)}  ${e.kind.padEnd(12)} ${e.label}`).join("\n")).join("\n"));
  parts.push(`<div class="h">Camera</div>` + director.history.map((h) => `${mmss(h.t)}  ${h.phase.padEnd(11)} ${h.reason}`).join("\n"));
  parts.push(`<div class="h">Structures</div>` + [...universe.bodies.values()].map((b) => `${b.preset.label.padEnd(10)} ${b.kind.padEnd(10)} ${String(b.structure.vertices.length).padStart(4)} v ${String(b.structure.edges.length).padStart(4)} e  verified ${String(b.verified.filter((v) => v === 1).length).padStart(3)}  ${b.path || b.mirrorOf?.replace("crystal:", "") || ""}`).join("\n"));
  $("history").innerHTML = parts.join("\n\n");
}

// ---------- export ----------
function download(blob, name) { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
async function savePng() { const b = await gl.screenshotBlob(); if (b) download(b, `forge-universe-${universe.fingerprint.slice(0, 8)}.png`); }
function saveManifest() {
  const ref = currentRef();
  // privacy: no project, session id or recording name, only the stable alias
  const who = privacy ? { session: currentName() } : source === "live" || replaySession ? { project: ref.project, sessionId: ref.id } : { recording: RECORDING };
  const m = { ...who, source: source === "live" ? "live" : replaySession ? "real session replay" : "recording", engine: "universe", fingerprint: universe.fingerprint, snapshotHash: universe.snapshotHash(), events: eventCount(), replayPositionMs: source === "replay" ? position() : null, resolved: universe.resolved, verifiedFraction: universe.verifiedFraction(), counts: universe.counts(), extent: universe.extent(), camera: camera.toJSON(), director: director.state(), ui: { ...ui, hidden: [...ui.hidden] }, generatedAt: new Date().toISOString(), note: isReal() ? "Deterministic: the same events and configuration reproduce this snapshotHash. Labelled events from content-free hook activity; no source content." : "Deterministic: the same recording and configuration reproduce this snapshotHash. Synthetic, labelled events; no source content." };
  download(new Blob([JSON.stringify(m, null, 2)], { type: "application/json" }), `forge-universe-manifest-${universe.fingerprint.slice(0, 8)}.json`);
}
$("savePng").addEventListener("click", savePng); $("gPng").addEventListener("click", savePng);
$("saveManifest").addEventListener("click", saveManifest); $("gManifest").addEventListener("click", saveManifest);

// ---------- styling: identity colour + Workshop temperature/verification + ripples ----------
const KIND_STYLE = {
  plane: { alpha: 0.14, width: 1, face: 0.014, sat: -25, light: -12 },
  origin: { alpha: 0.3, width: 1.4, face: 0.012 },
  field: { alpha: 0.08, width: 1, face: 0.003 },
  seed: { alpha: 0.4, width: 1.3, face: 0.03 },
  crystal: { alpha: 0.28, width: 1.2, face: 0.03 },
  root: { alpha: 0.45, width: 1.5, face: 0 },
  reflection: { alpha: 0.3, width: 1.1, face: 0.025, light: -8 },
  membrane: { alpha: 0.3, width: 1.2, face: 0.05 },
};
const LINK_STYLE = { foundation: [0.22, 1], collaboration: [0.35, 1.2], review: [0.3, 1], closure: [0.35, 1.2], seal: [0.35, 1.2], field: [0.12, 1] };
function edgeColour(b, ei, t, vf) {
  const P = b.preset, K = KIND_STYLE[b.kind] || KIND_STYLE.crystal, [a, c] = b.structure.edges[ei];
  const heat = (b.heat[a] + b.heat[c]) / 2, ver = Math.min(b.verified[a], b.verified[c]), bothVer = b.verified[a] === 1 && b.verified[c] === 1;
  let hue = P.hue, sat = P.sat + (K.sat || 0), light = P.light + (K.light || 0), alpha = K.alpha, width = K.width;
  if (b.kind === "origin") { const density = Math.min(1, 24 / b.structure.edges.length); alpha = (0.2 + 0.14 * vf) * density; light = 68 + 14 * vf; width = 1.2 + 0.5 * vf; }
  if (P.thermal && (b.kind === "crystal" || b.kind === "reflection" || b.kind === "seed")) {
    hue = mixHue(bothVer ? P.thermal.verifiedHue : P.hue, P.thermal.hotHue, heat); light = (bothVer ? light - 4 : light) + (P.thermal.hotLight - P.light) * heat; sat = bothVer ? P.thermal.verifiedSat : sat;
    if (ver === -1) { hue = P.thermal.failHue; light = 58 + 10 * Math.sin(t * 0.012 + ei); }
  } else { light += 16 * heat; if (ver === -1) { hue = mixHue(hue, 5, 0.7); light = 56 + 8 * Math.sin(t * 0.012 + ei); } }
  if (bothVer && b.kind !== "plane" && b.kind !== "origin") { alpha += 0.1; width += 0.5; } else if (b.kind === "crystal" || b.kind === "root") alpha *= 0.8;
  const wgt = b.edgeWeight[ei]; if (wgt > 0) { alpha += 0.15 * wgt; width += 0.4 * wgt; light += 4 * wgt; } if (wgt < 0) alpha *= 1 + 0.6 * wgt;
  const st = universe.edgeState(b.id, a, c, t), glow = (b.glow[a] + b.glow[c]) / 2;
  if (st.energy > 0.01) { hue = mixHue(hue, st.hue ?? hue, Math.min(1, st.energy) * 0.8); light += 18 * Math.min(1, st.energy); alpha = Math.min(0.85, alpha + 0.3 * Math.abs(st.amp)); width += 1.0 * Math.abs(st.amp); }
  if (glow > 0) { light += 10 * glow; alpha = Math.min(0.85, alpha + 0.15 * glow); }
  if (b.docked) alpha *= 0.85;
  return { rgb: hslToRgb(hue, Math.max(0, Math.min(100, sat)), Math.min(96, light)), alpha, width };
}

// ---------- frame ----------
function frame(now) {
  const dt = Math.min(100, now - lastFrame); lastFrame = now; fps = fps * 0.95 + (1000 / Math.max(1, dt)) * 0.05;
  let resolving;
  if (source === "live") resolving = liveFrame(now, dt);
  else {
    const playing = replayer && replayer.state === "playing";
    const advancing = playing || (replayer && replayer.state === "done" && ui.mode === "live");
    if (advancing) sceneClock += dt;
    resolving = universe.tick(advancing ? dt : 0, sceneClock);
  }
  const t = sceneClock;
  if (now - lastExtentAt > 500) { lastExtent = universe.extent(); lastExtentAt = now; }
  steerCamera(dt);
  if (ui.mode === "art" && !director.manual && !easeTo) { director.phase = "completion"; director.phaseIndex = 4; }
  if (universe.resolved && ui.autoGallery && ui.mode === "live" && resolving >= 1 && (source === "live" || replayer?.state !== "paused") && !galleryEntered) setMode("art");
  if (synth && musicOn) { try { synth.setState?.(universe.state()); synth.setSpace?.(spatialMap()); synth.tick?.(t / 1000); } catch { /* ignore */ } }

  fb.reset();
  const basis = camera.basis(), vf = universe.verifiedFraction(), waitingDim = universe.waiting || dormantShown ? 0.6 : 1;
  const visible = (b) => !(ui.hideKinds && ui.hideKinds.has(b.kind)) && !(b.agentKey && ui.hidden.has(b.agentKey)) && !(b.kind === "reflection" && b.agentKey && ui.hidden.has(b.agentKey));
  const placed = new Map(); lastScreens = [];
  for (const b of universe.bodies.values()) {
    const wv = universe.worldVertices(b);
    // unverified material trembles slightly (Workshop: soft until quenched)
    const pts = (b.kind === "crystal" || b.kind === "root" || b.kind === "seed") && !ui.reduced ? wv.points.map((p, i) => (b.verified[i] === 1 ? p : [p[0] + Math.sin(t * 0.004 + i * 1.7) * 0.012 * (0.4 + b.heat[i]), p[1] + Math.cos(t * 0.0035 + i * 2.3) * 0.012 * (0.4 + b.heat[i]), p[2]])) : wv.points;
    placed.set(b.id, { points: pts, w: wv.w });
    if (visible(b)) lastScreens.push({ bodyId: b.id, screen: pts.map((p) => camera.project(p, basis)) });
  }
  // links first (behind)
  if (ui.links) for (const l of universe.links) {
    const A = universe.body(l.a.bodyId), B = universe.body(l.b.bodyId); if (!A || !B || !visible(A) || !visible(B)) continue;
    const pa = placed.get(A.id).points[l.a.i], pb = placed.get(B.id).points[l.b.i]; if (!pa || !pb) continue;
    const P = universe.preset(l.identity || A.identity), [al, wd] = LINK_STYLE[l.kind] || [0.2, 1];
    const sa = universe.edgeState(A.id, l.a.i, l.a.i, t);
    fb.line(pa, pb, hslToRgb(P.hue, P.sat - 10, P.light + 8 + 20 * Math.min(1, sa.energy)), (al + 0.4 * Math.abs(sa.amp)) * waitingDim * l.weight, wd + 0.8 * Math.abs(sa.amp));
  }
  for (const b of universe.bodies.values()) {
    if (!visible(b)) continue;
    const { points: pts, w } = placed.get(b.id), P = b.preset, K = KIND_STYLE[b.kind] || KIND_STYLE.crystal;
    const wcue = (i) => (w ? 0.55 + 0.45 * Math.max(0, Math.min(1, (w[i] + 1) / 2)) : 1);
    if (ui.faces && b.structure.faces.length && K.face > 0) for (const f of b.structure.faces) {
      const ver = f.every((v) => b.verified[v] === 1), heat = f.reduce((s, v) => s + b.heat[v], 0) / f.length;
      const hue = P.thermal ? mixHue(P.hue, P.thermal.hotHue, heat) : P.hue;
      const alpha = (b.kind === "origin" ? 0.02 + 0.03 * vf : K.face * (ver ? 1.3 : 0.75)) * waitingDim;
      fb.polygon(f.map((v) => pts[v]), hslToRgb(hue, P.sat + (K.sat || 0), P.light + (K.light || 0) + 10 * heat), alpha);
    }
    b.structure.edges.forEach(([a, c], ei) => { const s = edgeColour(b, ei, t, vf); fb.line(pts[a], pts[c], s.rgb, s.alpha * waitingDim * wcue(a), s.width); });
    for (let i = 0; i < pts.length; i++) {
      const g = b.glow[i], heat = b.heat[i], st = universe.vertexState(b.id, i, t), e = Math.min(1, st.energy), sel = selected && selected.bodyId === b.id && selected.index === i;
      if (sel) { fb.point(pts[i], [1, 1, 1], 1, 0.16); continue; }
      if (b.verified[i] === -1 && b.kind !== "plane") { fb.point(pts[i], hslToRgb(6, 85, 60), 0.5 + 0.3 * Math.sin(t * 0.01 + i), 0.09); continue; }
      if (g < 0.05 && e < 0.05 && heat < 0.35) continue;
      const hue = P.thermal ? mixHue(P.hue, P.thermal.hotHue, heat) : mixHue(P.hue, st.hue ?? P.hue, e);
      fb.point(pts[i], hslToRgb(hue, b.kind === "origin" ? 35 : P.sat, P.light + 12 + 10 * heat), (b.kind === "origin" ? 0.1 + 0.15 * vf : 0.2 * g + 0.35 * e + 0.2 * Math.max(0, heat - 0.35)) * waitingDim, b.kind === "origin" ? 0.05 : 0.04 + 0.05 * e + 0.03 * heat);
    }
  }
  // the objective's luminous heart, and ripples in the plane
  if (universe.origin) fb.point([0, 0, 0], hslToRgb(46, 55, 85), 0.04 + 0.05 * vf, (0.3 + 0.25 * vf) * (0.95 + 0.05 * Math.sin(t * 0.0015)));
  for (const r of universe.ripples.activeRings(t)) fb.ring([r.centre[0], 0.012, r.centre[1]], [0, 1, 0], r.radius, hslToRgb(r.hue, 70, 65), r.alpha * waitingDim, r.width);
  for (const x of universe.ripples.interferences(t)) fb.point([x.point[0], 0.02, x.point[1]], hslToRgb(x.hue, 80, 70), Math.min(0.7, x.alpha * 1.6), 0.14);

  const built = fb.build();
  built.bloom = { strength: ui.mode === "art" ? 0.35 : 0.3, radius: 0.3, threshold: 0.75 };
  gl.render(built, { position: camera.position, target: camera.target, up: [0, 1, 0], fov: camera.fov, near: 0.05, far: 300 });
  const stats = gl.stats();
  slowFrames = stats.ms > 16 ? slowFrames + 1 : 0; if (slowFrames > 60 && ui.bloom) { ui.bloom = false; $("bloomOn").checked = false; gl.setQuality(0); slowFrames = 0; }

  // HUD
  if (source === "replay" && replayer) { const p = position(), d = replayer.duration || 1; if (!drag) $("seek").value = Math.round((p / d) * 1000); $("time").textContent = `${mmss(p)} / ${mmss(d)}`; }
  const st = frameState || universe.state(), cx = st.counts, ds = director.state();
  $("camphase").textContent = ui.mode === "live" ? (director.manual || !ui.director ? "camera · manual" : PHASE_TEXT[ds.phase]) : "";
  $("readout").textContent = `fps ${fps.toFixed(0)} · render ${stats.ms.toFixed(1)} ms · lines ${stats.lines} · faces ${stats.faces}${ui.bloom ? "" : " (bloom off)"}\nverified ${(st.verifiedFraction * 100).toFixed(0)}% · tension ${st.tension.toFixed(2)} · ${st.phase}${st.waiting ? " (waiting)" : ""}\nplane rings ${st.planeRings} · bodies ${cx.bodies} · links ${cx.links} · above ${cx.above} · below ${cx.below} · waves ${cx.waves}\ncamera ${ds.phase}${ds.manual ? " (manual)" : ""} · az ${camera.azimuth.toFixed(2)} el ${camera.elevation.toFixed(2)} d ${camera.distance.toFixed(1)}\nfingerprint ${universe.fingerprint.slice(0, 16)}…${isReal() && currentName() ? `\nsession ${currentName()}` : ""}${lastMusic ? `\nmusic ${lastMusic.phase || ""} · ${lastMusic.bpm || ""} bpm · chord ${lastMusic.chord?.degree ?? lastMusic.chord?.index ?? ""}` : ""}`;
  if (selected && (now | 0) % 15 === 0) renderInspect();
  requestAnimationFrame(frame);
}
// Stereo position of each agent's voice from where its home sits on screen (the rotating view moves the sound).
function spatialMap() {
  const basis = camera.basis(), out = {};
  for (const a of universe.agents.values()) { const b = universe.homeBody(a); if (!b) continue; const p = camera.project(b.position, basis); out[a.agentId || "main"] = Math.max(-0.8, Math.min(0.8, p.visible ? p.x : 0)); }
  return { pans: out, resonance: Math.min(1, universe.ripples.waves.length / 12), fieldSpin: universe.field?.spinBoost ?? 0 };
}
const mmss = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

addEventListener("resize", () => gl.resize());
gl.resize();
async function boot() {
  const want = params.get("source"), sess = params.get("session");
  fillSessions();
  if (want === "live") { await setSource("live", { force: true }); return; }
  if (want === "replay" || sess || params.get("recording")) {
    await setSource("replay", { force: true, load: !sess });
    if (sess) await loadSession(sess);
    return;
  }
  // default: live if the feed says hello within 2 s, otherwise the demo recording and a quiet note
  if (await probeFeed(2000)) { await setSource("live", { force: true }); return; }
  disconnectFeed();
  await setSource("replay", { force: true });
  $("sourceNote").textContent = "No live activity feed — showing a recording";
}
await boot();
requestAnimationFrame(frame);
window.forgeUniverse = { get worlds() { return worlds; }, source: () => source, focusId: () => focusedId, privacy: () => privacy, universe: () => universe, camera, director: () => director, gl, ui, jumpToFinale, rebuildTo, setMode, replayer: () => replayer, synth: () => synth, music: () => lastMusic, extent: () => lastExtent };
