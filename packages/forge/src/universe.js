// The Forge universe composer ("as above, so below"): turns generic development event records into ONE
// multidimensional geometric composition in a shared coordinate system centred on the objective.
//
//   • origin        the objective: a small luminous solid at [0,0,0] that gains internal structure as work is verified
//   • plane         the reference plane y = 0: a hexagonal lattice that spreads ring by ring as planning establishes
//                   relationships; every other structure grows from one of its sites (shared foundations)
//   • field         a four-dimensional figure (24-cell by default) rotating in 4D planes through the origin; it passes
//                   through the plane, so some of its projected vertices are above and some below
//   • seed          an agent's arrival: a small solid at its home site, linked to the structure that spawned it
//   • crystal       implementation: one stacked, twisted prism per file rising from a lattice site; edits add stages
//                   or nest solids (existing structure transforms, nothing is thrown in from offscreen)
//   • root          research: a branching network growing downward and outward beneath the plane; dead ends stop,
//                   discoveries close loops back to the plane
//   • reflection    verification: a verified crystal gains its mirror image beneath the plane (its foundation);
//                   failing tests fracture the foundation
//   • membrane      a commit: a translucent polygon spanning the apexes of the verified crystals it seals
//   • links         real edges between bodies (collaboration, review, closure) so ripples travel across the whole
//                   universe; the world graph is the union of all bodies and links
//
// Independence: depends only on @alexandria/geometry, ripples.js and fingerprint.js and the generic event record
// described in composer.js. Deterministic: all randomness comes from a PRNG seeded by the session fingerprint.
// Every vertex, edge and link keeps a `ref` to the event that created it (provenance). Mappings are artistic
// interpretations of observable activity (forge-mapping.json "universe" section), not depictions of thought.
import * as G from "../../geometry/src/index.js";
import { RippleField } from "./ripples.js";
import { fingerprint, seedRandom, snapshotHash } from "./fingerprint.js";

const GOLDEN = 2.399963229728653;
const PARTNERS = { "24-cell": "16-cell", tesseract: "16-cell", "16-cell": "tesseract", cube: "octahedron", octahedron: "cube", icosahedron: "dodecahedron", dodecahedron: "icosahedron", tetrahedron: "tetrahedron" };

export const UNIVERSE_DEFAULTS = {
  spacing: 1,                      // lattice spacing (world units)
  plane: { initialRings: 1, maxRings: 5, revealsPerRing: 2, settleFrom: 0.35, ringThresholds: [0, 1, 3, 6, 10, 15], clearingRings: 1 },
  origin: { seed: "octahedron", scale: 0.32, maxEdges: 220 },
  field: { seed: "24-cell", scale: 1.35, projectionDistance: 3.2, maxEdges: 420 },
  seed: { scale: 0.16, lift: 0.22, shrinkOnDock: 0.8 },
  crystal: { radius: 0.3, stageHeight: 0.5, twist: 0.3141592653589793, taper: 0.88, maxStages: 5, maxEdges: 160, nestScale: 0.42, sidesByIdentity: { smith: 4, forge: 6, scout: 3 }, defaultSides: 4, homeRadius: 1.0 },
  root: { maxVertices: 160, segment: [0.45, 0.8], downBias: 0.55, branchChance: 0.3, spread: 0.55 },
  reflection: { dim: 0.85 },
  membrane: { max: 8, lift: 0.08 },
  agents: { radiusRings: 3, childOffset: 1.0 },
  links: { reviewPerCrystal: 2 },
  caps: { bodies: 90, links: 400 },
  waveReach: 6,
};

function buildSeed(name) {
  if (G.POLYTOPES[name]) return G.POLYTOPES[name]();
  if (G.PLATONIC[name]) return G.PLATONIC[name]();
  if (name === "star-tetrahedron") return G.starTetrahedron();
  return G.octahedron();
}
const merge = (a, b) => { const out = { ...a }; for (const k of Object.keys(b || {})) out[k] = b[k] && typeof b[k] === "object" && !Array.isArray(b[k]) ? merge(a[k] || {}, b[k]) : b[k]; return out; };

export class Universe {
  constructor({ mapping, identities, events = [], config = {}, hints = null } = {}) {
    this.mapping = mapping; this.identities = identities; this.config = config; this.hints = hints;
    this.U = merge(UNIVERSE_DEFAULTS, mapping.universe || {});
    this.reset(events);
  }
  reset(events = []) {
    this.fingerprint = fingerprint(events, { mapping: this.mapping, identities: this.identities, config: this.config, engine: "universe" });
    this.rng = seedRandom(this.fingerprint);
    this.bodies = new Map(); this.order = []; this.links = []; this.linkSeq = 0;
    this.agents = new Map(); this.agentCount = 0; this.childCounts = new Map();
    this.crystals = new Map();            // path → body id
    this.siteOwner = new Map();           // lattice vertex index → body id or agent key
    this.ripples = new RippleField({ maxWaves: 64, maxRings: 48 });
    this.world = null; this.base = new Map(); this.worldDirty = true;
    this.events = new Map(); this.eventCount = 0; this.totalEvents = events.length || null;
    this.task = null; this.project = null; this.session = null;
    this.resolved = false; this.resolvedAt = null; this.waiting = false; this.tension = 0;
    this.time = 0; this.current = null; this.reveals = 0; this.commits = 0; this.tests = { passed: 0, failed: 0 };
    this.milestones = { started: null, planning: null, firstAgent: null, firstCrystal: null, firstBelow: null, firstTest: null, firstPass: null, firstFail: null, firstCommit: null, resolved: null };
  }

  // ---------- identities and presets ----------
  identityFor(actor) {
    const ids = this.identities;
    if (!actor || actor.type === "main" || actor.type === "human" || actor.type === "system") return ids.main;
    if (actor.agentId && ids.byAgentId[actor.agentId]) return ids.byAgentId[actor.agentId];
    if (actor.agentType && ids.byAgentType[actor.agentType]) return ids.byAgentType[actor.agentType];
    return ids.fallback;
  }
  preset(name) { return this.identities.presets[name] || this.identities.presets[this.identities.fallback]; }
  get plane() { return this.bodies.get("plane"); }
  get origin() { return this.bodies.get("origin"); }
  get field() { return this.bodies.get("field"); }
  body(id) { return this.bodies.get(id); }

  // ---------- bodies ----------
  createBody({ id, kind, identity, structure, position = [0, 0, 0], scale = 1, event, replayIndex, anchor = null, site = null, agentKey = null, spin = null, dim = null, extra = {} }) {
    if (this.bodies.size >= this.U.caps.bodies) return null;
    const preset = this.preset(identity), ref = this.ref(event, replayIndex);
    const b = {
      id, kind, identity, preset, structure, dim: dim ?? structure.dim, position: [...position], scale, targetScale: scale,
      angles: {}, spin: spin || {}, spinBoost: 0,
      offsets: structure.vertices.map(() => [0, 0, 0]), glow: structure.vertices.map(() => 1), heat: structure.vertices.map(() => (kind === "origin" || kind === "plane" ? 0.2 : 0.8)),
      verified: structure.vertices.map(() => 0), edgeWeight: structure.edges.map(() => 0),
      refs: { vertices: structure.vertices.map(() => ref), edges: structure.edges.map(() => ref) },
      anchor, site, agentKey, bornAt: this.time, events: 0, growth: 0, stage: 0, tension: 0, fixing: 0, docked: false, history: [], ...extra,
    };
    this.bodies.set(id, b); this.order.push(id); this.worldDirty = true;
    this.record(b, event, replayIndex);
    return b;
  }
  record(b, e, replayIndex) { if (!b || !e) return; b.history.push({ i: replayIndex ?? this.eventCount, eventId: e.id, kind: e.kind, ts: e.ts }); if (b.history.length > 300) b.history.shift(); }
  ref(e, replayIndex) {
    return { eventId: e?.id ?? null, kind: e?.kind ?? null, ts: e?.ts ?? null, agentId: e?.actor?.agentId ?? null, actorType: e?.actor?.type ?? null, taskId: e?.task?.id ?? this.task?.id ?? null, tool: e?.payload?.tool ?? null, path: e?.payload?.paths?.[0] ?? e?.payload?.path ?? null, structure: e?.payload?.name ?? null, replayIndex: replayIndex ?? this.eventCount };
  }
  link(a, b, { kind = "link", identity = null, event = null, replayIndex = null, weight = 1 } = {}) {
    if (this.links.length >= this.U.caps.links) return null;
    if (!this.bodies.has(a.bodyId) || !this.bodies.has(b.bodyId)) return null;
    const l = { id: `l${++this.linkSeq}`, a: { ...a }, b: { ...b }, kind, identity, weight, ref: this.ref(event, replayIndex), bornAt: this.time };
    this.links.push(l); this.worldDirty = true;
    return l;
  }

  // Replace a body's structure, preserving per-vertex state for surviving indices; new vertices inherit from their
  // old neighbours (a midpoint between verified vertices is verified) and start displaced by `emerge` so they
  // relax into place (growth is visible as emergence, never as popping).
  adoptStructure(b, after, ref, emerge = null) {
    const oldV = b.structure.vertices.length, oldEdges = new Map(b.structure.edges.map(([x, y], i) => [G.edgeKey(x, y), i]));
    const adj = G.adjacency(after.vertices.length, after.edges);
    const inherit = (i) => { const olds = [...adj[i]].filter((k) => k < oldV); if (!olds.length) return { v: 0, h: 1 }; const vs = olds.map((k) => b.verified[k]); return { v: vs.includes(-1) ? -1 : vs.every((x) => x === 1) ? 1 : 0, h: olds.reduce((s, k) => s + b.heat[k], 0) / olds.length }; };
    b.offsets = after.vertices.map((v, i) => (i < oldV ? b.offsets[i] : emerge ? emerge(v, i) : [0, 0, 0]));
    b.glow = after.vertices.map((_, i) => (i < oldV ? b.glow[i] : 1));
    const inh = after.vertices.map((_, i) => (i < oldV ? null : inherit(i)));
    b.heat = after.vertices.map((_, i) => (i < oldV ? b.heat[i] : Math.max(0.6, inh[i].h)));
    b.verified = after.vertices.map((_, i) => (i < oldV ? b.verified[i] : inh[i].v === 1 ? 0 : inh[i].v)); // new material is untested even inside verified regions
    b.refs.vertices = after.vertices.map((_, i) => (i < oldV ? b.refs.vertices[i] : ref));
    b.refs.edges = after.edges.map(([x, y]) => { const k = oldEdges.get(G.edgeKey(x, y)); return k != null ? b.refs.edges[k] : ref; });
    b.edgeWeight = after.edges.map(([x, y]) => { const k = oldEdges.get(G.edgeKey(x, y)); return k != null ? b.edgeWeight[k] : 0; });
    b.structure = after; this.worldDirty = true;
  }

  // ---------- the world graph (all bodies + links) for ripples ----------
  rebuildWorld() {
    if (!this.worldDirty) return this.world;
    let total = 0; this.base = new Map();
    for (const id of this.order) { const b = this.bodies.get(id); this.base.set(id, total); total += b.structure.vertices.length; }
    const edges = [];
    for (const id of this.order) { const b = this.bodies.get(id), off = this.base.get(id); for (const [x, y] of b.structure.edges) edges.push([x + off, y + off]); }
    for (const l of this.links) { const ga = this.gi(l.a.bodyId, l.a.i), gb = this.gi(l.b.bodyId, l.b.i); if (ga != null && gb != null) edges.push([ga, gb]); }
    this.world = { id: "world", dim: 3, vertices: new Array(total).fill(0), edges, faces: [], cells: [], meta: {} };
    for (const w of this.ripples.waves) { const g = this.gi(w.originBody, w.originIndex); w.hops = g == null ? new Array(total).fill(-1) : G.hopDistances(this.world, g); }
    this.worldDirty = false;
    return this.world;
  }
  gi(bodyId, i) { const base = this.base.get(bodyId); if (base == null) return null; const b = this.bodies.get(bodyId); if (!b || i >= b.structure.vertices.length) return null; return base + i; }
  vertexState(bodyId, i, t) { this.rebuildWorld(); const g = this.gi(bodyId, i); return g == null ? { amp: 0, hue: null, energy: 0 } : this.ripples.vertexState("world", g, t); }
  edgeState(bodyId, a, b, t) { this.rebuildWorld(); const ga = this.gi(bodyId, a), gb = this.gi(bodyId, b); return ga == null || gb == null ? { amp: 0, hue: null, energy: 0 } : this.ripples.edgeState("world", ga, gb, t); }

  // ---------- classification (shared mapping with the composer) ----------
  classify(e) {
    const cls = e.classification || [];
    const best = (scheme) => cls.filter((c) => c.scheme === scheme).sort((a, b) => b.confidence - a.confidence)[0]?.value || null;
    const operation = best("operation") || (e.kind === "test.run" ? "test" : e.kind === "git.commit" ? "commit" : "other");
    const category = best("work-category");
    const opMap = this.mapping.operations[operation] || this.mapping.operations.other;
    const catMap = category ? this.mapping.categories[category] : null;
    const hue = catMap?.hue ?? (category && this.hints ? this.hints("work-category", category)?.hue : null) ?? null;
    const op = catMap && ["distort", "wave", "scaffold", "branch"].includes(catMap.op) && opMap.op !== "seal" ? catMap.op : opMap.op;
    return { operation, category, op, growth: opMap.growth ?? 0.2, spin: opMap.spin ?? 0.1, hue, path: e.payload?.paths?.[0] ?? e.payload?.path ?? null };
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
      case "task.start": this.task = { id: e.task?.id || e.id, title: e.task?.title || null, startedAt: e.ts }; this.resolved = false; this.resolvedAt = null; this.ensureUniverse(e, replayIndex); break;
      case "prompt.submit": this.waiting = false; if (this.field) this.field.spinBoost += 0.5; break;
      case "notification": if (e.payload?.kind === "permission_prompt" || e.payload?.kind === "idle_prompt") this.waiting = true; break;
      case "agent.start": this.spawnAgent(e, replayIndex); break;
      case "agent.stop": this.dockAgent(e, tNow, replayIndex); break;
      case "tool.call": { const a = this.agentFor(e, replayIndex); a.events++; const s = this.bodies.get(a.seedId); if (s) s.spinBoost += 0.3; break; }
      case "tool.result": case "tool.failure": this.waiting = false; this.applyTool(e, tNow, replayIndex); break;
      case "test.run": this.applyTest(e, tNow, replayIndex); break;
      case "git.commit": this.applyCommit(e, tNow, replayIndex); break;
      case "code.structure": { const a = this.agentFor(e, replayIndex); const c = a.lastCrystal ? this.bodies.get(a.lastCrystal) : null; if (c) { const i = c.structure.meta.apexIndex ?? c.structure.vertices.length - 1; c.refs.vertices[i] = { ...c.refs.vertices[i], structure: e.payload?.name ?? c.refs.vertices[i].structure, structureKind: e.payload?.kind ?? null }; } break; }
      case "turn.stop": if (!sub) { this.ensureUniverse(e, replayIndex); this.wave(this.origin, 0, tNow, "turnStop", e); for (const b of this.bodies.values()) b.fixing = Math.max(b.fixing, 0.5); } break;
      case "task.end": this.resolve(e, tNow, replayIndex); break;
      default: break;
    }
  }

  ensureUniverse(e, replayIndex) {
    if (this.origin) return;
    const U = this.U, coreId = this.identities.core && this.identities.presets[this.identities.core] ? this.identities.core : this.identities.main;
    this.milestones.started = this.time;
    // the reference plane: ring 0 is the origin's site
    const lattice = G.hexLattice({ rings: U.plane.initialRings, spacing: U.spacing });
    this.createBody({ id: "plane", kind: "plane", identity: this.identities.main, structure: lattice, event: e, replayIndex, extra: { rings: U.plane.initialRings } });
    this.plane.heat = this.plane.heat.map(() => 0.5);
    // the objective
    const o = this.createBody({ id: "origin", kind: "origin", identity: coreId, structure: buildSeed(U.origin.seed), scale: U.origin.scale, event: e, replayIndex, site: 0, spin: { xz: 0.05, xy: 0.02 } });
    this.siteOwner.set(0, "origin");
    for (let i = 0; i < o.structure.vertices.length; i++) this.link({ bodyId: "origin", i }, { bodyId: "plane", i: 0 }, { kind: "foundation", identity: coreId, event: e, replayIndex });
    // the four-dimensional field through the plane
    const mainPreset = this.preset(this.identities.main);
    const f = this.createBody({ id: "field", kind: "field", identity: this.identities.main, structure: buildSeed(mainPreset.seed && G.POLYTOPES[mainPreset.seed] ? mainPreset.seed : U.field.seed), scale: U.field.scale, event: e, replayIndex, spin: mainPreset.spin || { xw: 0.12, zw: 0.07, xy: 0.03 }, extra: { projectionDistance: mainPreset.projectionDistance || U.field.projectionDistance } });
    f.heat = f.heat.map(() => 0.3);
    for (let k = 0; k < 4; k++) this.link({ bodyId: "field", i: Math.floor(this.rng() * f.structure.vertices.length) }, { bodyId: "plane", i: 1 + Math.floor(this.rng() * 6) }, { kind: "field", identity: this.identities.main, event: e, replayIndex, weight: 0.5 });
    // the main agent lives at the origin
    this.agents.set("main", { key: "main", agentId: null, agentType: "main", identity: this.identities.main, home: 0, homePos: [0, 0, 0], parentKey: null, docked: false, events: 0, seedId: null, rootId: null, crystals: [], lastCrystal: null, model: null, bornAt: this.time });
  }

  // ---------- agents, homes and sites ----------
  agentFor(e, replayIndex) {
    this.ensureUniverse(e, replayIndex);
    if (e.actor?.type === "subagent" && e.actor.agentId) return this.agents.get("agent:" + e.actor.agentId) || this.spawnAgent(e, replayIndex);
    return this.agents.get("main");
  }
  sitePosition(i) { return this.plane.structure.vertices[i]; }
  // Planning accumulates growth; the plane gains a ring each time the accumulated growth crosses the next
  // threshold (the ground spreads gradually, not on every read). `force` adds a ring regardless (a site is needed).
  extendPlane(e, replayIndex, { amount = 1, force = false } = {}) {
    const p = this.plane, U = this.U;
    if (p.rings >= U.plane.maxRings) return false;
    if (!force) { p.growth += amount; if (p.growth < U.plane.ringThresholds[p.rings]) return false; }
    const after = G.extendHexLattice(p.structure);
    const k = after.meta.rings;
    this.adoptStructure(p, after, this.ref(e, replayIndex), (v) => G.scale(v, -U.plane.settleFrom)); // new ring emerges from inside: the ground spreads
    p.rings = k; this.record(p, e, replayIndex);
    if (!this.milestones.planning) this.milestones.planning = this.time;
    return true;
  }
  // nearest unoccupied lattice site to a point (extends the plane when none is free); deterministic
  freeSiteNear(point, e, replayIndex) {
    for (;;) {
      let best = -1, bd = Infinity;
      const ring = this.plane.structure.meta.ring || [];
      this.plane.structure.vertices.forEach((v, i) => { if (this.siteOwner.has(i) || (ring[i] ?? 0) <= this.U.plane.clearingRings) return; const d = Math.hypot(v[0] - point[0], v[2] - point[2]); if (d < bd - 1e-9) { bd = d; best = i; } }); // the rings around the origin stay clear
      if (best >= 0) return best;
      if (!this.extendPlane(e, replayIndex, { force: true })) { let near = 0, nd = Infinity; this.plane.structure.vertices.forEach((v, i) => { const d = Math.hypot(v[0] - point[0], v[2] - point[2]); if (d < nd) { nd = d; near = i; } }); return near; }
    }
  }
  spawnAgent(e, replayIndex) {
    const key = "agent:" + e.actor.agentId;
    if (this.agents.has(key)) return this.agents.get(key);
    this.ensureUniverse(e, replayIndex);
    const U = this.U, identity = this.identityFor(e.actor);
    const parentKey = e.parent?.agentId && this.agents.has("agent:" + e.parent.agentId) ? "agent:" + e.parent.agentId : "main";
    const parent = this.agents.get(parentKey);
    let want;
    if (parentKey === "main") { const k = this.agentCount++; const r = U.agents.radiusRings * U.spacing, a = 0.9 + k * GOLDEN; want = [Math.cos(a) * r, 0, Math.sin(a) * r]; }
    else { const k = this.childCounts.get(parentKey) || 0; this.childCounts.set(parentKey, k + 1); const a = 0.4 + k * GOLDEN; want = G.add(parent.homePos, [Math.cos(a) * U.agents.childOffset * U.spacing, 0, Math.sin(a) * U.agents.childOffset * U.spacing]); }
    const home = this.freeSiteNear(want, e, replayIndex);
    const agent = { key, agentId: e.actor.agentId, agentType: e.actor.agentType || null, identity, home, homePos: [...this.sitePosition(home)], parentKey, docked: false, events: 0, seedId: null, rootId: null, crystals: [], lastCrystal: null, model: e.actor.model || null, bornAt: this.time };
    this.agents.set(key, agent); this.siteOwner.set(home, key);
    if (!this.milestones.firstAgent) this.milestones.firstAgent = this.time;
    // arrival: a small solid above the home site, linked to the site and to the spawner (collaboration)
    const seedId = "seed:" + e.actor.agentId;
    const s = this.createBody({ id: seedId, kind: "seed", identity, structure: buildSeed(this.preset(identity).seed && G.PLATONIC[this.preset(identity).seed] ? this.preset(identity).seed : "tetrahedron"), position: G.add(agent.homePos, [0, U.seed.lift, 0]), scale: U.seed.scale, event: e, replayIndex, anchor: { bodyId: "plane", vertexIndex: home }, site: home, agentKey: key, spin: { xz: 0.25, xy: 0.1 } });
    if (s) {
      agent.seedId = seedId;
      s.offsets = s.offsets.map(() => [0, -U.seed.lift / U.seed.scale, 0]); // rises out of the ground
      this.link({ bodyId: seedId, i: 0 }, { bodyId: "plane", i: home }, { kind: "foundation", identity, event: e, replayIndex });
      const from = parent.seedId ? { bodyId: parent.seedId, i: 1 % this.bodies.get(parent.seedId).structure.vertices.length } : { bodyId: "origin", i: Math.floor(this.rng() * this.origin.structure.vertices.length) };
      this.link({ bodyId: seedId, i: 1 % s.structure.vertices.length }, from, { kind: "collaboration", identity, event: e, replayIndex, weight: 0.6 });
    }
    this.wave(this.plane, home, this.time, "agentStart", e, { hue: this.preset(identity).hue });
    if (this.field) this.field.spinBoost += 0.3;
    return agent;
  }
  dockAgent(e, tNow, replayIndex) {
    const a = this.agents.get("agent:" + e.actor.agentId); if (!a || a.docked) return;
    a.docked = true; a.stoppedAt = tNow;
    const s = this.bodies.get(a.seedId); if (s) { s.docked = true; s.targetScale = s.scale * this.U.seed.shrinkOnDock; this.record(s, e, replayIndex); }
    // discovery: a researcher's return closes its branches back to the plane
    const root = a.rootId ? this.bodies.get(a.rootId) : null;
    if (root) { for (const tip of G.tips(root.structure, new Set([0])).slice(0, 4)) { if (root.verified[tip] === -1) continue; const site = G.nearestLatticeVertex(this.plane.structure, G.add(root.position, G.scale(G.add(root.structure.vertices[tip], root.offsets[tip]), root.scale))); this.link({ bodyId: root.id, i: tip }, { bodyId: "plane", i: site }, { kind: "closure", identity: a.identity, event: e, replayIndex, weight: 0.7 }); root.verified[tip] = Math.max(root.verified[tip], 0); } root.docked = true; }
    this.wave(this.plane, a.home, tNow, "agentStop", e, { hue: this.preset(a.identity).hue });
  }

  // ---------- tools ----------
  applyTool(e, tNow, replayIndex) {
    const a = this.agentFor(e, replayIndex), c = this.classify(e), failed = e.kind === "tool.failure";
    a.events++;
    const seed = a.seedId ? this.bodies.get(a.seedId) : null; if (seed) { seed.spinBoost += c.spin; this.record(seed, e, replayIndex); }
    const research = a.identity === "scout" || c.category === "research";
    if (failed) {
      if (research) this.deadEnd(a, e, replayIndex); else { const cr = a.lastCrystal ? this.bodies.get(a.lastCrystal) : seed || this.field; if (cr) { this.distort(cr, 0.8, e, replayIndex); cr.tension = Math.min(1, cr.tension + 0.35); } }
      this.tension = Math.min(1, this.tension + 0.2);
      this.wave(this.homeBody(a), this.homeVertex(a), tNow, "toolFailure", e); return;
    }
    switch (c.op) {
      case "assemble": if (c.path) this.crystalGrow(c.path, a, e, replayIndex, "create"); else this.igniteHome(a, e, replayIndex); break;
      case "transform": if (c.path) this.crystalGrow(c.path, a, e, replayIndex, "edit"); else if (this.field) this.rotateField(e, replayIndex); break;
      case "reveal": this.reveal(a, c, e, replayIndex, research); break;
      case "branch": if (research) this.branch(a, e, replayIndex, 1); else if (a.key === "main") { this.extendPlane(e, replayIndex, { amount: 0.6 }); this.growField(e, replayIndex, 0.6); } else this.igniteHome(a, e, replayIndex); break;
      case "scaffold": this.extendPlane(e, replayIndex, { amount: 1 }); this.growField(e, replayIndex, 1); if (!this.milestones.planning) this.milestones.planning = this.time; break;
      case "distort": { const cr = a.lastCrystal ? this.bodies.get(a.lastCrystal) : null; if (cr) { this.distort(cr, 0.45, e, replayIndex); cr.tension = Math.min(1, cr.tension + 0.15); } break; }
      case "pulse": case "wave": this.wave(this.homeBody(a), this.homeVertex(a), tNow, "toolResult", e, { hue: c.hue ?? (c.op === "wave" ? 130 : undefined) }); break;
      case "seal": this.wave(this.homeBody(a), this.homeVertex(a), tNow, "commit", e); break;
      case "hold": break;
      default: this.igniteHome(a, e, replayIndex); break;
    }
    if (c.op !== "hold") this.wave(this.homeBody(a), this.homeVertex(a), tNow, "toolResult", e, { hue: c.hue, strength: 0.2 + 0.2 * c.growth });
  }
  homeBody(a) { return (a.lastCrystal && this.bodies.get(a.lastCrystal)) || (a.rootId && this.bodies.get(a.rootId)) || (a.seedId && this.bodies.get(a.seedId)) || this.origin; }
  homeVertex(a) { const b = this.homeBody(a); return b.kind === "crystal" ? b.structure.meta.apexIndex ?? 0 : 0; }
  igniteHome(a, e, replayIndex) { const b = this.homeBody(a); for (let j = 0; j < 2; j++) this.touch(b, Math.floor(this.rng() * b.structure.vertices.length), e, replayIndex); }

  reveal(a, c, e, replayIndex, research) {
    if (research) { this.branch(a, e, replayIndex, 0.7); return; }
    const crystalId = c.path ? this.crystals.get(c.path) : null;
    if (crystalId && this.bodies.has(crystalId)) { // reading existing work: review — lights it and links it to the reader
      const cr = this.bodies.get(crystalId);
      for (let j = 0; j < 2; j++) this.touch(cr, Math.floor(this.rng() * cr.structure.vertices.length), e, replayIndex, { verifiedReset: false });
      cr.glow = cr.glow.map(() => 1); this.record(cr, e, replayIndex);
      const reader = a.key === "main" ? { bodyId: "field", i: Math.floor(this.rng() * this.field.structure.vertices.length) } : a.seedId ? { bodyId: a.seedId, i: 0 } : null;
      const existing = this.links.filter((l) => l.kind === "review" && l.b.bodyId === crystalId).length;
      if (reader && existing < this.U.links.reviewPerCrystal) this.link(reader, { bodyId: crystalId, i: cr.structure.meta.apexIndex ?? 0 }, { kind: "review", identity: a.identity, event: e, replayIndex, weight: 0.5 });
      if (this.field) this.field.spinBoost += 0.4;
      return;
    }
    if (a.key === "main" && !this.milestones.firstCrystal) { // planning: reading establishes the ground
      this.reveals++;
      this.extendPlane(e, replayIndex, { amount: 1 / this.U.plane.revealsPerRing });
      const p = this.plane; for (let j = 0; j < 3; j++) this.touch(p, Math.floor(this.rng() * p.structure.vertices.length), e, replayIndex, { verifiedReset: false });
      this.growField(e, replayIndex, 0.5);
      return;
    }
    this.igniteHome(a, e, replayIndex);
  }

  // ---------- crystals (implementation) ----------
  crystalGrow(path, a, e, replayIndex, mode) {
    const U = this.U.crystal, ref = this.ref(e, replayIndex);
    let id = this.crystals.get(path), cr = id ? this.bodies.get(id) : null;
    if (!cr) {
      const k = a.crystals.length, ang = 0.7 + k * GOLDEN, want = G.add(a.homePos, [Math.cos(ang) * U.homeRadius * this.U.spacing, 0, Math.sin(ang) * U.homeRadius * this.U.spacing]);
      const site = this.freeSiteNear(want, e, replayIndex);
      id = "crystal:" + path;
      const sides = U.sidesByIdentity[a.identity] ?? U.defaultSides;
      const twist = (this.rng() < 0.5 ? -1 : 1) * U.twist;
      cr = this.createBody({ id, kind: "crystal", identity: a.identity, structure: G.crystal({ sides, radius: U.radius, stages: 1, stageHeight: U.stageHeight, twist, taper: U.taper }), position: [...this.sitePosition(site)], event: e, replayIndex, anchor: { bodyId: "plane", vertexIndex: site }, site, agentKey: a.key, extra: { path, nested: 0 } });
      if (!cr) return null;
      cr.offsets = cr.offsets.map((_, i) => [0, -cr.structure.vertices[i][1], 0]); // rises out of the plane
      this.crystals.set(path, id); this.siteOwner.set(site, id); a.crystals.push(id);
      for (let i = 0; i < sides; i++) this.link({ bodyId: id, i }, { bodyId: "plane", i: site }, { kind: "foundation", identity: a.identity, event: e, replayIndex });
      if (!this.milestones.firstCrystal) this.milestones.firstCrystal = this.time;
    } else {
      const m = cr.structure.meta;
      if (cr.tension > 0.2) { cr.fixing = 1; cr.tension = Math.max(0, cr.tension - 0.3); }
      if (m.stages < U.maxStages && cr.structure.edges.length < U.maxEdges) {
        const after = G.extendCrystal(cr.structure, { twist: (m.stages % 2 ? -1 : 1) * m.twist });
        const topY = cr.structure.vertices[cr.structure.vertices.length - 1][1];
        this.adoptStructure(cr, after, ref, (v) => [0, Math.min(0, topY - v[1]), 0]); // the new stage rises from the old apex
      } else if (cr.nested < 1 && cr.structure.edges.length < U.maxEdges) {
        const partner = PARTNERS[this.preset(a.identity).seed] || "octahedron";
        const inner = G.translateStructure(G.scaleStructure(G.normalizeRadius(buildSeed(partner)), U.radius * U.nestScale * 2), [0, m.stageHeight * 0.5, 0]);
        const after = G.mergeStructures([cr.structure, inner], cr.structure.id + "+" + partner); after.dim = 3; after.meta = { ...m, nestedFrom: cr.structure.vertices.length };
        const outer = cr.structure.vertices.length;
        for (let j = outer; j < after.vertices.length; j++) { let best = -1, bd = Infinity; for (let i = 0; i < outer; i++) { const d = G.distance(after.vertices[i], after.vertices[j]); if (d < bd) { bd = d; best = i; } } after.edges.push([best, j]); }
        after.edges = G.uniqueEdges(after.edges);
        this.adoptStructure(cr, after, ref); cr.nested++;
      } else { // bounded: beyond the caps an edit only re-lights existing material
        for (let j = 0; j < 3; j++) this.touch(cr, Math.floor(this.rng() * cr.structure.vertices.length), e, replayIndex);
      }
      // the touched stage is hot and untested again
      const from = Math.max(0, cr.structure.vertices.length - m.sides - 2);
      for (let i = from; i < cr.structure.vertices.length; i++) this.touch(cr, i, e, replayIndex);
    }
    cr.events++; cr.growth += mode === "create" ? 1 : 0.6; this.record(cr, e, replayIndex); a.lastCrystal = id;
    return cr;
  }

  // ---------- roots (research) ----------
  ensureRoot(a, e, replayIndex) {
    if (a.rootId && this.bodies.has(a.rootId)) return this.bodies.get(a.rootId);
    const id = "root:" + a.key.replace("agent:", ""), p0 = [...a.homePos];
    const s = G.makeStructure({ id: "root", dim: 3, vertices: [[0, 0, 0], [0, -this.U.root.segment[0], 0]], edges: [[0, 1]], meta: { form: "root" } });
    const r = this.createBody({ id, kind: "root", identity: a.identity, structure: s, position: p0, event: e, replayIndex, anchor: { bodyId: "plane", vertexIndex: a.home }, site: a.home, agentKey: a.key, extra: { dirs: [[0, -1, 0], [0, -1, 0]] } });
    if (!r) return null;
    r.offsets[1] = [0, this.U.root.segment[0], 0]; // grows down out of the plane
    this.link({ bodyId: id, i: 0 }, { bodyId: "plane", i: a.home }, { kind: "foundation", identity: a.identity, event: e, replayIndex });
    a.rootId = id;
    if (!this.milestones.firstBelow) this.milestones.firstBelow = this.time;
    return r;
  }
  // Research grows the root network by one or more segments (a read extends, a search extends and branches).
  branch(a, e, replayIndex, strength = 1) {
    const segments = 1 + Math.round(strength);
    for (let k = 0; k < segments; k++) this.branchOnce(a, e, replayIndex, strength);
  }
  branchOnce(a, e, replayIndex, strength = 1) {
    const r = this.ensureRoot(a, e, replayIndex); if (!r) return;
    const R = this.U.root, s = r.structure;
    if (s.vertices.length >= R.maxVertices) { for (let j = 0; j < 2; j++) this.touch(r, Math.floor(this.rng() * s.vertices.length), e, replayIndex); return; }
    const live = G.tips(s, new Set([0])).filter((i) => r.verified[i] !== -1);
    let from;
    if (!live.length || this.rng() < R.branchChance) { from = 1 + Math.floor(this.rng() * (s.vertices.length - 1)); } else from = live[Math.floor(this.rng() * live.length)];
    const prev = r.dirs[from] || [0, -1, 0];
    const rnd = G.normalize([this.rng.range(-1, 1), this.rng.range(-1, 1), this.rng.range(-1, 1)]);
    let dir = G.normalize(G.add(G.add(G.scale(prev, 0.6), G.scale(rnd, R.spread)), [0, -R.downBias, 0]));
    if (dir[1] > -0.15) dir = G.normalize([dir[0], -0.15, dir[2]]); // roots stay beneath the plane
    const len = this.rng.range(R.segment[0], R.segment[1]) * (0.7 + 0.3 * strength);
    const p = G.add(s.vertices[from], G.scale(dir, len));
    const after = G.addVertex(s, p, [from]); after.meta = s.meta;
    this.adoptStructure(r, after, this.ref(e, replayIndex), () => G.scale(dir, -len)); // emerges from its parent vertex
    r.dirs.push(dir); r.dirs[from] = dir;
    const ni = after.vertices.length - 1; this.touch(r, ni, e, replayIndex); r.glow[ni] = 1; r.events++; r.growth += strength; this.record(r, e, replayIndex);
  }
  deadEnd(a, e, replayIndex) {
    const r = this.ensureRoot(a, e, replayIndex); if (!r) return;
    const live = G.tips(r.structure, new Set([0])).filter((i) => r.verified[i] !== -1);
    const tip = live.length ? live[live.length - 1] : r.structure.vertices.length - 1;
    r.verified[tip] = -1; r.heat[tip] = 1; r.offsets[tip] = G.add(r.offsets[tip], [this.rng.range(-0.15, 0.15), -0.1, this.rng.range(-0.15, 0.15)]);
    r.refs.vertices[tip] = { ...r.refs.vertices[tip], lastEventId: e.id, lastKind: e.kind, deadEnd: true }; this.record(r, e, replayIndex);
  }

  // ---------- the field (planning, four dimensions) ----------
  growField(e, replayIndex, amount) {
    const f = this.field; if (!f) return;
    f.growth += amount; f.spinBoost += 0.3;
    const thresholds = [2, 5, 9];
    while (f.stage < thresholds.length && f.growth >= thresholds[f.stage]) {
      const stage = f.stage++;
      if (f.structure.edges.length >= this.U.field.maxEdges) break;
      let after;
      if (stage === 1) { const partner = PARTNERS[f.structure.id] || "16-cell"; const inner = G.scaleStructure(G.normalizeRadius(buildSeed(partner)), 0.55); after = G.mergeStructures([f.structure, inner], f.structure.id + "+" + partner); after.dim = 4; const outer = f.structure.vertices.length; for (let j = outer; j < after.vertices.length; j++) { let best = -1, bd = Infinity; for (let i = 0; i < outer; i++) { const d = G.distance(after.vertices[i], after.vertices[j]); if (d < bd) { bd = d; best = i; } } after.edges.push([best, j]); } after.edges = G.uniqueEdges(after.edges); }
      else after = G.connectNearest(f.structure, 1);
      this.adoptStructure(f, after, this.ref(e, replayIndex));
    }
    for (let j = 0; j < 2; j++) this.touch(f, Math.floor(this.rng() * f.structure.vertices.length), e, replayIndex, { verifiedReset: false });
  }
  rotateField(e, replayIndex) { const f = this.field; const plane = G.PLANES_4D[Math.floor(this.rng() * G.PLANES_4D.length)]; f.angles[plane] = (f.angles[plane] || 0) + (this.rng() < 0.5 ? -1 : 1) * 0.2; f.spinBoost += 0.5; this.touch(f, Math.floor(this.rng() * f.structure.vertices.length), e, replayIndex, { verifiedReset: false }); }

  // ---------- verification ----------
  // Tests verify the region the actor built: its crystals (and its parent's, a helper tests its parent's work),
  // plus whatever the wave reaches in the world graph within `waveReach` hops. Passing cools, sharpens and gives
  // each verified crystal its reflection beneath the plane; failing fractures and marks the region unstable.
  applyTest(e, tNow, replayIndex) {
    const a = this.agentFor(e, replayIndex), ok = e.payload?.ok === true, V = this.mapping.verification || {};
    a.events++;
    if (!this.milestones.firstTest) this.milestones.firstTest = this.time;
    const parent = a.parentKey && a.parentKey !== "main" ? this.agents.get(a.parentKey) : null;
    const targets = [...a.crystals, ...(parent ? parent.crystals : [])].map((id) => this.bodies.get(id)).filter(Boolean);
    if (!targets.length) targets.push(this.homeBody(a));
    this.rebuildWorld();
    for (const cr of targets) {
      const originIndex = cr.kind === "crystal" ? 0 : Math.floor(this.rng() * cr.structure.vertices.length);
      const w = this.wave(cr, originIndex, tNow, ok ? "testPass" : "testFail", e, { strength: 1 });
      const reach = w ? w.hops : null;
      // local: the whole crystal; global: everything within reach in the world graph
      const hit = (bodyId, i) => { const g = this.gi(bodyId, i); return reach && g != null && reach[g] >= 0 && reach[g] <= this.U.waveReach; };
      for (const b of this.bodies.values()) {
        if (b.kind === "plane" && !ok) continue;
        for (let i = 0; i < b.structure.vertices.length; i++) {
          const inside = b === cr || (b.kind === "reflection" && b.mirrorOf === cr.id);
          if (!inside && !hit(b.id, i)) continue;
          if (ok) { if (b.kind !== "plane" || inside) b.verified[i] = 1; b.heat[i] *= 0.3; }
          else if (inside || b.kind === "crystal") { b.verified[i] = -1; }
        }
        b.structure.edges.forEach(([x, y], i) => { if (b === cr || (hit(b.id, x) && hit(b.id, y))) b.edgeWeight[i] = Math.max(-1, Math.min(1, b.edgeWeight[i] + (ok ? (V.verifiedReinforce ?? 0.12) : -(V.failWeaken ?? 0.2)))); });
      }
      this.record(cr, e, replayIndex);
      if (ok) { cr.tension = 0; cr.fixing = 1; if (cr.kind === "crystal") this.reflect(cr, e, replayIndex); }
      else { this.distortRegion(cr, 0.8, e, replayIndex); cr.tension = Math.min(1, cr.tension + 0.4); const refl = this.bodies.get("reflection:" + cr.id); if (refl) this.distortRegion(refl, 1.0, e, replayIndex); }
    }
    if (ok) { this.tests.passed++; this.tension = Math.max(0, this.tension - 0.3); this.growOrigin(e, replayIndex, V.coreGrowthPerPass ?? 1); if (!this.milestones.firstPass) this.milestones.firstPass = this.time; }
    else { this.tests.failed++; this.tension = Math.min(1, this.tension + 0.3); if (!this.milestones.firstFail) this.milestones.firstFail = this.time; }
  }
  reflect(cr, e, replayIndex) {
    const id = "reflection:" + cr.id, existing = this.bodies.get(id), mirrored = G.mirrorY(cr.structure);
    if (!existing) {
      const r = this.createBody({ id, kind: "reflection", identity: cr.identity, structure: mirrored, position: [...cr.position], event: e, replayIndex, anchor: cr.anchor, site: cr.site, agentKey: cr.agentKey, extra: { mirrorOf: cr.id, path: cr.path } });
      if (!r) return;
      r.offsets = r.offsets.map((_, i) => [0, -mirrored.vertices[i][1], 0]); // sinks from the plane into the ground
      r.verified = r.verified.map(() => 1); r.heat = r.heat.map(() => 0.2);
      for (let i = 0; i < (cr.structure.meta.sides || 1); i++) this.link({ bodyId: id, i }, { bodyId: "plane", i: cr.site }, { kind: "foundation", identity: cr.identity, event: e, replayIndex });
      if (!this.milestones.firstBelow) this.milestones.firstBelow = this.time;
    } else if (existing.structure.vertices.length !== mirrored.vertices.length) { // the foundation catches up with the building
      const oldV = existing.structure.vertices.length;
      this.adoptStructure(existing, mirrored, this.ref(e, replayIndex), (v, i) => (i >= oldV ? [0, -v[1] + (existing.structure.vertices[Math.min(oldV - 1, i)]?.[1] ?? 0), 0] : [0, 0, 0]));
      existing.verified = existing.verified.map(() => 1); existing.offsets = existing.offsets.map((o) => G.scale(o, 0.5));
    } else { existing.verified = existing.verified.map(() => 1); existing.fixing = 1; }
  }
  growOrigin(e, replayIndex, amount) {
    const o = this.origin; if (!o) return;
    o.growth += amount; o.spinBoost += 0.6;
    const thresholds = [1, 3]; // bounded: one subdivision and one connection pass, then only brightness and scale
    while (o.stage < thresholds.length && o.growth >= thresholds[o.stage]) {
      const stage = o.stage++;
      if (o.structure.edges.length >= this.U.origin.maxEdges) break;
      const after = stage % 2 === 0 ? G.subdivide(o.structure, { spherize: true }) : G.connectNearest(o.structure, 1);
      this.adoptStructure(o, after, this.ref(e, replayIndex));
      o.verified = o.verified.map(() => 1);
    }
    o.targetScale = this.U.origin.scale * (1 + 0.3 * o.stage + 0.04 * Math.min(6, o.growth));
  }

  // ---------- commits ----------
  applyCommit(e, tNow, replayIndex) {
    const a = this.agentFor(e, replayIndex); a.events++; this.commits++;
    if (!this.milestones.firstCommit) this.milestones.firstCommit = this.time;
    const verified = a.crystals.map((id) => this.bodies.get(id)).filter((c) => c && c.verified.filter((v) => v === 1).length > c.verified.length / 2);
    const apexes = verified.map((c) => ({ c, i: c.structure.meta.apexIndex ?? c.structure.vertices.length - 1 }));
    if (apexes.length >= 3 && this.order.filter((id) => id.startsWith("membrane:")).length < this.U.membrane.max) {
      const pts = apexes.map(({ c, i }) => G.add(this.worldVertices(c).points[i], [0, this.U.membrane.lift, 0]));
      const m = this.createBody({ id: "membrane:" + e.id, kind: "membrane", identity: a.identity, structure: G.membrane(pts), event: e, replayIndex, agentKey: a.key, extra: { seals: apexes.map((x) => x.c.id) } });
      if (m) {
        m.verified = m.verified.map(() => 1); m.heat = m.heat.map(() => 0.4);
        // the membrane's vertices were ordered around the centroid; link each to the apex it sits on
        m.structure.vertices.forEach((v, k) => { let best = null, bd = Infinity; for (const ax of apexes) { const d = G.distance(G.add(this.worldVertices(ax.c).points[ax.i], [0, this.U.membrane.lift, 0]), v); if (d < bd) { bd = d; best = ax; } } if (best) this.link({ bodyId: m.id, i: k }, { bodyId: best.c.id, i: best.i }, { kind: "seal", identity: a.identity, event: e, replayIndex }); });
      }
    }
    for (const c of verified) { c.edgeWeight = c.edgeWeight.map((w) => Math.min(1, w + 0.2)); c.fixing = 1; this.record(c, e, replayIndex); }
    this.wave(this.homeBody(a), this.homeVertex(a), tNow, "commit", e);
    this.wave(this.origin, 0, tNow, "commit", e);
    this.growOrigin(e, replayIndex, this.mapping.verification?.coreGrowthPerCommit ?? 1);
    this.tension = Math.max(0, this.tension - 0.5);
  }

  resolve(e, tNow, replayIndex) {
    this.ensureUniverse(e, replayIndex);
    this.resolved = true; this.resolvedAt = tNow; this.waiting = false; this.milestones.resolved = tNow;
    this.wave(this.origin, 0, tNow, "taskEnd", e);
    for (const b of this.bodies.values()) { b.fixing = 1; b.tension = 0; }
    this.origin.verified = this.origin.verified.map(() => 1); this.origin.glow = this.origin.glow.map(() => 1);
  }

  // ---------- geometric operations ----------
  touch(b, i, e, replayIndex, { verifiedReset = true } = {}) {
    if (!b || i == null || i < 0 || i >= b.structure.vertices.length) return;
    b.heat[i] = 1; b.glow[i] = Math.max(b.glow[i], 0.8); if (verifiedReset && b.kind !== "plane" && b.kind !== "field") b.verified[i] = 0;
    const r = this.ref(e, replayIndex);
    b.refs.vertices[i] = { ...b.refs.vertices[i], lastEventId: r.eventId, lastKind: r.kind, lastTs: r.ts, path: r.path ?? b.refs.vertices[i].path, tool: r.tool ?? b.refs.vertices[i].tool };
  }
  distort(b, amount, e, replayIndex) {
    const k = Math.max(2, Math.floor(b.structure.vertices.length * 0.2));
    for (let j = 0; j < k; j++) { const i = Math.floor(this.rng() * b.offsets.length); b.offsets[i] = G.add(b.offsets[i], [this.rng.range(-amount, amount) * 0.2, this.rng.range(-amount, amount) * 0.2, this.rng.range(-amount, amount) * 0.2]); this.touch(b, i, e, replayIndex); }
  }
  distortRegion(b, amount, e, replayIndex) {
    const origin = Math.floor(this.rng() * b.structure.vertices.length), hops = G.hopDistances(b.structure, origin);
    const dir = G.normalize([this.rng.range(-1, 1), this.rng.range(-0.3, 0.3), this.rng.range(-1, 1)]);
    hops.forEach((h, i) => { if (h >= 0 && h <= 2) { b.offsets[i] = G.add(b.offsets[i], G.scale(dir, amount * 0.2 / (1 + h))); this.touch(b, i, e, replayIndex, { verifiedReset: false }); b.verified[i] = -1; } });
  }
  // Wave through the world graph from a body vertex; ring ripple in the plane at that body's site.
  wave(b, i, tNow, kindKey, e, { hue, strength } = {}) {
    if (!b) return null;
    if (this.resolved && kindKey !== "taskEnd") return null;
    const cfg = this.mapping.ripples[kindKey] || this.mapping.ripples.toolResult;
    const world = this.rebuildWorld(), g = this.gi(b.id, i); if (g == null) return null;
    const h = hue ?? cfg.hue ?? b.preset.hue;
    const w = this.ripples.addGraphWave(world, g, { born: tNow, hue: h, strength: (strength ?? 1) * cfg.strength, life: cfg.life, sign: cfg.sign ?? 1, speed: 3.2, meta: { eventId: e?.id, kind: e?.kind, bodyId: b.id, kindKey } });
    w.originBody = b.id; w.originIndex = i; w.bodyId = b.id;
    if (cfg.ring) { const c = this.anchorPosition(b); this.ripples.addRing([c[0], c[2]], { born: tNow, hue: h, life: cfg.life, r0: 0.15, r1: kindKey === "taskEnd" ? 9 : 2.2 + 1.5 * this.rng(), alpha: 0.4, meta: { eventId: e?.id, kind: e?.kind, bodyId: b.id, kindKey } }).bodyId = b.id; }
    return w;
  }

  // ---------- time ----------
  tick(dtMs, tNow = this.time + dtMs) {
    const dt = Math.min(0.1, Math.max(0, dtMs / 1000)); this.time = tNow;
    const D = this.mapping.dynamics, halfLife = this.mapping.verification?.heatHalfLifeSec ?? 75, cool = Math.pow(0.5, dt / halfLife);
    const resolving = this.resolved ? Math.min(1, (tNow - this.resolvedAt) / (D.resolveSeconds * 1000)) : 0;
    const slow = this.resolved ? 1 - 0.7 * resolving : 1;
    for (const id of this.order) {
      const b = this.bodies.get(id);
      for (const [plane, rate] of Object.entries(b.spin)) if (b.structure.dim === 4 || !plane.includes("w")) b.angles[plane] = (b.angles[plane] || 0) + rate * (1 + b.spinBoost) * slow * dt;
      b.spinBoost *= Math.exp(-D.spinDecay * dt * 3);
      const relax = Math.min(0.95, D.relaxRate * (1 + 2 * b.fixing + 3 * resolving) * dt);
      for (let i = 0; i < b.offsets.length; i++) {
        const o = b.offsets[i]; if (o[0] || o[1] || o[2]) { const s = G.scale(o, 1 - relax); b.offsets[i] = Math.abs(s[0]) + Math.abs(s[1]) + Math.abs(s[2]) < 1e-4 ? [0, 0, 0] : s; }
        if (b.glow[i] > 0) b.glow[i] = Math.max(0, b.glow[i] - dt * 0.6);
        if (b.heat[i] > 0.001) b.heat[i] *= cool; else b.heat[i] = 0;
      }
      b.fixing = Math.max(0, b.fixing - dt * 0.5);
      b.tension = Math.max(0, b.tension - D.tensionDecay * dt);
      b.scale += (b.targetScale - b.scale) * Math.min(1, dt * 1.2);
      for (let i = 0; i < b.edgeWeight.length; i++) if (b.edgeWeight[i] < 0) b.edgeWeight[i] = Math.min(0, b.edgeWeight[i] + dt * 0.05 * (1 + 4 * b.fixing));
    }
    this.tension = Math.max(0, this.tension - D.tensionDecay * dt);
    this.ripples.prune(tNow);
    return resolving;
  }

  // World-space 3D vertices (4D rotation → projection → 3D rotation → offsets → scale → placement).
  worldVertices(b) {
    const s = b.structure;
    let pts, w = null;
    if (s.dim === 4) { const p = G.projectAll4to3(G.applyAll(G.rotations(4, b.angles), s.vertices), { distance: b.projectionDistance || 3 }); pts = p.map((q) => [q[0], q[1], q[2]]); w = p.map((q) => q[3]); }
    else { const ang = Object.fromEntries(Object.entries(b.angles).filter(([k]) => !k.includes("w"))); pts = Object.keys(ang).length ? G.applyAll(G.rotations(3, ang), s.vertices) : s.vertices; }
    const centre = this.anchorPosition(b);
    return { points: pts.map((v, i) => G.add(centre, G.scale(G.add(v, b.offsets[i]), b.scale))), w, centre };
  }
  anchorPosition(b) { return b.position; }

  // ---------- state for the camera director, the music and the UI ----------
  verifiedFraction() {
    let v = 0, t = 0;
    for (const b of this.bodies.values()) if (b.kind === "crystal" || b.kind === "root" || b.kind === "seed") { t += b.verified.length; for (const x of b.verified) if (x === 1) v++; }
    return t ? v / t : 0;
  }
  extent() {
    let r = 0, yMin = 0, yMax = 0;
    for (const b of this.bodies.values()) for (const p of this.worldVertices(b).points) { const d = Math.hypot(p[0], p[2]); if (d > r) r = d; if (p[1] < yMin) yMin = p[1]; if (p[1] > yMax) yMax = p[1]; }
    return { radius: r, yMin, yMax };
  }
  counts() {
    let above = 0, below = 0, vertices = 0, edges = 0, faces = 0;
    for (const b of this.bodies.values()) { vertices += b.structure.vertices.length; edges += b.structure.edges.length; faces += b.structure.faces.length; if (b.kind === "plane" || b.kind === "field") continue; for (const p of this.worldVertices(b).points) { if (p[1] > 0.05) above++; else if (p[1] < -0.05) below++; } }
    return { bodies: this.bodies.size, links: this.links.length, vertices, edges, faces, above, below, waves: this.ripples.waves.length, rings: this.ripples.rings.length };
  }
  complexity() { return this.counts(); }
  state() {
    const agents = [...this.agents.values()].map((a) => ({ id: a.key, agentId: a.agentId, identity: a.identity, agentType: a.agentType, parentId: a.parentKey, active: !a.docked, docked: a.docked, events: a.events, crystals: a.crystals.length, model: a.model }));
    const phase = this.resolved ? "resolved" : this.waiting ? "waiting" : this.tension > 0.5 ? "tension" : this.task ? "working" : "idle";
    const c = this.counts();
    return { verifiedFraction: this.verifiedFraction(), tension: this.tension, resolved: this.resolved, waiting: this.waiting, agents, phase, task: this.task, current: this.current, time: this.time, milestones: { ...this.milestones }, planeRings: this.plane?.rings ?? 0, crystals: this.crystals.size, links: this.links.length, above: c.above, below: c.below, bodies: c.bodies, counts: c, tests: { ...this.tests }, commits: this.commits, progress: this.totalEvents ? this.eventCount / this.totalEvents : null };
  }

  // ---------- inspection ----------
  describe(bodyId, vertexIndex) {
    const b = this.bodies.get(bodyId); if (!b) return null;
    const ref = b.refs.vertices[vertexIndex] || null;
    const edges = b.structure.edges.map((e, i) => (e[0] === vertexIndex || e[1] === vertexIndex ? i : -1)).filter((i) => i >= 0);
    const links = this.links.filter((l) => (l.a.bodyId === bodyId && l.a.i === vertexIndex) || (l.b.bodyId === bodyId && l.b.i === vertexIndex)).map((l) => ({ id: l.id, kind: l.kind, to: l.a.bodyId === bodyId ? l.b.bodyId : l.a.bodyId, ref: l.ref }));
    const ev = ref?.lastEventId ? this.events.get(ref.lastEventId) : ref?.eventId ? this.events.get(ref.eventId) : null;
    const agent = b.agentKey ? this.agents.get(b.agentKey) : null;
    return { body: { id: b.id, kind: b.kind, identity: b.identity, label: b.preset.label, path: b.path || null, mirrorOf: b.mirrorOf || null, agentKey: b.agentKey, agentType: agent?.agentType || (b.agentKey === "main" ? "main" : null), model: agent?.model || null, stage: b.structure.meta?.stages ?? b.stage, growth: Number(b.growth.toFixed(2)), events: b.events, docked: b.docked, vertices: b.structure.vertices.length, edges: b.structure.edges.length, verified: b.verified.filter((x) => x === 1).length, failed: b.verified.filter((x) => x === -1).length, site: b.site }, vertex: { index: vertexIndex, ref, glow: b.glow[vertexIndex], heat: b.heat[vertexIndex], verified: b.verified[vertexIndex], offset: b.offsets[vertexIndex], world: this.worldVertices(b).points[vertexIndex] }, edges: edges.slice(0, 8).map((i) => ({ edge: b.structure.edges[i], weight: b.edgeWeight[i], ref: b.refs.edges[i] })), links, event: ev, history: b.history.slice(-12), task: this.task, fingerprint: this.fingerprint, replayIndex: ref?.replayIndex ?? null };
  }
  snapshot() {
    const r = (x) => Math.round(x * 1e6) / 1e6;
    return { engine: "universe", fingerprint: this.fingerprint, resolved: this.resolved, task: this.task, bodies: this.order.map((id) => { const b = this.bodies.get(id); return { id, kind: b.kind, identity: b.identity, site: b.site, agentKey: b.agentKey, path: b.path || null, vertices: b.structure.vertices.map((v) => v.map(r)), edges: b.structure.edges, angles: Object.fromEntries(Object.entries(b.angles).map(([k, v]) => [k, r(v)])), offsets: b.offsets.map((o) => o.map(r)), heat: b.heat.map(r), verified: b.verified, edgeWeight: b.edgeWeight.map(r), position: b.position.map(r), scale: r(b.scale), refs: b.refs.vertices.map((x) => x?.eventId ?? null) }; }), links: this.links.map((l) => ({ a: l.a, b: l.b, kind: l.kind, ref: l.ref.eventId })) };
  }
  snapshotHash() { return snapshotHash(this.snapshot()); }
}

function summarizePayload(p) {
  if (!p) return null;
  const keep = ["tool", "paths", "path", "signature", "kind", "framework", "passed", "failed", "skipped", "ok", "label", "agentType", "hash", "files", "insertions", "deletions", "name", "promptLen", "calls", "stage"];
  const out = {}; for (const k of keep) if (p[k] !== undefined) out[k] = p[k];
  return out;
}
