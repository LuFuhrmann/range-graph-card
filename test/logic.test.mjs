// Unit tests for the pure helpers. Run with: TZ=Europe/Berlin npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRange, rangeStart, historyToPoints, statisticsToPoints, mergeSeries,
  xDomain, yDomain, niceTicks, timeTicks, valueAt, dailyMeans, computeChange,
} from "../range-graph-card.js";

const H = 3600e3, D = 24 * H;
const now = Date.parse("2026-10-27T10:00:00+01:00");

test("parseRange accepts stock style keys and rejects junk", () => {
  assert.deepEqual(parseRange("1W"), { key: "1w", n: 1, unit: "w" });
  assert.deepEqual(parseRange("all"), { key: "all", n: 0, unit: "all" });
  assert.equal(parseRange("0m"), null);
  assert.equal(parseRange("week"), null);
});

test("rangeStart counts calendar months and years", () => {
  assert.equal(new Date(rangeStart(parseRange("1m"), now)).getMonth(), 8);
  assert.equal(new Date(rangeStart(parseRange("1y"), now)).getFullYear(), 2025);
  assert.equal(rangeStart(parseRange("1w"), now), now - 7 * D - H); // clocks went back on 25.10.
  assert.ok(rangeStart(parseRange("all"), now) < now - 10 * 365 * D);
});

test("historyToPoints skips unknown/unavailable and uses last_changed", () => {
  const pts = historyToPoints([{ s: "unknown", lu: 1 }, { s: "66.0", lu: 2 }, { s: "unavailable", lu: 3 }, { s: "68", lu: 5, lc: 4 }]);
  assert.deepEqual(pts, [{ t: 2000, v: 66 }, { t: 4000, v: 68 }]);
});

test("statistics are used only before history and collapse equal values", () => {
  const t0 = now - 10 * D;
  const rows = [0, 1, 2, 3].map((i) => ({ start: t0 + i * H, end: t0 + (i + 1) * H, mean: i < 3 ? 70 : 69 }));
  assert.deepEqual(statisticsToPoints(rows), [{ t: t0, v: 70, stat: "hour" }, { t: t0 + 3 * H, v: 69, stat: "hour" }]);
  assert.deepEqual(statisticsToPoints(rows, t0 + 2 * H), [{ t: t0, v: 70, stat: "hour" }]);
});

test("mergeSeries carries the last value before the range start to the start", () => {
  const s = mergeSeries({ statistics: [{ t: 0, v: 70 }, { t: 5, v: 71 }], history: [{ t: 20, v: 69 }], start: 10 });
  assert.deepEqual(s, [{ t: 10, v: 71, carried: true }, { t: 20, v: 69 }]);
});

test("xDomain starts at the first point when the range is longer than the data", () => {
  const series = [[{ t: now - 3 * D, v: 66 }, { t: now - D, v: 68 }]];
  assert.deepEqual(xDomain(series, now - 90 * D, now), [now - 3 * D, now]);
  assert.deepEqual(xDomain(series, now - 2 * D, now), [now - 2 * D, now]);
  assert.deepEqual(xDomain([[{ t: now - 60e3, v: 1 }]], now - D, now), [now - H, now], "single fresh point gets 1 h");
});

test("yDomain pads around values, handles a single value and config limits", () => {
  const [lo, hi] = yDomain([66, 68]);
  assert.ok(lo < 66 && lo > 65.5 && hi > 68 && hi < 68.5);
  const [a, b] = yDomain([68]);
  assert.ok(a < 68 && b > 68);
  assert.deepEqual(yDomain([66, 68], 60, 80), [60, 80]);
});

test("niceTicks and timeTicks produce round, increasing values", () => {
  assert.deepEqual(niceTicks(65.7, 68.3, 4).ticks, [66, 67, 68]);
  assert.deepEqual(niceTicks(18.0, 19.1, 4).ticks, [18, 18.5, 19]);
  assert.deepEqual(niceTicks(17.98, 19.12, 8).ticks, [18, 18.2, 18.4, 18.6, 18.8, 19]);
  const { ticks, unit } = timeTicks(now - 3 * D, now, 5);
  assert.equal(unit, "d");
  assert.ok(ticks.every((t) => new Date(t).getHours() === 0));
  const m = timeTicks(now - 365 * D, now, 6);
  assert.equal(m.unit, "M");
  assert.ok(m.ticks.every((t) => new Date(t).getDate() === 1));
});

test("valueAt returns the step value", () => {
  const pts = [{ t: 1, v: 1 }, { t: 5, v: 2 }];
  assert.equal(valueAt(pts, 0), null);
  assert.equal(valueAt(pts, 4), 1);
  assert.equal(valueAt(pts, 9), 2);
});

test("dailyMeans groups by local day and ignores carried values", () => {
  const d1 = Date.parse("2026-10-25T07:00:00+01:00"), d1e = Date.parse("2026-10-25T21:00:00+01:00");
  const d2 = Date.parse("2026-10-26T00:30:00+01:00"); // after midnight Berlin, still 25.10. in UTC
  const days = dailyMeans([{ t: d1 - D, v: 50, carried: true }, { t: d1, v: 68 }, { t: d1e, v: 69 }, { t: d2, v: 70 }]);
  assert.equal(days.length, 2);
  assert.equal(days[0].v, 68.5);
  assert.equal(days[0].n, 2);
  assert.equal(days[0].t, (d1 + d1e) / 2);
  assert.equal(days[1].v, 70);
});

test("computeChange: raw value vs. daily mean basis", () => {
  const t = Date.parse("2026-10-24T08:00:00+02:00");
  const pts = [{ t, v: 66 }, { t: t + 12 * H, v: 67 }, { t: t + 2 * D, v: 68 }, { t: t + 2 * D + 12 * H, v: 69.2 }];
  assert.equal(computeChange(pts, t, 69.2).diff.toFixed(1), "3.2");
  const daily = computeChange(pts, t, 69.2, "daily_mean");
  assert.equal(daily.diff.toFixed(1), "2.1"); // 68.6 - 66.5
  assert.equal(daily.days, 2);
  const one = computeChange(pts.slice(0, 2), t, 67, "daily_mean");
  assert.equal(one.diff, null, "one day only: neutral");
  assert.equal(one.mean, 66.5);
});
