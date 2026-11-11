// Which Claude Code session the live view should focus on. Pure and deterministic: no Node imports, no Date.now();
// every time is a ms value passed in by the caller. Safe to load in the browser.
//
// Activity score: exponentially decaying sum of observed weights, half-life 3 minutes.
// Dormant (no activity for dormantAfterMs) is NOT an ending; new activity wakes the session. Ended is explicit bookkeeping.
// Focus rules (see focus()):
//   - a pinned session wins while it exists;
//   - initially the highest score;
//   - afterwards the current focus is kept unless
//       (a) it is dormant or ended and another session is active (not dormant, not ended), or
//       (b) another active session's score has been >= switchRatio x the current one's, continuously for >= challengeMs,
//           AND the current focus has been held for >= minHoldMs.
//   - ties are broken by session id (ascending).
// "Continuously" in (b) is sampled at focus() calls: call focus() regularly (e.g. every frame or second) while the view runs.

export const HALF_LIFE_MS = 3 * 60 * 1000;
export const DORMANT_AFTER_MS = 20 * 60 * 1000;
export const SWITCH_RATIO = 2;
export const CHALLENGE_MS = 90 * 1000;
export const MIN_HOLD_MS = 3 * 60 * 1000;

export class SessionFocus {
  constructor({ halfLifeMs = HALF_LIFE_MS, dormantAfterMs = DORMANT_AFTER_MS, switchRatio = SWITCH_RATIO, challengeMs = CHALLENGE_MS, minHoldMs = MIN_HOLD_MS } = {}) {
    Object.assign(this, { halfLifeMs, dormantAfterMs, switchRatio, challengeMs, minHoldMs });
    this.sessions = new Map(); // id -> { score, scoreTs, lastTs, ended }
    this.pinned = null;
    this.current = null; this.heldSince = 0;
    this.challenger = null; this.challengerSince = 0;
  }
  #decay(s, nowMs) { return nowMs > s.scoreTs ? s.score * Math.pow(0.5, (nowMs - s.scoreTs) / this.halfLifeMs) : s.score; }
  observe(sessionId, tsMs, weight = 1) {
    let s = this.sessions.get(sessionId);
    if (!s) this.sessions.set(sessionId, s = { score: 0, scoreTs: tsMs, lastTs: tsMs, ended: false });
    if (tsMs >= s.scoreTs) { s.score = this.#decay(s, tsMs) + weight; s.scoreTs = tsMs; }
    else s.score += weight * Math.pow(0.5, (s.scoreTs - tsMs) / this.halfLifeMs); // late (out-of-order) event: decay the new weight instead
    if (tsMs > s.lastTs) s.lastTs = tsMs;
  }
  has(sessionId) { return this.sessions.has(sessionId); }
  score(sessionId, nowMs) { const s = this.sessions.get(sessionId); return s ? this.#decay(s, nowMs) : 0; }
  dormant(sessionId, nowMs) { const s = this.sessions.get(sessionId); return !s || nowMs - s.lastTs >= this.dormantAfterMs; }
  ended(sessionId) { return !!this.sessions.get(sessionId)?.ended; }
  markEnded(sessionId) { const s = this.sessions.get(sessionId); if (s) s.ended = true; }
  markResumed(sessionId) { const s = this.sessions.get(sessionId); if (s) s.ended = false; }
  pin(sessionId) { this.pinned = sessionId; }
  unpin() { this.pinned = null; }
  #active(id, nowMs) { return !this.dormant(id, nowMs) && !this.ended(id); }

  list(nowMs) {
    const focused = this.focus(nowMs);
    return [...this.sessions.entries()].map(([id, s]) => ({
      id, score: this.#decay(s, nowMs), dormant: this.dormant(id, nowMs), ended: s.ended, focused: id === focused, pinned: id === this.pinned, lastTs: s.lastTs,
    })).sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  focus(nowMs) {
    const rows = [...this.sessions.keys()].map((id) => ({ id, score: this.score(id, nowMs) }))
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const take = (id) => { if (id !== this.current) { this.current = id; this.heldSince = nowMs; } this.challenger = null; return this.current; };
    if (!rows.length) { this.current = null; this.challenger = null; return null; }
    if (this.pinned && this.sessions.has(this.pinned)) return take(this.pinned);
    const best = (pred) => rows.find((r) => pred(r.id));
    const active = (r) => this.#active(r, nowMs);
    if (this.current == null || !this.sessions.has(this.current)) {
      // initial pick: highest score, preferring active sessions, then not-ended ones, then anything
      return take((best(active) || best((id) => !this.ended(id)) || rows[0]).id);
    }
    const cur = rows.find((r) => r.id === this.current);
    if (!active(cur.id)) { // (a) current is dormant or ended: move to the best active session, if any
      const alt = best((id) => id !== cur.id && active(id));
      if (alt) return take(alt.id);
      this.challenger = null; return this.current;
    }
    // (b) sustained dominance by another active session
    const rival = best((id) => id !== cur.id && active(id));
    if (rival && rival.score > 0 && rival.score >= this.switchRatio * cur.score) {
      if (this.challenger !== rival.id) { this.challenger = rival.id; this.challengerSince = nowMs; }
      if (nowMs - this.challengerSince >= this.challengeMs && nowMs - this.heldSince >= this.minHoldMs) return take(rival.id);
    } else this.challenger = null;
    return this.current;
  }
}
