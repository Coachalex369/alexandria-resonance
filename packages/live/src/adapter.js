// Alexandria Resonance — live adapter. Browser-safe, pure, deterministic.
//
// Turns normalized Claude Code events (alexandria.event/1, from the shared collector log via the protocol parser)
// into the event records the Universe engine already understands. It adds no new visual vocabulary and never
// touches the engine; it only supplies what the content-free collector log cannot:
//
//   objective   each session is one objective. The first event of a session opens it (task.start); session.end
//               closes it (task.end → finale, an observed ending). Activity after an ending reopens the same
//               objective (task.start again) on the existing artwork — nothing is lost. Inactivity is NOT an
//               ending: dormancy is decided by the page, never here.
//   phases      each prompt starts a new phase; every event carries payload.stage = "Phase n" ("Opening" before
//               the first prompt) so the story and history group by phase.
//   stretches   the log never records file paths, so a crystal is an IMPLEMENTATION STRETCH: one actor's run of
//               edits until a verification point (test run, commit), the end of its turn (main) or of its run
//               (subagent), a new prompt, or a gap longer than `stretchGapMs`. Reads in between do not split a
//               stretch. The stretch name is given to the engine as payload.path ("stretch 3").
//   commits     a successful Bash/PowerShell call whose redacted signature is exactly "git commit" yields an
//               INFERRED git.commit event (provenance.observed = false) so commits seal membranes. push, merge,
//               tag and checkout -b do not.
//   labels      short readable labels from tool names and the collector's redacted signatures only.
//
// Every synthetic record says so: provenance { observed: false, adapter: "resonance-live@1" }.

export const ADAPTER = "resonance-live@1";
export const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const COMMIT_SIGNATURE = /^git commit$/i;
// Collector v4 (protocol 3.1) emits an observed git.commit itself; only older collectors need the commit inferred.
const LEGACY_COLLECTOR = /^claude-hooks@[123]$/;
const infersCommit = (e) => { const a = e.provenance && e.provenance.adapter; return !a || LEGACY_COLLECTOR.test(a); };

// The engine configuration that makes each session's universe distinct and reproducible. Live mode and the replay
// of a real session must use the same value so the same events build the same artwork.
export function universeConfig(sessionId) { return { page: "universe", source: "live", session: String(sessionId || "unknown") }; }

export class LiveAdapter {
  constructor({ stretchGapMs = 5 * 60 * 1000 } = {}) {
    this.stretchGapMs = stretchGapMs;
    this.sessions = new Map();
  }

  state(sessionId) {
    let s = this.sessions.get(sessionId);
    if (!s) { s = { opened: false, ended: false, openings: 0, phase: 0, stretchCount: new Map(), open: new Map() }; this.sessions.set(sessionId, s); }
    return s;
  }

  // One normalized event in, the events to ingest out (in order). Never mutates the input.
  process(e) {
    if (!e || !e.kind || !e.session) return [];
    const sid = e.session.id, s = this.state(sid), out = [];
    const actorKey = actorKeyOf(e.actor);

    // phases advance before the prompt is labelled
    if (e.kind === "prompt.submit") { s.phase++; this.closeStretch(s, "main"); }
    const stage = s.phase ? `Phase ${s.phase}` : "Opening";

    // open (or reopen) the objective on the session's first meaningful event
    const opens = (!s.opened || s.ended) && e.kind !== "session.end";
    if (opens && e.kind !== "session.start") out.push(this.objective(e, s, stage, "task.start"));

    const payload = { ...(e.payload || {}) };
    payload.stage = payload.stage || stage;
    let commit = null;

    if ((e.kind === "tool.result" || e.kind === "tool.failure") && EDIT_TOOLS.has(payload.tool)) {
      const st = this.stretchFor(s, actorKey, Date.parse(e.ts), e.actor);
      payload.path = st.name;
      payload.label = payload.label || `${payload.tool} · ${st.name}${e.kind === "tool.failure" ? " (failed)" : ""}`;
    } else if (e.kind === "tool.result" && COMMIT_SIGNATURE.test(payload.signature || "") && infersCommit(e)) {
      this.closeStretch(s, actorKey);
      commit = true;
    }
    if (e.kind === "git.commit") { this.closeStretch(s, actorKey); payload.label = payload.label || "Commit"; } // an observed commit (collector v4) closes the stretch like the inferred one
    if (e.kind === "test.run") payload.label = labelFor(e, payload, s); // the parser's label is the bare signature: add the counts
    payload.label = payload.label || labelFor(e, payload, s);
    out.push({ ...e, payload });
    if (opens && e.kind === "session.start") out.push(this.objective(e, s, stage, "task.start"));

    if (commit) out.push({
      schema: e.schema, id: `${e.id}:commit`, ts: e.ts, source: "git", kind: "git.commit", session: e.session, actor: e.actor,
      parent: { ...(e.parent || {}), inferredFrom: e.id }, payload: { label: "Commit", stage },
      classification: [{ scheme: "operation", value: "commit", basis: "inferred", confidence: 0.9, by: "rule:git-commit-signature" }],
      provenance: { observed: false, adapter: ADAPTER, confidence: 0.9 },
    });

    // verification points and endings close stretches
    if (e.kind === "test.run") this.closeStretch(s, actorKey);
    if (e.kind === "turn.stop" && actorKey === "main") this.closeStretch(s, "main");
    if (e.kind === "agent.stop") this.closeStretch(s, actorKey);
    if (e.kind === "session.end" && s.opened && !s.ended) { out.push(this.objective(e, s, stage, "task.end")); s.ended = true; s.open.clear(); }
    return out;
  }

  processAll(events) { const out = []; for (const e of events) out.push(...this.process(e)); return out; }

  objective(e, s, stage, kind) {
    if (kind === "task.start") { s.openings++; s.opened = true; s.ended = false; }
    const label = kind === "task.end" ? "Session closed" : s.openings > 1 ? "Session resumed" : "Session opened";
    return {
      schema: e.schema, id: `${e.id}:${kind === "task.end" ? "close" : "open"}`, ts: e.ts, source: "marks", kind,
      session: e.session, actor: { type: "system" }, task: { id: `session:${e.session.id}`, title: null },
      payload: { label, stage, objective: "session" },
      provenance: { observed: false, adapter: ADAPTER, confidence: 1 },
    };
  }

  stretchFor(s, actorKey, tsMs, actor) {
    const cur = s.open.get(actorKey);
    if (cur && Number.isFinite(tsMs) && tsMs - cur.lastTs <= this.stretchGapMs) { cur.lastTs = tsMs; return cur; }
    const n = (s.stretchCount.get(actorKey) || 0) + 1;
    s.stretchCount.set(actorKey, n);
    const who = actorKey === "main" ? "" : `${actor?.agentType || "agent"} ${String(actor?.agentId || "").slice(0, 6)} · `;
    const st = { name: `${who}stretch ${n}`, lastTs: Number.isFinite(tsMs) ? tsMs : 0 };
    s.open.set(actorKey, st);
    return st;
  }
  closeStretch(s, actorKey) { s.open.delete(actorKey); }
}

function actorKeyOf(actor) { return actor?.type === "subagent" && actor.agentId ? "agent:" + actor.agentId : "main"; }

function labelFor(e, p, s) {
  switch (e.kind) {
    case "session.start": return p.sourceOfStart === "resume" ? "Session resumed" : "Session started";
    case "session.end": return "Session ended";
    case "prompt.submit": return `Prompt ${s.phase}`;
    case "turn.stop": return "Turn complete";
    case "tool.result": case "tool.failure": return `${p.tool || "tool"}${p.signature ? " · " + p.signature : ""}${e.kind === "tool.failure" ? (p.interrupted ? " (interrupted)" : " (failed)") : ""}`;
    case "test.run": return `${p.label || p.framework || "tests"} · ${p.passed ?? "?"} passed${p.failed ? `, ${p.failed} failed` : ""}`;
    case "agent.start": return `${e.actor?.agentType || p.agentType || "agent"} arrives`;
    case "agent.stop": return `${e.actor?.agentType || "agent"} returns`;
    case "notification": return p.kind === "permission_prompt" ? "Waiting for permission" : p.kind === "idle_prompt" ? "Waiting for the owner" : `Notice · ${p.kind || "notification"}`;
    case "permission.request": return `Permission requested · ${p.tool || ""}`.trim();
    case "permission.denied": return `Permission denied · ${p.tool || ""}`.trim();
    case "api.error": return `API ${p.error || "error"}${p.status ? " " + p.status : ""}`;
    case "context.compact": return `Context compaction ${p.phase || ""}`.trim();
    case "model.switch": return `Model ${p.fromModel || "?"} → ${p.toModel || "?"}`;
    default: return e.kind;
  }
}
