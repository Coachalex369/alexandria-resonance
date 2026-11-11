// The Visualizer's own local server: home redirect, pages, Three.js module, path traversal, independent port.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStaticServer, DEFAULT_PORT } from "../tools/serve-demo.js";

test("serves the universe page, the Three.js module and recordings; redirects / ; refuses traversal", async () => {
  const s = createStaticServer({ port: 0 }); const port = await s.listen();
  const get = (p) => fetch(`http://127.0.0.1:${port}${p}`, { redirect: "manual" });
  try {
    assert.equal(DEFAULT_PORT, 4350, "the Visualizer never uses the Scoreboard's 4340");
    const home = await get("/"); assert.equal(home.status, 302); assert.equal(home.headers.get("location"), "/packages/forge/universe.html");
    const page = await get("/packages/forge/universe.html"); assert.equal(page.status, 200); assert.match(await page.text(), /importmap/);
    const three = await get("/node_modules/three/build/three.module.js"); assert.equal(three.status, 200); assert.match(three.headers.get("content-type"), /javascript/);
    assert.equal((await get("/demo/recordings/forge-demo-session.events.jsonl")).status, 200);
    assert.notEqual((await get("/../../Windows/win.ini")).status, 200);
  } finally { await s.close(); }
});

test("packaged layout: Three.js add-ons are served from build-vendor when node_modules/three/examples is absent", async () => {
  const fs = await import("node:fs"); const os = await import("node:os"); const path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "viz-pkg-"));
  fs.mkdirSync(path.join(root, "node_modules", "three", "build"), { recursive: true }); fs.writeFileSync(path.join(root, "node_modules", "three", "build", "three.module.js"), "export const core = 1;\n");
  fs.mkdirSync(path.join(root, "build-vendor", "three-addons", "postprocessing"), { recursive: true }); fs.writeFileSync(path.join(root, "build-vendor", "three-addons", "postprocessing", "UnrealBloomPass.js"), "export const bloom = 1;\n");
  const s = createStaticServer({ root, port: 0 }); const port = await s.listen();
  try {
    const r = await fetch(`http://127.0.0.1:${port}/node_modules/three/examples/jsm/postprocessing/UnrealBloomPass.js`); assert.equal(r.status, 200); assert.match(await r.text(), /bloom/);
    fs.writeFileSync(path.join(root, "secret.txt"), "outside the vendor folder");
    for (const evil of ["/node_modules/three/examples/jsm/..%2f..%2f..%2fsecret.txt", "/node_modules/three/examples/jsm/%2e%2e/%2e%2e/%2e%2e/secret.txt"]) {
      const r = await fetch(`http://127.0.0.1:${port}${evil}`); assert.notEqual(r.status, 200, evil); assert.doesNotMatch(await r.text(), /outside the vendor/);
    }
  } finally { await s.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
