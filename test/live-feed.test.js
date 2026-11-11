// Live feed: polling tail, session index, backlog window, and the /live/* HTTP routes (SSE included).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { LiveFeed, FileTail } from "../tools/live-feed.js";
import { createStaticServer } from "../tools/serve-demo.js";
import { parseHookLog } from "../packages/event-engine/src/adapters/claudeHooks.js";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "hook-lines.jsonl");
const LINES = fs.readFileSync(FIX, "utf8").split("\n").filter(Boolean);
const NOW = Date.parse("2026-11-11T02:30:00Z"); // 9 min after the v3 fixture session
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "viz-live-"));
async function until(cond, ms = 4000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await cond(); if (v) return v; await new Promise((r) => setTimeout(r, 10)); } throw new Error("timed out waiting for condition"); }
const feedFor = (file, extra = {}) => new LiveFeed({ file, intervalMs: 20, now: () => NOW, ...extra });
const sidLine = (sid, ts, extra = {}) => JSON.stringify({ ts, ev: "PostToolUse", sid, proj: "p", tool: "Edit", tuid: `t-${ts}`, hookMs: 1, ...extra }) + "\n";

test("incremental appends, a partial line split across polls, and ids equal to a whole-file parse", async () => {
  const dir = tmp(), file = path.join(dir, "events.jsonl");
  const tail = []; const t = new FileTail(file, (text, line) => tail.push([text, line]), { intervalMs: 20 });
  t.poll(); assert.equal(tail.length, 0, "missing file is silent");
  fs.writeFileSync(file, LINES[0] + "\n" + LINES[1] + "\n" + LINES[2].slice(0, 30));
  t.poll(); assert.equal(tail.length, 1); assert.equal(tail[0][1], 0); assert.equal(tail[0][0].split("\n").length - 1, 2);
  fs.appendFileSync(file, LINES[2].slice(30) + "\n");
  t.poll(); assert.equal(tail.length, 2); assert.equal(tail[1][1], 2); assert.equal(tail[1][0], LINES[2] + "\n");
  t.poll(); assert.equal(tail.length, 2, "nothing new, nothing emitted");

  // Through LiveFeed: same ids as parseHookLog over the whole file, even with a split line.
  const file2 = path.join(dir, "events2.jsonl"); const feed = feedFor(file2); feed.start();
  try {
    fs.writeFileSync(file2, LINES.slice(0, 4).join("\n") + "\n" + LINES[4].slice(0, 20));
    await until(() => feed.backlog().length || feed.sessions().length);
    fs.appendFileSync(file2, LINES[4].slice(20) + "\n" + LINES.slice(5).join("\n") + "\n");
    const whole = parseHookLog(fs.readFileSync(file2, "utf8"), { file: "events2.jsonl" });
    await until(() => feed.sessions().reduce((n, s) => n + s.count, 0) === whole.length);
    const got = feed.sessions().flatMap((s) => feed.sessionEvents(s.id)).map((e) => e.id).sort();
    assert.deepEqual(got, whole.map((e) => e.id).sort());
  } finally { feed.stop(); }
});

test("truncation restarts from the top; a recreated file is read again", async () => {
  const dir = tmp(), file = path.join(dir, "events.jsonl");
  const seen = []; const t = new FileTail(file, (text, line) => seen.push([text, line]));
  fs.writeFileSync(file, sidLine("s", "2026-11-11T01:00:00.000Z") + sidLine("s", "2026-11-11T01:00:01.000Z"));
  t.poll(); assert.equal(seen.at(-1)[1], 0);
  fs.writeFileSync(file, sidLine("s", "2026-11-11T02:00:00.000Z")); // shorter: truncated
  t.poll(); assert.equal(seen.length, 2); assert.equal(seen[1][1], 0); assert.match(seen[1][0], /02:00:00/);
  fs.unlinkSync(file); t.poll();
  fs.writeFileSync(file, sidLine("s", "2026-11-11T03:00:00.000Z"));
  t.poll(); assert.equal(seen.length, 3); assert.equal(seen[2][1], 0);
});

test("a huge existing log starts at a line boundary within the last maxInitialBytes", () => {
  const dir = tmp(), file = path.join(dir, "events.jsonl");
  const lines = Array.from({ length: 50 }, (_, i) => sidLine("s", new Date(Date.UTC(2026, 10, 11, 1, 0, i)).toISOString()));
  fs.writeFileSync(file, lines.join(""));
  const chunks = []; new FileTail(file, (text, line) => chunks.push([text, line]), { maxInitialBytes: lines[0].length * 10 + 5 }).poll();
  assert.equal(chunks.length, 1);
  const got = chunks[0][0].split("\n").filter(Boolean);
  assert.ok(got.length >= 9 && got.length <= 10, `got ${got.length}`);
  for (const l of got) assert.doesNotThrow(() => JSON.parse(l), "no cut-off first line");
  assert.equal(chunks[0][1], 0, "line numbers count from the starting point");
});

test("multiple sessions are separated; sessions() newest first with active flag; unknown id is null", async () => {
  const dir = tmp(), file = path.join(dir, "events.jsonl"); fs.writeFileSync(file, LINES.join("\n") + "\n");
  const feed = feedFor(file); feed.start();
  try {
    const ss = feed.sessions();
    assert.deepEqual(ss.map((s) => s.id), ["fx-v4", "fx-v3", "fx-v2", "fx-v1"]);
    assert.deepEqual(ss.map((s) => s.active), [true, true, false, false]);
    const v3 = ss[1]; assert.equal(v3.project, "p"); assert.equal(v3.count, 4); assert.equal(v3.first, "2026-11-11T02:21:17.000Z"); assert.equal(v3.last, "2026-11-11T02:21:41.000Z");
    assert.ok(feed.sessionEvents("fx-v1").every((e) => e.session.id === "fx-v1"));
    assert.equal(feed.sessionEvents("nope"), null);
    const ev = feed.sessionEvents("fx-v3"); assert.deepEqual(ev.map((e) => e.ts), [...ev.map((e) => e.ts)].sort());
  } finally { feed.stop(); }
});

test("backlog window: only sessions active within backlogHours, sorted by ts then id", () => {
  const dir = tmp(), file = path.join(dir, "events.jsonl");
  fs.writeFileSync(file, LINES.join("\n") + "\n" + sidLine("recent", "2026-11-11T02:00:00.000Z") + sidLine("recent", "2026-11-11T02:00:00.000Z", { tuid: "other" }));
  const wide = feedFor(file, { backlogHours: 100 }); wide.start(); wide.stop();
  assert.deepEqual([...new Set(wide.backlog().map((e) => e.session.id))].sort(), ["fx-v1", "fx-v2", "fx-v3", "fx-v4", "recent"]);
  const feed = feedFor(file, { backlogHours: 12 }); feed.start(); feed.stop();
  const b = feed.backlog();
  assert.deepEqual([...new Set(b.map((e) => e.session.id))].sort(), ["fx-v3", "fx-v4", "recent"]);
  for (let i = 1; i < b.length; i++) assert.ok(Date.parse(b[i - 1].ts) < Date.parse(b[i].ts) || (b[i - 1].ts === b[i].ts && b[i - 1].id < b[i].id));
});

test("maxEvents drops the oldest events", () => {
  const dir = tmp(), file = path.join(dir, "events.jsonl");
  fs.writeFileSync(file, Array.from({ length: 40 }, (_, i) => sidLine("s", new Date(Date.UTC(2026, 10, 11, 2, 0, i)).toISOString())).join(""));
  const feed = feedFor(file, { maxEvents: 20 }); feed.start(); feed.stop();
  const ev = feed.sessionEvents("s"); assert.ok(ev.length <= 22 && ev.length >= 20, `kept ${ev.length}`);
  assert.equal(ev.at(-1).ts, "2026-11-11T02:00:39.000Z");
});

test("subscribe delivers new batches and unsubscribes", async () => {
  const dir = tmp(), file = path.join(dir, "events.jsonl"); fs.writeFileSync(file, "");
  const feed = feedFor(file); feed.start();
  try {
    const batches = []; const off = feed.subscribe((b) => batches.push(b));
    fs.appendFileSync(file, sidLine("s", "2026-11-11T02:10:00.000Z"));
    await until(() => batches.length === 1); assert.equal(batches[0][0].session.id, "s");
    off(); fs.appendFileSync(file, sidLine("s", "2026-11-11T02:10:01.000Z"));
    await until(() => feed.sessionEvents("s").length === 2); assert.equal(batches.length, 1);
  } finally { feed.stop(); }
});

test("the feed never modifies the log file", async () => {
  const dir = tmp(), file = path.join(dir, "events.jsonl"); fs.writeFileSync(file, LINES.join("\n") + "\n");
  const before = fs.statSync(file); const content = fs.readFileSync(file);
  const feed = feedFor(file); feed.start(); await new Promise((r) => setTimeout(r, 80)); feed.stop();
  const after = fs.statSync(file); assert.equal(after.mtimeMs, before.mtimeMs); assert.equal(after.size, before.size);
  assert.ok(content.equals(fs.readFileSync(file))); assert.deepEqual(fs.readdirSync(dir), ["events.jsonl"]);
  fs.unlinkSync(file); // not locked: deletable while a feed has polled it
});

// ---- HTTP ----
async function withServer(fn, { lines = LINES, pingMs } = {}) {
  const dir = tmp(), file = path.join(dir, "events.jsonl"); fs.writeFileSync(file, lines.join("\n") + "\n");
  const live = feedFor(file); const s = createStaticServer({ port: 0, live, pingMs }); const port = await s.listen();
  try { await fn({ port, file, live, base: `http://127.0.0.1:${port}` }); } finally { await s.close(); }
}
function sse(port, headers = {}) { // minimal SSE client that exposes the accumulated text
  const state = { text: "", status: 0, headers: {} };
  const req = http.get({ host: "127.0.0.1", port, path: "/live/stream", headers }, (res) => { state.status = res.statusCode; state.headers = res.headers; res.setEncoding("utf8"); res.on("data", (d) => { state.text += d; }); });
  req.on("error", () => {});
  state.close = () => req.destroy();
  return state;
}
const frames = (text) => text.split("\n\n").filter((f) => f.startsWith("event:")).map((f) => ({ event: /^event: (.*)$/m.exec(f)[1], data: JSON.parse(/^data: (.*)$/m.exec(f)[1]) }));

test("HTTP: /live/sessions and /live/session", async () => {
  await withServer(async ({ base }) => {
    const r = await fetch(`${base}/live/sessions`); assert.equal(r.status, 200); assert.match(r.headers.get("content-type"), /json/);
    assert.deepEqual((await r.json()).map((s) => s.id), ["fx-v4", "fx-v3", "fx-v2", "fx-v1"]);
    const one = await fetch(`${base}/live/session?id=fx-v1`); assert.equal(one.status, 200);
    const ev = await one.json(); assert.ok(ev.length >= 2 && ev.every((e) => e.session.id === "fx-v1"));
    assert.equal((await fetch(`${base}/live/session?id=ghost`)).status, 404);
    assert.equal((await fetch(`${base}/live/session`)).status, 404);
  });
});

test("HTTP: SSE sends hello, backlog, then an appended event; pings; no CORS header", async () => {
  await withServer(async ({ port, file }) => {
    const c = sse(port);
    try {
      await until(() => frames(c.text).length >= 2);
      assert.equal(c.status, 200); assert.match(c.headers["content-type"], /text\/event-stream/);
      assert.equal(c.headers["access-control-allow-origin"], undefined);
      const [hello, backlog] = frames(c.text);
      assert.equal(hello.event, "hello"); assert.equal(hello.data.file, "events.jsonl"); assert.ok(Date.parse(hello.data.serverTime));
      assert.equal(backlog.event, "backlog"); assert.deepEqual([...new Set(backlog.data.map((e) => e.session.id))].sort(), ["fx-v3", "fx-v4"]);
      fs.appendFileSync(file, sidLine("fx-v3", "2026-11-11T02:25:00.000Z", { tuid: "live-1" }));
      await until(() => frames(c.text).some((f) => f.event === "events"));
      const ev = frames(c.text).find((f) => f.event === "events"); assert.equal(ev.data.length, 1); assert.equal(ev.data[0].parent.toolUseId, "live-1");
      await until(() => c.text.includes(": ping"));
    } finally { c.close(); }
  }, { pingMs: 30 });
});

test("HTTP: Host guard returns 403 for foreign hosts (DNS rebinding); localhost is accepted; no ACAO on JSON", async () => {
  await withServer(async ({ port }) => {
    const get = (host, p = "/live/sessions") => new Promise((resolve, reject) => http.get({ host: "127.0.0.1", port, path: p, headers: { host } }, (res) => { let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: b })); }).on("error", reject));
    assert.equal((await get(`evil.example:${port}`)).status, 403);
    assert.equal((await get(`127.0.0.1:${port + 1}`)).status, 403);
    assert.equal((await get("127.0.0.1")).status, 403);
    assert.equal((await get(`evil.example:${port}`, "/live/stream")).status, 403);
    const ok1 = await get(`localhost:${port}`); assert.equal(ok1.status, 200);
    const ok2 = await get(`127.0.0.1:${port}`); assert.equal(ok2.status, 200); assert.equal(ok2.headers["access-control-allow-origin"], undefined);
  });
});

test("HTTP: close() ends open streams and stops the feed; live:false disables /live; static routes unchanged", async () => {
  const dir = tmp(), file = path.join(dir, "events.jsonl"); fs.writeFileSync(file, LINES.join("\n") + "\n");
  const live = feedFor(file); const s = createStaticServer({ port: 0, live }); const port = await s.listen();
  const c = sse(port); await until(() => frames(c.text).length >= 2);
  const home = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" }); assert.equal(home.status, 302);
  assert.equal((await fetch(`http://127.0.0.1:${port}/packages/forge/universe.html`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/nope.txt`)).status, 404);
  await s.close(); assert.equal(live.tail.timer, null, "feed stopped on close");
  c.close();

  const off = createStaticServer({ port: 0, live: false }); const p2 = await off.listen();
  try {
    assert.equal((await fetch(`http://127.0.0.1:${p2}/live/sessions`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${p2}/packages/forge/universe.html`)).status, 200);
  } finally { await off.close(); }
});

test("HTTP: the feed starts lazily on the first /live request", async () => {
  const dir = tmp(), file = path.join(dir, "events.jsonl"); fs.writeFileSync(file, LINES.join("\n") + "\n");
  const live = feedFor(file); const s = createStaticServer({ port: 0, live }); const port = await s.listen();
  try {
    await fetch(`http://127.0.0.1:${port}/packages/forge/universe.html`);
    assert.equal(live.tail.timer, null); assert.equal(live.sessions().length, 0);
    await fetch(`http://127.0.0.1:${port}/live/sessions`);
    assert.ok(live.tail.timer); assert.equal(live.sessions().length, 4);
  } finally { await s.close(); }
});
