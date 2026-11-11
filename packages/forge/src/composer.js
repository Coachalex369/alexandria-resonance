// The Forge composer: turns generic development event records into a composition of geometric structures —
// one luminous core for the objective, one structure per agent orbiting it (children orbit their parent), plus
// satellites — with bounded internal complexity, heat/verification state per vertex, distortion/relaxation
// dynamics, ripples and a final resolution. DOM-free and deterministic: all randomness comes from a PRNG seeded
// by the session fingerprint, so the same recording and configuration reproduce the same artwork.
//
// Independence: this engine depends only on @alexandria/geometry and the generic event record below. It knows
// nothing about Claude Code, hooks, the taxonomy package or the Scoreboard UI. Any producer that emits records of
// this shape (an adapter) can drive it:
//   { id, ts (ISO), kind, actor: { type: "main"|"subagent"|..., agentId?, agentType?, model? },
//     parent?: { agentId? (spawning agent), toolUseId? }, task?: { id, title },
//     payload?: { tool?, paths?, ok?, kind? ... metadata only, never content },
//     classification?: [{ scheme: "operation"|"work-category"|"code-structure", value, confidence }] }
// Recognised kinds: session.start, task.start, task.end, prompt.submit, notification, agent.start, agent.stop,
// tool.call, tool.result, tool.failure, test.run, git.commit, code.structure, turn.stop. Unknown kinds are ignored.
// Optional `hints(scheme, value)` may supply a fallback hue for a category not listed in the mapping.
//
// Every vertex and edge keeps a `ref` to the event that created it (provenance) so the artwork is explorable.
// These mappings are artistic interpretations of observable activity (forge-mapping.json, identities.json);
// nothing here claims to depict an AI's private thoughts.
import * as G from "../../geometry/src/index.js";
import { RippleField } from "./ripples.js";
import { fingerprint, seedRandom, snapshotHash } from "./fingerprint.js";

const PARTNERS = { "24-cell": "16-cell", tesseract: "16-cell", "16-cell": "tesseract", cube: "octahedron", octahedron: "cube", icosahedron: "dodecahedron", dodecahedron: "icosahedron", tetrahedron: "tetrahedron" };
const SATELLITE_SHAPES = ["tetrahedron", "octahedron", "cube", "icosahedron"];
const GOLDEN = 2.399963229728653;

function buildSeed(name) {
  if (G.POLYTOPES[name]) return G.POLYTOPES[name]();
  if (G.PLATONIC[name]) return G.PLATONIC[name]();
  if (name === "star-tetrahedron") return G.starTetrahedron();
  if (name === "metatron") return G.metatronArrangement({ connectAll: false });
  return G.icosahedron();
}

export class Composer {
  constructor({ mapping, identities, events = [], config = {}, hints = null } = {}) {
    this.mapping = mapping; this.identities = identities; this.config = config; this.hints = hints;
    this.reset(events);
  }

  reset(events = []) {
    this.fingerprint = fingerprint(events, { mapping: this.mapping, identities: this.identities, config: this.config });
    this.rng = seedRandom(this.fingerprint);
    this.nodes = new Map(); this.order = [];
    this.ripples = new RippleField({ maxWaves: 64, maxRings: 48 });
    this.events = new Map(); this.eventCount = 0;
    this.task = null; this.project = null; this.session = null;
    this.resolved = false; this.resolvedAt = null; this.waiting = false; this.tension = 0;
    this.agentIndex = 0; this.childCounts = new Map(); this.time = 0; this.log = [];
    this.current = null; // last meaningful event (for the page's "now" line)
  }

  // ---------- identities ----------
  identityFor(actor) {
    const ids = this.identities;
    if (!actor || actor.type === "main" || actor.type === "human" || actor.type === "system") return ids.main;
    if (actor.agentId && ids.byAgentId[actor.agentId]) return ids.byAgentId[actor.agentId];
    if (actor.agentType && ids.byAgentType[actor.agentType]) return ids.byAgentType[actor.agentType];
    return ids.fallback;
  }
  preset(name) { return this.identities.presets[name] || this.identities.presets[this.identities.fallback]; }

  // ---------- nodes ----------
  node(id) { return this.nodes.get(id); }
  get core() { return this.nodes.get("core"); }
  get main() { return this.nodes.get("main"); }
  get L() { return this.mapping.layout; }

  ensureCore(e, replayIndex) {
    if (this.core) return this.core;
    const identity = this.identities.core && this.identities.presets[this.identities.core] ? this.identities.core : this.identities.main;
    return this.createNode({ id: "core", kind: "core", agentId: null, agentType: "objective", identity, parentId: null, event: e, replayIndex, scale: this.L.coreRadius, orbit: null });
  }
  ensureMain(e, replayIndex) {
    this.ensureCore(e, replayIndex);
    if (this.main) return this.main;
    const n = this.createNode({ id: "main", kind: "agent", agentId: null, agentType: "main", identity: this.identities.main, parentId: "core", event: e, replayIndex, scale: this.L.mainScale, orbit: { centerId: "core", radius: this.L.mainOrbit, angle: 0.4, y: 0.55 } });
    n.position = this.orbitPosition(n.orbit, 1.5);
    for (let i = 0; i < this.L.tetherEdges; i++) n.tethers.push({ toNodeId: "core", from: Math.floor(this.rng() * n.structure.vertices.length), to: Math.floor(this.rng() * this.core.structure.vertices.length) });
    return n;
  }

  createNode({ id, kind, agentId, agentType, identity, parentId, event, replayIndex, scale, orbit, anchor = null, seedName = null }) {
    const preset = this.preset(identity);
    const structure = buildSeed(seedName || preset.seed);
    const ref = this.ref(event, replayIndex);
    const V = structure.vertices.length;
    const n = {
      id, kind, agentId, agentType, identity, preset, parentId, anchor, orbit,
      structure, seedName: seedName || preset.seed,
      offsets: structure.vertices.map(() => [0, 0, 0]),
      glow: structure.vertices.map(() => 0),
      heat: structure.vertices.map(() => (kind === "core" ? 0 : 0.6)),   // temperature: recent work glows, cools over time
      verified: structure.vertices.map(() => 0),                            // 0 untested, 1 verified, -1 failed
      edgeWeight: structure.edges.map(() => 0),
      refs: { vertices: structure.vertices.map(() => ref), edges: structure.edges.map(() => ref) },
      angles: {}, spinBoost: 0, growth: 0, stage: 0, tension: 0, fixing: 0,
      position: orbit ? this.orbitPosition(orbit, 1) : [0, 0, 0], targetPosition: [0, 0, 0], scale, targetScale: scale,
      docked: false, stoppedAt: null, bornAt: this.time, events: 0, satellites: [], tethers: [], history: [],
    };
    n.targetPosition = [...n.position];
    this.nodes.set(id, n); this.order.push(id);
    this.record(n, event, replayIndex);
    return n;
  }
  record(n, e, replayIndex) { if (!e) return; n.history.push({ i: replayIndex ?? this.eventCount, eventId: e.id, kind: e.kind, ts: e.ts }); if (n.history.length > 400) n.history.shift(); }

  orbitPosition(orbit, k = 1) {
    const c = orbit.centerId === "core" || !this.nodes.get(orbit.centerId) ? [0, 0, 0] : this.nodes.get(orbit.centerId).position;
    return [c[0] + Math.cos(orbit.angle) * orbit.radius * k, c[1] + orbit.y, c[2] + Math.sin(orbit.angle) * orbit.radius * k];
  }

  ref(e, replayIndex) {
    return { eventId: e?.id ?? null, kind: e?.kind ?? null, ts: e?.ts ?? null, agentId: e?.actor?.agentId ?? null, actorType: e?.actor?.type ?? null, taskId: e?.task?.id ?? this.task?.id ?? null, tool: e?.payload?.tool ?? null, path: e?.payload?.paths?.[0] ?? e?.payload?.path ?? null, structure: e?.payload?.name ?? null, replayIndex: replayIndex ?? this.eventCount };
  }

  classify(e) {
    const cls = e.classification || [];
    const best = (scheme) => cls.filter((c) => c.scheme === scheme).sort((a, b) => b.confidence - a.confidence)[0]?.value || null;
    const operation = best("operation") || (e.kind === "test.run" ? "test" : e.kind === "git.commit" ? "commit" : "other");
    const category = best("work-category");
    const opMap = this.mapping.operations[operation] || this.mapping.operations.other;
    const catMap = category ? this.mapping.categories[category] : null;
    const hue = catMap?.hue ?? (category && this.hints ? this.hints("work-category", category)?.hue : null) ?? null;
    const op = catMap && ["distort", "wave", "scaffold", "branch"].includes(catMap.op) && opMap.op !== "seal" ? catMap.op : opMap.op;
    return { operation, category, op, growth: opMap.growth ?? 0.2, spin: opMap.spin ?? 0.1, hue, structures: cls.filter((c) => c.scheme === "code-structure").map((c) => c.value) };
  }

  // ---------- ingest ----------
  ingest(e, tNow = this.time, replayIndex = this.eventCount) {
    this.time = tNow;
    this.events.set(e.id, { id: e.id, kind: e.kind, ts: e.ts, actor: e.actor, task: e.task, payload: summarizePayload(e.payload), classification: e.classification || [], replayIndex, label: e.payload?.label ?? null });
    this.eventCount++;
    const sub = e.actor?.type === "subagent";
    if (!["tool.call", "session.start", "session.end"].includes(e.kind)) this.current = { id: e.id, kind: e.kind, ts: e.ts, actor: e.actor, label: e.payload?.label ?? e.task?.title ?? null, replayIndex };
    switch (e.kind) {
      case "session.start": this.session = e.session?.id; this.project = e.session?.project; break;
      case "task.start": this.task = { id: e.task?.id || e.id, title: e.task?.title || null, startedAt: e.ts }; this.resolved = false; this.resolvedAt = null; this.ensureMain(e, replayIndex); break;
      case "prompt.submit": this.waiting = false; this.ensureMain(e, replayIndex).spinBoost += 0.4; break;
      case "notification": if (e.payload?.kind === "permission_prompt" || e.payload?.kind === "idle_prompt") this.waiting = true; break;
      case "agent.start": this.spawnAgent(e, replayIndex); break;
      case "agent.stop": this.dockAgent(e, tNow, replayIndex); break; // docks the agent's structure; never resolves the composition
      case "tool.call": { const n = this.nodeFor(e, replayIndex); n.spinBoost += 0.15; n.events++; break; }
      case "tool.result": case "tool.failure": this.waiting = false; this.applyTool(e, tNow, replayIndex); break;
      case "test.run": this.applyTest(e, tNow, replayIndex); break;
      case "git.commit": { const n = this.ensureMain(e, replayIndex); this.record(n, e, replayIndex); this.wave(n, tNow, "commit", e); this.wave(this.core, tNow, "commit", e); this.core.growth += this.mapping.verification?.coreGrowthPerCommit ?? 1; this.advanceGrowth(this.core, e, replayIndex); n.tension = 0; this.tension = Math.max(0, this.tension - 0.5); break; }
      case "code.structure": { const n = this.nodeFor(e, replayIndex); const i = n.structure.vertices.length - 1; if (i >= 0) n.refs.vertices[i] = { ...n.refs.vertices[i], structure: e.payload?.name ?? n.refs.vertices[i].structure, structureKind: e.payload?.kind ?? null }; break; }
      case "turn.stop": if (!sub) { const n = this.ensureMain(e, replayIndex); this.record(n, e, replayIndex); this.wave(n, tNow, "turnStop", e); for (const m of this.nodes.values()) m.fixing = Math.max(m.fixing, 0.5); } break;
      case "task.end": this.resolve(e, tNow, replayIndex); break;
      default: break;
    }
    this.log.push({ i: replayIndex, kind: e.kind }); if (this.log.length > 200) this.log.shift();
  }

  nodeFor(e, replayIndex) {
    if (e.actor?.type === "subagent" && e.actor.agentId) {
      const id = "agent:" + e.actor.agentId;
      return this.nodes.get(id) || this.spawnAgent(e, replayIndex);
    }
    return this.ensureMain(e, replayIndex);
  }

  spawnAgent(e, replayIndex) {
    const id = "agent:" + e.actor.agentId;
    if (this.nodes.has(id)) return this.nodes.get(id);
    const main = this.ensureMain(e, replayIndex);
    const L = this.L;
    const parentAgent = e.parent?.agentId ? this.nodes.get("agent:" + e.parent.agentId) : null;
    const parentId = parentAgent ? parentAgent.id : "main";
    let orbit, scale;
    if (parentAgent) {
      const k = (this.childCounts.get(parentAgent.id) || 0); this.childCounts.set(parentAgent.id, k + 1);
      orbit = { centerId: parentAgent.id, radius: L.childOrbit * parentAgent.scale / L.agentScale, angle: 1.1 + k * GOLDEN, y: this.rng.range(-0.25, 0.25) };
      scale = parentAgent.scale * L.childScale;
    } else {
      const k = this.agentIndex++;
      orbit = { centerId: "core", radius: L.agentOrbit, angle: 0.4 + Math.PI * 0.75 + k * GOLDEN, y: this.rng.range(-0.6, 0.1) };
      scale = L.agentScale;
    }
    const n = this.createNode({ id, kind: "agent", agentId: e.actor.agentId, agentType: e.actor.agentType || null, identity: this.identityFor(e.actor), parentId, event: e, replayIndex, scale, orbit });
    n.position = this.orbitPosition(orbit, 1.7); // arrives from outside and settles into orbit
    n.model = e.actor.model || null;
    // interlock: tethers to the objective (top level) or to the parent agent (children); a thin link to the spawner
    const tetherTarget = parentAgent ? parentAgent : this.core;
    for (let i = 0; i < L.tetherEdges; i++) n.tethers.push({ toNodeId: tetherTarget.id, from: Math.floor(this.rng() * n.structure.vertices.length), to: Math.floor(this.rng() * tetherTarget.structure.vertices.length) });
    if (!parentAgent) n.tethers.push({ toNodeId: "main", from: Math.floor(this.rng() * n.structure.vertices.length), to: Math.floor(this.rng() * main.structure.vertices.length), thin: true });
    main.spinBoost += 0.3;
    this.wave(n, this.time, "agentStart", e, { hue: n.preset.hue });
    return n;
  }

  dockAgent(e, tNow, replayIndex) {
    const n = this.nodes.get("agent:" + e.actor.agentId); if (!n || n.docked) return;
    const L = this.L;
    n.docked = true; n.stoppedAt = tNow; this.record(n, e, replayIndex);
    if (n.orbit) { n.orbit.radius *= L.dockedOrbitScale; n.orbit.y *= 0.6; }
    n.targetScale = n.scale * L.dockedShrink;
    this.wave(n, tNow, "agentStop", e, { hue: n.preset.hue });
  }

  applyTool(e, tNow, replayIndex) {
    const n = this.nodeFor(e, replayIndex);
    const c = this.classify(e);
    const failed = e.kind === "tool.failure";
    n.events++; n.lastHue = c.hue ?? n.lastHue ?? null; this.record(n, e, replayIndex);
    n.spinBoost += c.spin;
    if (failed) { this.distort(n, 0.9, e, replayIndex); n.tension = Math.min(1, n.tension + 0.35); this.tension = Math.min(1, this.tension + 0.2); this.wave(n, tNow, "toolFailure", e); return; }
    switch (c.op) {
      case "distort": this.distort(n, 0.45, e, replayIndex); n.tension = Math.min(1, n.tension + 0.15); break;
      case "transform": if (n.tension > 0.2) { n.fixing = 1; n.tension = Math.max(0, n.tension - 0.3); } this.transform(n, 0.18 + 0.1 * this.rng(), e, replayIndex); break;
      case "assemble": this.ignite(n, 3, e, replayIndex); break;
      case "scaffold": this.ignite(n, 2, e, replayIndex); if (n.stage === 0 && n.growth > 0.5) this.grow(n, "connect", e, replayIndex); break;
      case "branch": this.ignite(n, 1, e, replayIndex); n.branchBias = (n.branchBias || 0) + 1; break;
      case "pulse": this.wave(n, tNow, "toolResult", e, { hue: c.hue }); break;
      case "wave": this.wave(n, tNow, "toolResult", e, { hue: c.hue ?? 130 }); break;
      case "seal": this.wave(n, tNow, "commit", e); break;
      case "hold": break;
      default: this.ignite(n, 1, e, replayIndex); break;
    }
    if (c.op !== "hold") this.wave(n, tNow, "toolResult", e, { hue: c.hue, strength: 0.25 + 0.2 * c.growth });
    n.growth += c.growth;
    this.advanceGrowth(n, e, replayIndex);
  }

  // Tests verify the actor's structure, its parent agent's structure (a helper tests its parent's work) and the core.
  applyTest(e, tNow, replayIndex) {
    const n = this.nodeFor(e, replayIndex), ok = e.payload?.ok === true;
    const V = this.mapping.verification || {};
    n.events++; this.record(n, e, replayIndex);
    const targets = [[n, 1]];
    const parent = n.parentId && n.parentId !== "main" && n.parentId !== "core" ? this.nodes.get(n.parentId) : null;
    if (parent) { targets.push([parent, 0.7]); this.record(parent, e, replayIndex); }
    if (this.core && n !== this.core) { targets.push([this.core, 0.6]); this.record(this.core, e, replayIndex); }
    for (const [m, k] of targets) {
      const w = this.wave(m, tNow, ok ? "testPass" : "testFail", e, { strength: k });
      const reach = w ? w.hops : m.structure.vertices.map(() => 0);
      m.structure.edges.forEach(([a, b], i) => { if (reach[a] >= 0 && reach[b] >= 0) m.edgeWeight[i] = Math.max(-1, Math.min(1, m.edgeWeight[i] + (ok ? (V.verifiedReinforce ?? 0.12) : -(V.failWeaken ?? 0.2)) * k)); });
      if (ok) { reach.forEach((h, i) => { if (h >= 0) { m.verified[i] = 1; m.heat[i] *= 0.25; } }); m.tension = Math.max(0, m.tension - 0.5); m.fixing = 1; }
      else { this.distortRegion(m, 0.8 * k, e, replayIndex, true); m.tension = Math.min(1, m.tension + 0.4 * k); }
    }
    if (ok) { this.tension = Math.max(0, this.tension - 0.3); this.core.growth += (V.coreGrowthPerPass ?? 1) ; this.advanceGrowth(this.core, e, replayIndex); }
    else this.tension = Math.min(1, this.tension + 0.3);
    n.growth += 0.2; this.advanceGrowth(n, e, replayIndex);
  }

  resolve(e, tNow, replayIndex) {
    this.resolved = true; this.resolvedAt = tNow; this.waiting = false;
    const main = this.ensureMain(e, replayIndex);
    this.record(main, e, replayIndex); this.record(this.core, e, replayIndex);
    this.wave(this.core, tNow, "taskEnd", e);
    this.wave(main, tNow, "taskEnd", e, { strength: 0.6 });
    for (const n of this.nodes.values()) { n.fixing = 1; n.tension = 0; n.resolveFrom = tNow; }
  }

  // ---------- geometric operations ----------
  touch(n, i, e, replayIndex, { verifiedReset = true } = {}) {
    n.heat[i] = 1; if (verifiedReset) n.verified[i] = 0;
    const r = this.ref(e, replayIndex);
    n.refs.vertices[i] = { ...n.refs.vertices[i], lastEventId: r.eventId, lastKind: r.kind, lastTs: r.ts, path: r.path ?? n.refs.vertices[i].path, tool: r.tool ?? n.refs.vertices[i].tool };
  }
  ignite(n, k, e, replayIndex) {
    for (let j = 0; j < k; j++) { const i = Math.floor(this.rng() * n.structure.vertices.length); n.glow[i] = 1; this.touch(n, i, e, replayIndex); }
  }
  // rotate the template itself (existing structure transforms rather than spawning new objects)
  transform(n, angle, e, replayIndex) {
    const dim = n.structure.dim, planes = dim === 4 ? G.PLANES_4D : G.PLANES_3D;
    const plane = planes[Math.floor(this.rng() * planes.length)];
    n.structure = G.transformStructure(n.structure, G.rotationPlane(dim, plane, angle * (this.rng() < 0.5 ? -1 : 1)));
    n.transforms = (n.transforms || 0) + 1;
    for (let j = 0; j < 3; j++) this.touch(n, Math.floor(this.rng() * n.structure.vertices.length), e, replayIndex);
  }
  distort(n, amount, e, replayIndex) {
    const k = Math.max(2, Math.floor(n.structure.vertices.length * 0.2));
    for (let j = 0; j < k; j++) { const i = Math.floor(this.rng() * n.offsets.length); n.offsets[i] = G.add(n.offsets[i], [this.rng.range(-amount, amount) * 0.25, this.rng.range(-amount, amount) * 0.25, this.rng.range(-amount, amount) * 0.25]); this.touch(n, i, e, replayIndex); }
  }
  // unstable region: a cluster within two hops of a random origin is displaced (test failures) and marked failed
  distortRegion(n, amount, e, replayIndex, markFailed = false) {
    const origin = Math.floor(this.rng() * n.structure.vertices.length), hops = G.hopDistances(n.structure, origin);
    const dir = G.normalize([this.rng.range(-1, 1), this.rng.range(-1, 1), this.rng.range(-1, 1)]);
    hops.forEach((h, i) => { if (h >= 0 && h <= 2) { n.offsets[i] = G.add(n.offsets[i], G.scale(dir, amount * 0.22 / (1 + h))); this.touch(n, i, e, replayIndex, { verifiedReset: false }); if (markFailed) n.verified[i] = -1; } });
    n.unstableOrigin = origin;
  }
  wave(n, tNow, kindKey, e, { hue, strength } = {}) {
    if (!n) return null;
    if (this.resolved && kindKey !== "taskEnd") return null;
    const cfg = this.mapping.ripples[kindKey] || this.mapping.ripples.toolResult;
    const origin = Math.floor(this.rng() * n.structure.vertices.length);
    const h = hue ?? cfg.hue ?? n.lastHue ?? n.preset.hue;
    const w = this.ripples.addGraphWave(n.structure, origin, { born: tNow, hue: h, strength: (strength ?? 1) * cfg.strength, life: cfg.life, sign: cfg.sign ?? 1, meta: { eventId: e?.id, kind: e?.kind, nodeId: n.id, kindKey } });
    w.nodeId = n.id;
    if (cfg.ring) this.ripples.addRing([0, 0], { born: tNow, hue: h, life: cfg.life, r0: 0.05 * n.scale, r1: kindKey === "taskEnd" ? 1.3 : 0.5 + 0.4 * this.rng(), alpha: 0.35, meta: { eventId: e?.id, kind: e?.kind, nodeId: n.id, kindKey } }).nodeId = n.id;
    return w;
  }

  // ---------- bounded growth ----------
  advanceGrowth(n, e, replayIndex) {
    const g = this.mapping.growth;
    while (n.stage < g.thresholds.length && n.growth >= g.thresholds[n.stage]) {
      let stage = g.stages[n.stage];
      if (n.kind === "core" && stage === "satellite") stage = "connect"; // the core gains internal structure only
      if (stage === "subdivide" && n.preset.growthPreference && !n.preset.growthPreference.includes("subdivide")) stage = "connect"; // identities that prefer legible outlines
      if (n.branchBias > 2 && stage !== "satellite" && n.preset.growthPreference[0] === "satellite") stage = "satellite";
      this.grow(n, stage, e, replayIndex);
      n.stage++;
    }
  }
  grow(n, stage, e, replayIndex) {
    const g = this.mapping.growth, ref = this.ref(e, replayIndex);
    const before = n.structure;
    if (stage === "satellite") { if (n.satellites.length < g.maxSatellites) this.addSatellite(n, e, replayIndex); return; }
    if (before.edges.length >= g.maxEdges) { n.spinBoost += 0.5; return; }
    let after;
    if (stage === "subdivide") after = G.subdivide(before, { spherize: true });
    else if (stage === "connect") after = G.connectNearest(before, 1);
    else if (stage === "nest") {
      const partner = PARTNERS[n.seedName] || "octahedron"; const inner = G.scaleStructure(G.normalizeRadius(buildSeed(partner)), 0.58);
      after = G.mergeStructures([before, inner], before.id + "+" + partner); after.dim = before.dim;
      // interlock the nested solid with its shell: each inner vertex links to its nearest outer vertex, so waves
      // and verification reach it and the nesting reads as one structure
      const outer = before.vertices.length;
      for (let j = outer; j < after.vertices.length; j++) { let best = -1, bd = Infinity; for (let i = 0; i < outer; i++) { const d = G.distance(after.vertices[i], after.vertices[j]); if (d < bd) { bd = d; best = i; } } after.edges.push([best, j]); }
      after.edges = G.uniqueEdges(after.edges);
    }
    else return;
    if (after.edges.length > g.maxEdges * 1.6) { n.spinBoost += 0.5; return; }
    this.adoptStructure(n, after, ref);
  }
  adoptStructure(n, after, ref) {
    const oldV = n.structure.vertices.length;
    const oldEdges = new Map(n.structure.edges.map(([a, b], i) => [G.edgeKey(a, b), i]));
    n.offsets = after.vertices.map((_, i) => (i < oldV ? n.offsets[i] : [0, 0, 0]));
    n.glow = after.vertices.map((_, i) => (i < oldV ? n.glow[i] : 1));
    // new internal detail inherits the state of the existing material it refines: a midpoint between verified
    // vertices is verified, next to failed material it is failed, otherwise untested; heat is averaged
    const adj = G.adjacency(after.vertices.length, after.edges);
    const inherit = (i) => { const olds = [...adj[i]].filter((k) => k < oldV); if (!olds.length) return { v: 0, h: 1 }; const vs = olds.map((k) => n.verified[k]); return { v: vs.includes(-1) ? -1 : vs.every((x) => x === 1) ? 1 : 0, h: olds.reduce((s, k) => s + n.heat[k], 0) / olds.length }; };
    const inh = after.vertices.map((_, i) => (i < oldV ? null : inherit(i)));
    n.heat = after.vertices.map((_, i) => (i < oldV ? n.heat[i] : inh[i].h));
    n.verified = after.vertices.map((_, i) => (i < oldV ? n.verified[i] : inh[i].v));
    n.refs.vertices = after.vertices.map((_, i) => (i < oldV ? n.refs.vertices[i] : ref));
    n.refs.edges = after.edges.map(([a, b]) => { const k = oldEdges.get(G.edgeKey(a, b)); return k != null ? n.refs.edges[k] : ref; });
    n.edgeWeight = after.edges.map(([a, b]) => { const k = oldEdges.get(G.edgeKey(a, b)); return k != null ? n.edgeWeight[k] : 0; });
    n.structure = after;
    for (const w of this.ripples.waves) if (w.nodeId === n.id) while (w.hops.length < after.vertices.length) w.hops.push(-1);
  }
  addSatellite(n, e, replayIndex) {
    const g = this.mapping.growth, shape = SATELLITE_SHAPES[Math.floor(this.rng() * SATELLITE_SHAPES.length)];
    const anchorVertex = Math.floor(this.rng() * n.structure.vertices.length);
    const id = `${n.id}/sat${n.satellites.length + 1}`;
    const s = this.createNode({ id, kind: "satellite", agentId: n.agentId, agentType: n.agentType, identity: n.identity, parentId: n.id, event: e, replayIndex, scale: n.scale * g.satelliteScale, orbit: null, anchor: { nodeId: n.id, vertexIndex: anchorVertex }, seedName: shape });
    s.position = [...n.position]; s.targetPosition = [...n.position]; s.spinBoost = 1;
    n.satellites.push(id);
  }

  // ---------- time ----------
  tick(dtMs, tNow = this.time + dtMs) {
    const dt = Math.min(0.1, Math.max(0, dtMs / 1000)); this.time = tNow;
    const D = this.mapping.dynamics, halfLife = this.mapping.verification?.heatHalfLifeSec ?? 75;
    const cool = Math.pow(0.5, dt / halfLife);
    const resolving = this.resolved ? Math.min(1, (tNow - this.resolvedAt) / (D.resolveSeconds * 1000)) : 0;
    for (const id of this.order) {
      const n = this.nodes.get(id);
      const slow = this.resolved ? 1 - 0.8 * resolving : 1;
      const spin = n.preset.spin || {};
      for (const [plane, rate] of Object.entries(spin)) if ((n.structure.dim === 4) || !plane.includes("w")) n.angles[plane] = (n.angles[plane] || 0) + rate * (D.baseSpin / 0.12) * (1 + n.spinBoost) * slow * dt;
      n.spinBoost *= Math.exp(-D.spinDecay * dt * 3);
      const relax = D.relaxRate * (1 + 2 * n.fixing + 3 * resolving) * dt;
      for (let i = 0; i < n.offsets.length; i++) {
        const o = n.offsets[i]; if (o[0] || o[1] || o[2]) n.offsets[i] = G.scale(o, Math.max(0, 1 - relax));
        if (n.glow[i] > 0) n.glow[i] = Math.max(0, n.glow[i] - dt * 0.6);
        if (n.heat[i] > 0.001) n.heat[i] *= cool; else n.heat[i] = 0;
      }
      n.fixing = Math.max(0, n.fixing - dt * 0.5);
      n.tension = Math.max(0, n.tension - D.tensionDecay * dt);
      if (n.orbit) n.targetPosition = this.orbitPosition(n.orbit, 1);
      n.position = G.lerp(n.position, n.targetPosition, Math.min(1, dt * 1.2));
      n.scale += (n.targetScale - n.scale) * Math.min(1, dt * 1.2);
      for (let i = 0; i < n.edgeWeight.length; i++) if (n.edgeWeight[i] < 0) n.edgeWeight[i] = Math.min(0, n.edgeWeight[i] + dt * 0.05 * (1 + 4 * n.fixing));
    }
    this.tension = Math.max(0, this.tension - D.tensionDecay * dt);
    this.ripples.prune(tNow);
    return resolving;
  }

  // World-space 3D vertices for a node (4D rotation → projection → 3D rotation → distortion → scale → place).
  worldVertices(n) {
    const s = n.structure;
    let pts, w = null;
    if (s.dim === 4) {
      const p = G.projectAll4to3(G.applyAll(G.rotations(4, n.angles), s.vertices), { distance: n.preset.projectionDistance || 3 });
      pts = p.map((q) => [q[0], q[1], q[2]]); w = p.map((q) => q[3]);
    } else pts = G.applyAll(G.rotations(3, Object.fromEntries(Object.entries(n.angles).filter(([k]) => !k.includes("w")))), s.vertices);
    const centre = this.anchorPosition(n);
    pts = pts.map((v, i) => G.add(centre, G.scale(G.add(v, n.offsets[i]), n.scale)));
    return { points: pts, w, centre };
  }
  anchorPosition(n) {
    if (!n.anchor) return n.position;
    const parent = this.nodes.get(n.anchor.nodeId); if (!parent) return n.position;
    const pw = this.worldVertices(parent).points[n.anchor.vertexIndex] || parent.position;
    const dir = G.normalize(G.sub(pw, parent.position));
    return G.add(pw, G.scale(dir, n.scale * 1.6));
  }

  // ---------- state for other renderings (music, UI) ----------
  verifiedFraction() {
    let v = 0, t = 0;
    for (const n of this.nodes.values()) if (n.kind === "agent") { t += n.verified.length; for (const x of n.verified) if (x === 1) v++; }
    return t ? v / t : 0;
  }
  state() {
    const agents = [...this.nodes.values()].filter((n) => n.kind === "agent").map((n) => ({ id: n.id, identity: n.identity, agentType: n.agentType, parentId: n.parentId, active: !n.docked, docked: n.docked, events: n.events, verified: n.verified.filter((x) => x === 1).length, failed: n.verified.filter((x) => x === -1).length, vertices: n.verified.length }));
    const phase = this.resolved ? "resolved" : this.waiting ? "waiting" : this.tension > 0.5 ? "tension" : this.task ? "working" : "idle";
    return { verifiedFraction: this.verifiedFraction(), tension: this.tension, resolved: this.resolved, waiting: this.waiting, agents, phase, task: this.task, current: this.current, time: this.time };
  }

  // ---------- inspection ----------
  describe(nodeId, vertexIndex) {
    const n = this.nodes.get(nodeId); if (!n) return null;
    const ref = n.refs.vertices[vertexIndex] || null;
    const edges = n.structure.edges.map((e, i) => (e[0] === vertexIndex || e[1] === vertexIndex ? i : -1)).filter((i) => i >= 0);
    const edgeRefs = edges.slice(0, 8).map((i) => ({ edge: n.structure.edges[i], weight: n.edgeWeight[i], ref: n.refs.edges[i] }));
    const ev = ref?.lastEventId ? this.events.get(ref.lastEventId) : ref?.eventId ? this.events.get(ref.eventId) : null;
    return { node: { id: n.id, kind: n.kind, identity: n.identity, label: n.preset.label, agentId: n.agentId, agentType: n.agentType, model: n.model || null, parentId: n.parentId, stage: n.stage, growth: Number(n.growth.toFixed(2)), events: n.events, docked: n.docked, vertices: n.structure.vertices.length, edges: n.structure.edges.length, seed: n.seedName, verified: n.verified.filter((x) => x === 1).length, failed: n.verified.filter((x) => x === -1).length }, vertex: { index: vertexIndex, ref, glow: n.glow[vertexIndex], heat: n.heat[vertexIndex], verified: n.verified[vertexIndex], offset: n.offsets[vertexIndex] }, edges: edgeRefs, event: ev, history: n.history.slice(-12), task: this.task, fingerprint: this.fingerprint, replayIndex: ref?.replayIndex ?? null };
  }
  complexity() { let v = 0, e = 0, f = 0; for (const n of this.nodes.values()) { v += n.structure.vertices.length; e += n.structure.edges.length; f += n.structure.faces.length; } return { nodes: this.nodes.size, vertices: v, edges: e, faces: f, waves: this.ripples.waves.length, rings: this.ripples.rings.length }; }
  snapshot() {
    const r = (x) => Math.round(x * 1e6) / 1e6;
    return { fingerprint: this.fingerprint, resolved: this.resolved, task: this.task, nodes: this.order.map((id) => { const n = this.nodes.get(id); return { id, kind: n.kind, identity: n.identity, seed: n.seedName, parentId: n.parentId, stage: n.stage, growth: r(n.growth), docked: n.docked, vertices: n.structure.vertices.map((v) => v.map(r)), edges: n.structure.edges, angles: Object.fromEntries(Object.entries(n.angles).map(([k, v]) => [k, r(v)])), offsets: n.offsets.map((o) => o.map(r)), heat: n.heat.map(r), verified: n.verified, edgeWeight: n.edgeWeight.map(r), position: n.position.map(r), scale: r(n.scale), satellites: n.satellites, tethers: n.tethers, refs: n.refs.vertices.map((x) => x?.eventId ?? null) }; }) };
  }
  snapshotHash() { return snapshotHash(this.snapshot()); }
}

function summarizePayload(p) {
  if (!p) return null;
  const keep = ["tool", "paths", "path", "signature", "kind", "framework", "passed", "failed", "skipped", "ok", "label", "agentType", "hash", "files", "insertions", "deletions", "name", "promptLen", "p50Min", "p90Min", "calls", "stage"];
  const out = {}; for (const k of keep) if (p[k] !== undefined) out[k] = p[k];
  return out;
}
