/*! range-graph-card v1.0.0 | MIT License | https://github.com/LuFuhrmann/range-graph-card */
// A Home Assistant Lovelace card that shows the history of one or more numeric
// entities as a step chart with stock-app style range buttons (1W, 1M, 3M, ...).
// No build step and no runtime dependencies: this file is the whole card.

export const VERSION = "1.0.0";

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const DEFAULT_RANGES = ["1w", "1m", "3m", "6m", "1y", "all"];
const ALL_YEARS = 20; // how far back "All" looks
const PALETTE = ["var(--primary-color, #03a9f4)", "var(--accent-color, #ff9800)", "#4caf50", "#9c27b0", "#e91e63"];

const STRINGS = {
  en: {
    units: { h: "H", d: "D", w: "W", m: "M", y: "Y" }, all: "All",
    since: "since", inRange: "", noData: "No data yet for", loading: "Loading…",
    error: "Could not load history", updated: "Updated", noEntity: "Entity not found",
    dailyMean: "Daily mean", oneDay: "only 1 day so far", mean: "Ø",
    meanHint: "Ø = change of the daily mean: last vs. first day with data",
  },
  de: {
    units: { h: "Std", d: "T", w: "W", m: "M", y: "J" }, all: "Alle",
    since: "seit", noData: "Noch keine Messwerte für", loading: "Lade…",
    error: "Verlauf konnte nicht geladen werden", updated: "Stand", noEntity: "Entität nicht gefunden",
    dailyMean: "Tagesmittel", oneDay: "erst 1 Tag", mean: "Ø",
    meanHint: "Ø = Veränderung des Tagesmittels: letzter gegenüber erstem Tag mit Daten",
  },
};

// ---------------------------------------------------------------- pure helpers

/** Parses "1w", "3m", "all" ... into { key, n, unit } or null. */
export function parseRange(key) {
  const k = String(key).trim().toLowerCase();
  if (k === "all") return { key: k, n: 0, unit: "all" };
  const m = /^(\d+)\s*([hdwmy])$/.exec(k);
  return m && Number(m[1]) > 0 ? { key: k, n: Number(m[1]), unit: m[2] } : null;
}

/** Start of a range (ms), counted back from `now` in local calendar time. */
export function rangeStart(range, now) {
  const d = new Date(now);
  switch (range.unit) {
    case "h": return now - range.n * HOUR;
    case "d": d.setDate(d.getDate() - range.n); return d.getTime();
    case "w": d.setDate(d.getDate() - 7 * range.n); return d.getTime();
    case "m": d.setMonth(d.getMonth() - range.n); return d.getTime();
    case "y": d.setFullYear(d.getFullYear() - range.n); return d.getTime();
    default: d.setFullYear(d.getFullYear() - ALL_YEARS); return d.getTime();
  }
}

export function rangeLabel(range, strings) {
  return range.unit === "all" ? strings.all : `${range.n}${strings.units[range.unit]}`;
}

const toMs = (t) => (typeof t === "number" ? (t < 1e11 ? t * 1000 : t) : Date.parse(t));

/** HA compressed history ([{s, lu, lc?}]) -> numeric points [{t, v}]. Non-numeric states are skipped. */
export function historyToPoints(list) {
  const out = [];
  for (const e of list || []) {
    const v = Number.parseFloat(e.s ?? e.state);
    const t = toMs(e.lc ?? e.lu ?? e.last_changed ?? e.last_updated);
    if (Number.isFinite(v) && Number.isFinite(t)) out.push({ t, v });
  }
  return out;
}

/**
 * Long-term statistics rows -> points {t, v}. Only periods that end at or before `before`
 * are used (pass the first history timestamp, so the recorder's exact values win wherever
 * they still exist). Consecutive equal values are collapsed.
 */
export function statisticsToPoints(rows, before = Infinity, period = "hour") {
  const out = [];
  for (const r of rows || []) {
    const v = r.mean ?? r.state;
    const t = toMs(r.start);
    const end = r.end != null ? toMs(r.end) : t;
    if (v == null || !Number.isFinite(v) || !Number.isFinite(t) || end > before) continue;
    if (out.length && out[out.length - 1].v === v) continue;
    out.push({ t, v, stat: period });
  }
  return out;
}

/** Merges older statistics points and history points; a value from before `start` is carried to `start`. */
export function mergeSeries({ history = [], statistics = [], start = -Infinity }) {
  const merged = [...statistics, ...history].sort((a, b) => a.t - b.t);
  const out = [];
  let carried = null;
  for (const p of merged) {
    if (p.t <= start) carried = { t: start, v: p.v, carried: true };
    else out.push(p);
  }
  if (carried) out.unshift(carried);
  return out;
}

/** Visible x window: from the later of (range start, first point) to now; never shorter than 1 h. */
export function xDomain(series, start, now) {
  const first = Math.min(...series.filter((s) => s.length).map((s) => s[0].t));
  let lo = Math.max(start, Number.isFinite(first) ? first : start);
  if (!Number.isFinite(lo) || now - lo < HOUR) lo = now - HOUR;
  return [lo, now];
}

/** y window around the visible values with some headroom; config min/max override. */
export function yDomain(values, cfgMin, cfgMax) {
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
  const span = hi - lo;
  const pad = span > 0 ? span * 0.15 : Math.max(Math.abs(hi) * 0.01, 0.1);
  lo -= pad; hi += pad;
  if (cfgMin != null && cfgMin !== "") lo = Number(cfgMin);
  if (cfgMax != null && cfgMax !== "") hi = Number(cfgMax);
  if (hi <= lo) hi = lo + 1;
  return [lo, hi];
}

/** "Nice" tick values inside [lo, hi]. */
export function niceTicks(lo, hi, maxTicks = 4) {
  const raw = (hi - lo) / Math.max(1, maxTicks);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((f) => f * mag).find((s) => s >= raw) || 10 * mag;
  const ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) ticks.push(Number(v.toFixed(10)));
  return { ticks, step };
}

const X_STEPS = [
  [HOUR, "h", 1], [3 * HOUR, "h", 3], [6 * HOUR, "h", 6], [12 * HOUR, "h", 12],
  [DAY, "d", 1], [2 * DAY, "d", 2], [7 * DAY, "d", 7], [14 * DAY, "d", 14],
  [30 * DAY, "M", 1], [61 * DAY, "M", 2], [91 * DAY, "M", 3], [182 * DAY, "M", 6], [365 * DAY, "M", 12],
];

/** Time ticks aligned to local hours, midnights or month starts. */
export function timeTicks(lo, hi, maxTicks) {
  const [, unit, n] = X_STEPS.find(([ms]) => (hi - lo) / ms <= maxTicks) || X_STEPS[X_STEPS.length - 1];
  const d = new Date(lo);
  if (unit === "h") { d.setMinutes(0, 0, 0); while (d.getTime() < lo || d.getHours() % n) d.setHours(d.getHours() + 1); }
  else if (unit === "d") { d.setHours(0, 0, 0, 0); if (d.getTime() < lo) d.setDate(d.getDate() + 1); }
  else { d.setHours(0, 0, 0, 0); d.setDate(1); while (d.getTime() < lo || d.getMonth() % n) d.setMonth(d.getMonth() + 1); }
  const ticks = [];
  for (let i = 0; d.getTime() <= hi && i < 50; i++) {
    ticks.push(d.getTime());
    if (unit === "h") d.setHours(d.getHours() + n);
    else if (unit === "d") d.setDate(d.getDate() + n);
    else d.setMonth(d.getMonth() + n);
  }
  return { ticks, unit };
}

/** Value of a step series at time t (last point at or before t). */
export function valueAt(points, t) {
  let v = null;
  for (const p of points) { if (p.t <= t) v = p.v; else break; }
  return v;
}

const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };

/**
 * Daily means (local time zone) of the real measurements in `points` at or after `from`.
 * Each day is placed at the mean time of its measurements, so it never lies in the future.
 * Carried values (from before the range) are ignored.
 */
export function dailyMeans(points, from = -Infinity) {
  const days = new Map();
  for (const p of points) {
    if (p.carried || p.t < from) continue;
    const k = dayKey(p.t);
    const d = days.get(k) || days.set(k, { day: k, ts: 0, vs: 0, n: 0 }).get(k);
    d.ts += p.t; d.vs += p.v; d.n += 1;
  }
  return [...days.values()].map((d) => ({ day: d.day, t: d.ts / d.n, v: d.vs / d.n, n: d.n }));
}

/**
 * Change over the visible window. basis "value": current value minus the value at the window
 * start. basis "daily_mean": mean of the last day minus mean of the first day with data
 * (null diff when there is only one day).
 */
export function computeChange(points, x0, current, basis = "value") {
  if (basis === "daily_mean") {
    const days = dailyMeans(points, x0);
    if (!days.length) return null;
    const first = days[0], last = days[days.length - 1];
    return { diff: days.length > 1 ? last.v - first.v : null, since: first.t, mean: last.v, days: days.length };
  }
  const base = valueAt(points, x0) ?? points[0]?.v;
  return base == null || !Number.isFinite(current) ? null : { diff: current - base, since: x0 };
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ---------------------------------------------------------------- card

const Base = globalThis.HTMLElement ?? class {};

export class RangeGraphCard extends Base {
  static getStubConfig(hass) {
    const e = Object.keys(hass?.states || {}).find((id) => id.startsWith("sensor.") && Number.isFinite(Number(hass.states[id].state)));
    return { entity: e || "sensor.example" };
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._data = null; // { series: [[{t,v}]], start, now }
    this._loading = false;
    this._error = null;
    this._lastChanged = {};
    this._fetchId = 0;
    this._width = 0;
  }

  setConfig(config) {
    if (!config || (!config.entity && !config.entities)) throw new Error("range-graph-card: set `entity` or `entities`.");
    const list = config.entities ? [].concat(config.entities) : [{ entity: config.entity, name: config.name }];
    const entities = list.map((e, i) => {
      const o = typeof e === "string" ? { entity: e } : { ...e };
      if (!o.entity) throw new Error("range-graph-card: every entry in `entities` needs an `entity`.");
      o.color = o.color || PALETTE[i % PALETTE.length];
      return o;
    });
    const ranges = (config.ranges || DEFAULT_RANGES).map(parseRange);
    if (!ranges.length || ranges.some((r) => !r)) throw new Error("range-graph-card: `ranges` entries look like 1d, 2w, 3m, 1y or all.");
    this._config = {
      height: 200, statistics: true, show_points: "auto", good_direction: "none", show_updated: true,
      change_basis: "value", trend_line: "none",
      ...config, entities, ranges,
    };
    if (!["value", "daily_mean"].includes(this._config.change_basis)) throw new Error("range-graph-card: `change_basis` is value or daily_mean.");
    if (!["none", "daily_mean"].includes(this._config.trend_line)) throw new Error("range-graph-card: `trend_line` is none or daily_mean.");
    this._storageKey = `range-graph-card:${config.storage_key || entities.map((e) => e.entity).join(",") + "|" + (config.title ?? "")}`;
    let saved = null;
    try { saved = globalThis.localStorage?.getItem(this._storageKey); } catch (_) { /* private mode */ }
    const pick = [saved, config.default_range, "1m"].map((k) => k && ranges.find((r) => r.key === String(k).toLowerCase())).find(Boolean);
    this._range = pick || ranges[0];
    this._data = null;
    this._built = false;
    if (this._hass) this._load();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (!this._config) return;
    let changed = false;
    for (const e of this._config.entities) {
      const lc = hass.states[e.entity]?.last_changed;
      if (lc && this._lastChanged[e.entity] !== lc) { if (this._lastChanged[e.entity]) changed = true; this._lastChanged[e.entity] = lc; }
    }
    if (first || !this._data) this._load();
    else if (changed) { clearTimeout(this._reloadTimer); this._reloadTimer = setTimeout(() => this._load(), 1000); }
    else this._renderHeader();
  }

  connectedCallback() {
    this._ro = this._ro || new ResizeObserver(() => {
      const w = this.shadowRoot.querySelector(".chart")?.clientWidth || 0;
      if (w && w !== this._width) { this._width = w; this._renderChart(); }
    });
    if (this._built) this._ro.observe(this.shadowRoot.querySelector(".chart"));
    this._tick = setInterval(() => { if (this._data) { this._data.now = Date.now(); this._renderChart(); } }, 5 * 60e3);
    if (this._hass && this._config && !this._data) this._load();
  }

  disconnectedCallback() {
    this._ro?.disconnect();
    clearInterval(this._tick);
    clearTimeout(this._reloadTimer);
  }

  getCardSize() { return Math.ceil((Number(this._config?.height) + 130) / 50); }
  getGridOptions() { return { columns: 12, min_columns: 6, min_rows: 4 }; }

  // ------------------------------------------------------------ data

  get _strings() {
    const lang = (this._hass?.locale?.language || this._hass?.language || "en").toLowerCase();
    return STRINGS[lang.split("-")[0]] || STRINGS.en;
  }
  get _locale() { return this._hass?.locale?.language || this._hass?.language || "en"; }

  async _load() {
    if (!this._hass || !this._config) return;
    const id = ++this._fetchId;
    const now = Date.now();
    const start = rangeStart(this._range, now);
    const ids = this._config.entities.map((e) => e.entity);
    this._loading = true;
    this._build();
    this._renderStatus();
    try {
      const iso = (t) => new Date(t).toISOString();
      const historyP = this._hass.callWS({
        type: "history/history_during_period", start_time: iso(start), end_time: iso(now),
        entity_ids: ids, minimal_response: true, no_attributes: true, significant_changes_only: false,
      });
      const statIds = this._config.entities.map((e) => e.statistic_id || e.entity);
      const period = now - start > 100 * DAY ? "day" : "hour";
      const statsP = this._config.statistics
        ? this._hass.callWS({
          type: "recorder/statistics_during_period", start_time: iso(start), end_time: iso(now),
          statistic_ids: statIds, period, types: ["mean", "state"],
        }).catch(() => ({}))
        : Promise.resolve({});
      const [history, stats] = await Promise.all([historyP, statsP]);
      if (id !== this._fetchId) return;
      const series = this._config.entities.map((e, i) => {
        const raw = history?.[e.entity] || [];
        const historyFirst = raw.length ? toMs(raw[0].lc ?? raw[0].lu ?? raw[0].last_changed) : Infinity;
        return mergeSeries({ history: historyToPoints(raw), statistics: statisticsToPoints(stats?.[statIds[i]], historyFirst, period), start });
      });
      const raw = this._config.entities.map((e) => (history?.[e.entity] || []).map((x) => x.s));
      this._data = { series, raw, start, now };
      this._error = null;
    } catch (err) {
      if (id !== this._fetchId) return;
      this._error = err?.message || String(err);
    }
    this._loading = false;
    this._render();
  }

  _selectRange(key) {
    const r = this._config.ranges.find((x) => x.key === key);
    if (!r || r === this._range) return;
    this._range = r;
    try { globalThis.localStorage?.setItem(this._storageKey, r.key); } catch (_) { /* ignore */ }
    this._renderButtons();
    this._load();
  }

  // ------------------------------------------------------------ formatting

  _decimals(i = 0) {
    const e = this._config.entities[i];
    const d = e.decimals ?? this._config.decimals;
    if (d != null) return Number(d);
    // Auto: as many decimals as the entity itself reports (1 to 2); statistics means are ignored.
    const raw = [this._hass?.states[e.entity]?.state, ...(this._data?.raw[i] || [])];
    const max = Math.max(1, ...raw.map((v) => (/^-?\d+\.(\d+)$/.exec(String(v ?? "")) || [, ""])[1].length));
    return Math.min(max, 2);
  }
  _fmt(v, i = 0, sign = false) {
    const d = this._decimals(i);
    const s = new Intl.NumberFormat(this._locale, { minimumFractionDigits: d, maximumFractionDigits: d, signDisplay: sign ? "exceptZero" : "auto" }).format(v);
    return s.replace("-", "\u2212");
  }
  _unit(i = 0) {
    const e = this._config.entities[i];
    return e.unit ?? this._config.unit ?? this._hass?.states[e.entity]?.attributes?.unit_of_measurement ?? "";
  }
  _name(i = 0) {
    const e = this._config.entities[i];
    return e.name ?? this._hass?.states[e.entity]?.attributes?.friendly_name ?? e.entity;
  }
  _date(t, opts) { return new Intl.DateTimeFormat(this._locale, opts).format(new Date(t)); }
  _dateTime(t, dateOnly = false) {
    const time = dateOnly ? {} : { hour: "2-digit", minute: "2-digit" };
    return this._date(t, { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric", ...time });
  }
  _withUnit(text, i) { const u = this._unit(i); return u ? `${text}\u00a0${u}` : text; }

  // ------------------------------------------------------------ rendering

  _build() {
    if (this._built) return;
    this._built = true;
    this.shadowRoot.innerHTML = `
      <style>${STYLE}</style>
      <ha-card>
        <div class="head">
          <div class="title"></div>
          <div class="value"></div>
          <div class="sub"><span class="change"></span><span class="updated"></span></div>
        </div>
        <div class="chart" style="height:${Number(this._config.height) || 200}px">
          <div class="svg"></div>
          <div class="status"></div>
          <div class="tip" hidden></div>
        </div>
        <div class="ranges" role="group"></div>
      </ha-card>`;
    const chart = this.shadowRoot.querySelector(".chart");
    this._ro?.observe(chart);
    chart.addEventListener("pointerdown", (ev) => this._scrub(ev));
    chart.addEventListener("pointermove", (ev) => this._scrub(ev));
    chart.addEventListener("pointerleave", (ev) => { if (ev.pointerType === "mouse") this._hideTip(); });
    chart.addEventListener("pointerup", (ev) => { if (ev.pointerType !== "mouse") this._hideTip(2500); });
    chart.addEventListener("pointercancel", () => this._hideTip());
    this.shadowRoot.querySelector(".ranges").addEventListener("click", (ev) => {
      const b = ev.target.closest("button");
      if (b) this._selectRange(b.dataset.range);
    });
    this._renderButtons();
  }

  _render() {
    this._build();
    this._renderHeader();
    this._renderChart();
    this._renderStatus();
  }

  _renderButtons() {
    const box = this.shadowRoot.querySelector(".ranges");
    if (!box) return;
    box.innerHTML = this._config.ranges.map((r) => `<button type="button" data-range="${esc(r.key)}" aria-pressed="${r === this._range}">${esc(rangeLabel(r, this._strings))}</button>`).join("");
  }

  _renderHeader() {
    const root = this.shadowRoot;
    if (!this._built) return;
    const S = this._strings;
    const cfg = this._config;
    root.querySelector(".title").textContent = cfg.title ?? this._name(0);
    root.querySelector(".title").hidden = cfg.title === "";
    const st = this._hass?.states[cfg.entities[0].entity];
    const pts = this._data?.series[0] || [];
    let cur = Number.parseFloat(st?.state);
    if (!Number.isFinite(cur)) cur = pts.length ? pts[pts.length - 1].v : NaN;
    root.querySelector(".value").textContent = Number.isFinite(cur) ? this._withUnit(this._fmt(cur), 0) : (st ? "–" : S.noEntity);

    const change = root.querySelector(".change");
    change.className = "change";
    change.textContent = "";
    if (pts.length && Number.isFinite(cur) && this._data) {
      const [x0] = xDomain(this._data.series, this._data.start, this._data.now);
      const daily = cfg.change_basis === "daily_mean";
      const ch = computeChange(pts, x0, cur, cfg.change_basis);
      const shortDate = (t) => this._date(t, { day: "2-digit", month: "2-digit", ...(new Date(t).getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
      const clipped = x0 > this._data.start + 60e3;
      const since = daily || clipped || this._range.unit === "all" ? shortDate(ch?.since ?? x0) : rangeLabel(this._range, S);
      if (ch && ch.diff != null) {
        change.textContent = `${daily ? `${S.mean} ` : ""}${this._withUnit(this._fmt(ch.diff, 0, true), 0)} ${S.since} ${since}`;
        const dir = cfg.good_direction;
        const shown = Math.round(Math.abs(ch.diff) * 10 ** this._decimals(0)); // no colour for a change that displays as 0
        if (shown !== 0 && (dir === "up" || dir === "down")) change.classList.add((ch.diff > 0) === (dir === "up") ? "good" : "bad");
      } else if (ch) {
        change.textContent = `${S.dailyMean} ${this._withUnit(this._fmt(ch.mean, 0), 0)} · ${S.oneDay}`;
      }
      change.title = daily ? S.meanHint : "";
    }
    const last = pts.length ? pts[pts.length - 1] : null;
    root.querySelector(".updated").textContent = cfg.show_updated && last && !last.carried
      ? `${S.updated} ${this._date(last.t, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}` : "";
  }

  _renderStatus() {
    const el = this.shadowRoot.querySelector(".status");
    if (!el) return;
    const S = this._strings;
    const empty = this._data && this._data.series.every((s) => !s.length);
    let text = "";
    if (this._error) text = `${S.error}: ${this._error}`;
    else if (!this._data && this._loading) text = S.loading;
    else if (empty) text = `${S.noData} ${this._config.entities.map((_, i) => this._name(i)).join(", ")}`;
    el.textContent = text;
    el.hidden = !text;
    this.shadowRoot.querySelector(".chart").classList.toggle("busy", this._loading && !!this._data);
  }

  _renderChart() {
    const host = this.shadowRoot.querySelector(".svg");
    if (!host || !this._data) return;
    const W = this._width || this.shadowRoot.querySelector(".chart").clientWidth || 300;
    const H = Number(this._config.height) || 200;
    const { series, start, now } = this._data;
    if (series.every((s) => !s.length)) { host.innerHTML = ""; this._geo = null; return; }

    const [x0, x1] = xDomain(series, start, now);
    const visible = series.flatMap((s) => [valueAt(s, x0), ...s.filter((p) => p.t >= x0).map((p) => p.v)]).filter((v) => v != null);
    const [y0, y1] = yDomain(visible, this._config.min, this._config.max);
    const { ticks: yt, step } = niceTicks(y0, y1, Math.max(2, Math.floor(H / 40)));
    const td = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
    const yLabels = yt.map((v) => new Intl.NumberFormat(this._locale, { minimumFractionDigits: td, maximumFractionDigits: td }).format(v).replace("-", "\u2212"));
    const axisW = Math.max(28, ...yLabels.map((l) => l.length * 7 + 8));
    const pad = { l: 8, r: axisW + 4, t: 10, b: 24 };
    const pw = Math.max(10, W - pad.l - pad.r);
    const ph = Math.max(10, H - pad.t - pad.b);
    const X = (t) => pad.l + ((t - x0) / (x1 - x0)) * pw;
    const Y = (v) => pad.t + (1 - (v - y0) / (y1 - y0)) * ph;
    this._geo = { X, Y, x0, x1, pad, pw };

    let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">`;
    svg += `<defs><clipPath id="clip"><rect x="${pad.l - 6}" y="${pad.t - 6}" width="${pw + 12}" height="${ph + 12}"/></clipPath>`;
    series.forEach((_, i) => {
      svg += `<linearGradient id="fill${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${this._config.entities[i].color}" stop-opacity=".28"/><stop offset="1" stop-color="${this._config.entities[i].color}" stop-opacity="0"/></linearGradient>`;
    });
    svg += `</defs>`;
    yt.forEach((v, i) => {
      svg += `<line class="grid" x1="${pad.l}" x2="${pad.l + pw}" y1="${Y(v)}" y2="${Y(v)}"/>`;
      svg += `<text class="axis" x="${W - 4}" y="${Y(v) + 4}" text-anchor="end">${esc(yLabels[i])}</text>`;
    });
    const { ticks: xt, unit } = timeTicks(x0, x1, Math.max(2, Math.floor(pw / 56)));
    const xfmt = unit === "h" ? { hour: "2-digit", minute: "2-digit" } : unit === "d" ? { day: "2-digit", month: "2-digit" } : { month: "short" };
    xt.forEach((t) => {
      const d = new Date(t);
      const label = unit === "M" && d.getMonth() === 0 ? String(d.getFullYear())
        : unit === "h" && d.getHours() === 0 ? this._date(t, { day: "2-digit", month: "2-digit" }) : this._date(t, xfmt);
      const x = X(t);
      svg += `<line class="tick" x1="${x}" x2="${x}" y1="${pad.t + ph}" y2="${pad.t + ph + 4}"/>`;
      const anchor = x < pad.l + 20 ? "start" : x > pad.l + pw - 20 ? "end" : "middle";
      svg += `<text class="axis" x="${x}" y="${H - 6}" text-anchor="${anchor}">${esc(label)}</text>`;
    });

    const single = series.filter((s) => s.length).length === 1;
    svg += `<g clip-path="url(#clip)">`;
    series.forEach((pts, i) => {
      if (!pts.length) return;
      const color = this._config.entities[i].color;
      const startV = valueAt(pts, x0);
      const vis = pts.filter((p) => p.t > x0);
      let d = startV != null ? `M${X(x0)},${Y(startV)}` : `M${X(vis[0].t)},${Y(vis[0].v)}`;
      for (const p of startV != null ? vis : vis.slice(1)) d += `H${X(p.t)}V${Y(p.v)}`;
      d += `H${X(x1)}`;
      if (single) {
        const firstX = startV != null ? X(x0) : X(vis[0].t);
        svg += `<path d="${d}V${pad.t + ph}H${firstX}Z" fill="url(#fill${i})" stroke="none"/>`;
      }
      const trend = this._config.trend_line === "daily_mean";
      svg += `<g class="${trend ? "raw" : ""}"><path class="line" d="${d}" stroke="${color}"/>`;
      const dots = pts.filter((p) => !p.carried && p.t >= x0);
      const show = this._config.show_points === true || (this._config.show_points === "auto" && dots.length <= Math.max(20, pw / 8));
      if (show) dots.forEach((p) => { svg += `<circle class="dot" cx="${X(p.t)}" cy="${Y(p.v)}" r="${trend ? 2.5 : 3}" stroke="${color}"/>`; });
      if (dots.length && !trend) { const p = dots[dots.length - 1]; svg += `<circle cx="${X(p.t)}" cy="${Y(p.v)}" r="4.5" fill="${color}"/>`; }
      svg += `</g>`;
      if (trend) {
        const days = dailyMeans(pts, x0);
        if (days.length > 1) svg += `<polyline class="trend" points="${days.map((m) => `${X(m.t)},${Y(m.v)}`).join(" ")}" stroke="${color}"/>`;
        const showDays = days.length <= Math.max(20, pw / 10);
        days.forEach((m, k) => {
          if (showDays || k === days.length - 1) svg += `<circle class="tdot" cx="${X(m.t)}" cy="${Y(m.v)}" r="${k === days.length - 1 ? 5 : 4}" fill="${color}"/>`;
        });
      }
    });
    svg += `</g><g class="cross" visibility="hidden"><line class="crossline" y1="${pad.t}" y2="${pad.t + ph}"/><circle class="crossdot" r="6"/></g></svg>`;
    host.innerHTML = svg;
  }

  _scrub(ev) {
    if (!this._geo || !this._data) return;
    const rect = this.shadowRoot.querySelector(".chart").getBoundingClientRect();
    const px = ev.clientX - rect.left;
    const { X, Y, x0 } = this._geo;
    let best = null;
    this._data.series.forEach((pts, i) => pts.forEach((p) => {
      const t = Math.max(p.t, x0);
      const dx = Math.abs(X(t) - px);
      if (!best || dx < best.dx) best = { dx, p, i, t };
    }));
    if (!best) return;
    clearTimeout(this._tipTimer);
    const cx = X(best.t);
    const cy = Y(best.p.v);
    const cross = this.shadowRoot.querySelector(".cross");
    cross.setAttribute("visibility", "visible");
    cross.querySelector(".crossline").setAttribute("x1", cx);
    cross.querySelector(".crossline").setAttribute("x2", cx);
    const dot = cross.querySelector(".crossdot");
    dot.setAttribute("cx", cx); dot.setAttribute("cy", cy); dot.setAttribute("stroke", this._config.entities[best.i].color);
    const tip = this.shadowRoot.querySelector(".tip");
    const multi = this._data.series.length > 1;
    let mean = "";
    if (this._config.trend_line === "daily_mean" && !best.p.carried) {
      const day = dailyMeans(this._data.series[best.i], x0).find((m) => m.day === dayKey(best.p.t));
      if (day) mean = `<br><span class="mean">${esc(`${this._strings.dailyMean} ${this._withUnit(this._fmt(day.v, best.i), best.i)}${day.n > 1 ? ` (${day.n}×)` : ""}`)}</span>`;
    }
    tip.innerHTML = `<b>${esc(this._withUnit(this._fmt(best.p.v, best.i), best.i))}</b>${multi ? ` <span>${esc(this._name(best.i))}</span>` : ""}<br>${esc(best.p.carried ? `≤ ${this._dateTime(best.t)}` : this._dateTime(best.p.t, best.p.stat === "day"))}${mean}`;
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.min(Math.max(cx - tw / 2, 0), rect.width - tw)}px`;
    tip.style.top = `${cy > 70 ? Math.max(0, cy - 58) : cy + 14}px`;
  }

  _hideTip(delay = 0) {
    clearTimeout(this._tipTimer);
    this._tipTimer = setTimeout(() => {
      const tip = this.shadowRoot.querySelector(".tip");
      if (tip) tip.hidden = true;
      this.shadowRoot.querySelector(".cross")?.setAttribute("visibility", "hidden");
    }, delay);
  }
}

const STYLE = `
  :host { display: block; }
  ha-card { overflow: hidden; padding: 14px 0 10px; }
  .head { padding: 0 16px 6px; }
  .title { color: var(--secondary-text-color); font-size: 14px; line-height: 20px; }
  .value { color: var(--primary-text-color); font-size: 28px; font-weight: 500; line-height: 36px; font-variant-numeric: tabular-nums; }
  .sub { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; color: var(--secondary-text-color); line-height: 18px; min-height: 18px; }
  .change { font-weight: 500; color: var(--primary-text-color); }
  .change.good { color: var(--success-color, #43a047); }
  .change.bad { color: var(--error-color, #db4437); }
  .updated { white-space: nowrap; }
  .chart { position: relative; touch-action: pan-y; user-select: none; -webkit-user-select: none; -webkit-tap-highlight-color: transparent; }
  .chart.busy .svg { opacity: .45; transition: opacity .2s; }
  .svg svg { display: block; overflow: visible; }
  .grid { stroke: var(--divider-color, rgba(127,127,127,.2)); stroke-width: 1; stroke-dasharray: 3 4; }
  .tick { stroke: var(--divider-color, rgba(127,127,127,.3)); }
  .axis { fill: var(--secondary-text-color); font-size: 11px; font-family: inherit; font-variant-numeric: tabular-nums; }
  .line { fill: none; stroke-width: 2.2; stroke-linejoin: round; stroke-linecap: round; }
  .raw .line { stroke-width: 1.4; opacity: .45; }
  .raw .dot { opacity: .55; }
  .trend { fill: none; stroke-width: 3; stroke-linejoin: round; stroke-linecap: round; }
  .tdot { stroke: var(--card-background-color, var(--ha-card-background, #fff)); stroke-width: 1.5; }
  .tip .mean { opacity: .85; }
  .dot { fill: var(--card-background-color, var(--ha-card-background, #fff)); stroke-width: 2; }
  .crossline { stroke: var(--secondary-text-color); stroke-width: 1; stroke-dasharray: 2 3; }
  .crossdot { fill: var(--card-background-color, var(--ha-card-background, #fff)); stroke-width: 3; }
  .status { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; text-align: center; padding: 0 24px; color: var(--secondary-text-color); font-size: 14px; }
  .status[hidden], .tip[hidden] { display: none; }
  .tip { position: absolute; pointer-events: none; white-space: nowrap; background: var(--primary-text-color); color: var(--card-background-color, var(--ha-card-background, #fff)); border-radius: 8px; padding: 5px 9px; font-size: 12px; line-height: 17px; box-shadow: 0 2px 6px rgba(0,0,0,.25); }
  .tip b { font-size: 13px; }
  .ranges { display: flex; gap: 4px; padding: 8px 12px 0; }
  .ranges button { flex: 1; min-height: 34px; border: none; border-radius: 17px; background: transparent; color: var(--secondary-text-color); font: inherit; font-size: 13px; font-weight: 500; cursor: pointer; padding: 0 4px; }
  .ranges button:hover { background: var(--secondary-background-color, rgba(127,127,127,.12)); }
  .ranges button[aria-pressed="true"] { background: rgba(var(--rgb-primary-color, 3,169,244), .16); color: var(--primary-color); }
  .ranges button:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 1px; }
`;

if (globalThis.customElements && !customElements.get("range-graph-card")) {
  customElements.define("range-graph-card", RangeGraphCard);
  (window.customCards = window.customCards || []).push({
    type: "range-graph-card",
    name: "Range Graph Card",
    description: "Step chart of an entity's history with stock-style range buttons (1W, 1M, 3M, 6M, 1Y, All).",
    preview: true,
    documentationURL: "https://github.com/LuFuhrmann/range-graph-card",
  });
  console.info(`%c RANGE-GRAPH-CARD %c ${VERSION} `, "color:#fff;background:#03a9f4;font-weight:700", "color:#03a9f4");
}
