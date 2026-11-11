// Alexandria Resonance (internal id: alexandria-visualizer): Windows desktop shell (Electron main process, ES module).
// Serves the same pages as `npm start`, in-process, on a random loopback port. Offline by design: no network calls,
// no auto-update, no telemetry. Independent of every other Alexandria application.
//
//   npm run desktop                      dev run from the repo
//   npm run desktop -- --smoke=out.png   load, screenshot the real window to a PNG, exit 0 (verification)
//   npm run dist:zip                     portable ZIP in dist/
import { app, BrowserWindow, Menu, shell, dialog } from "electron";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createStaticServer, APP_ROOT, HOME_PATH } from "../tools/serve-demo.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8"));
const smoke = process.argv.find((a) => a.startsWith("--smoke="))?.slice(8) || null;
const PRODUCT = "Alexandria Resonance";
// Reserved for the live-activity milestone; nothing is written there yet.
export function defaultDataDir() { return process.env.VZ_DATA_DIR || path.join(os.homedir(), ".claude", "eta", "visualizer"); }

if (!app.requestSingleInstanceLock()) app.quit();
app.setAppUserModelId("com.alexandrialtd.visualizer");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required"); // music can start without a first click

let server = null, origin = null, win = null;
const PAGES = [
  { label: "As Above, So Below (universe)", path: HOME_PATH, accelerator: "CmdOrCtrl+1" },
  { label: "Forge session (demo)", path: "/packages/forge/session.html", accelerator: "CmdOrCtrl+2" },
  { label: "The Forge", path: "/packages/forge/", accelerator: "CmdOrCtrl+3" },
  { label: "Geometry laboratory", path: "/packages/forge/lab.html", accelerator: "CmdOrCtrl+4" },
  { label: "Canvas visualizer (first prototype)", path: "/packages/visualizer/", accelerator: "CmdOrCtrl+5" },
  { label: "Audio prototype", path: "/packages/audio/", accelerator: "CmdOrCtrl+6" },
];

async function startServer() {
  server = createStaticServer({ root: APP_ROOT, port: 0 });
  const port = await server.listen();
  origin = `http://127.0.0.1:${port}`;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 720, minHeight: 520, backgroundColor: "#05060a", show: false, title: PRODUCT,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.once("ready-to-show", () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => (url.startsWith(origin) ? { action: "allow" } : (shell.openExternal(url), { action: "deny" })));
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith(origin)) { e.preventDefault(); shell.openExternal(url); } });
  win.loadURL(origin + HOME_PATH);
  Menu.setApplicationMenu(buildMenu());
  if (smoke) win.webContents.once("did-finish-load", () => setTimeout(async () => {
    try { const img = await win.webContents.capturePage(); fs.mkdirSync(path.dirname(smoke), { recursive: true }); fs.writeFileSync(smoke, img.toPNG()); console.log(`smoke: ${img.getSize().width}x${img.getSize().height} → ${smoke} · ${origin}${HOME_PATH}`); app.exit(0); }
    catch (err) { console.error(`smoke failed: ${err.message}`); app.exit(1); }
  }, 5000));
}

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: "Resonance", submenu: [
      ...PAGES.map((p) => ({ label: p.label, accelerator: p.accelerator, click: () => win?.loadURL(origin + p.path) })),
      { type: "separator" },
      { label: "Open hook log folder", click: () => shell.openPath(path.join(os.homedir(), ".claude", "eta")) },
      { type: "separator" },
      { role: "quit" },
    ] },
    { label: "View", submenu: [{ role: "togglefullscreen" }, { type: "separator" }, { role: "zoomIn" }, { role: "zoomOut" }, { role: "resetZoom" }, { type: "separator" }, { role: "reload" }, { role: "toggleDevTools" }] },
    { label: "Help", submenu: [
      { label: "About", click: () => dialog.showMessageBox(win, { type: "info", title: PRODUCT, message: `${PRODUCT} ${pkg.version}`, detail: `Offline desktop shell · Electron ${process.versions.electron}\nLocal server ${origin}\nGenerative art and music from live Claude Code activity, or from recordings.\n\nAlexandria Ltd.` }) },
    ] },
  ]);
}

app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(async () => { try { await startServer(); createWindow(); } catch (err) { dialog.showErrorBox(`${PRODUCT} could not start`, String(err?.stack || err)); app.exit(1); } });
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => { server?.close(); });
