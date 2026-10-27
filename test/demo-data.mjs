// Deterministic synthetic data for the public demo screenshots (no personal data).
// Produces the same shapes Home Assistant returns: compressed history (seconds) and
// hourly long-term statistics (milliseconds). History older than `retentionDays` is
// dropped, like the recorder's purge, so the statistics merge is exercised.
const H = 3600e3, D = 24 * H;

function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

function hourly(points, now) {
  const rows = [];
  let i = 0;
  for (let t = Math.floor(points[0][0] / H) * H; t + H <= now; t += H) {
    while (i + 1 < points.length && points[i + 1][0] <= t) i++;
    if (points[i][0] <= t + H) rows.push({ start: t, end: t + H, mean: points[i][1] });
  }
  return rows;
}

export function demoFixture(now = Date.now(), retentionDays = 10) {
  const r = rng(42);
  const official = [];
  const raw = [];
  let t = now - 420 * D;
  t = new Date(t).setHours(7, 20, 0, 0);
  while (t < now - 6 * H) {
    const progress = 1 - (now - t) / (420 * D);
    const base = 82.4 - 4.2 * progress + Math.sin(progress * 9) * 0.6;
    const w = Math.round((base + (r() - 0.5) * 0.8) * 10) / 10;
    official.push([t + Math.floor(r() * 40) * 60e3, w]);
    if (r() < 0.35) official.push([t + 12 * H + Math.floor(r() * 60) * 60e3, Math.round((w + 0.4 + r() * 0.7) * 10) / 10]); // evening weigh-in
    raw.push([t, Math.round((w + (r() - 0.5) * 0.3) * 20) / 20]);
    if (r() < 0.3) raw.push([t + 13 * H, Math.round((w + 0.6 + r() * 0.8) * 20) / 20]);
    t += (1 + Math.floor(r() * 3)) * D;
  }
  const bmi = official.map(([tt, w]) => [tt, Math.round((w / 1.83 ** 2) * 10) / 10]);
  const cut = now - retentionDays * D;
  const hist = (pts) => pts.filter(([tt]) => tt >= cut).map(([tt, v]) => ({ s: String(v), lu: tt / 1000 }));
  const state = (id, pts, name, unit) => ({ entity_id: id, state: String(pts.at(-1)[1]), last_changed: new Date(pts.at(-1)[0]).toISOString(), attributes: { friendly_name: name, unit_of_measurement: unit } });
  return {
    language: "de",
    history: { "sensor.weight": hist(official), "sensor.bmi": hist(bmi), "sensor.scale_raw": hist(raw) },
    statistics: { "sensor.weight": hourly(official, now), "sensor.bmi": hourly(bmi, now), "sensor.scale_raw": hourly(raw, now) },
    states: {
      "sensor.weight": state("sensor.weight", official, "Weight", "kg"),
      "sensor.bmi": state("sensor.bmi", bmi, "BMI", "kg/m²"),
      "sensor.scale_raw": state("sensor.scale_raw", raw, "Scale (raw)", "kg"),
      "sensor.empty": { entity_id: "sensor.empty", state: "unknown", last_changed: new Date(now).toISOString(), attributes: { friendly_name: "Body fat", unit_of_measurement: "%" } },
    },
  };
}
