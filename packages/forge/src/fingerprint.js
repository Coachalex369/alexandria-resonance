// Deterministic replay support: a session fingerprint (hash of the event ids in order plus the configuration)
// seeds a small PRNG so the same recording and configuration always produce the same composition.

export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
// 64 hex chars built from four independent FNV passes over salted inputs.
export function fingerprint(events, config = {}) {
  const ids = events.map((e) => e.id).join("|");
  const cfg = stableStringify(config);
  return [fnv1a("ids:" + ids), fnv1a("cfg:" + cfg), fnv1a("n:" + events.length + ":" + ids.length), fnv1a(ids + "::" + cfg)].map((h) => h.toString(16).padStart(8, "0")).join("");
}
// JSON with sorted keys so equal configs hash equally regardless of key order.
export function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
// mulberry32: tiny, fast, deterministic. rng() in [0,1).
export function seedRandom(seed) {
  let a = typeof seed === "string" ? fnv1a(seed) : seed >>> 0;
  const rng = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  rng.range = (lo, hi) => lo + (hi - lo) * rng();
  return rng;
}
// Hash of a composition snapshot (for determinism tests and export manifests).
export function snapshotHash(obj) { return fnv1a(stableStringify(obj)).toString(16).padStart(8, "0"); }
