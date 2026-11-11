// Live feed for Alexandria Resonance: tails the collector's hook log (read-only) and serves normalized events.
// Node only. Never writes, renames or locks the log or anything under ~/.claude: each poll opens a read-only fd and closes it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseHookLog } from "../packages/event-engine/src/adapters/claudeHooks.js";

export const defaultHookLog = () => process.env.VZ_HOOK_LOG || path.join(os.homedir(), ".claude", "eta", "events.jsonl");
const NL = 0x0a;
const ACTIVE_MS = 20 * 60 * 1000;
const tsMs = (ts) => { const n = Date.parse(ts); return Number.isFinite(n) ? n : 0; };
// A session is named after the folder where most of its activity happened (it starts in the home folder and cd's
// elsewhere); ties keep the earlier folder. Same rule as packages/live/src/worlds.js.
function mainProject(list) {
  const tally = new Map(); let best = null;
  for (const e of list) { const p = e.session.project; if (!p) continue; tally.set(p, (tally.get(p) || 0) + 1); if (!best || tally.get(p) > tally.get(best)) best = p; }
  return best;
}
function byTs(a, b) { return tsMs(a.ts) - tsMs(b.ts) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); }

// Polling tail (fs.watch is unreliable on Windows for appended logs). Calls onChunk(completeLinesText, firstLineNumber).
// If the file is larger than maxInitialBytes at start, begins at the first line boundary inside the last maxInitialBytes;
// line numbers then count from that point (so ids for that case differ from a whole-file parse; acceptable).
export class FileTail {
  constructor(file, onChunk, { intervalMs = 1000, maxInitialBytes = 8 * 1024 * 1024 } = {}) {
    Object.assign(this, { file, onChunk, intervalMs, maxInitialBytes });
    this.offset = 0; this.line = 0; this.rest = Buffer.alloc(0); this.timer = null; this.started = false;
  }
  reset() { this.offset = 0; this.line = 0; this.rest = Buffer.alloc(0); this.started = false; }
  poll() {
    let st; try { st = fs.statSync(this.file); } catch { if (this.offset || this.started) this.reset(); return; } // missing: keep polling silently
    if (!st.isFile()) return;
    if (st.size < this.offset) this.reset();                           // truncated or rotated: restart from 0
    let from = this.offset, skipPartial = false;
    if (!this.started) {
      this.started = true;
      if (st.size > this.maxInitialBytes) { from = st.size - this.maxInitialBytes; skipPartial = true; }
      this.offset = from;
    }
    if (st.size === from) return;
    let fd;
    try { fd = fs.openSync(this.file, "r"); } catch { return; }
    let buf;
    try {
      buf = Buffer.alloc(st.size - from);
      const n = fs.readSync(fd, buf, 0, buf.length, from); buf = buf.subarray(0, n);
    } catch { return; } finally { fs.closeSync(fd); }
    this.offset = from + buf.length;
    let data = this.rest.length ? Buffer.concat([this.rest, buf]) : buf;
    if (skipPartial) { const i = data.indexOf(NL); data = i < 0 ? Buffer.alloc(0) : data.subarray(i + 1); } // drop the cut-off first line
    const nl = data.lastIndexOf(NL);
    if (nl < 0) { this.rest = Buffer.from(data); return; }
    this.rest = Buffer.from(data.subarray(nl + 1));                    // partial trailing line carries over
    const complete = data.subarray(0, nl + 1).toString("utf8");
    const first = this.line;
    this.line += complete.split("\n").length - 1;
    this.onChunk(complete, first);
  }
  start() {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => { try { this.poll(); } catch { /* a bad poll must not kill the server */ } }, this.intervalMs);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}

export class LiveFeed {
  constructor({ file = defaultHookLog(), intervalMs = 1000, backlogHours = 12, maxEvents = 50000, now = () => Date.now(), maxInitialBytes } = {}) {
    this.file = file; this.backlogHours = backlogHours; this.maxEvents = maxEvents; this.now = now;
    this.bySession = new Map(); // sid -> events[] in ts order
    this.ids = new Set(); this.total = 0; this.subs = new Set();
    this.tail = new FileTail(file, (text, line) => this.#ingest(text, line), { intervalMs, ...(maxInitialBytes ? { maxInitialBytes } : {}) });
  }
  get basename() { return path.basename(this.file); }
  start() { this.tail.start(); }
  stop() { this.tail.stop(); }
  #ingest(text, lineOffset) {
    const parsed = parseHookLog(text, { file: this.basename, lineOffset }).filter((e) => !this.ids.has(e.id));
    if (!parsed.length) return;
    for (const e of parsed) {
      this.ids.add(e.id);
      let list = this.bySession.get(e.session.id); if (!list) this.bySession.set(e.session.id, list = []);
      list.push(e); this.total++;
      const n = list.length; if (n > 1 && tsMs(list[n - 2].ts) > tsMs(e.ts)) list.sort(byTs);
    }
    if (this.total > this.maxEvents * 1.1) this.#trim();
    for (const fn of [...this.subs]) { try { fn(parsed); } catch { /* subscriber errors are theirs */ } }
  }
  #trim() { // drop the oldest events overall until maxEvents remain
    const all = [...this.bySession.values()].flat().sort(byTs).slice(-this.maxEvents);
    this.bySession.clear(); this.ids.clear();
    for (const e of all) { let l = this.bySession.get(e.session.id); if (!l) this.bySession.set(e.session.id, l = []); l.push(e); this.ids.add(e.id); }
    this.total = all.length;
  }
  sessions() {
    const now = this.now();
    return [...this.bySession.entries()].map(([id, list]) => {
      const first = list[0], last = list[list.length - 1];
      return { id, project: mainProject(list), first: first.ts, last: last.ts, count: list.length, active: now - tsMs(last.ts) <= ACTIVE_MS };
    }).sort((a, b) => tsMs(b.last) - tsMs(a.last) || (a.id < b.id ? -1 : 1));
  }
  sessionEvents(id) { const l = this.bySession.get(id); return l ? [...l].sort(byTs) : null; }
  backlog() {
    const cutoff = this.now() - this.backlogHours * 3600 * 1000, out = [];
    for (const list of this.bySession.values()) if (tsMs(list[list.length - 1].ts) >= cutoff) out.push(...list);
    return out.sort(byTs);
  }
  subscribe(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
}

// HTTP wiring used by createStaticServer. Returns { handle(req,res) -> handled?, close() }.
export function createLiveRoutes({ live, getPort, pingMs = 15000 }) {
  let feed = live === false ? null : live || null;
  const open = new Set();
  const getFeed = () => { if (live === false) return null; if (!feed) feed = new LiveFeed(); feed.start(); return feed; }; // lazy: nothing is read until the first /live request
  const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
  function handle(req, res) {
    const [pathname, query = ""] = req.url.split("?");
    if (pathname !== "/live" && !pathname.startsWith("/live/")) return false;
    const host = req.headers.host, port = getPort();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) { res.writeHead(403, { "content-type": "text/plain" }); res.end("forbidden host"); return true; } // DNS-rebinding guard
    const f = getFeed();
    if (!f) { json(res, 404, { error: "live feed disabled" }); return true; }
    if (pathname === "/live/sessions") { json(res, 200, f.sessions()); return true; }
    if (pathname === "/live/session") {
      const id = new URLSearchParams(query).get("id"); const ev = id == null ? null : f.sessionEvents(id);
      if (!ev) json(res, 404, { error: "unknown session" }); else json(res, 200, ev);
      return true;
    }
    if (pathname === "/live/stream") {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send("hello", { file: f.basename, serverTime: new Date().toISOString() });
      send("backlog", f.backlog());
      const unsub = f.subscribe((batch) => send("events", batch)); // same tick as backlog(): no gap
      const ping = setInterval(() => res.write(": ping\n\n"), pingMs); ping.unref?.();
      const entry = { res }; open.add(entry);
      const cleanup = () => { clearInterval(ping); unsub(); open.delete(entry); };
      req.on("close", cleanup); res.on("close", cleanup);
      return true;
    }
    json(res, 404, { error: "not found" }); return true;
  }
  function close() { for (const { res } of [...open]) { try { res.end(); } catch { /* ignore */ } } open.clear(); feed?.stop(); }
  return { handle, close };
}
