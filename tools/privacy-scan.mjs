#!/usr/bin/env node
// Privacy scan: keeps real projects, people, machines and secrets out of what this repository ships.
//
// Generic detectors (always on, no private file needed):
//   user-path     personal home folders: Windows C:\Users\<name>, macOS /Users/<name>, Linux /home/<name>
//                 (placeholder names such as <name>, you, someone are allowed: PLACEHOLDER_USERS)
//   email         email addresses, except reserved example domains, *.invalid, GitHub noreply and git@github.com
//   credential    private key blocks, well-known token formats, and long high-entropy values assigned to
//                 secret-like names
//   recording     JSON Lines events (kind + session) must carry provenance.synthetic === true; raw hook-log lines
//                 (ev + sid) are refused, except a fixture whose exact content is pinned in PROTOCOL_VERSION.json
// Private layer (optional): every line of a denylist kept OUTSIDE the repository (~/.alexandria/denylist.txt, or
//   ALEXANDRIA_DENYLIST): project names, personal paths. Missing denylist is reported as SKIPPED, never as clean.
//
// Exceptions are narrow and visible: a line containing "privacy-scan: allow <reason>" (reason of 3+ characters) is
// excused for that line only, and every excused line is counted and listed in the summary. There are no folder or
// file exemptions.
//
// Output never contains what matched: findings are "file:line kind" (denylist hits by line number of the list).
//
// CLI (run from inside a repository):
//   node tools/privacy-scan.mjs [--all]   tracked files of the working tree (default: demo/recordings, docs, tools)
//   node tools/privacy-scan.mjs --staged  the staged content of added/changed files (pre-commit hook)
//   node tools/privacy-scan.mjs --pre-push  reads git's pre-push stdin; scans every outgoing commit (changed files,
//                                         message, author and committer) and the full tree of each pushed tip
// Exit: 0 clean · 1 findings · 2 generic checks clean but the denylist is missing (pre-push refuses unless
//   ALEXANDRIA_ALLOW_NO_DENYLIST=1; --staged only warns).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_DIRS = ["demo/recordings", "docs", "tools"];
export const denylistPath = () => process.env.ALEXANDRIA_DENYLIST || path.join(os.homedir(), ".alexandria", "denylist.txt");
export const PLACEHOLDER_USERS = new Set(["<name>", "<user>", "<username>", "name", "user", "username", "you", "your-name", "yourname", "someone", "me", "example", "runner", "$user", "${user}", "%username%", "…", "...", "*"]);
const ALLOWED_EMAIL_DOMAIN = [/^example\.(com|org|net)$/i, /\.example\.(com|org|net)$/i, /\.invalid$/i, /^invalid$/i, /^users\.noreply\.github\.com$/i, /\.test$/i, /\.localhost$/i];
// public automated addresses (git transport; the required co-author trailer of AI-assisted commits)
const ALLOWED_EMAILS = new Set(["git@github.com", "noreply@anthropic.com"]);
const ALLOW_MARK = /privacy-scan:\s*allow\s+\S.{2,}/i;
// Detector exceptions: one detector, one exact file, a stated reason; printed in every scan summary.
export const DETECTOR_EXCEPTIONS = [{ file: "package-lock.json", detector: "email", reason: "third-party npm registry metadata (package maintainers' published addresses)" }];
// A test value that names itself (a canary such as "...-SECRET-probe") is a sentinel, not a credential.
const SENTINEL_WORDS = /secret|canary|probe|dummy|fake|placeholder|example|redacted|sample|not-a-real/i;
const MAX_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------- detectors (pure)
const entropy = (s) => { const n = new Map(); for (const c of s) n.set(c, (n.get(c) || 0) + 1); let h = 0; for (const v of n.values()) { const p = v / s.length; h -= p * Math.log2(p); } return h; };
const PLACEHOLDER_SECRET = /^(x+|\*+|\.+|<[^>]*>|\$\{[^}]*\}|%[^%]*%|your[-_a-z]*|changeme|example[-_a-z]*|test[-_a-z]*|dummy[-_a-z]*|placeholder[-_a-z]*)$/i;
const CREDENTIALS = [
  ["private-key", /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/],
  ["aws-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/],
  ["slack-token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ["stripe-key", /\b[sr]k_live_[A-Za-z0-9]{20,}/],
  ["google-key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["api-key", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
];
const SECRET_ASSIGN = /(?:secret|token|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth)[A-Za-z0-9_]*["']?\s*[:=]\s*["'`]([^"'`\s]{16,})["'`]/gi;
const USER_PATHS = [/\b[A-Za-z]:(?:\\\\|\\|\/)+Users(?:\\\\|\\|\/)+([^\\/\s"'`<>|:*?]+(?:>)?)/gi, /\/Users\/([^/\s"'`]+)/g, /\/home\/([^/\s"'`]+)/g];
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g;

export function lineFindings(line, { skip = new Set() } = {}) {
  const out = new Set();
  for (const re of USER_PATHS) for (const m of line.matchAll(re)) { const u = m[1].replace(/[)\].,;]+$/, ""); if (!PLACEHOLDER_USERS.has(u.toLowerCase()) && !/^</.test(u)) out.add("user-path"); }
  if (!skip.has("email")) for (const m of line.matchAll(EMAIL)) if (!ALLOWED_EMAILS.has(m[0].toLowerCase()) && !ALLOWED_EMAIL_DOMAIN.some((r) => r.test(m[1]))) out.add("email");
  for (const [kind, re] of CREDENTIALS) if (re.test(line)) out.add("credential:" + kind);
  for (const m of line.matchAll(SECRET_ASSIGN)) { const v = m[1]; if (!PLACEHOLDER_SECRET.test(v) && !SENTINEL_WORDS.test(v) && !/^(process\.env|import\.meta)/.test(v) && entropy(v) >= 3.5) out.add("credential:assigned-secret"); }
  return [...out];
}

// The protocol-pinned fixtures (exact content, LF-normalized sha256, as the protocol drift test computes it).
function pinnedFixtures(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, "PROTOCOL_VERSION.json"), "utf8")).files || {}; } catch { return {}; }
}
const sha = (text) => crypto.createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");

// Findings for one file's content: [{ file, line, kind }] and the excused lines [{ file, line }].
export function scanContent(file, buf, { terms = null, pinned = {} } = {}) {
  const findings = [], allowed = [];
  if (!buf || buf.length > MAX_BYTES || buf.includes(0)) return { findings, allowed };
  const text = buf.toString("utf8"), lines = text.split(/\r?\n/), lower = terms ? terms.map((t) => t.toLowerCase()) : null;
  const isJsonl = /\.(jsonl|ndjson)$/i.test(file), pinnedOk = pinned[file] && pinned[file] === sha(text);
  const skip = new Set(DETECTOR_EXCEPTIONS.filter((x) => x.file === file).map((x) => x.detector));
  lines.forEach((l, i) => {
    const n = i + 1, here = lineFindings(l, { skip }).map((k) => ({ file, line: n, kind: k }));
    if (lower) { const s = l.toLowerCase(); lower.forEach((t, j) => { if (s.includes(t)) here.push({ file, line: n, kind: `denylist line ${j + 1}` }); }); }
    // an allow marker excuses only a line that has a finding (a line merely mentioning the marker is not "excused"),
    // and never a denylist hit
    if (here.length && ALLOW_MARK.test(l) && !here.some((h) => h.kind.startsWith("denylist"))) allowed.push({ file, line: n, kinds: here.map((h) => h.kind) });
    else findings.push(...here);
    if (isJsonl && l.trim()) {
      let e = null; try { e = JSON.parse(l); } catch { /* not JSON: not an event */ }
      if (e && typeof e === "object") {
        if (e.kind && e.session && e?.provenance?.synthetic !== true) findings.push({ file, line: n, kind: "recording:not-synthetic" });
        else if (e.ev && e.sid && !pinnedOk) findings.push({ file, line: n, kind: "recording:raw-hook-line" });
      }
    }
  });
  return { findings, allowed };
}

// ---------------------------------------------------------------- the private denylist and file sources
export function loadDenylist(file = denylistPath()) {
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}
const git = (root, args, enc = "utf8") => spawnSync("git", ["-C", root, ...args], { encoding: enc, maxBuffer: 256 << 20 });
export function trackedFiles(dirs = DEFAULT_DIRS, root = ROOT) {
  const r = git(root, ["ls-files", "-z", "--", ...(dirs || [])]);
  if (r.status !== 0) throw new Error("git ls-files failed: " + r.stderr);
  return r.stdout.split("\0").filter(Boolean);
}
// Kept for callers of the first version: denylist-only findings in working-tree files.
export function scanDenylist(files, terms, root = ROOT) {
  const out = [], lower = terms.map((t) => t.toLowerCase());
  for (const f of files) {
    let text; try { text = fs.readFileSync(path.join(root, f)); } catch { continue; }
    if (text.includes(0)) continue;
    const s = text.toString("utf8").toLowerCase();
    lower.forEach((t, i) => { if (s.includes(t)) out.push({ file: f, term: `denylist line ${i + 1}` }); });
  }
  return out;
}
export function scanRecordings(root = ROOT) {
  const dir = path.join(root, "demo", "recordings"), out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (!/\.jsonl?$/.test(name)) continue;
    fs.readFileSync(path.join(dir, name), "utf8").split(/\r?\n/).forEach((l, i) => {
      if (!l.trim()) return;
      let e; try { e = JSON.parse(l); } catch { out.push({ file: "demo/recordings/" + name, line: i + 1, reason: "not JSON" }); return; }
      if (e?.provenance?.synthetic !== true) out.push({ file: "demo/recordings/" + name, line: i + 1, reason: "no provenance.synthetic" });
    });
  }
  return out;
}

// Working tree (tracked files), staged content, or the outgoing commits of a push.
export function scanWorkingTree({ root = ROOT, dirs = DEFAULT_DIRS, terms = loadDenylist() } = {}) {
  const pinned = pinnedFixtures(root), res = { findings: [], allowed: [], scanned: 0 };
  for (const f of trackedFiles(dirs, root)) { let b; try { b = fs.readFileSync(path.join(root, f)); } catch { continue; } add(res, scanContent(f, b, { terms, pinned })); }
  return res;
}
export function scanStaged({ root = ROOT, terms = loadDenylist() } = {}) {
  const pinned = pinnedFixtures(root), res = { findings: [], allowed: [], scanned: 0 };
  const files = git(root, ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"]).stdout.split("\0").filter(Boolean);
  for (const f of files) { const r = git(root, ["show", ":" + f], "buffer"); if (r.status === 0) add(res, scanContent(f, r.stdout, { terms, pinned })); }
  return res;
}
// updates: [{ localSha, remoteSha }] (git pre-push stdin). Every commit being sent is scanned: its changed files at
// that commit, its message, author and committer; and the whole tree of each pushed tip.
export function scanOutgoing(updates, { root = ROOT, terms = loadDenylist() } = {}) {
  const pinned = pinnedFixtures(root), res = { findings: [], allowed: [], scanned: 0, commits: 0 }, ZERO = /^0+$/;
  for (const { localSha, remoteSha } of updates) {
    if (ZERO.test(localSha)) continue; // a deletion sends nothing
    const range = ZERO.test(remoteSha) ? [localSha, "--not", "--remotes"] : [`${remoteSha}..${localSha}`];
    let commits = git(root, ["rev-list", ...range]).stdout.split("\n").filter(Boolean);
    if (!ZERO.test(remoteSha) && git(root, ["cat-file", "-e", remoteSha + "^{commit}"]).status !== 0) commits = git(root, ["rev-list", localSha]).stdout.split("\n").filter(Boolean); // unknown remote tip: scan all
    for (const c of commits) {
      res.commits++;
      const short = c.slice(0, 7);
      const meta = git(root, ["log", "-1", "--format=%an <%ae>%n%cn <%ce>%n%B", c]).stdout;
      for (const f of scanContent(`commit ${short} (message/author)`, Buffer.from(meta), { terms }).findings) res.findings.push(f);
      const files = git(root, ["diff-tree", "--root", "--no-commit-id", "-r", "-m", "--name-only", "-z", "--diff-filter=ACMR", c]).stdout.split("\0").filter(Boolean);
      for (const f of new Set(files)) { const r = git(root, ["show", `${c}:${f}`], "buffer"); if (r.status === 0) add(res, scanContent(f, r.stdout, { terms, pinned }), `@${short}`); }
    }
    for (const f of git(root, ["ls-tree", "-r", "--name-only", "-z", localSha]).stdout.split("\0").filter(Boolean)) { const r = git(root, ["show", `${localSha}:${f}`], "buffer"); if (r.status === 0) add(res, scanContent(f, r.stdout, { terms, pinned }), `@${localSha.slice(0, 7)} tip`); }
  }
  res.findings = dedupe(res.findings); res.allowed = dedupe(res.allowed);
  return res;
}
function add(res, r, where = "") { res.scanned++; for (const f of r.findings) res.findings.push(where ? { ...f, file: `${f.file} ${where}` } : f); for (const a of r.allowed) res.allowed.push(where ? { ...a, file: `${a.file} ${where}` } : a); }
function dedupe(list) { const seen = new Set(); return list.filter((x) => { const k = JSON.stringify(x); if (seen.has(k)) return false; seen.add(k); return true; }); }

// ---------------------------------------------------------------- CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), mode = args.includes("--staged") ? "staged" : args.includes("--pre-push") ? "pre-push" : args.includes("--all") ? "all" : "default";
  const top = git(process.cwd(), ["rev-parse", "--show-toplevel"]).stdout.trim() || ROOT, terms = loadDenylist();
  let res;
  if (mode === "staged") res = scanStaged({ root: top, terms });
  else if (mode === "pre-push") {
    const updates = fs.readFileSync(0, "utf8").split("\n").map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 4).map(([, localSha, , remoteSha]) => ({ localSha, remoteSha }));
    res = scanOutgoing(updates, { root: top, terms });
  } else res = scanWorkingTree({ root: top, dirs: mode === "all" ? null : DEFAULT_DIRS, terms });
  for (const f of res.findings.slice(0, 50)) console.error(`privacy: ${f.file}:${f.line} ${f.kind}`);
  if (res.findings.length > 50) console.error(`privacy: … ${res.findings.length - 50} more`);
  for (const a of res.allowed) console.log(`privacy: excused by an inline allow marker: ${a.file}:${a.line} (${a.kinds.join(", ")})`);
  for (const x of DETECTOR_EXCEPTIONS) console.log(`privacy: detector exception: ${x.detector} not applied to ${x.file} (${x.reason})`);
  const scope = mode === "pre-push" ? `${res.commits} outgoing commit(s) and pushed tips` : mode === "staged" ? `${res.scanned} staged file(s)` : mode === "all" ? "all tracked files" : DEFAULT_DIRS.join(", ");
  if (res.findings.length) { console.error(`privacy: ${res.findings.length} finding(s) in ${scope}${mode === "pre-push" ? "; nothing was pushed" : ""}`); process.exit(1); }
  if (!terms) {
    const msg = `privacy: generic checks clean (${scope}); denylist not found (${denylistPath()}), denylist check SKIPPED`;
    if (mode === "staged" || (mode === "pre-push" && process.env.ALEXANDRIA_ALLOW_NO_DENYLIST === "1")) { console.warn(msg); process.exit(0); }
    console.error(msg + (mode === "pre-push" ? "; refusing to push (set ALEXANDRIA_ALLOW_NO_DENYLIST=1 to push with generic checks only)" : "")); process.exit(2);
  }
  console.log(`privacy: clean (${scope}; generic detectors + ${terms.length} denylist terms${res.allowed.length ? `; ${res.allowed.length} line(s) excused` : ""})`);
}
