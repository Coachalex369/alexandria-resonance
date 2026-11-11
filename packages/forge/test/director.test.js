import test from "node:test";
import assert from "node:assert/strict";
import { CameraDirector, PHASES } from "../src/director.js";

const extent = { radius: 4, yMin: -2, yMax: 2 };
function play(d, seconds, ms) {
  const poses = [];
  for (let t = 0; t < seconds * 1000; t += 100) { const p = d.update(100, { milestones: ms(t), progress: t / (seconds * 1000), extent, resolved: t > seconds * 1000 * 0.92 }); poses.push({ ...p, target: [...p.target], phase: d.phase }); }
  return poses;
}
const story = (t) => ({ firstAgent: t > 20000 ? 20000 : null, firstCrystal: t > 60000 ? 60000 : null, firstBelow: t > 90000 ? 90000 : null, firstPass: t > 200000 ? 200000 : null });

test("phases advance in order on milestones, each with its minimum dwell, and finish on completion", () => {
  const d = new CameraDirector();
  const poses = play(d, 400, story);
  const seen = [...new Set(poses.map((p) => p.phase))];
  assert.deepEqual(seen, PHASES);
  assert.deepEqual(d.history.map((h) => h.phase), PHASES);
  assert.ok(d.history[1].t >= 14000 && d.history[2].t - d.history[1].t >= 16000);
  assert.ok(poses.every((p) => Number.isFinite(p.azimuth) && Number.isFinite(p.elevation) && Number.isFinite(p.distance)));
});
test("grounded starts low and near; revelation goes beneath the plane; completion settles high", () => {
  const d = new CameraDirector();
  const poses = play(d, 400, story);
  const by = (ph) => poses.filter((p) => p.phase === ph);
  assert.ok(by("grounded").every((p) => p.elevation < 0.12));
  assert.ok(Math.min(...by("revelation").map((p) => p.elevation)) < -0.15, "the camera looks up from beneath the plane");
  assert.ok(Math.max(...by("revelation").map((p) => p.elevation)) > 0.3, "and gains height first");
  const last = poses.at(-1); assert.ok(last.elevation > 0.3 && last.distance > by("grounded")[0].distance);
});
test("progress fallback carries the arc without milestones", () => {
  const d = new CameraDirector();
  play(d, 400, () => ({}));
  assert.equal(d.phase, "completion");
  assert.ok(d.history.some((h) => h.reason === "progress"));
});
test("reduced motion: no continuous orbit; manual control pauses the director; ground and overview poses", () => {
  const d = new CameraDirector({ reduced: true });
  const poses = play(d, 120, () => ({ firstAgent: 1 }));
  const settled = poses.slice(-20);
  assert.ok(Math.abs(settled[0].azimuth - settled.at(-1).azimuth) < 1e-3, "azimuth rests between phases");
  const m = new CameraDirector();
  m.update(100, { extent });
  const g = m.ground(extent); assert.ok(m.manual && g.elevation < 0.1);
  const before = { ...m.pose }; m.update(5000, { extent, progress: 0.9 }); assert.deepEqual({ ...m.pose, target: undefined }, { ...before, target: undefined });
  const o = m.overview(extent); assert.ok(o.elevation > 1);
  m.resume(o); assert.equal(m.manual, false); assert.equal(m.pose.elevation, o.elevation);
});
