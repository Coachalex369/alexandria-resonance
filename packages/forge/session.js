// Alexandria Resonance — The Forge demonstration page.
// One central origin (the objective core), many agents orbiting it, one evolving composition; Live session and
// Finished artwork modes. This file is presentation only: it feeds a recording through the Replayer into the
// Composer (the engine) and draws the engine's state with the Canvas WireRenderer; the optional music reads the
// same composer state. Nothing here decides geometry.
import { Replayer } from "../event-engine/src/replay.js";
import { Camera } from "../geometry/src/projection.js";
import { WireRenderer, hsla } from "./src/render2d.js";
import { Composer } from "./src/composer.js";
import { mixHue } from "./src/ripples.js";

const $ = (id) => document.getElementById(id);
const canvas = $("cv");
const RECORDING = new URLSearchParams(location.search).get("recording") || "forge-demo-session.events.jsonl";
const [mapping, identities] = await Promise.all([fetch("forge-mapping.json", { cache: "no-store" }).then((r) => r.json()), fetch("identities.json", { cache: "no-store" }).then((r) => r.json())]);

const prefersReduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const ui = { orbit: !prefersReduced, faces: true, traces: true, reduced: prefersReduced, autoGallery: true, mode: "live", hidden: new Set() };
$("autoOrbit").checked = ui.orbit; $("reduced").checked = ui.reduced;

const renderer = new WireRenderer(canvas, { background: "#04050a", glow: true });
const camera = new Camera({ azimuth: 2.0, elevation: 0.3, distance: 8.4, fov: 0.8 });
let composer = new Composer({ mapping, identities });
let replayer = null, events = [];
let sceneClock = 0, lastFrame = performance.now(), fps = 60, slow = 0, fast = 0;
let selected = null, lastScreens = [], galleryEntered = null;
let synth = null, musicOn = false, lastMusic = null;
const trace = document.createElement("canvas"), tctx = trace.getContext("2d");
const agentIndex = new Map();

// ---------- loading and replay ----------
const parseJsonl = (t) => t.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e && e.kind && e.ts);
function newComposer() { composer = new Composer({ mapping, identities, events, config: { page: "session" } }); agentIndex.clear(); if (synth) { synth.opts.project = composer.project || "demo"; synth.setSeed?.(composer.fingerprint); } }
async function load() {
  const res = await fetch("/demo/recordings/" + RECORDING, { cache: "no-store" });
  if (!res.ok) { $("stage").textContent = "Recording not found: " + RECORDING; return; }
  events = parseJsonl(await res.text());
  restart();
}
function restart() {
  if (replayer) replayer.pause();
  newComposer(); selected = null; renderInspect(); clearTrace(); sceneClock = 0; galleryEntered = null;
  camera.distance = 8.4; setMode("live");
  replayer = new Replayer(events, { speed: Number($("speed").value) });
  replayer.on("event", ({ event, index }) => onEvent(event, index));
  replayer.on("state", updatePlay);
  replayer.start(); updatePlay(); renderAgents();
}
function onEvent(event, index) {
  composer.ingest(event, sceneClock, index);
  if (event.actor?.type === "subagent" && !agentIndex.has(event.actor.agentId)) agentIndex.set(event.actor.agentId, agentIndex.size + 1);
  if (synth && musicOn) {
    const nodeId = event.actor?.type === "subagent" ? "agent:" + event.actor.agentId : "main";
    const node = composer.node(nodeId);
    const verifiedShare = node ? node.verified.filter((v) => v === 1).length / Math.max(1, node.verified.length) : 0;
    try { lastMusic = synth.onEvent(event, { identity: composer.identityFor(event.actor), agentIndex: event.actor?.type === "subagent" ? agentIndex.get(event.actor.agentId) : 0, nodeId, t: sceneClock / 1000, verified: verifiedShare > 0.6, path: event.payload?.paths?.[0] || null }); } catch (err) { console.warn("music", err); }
  }
  renderAgents(); renderObjective(event);
}
// Rebuild the composition up to a recording offset, interleaving engine ticks so positions, heat and ripples
// settle the way they would during playback (deterministic: same events, same tick cadence).
function rebuildTo(targetMs) {
  const wasPlaying = replayer.state === "playing"; if (wasPlaying) replayer.pause();
  newComposer(); selected = null; renderInspect(); clearTrace(); sceneClock = 0;
  const t0 = replayer.t0, step = 250;
  let prev = t0, i = 0;
  for (; i < events.length && Date.parse(events[i].ts) - t0 <= targetMs; i++) {
    const ts = Date.parse(events[i].ts);
    while (prev + step <= ts) { prev += step; sceneClock += step; composer.tick(step, sceneClock); }
    composer.ingest(events[i], sceneClock, i);
    if (events[i].actor?.type === "subagent" && !agentIndex.has(events[i].actor.agentId)) agentIndex.set(events[i].actor.agentId, agentIndex.size + 1);
  }
  while (prev + step <= t0 + targetMs) { prev += step; sceneClock += step; composer.tick(step, sceneClock); }
  replayer.index = i; replayer.virtual = t0 + targetMs; replayer.wallAnchor = replayer.now();
  if (i >= events.length) { replayer.setState("done"); } else if (replayer.state === "done" || replayer.state === "idle") replayer.setState("paused");
  if (wasPlaying && replayer.state === "paused") replayer.resume();
  if (synth) synth.reset?.();
  renderAgents(); renderObjective(events[Math.max(0, i - 1)]);
}
function updatePlay() { $("play").textContent = replayer && replayer.state === "playing" ? "Pause" : replayer && replayer.state === "done" ? "Replay" : "Play"; }
function position() { if (!replayer) return 0; let p = replayer.position; if (replayer.state === "playing" && replayer.wallAnchor != null) p += (replayer.now() - replayer.wallAnchor) * replayer.speed; return Math.min(replayer.duration, Math.max(0, p)); }

$("play").addEventListener("click", togglePlay);
function togglePlay() { if (!replayer) return; if (replayer.state === "playing") replayer.pause(); else if (replayer.state === "done") restart(); else if (replayer.state === "paused") replayer.resume(); else replayer.start(); }
$("restart").addEventListener("click", restart);
$("speed").addEventListener("input", () => { $("speedv").textContent = $("speed").value + "×"; if (replayer) replayer.setSpeed(Number($("speed").value)); });
$("seek").addEventListener("change", () => { if (replayer) rebuildTo((Number($("seek").value) / 1000) * replayer.duration); });
$("finale").addEventListener("click", jumpToFinale);
function jumpToFinale() { if (!replayer) return; rebuildTo(replayer.duration + 60000); replayer.setState("done"); for (let k = 0; k < 40; k++) { sceneClock += 250; composer.tick(250, sceneClock); } setMode("art"); }
for (const [id, key] of [["autoOrbit", "orbit"], ["facesOn", "faces"], ["tracesOn", "traces"], ["autoGallery", "autoGallery"], ["reduced", "reduced"]]) $(id).addEventListener("change", () => { ui[key] = $(id).checked; if (key === "reduced" && ui.reduced) { ui.orbit = false; $("autoOrbit").checked = false; } });
$("panelToggle").addEventListener("click", () => { const h = !$("side").hidden; $("side").hidden = h; $("panelToggle").setAttribute("aria-expanded", String(!h)); });
addEventListener("keydown", (e) => { if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return; if (e.code === "Space") { e.preventDefault(); togglePlay(); } if (e.key === "g" || e.key === "G") setMode(ui.mode === "live" ? "art" : "live"); });

// ---------- modes ----------
function setMode(mode) {
  ui.mode = mode; document.body.dataset.mode = mode;
  $("modeLive").setAttribute("aria-selected", String(mode === "live")); $("modeArt").setAttribute("aria-selected", String(mode === "art"));
  if (mode === "art") { galleryEntered = performance.now(); $("gTask").textContent = composer.task?.title ? `“${composer.task.title}”` : "Finished artwork"; $("gMeta").textContent = `${events.length} synthetic events · ${composer.nodes.size} structures · verified ${(composer.verifiedFraction() * 100).toFixed(0)}% · ${composer.fingerprint.slice(0, 12)}`; renderHistory(); }
}
$("modeLive").addEventListener("click", () => setMode("live")); $("modeArt").addEventListener("click", () => setMode("art")); $("gBack").addEventListener("click", () => setMode("live"));
$("gHistory").addEventListener("click", () => { $("history").hidden = !$("history").hidden; });

// ---------- music (optional; off by default; independent of other apps' alerts) ----------
$("musicToggle").addEventListener("click", async () => {
  if (!synth) { try { const mod = await import("../audio/src/forge-music.js"); synth = new mod.ForgeSynth({ identities, project: composer.project || "demo", seed: composer.fingerprint }); } catch (err) { $("music").textContent = "music module unavailable: " + err.message; return; } }
  if (!musicOn) { await synth.enable(); synth.setMuted(false); synth.setVolume(Number($("volume").value) / 100); musicOn = true; $("musicToggle").textContent = "Mute music"; $("music").textContent = "music playing (Forge harmony · Smith rhythm · Scout melody)"; }
  else { synth.setMuted(true); musicOn = false; $("musicToggle").textContent = "Enable music"; $("music").textContent = "music muted"; }
});
$("volume").addEventListener("input", () => { if (synth) synth.setVolume(Number($("volume").value) / 100); });

// ---------- camera ----------
let drag = null;
canvas.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, moved: false }; });
canvas.addEventListener("pointermove", (e) => { if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true; camera.orbit(-dx * 0.005, dy * 0.005); drag.x = e.clientX; drag.y = e.clientY; });
canvas.addEventListener("pointerup", (e) => { if (drag && !drag.moved) pick(e.clientX, e.clientY); drag = null; });
canvas.addEventListener("wheel", (e) => { camera.dolly(Math.exp(e.deltaY * 0.001)); e.preventDefault(); }, { passive: false });

// ---------- inspection, agents, objective, history ----------
function pick(x, y) {
  let best = null;
  for (const { nodeId, screen } of lastScreens) { const p = renderer.pick(screen, x, y, 12); if (p && (!best || p.dist < best.dist)) best = { ...p, nodeId }; }
  selected = best ? { nodeId: best.nodeId, index: best.index } : null;
  renderInspect(); if (ui.mode === "art") { $("history").hidden = false; renderHistory(); }
}
const VER = { 1: "verified", 0: "untested", "-1": "unstable" };
function describeLines(d) {
  const ref = d.vertex.ref || {}, ev = d.event;
  return [
    `<b>${d.node.label}</b> ${d.node.kind === "core" ? "(the objective)" : d.node.agentType || ""}${d.node.model ? " · " + d.node.model : ""}${d.node.parentId ? " · child of " + d.node.parentId : ""}`,
    `<b>material</b> ${VER[d.vertex.verified]} · heat ${d.vertex.heat.toFixed(2)} · vertex #${d.vertex.index} of ${d.node.vertices} · ${d.node.verified} verified, ${d.node.failed} unstable`,
    `<b>created by</b> ${ref.kind || "?"} ${ref.eventId || ""} · replay #${ref.replayIndex ?? "?"}${ref.lastEventId ? `\n<b>last touched by</b> ${ref.lastKind} ${ref.lastEventId}` : ""}`,
    ref.tool || ref.path ? `<b>tool</b> ${ref.tool || "-"} · <b>file</b> ${ref.path || "-"}` : null,
    ref.structure ? `<b>code structure</b> ${ref.structureKind || ""} ${ref.structure}` : null,
    ev ? `<b>event</b> ${ev.label || ev.kind}${ev.payload?.stage ? ` · stage ${ev.payload.stage}` : ""}\n${ev.classification.map((c) => `${c.scheme}=${c.value}@${c.confidence}`).join(" ")}` : null,
    `<b>edges here</b> ${d.edges.map((e) => `${e.edge[0]}-${e.edge[1]} (${e.ref.kind}${e.weight ? ", w " + e.weight.toFixed(2) : ""})`).join(", ")}`,
    `<b>recent history</b> ${d.history.map((h) => h.kind).join(" → ")}`,
    `<b>fingerprint</b> ${d.fingerprint}`,
  ].filter(Boolean);
}
function renderInspect() {
  if (!selected) { $("inspect").textContent = "nothing selected"; $("inspect").className = "mono hint"; return; }
  const d = composer.describe(selected.nodeId, selected.index); if (!d) return;
  $("inspect").innerHTML = describeLines(d).join("\n"); $("inspect").className = "mono";
}
function renderAgents() {
  const items = [];
  for (const n of composer.nodes.values()) {
    if (n.kind === "satellite") continue;
    const color = hsla(n.preset.hue, n.preset.sat, n.preset.light, 1);
    const st = n.kind === "core" ? `objective · ${n.verified.filter((v) => v === 1).length}/${n.verified.length} verified` : `${n.agentType || "main"}${n.docked ? " · returned" : " · active"} · ${n.verified.filter((v) => v === 1).length}/${n.verified.length} verified${n.parentId && n.parentId !== "main" && n.parentId !== "core" ? " · helper" : ""}`;
    items.push(`<li><span class="sw" style="color:${color};background:${color}"></span><span class="nm">${n.preset.label}</span><span class="st">${st}</span><input type="checkbox" data-node="${n.id}" ${ui.hidden.has(n.id) ? "" : "checked"} aria-label="show ${n.preset.label}" /></li>`);
  }
  $("agents").innerHTML = items.join("") || '<li class="hint">waiting for the objective…</li>';
  for (const cb of $("agents").querySelectorAll("input")) cb.addEventListener("change", () => { if (cb.checked) ui.hidden.delete(cb.dataset.node); else ui.hidden.add(cb.dataset.node); });
}
function renderObjective(event) {
  const st = composer.state();
  const stage = event?.payload?.stage || (composer.resolved ? "Objective completed" : composer.task?.title || "");
  $("stage").textContent = composer.task ? `${composer.task.title}${stage ? "  —  " + stage : ""}` : stage;
  const who = event?.actor?.type === "subagent" ? (composer.node("agent:" + event.actor.agentId)?.preset.label || event.actor.agentType) : event?.actor?.type === "main" ? composer.preset(identities.main).label : "";
  $("now").textContent = event?.payload?.label ? `${who ? who + ": " : ""}${event.payload.label}` : event ? `${who} ${event.kind}` : "";
}
function renderHistory() {
  const stages = new Map();
  for (const e of composer.events.values()) { const s = e.payload?.stage; if (!s) continue; if (!stages.has(s)) stages.set(s, []); if (e.label && e.kind !== "tool.call") stages.get(s).push(e); }
  const parts = [];
  if (selected) { const d = composer.describe(selected.nodeId, selected.index); if (d) parts.push(`<div class="h">Selected element</div>` + describeLines(d).slice(0, 6).join("\n")); }
  parts.push(`<div class="h">Story</div>` + [...stages.entries()].map(([s, list]) => `${s}\n` + list.map((e) => `   ${new Date(e.ts).toISOString().slice(11, 19)}  ${e.kind.padEnd(12)} ${e.label}`).join("\n")).join("\n"));
  parts.push(`<div class="h">Structures</div>` + [...composer.nodes.values()].map((n) => `${n.preset.label.padEnd(10)} ${n.kind.padEnd(9)} ${String(n.structure.vertices.length).padStart(4)} v ${String(n.structure.edges.length).padStart(4)} e  verified ${n.verified.filter((v) => v === 1).length}  events ${n.events}${n.parentId ? "  ← " + n.parentId : ""}`).join("\n"));
  $("history").innerHTML = parts.join("\n\n");
}

// ---------- export ----------
function download(blob, name) { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
function savePng() { canvas.toBlob((b) => download(b, `forge-artwork-${composer.fingerprint.slice(0, 8)}.png`)); }
function saveManifest() { const m = { recording: RECORDING, fingerprint: composer.fingerprint, snapshotHash: composer.snapshotHash(), events: events.length, replayPositionMs: position(), resolved: composer.resolved, verifiedFraction: composer.verifiedFraction(), camera: camera.toJSON(), ui: { ...ui, hidden: [...ui.hidden] }, generatedAt: new Date().toISOString(), note: "Deterministic: the same recording and configuration reproduce this snapshotHash." }; download(new Blob([JSON.stringify(m, null, 2)], { type: "application/json" }), `forge-manifest-${composer.fingerprint.slice(0, 8)}.json`); }
$("savePng").addEventListener("click", savePng); $("gPng").addEventListener("click", savePng);
$("saveManifest").addEventListener("click", saveManifest); $("gManifest").addEventListener("click", saveManifest);

// ---------- traces ----------
function sizeTrace() { if (trace.width !== renderer.w || trace.height !== renderer.h) { trace.width = renderer.w; trace.height = renderer.h; clearTrace(); } }
function clearTrace() { tctx.globalCompositeOperation = "source-over"; tctx.fillStyle = "#04050a"; tctx.fillRect(0, 0, trace.width, trace.height); }
function fadeTrace() { tctx.globalCompositeOperation = "source-over"; tctx.fillStyle = "rgba(4,5,10,0.003)"; tctx.fillRect(0, 0, trace.width, trace.height); }
function stampLine(a, b, hue, alpha, width) { const [x0, y0] = renderer.px(a), [x1, y1] = renderer.px(b); tctx.globalCompositeOperation = "lighter"; tctx.strokeStyle = hsla(hue, 60, 55, alpha); tctx.lineWidth = width; tctx.beginPath(); tctx.moveTo(x0, y0); tctx.lineTo(x1, y1); tctx.stroke(); }
function stampRing(c, r, hue, alpha) { const [x, y] = renderer.px(c); tctx.globalCompositeOperation = "lighter"; tctx.strokeStyle = hsla(hue, 55, 50, alpha); tctx.lineWidth = 1; tctx.beginPath(); tctx.arc(x, y, r * renderer.scale, 0, Math.PI * 2); tctx.stroke(); }

// ---------- styling: identity colour + Workshop temperature/verification ----------
function edgeStyle(n, ei, t) {
  const P = n.preset, [a, b] = n.structure.edges[ei];
  const heat = (n.heat[a] + n.heat[b]) / 2, ver = Math.min(n.verified[a], n.verified[b]), bothVer = n.verified[a] === 1 && n.verified[b] === 1;
  let hue = P.hue, sat = P.sat, light = P.light, alpha = 0.5, width = 1.1;
  if (n.kind === "core") { alpha = 0.6 + 0.4 * composer.verifiedFraction(); sat = 55 + 15 * composer.verifiedFraction(); light = 74 + 18 * composer.verifiedFraction(); width = 1.6 + 0.8 * composer.verifiedFraction(); }
  if (P.thermal) { // Smith: hot copper-gold cooling to tempered copper; verified material is crisp and saturated
    hue = mixHue(bothVer ? P.thermal.verifiedHue : P.hue, P.thermal.hotHue, heat); light = (bothVer ? P.light - 4 : P.light) + (P.thermal.hotLight - P.light) * heat; sat = bothVer ? P.thermal.verifiedSat : P.sat;
    if (ver === -1) { hue = P.thermal.failHue; light = 60 + 10 * Math.sin(t * 0.012 + ei); }
  } else { light += 18 * heat; if (ver === -1) { hue = mixHue(hue, 5, 0.7); light = 58 + 8 * Math.sin(t * 0.012 + ei); } }
  if (bothVer) { alpha += 0.3; width += 0.5; } else if (n.kind !== "core") { alpha *= 0.75; }
  const wgt = n.edgeWeight[ei]; if (wgt > 0) { alpha += 0.2 * wgt; width += 0.5 * wgt; light += 5 * wgt; } if (wgt < 0) alpha *= 1 + 0.6 * wgt;
  const st = composer.ripples.edgeState(n.id, a, b, t), glow = (n.glow[a] + n.glow[b]) / 2;
  if (st.energy > 0.01) { hue = mixHue(hue, st.hue ?? hue, Math.min(1, st.energy) * 0.8); light += 28 * Math.min(1, st.energy); alpha = Math.min(1, alpha + 0.5 * Math.abs(st.amp)); width += 1.5 * Math.abs(st.amp); }
  if (glow > 0) { light += 18 * glow; alpha = Math.min(1, alpha + 0.3 * glow); }
  return { hue, sat, light: Math.min(96, light), alpha: alpha * (n.docked ? 0.75 : 1), width, unverified: !bothVer && n.kind !== "core", rippleAmp: Math.abs(st.amp), rippleHue: st.hue };
}

// ---------- frame ----------
function frame(now) {
  const dt = Math.min(100, now - lastFrame); lastFrame = now; fps = fps * 0.95 + (1000 / Math.max(1, dt)) * 0.05;
  const playing = replayer && replayer.state === "playing";
  const advancing = playing || (replayer && replayer.state === "done" && ui.mode === "live");
  if (advancing) sceneClock += dt;
  renderer.resize(); sizeTrace();
  const t = sceneClock;
  if (!ui.reduced && ((ui.orbit && playing) || ui.mode === "art")) camera.orbit(dt * (ui.mode === "art" ? 0.00003 : 0.00004), Math.sin(now * 0.00004) * dt * 0.000006);
  if (ui.mode === "art" && camera.elevation < 0.5) camera.elevation += dt * 0.0001; // look slightly down on the finished piece so the orbit reads around the core
  const resolving = composer.tick(advancing ? dt : 0, t);
  if (composer.resolved && camera.distance < 9.2 && ui.mode === "live") camera.distance += dt * 0.0002;
  if (composer.resolved && ui.autoGallery && ui.mode === "live" && resolving >= 1 && replayer?.state !== "paused" && !galleryEntered) setMode("art");
  if (synth && musicOn) { try { synth.setState?.(composer.state()); synth.tick?.(t / 1000); } catch { /* ignore */ } }

  renderer.begin();
  if (ui.traces) { fadeTrace(); renderer.drawLayer(trace, 0.9, "lighter"); }
  const basis = camera.basis(), centres = new Map(), waitingDim = composer.waiting ? 0.6 : 1;
  lastScreens = [];
  const visible = (n) => !ui.hidden.has(n.id) && !(n.kind === "satellite" && ui.hidden.has(n.parentId)) && !(n.kind === "agent" && n.parentId && n.parentId !== "core" && ui.hidden.has(n.parentId));
  const nodes = [...composer.nodes.values()];
  const screens = new Map();
  for (const n of nodes) { const { points, centre, w } = composer.worldVertices(n); const screen = points.map((p) => camera.project(p, basis)); screens.set(n.id, { screen, w }); centres.set(n.id, camera.project(centre, basis)); if (visible(n)) lastScreens.push({ nodeId: n.id, screen }); }
  // tethers first (behind): agents interlock with the core or their parent
  const ctx = renderer.ctx; ctx.globalCompositeOperation = "lighter";
  for (const n of nodes) {
    if (!visible(n)) continue;
    const me = screens.get(n.id)?.screen;
    for (const th of n.tethers) { const target = composer.node(th.toNodeId); if (!target || !visible(target)) continue; const pa = screens.get(th.toNodeId)?.screen; const a = me?.[th.from], b = pa?.[th.to]; if (!a?.visible || !b?.visible) continue; const [x0, y0] = renderer.px(a), [x1, y1] = renderer.px(b); ctx.strokeStyle = hsla(n.preset.hue, 55, 62, (th.thin ? 0.08 : 0.2) * waitingDim * (n.docked ? 0.8 : 1)); ctx.lineWidth = (th.thin ? 0.6 : 0.9) * renderer.dpr; ctx.setLineDash([3 * renderer.dpr, 6 * renderer.dpr]); ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); ctx.setLineDash([]); }
    if (n.kind === "satellite" && n.anchor) { const pa = screens.get(n.anchor.nodeId)?.screen?.[n.anchor.vertexIndex], c = centres.get(n.id); if (pa?.visible && c?.visible) { const [x0, y0] = renderer.px(pa), [x1, y1] = renderer.px(c); ctx.strokeStyle = hsla(n.preset.hue, 50, 60, 0.25); ctx.lineWidth = renderer.dpr; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); } }
  }
  // structures, far to near
  nodes.sort((a, b) => (centres.get(b.id)?.depth ?? 0) - (centres.get(a.id)?.depth ?? 0));
  for (const n of nodes) {
    if (!visible(n)) continue;
    const { screen, w } = screens.get(n.id), range = WireRenderer.depthRange(screen), P = n.preset;
    // unverified material trembles slightly (Workshop: soft until quenched)
    const jitter = (i) => (n.verified[i] === 1 || n.kind === "core" || ui.reduced) ? screen[i] : { ...screen[i], x: screen[i].x + Math.sin(t * 0.004 + i * 1.7) * 0.0022 * (0.4 + n.heat[i]), y: screen[i].y + Math.cos(t * 0.0035 + i * 2.3) * 0.0022 * (0.4 + n.heat[i]) };
    const sj = screen.map((_, i) => jitter(i));
    if (ui.faces && n.structure.faces.length && n.structure.faces.length <= 1400) renderer.drawFaces(sj, n.structure.faces, (fi) => { const f = n.structure.faces[fi]; const ver = f.every((v) => n.verified[v] === 1); const heat = f.reduce((s, v) => s + n.heat[v], 0) / f.length; return { hue: P.thermal ? mixHue(P.hue, P.thermal.hotHue, heat) : P.hue, sat: P.sat, light: P.light + 10 * heat, alpha: (n.kind === "core" ? 0.04 + 0.06 * composer.verifiedFraction() : P.faceAlpha * (ver ? 1.4 : 0.7)) * waitingDim }; }, { range });
    renderer.drawEdges(sj, n.structure.edges, (ei) => edgeStyle(n, ei, t), { range });
    // trace stamping where ripples pass
    if (ui.traces && composer.ripples.waves.length) for (let ei = 0; ei < n.structure.edges.length; ei += 2) { const [a, b] = n.structure.edges[ei]; const st = composer.ripples.edgeState(n.id, a, b, t); if (Math.abs(st.amp) > 0.5 && sj[a].visible && sj[b].visible) stampLine(sj[a], sj[b], st.hue ?? P.hue, 0.05, 1.2); }
    renderer.drawNodes(sj, (i) => { const g = n.glow[i], heat = n.heat[i], st = composer.ripples.vertexState(n.id, i, t), e = Math.min(1, st.energy), sel = selected && selected.nodeId === n.id && selected.index === i; if (!sel && g < 0.05 && e < 0.05 && heat < 0.35 && n.kind !== "core") return null; if (sel) return { hue: 0, sat: 0, light: 100, alpha: 0.95, radius: 4.5 }; const hue = P.thermal ? mixHue(P.hue, P.thermal.hotHue, heat) : mixHue(P.hue, st.hue ?? P.hue, e); return { hue, sat: n.kind === "core" ? 30 : P.sat, light: P.light + 12 + 10 * heat, alpha: (n.kind === "core" ? 0.12 + 0.35 * composer.verifiedFraction() : 0.3 * g + 0.45 * e + 0.25 * Math.max(0, heat - 0.35)) * waitingDim, radius: n.kind === "core" ? 2.4 : 2 + 2 * e + 1.5 * heat }; }, { range });
  }
  // the core's luminous heart
  const cc = centres.get("core"); if (cc?.visible && composer.core && visible(composer.core)) { const [x, y] = renderer.px(cc); const r = (34 + 40 * composer.verifiedFraction()) * renderer.dpr * (0.9 + 0.1 * Math.sin(t * 0.0015)); const g = ctx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, hsla(48, 60, 92, 0.35 + 0.4 * composer.verifiedFraction())); g.addColorStop(0.4, hsla(44, 55, 70, 0.12)); g.addColorStop(1, hsla(40, 50, 60, 0)); ctx.globalCompositeOperation = "lighter"; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
  // rings into the empty field
  for (const r of composer.ripples.activeRings(t)) { const c = centres.get(r.nodeId) || cc; if (!c?.visible) continue; renderer.drawRing(c, r.radius, { hue: r.hue, alpha: r.alpha * waitingDim, width: r.width }); if (ui.traces && r.u > 0.3 && r.u < 0.9) stampRing(c, r.radius, r.hue, 0.02); }
  for (const x of composer.ripples.interferences(t)) renderer.drawRing(x.point, 0.012, { hue: x.hue, alpha: Math.min(0.6, x.alpha * 1.5), width: 2 });
  const stats = renderer.end();
  slow = stats.ms > 14 ? slow + 1 : 0; fast = stats.ms < 7 ? fast + 1 : 0;
  if (slow > 30 && renderer.glow) { renderer.glow = false; slow = 0; } else if (fast > 120 && !renderer.glow) { renderer.glow = true; fast = 0; }

  // HUD
  if (replayer) { const p = position(), d = replayer.duration || 1; if (!drag) $("seek").value = Math.round((p / d) * 1000); $("time").textContent = `${mmss(p)} / ${mmss(d)}`; }
  const st = composer.state(), cx = composer.complexity();
  $("readout").textContent = `fps ${fps.toFixed(0)} · frame ${stats.ms.toFixed(1)} ms · edges ${stats.edges}${renderer.glow ? "" : " (glow off)"}\nverified ${(st.verifiedFraction * 100).toFixed(0)}% · tension ${st.tension.toFixed(2)} · ${st.phase}${st.waiting ? " (waiting)" : ""}\nstructures ${cx.nodes} · vertices ${cx.vertices} · waves ${cx.waves} · rings ${cx.rings}\nfingerprint ${composer.fingerprint.slice(0, 16)}…${lastMusic ? `\nmusic ${lastMusic.phase || ""} · ${lastMusic.bpm || ""} bpm · chord ${lastMusic.chord?.degree ?? lastMusic.chord?.index ?? ""}` : ""}`;
  if (selected && (now | 0) % 15 === 0) renderInspect();
  requestAnimationFrame(frame);
}
const mmss = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

addEventListener("resize", () => { renderer.resize(); sizeTrace(); });
renderer.resize(); sizeTrace();
await load();
requestAnimationFrame(frame);
window.forgeSession = { composer: () => composer, camera, renderer, ui, jumpToFinale, rebuildTo, setMode, replayer: () => replayer, synth: () => synth, music: () => lastMusic };
