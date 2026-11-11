// Alexandria Resonance - geometric visualizer prototype (Canvas 2D renderer + UI wiring).
// Scene/state logic lives in scene.js; this file only loads recordings, drives time and draws primitives.
//
// mapping.json keys (read at startup; the taxonomy hints are the defaults, these override them):
//   categoryHue      { "<work-category>": hueDegrees }  override the taxonomy hue of a work-category.
//   shapeSizes       { "<shape>"|"default": unitSize }  element size per shape (unit space: 1 = canvas radius).
//   motionSpeeds     { "<motion>": multiplier }         life-progress speed per motion
//                                                       (drift sweep pulse bloom spin split hold flash stack seal tick).
//   layerOpacity     { persistent, continuous, lanes }  per-layer opacity multipliers (0..1).
//   timing           { intervalWindow, minPeriodMs, maxPeriodMs, elementLifeMs:[min,max], laneResolveMs }
//                    intervalWindow = number of recent event gaps averaged to set the pulse period;
//                    min/maxPeriodMs clamp it; elementLifeMs bounds an element's life; laneResolveMs = lane close animation.
//   palettes         { active, presets:{ name:{ hueShift, saturation, lightness, neutralHue, neutralSaturation,
//                      subagentLightnessDelta, subagentSaturationScale, subagentAlpha, failHue, background } } }
//                    palette presets are selectable in the UI; subagent* keys make the lane palette dimmer.
import { Replayer, LiveState } from "../event-engine/src/replay.js";
import { Scene } from "./scene.js";

const $ = (id) => document.getElementById(id);
const canvas = $("c"), ctx = canvas.getContext("2d");
const RECORDINGS = ["synthetic-multi-agent.events.jsonl"];
const LIVE_FILE = "/demo/recordings/live-hooks.events.jsonl";

let mapping = {};
try { mapping = await (await fetch("mapping.json", { cache: "no-store" })).json(); } catch (e) { console.warn("mapping.json not loaded, using defaults", e); }

let scene = new Scene({ mapping });
let live = new LiveState();
let replayer = null;
let sceneClock = 0;       // scene time (ms); frozen while paused
let lastFrame = performance.now();
let liveTail = { on: false, lines: 0, timer: null };
let label = "";

// ---------- loading ----------
const parseJsonl = (text) => text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e && e.kind && e.ts);

function loadEvents(events, name) {
  stopLive();
  label = name;
  if (replayer) replayer.pause();
  scene.reset(); live = new LiveState();
  replayer = new Replayer(events, { speed: Number($("speed").value) });
  replayer.on("event", ({ event }) => { live.apply(event); scene.ingest(event, sceneClock); });
  replayer.on("state", updatePlayButton);
  $("seek").value = 0;
  updatePlayButton();
  replayer.start();
}

async function loadUrl(name) {
  const res = await fetch("/demo/recordings/" + name, { cache: "no-store" });
  if (!res.ok) throw new Error(name + ": " + res.status);
  loadEvents(parseJsonl(await res.text()), name);
}

// ---------- transport ----------
function updatePlayButton() { $("play").textContent = replayer && replayer.state === "playing" ? "Pause" : replayer && replayer.state === "done" ? "Replay" : "Play"; }

function position() {
  if (!replayer) return 0;
  let p = replayer.position;
  if (replayer.state === "playing" && replayer.wallAnchor != null) p += (replayer.now() - replayer.wallAnchor) * replayer.speed;
  return Math.min(replayer.duration, Math.max(0, p));
}

function seekTo(ms) {
  if (!replayer) return;
  const wasPlaying = replayer.state === "playing";
  if (wasPlaying) replayer.pause();
  scene.reset(); live = new LiveState();
  replayer.index = 0;
  replayer.seek(ms); // delivers every event up to ms (scene ingests them as arrivals, then we settle them)
  replayer.wallAnchor = null;
  scene.elements = []; scene.pulses = []; // fast-forwarded events leave state, not animation debris
  if (replayer.state === "done" || replayer.state === "idle") replayer.setState("paused");
  if (wasPlaying) replayer.resume();
}

$("play").addEventListener("click", () => {
  if (liveTail.on || !replayer) return;
  if (replayer.state === "playing") replayer.pause();
  else if (replayer.state === "paused") replayer.resume();
  else if (replayer.state === "done") seekTo(0);
  else replayer.start();
});
$("speed").addEventListener("change", () => replayer && replayer.setSpeed(Number($("speed").value)));
let seeking = false;
$("seek").addEventListener("input", () => { seeking = true; if (replayer) seekTo(($("seek").value / 1000) * replayer.duration); seeking = false; });

$("file").addEventListener("change", async (ev) => {
  const f = ev.target.files[0]; if (!f) return;
  loadEvents(parseJsonl(await f.text()), f.name);
});
$("rec").addEventListener("change", () => loadUrl($("rec").value).catch(console.error));
$("palette").addEventListener("change", () => scene.setPalette($("palette").value));

// ---------- live tail ----------
function stopLive() { if (liveTail.timer) clearInterval(liveTail.timer); liveTail = { on: false, lines: 0, timer: null }; $("live").checked = false; }

async function pollLive(first) {
  try {
    const res = await fetch(LIVE_FILE, { cache: "no-store" });
    if (!res.ok) return;
    const lines = (await res.text()).split("\n").filter((l) => l.trim());
    const fresh = lines.slice(liveTail.lines);
    liveTail.lines = lines.length;
    const events = parseJsonl(fresh.join("\n")).sort((a, b) => a.ts.localeCompare(b.ts));
    events.forEach((e, i) => {
      live.apply(e);
      // existing history is applied quietly; new lines are spread over the poll interval so they animate smoothly
      scene.ingest(e, sceneClock, first ? { quiet: true } : { delay: (i / Math.max(1, events.length)) * 1800 });
    });
  } catch (e) { console.warn("live poll failed", e); }
}

$("live").addEventListener("change", async () => {
  if (!$("live").checked) { stopLive(); return; }
  if (replayer) replayer.pause();
  scene.reset(); live = new LiveState(); replayer = null; label = "live tail";
  liveTail = { on: true, lines: 0, timer: null };
  $("live").checked = true;
  await pollLive(true);
  liveTail.timer = setInterval(() => pollLive(false), 2000);
});

// ---------- drawing ----------
function poly(n, r, rot = 0) { ctx.beginPath(); for (let i = 0; i < n; i++) { const a = rot + (i / n) * Math.PI * 2 - Math.PI / 2; ctx[i ? "lineTo" : "moveTo"](Math.cos(a) * r, Math.sin(a) * r); } ctx.closePath(); }
function lines(pts) { ctx.beginPath(); pts.forEach(([x, y], i) => ctx[i ? "lineTo" : "moveTo"](x, y)); }

function shapePath(shape, r) {
  switch (shape) {
    case "polygon": poly(5, r); break;
    case "triangle": poly(3, r); break;
    case "square": poly(4, r, Math.PI / 4); break;
    case "diamond": poly(4, r); break;
    case "hexagon": poly(6, r); break;
    case "petal": ctx.beginPath(); ctx.moveTo(0, -r); ctx.quadraticCurveTo(r * 0.9, 0, 0, r); ctx.quadraticCurveTo(-r * 0.9, 0, 0, -r); break;
    case "zigzag": lines([[-r, r * 0.5], [-r * 0.5, -r * 0.5], [0, r * 0.5], [r * 0.5, -r * 0.5], [r, r * 0.5]]); break;
    case "shield": ctx.beginPath(); ctx.moveTo(-r, -r * 0.8); ctx.lineTo(r, -r * 0.8); ctx.lineTo(r, 0); ctx.quadraticCurveTo(r * 0.8, r * 0.8, 0, r); ctx.quadraticCurveTo(-r * 0.8, r * 0.8, -r, 0); ctx.closePath(); break;
    case "arrow": lines([[-r, 0], [r, 0], [r * 0.4, -r * 0.5], [r, 0], [r * 0.4, r * 0.5]]); break;
    case "line": lines([[-r, 0], [r, 0]]); break;
    case "arc": ctx.beginPath(); ctx.arc(0, 0, r, Math.PI * 0.15, Math.PI * 0.85, true); break;
    case "gear": { const pts = []; for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2, rr = i % 2 ? r * 0.7 : r; pts.push([Math.cos(a) * rr, Math.sin(a) * rr]); } lines(pts); ctx.closePath(); break; }
    case "wave": ctx.beginPath(); for (let i = 0; i <= 12; i++) { const x = -r + (2 * r * i) / 12; ctx[i ? "lineTo" : "moveTo"](x, Math.sin((i / 12) * Math.PI * 2) * r * 0.4); } break;
    case "bars": ctx.beginPath(); for (const [x, h] of [[-r * 0.6, 0.5], [0, 1], [r * 0.6, 0.7]]) { ctx.moveTo(x, r); ctx.lineTo(x, r - h * 2 * r); } break;
    case "dot-grid": ctx.beginPath(); for (const x of [-0.6, 0, 0.6]) for (const y of [-0.6, 0, 0.6]) { ctx.moveTo(x * r + r * 0.12, y * r); ctx.arc(x * r, y * r, r * 0.12, 0, Math.PI * 2); } break;
    default: ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2);
  }
}

const hsla = (p, a = p.alpha, dl = 0) => `hsla(${p.hue},${p.sat}%,${p.light + dl}%,${Math.max(0, Math.min(1, a))})`;

function draw(prims, W, H, dpr) {
  const bg = scene.palette.background;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = bg; ctx.fillRect(0, 0, canvas.width, canvas.height);
  const R = Math.min(W, H) * 0.46;
  ctx.setTransform(dpr, 0, 0, dpr, W * dpr / 2, H * dpr / 2);
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  // faint centre glow keeps the dark field from looking flat
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
  g.addColorStop(0, "rgba(120,140,180,0.06)"); g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill();

  for (const p of prims) {
    if (p.alpha <= 0.003) continue;
    ctx.save();
    ctx.translate(p.x * R, p.y * R);
    ctx.lineWidth = p.width * 1.1;
    ctx.strokeStyle = hsla(p); ctx.fillStyle = hsla(p, p.alpha * 0.25);
    switch (p.type) {
      case "shape": ctx.rotate(p.rot || 0); shapePath(p.shape, p.size * R); ctx.fill(); ctx.stroke(); break;
      case "ring": ctx.beginPath(); ctx.arc(0, 0, p.size * R, 0, Math.PI * 2); ctx.stroke(); break;
      case "lane": {
        const r = p.size * R, sweep = Math.PI * 2 * p.open;
        ctx.beginPath(); ctx.arc(0, 0, r, p.theta, p.theta + sweep); ctx.setLineDash([2, 6]); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = hsla(p, p.alpha * 1.6, 10); ctx.beginPath(); ctx.arc(Math.cos(p.theta) * r, Math.sin(p.theta) * r, 2.2, 0, Math.PI * 2); ctx.fill(); // orbiting head
        break;
      }
      case "crack": { // failed work: a small red fracture
        const s = p.size * R * 1.6;
        ctx.beginPath(); ctx.moveTo(-s, -s * 0.6); ctx.lineTo(-s * 0.2, -s * 0.1); ctx.lineTo(s * 0.1, -s * 0.5); ctx.lineTo(s * 0.3, s * 0.2); ctx.lineTo(s, s * 0.6);
        ctx.moveTo(-s * 0.2, -s * 0.1); ctx.lineTo(-s * 0.5, s * 0.6); ctx.stroke();
        ctx.beginPath(); ctx.arc(0, 0, s * 0.9, 0, Math.PI * 2); ctx.strokeStyle = hsla(p, p.alpha * 0.4); ctx.stroke();
        break;
      }
      case "seal": { // commit: concentric ring with a notched star
        const s = p.size * R;
        ctx.beginPath(); ctx.arc(0, 0, s, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2, rr = i % 2 ? s * 0.45 : s * 0.8; ctx[i ? "lineTo" : "moveTo"](Math.cos(a) * rr, Math.sin(a) * rr); } ctx.closePath(); ctx.fill(); ctx.stroke();
        break;
      }
      case "frame": { // closing frame, drawn in progressively around the composition
        const s = p.size * R, c = 14;
        ctx.beginPath(); ctx.roundRect(-s, -s, 2 * s, 2 * s, c);
        ctx.setLineDash([p.progress * 8 * s, 8 * s]); ctx.stroke(); ctx.setLineDash([]);
        break;
      }
      default: break;
    }
    ctx.restore();
  }
}

function readout() {
  let tools = 0, agents = 0, tasks = 0, waiting = false;
  for (const id of live.sessions.keys()) {
    const s = live.sessions.get(id);
    tools += s.openTools.size; agents += live.runningAgents(id).length; tasks += live.openTasks(id).length; waiting = waiting || !!s.waiting;
  }
  const mode = liveTail.on ? `live tail (${liveTail.lines} lines)` : label;
  $("readout").textContent = `${mode}  |  open tools ${tools}  |  running agents ${agents}  |  open tasks ${tasks}  |  ${waiting ? "WAITING" : "active"}  |  marks ${scene.marks.length}  |  pulse ${Math.round(scene.period)} ms${scene.completed ? "  |  task complete" : ""}`;
}

const fmt = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

function frame(t) {
  const dt = Math.min(100, t - lastFrame); lastFrame = t;
  const paused = replayer && replayer.state === "paused";
  if (!paused) sceneClock += dt; // freeze animation while paused
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
  draw(scene.primitives(sceneClock), W, H, dpr);
  if (replayer) {
    const pos = position();
    if (!seeking && replayer.duration) $("seek").value = Math.round((pos / replayer.duration) * 1000);
    $("clock").textContent = `${fmt(pos)} / ${fmt(replayer.duration)}`;
  }
  readout();
  requestAnimationFrame(frame);
}

// ---------- startup ----------
$("rec").innerHTML = RECORDINGS.map((n) => `<option value="${n}">${n.replace(".events.jsonl", "")}</option>`).join("");
$("palette").innerHTML = Object.keys(scene.mapping.palettes.presets).map((n) => `<option ${n === scene.mapping.palettes.active ? "selected" : ""}>${n}</option>`).join("");
requestAnimationFrame(frame);
loadUrl(RECORDINGS[0]).catch((e) => { console.error(e); $("readout").textContent = "could not load recording: " + e.message; });
