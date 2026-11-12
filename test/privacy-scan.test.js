// Privacy gate: shipped recordings are synthetic, real hook logs are recorded outside the repository, and nothing in
// demo/recordings, docs or tools contains a denylisted name or path (the denylist lives outside the repository).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, DEFAULT_DIRS, loadDenylist, denylistPath, trackedFiles, scanDenylist, scanRecordings } from "../tools/privacy-scan.mjs";

test("every event in demo/recordings is marked synthetic (provenance.synthetic)", () => {
  const found = scanRecordings();
  assert.deepEqual(found.slice(0, 5), [], `${found.length} non-synthetic event(s) in demo/recordings`);
});

test("demo:record writes the live hook log to data/, which git ignores", () => {
  const script = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts["demo:record"];
  const out = script.match(/--out\s+(\S+)/)?.[1];
  assert.equal(out, "data/live-hooks.events.jsonl");
  const r = spawnSync("git", ["-C", ROOT, "check-ignore", "-q", out]);
  assert.equal(r.status, 0, out + " must be ignored by git");
});

test("no denylisted name or path in demo/recordings, docs or tools", (t) => {
  const terms = loadDenylist();
  if (!terms) { t.skip(`denylist not found, privacy scan skipped (${denylistPath()})`); return; }
  const found = scanDenylist(trackedFiles(DEFAULT_DIRS), terms);
  assert.deepEqual(found, [], "denylisted text found");
});

test("the scanner itself: finds denylisted terms case-insensitively, skips binaries, flags unmarked events", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "privacy-scan-"));
  try {
    fs.writeFileSync(path.join(dir, "a.md"), "Built for ExampleCorp at C:\\Users\\someone\\x");
    fs.writeFileSync(path.join(dir, "b.bin"), Buffer.from([0, 1, 2, 69, 120, 97]));
    const found = scanDenylist(["a.md", "b.bin"], ["examplecorp", "c:\\users\\someone", "absent"], dir);
    assert.deepEqual(found, [{ file: "a.md", term: "denylist line 1" }, { file: "a.md", term: "denylist line 2" }]);
    fs.mkdirSync(path.join(dir, "demo", "recordings"), { recursive: true });
    fs.writeFileSync(path.join(dir, "demo", "recordings", "x.events.jsonl"), JSON.stringify({ provenance: { synthetic: true } }) + "\n" + JSON.stringify({ provenance: { observed: true } }) + "\n");
    assert.deepEqual(scanRecordings(dir), [{ file: "demo/recordings/x.events.jsonl", line: 2, reason: "no provenance.synthetic" }]);
    const list = path.join(dir, "deny.txt"); fs.writeFileSync(list, "# comment\n\nExampleCorp\r\n  /home/someone  \n");
    assert.deepEqual(loadDenylist(list), ["ExampleCorp", "/home/someone"]);
    assert.equal(loadDenylist(path.join(dir, "missing.txt")), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- generic detectors, hooks, outgoing history
// Every sensitive-looking fixture is assembled at runtime, so this file itself never contains a match.
import * as SCAN from "../tools/privacy-scan.mjs";
import { lineFindings, scanContent, DETECTOR_EXCEPTIONS } from "../tools/privacy-scan.mjs";
const J = (...p) => p.join("");
const WIN = ["C:", "Users", J("jdoe", "-fixture"), "repo", "a.js"].join("\\");
const WIN_FWD = ["C:", "Users", J("jdoe", "-fixture"), "repo"].join("/");
const MAC = J("/Us", "ers/", "jdoe-fixture", "/code");
const LNX = J("/ho", "me/", "jdoe-fixture", "/code");
const BASH = J("/c/Us", "ers/", "jdoe-fixture", "/x");
const EMAIL_REAL = J("jane.doe", "@", "corp-mail", ".com");
const GH_TOKEN = J("gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8");
const AWS = J("AK", "IA", "QWERTYUIOPASDFGH");
const PEM = J("-----BEGIN ", "RSA PRIVATE", " KEY-----");
const ASSIGNED = J('apiKey = "', "Zq8xV2mPq7LwT4nRb9KcYd3H", '"');
const SENTINEL = J('const SECRET = "', "TOP-SECRET-probe-value", '";');
const ALLOWED_LINE = J(EMAIL_REAL, "  // privacy-scan: ", "allow public contact address");

test("generic detectors: personal paths, emails and credentials are found; placeholders and examples are not", () => {
  for (const l of [WIN, WIN_FWD, MAC, LNX, BASH]) assert.deepEqual(lineFindings(l), ["user-path"], "path not found");
  assert.deepEqual(lineFindings(`mail ${EMAIL_REAL} now`), ["email"]);
  assert.ok(lineFindings(GH_TOKEN)[0].startsWith("credential:"));
  assert.ok(lineFindings(AWS)[0].startsWith("credential:"));
  assert.ok(lineFindings(PEM)[0].startsWith("credential:"));
  assert.deepEqual(lineFindings(ASSIGNED), ["credential:assigned-secret"]);
  const clean = [["C:", "Users", "<name>", "x"].join("\\"), J("/ho", "me/you/x"), J("/Us", "ers/someone/x"), "%USERPROFILE%/.claude/eta", J("dev", "@", "example.com"), J("x", "@", "users.noreply.github.com"), J("git", "@", "github.com:org/repo.git"), J("Co-Authored-By: Claude <", "noreply", "@", "anthropic.com>"), "three@0.187.0", "@alexandria/audio", SENTINEL, "token = process.env.API_TOKEN_VALUE_X", 'password = "xxxxxxxxxxxxxxxxxxxx"'];
  for (const l of clean) assert.deepEqual(lineFindings(l), [], "false positive on a " + l.length + "-character line");
});

test("exceptions are narrow: an inline marker excuses its own line only (and never a denylist hit); one listed detector exception", () => {
  const r = scanContent("a.md", Buffer.from([ALLOWED_LINE, EMAIL_REAL, "mentions the privacy-scan: allow marker in prose"].join("\n")), { terms: ["corp-mail"] });
  // line 1: marker present, but a denylist term also matches, so it is NOT excused; line 2 is a finding; line 3 has none
  assert.deepEqual(r.findings.map((f) => [f.line, f.kind]), [[1, "email"], [1, "denylist line 1"], [2, "email"], [2, "denylist line 1"]]);
  const r2 = scanContent("a.md", Buffer.from(ALLOWED_LINE), {});
  assert.deepEqual(r2.findings, []); assert.deepEqual(r2.allowed, [{ file: "a.md", line: 1, kinds: ["email"] }]);
  assert.deepEqual(DETECTOR_EXCEPTIONS.map((x) => [x.file, x.detector]), [["package-lock.json", "email"]]);
  assert.deepEqual(scanContent("package-lock.json", Buffer.from(EMAIL_REAL)).findings, []);
  assert.equal(scanContent("other.json", Buffer.from(EMAIL_REAL)).findings.length, 1);
});

test("recordings: canonical events must be synthetic; raw hook lines only in a protocol-pinned fixture", () => {
  const ev = (syn) => JSON.stringify({ kind: "tool.result", session: { id: "s" }, provenance: syn ? { synthetic: true } : { observed: true } });
  assert.deepEqual(scanContent("x.events.jsonl", Buffer.from(ev(true) + "\n" + ev(false))).findings.map((f) => [f.line, f.kind]), [[2, "recording:not-synthetic"]]);
  const raw = JSON.stringify({ ts: "2026-01-01T00:00:00Z", ev: "PostToolUse", sid: "s1", proj: "p" }) + "\n";
  assert.equal(scanContent("fixtures/h.jsonl", Buffer.from(raw)).findings[0].kind, "recording:raw-hook-line");
  const pin = crypto.createHash("sha256").update(raw).digest("hex");
  assert.deepEqual(scanContent("fixtures/h.jsonl", Buffer.from(raw), { pinned: { "fixtures/h.jsonl": pin } }).findings, []);
  assert.equal(scanContent("fixtures/h.jsonl", Buffer.from(raw + raw), { pinned: { "fixtures/h.jsonl": pin } }).findings.length, 2, "a changed pinned fixture is refused");
});

// temp repositories for the hook paths
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "f@example.invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "f@example.invalid" };
const g = (cwd, ...a) => { const r = spawnSync("git", a, { cwd, encoding: "utf8", env: gitEnv }); if (r.status !== 0) throw new Error(a.join(" ") + ": " + r.stderr); return r.stdout.trim(); };
const SCANNER = path.join(ROOT, "tools", "privacy-scan.mjs");
const runScan = (cwd, args, { input = "", env = {} } = {}) => spawnSync(process.execPath, [SCANNER, ...args], { cwd, input, encoding: "utf8", env: { ...gitEnv, ...env } });
function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "privacy-hooks-")), remote = path.join(dir, "remote.git"), repo = path.join(dir, "repo");
  g(dir, "init", "-q", "--bare", "-b", "main", remote); g(dir, "clone", "-q", remote, repo);
  fs.writeFileSync(path.join(repo, "README.md"), "clean\n"); g(repo, "add", "-A"); g(repo, "commit", "-q", "-m", "first"); g(repo, "push", "-q", "origin", "main");
  return { dir, repo, remote };
}
const DENY_MISSING = { ALEXANDRIA_DENYLIST: path.join(os.tmpdir(), "no-such-denylist-" + process.pid + ".txt") };
const noLeak = (r) => { const out = r.stdout + r.stderr; for (const s of ["jdoe", "Zq8xV2", "A1b2C3", "jane.doe", "QWERTYUIOP"]) assert.ok(!out.includes(s), "scanner output leaked a matched value"); };

test("pre-commit scan: staged additions are checked as staged (not the working tree); missing denylist only warns", () => {
  const { dir, repo } = tempRepo();
  try {
    fs.writeFileSync(path.join(repo, "notes.md"), `path ${WIN}\n`); g(repo, "add", "notes.md");
    fs.writeFileSync(path.join(repo, "notes.md"), "now clean in the working tree\n"); // the staged blob still leaks
    let r = runScan(repo, ["--staged"], { env: DENY_MISSING });
    assert.equal(r.status, 1); assert.match(r.stderr, /notes\.md:1 user-path/); noLeak(r);
    g(repo, "add", "notes.md");
    r = runScan(repo, ["--staged"], { env: DENY_MISSING });
    assert.equal(r.status, 0); assert.match(r.stderr + r.stdout, /denylist check SKIPPED/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("pre-push scan: a leak in an outgoing historical commit is caught even when the tip is clean", () => {
  const { dir, repo } = tempRepo();
  try {
    const base = g(repo, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(repo, "config.js"), ASSIGNED + "\n"); g(repo, "add", "-A"); g(repo, "commit", "-q", "-m", "add config");
    const leaky = g(repo, "rev-parse", "--short=7", "HEAD");
    fs.writeFileSync(path.join(repo, "config.js"), "export const apiKey = process.env.KEY;\n"); g(repo, "commit", "-q", "-am", "use env");
    g(repo, "commit", "-q", "--allow-empty", "-m", `notes from ${MAC}`);
    const tip = g(repo, "rev-parse", "HEAD");
    const r = runScan(repo, ["--pre-push"], { input: `refs/heads/main ${tip} refs/heads/main ${base}\n`, env: DENY_MISSING });
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`config\\.js @${leaky}:1 credential:assigned-secret`));
    assert.match(r.stderr, /commit [0-9a-f]{7} \(message\/author\):\d+ user-path/);
    assert.match(r.stderr, /3 outgoing commit/); noLeak(r);
    // a new branch (remote side all zeros) sends what no remote has; the tip tree is scanned too
    const r2 = runScan(repo, ["--pre-push"], { input: `refs/heads/x ${tip} refs/heads/x ${"0".repeat(40)}\n`, env: DENY_MISSING });
    assert.equal(r2.status, 1); noLeak(r2);
    // a clean push with no denylist: generic checks pass, then refuse unless explicitly allowed
    g(repo, "reset", "-q", "--hard", base); fs.writeFileSync(path.join(repo, "ok.md"), "fine\n"); g(repo, "add", "-A"); g(repo, "commit", "-q", "-m", "fine");
    const ok = g(repo, "rev-parse", "HEAD"), line = `refs/heads/main ${ok} refs/heads/main ${base}\n`;
    assert.equal(runScan(repo, ["--pre-push"], { input: line, env: DENY_MISSING }).status, 2);
    assert.equal(runScan(repo, ["--pre-push"], { input: line, env: { ...DENY_MISSING, ALEXANDRIA_ALLOW_NO_DENYLIST: "1" } }).status, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("installed hooks block a leaking commit and a leaking push end to end", () => {
  const { dir, repo } = tempRepo();
  try {
    fs.mkdirSync(path.join(repo, "tools")); fs.copyFileSync(SCANNER, path.join(repo, "tools", "privacy-scan.mjs"));
    fs.copyFileSync(path.join(ROOT, "tools", "install-privacy-hooks.mjs"), path.join(repo, "tools", "install-privacy-hooks.mjs"));
    g(repo, "add", "-A"); g(repo, "commit", "-q", "-m", "tools");
    assert.equal(spawnSync(process.execPath, ["tools/install-privacy-hooks.mjs"], { cwd: repo, encoding: "utf8" }).status, 0);
    const env = { ...gitEnv, ...DENY_MISSING, ALEXANDRIA_ALLOW_NO_DENYLIST: "1" };
    fs.writeFileSync(path.join(repo, "leak.md"), `${EMAIL_REAL}\n`);
    spawnSync("git", ["add", "leak.md"], { cwd: repo, env });
    const c = spawnSync("git", ["commit", "-q", "-m", "leak"], { cwd: repo, encoding: "utf8", env });
    assert.notEqual(c.status, 0, "pre-commit should block"); assert.match(c.stderr, /commit blocked/);
    // bypass the commit hook to plant the leak in history, then the push hook must stop it
    spawnSync("git", ["commit", "-q", "--no-verify", "-m", "leak"], { cwd: repo, env });
    const p = spawnSync("git", ["push", "-q", "origin", "main"], { cwd: repo, encoding: "utf8", env });
    assert.notEqual(p.status, 0, "pre-push should block"); assert.match(p.stderr, /push blocked/);
    const remoteMain = spawnSync("git", ["--git-dir", path.join(dir, "remote.git"), "rev-parse", "main"], { encoding: "utf8" }).stdout.trim();
    assert.notEqual(g(repo, "rev-parse", "HEAD"), remoteMain, "nothing was pushed");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("this repository: the generic detectors find nothing in any tracked file (runs without the private denylist)", () => {
  const { scanWorkingTree } = SCAN;
  const r = scanWorkingTree({ dirs: null, terms: null });
  assert.deepEqual(r.findings.map((f) => `${f.file}:${f.line} ${f.kind}`), []);
});

test("pre-push scan: a personal author or committer email on an outgoing commit is caught", () => {
  const { dir, repo } = tempRepo();
  try {
    const base = g(repo, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(repo, "b.md"), "fine\n"); g(repo, "add", "-A");
    spawnSync("git", ["commit", "-q", "-m", "b"], { cwd: repo, env: { ...gitEnv, GIT_AUTHOR_EMAIL: EMAIL_REAL, GIT_COMMITTER_EMAIL: EMAIL_REAL } });
    const r = runScan(repo, ["--pre-push"], { input: `refs/heads/main ${g(repo, "rev-parse", "HEAD")} refs/heads/main ${base}\n`, env: DENY_MISSING });
    assert.equal(r.status, 1); assert.match(r.stderr, /\(message\/author\):1 email/); assert.match(r.stderr, /\(message\/author\):2 email/); noLeak(r);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
