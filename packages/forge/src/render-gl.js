// WebGL renderer adapter (Three.js). Pure adapter: draws world-space frame data (see frame.js FrameBuilder.build())
// from a camera description. It knows nothing about the engines that produced the data.
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";

const BUCKET_PX = [1, 2, 3.2];
const bucketOf = (w) => (w <= 1.2 ? 0 : w <= 2.4 ? 1 : 2);

function makeSprite() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.25, "rgba(255,255,255,0.55)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

export class GLRenderer {
  constructor(canvas, { background = "#04050a", bloom = true, dprCap = 2 } = {}) {
    this.canvas = canvas; this.dprCap = dprCap; this.bloomOn = !!bloom; this.available = false;
    this._stats = { ms: 0, lines: 0, faces: 0, points: 0 };
    this._w = 1; this._h = 1; this._dpr = 1;
    let renderer = null;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance", preserveDrawingBuffer: true });
    } catch (e) { renderer = null; }
    if (!renderer || !renderer.capabilities || !renderer.capabilities.isWebGL2) { if (renderer) renderer.dispose(); return; }
    this.available = true;
    this.renderer = renderer;
    renderer.toneMapping = THREE.NoToneMapping;
    // Input colours are display-referred (CSS-like). Linear output means no extra transfer curve is applied.
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.setClearColor(new THREE.Color(background), 1);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(background);
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.05, 200);

    // faces
    this.faceGeo = new THREE.BufferGeometry();
    this.faceMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false, depthTest: true });
    this.faceMesh = new THREE.Mesh(this.faceGeo, this.faceMat);
    this.faceMesh.frustumCulled = false; this.faceMesh.renderOrder = 0;
    this._growFaces(1024);
    this.scene.add(this.faceMesh);

    // lines (3 width buckets)
    this.buckets = BUCKET_PX.map((px, i) => {
      const material = new LineMaterial({ color: 0xffffff, linewidth: px, vertexColors: true, worldUnits: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true });
      const b = { px, material, cap: 0, pos: null, col: null, geo: null, mesh: null, n: 0 };
      this._growBucket(b, 1024);
      b.mesh.renderOrder = 1 + i;
      this.scene.add(b.mesh);
      return b;
    });

    // points
    this.pointGeo = new THREE.BufferGeometry();
    this.pointMat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: makeSprite() }, uViewH: { value: 1 } },
      vertexShader: `attribute float size; attribute vec3 color; varying vec3 vColor;
        uniform float uViewH;
        void main() { vColor = color; vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = max(1.0, size * uViewH * 0.5 * projectionMatrix[1][1] / max(0.0001, -mv.z));
          gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform sampler2D uMap; varying vec3 vColor;
        void main() { float a = texture2D(uMap, gl_PointCoord).a; gl_FragColor = vec4(vColor * a, 1.0); }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true,
    });
    this.points = new THREE.Points(this.pointGeo, this.pointMat);
    this.points.frustumCulled = false; this.points.renderOrder = 5;
    this._growPoints(1024);
    this.scene.add(this.points);

    // post
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.9, 0.4, 0.2);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());
    this.resize();
  }

  _growFaces(cap) {
    this._faceCap = cap;
    this.facePos = new THREE.BufferAttribute(new Float32Array(cap * 9), 3).setUsage(THREE.DynamicDrawUsage);
    this.faceCol = new THREE.BufferAttribute(new Float32Array(cap * 9), 3).setUsage(THREE.DynamicDrawUsage);
    this.faceGeo.dispose();
    this.faceGeo.setAttribute("position", this.facePos);
    this.faceGeo.setAttribute("color", this.faceCol);
    this.faceGeo.setDrawRange(0, 0);
  }
  _growPoints(cap) {
    this._pointCap = cap;
    this.pPos = new THREE.BufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.pCol = new THREE.BufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.pSize = new THREE.BufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage);
    this.pointGeo.dispose();
    this.pointGeo.setAttribute("position", this.pPos);
    this.pointGeo.setAttribute("color", this.pCol);
    this.pointGeo.setAttribute("size", this.pSize);
    this.pointGeo.setDrawRange(0, 0);
  }
  _growBucket(b, cap) {
    if (b.geo) b.geo.dispose();
    b.cap = cap; b.pos = new Float32Array(cap * 6); b.col = new Float32Array(cap * 6);
    b.geo = new LineSegmentsGeometry();
    b.geo.setPositions(b.pos); b.geo.setColors(b.col);
    b.geo.instanceCount = 0;
    if (!b.mesh) { b.mesh = new LineSegments2(b.geo, b.material); b.mesh.frustumCulled = false; }
    else b.mesh.geometry = b.geo;
  }

  resize() {
    if (!this.available) return;
    const dpr = Math.min(globalThis.devicePixelRatio || 1, this.dprCap);
    const w = Math.max(1, this.canvas.clientWidth || this.canvas.width), h = Math.max(1, this.canvas.clientHeight || this.canvas.height);
    this._dpr = dpr; this._w = w; this._h = h;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(w, h);
    this.bloomPass.resolution.set(Math.max(1, Math.floor(w * dpr / 2)), Math.max(1, Math.floor(h * dpr / 2)));
    for (const b of this.buckets) { b.material.resolution.set(w * dpr, h * dpr); b.material.linewidth = b.px * dpr; }
    this.pointMat.uniforms.uViewH.value = h * dpr;
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }

  setQuality(level) { this.bloomOn = level >= 1; }

  render(frame, camera) {
    if (!this.available) return;
    const t0 = performance.now();
    const cam = this.camera;
    cam.position.set(camera.position[0], camera.position[1], camera.position[2]);
    const up = camera.up || [0, 1, 0];
    cam.up.set(up[0], up[1], up[2]);
    cam.fov = (camera.fov * 180) / Math.PI; cam.near = camera.near ?? 0.05; cam.far = camera.far ?? 200;
    cam.aspect = this._w / this._h;
    cam.lookAt(camera.target[0], camera.target[1], camera.target[2]);
    cam.updateProjectionMatrix(); cam.updateMatrixWorld();

    // faces
    const F = frame.faces || { count: 0 }, nF = F.count | 0;
    if (nF > this._faceCap) this._growFaces(Math.max(nF, this._faceCap * 2));
    if (nF > 0) {
      this.facePos.array.set(F.positions.subarray(0, nF * 9)); this.faceCol.array.set(F.colors.subarray(0, nF * 9));
      this.facePos.needsUpdate = true; this.faceCol.needsUpdate = true;
    }
    this.faceGeo.setDrawRange(0, nF * 3); this.faceMesh.visible = nF > 0;

    // lines: bucket by width
    const L = frame.lines || { count: 0 }, nL = L.count | 0;
    const counts = [0, 0, 0];
    for (let i = 0; i < nL; i++) counts[bucketOf(L.widths[i])]++;
    for (let k = 0; k < 3; k++) {
      const b = this.buckets[k];
      if (counts[k] > b.cap) this._growBucket(b, Math.max(counts[k], b.cap * 2));
      b.n = 0;
    }
    for (let i = 0; i < nL; i++) {
      const b = this.buckets[bucketOf(L.widths[i])], o = b.n++ * 6, s = i * 6;
      for (let j = 0; j < 6; j++) { b.pos[o + j] = L.positions[s + j]; b.col[o + j] = L.colors[s + j]; }
    }
    for (const b of this.buckets) {
      b.geo.attributes.instanceStart.data.needsUpdate = true;
      b.geo.attributes.instanceColorStart.data.needsUpdate = true;
      b.geo.instanceCount = b.n; b.mesh.visible = b.n > 0;
    }

    // points
    const P = frame.points || { count: 0 }, nP = P.count | 0;
    if (nP > this._pointCap) this._growPoints(Math.max(nP, this._pointCap * 2));
    if (nP > 0) {
      this.pPos.array.set(P.positions.subarray(0, nP * 3)); this.pCol.array.set(P.colors.subarray(0, nP * 3)); this.pSize.array.set(P.sizes.subarray(0, nP));
      this.pPos.needsUpdate = true; this.pCol.needsUpdate = true; this.pSize.needsUpdate = true;
    }
    this.pointGeo.setDrawRange(0, nP); this.points.visible = nP > 0;

    const bl = frame.bloom;
    if (bl) {
      if (bl.strength != null) this.bloomPass.strength = bl.strength;
      if (bl.radius != null) this.bloomPass.radius = bl.radius;
      if (bl.threshold != null) this.bloomPass.threshold = bl.threshold;
    }
    if (this.bloomOn) this.composer.render(); else this.renderer.render(this.scene, cam);
    this._stats = { ms: performance.now() - t0, lines: nL, faces: nF, points: nP };
  }

  stats() { return this._stats; }

  screenshotBlob() {
    return new Promise((resolve) => {
      if (!this.available) return resolve(null);
      this.canvas.toBlob((b) => resolve(b), "image/png");
    });
  }

  dispose() {
    if (!this.available) return;
    this.faceGeo.dispose(); this.faceMat.dispose();
    for (const b of this.buckets) { b.geo.dispose(); b.material.dispose(); }
    this.pointGeo.dispose(); this.pointMat.uniforms.uMap.value.dispose(); this.pointMat.dispose();
    this.composer.dispose(); this.renderer.dispose();
    this.available = false;
  }
}
