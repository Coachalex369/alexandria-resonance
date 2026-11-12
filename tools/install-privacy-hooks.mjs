#!/usr/bin/env node
// Installs the local privacy gate into this checkout's .git/hooks (hooks are local; they are never committed):
//   pre-commit  scans the staged content of added and changed files (tools/privacy-scan.mjs --staged)
//   pre-push    scans every outgoing commit and each pushed tip (tools/privacy-scan.mjs --pre-push); it refuses to
//               push when the private denylist is missing unless ALEXANDRIA_ALLOW_NO_DENYLIST=1
// Usage: node tools/install-privacy-hooks.mjs   (from anywhere inside the checkout). Existing hooks of the same name
// are kept as <name>.before-privacy-gate the first time.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const hooksDir = spawnSync("git", ["rev-parse", "--git-path", "hooks"], { encoding: "utf8" }).stdout.trim();
if (!hooksDir) { console.error("not inside a git checkout"); process.exit(1); }
const MARK = "# alexandria-privacy-gate";
const hook = (mode, what) => `#!/bin/sh
${MARK} (local only; installed by tools/install-privacy-hooks.mjs; not committed)
root="$(git rev-parse --show-toplevel)"
if [ ! -f "$root/tools/privacy-scan.mjs" ]; then echo "${what}: tools/privacy-scan.mjs missing; refusing unchecked" >&2; exit 1; fi
node "$root/tools/privacy-scan.mjs" ${mode}
status=$?
if [ $status -ne 0 ]; then echo "${what}: privacy scan failed (exit $status); ${what === "pre-push" ? "push" : "commit"} blocked" >&2; exit 1; fi
exit 0
`;
fs.mkdirSync(hooksDir, { recursive: true });
for (const [name, mode] of [["pre-commit", "--staged"], ["pre-push", "--pre-push"]]) {
  const file = path.join(hooksDir, name);
  if (fs.existsSync(file) && !fs.readFileSync(file, "utf8").includes(MARK) && !fs.existsSync(file + ".before-privacy-gate")) fs.renameSync(file, file + ".before-privacy-gate");
  fs.writeFileSync(file, hook(mode, name), { mode: 0o755 });
  console.log(`installed ${path.relative(process.cwd(), file) || file}`);
}
