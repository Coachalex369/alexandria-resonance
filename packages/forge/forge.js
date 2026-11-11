// The Forge page: replays a recording through the Composer, renders the composition with the Canvas
// WireRenderer (structures, tethers, ripple-blended edges, rings into the empty field, persistent traces),
// supports vertex inspection (provenance), optional procedural music, deterministic manifests and PNG export.
// All logic that decides geometry lives in src/composer.js; this file is wiring, drawing and UI only.
import { Replayer } from "../event-engine/src/replay.js";
import { Camera } from "../geometry/src/projection.js";
import { WireRenderer, hsla } from "./src/render2d.js";
import { Composer } from "./src/composer.js";
import { mixHue } from "./src/ripples.js";

const $ = (id) => document.getElementById(id);
const canvas = $("cv");
const RECORDINGS = ["forge-demo-session.events.jsonl", "synthetic-multi-agent.events.jsonl"];

const [mapping, identities] = await Promise.all([fetch("forge-mapping.json", { cache: "no-store" }).then((r) => r.json()), fetch("identities.json", { cache: "no-store" }).then((r) => r.json())]);

const prefersReduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const ui = { orbit: !prefersReduced, faces: true, traces: true, reduced: prefersReduced, palette: "identity", quality: 1 };
$("orbit").checked = ui.orbit; $("reduced").checked = ui.reduced;

const renderer = new WireRenderer(canvas, { background: "#05060a", glow: true });
const camera = new Camera({ azimuth: 0.7, elevation: 0.3, distance: 6.2, fov: 0.85 });
let composer = new Composer({ mapping, identities });
let replayer = null, events = [], recordingName = "";
let sceneClock = 0, lastFrame = performance.now(), fps = 60;
let selected = null; // { nodeId, index }
let slow = 0, fast = 0; // adaptive-quality counters
let synth = null, synthLoaded = false, lastMusic = null;
const trace = document.createElement("canvas"); const tctx = trace.getContext("2d");
const agentIndex = new Map();

// ---------- loading ----------
const parseJsonl = (t) => t.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e && e.kind && e.ts);
async function loadRecording(name) {
  const res = await fetch("/demo/recordings/" + name, { cache: "no-store" });
  events = parseJsonl(await res.text()); recordingName = name;
  if (replayer) replayer.pause();
  composer = new Composer({ mapping, identities, events, config: { palette: ui.palette } });
  if (synth) { synth.opts.project = composer.project || "alexandria"; synth.setSeed(composer.fingerprint); }
  agentIndex.clear(); selected = null; renderInspect(); clearTrace(); camera.distance = 6.2;
  sceneClock = 0;
  replayer = new Replayer(events, { speed: Number($("speed").value) });
  replayer.on("event", ({ event, index }) => onEvent(event, index));
  replayer.on("state", updatePlay);
  $("seek").value = 0; updatePlay(); replayer.start();
}
function onEvent(event, index) {
  composer.ingest(event, sceneClock, index);
  if (event.actor?.type === "subagent" && !agentIndex.has(event.actor.agentId)) agentIndex.set(event.actor.agentId, agentIndex.size);
  if (synth) {
    const identity = composer.identityFor(event.actor);
    const nodeId = event.actor?.type === "subagent" ? "agent:" + event.actor.agentId : "main";
    try { lastMusic = synth.onEvent(event, { identity, agentIndex: event.actor?.type === "subagent" ? agentIndex.get(event.actor.agentId) : 0, nodeId, t: sceneClock / 1000 }); } catch (e) { console.warn("music", e); }
  }
  renderAgents();
}

// ---------- transport ----------
function updatePlay() { $("play").textContent = replayer && replayer.state === "playing" ? "Pause" : replayer && replayer.state === "done" ? "Replay" : "Play"; }
function position() { if (!replayer) return 0; let p = replayer.position; if (replayer.state === "playing" && replayer.wallAnchor != null) p += (replayer.now() - replayer.wallAnchor) * replayer.speed; return Math.min(replayer.duration, Math.max(0, p)); }
$("play").addEventListener("click", () => { if (!replayer) return; if (replayer.state === "playing") replayer.pause(); else if (replayer.state === "done") loadRecording(recordingName); else if (replayer.state === "paused") replayer.resume(); else replayer.start(); });
$("speed").addEventListener("input", () => { $("speedv").textContent = $("speed").value + "x"; if (replayer) replayer.setSpeed(Number($("speed").value)); });
$("seek").addEventListener("change", () => { if (!replayer) return; const target = (Number($("seek").value) / 1000) * replayer.duration; const wasPlaying = replayer.state === "playing"; if (wasPlaying) replayer.pause(); composer = new Composer({ mapping, identities, events, config: { palette: ui.palette } }); agentIndex.clear(); clearTrace(); replayer.index = 0; replayer.seek(target); replayer.wallAnchor = null; if (replayer.state === "done" || replayer.state === "idle") replayer.setState("paused"); if (wasPlaying) replayer.resume(); });
for (const name of RECORDINGS) { const o = document.createElement("option"); o.value = o.textContent = name; $("recording").appendChild(o); }
$("recording").addEventListener("change", () => loadRecording($("recording").value));
for (const [id, key] of [["orbit", "orbit"], ["facesOn", "faces"], ["traceOn", "traces"], ["reduced", "reduced"]]) $(id).addEventListener("change", () => { ui[key] = $(id).checked; if (key === "reduced" && ui.reduced) { ui.orbit = false; $("orbit").checked = false; } });
$("palette").addEventListener("change", () => { ui.palette = $("palette").value; });
$("quality").addEventListener("change", () => { renderer.quality = Number($("quality").value); renderer.resize(); sizeTrace(); });

// ---------- audio (optional, off by default, independent of other apps' alerts) ----------
$("audioEnable").addEventListener("click", async () => {
  if (!synthLoaded) { synthLoaded = true; try { const mod = await import("../audio/src/forge-music.js"); synth = new mod.ForgeSynth({ identities, project: composer.project, seed: composer.fingerprint }); } catch (e) { $("music").textContent = "music module not available: " + e.message; return; } }
  await synth.enable(); synth.setMuted($("mute").checked); synth.setVolume(Number($("volume").value) / 100);
  $("music").textContent = $("mute").checked ? "audio enabled, muted (untick to hear)" : "audio playing";
});
$("mute").addEventListener("change", () => { if (synth) synth.setMuted($("mute").checked); $("music").textContent = synth ? ($("mute").checked ? "audio enabled, muted" : "audio playing") : "audio off"; });
$("volume").addEventListener("input", () => { if (synth) synth.setVolume(Number($("volume").value) / 100); });

// ---------- camera interaction ----------
let drag = null;
canvas.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, moved: false }; });
canvas.addEventListener("pointermove", (e) => { if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true; camera.orbit(-dx * 0.005, dy * 0.005); drag.x = e.clientX; drag.y = e.clientY; });
canvas.addEventListener("pointerup", (e) => { if (drag && !drag.moved) pick(e.clientX, e.clientY); drag = null; });
canvas.addEventListener("wheel", (e) => { camera.dolly(Math.exp(e.deltaY * 0.001)); e.preventDefault(); }, { passive: false });

// ---------- inspection ----------
let lastScreens = []; // [{ nodeId, screen }]
function pick(x, y) {
  let best = null;
  for (const { nodeId, screen } of lastScreens) { const p = renderer.pick(screen, x, y, 12); if (p && (!best || p.dist < best.dist)) best = { ...p, nodeId }; }
  selected = best ? { nodeId: best.nodeId, index: best.index } : null;
  renderInspect();
}
function renderInspect() {
  if (!selected) { $("inspect").textContent = "nothing selected"; $("inspect").className = "mono dim"; return; }
  const d = composer.describe(selected.nodeId, selected.index); if (!d) return;
  const ref = d.vertex.ref || {}; const ev = d.event;
  const lines = [
    `<b>structure</b> ${d.node.id} (${d.node.label}${d.node.agentType ? ", " + d.node.agentType : ""}${d.node.model ? ", " + d.node.model : ""})`,
    `<b>seed</b> ${d.node.seed}  <b>stage</b> ${d.node.stage}  <b>growth</b> ${d.node.growth}  <b>events</b> ${d.node.events}${d.node.docked ? "  docked" : ""}`,
    `<b>parent</b> ${d.node.parentId || "(root)"}  <b>vertex</b> #${d.vertex.index} of ${d.node.vertices}  <b>glow</b> ${d.vertex.glow.toFixed(2)}`,
    `<b>created by</b> ${ref.kind || "?"} ${ref.eventId || ""}  @ ${ref.ts || "?"}  replay #${ref.replayIndex ?? "?"}`,
    ref.lastEventId ? `<b>last touched by</b> ${ref.lastKind} ${ref.lastEventId} @ ${ref.lastTs}` : null,
    ref.tool || ref.path ? `<b>tool</b> ${ref.tool || "-"}  <b>path</b> ${ref.path || "-"}` : null,
    ref.structure ? `<b>code structure</b> ${ref.structureKind || ""} ${ref.structure}` : null,
    d.task ? `<b>task</b> ${d.task.id} ${d.task.title || ""}` : null,
    ev ? `<b>event</b> ${ev.kind} actor=${ev.actor?.type}${ev.actor?.agentType ? "/" + ev.actor.agentType : ""} ${ev.payload ? JSON.stringify(ev.payload) : ""} ${ev.classification.map((c) => c.scheme + "=" + c.value + "@" + c.confidence).join(" ")}` : null,
    `<b>edges here</b> ${d.edges.map((e) => `${e.edge[0]}-${e.edge[1]} (${e.ref.kind}, w ${e.weight.toFixed(2)})`).join(", ")}`,
    `<b>fingerprint</b> ${d.fingerprint}`,
  ].filter(Boolean);
  $("inspect").innerHTML = lines.join("\n"); $("inspect").className = "mono";
}
function renderAgents() {
  const items = [];
  for (const n of composer.nodes.values()) {
    if (n.kind !== "agent") continue;
    const color = hsla(n.preset.hue, n.preset.sat, n.preset.light, 1);
    items.push(`<li><span class="swatch" style="color:${color};background:${color}"></span><span class="name">${n.preset.label}</span> <span class="dim">${n.agentType || "main"}${n.model ? " · " + n.model : ""} · ${n.structure.vertices.length}v/${n.structure.edges.length}e · stage ${n.stage}${n.docked ? " · docked" : ""}${n.satellites.length ? " · +" + n.satellites.length + " sat" : ""}</span></li>`);
  }
  $("agents").innerHTML = items.join("") || '<li class="dim">waiting for task.start</li>';
}

// ---------- export ----------
$("manifest").addEventListener("click", () => {
  const manifest = { recording: recordingName, fingerprint: composer.fingerprint, snapshotHash: composer.snapshotHash(), events: events.length, replayPositionMs: position(), camera: camera.toJSON(), ui, mappingVersion: "forge-mapping.json", identities: Object.keys(identities.presets), generatedAt: new Date().toISOString(), note: "Deterministic: the same recording + configuration reproduce this snapshotHash." };
  download(new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" }), `forge-manifest-${composer.fingerprint.slice(0, 8)}.json`);
});
$("png").addEventListener("click", () => canvas.toBlob((b) => download(b, `forge-${composer.fingerprint.slice(0, 8)}.png`)));
function download(blob, name) { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }

// ---------- traces (persistent field, bounded) ----------
function sizeTrace() { if (trace.width !== renderer.w || trace.height !== renderer.h) { trace.width = renderer.w; trace.height = renderer.h; clearTrace(); } }
function clearTrace() { tctx.globalCompositeOperation = "source-over"; tctx.fillStyle = "#05060a"; tctx.fillRect(0, 0, trace.width, trace.height); }
function fadeTrace() { tctx.globalCompositeOperation = "source-over"; tctx.fillStyle = "rgba(5,6,10,0.006)"; tctx.fillRect(0, 0, trace.width, trace.height); }
function stampLine(a, b, hue, alpha, width) { const [x0, y0] = renderer.px(a), [x1, y1] = renderer.px(b); tctx.globalCompositeOperation = "lighter"; tctx.strokeStyle = hsla(hue, 60, 55, alpha); tctx.lineWidth = width; tctx.beginPath(); tctx.moveTo(x0, y0); tctx.lineTo(x1, y1); tctx.stroke(); }
function stampRing(c, r, hue, alpha) { const [x, y] = renderer.px(c); tctx.globalCompositeOperation = "lighter"; tctx.strokeStyle = hsla(hue, 55, 50, alpha); tctx.lineWidth = 1; tctx.beginPath(); tctx.arc(x, y, r * renderer.scale, 0, Math.PI * 2); tctx.stroke(); }

// ---------- frame ----------
function frame(now) {
  const dt = Math.min(100, now - lastFrame); lastFrame = now;
  fps = fps * 0.95 + (1000 / Math.max(1, dt)) * 0.05;
  const playing = replayer && replayer.state === "playing";
  if (playing || (replayer && replayer.state === "done")) sceneClock += dt;
  renderer.resize(); sizeTrace();
  if (ui.orbit && !ui.reduced && playing) camera.orbit(dt * 0.00004, Math.sin(now * 0.00005) * dt * 0.000008);
  const resolving = composer.tick(playing || !replayer ? dt : 0, sceneClock);
  if (composer.resolved && camera.distance < 7.5) camera.distance += dt * 0.00025; // pull back to reveal the whole composition
  if (synth && playing) try { synth.tick?.(sceneClock / 1000); } catch { /* ignore */ }

  const t = sceneClock, waitingDim = composer.waiting ? 0.55 : 1;
  renderer.begin();
  if (ui.traces) { fadeTrace(); renderer.drawLayer(trace, 0.9, "lighter"); }
  const basis = camera.basis();
  lastScreens = [];
  const centres = new Map();
  // nodes
  for (const n of composer.nodes.values()) {
    const { points, w, centre } = composer.worldVertices(n);
    const screen = points.map((p) => camera.project(p, basis));
    centres.set(n.id, camera.project(centre, basis));
    lastScreens.push({ nodeId: n.id, screen });
    const range = WireRenderer.depthRange(screen);
    const P = n.preset, sub = n.id !== "main" && n.kind === "agent";
    const baseAlpha = (n.docked ? 0.55 : 0.9) * waitingDim * (n.kind === "satellite" ? 0.8 : 1);
    const wRange = w ? [Math.min(...w), Math.max(...w)] : null;
    const hueFor = (ref, i) => {
      let h = P.hue;
      if (ui.palette !== "identity-only") { const ev = ref?.lastEventId ? composer.events.get(ref.lastEventId) : composer.events.get(ref?.eventId); const cat = ev?.classification?.find((c) => c.scheme === "work-category")?.value; const ch = cat ? mapping.categories[cat]?.hue : null; if (ch != null) h = ui.palette === "category" ? ch : mixHue(P.hue, ch, 0.35); }
      if (wRange && wRange[1] > wRange[0]) h += 40 * ((w[i] - wRange[0]) / (wRange[1] - wRange[0]) - 0.5); // 4D depth tint
      return h;
    };
    if (ui.faces && n.structure.faces.length && n.structure.faces.length <= 1400) renderer.drawFaces(screen, n.structure.faces, (fi) => { const f = n.structure.faces[fi]; return { hue: hueFor(n.refs.vertices[f[0]], f[0]), sat: P.sat, light: P.light, alpha: P.faceAlpha * baseAlpha * (1 + 0.5 * resolving) }; }, { range });
    renderer.drawEdges(screen, n.structure.edges, (ei) => {
      const [a, b] = n.structure.edges[ei]; const st = composer.ripples.edgeState(n.id, a, b, t);
      let hue = hueFor(n.refs.edges[ei], a), light = P.light, alpha = 0.55 * baseAlpha, width = 1.1;
      const wgt = n.edgeWeight[ei];
      if (wgt > 0) { alpha += 0.25 * wgt; width += 0.6 * wgt; light += 6 * wgt; }
      if (wgt < 0) { alpha *= 1 + 0.6 * wgt * (0.5 + 0.5 * Math.sin(t * 0.02 + ei)); hue = mixHue(hue, 5, -wgt * 0.7); }
      if (st.energy > 0.01) { hue = mixHue(hue, st.hue ?? hue, Math.min(1, st.energy)); light += 30 * Math.min(1, st.energy); alpha = Math.min(1, alpha + 0.5 * Math.abs(st.amp)); width += 1.6 * Math.abs(st.amp); if (ui.traces && Math.abs(st.amp) > 0.55 && screen[a].visible && screen[b].visible) stampLine(screen[a], screen[b], hue, 0.035, 1.2); }
      const g = (n.glow[a] + n.glow[b]) / 2; if (g > 0) { light += 20 * g; alpha = Math.min(1, alpha + 0.3 * g); }
      return { hue, sat: P.sat, light: Math.min(95, light), alpha, width };
    }, { range });
    renderer.drawNodes(screen, (i) => { const g = n.glow[i], st = composer.ripples.vertexState(n.id, i, t); const e = Math.min(1, st.energy); if (g < 0.05 && e < 0.05 && !(selected && selected.nodeId === n.id && selected.index === i)) return null; const sel = selected && selected.nodeId === n.id && selected.index === i; return { hue: sel ? 0 : mixHue(hueFor(n.refs.vertices[i], i), st.hue ?? P.hue, e), sat: sel ? 0 : P.sat, light: sel ? 100 : P.light + 10, alpha: sel ? 0.95 : (0.35 * g + 0.5 * e) * baseAlpha, radius: sel ? 4 : 2 + 2 * e }; }, { range });
  }
  // tethers: agents interlock with their parent; satellites with their anchor
  const ctx = renderer.ctx; ctx.globalCompositeOperation = "lighter"; ctx.lineWidth = 0.8 * renderer.dpr;
  for (const n of composer.nodes.values()) {
    if (n.kind === "agent" && n.parentId) {
      const me = lastScreens.find((s) => s.nodeId === n.id)?.screen, pa = lastScreens.find((s) => s.nodeId === n.parentId)?.screen; if (!me || !pa) continue;
      for (const th of n.tethers) { const a = me[th.from], b = pa[th.to]; if (!a?.visible || !b?.visible) continue; const [x0, y0] = renderer.px(a), [x1, y1] = renderer.px(b); ctx.strokeStyle = hsla(n.preset.hue, 50, 60, 0.18 * waitingDim); ctx.setLineDash([3 * renderer.dpr, 5 * renderer.dpr]); ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); ctx.setLineDash([]); }
    }
    if (n.kind === "satellite" && n.anchor) {
      const pa = lastScreens.find((s) => s.nodeId === n.anchor.nodeId)?.screen?.[n.anchor.vertexIndex], c = centres.get(n.id); if (!pa?.visible || !c?.visible) continue;
      const [x0, y0] = renderer.px(pa), [x1, y1] = renderer.px(c); ctx.strokeStyle = hsla(n.preset.hue, 50, 60, 0.25); ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    }
  }
  // rings into the empty field, centred on the originating structure; interference points blend colour
  for (const r of composer.ripples.activeRings(t)) {
    const c = centres.get(r.nodeId) || { x: 0, y: 0, visible: true }; if (!c.visible) continue;
    renderer.drawRing(c, r.radius, { hue: r.hue, alpha: r.alpha * waitingDim, width: r.width });
    if (ui.traces && r.u > 0.3 && r.u < 0.9) stampRing(c, r.radius, r.hue, 0.012);
  }
  for (const x of composer.ripples.interferences(t)) renderer.drawRing(x.point, 0.012, { hue: x.hue, alpha: Math.min(0.6, x.alpha * 1.5), width: 2 });
  const stats = renderer.end();
  // adaptive quality: drop the glow pass when frames run long, restore it when there is headroom
  slow = stats.ms > 14 ? slow + 1 : 0; fast = stats.ms < 7 ? fast + 1 : 0;
  if (slow > 30 && renderer.glow) { renderer.glow = false; slow = 0; } else if (fast > 120 && !renderer.glow) { renderer.glow = true; fast = 0; }

  // readout
  if (replayer) { const p = position(), d = replayer.duration || 1; if (!drag) $("seek").value = Math.round((p / d) * 1000); $("pos").textContent = `${mmss(p)} / ${mmss(d)}  ${replayer.index}/${events.length} events${composer.waiting ? "  · waiting (permission)" : ""}${composer.resolved ? "  · resolved" : ""}`; }
  const cx = composer.complexity();
  $("readout").textContent = `fps ${fps.toFixed(0)}  frame ${stats.ms.toFixed(1)} ms  drawn edges ${stats.edges} faces ${stats.faces}\nstructures ${cx.nodes}  vertices ${cx.vertices}  edges ${cx.edges}  waves ${cx.waves} rings ${cx.rings}\nfingerprint ${composer.fingerprint.slice(0, 16)}…  task ${composer.task?.id || "-"}${composer.resolved ? " (resolved)" : ""}\ncamera az ${camera.azimuth.toFixed(2)} el ${camera.elevation.toFixed(2)} d ${camera.distance.toFixed(1)}${lastMusic ? `\nmusic ${lastMusic.phase || ""} bpm ${lastMusic.bpm || ""} notes ${lastMusic.notes?.length ?? 0}` : ""}`;
  if (selected && (now | 0) % 20 === 0) renderInspect();
  requestAnimationFrame(frame);
}
const mmss = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

addEventListener("resize", () => { renderer.resize(); sizeTrace(); });
renderer.resize(); sizeTrace();
await loadRecording(RECORDINGS[0]);
requestAnimationFrame(frame);
window.forge = { composer: () => composer, camera, renderer, ui };
