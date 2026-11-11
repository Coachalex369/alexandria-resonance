// Geometry Laboratory wiring: connects the DOM controls (lab.html) to the pure lab model (src/labModel.js),
// the geometry engine (4D rotation, 4D->3D->2D projection), the WireRenderer and the RippleField.
// Lab time (labT) only advances while not paused, so rotation and ripples freeze together.
import { Camera, projectStructure } from "../geometry/src/index.js";
import { WireRenderer } from "./src/render2d.js";
import { RippleField, mixHue } from "./src/ripples.js";
import {
  STRUCTURES, EDGE_GUARD, isFourD, buildStructure, applyComplexity, structureStats, defaultState,
  stepAngles, rotationMatrices, colorFor, vertexParts,
} from "./src/labModel.js";

const $ = (id) => document.getElementById(id);
const mq = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
const state = defaultState({ reducedMotion: !!(mq && mq.matches), structure: "icosahedron" });

const canvas = $("cv");
const renderer = new WireRenderer(canvas, { glow: state.fx.glow });
const camera = new Camera({ distance: state.cam.distance, fov: state.cam.fov, mode: state.cam.mode });
const field = new RippleField();

let base = null, structure = null, parts = [], lastProj = null, labT = 0, frameStats = { edges: 0, ms: 0 };
const frameTimes = [];

// ---- structure management -------------------------------------------------------------------------------
function setWarn(msg) { const el = $("warn"); el.textContent = msg || ""; el.hidden = !msg; }

function rebuild(resetComplexity) {
  if (resetComplexity || !base) { base = buildStructure(state.structure); state.subdivisions = 0; state.connect = 0; }
  structure = applyComplexity(base, { subdivisions: state.subdivisions, connect: state.connect });
  parts = vertexParts(structure);
  field.waves = []; field.rings = [];
  const four = isFourD(state.structure);
  $("rot4").hidden = !four; $("proj4").hidden = !four;
  $("subdivide").disabled = four;
  updateStats();
}

function updateStats() {
  const st = structureStats(structure);
  $("stats").textContent = `v ${st.vertices}  e ${st.edges}  f ${st.faces}  cells ${st.cells}  dim ${st.dim}`;
  const over = st.edges > EDGE_GUARD;
  $("subdivide").disabled = isFourD(state.structure) || over;
  $("connect").disabled = over;
  if (over) setWarn(`edges ${st.edges} > ${EDGE_GUARD}: further subdivision refused (performance guard)`);
}

function selectStructure(name) {
  state.structure = name;
  const four = isFourD(name);
  if (!state.reducedMotion) state.auto4D = four;
  $("auto4d").checked = state.auto4D;
  state.angles = { xy: 0, xz: 0, yz: 0, xw: 0, yw: 0, zw: 0 };
  setWarn("");
  rebuild(true);
}

// ---- ripples --------------------------------------------------------------------------------------------
function launch(vertex) {
  if (!lastProj || vertex == null) return;
  const hue = Math.random() * 360, p = lastProj.screen[vertex];
  field.addGraphWave(structure, vertex, { born: labT, hue, meta: { source: "lab", vertex } });
  if (p && p.visible) field.addRing([p.x, p.y], { born: labT, hue });
}
function randomRipple() { launch(Math.floor(Math.random() * structure.vertices.length)); }

// ---- wiring ---------------------------------------------------------------------------------------------
const sel = $("structure");
for (const [value, label] of Object.entries(STRUCTURES)) { const o = document.createElement("option"); o.value = value; o.textContent = label; sel.appendChild(o); }
sel.value = state.structure;
sel.addEventListener("change", () => selectStructure(sel.value));

$("subdivide").addEventListener("click", () => {
  if (isFourD(state.structure) || structure.edges.length > EDGE_GUARD) { setWarn(`refused: edges ${structure.edges.length} > ${EDGE_GUARD}`); return; }
  state.subdivisions += 1; setWarn("");
  rebuild(false);
});
$("connect").addEventListener("click", () => { state.connect += 1; setWarn(""); rebuild(false); });
$("reset").addEventListener("click", () => { setWarn(""); rebuild(true); });

const bindCheck = (id, fn) => $(id).addEventListener("change", (e) => fn(e.target.checked));
const bindRange = (id, fn) => $(id).addEventListener("input", (e) => fn(Number(e.target.value)));
const bindSelect = (id, fn) => $(id).addEventListener("change", (e) => fn(e.target.value));

bindCheck("auto3d", (v) => { state.auto3D = v; });
bindCheck("auto4d", (v) => { state.auto4D = v; });
bindCheck("autoorbit", (v) => { state.autoOrbit = v; });
bindRange("speed", (v) => { state.speed = v; });
for (const p of ["xy", "xz", "yz", "xw", "yw", "zw"]) bindRange(`a-${p}`, (v) => { state.angles[p] = v; });
bindSelect("proj4mode", (v) => { state.proj4.mode = v; });
bindRange("proj4dist", (v) => { state.proj4.distance = v; });
bindSelect("cammode", (v) => { state.cam.mode = v; camera.mode = v; });
bindRange("fov", (v) => { state.cam.fov = v; camera.fov = v; });
bindRange("camdist", (v) => { state.cam.distance = v; camera.distance = v; });
bindCheck("faces", (v) => { state.fx.faces = v; });
bindRange("facealpha", (v) => { state.fx.faceAlpha = v; });
bindCheck("glow", (v) => { state.fx.glow = v; renderer.glow = v; });
bindCheck("nodes", (v) => { state.fx.nodes = v; });
bindSelect("colormode", (v) => { state.colorMode = v; });
bindRange("hue", (v) => { state.hue = v; });
$("random").addEventListener("click", randomRipple);
$("clear").addEventListener("click", () => { field.waves = []; field.rings = []; });

function setReduced(on) {
  state.reducedMotion = on;
  if (on) { state.auto3D = false; state.auto4D = false; state.autoOrbit = false; }
  $("reduced").checked = on;
  syncChecks();
}
$("reduced").addEventListener("change", (e) => setReduced(e.target.checked));
if (mq && mq.addEventListener) mq.addEventListener("change", (e) => setReduced(e.matches));

$("pause").addEventListener("click", () => { state.paused = !state.paused; $("pause").textContent = state.paused ? "Resume" : "Pause"; });
$("snapshot").addEventListener("click", () => {
  try {
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png"); a.download = `forge-${state.structure}-${Date.now()}.png`;
    document.body.appendChild(a); a.click(); a.remove();
  } catch (err) { setWarn(`snapshot failed: ${err.message}`); }
});

// Canvas: drag orbits, wheel dollies, a click without movement picks a vertex and launches a ripple.
let drag = null;
canvas.addEventListener("pointerdown", (e) => {
  drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false };
  canvas.setPointerCapture(e.pointerId); canvas.classList.add("drag");
});
canvas.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.x = e.clientX; drag.y = e.clientY;
  if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4) drag.moved = true;
  if (drag.moved) camera.orbit(-dx * 0.008, dy * 0.008);
});
const endDrag = (e) => {
  if (!drag) return;
  const wasClick = !drag.moved; drag = null; canvas.classList.remove("drag");
  if (wasClick && e.type === "pointerup" && lastProj) {
    const hit = renderer.pick(lastProj.screen, e.clientX, e.clientY);
    if (hit) launch(hit.index);
  }
};
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  camera.dolly(Math.exp(Math.sign(e.deltaY) * 0.08)); state.cam.distance = camera.distance;
}, { passive: false });
window.addEventListener("resize", () => renderer.resize());

function syncChecks() {
  $("auto3d").checked = state.auto3D; $("auto4d").checked = state.auto4D; $("autoorbit").checked = state.autoOrbit;
  $("reduced").checked = state.reducedMotion;
  $("rmflag").textContent = `reduced motion: ${state.reducedMotion ? "ON" : "off"}${mq && mq.matches ? " (system preference)" : ""}`;
}

// ---- frame ----------------------------------------------------------------------------------------------
function syncSliders() {
  const active = document.activeElement && document.activeElement.id;
  for (const p of ["xy", "xz", "yz", "xw", "yw", "zw"]) {
    const v = state.angles[p];
    if (active !== `a-${p}`) $(`a-${p}`).value = v;
    $(`v-${p}`).textContent = v.toFixed(2);
  }
  $("speedV").textContent = state.speed.toFixed(2);
  $("proj4distV").textContent = state.proj4.distance.toFixed(2);
  $("fovV").textContent = state.cam.fov.toFixed(2);
  if (active !== "camdist") $("camdist").value = camera.distance;
  $("camdistV").textContent = camera.distance.toFixed(2);
}

function draw() {
  const { rot3, rot4 } = rotationMatrices(state);
  lastProj = projectStructure(structure, { camera, rot4, rot3, proj4: state.proj4 });
  const { screen, w } = lastProj;
  const edges = structure.edges, n = edges.length;
  const waving = field.waves.some((wv) => wv.structureId === structure.id);
  let amps = null, hues = null, energies = null;
  if (waving) {
    amps = new Float32Array(screen.length); hues = new Array(screen.length); energies = new Float32Array(screen.length);
    for (let i = 0; i < screen.length; i++) { const s = field.vertexState(structure.id, i, labT); amps[i] = s.amp; hues[i] = s.hue; energies[i] = s.energy; }
  }
  const baseAlpha = n > 1500 ? 0.4 : n > 600 ? 0.55 : 0.8;
  const wAt = (i) => (w ? w[i] : null);

  renderer.begin();
  if (state.fx.faces && structure.faces.length) {
    renderer.drawFaces(screen, structure.faces, (fi) => {
      const f = structure.faces[fi], c = colorFor(state, structure, { w: w ? w[f[0]] : null, partIndex: parts[f[0]] });
      return { hue: c.hue, sat: c.sat, light: 50, alpha: state.fx.faceAlpha };
    });
  }
  renderer.drawEdges(screen, edges, (i) => {
    const [a, b] = edges[i];
    const wm = w ? (w[a] + w[b]) / 2 : null;
    const c = colorFor(state, structure, { edgeIndex: i, w: wm, partIndex: parts[a] });
    let hue = c.hue, alpha = baseAlpha, width = 1.2, light = c.light;
    if (waving) {
      const amp = (amps[a] + amps[b]) / 2, en = (energies[a] + energies[b]) / 2;
      const ha = hues[a], hb = hues[b], wh = ha == null ? hb : hb == null ? ha : mixHue(ha, hb, 0.5);
      if (wh != null) hue = mixHue(hue, wh, Math.min(1, Math.abs(amp) * 1.2));
      alpha = Math.min(1, alpha + 0.5 * Math.min(1, en)); width += 2.2 * Math.min(1, en); light = Math.min(90, light + 25 * Math.min(1, en));
    }
    return { hue, sat: c.sat, light, alpha, width };
  });
  if (state.fx.nodes) {
    renderer.drawNodes(screen, (i) => {
      const c = colorFor(state, structure, { w: wAt(i), partIndex: parts[i] });
      let hue = c.hue, radius = n > 1500 ? 1.2 : 2.2, alpha = 0.7;
      if (waving && hues[i] != null) { hue = mixHue(hue, hues[i], Math.min(1, Math.abs(amps[i]))); radius += 3 * Math.min(1, energies[i]); alpha = 1; }
      return { hue, sat: c.sat, light: c.light, alpha, radius };
    });
  }
  for (const r of field.activeRings(labT)) renderer.drawRing(r.centre, r.radius, { hue: r.hue, alpha: r.alpha, width: r.width });
  for (const x of field.interferences(labT)) renderer.drawRing(x.point, 0.02, { hue: x.hue, alpha: x.alpha, width: 2 });
  frameStats = renderer.end();
}

let last = performance.now();
function frame(ts) {
  const dt = Math.max(0, Math.min(100, ts - last)); last = ts;
  if (!state.paused) {
    labT += dt;
    state.angles = stepAngles(state, dt);
    if (state.autoOrbit && !state.reducedMotion && !drag) camera.orbit(0.0001 * dt, 0);
    field.prune(labT);
  }
  frameTimes.push(dt || 16); if (frameTimes.length > 60) frameTimes.shift();
  renderer.resize();
  draw();
  syncSliders();
  const avg = frameTimes.reduce((s, v) => s + v, 0) / frameTimes.length;
  const sz = field.size;
  $("ripples").textContent = `waves ${sz.waves} | rings ${sz.rings}`;
  $("readout").textContent = `fps ${(1000 / avg).toFixed(0)}  frame ${frameStats.ms.toFixed(1)} ms\nedges drawn ${frameStats.edges}  nodes ${frameStats.nodes}  faces ${frameStats.faces}`;
  requestAnimationFrame(frame);
}

syncChecks();
rebuild(true);
renderer.resize();
requestAnimationFrame(frame);

// Debug handle for the main session / console driving.
window.forgeLab = { state, camera, field, get structure() { return structure; }, launch, selectStructure, setReduced };
