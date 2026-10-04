// Validates a scored scan and writes scan.json, history.json and OSINT assessments.
// Used by the keyword-rule scan (rule-scan.mjs), the optional Claude routine (apply-scan.mjs)
// and the optional API scan (refresh.mjs).
import { readFile, writeFile } from "node:fs/promises";
import { CONF, ECONOMIES, INDUSTRIES, THEMES, fail } from "./shared.mjs";

export const SCAN_PATH = new URL("../public/data/scan.json", import.meta.url);
export const HISTORY_PATH = new URL("../public/data/history.json", import.meta.url);
export const OSINT_PATH = new URL("../public/data/osint.json", import.meta.url);

const COMPANY_HINT = /\b(Inc|Corp|Corporation|Ltd|LLC|plc|PLC|Holdings)\b/;
const clampScore = (v) => Math.max(-3, Math.min(3, Math.round(Number(v) || 0)));
export function impacts(arr, known) {
  const out = [];
  for (const x of arr ?? []) {
    if (!x || !known[x.id] || out.some((y) => y.id === x.id)) continue;
    const score = clampScore(x.score);
    if (score) out.push({ id: x.id, score, why: String(x.why ?? "").slice(0, 140) });
  }
  return out;
}

// items: [{ id, date, theme, headline, summary, rationale, horizon, confidence, industries, economies, sources: [url] }]
export function normalizeItems(rawItems) {
  const today = new Date().toISOString().slice(0, 10);
  return (rawItems ?? [])
    .map((it, i) => ({
      id: String(it.id || `s${i}`).toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 40) || `s${i}`,
      date: /^\d{4}-\d{2}-\d{2}$/.test(it.date) ? it.date : today,
      theme: THEMES.includes(it.theme) ? it.theme : "Growth data",
      headline: String(it.headline ?? "").slice(0, 200),
      summary: String(it.summary ?? "").slice(0, 600),
      rationale: String(it.rationale ?? "").slice(0, 600),
      horizon: ["days", "weeks", "months"].includes(it.horizon) ? it.horizon : "weeks",
      confidence: CONF[it.confidence] ? it.confidence : "medium",
      industries: impacts(it.industries, INDUSTRIES),
      economies: impacts(it.economies, ECONOMIES),
      sources: [...new Set((it.sources ?? []).filter((u) => typeof u === "string" && /^https:\/\//.test(u)))].slice(0, 3),
    }))
    .filter((it) => it.headline && (it.industries.length || it.economies.length));
}

export async function writeScan({ items, model, headlinesScanned = null, feedsOk = null, signals = [] }) {
  if (items.length < 6) fail(`Only ${items.length} usable stories; keeping the previous scan.`);
  const flagged = items.filter((it) => COMPANY_HINT.test(`${it.headline} ${it.summary} ${it.rationale}`));
  if (flagged.length) console.warn(`Check for company names in: ${flagged.map((i) => i.id).join(", ")}`);

  const dates = items.map((i) => i.date).sort();
  const fmt = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const scan = {
    scannedAt: new Date().toISOString(),
    window: dates[0] === dates.at(-1) ? fmt(dates[0]) : `${fmt(dates[0]).replace(/ \d{4}$/, "")} – ${fmt(dates.at(-1))}`,
    model,
    headlinesScanned,
    feedsOk,
    items,
  };
  await writeFile(SCAN_PATH, JSON.stringify(scan, null, 1) + "\n");

  const net = (key, ids) => {
    const t = Object.fromEntries(Object.keys(ids).map((k) => [k, 0]));
    for (const it of items) for (const s of it[key]) t[s.id] += s.score * CONF[it.confidence];
    for (const k in t) t[k] = Math.round(t[k] * 10) / 10;
    return t;
  };
  let history = [];
  try { history = JSON.parse(await readFile(HISTORY_PATH, "utf8")); } catch {}
  // One point per day: a later scan the same UTC day (e.g. Claude after the keyword rules) replaces it.
  if (history.at(-1)?.at?.slice(0, 10) === scan.scannedAt.slice(0, 10)) history.pop();
  history.push({ at: scan.scannedAt, ind: net("industries", INDUSTRIES), eco: net("economies", ECONOMIES) });
  await writeFile(HISTORY_PATH, JSON.stringify(history.slice(-24 * 14)) + "\n");

  // signals: [{ ref (1-based index into osint.json signals) or id, headline, risk, note, industries, economies }]
  let assessed = 0;
  let osint = null;
  try { osint = JSON.parse(await readFile(OSINT_PATH, "utf8")); } catch {}
  if (osint && signals.length) {
    for (const a of signals) {
      const sig = a.id ? osint.signals.find((s) => s.id === a.id) : osint.signals[Number(a.ref) - 1];
      if (!sig) continue;
      sig.assessment = {
        headline: String(a.headline ?? "").slice(0, 160),
        risk: ["watch", "elevated", "high"].includes(a.risk) ? a.risk : sig.severity,
        note: String(a.note ?? "").slice(0, 300),
        industries: impacts(a.industries, INDUSTRIES),
        economies: impacts(a.economies, ECONOMIES),
        at: scan.scannedAt,
      };
      assessed++;
    }
    osint.assessedAt = scan.scannedAt;
    await writeFile(OSINT_PATH, JSON.stringify(osint, null, 1) + "\n");
  }
  console.log(`Wrote ${items.length} stories; assessed ${assessed} intelligence signals.`);
  return scan;
}
