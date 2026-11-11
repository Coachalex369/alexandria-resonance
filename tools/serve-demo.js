#!/usr/bin/env node
// Alexandria Resonance local server (no dependencies). Serves the application root so the pages can load the
// engine/taxonomy ES modules, Three.js from /node_modules/three/ and the recordings under /demo/recordings/.
//   npm start      → http://127.0.0.1:4350/packages/forge/universe.html   (port: VZ_PORT or PORT)
// The desktop shell imports createStaticServer() and serves the packaged app the same way on a random port.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLiveRoutes } from "./live-feed.js";

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_PORT = 4350;
export const HOME_PATH = "/packages/forge/universe.html";
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json", ".jsonl": "application/x-ndjson", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".md": "text/markdown; charset=utf-8", ".wasm": "application/wasm", ".woff2": "font/woff2" };

// `live`: a LiveFeed instance (tests), false to disable /live/*, or omitted for the default feed (VZ_HOOK_LOG or ~/.claude/eta/events.jsonl).
export function createStaticServer({ root = APP_ROOT, port = DEFAULT_PORT, live, pingMs } = {}) {
  const base = path.resolve(root);
  let server;
  const routes = createLiveRoutes({ live, pingMs, getPort: () => server.address()?.port });
  server = http.createServer((req, res) => {
    if (routes.handle(req, res)) return;
    let url; try { url = decodeURIComponent(req.url.split("?")[0]); } catch { res.writeHead(400); res.end(); return; }
    if (url === "/") { res.writeHead(302, { location: HOME_PATH }); res.end(); return; }
    let file = path.join(base, url);
    if (!file.startsWith(base)) { res.writeHead(403); res.end(); return; }
    // Packaged app: Three.js add-ons come from build-vendor/ (electron-builder drops node_modules/*/examples).
    const ADDONS = "/node_modules/three/examples/jsm/";
    if (url.startsWith(ADDONS) && !fs.existsSync(file)) {
      const vendor = path.join(base, "build-vendor", "three-addons");
      file = path.join(vendor, url.slice(ADDONS.length));
      if (!file.startsWith(vendor + path.sep)) { res.writeHead(403); res.end(); return; } // no escape from the vendor folder
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { "content-type": "text/plain" }); res.end(`not found: ${url}`); return; }
      res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
      res.end(data);
    });
  });
  const listen = () => new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => resolve(server.address().port)); });
  const close = () => new Promise((r) => { routes.close(); server.close(r); server.closeAllConnections?.(); });
  return { server, listen, close };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.VZ_PORT || process.env.PORT || DEFAULT_PORT);
  createStaticServer({ port }).listen().then((p) => {
    console.log(`Alexandria Resonance → http://127.0.0.1:${p}${HOME_PATH}`);
    console.log(`  also: /packages/forge/session.html · /packages/forge/ · /packages/forge/lab.html · /packages/visualizer/ · /packages/audio/`);
  }, (err) => { console.error(`cannot listen on ${port}: ${err.message}`); process.exit(1); });
}
