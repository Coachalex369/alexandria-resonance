#!/usr/bin/env node
// Packaging step: electron-builder strips every examples/ folder from bundled node_modules, but the universe page
// imports Three.js add-ons from three/examples/jsm/ (bloom, fat lines). Copy exactly those add-on folders to
// build-vendor/three-addons/ (git-ignored, rebuilt on every package); the server falls back to it when
// node_modules/three/examples is absent (packaged app). Pages and the import map stay unchanged.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "node_modules", "three", "examples", "jsm"), dst = path.join(root, "build-vendor", "three-addons");
export const ADDON_DIRS = ["lines", "postprocessing", "shaders"];
fs.rmSync(dst, { recursive: true, force: true });
let n = 0;
for (const d of ADDON_DIRS) { fs.cpSync(path.join(src, d), path.join(dst, d), { recursive: true }); n += fs.readdirSync(path.join(dst, d), { recursive: true }).length; }
console.log(`vendored ${n} Three.js add-on files (${ADDON_DIRS.join(", ")}) → build-vendor/three-addons/`);
