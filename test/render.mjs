// Headless render + interaction test with a mocked `hass`. Writes phone-sized screenshots.
// Usage: TZ=Europe/Berlin node test/render.mjs            (public demo data)
//        TZ=Europe/Berlin node test/render.mjs live.json  (private fixture, screenshots "vorschau-*")
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { demoFixture } from "./demo-data.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureArg = process.argv[2];
const fixture = fixtureArg ? JSON.parse(readFileSync(resolve(root, "test/fixtures", fixtureArg), "utf8")) : demoFixture();
const prefix = fixtureArg ? "vorschau" : "demo";
const outDir = resolve(root, "screenshots");
mkdirSync(outDir, { recursive: true });
const CHROME = process.env.CHROME_PATH || ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(existsSync);

const THEMES = {
  hell: {
    "--primary-color": "#03a9f4", "--rgb-primary-color": "3, 169, 244", "--accent-color": "#ff9800", "--primary-text-color": "#212121",
    "--secondary-text-color": "#727272", "--card-background-color": "#ffffff", "--primary-background-color": "#fafafa",
    "--secondary-background-color": "#e5e5e5", "--divider-color": "rgba(0,0,0,.12)", "--error-color": "#db4437", "--success-color": "#43a047",
  },
  dunkel: {
    "--primary-color": "#03a9f4", "--rgb-primary-color": "3, 169, 244", "--accent-color": "#ff9800", "--primary-text-color": "#e1e1e1",
    "--secondary-text-color": "#9b9b9b", "--card-background-color": "#1c1c1c", "--primary-background-color": "#111111",
    "--secondary-background-color": "#282828", "--divider-color": "rgba(225,225,225,.12)", "--error-color": "#ef5350", "--success-color": "#66bb6a",
  },
};

const pageHtml = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{margin:0;padding:12px;font-family:Roboto,"Noto Sans",Arial,sans-serif;background:var(--primary-background-color);color:var(--primary-text-color);-webkit-font-smoothing:antialiased}
#host>*{margin-bottom:12px}</style>
<script>
  class HaCard extends HTMLElement{constructor(){super();this.attachShadow({mode:"open"}).innerHTML='<style>:host{display:block;background:var(--card-background-color);border-radius:12px;border:1px solid var(--divider-color);color:var(--primary-text-color)}</style><slot></slot>'}}
  customElements.define("ha-card",HaCard);
</script>
<script type="module" src="/range-graph-card.js"></script></head><body><div id="host"></div></body></html>`;

const server = createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/") { res.setHeader("content-type", "text/html"); return res.end(pageHtml); }
  if (url === "/range-graph-card.js") { res.setHeader("content-type", "text/javascript"); return res.end(readFileSync(resolve(root, "range-graph-card.js"))); }
  res.statusCode = url === "/favicon.ico" ? 204 : 404; res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
const results = [];
const check = (name, ok, info = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${info ? " – " + info : ""}`); };

// Mock of the two websocket commands, mimicking Home Assistant's behaviour.
function mockSource() {
  return `
  window.__calls = [];
  window.__mock = (fixture) => ({
    language: fixture.language, locale: { language: fixture.language },
    states: fixture.states,
    callWS: async (msg) => {
      window.__calls.push(msg);
      await new Promise((r) => setTimeout(r, 30));
      const start = Date.parse(msg.start_time), end = Date.parse(msg.end_time);
      if (msg.type === "history/history_during_period") {
        const out = {};
        for (const id of msg.entity_ids) {
          const list = fixture.history[id] || [];
          const before = list.filter((e) => e.lu * 1000 < start).at(-1);
          const inside = list.filter((e) => e.lu * 1000 >= start && e.lu * 1000 <= end);
          const rows = before ? [{ s: before.s, lu: start / 1000 }, ...inside] : inside;
          if (rows.length) out[id] = rows;
        }
        return out;
      }
      if (msg.type === "recorder/get_statistics_metadata") {
        return (fixture.meta || []).filter((m) => msg.statistic_ids.includes(m.statistic_id));
      }
      if (msg.type === "recorder/statistics_during_period") {
        // Aggregate hourly rows like the recorder: buckets per period, local time, weeks start on Monday.
        const bucket = (t) => {
          const d = new Date(t);
          if (msg.period === "hour") { d.setMinutes(0, 0, 0); return [d.getTime(), d.getTime() + 3600e3]; }
          d.setHours(0, 0, 0, 0);
          if (msg.period === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
          if (msg.period === "month") d.setDate(1);
          const e = new Date(d);
          if (msg.period === "day") e.setDate(e.getDate() + 1);
          if (msg.period === "week") e.setDate(e.getDate() + 7);
          if (msg.period === "month") e.setMonth(e.getMonth() + 1);
          return [d.getTime(), e.getTime()];
        };
        const out = {};
        for (const id of msg.statistic_ids) {
          const groups = new Map();
          for (const r of fixture.statistics[id] || []) {
            const [s0, e0] = bucket(r.start);
            if (e0 <= start || s0 >= end) continue;
            (groups.get(s0) || groups.set(s0, { start: s0, end: e0, vals: [], maxs: [] }).get(s0)).vals.push(r.mean);
          }
          const rows = [...groups.values()].sort((a, b) => a.start - b.start).map((g) => ({
            start: g.start, end: g.end, mean: g.vals.reduce((a, b) => a + b, 0) / g.vals.length,
            min: Math.min(...g.vals), max: Math.max(...g.vals), state: g.vals.at(-1),
          }));
          if (rows.length) out[id] = rows;
        }
        return out;
      }
      throw new Error("unknown command " + msg.type);
    },
  });`;
}

async function setup(theme, cards) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, timezoneId: "Europe/Berlin", locale: "de-DE", colorScheme: theme === "dunkel" ? "dark" : "light", hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(base);
  await page.waitForFunction(() => customElements.get("range-graph-card"));
  await page.addScriptTag({ content: mockSource() });
  await page.evaluate(({ vars, fixture, cards }) => {
    for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty(k, v);
    window.__hass = window.__mock(fixture);
    for (const cfg of cards) {
      const el = document.createElement("range-graph-card");
      el.setConfig(cfg);
      document.getElementById("host").appendChild(el);
      el.hass = window.__hass;
    }
  }, { vars: THEMES[theme], fixture, cards });
  await page.waitForTimeout(400);
  return { page, ctx, errors };
}

const card = (page, i = 0) => page.locator("range-graph-card").nth(i);
const text = (page, sel, i = 0) => card(page, i).locator(sel).first().textContent();

async function scrub(page, i, frac) {
  const box = await card(page, i).locator(".chart").boundingBox();
  await page.mouse.move(box.x + box.width * frac, box.y + box.height / 2);
  await page.waitForTimeout(100);
}

if (prefix === "vorschau") {
  // Private fixture: real data plus the card configs to render (fixture.cards).
  const snippetCards = (fixture.cards || []).map((c) => ({ type: "custom:range-graph-card", ...c }));
  for (const theme of ["hell", "dunkel"]) {
    const { page, ctx, errors } = await setup(theme, snippetCards);
    await page.screenshot({ path: `${outDir}/${prefix}-${theme}-1-drei-karten.png`, fullPage: true });
    await scrub(page, 0, 0.55);
    await card(page, 0).screenshot({ path: `${outDir}/${prefix}-${theme}-2-tooltip.png` });
    check(`${theme}: first card shows a daily-mean change`, /^Ø [−+]/.test(await text(page, ".change")), await text(page, ".change"));
    check(`${theme}: trend line`, (await card(page, 0).locator("polyline.trend").count()) === 1);
    check(`${theme}: last card neutral`, (await card(page, snippetCards.length - 1).locator(".change.good, .change.bad").count()) === 0);
    check(`${theme}: German tooltip`, /kg[\s\S]*\d{2}\.\d{2}\.\d{4}/.test(await text(page, ".tip")), await text(page, ".tip"));
    check(`${theme}: no errors`, errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
  // Ranges on the first card: the x axis must start at the first measurement for long ranges.
  const { page, ctx } = await setup("dunkel", [snippetCards[0]]);
  for (const r of ["1w", "3m", "all"]) {
    await card(page).locator(`button[data-range="${r}"]`).click();
    await page.waitForTimeout(300);
    await card(page).screenshot({ path: `${outDir}/${prefix}-dunkel-3-zeitraum-${r}.png` });
    check(`range ${r}: change`, /seit/.test(await text(page, ".change")), await text(page, ".change"));
  }
  await ctx.close();
} else {
  const demo = [
    { type: "custom:range-graph-card", entity: "sensor.weight", title: "Weight", default_range: "3m", good_direction: "down", change_basis: "daily_mean", trend_line: "daily_mean" },
    { type: "custom:range-graph-card", entity: "sensor.bmi", title: "BMI", default_range: "3m", decimals: 1 },
  ];
  for (const theme of ["hell", "dunkel"]) {
    const { page, ctx, errors } = await setup(theme, demo);
    await page.evaluate(() => localStorage.clear());
    await page.screenshot({ path: `${outDir}/${prefix}-${theme}-1-uebersicht.png`, fullPage: true });
    await scrub(page, 0, 0.7);
    await card(page, 0).screenshot({ path: `${outDir}/${prefix}-${theme}-2-tooltip.png` });
    check(`${theme}: trend line + daily mean in tooltip`, (await card(page, 0).locator("polyline.trend").count()) === 1 && /Tagesmittel/.test(await text(page, ".tip")), await text(page, ".tip"));
    check(`${theme}: daily-mean change`, /^Ø [−+]/.test(await text(page, ".change")), await text(page, ".change"));
    check(`${theme}: no errors`, errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
  {
    // Range buttons, statistics merge, localStorage, live reload.
    const { page, ctx, errors } = await setup("hell", [demo[0]]);
    const xFirstTick = async () => card(page).locator("text.axis[text-anchor=middle]").first().textContent();
    for (const r of ["1w", "1m", "6m", "all"]) {
      await card(page).locator(`button[data-range="${r}"]`).click();
      await page.waitForTimeout(250);
      await card(page).screenshot({ path: `${outDir}/${prefix}-hell-3-zeitraum-${r}.png` });
      check(`range ${r}: pressed + change`, (await card(page).locator('button[aria-pressed="true"]').getAttribute("data-range")) === r && /seit/.test(await text(page, ".change")), `${await text(page, ".change")} | first tick ${await xFirstTick()}`);
    }
    const dots = await card(page).locator("circle.dot").count();
    check("all: statistics fill the purged history (many points)", dots > 20 || (await card(page).locator("path.line").getAttribute("d")).length > 2000, `dots=${dots}`);
    const stored = await page.evaluate(() => Object.entries(localStorage));
    check("range stored per card in localStorage", JSON.stringify(stored).includes('"all"'), JSON.stringify(stored));
    const before = await page.evaluate(() => window.__calls.length);
    await page.evaluate(() => {
      const h = window.__hass;
      const st = { ...h.states["sensor.weight"], state: "77.1", last_changed: new Date().toISOString() };
      const fx = { ...h, states: { ...h.states, "sensor.weight": st } };
      document.querySelector("range-graph-card").hass = fx;
    });
    await page.waitForTimeout(1500);
    const after = await page.evaluate(() => window.__calls.length);
    check("state change triggers reload", after > before && (await text(page, ".value")).includes("77,1"), `${before}->${after} ${await text(page, ".value")}`);
    check("no errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
  {
    // Remembered range on a fresh card, touch scrub, empty card, multi entity, single point.
    const ctx0 = await setup("dunkel", []);
    await ctx0.page.evaluate(() => localStorage.setItem("range-graph-card:sensor.weight|Weight", "6m"));
    await ctx0.page.evaluate(() => {
      const el = document.createElement("range-graph-card");
      el.setConfig({ entity: "sensor.weight", title: "Weight" });
      document.getElementById("host").appendChild(el);
      el.hass = window.__hass;
    });
    await ctx0.page.waitForTimeout(300);
    check("remembered range restored", (await card(ctx0.page).locator('button[aria-pressed="true"]').getAttribute("data-range")) === "6m");
    const box = await card(ctx0.page).locator(".chart").boundingBox();
    await ctx0.page.touchscreen.tap(box.x + box.width * 0.3, box.y + box.height / 2);
    await ctx0.page.waitForTimeout(100);
    check("touch shows tooltip", await card(ctx0.page).locator(".tip").isVisible());
    await ctx0.ctx.close();

    const fx1 = structuredClone(fixture);
    fx1.history["sensor.single"] = [{ s: "71.4", lu: (Date.now() - 2 * 864e5) / 1000 }];
    fx1.states["sensor.single"] = { entity_id: "sensor.single", state: "71.4", last_changed: new Date(Date.now() - 2 * 864e5).toISOString(), attributes: { friendly_name: "Single", unit_of_measurement: "kg" } };
    const { page, ctx, errors } = await (async () => { const f = fixture; Object.assign(fixture, fx1); return setup("dunkel", [
      { entity: "sensor.empty", title: "Body fat (no data)" },
      { entity: "sensor.single", title: "Only one measurement", default_range: "3m" },
      { entities: [{ entity: "sensor.weight", name: "Official" }, { entity: "sensor.scale_raw", name: "Raw" }], title: "Official vs. raw", default_range: "1m" },
    ]); })();
    await page.screenshot({ path: `${outDir}/${prefix}-dunkel-4-sonderfaelle.png`, fullPage: true });
    check("empty hint", /Noch keine Messwerte/.test(await card(page, 0).locator(".status").textContent()));
    check("single point drawn", (await card(page, 1).locator("circle").count()) >= 1);
    check("two series", (await card(page, 2).locator("path.line").count()) === 2);
    check("no errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
  {
    // v1.1: statistics-only series, target line and band, bar chart, empty link.
    const cards11 = [
      { entity: undefined, statistic_id: "demo:treadmill_min", title: "Treadmill duration", period: "day", stat_type: "max", target: "input_number.treadmill_goal", good_direction: "up", decimals: 0, ranges: ["1m", "3m", "6m", "all"], default_range: "3m" },
      { statistic_id: "demo:treadmill_kmh", title: "Treadmill speed", period: "day", target_band: [9, 10], decimals: 1, ranges: ["1m", "3m", "6m", "all"], default_range: "3m" },
      { statistic_id: "demo:training_days", title: "Training days per week", chart_type: "bar", period: "week", target: 3, good_direction: "up", show_change: false, decimals: 0, ranges: ["3m", "6m", "1y", "all"], default_range: "6m" },
    ];
    for (const theme of ["hell", "dunkel"]) {
      const { page, ctx, errors } = await setup(theme, cards11);
      await page.screenshot({ path: `${outDir}/${prefix}-${theme}-5-ziele-balken.png`, fullPage: true });
      check(`${theme}: target line labelled`, /Ziel 15 min/.test(await card(page, 0).locator(".target-label").first().textContent()));
      check(`${theme}: target band labelled`, (await card(page, 1).locator("rect.target-band").count()) === 1 && /Ziel 9–10 km\/h/.test(await card(page, 1).locator(".target-label").first().textContent()));
      const bars = await card(page, 2).locator("rect.bar").count();
      const hits = await card(page, 2).locator("rect.bar.hit").count();
      check(`${theme}: weekly bars, goal weeks highlighted`, bars >= 20 && hits > 0 && hits < bars, `${bars} bars, ${hits} hit`);
      check(`${theme}: unit and name from metadata`, /min$/.test((await text(page, ".value", 0)).trim()), await text(page, ".value", 0));
      check(`${theme}: no change line for bars`, (await text(page, ".change", 2)) === "");
      await page.mouse.move(0, 0);
      await card(page, 2).locator(".chart").scrollIntoViewIfNeeded();
      const box = await card(page, 2).locator(".chart").boundingBox();
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2); await page.waitForTimeout(100);
      check(`${theme}: bar tooltip shows the week`, /Woche ab/.test(await text(page, ".tip", 2)), await text(page, ".tip", 2));
      await card(page, 2).screenshot({ path: `${outDir}/${prefix}-${theme}-6-balken-tooltip.png` });
      check(`${theme}: no errors (v1.1)`, errors.length === 0, errors.join(" | "));
      await ctx.close();
    }
    const { page, ctx, errors } = await setup("hell", [{ entity: "sensor.empty", title: "Waist", empty_link: { text: "Enter waist", navigation_path: "/demo/values" } }]);
    await card(page).locator("button.link").click();
    await page.waitForTimeout(100);
    check("empty link navigates", (await page.evaluate(() => location.pathname)) === "/demo/values");
    check("no errors (empty link)", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
}

await browser.close();
server.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
