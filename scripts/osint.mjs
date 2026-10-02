// Open-source intelligence feed: geopolitical and economic signals from open sources
// (GDELT, UN, ReliefWeb, GDACS, USGS, crisis trackers, central banks, IMF, WTO, EIA).
// Rule-based tagging only, so it runs without an API key; the Claude scan adds assessments later.
// Writes public/data/osint.json, keeping the previous assessments for signals still in the feed.
import { readFile, writeFile } from "node:fs/promises";
import { ECONOMIES, INDUSTRIES, fail, fetchFeed, fetchText, titleKey, txt } from "./shared.mjs";

const OSINT_PATH = new URL("../public/data/osint.json", import.meta.url);
const WINDOW_HOURS = 48;
const MAX_SIGNALS = 80;

const RSS_SOURCES = [
  { name: "UN News", type: "Intergovernmental", url: "https://news.un.org/feed/subscribe/en/news/all/rss.xml" },
  { name: "ReliefWeb", type: "Humanitarian", url: "https://reliefweb.int/headlines/rss.xml" },
  { name: "GDACS", type: "Disaster alerts", url: "https://www.gdacs.org/xml/rss.xml" },
  { name: "Crisis Group", type: "Conflict tracker", url: "https://www.crisisgroup.org/rss" },
  { name: "IMF", type: "Official", url: "https://www.imf.org/en/News/RSS?language=eng" },
  { name: "Federal Reserve", type: "Central bank", url: "https://www.federalreserve.gov/feeds/press_all.xml" },
  { name: "ECB", type: "Central bank", url: "https://www.ecb.europa.eu/rss/press.html" },
  { name: "Bank of England", type: "Central bank", url: "https://www.bankofengland.co.uk/rss/news" },
  { name: "WTO", type: "Official", url: "https://www.wto.org/library/rss/latest_news_e.xml" },
  { name: "US EIA", type: "Official", url: "https://www.eia.gov/rss/todayinenergy.xml" },
];

// GDELT monitors world news media in many languages; each query is one open API call.
const GDELT_QUERIES = [
  { label: "sanctions & trade", q: '(sanctions OR embargo OR "export controls" OR tariffs OR "trade war")' },
  { label: "conflict", q: '(missile OR airstrike OR "naval blockade" OR "military escalation" OR ceasefire OR coup)' },
  { label: "chokepoints", q: '("Strait of Hormuz" OR "Red Sea" OR "Suez Canal" OR "Panama Canal" OR "Taiwan Strait" OR "Black Sea")' },
  { label: "energy supply", q: '(OPEC OR "oil supply" OR "gas supply" OR "pipeline attack" OR "refinery outage" OR "LNG")' },
];

const CATEGORIES = [
  { id: "conflict", label: "Conflict & security", weight: 3, re: /\b(war|missile|airstrike|air strike|drone strike|military|troops|attack|shelling|ceasefire|insurgen|coup|clashes|navy|naval|invasion|hostage|terror)/i, ind: ["energy", "transport", "industrials"] },
  { id: "shipping", label: "Shipping & chokepoints", weight: 3, re: /\b(strait|shipping|canal|red sea|hormuz|bab el|freight|tanker|container ship|vessel|port closure|blockade|black sea)/i, ind: ["transport", "energy", "consumer"] },
  { id: "sanctions", label: "Sanctions & trade", weight: 2, re: /\b(sanction|embargo|export control|tariff|trade war|trade deal|blacklist|asset freeze|retaliat|anti-dumping|wto)/i, ind: ["industrials", "tech", "autos", "agrifood"] },
  { id: "energy", label: "Energy supply", weight: 2, re: /\b(oil|crude|opec|natural gas|\blng\b|pipeline|refiner|power grid|blackout|electricity|uranium|coal)/i, ind: ["energy", "materials", "transport"] },
  { id: "policy", label: "Policy & rates", weight: 2, re: /\b(central bank|interest rate|rate hike|rate cut|monetary|inflation|federal reserve|ecb|bank of england|imf|bond yield|devalu|currency|debt|default|fiscal)/i, ind: ["financials", "realestate"] },
  { id: "hazard", label: "Natural hazards", weight: 2, re: /\b(earthquake|cyclone|typhoon|hurricane|flood|drought|wildfire|volcan|tsunami|heatwave|storm)/i, ind: ["agrifood", "realestate", "transport"] },
  { id: "food", label: "Food & agriculture", weight: 1, re: /\b(wheat|grain|rice|maize|corn|fertili|famine|food price|harvest|food insecurity)/i, ind: ["agrifood", "consumer"] },
  { id: "politics", label: "Politics & unrest", weight: 1, re: /\b(election|protest|unrest|parliament|impeach|referendum|resign|state of emergency|martial law)/i, ind: ["financials"] },
];

const INDUSTRY_WORDS = [
  ["tech", /\b(chip|semiconductor|rare earth|data cent|\bai\b|telecom|cyber)/i],
  ["financials", /\b(bank|lender|credit|bond|insurer)/i],
  ["autos", /\b(car|auto|vehicle|\bev\b|battery)/i],
  ["materials", /\b(steel|copper|lithium|nickel|aluminium|aluminum|mining|metal|cobalt|gold)/i],
  ["healthcare", /\b(drug|pharma|vaccine|outbreak|epidemic|cholera|mpox|ebola)/i],
  ["realestate", /\b(housing|property|construction)/i],
  ["energy", /\b(oil|gas|lng|power plant|refiner)/i],
  ["agrifood", /\b(wheat|grain|crop|fertili|food)/i],
];

const ECONOMY_WORDS = [
  ["us", /\b(united states|u\.s\.|\bus\b|washington|american|federal reserve|pentagon|white house)/i],
  ["china", /\b(china|chinese|beijing|xi jinping|hong kong)/i],
  ["eurozone", /\b(euro area|eurozone|\becb\b|european union|\beu\b|germany|german|france|french|italy|italian|spain|spanish|netherlands|brussels)/i],
  ["japan", /\b(japan|japanese|tokyo|bank of japan)/i],
  ["india", /\b(india|indian|delhi|mumbai|rupee|\brbi\b)/i],
  ["uk", /\b(britain|british|\buk\b|united kingdom|london|bank of england)/i],
  ["gulf", /\b(saudi|emirat|\buae\b|qatar|kuwait|oman|bahrain|gulf|hormuz|opec)/i],
];

const PLACES = ["Russia", "Ukraine", "Israel", "Gaza", "Lebanon", "Iran", "Iraq", "Syria", "Yemen", "Taiwan", "North Korea", "South Korea", "Venezuela", "Mexico", "Brazil", "Argentina", "Turkey", "Egypt", "Sudan", "Nigeria", "South Africa", "Pakistan", "Indonesia", "Philippines", "Vietnam", "Red Sea", "Black Sea", "Strait of Hormuz", "Suez Canal", "Panama Canal", "Taiwan Strait", "Sahel", "Ethiopia", "Libya", "Canada", "Australia"];

const INTENSIFIER = /\b(killed|dead|deaths|escalat|invasion|blockade|seiz|shut|halt|collapse|default|emergency|record|surge|plunge|soar|nuclear|ban|closure|explosion)/i;
// Raw source headlines can name firms; drop those rather than show company names.
const COMPANY_MARKERS = /\b(Inc|Corp|Corporation|Ltd|LLC|plc|PLC|Holdings|N\.V\.)\b|\$[A-Z]{1,5}\b|\b(NYSE|NASDAQ|Nasdaq):/;
const STOP = new Set(["about", "after", "against", "amid", "their", "there", "these", "which", "while", "would", "could", "says", "said", "with", "from", "that", "this", "into", "over", "under", "will", "have", "been", "more", "than"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchGdelt() {
  const out = [];
  let ok = 0;
  for (const [i, g] of GDELT_QUERIES.entries()) {
    if (i) await sleep(6000); // GDELT asks for one request every five seconds
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(`${g.q} sourcelang:english`)}&mode=ArtList&maxrecords=50&timespan=24h&sort=HybridRel&format=json`;
    try {
      const body = await fetchText(url);
      const data = JSON.parse(body);
      ok++;
      for (const a of data.articles ?? []) {
        const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(a.seendate || "");
        out.push({
          title: String(a.title || "").trim(),
          link: a.url,
          published: m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN,
          source: a.domain || "GDELT",
          sourceType: "Media monitor (GDELT)",
          origin: a.sourcecountry || "",
        });
      }
    } catch (err) {
      console.warn(`GDELT "${g.label}" failed: ${err.message}`);
    }
  }
  return { name: "GDELT", type: "Media monitor", ok: ok > 0, count: out.length, items: out };
}

async function fetchUsgs() {
  try {
    const data = JSON.parse(await fetchText("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_week.geojson"));
    const items = (data.features ?? []).map((f) => ({
      title: f.properties.title,
      link: f.properties.url,
      published: f.properties.time,
      source: "USGS",
      sourceType: "Disaster alerts",
      magnitude: f.properties.mag,
      alert: f.properties.alert,
    }));
    return { name: "USGS earthquakes", type: "Disaster alerts", ok: true, count: items.length, items };
  } catch (err) {
    console.warn(`USGS failed: ${err.message}`);
    return { name: "USGS earthquakes", type: "Disaster alerts", ok: false, count: 0, items: [] };
  }
}

async function fetchRss(src) {
  try {
    const items = (await fetchFeed(src.url)).map((it) => {
      const alert = txt(it.raw?.["gdacs:alertlevel"]).toLowerCase();
      return { ...it, raw: undefined, source: src.name, sourceType: src.type, alert: alert || undefined };
    });
    // GDACS green alerts are routine; keep orange and red only.
    const kept = src.name === "GDACS" ? items.filter((i) => i.alert === "orange" || i.alert === "red") : items;
    return { name: src.name, type: src.type, ok: true, count: kept.length, items: kept };
  } catch (err) {
    console.warn(`${src.name} failed: ${err.message}`);
    return { name: src.name, type: src.type, ok: false, count: 0, items: [] };
  }
}

function tag(item) {
  const text = `${item.title} ${item.summary || ""}`;
  const cats = CATEGORIES.filter((c) => c.re.test(text));
  if (item.sourceType === "Disaster alerts" && !cats.some((c) => c.id === "hazard")) cats.unshift(CATEGORIES.find((c) => c.id === "hazard"));
  if (item.sourceType === "Central bank" && !cats.some((c) => c.id === "policy")) cats.unshift(CATEGORIES.find((c) => c.id === "policy"));
  if (!cats.length) return null;
  const primary = [...cats].sort((a, b) => b.weight - a.weight)[0];

  const industries = new Set(primary.ind);
  for (const c of cats) if (c !== primary) c.ind.slice(0, 1).forEach((i) => industries.add(i));
  for (const [id, re] of INDUSTRY_WORDS) if (re.test(text)) industries.add(id);
  const economies = ECONOMY_WORDS.filter(([, re]) => re.test(text)).map(([id]) => id);
  const places = PLACES.filter((p) => new RegExp(`\\b${p}\\b`, "i").test(text)).slice(0, 4);

  let score = primary.weight;
  if (INTENSIFIER.test(text)) score += 1;
  if (cats.length >= 3) score += 1;
  if (economies.length) score += 1;
  if (item.alert === "red") score += 2;
  else if (item.alert === "orange") score += 1;
  if (item.magnitude >= 7) score += 2;
  else if (item.magnitude >= 6) score += 1;

  return {
    category: primary.id,
    categories: cats.map((c) => c.id),
    industries: [...industries].filter((id) => INDUSTRIES[id]).slice(0, 5),
    economies: economies.slice(0, 5),
    places,
    score,
  };
}

const tokens = (t) => new Set(t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(" ").filter((w) => w.length >= 5 && !STOP.has(w)));
function similar(a, b) {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / Math.max(1, Math.min(a.size, b.size)) >= 0.6 && shared >= 3;
}

export async function collectOsint() {
  const sources = await Promise.all([...RSS_SOURCES.map(fetchRss), fetchUsgs(), fetchGdelt()]);
  const cutoff = Date.now() - WINDOW_HOURS * 3600_000;
  const seen = new Set();
  const tagged = [];
  for (const s of sources) {
    for (const it of s.items) {
      if (!it.title || !/^https?:\/\//.test(it.link || "")) continue;
      if (!Number.isNaN(it.published) && it.published < cutoff) continue;
      if (COMPANY_MARKERS.test(it.title)) continue;
      const key = titleKey(it.title);
      if (seen.has(key)) continue;
      seen.add(key);
      const t = tag(it);
      if (t) tagged.push({ ...it, ...t, words: tokens(it.title) });
    }
  }

  // Cluster near-duplicate reports so corroboration counts toward severity.
  tagged.sort((a, b) => b.score - a.score || (b.published || 0) - (a.published || 0));
  const clusters = [];
  for (const it of tagged) {
    const home = clusters.find((c) => similar(c.words, it.words));
    if (home) {
      if (home.also.length < 4 && home.source !== it.source) home.also.push({ source: it.source, link: it.link });
      home.reports++;
    } else {
      clusters.push({ ...it, also: [], reports: 1 });
    }
  }

  const signals = clusters
    .map((c) => {
      const score = c.score + (c.reports >= 3 ? 1 : 0);
      return {
        id: titleKey(c.title).replace(/ /g, "-").slice(0, 60),
        title: c.title.slice(0, 220),
        link: c.link,
        source: c.source,
        sourceType: c.sourceType,
        published: Number.isNaN(c.published) ? null : new Date(c.published).toISOString(),
        category: c.category,
        categories: c.categories,
        places: c.places,
        industries: c.industries,
        economies: c.economies,
        severity: score >= 5 ? "high" : score >= 3 ? "elevated" : "watch",
        severityScore: score,
        reports: c.reports,
        also: c.also,
      };
    })
    .sort((a, b) => b.severityScore - a.severityScore || (b.published || "").localeCompare(a.published || ""))
    .slice(0, MAX_SIGNALS);

  return {
    sources: sources.map(({ name, type, ok, count }) => ({ name, type, ok, count })),
    categories: CATEGORIES.map(({ id, label }) => ({ id, label })),
    signals,
  };
}

// Run directly: write the feed, carrying over earlier Claude assessments by signal id.
if (import.meta.url === `file://${process.argv[1]}`) {
  const feed = await collectOsint();
  const okCount = feed.sources.filter((s) => s.ok).length;
  console.log(`${okCount}/${feed.sources.length} OSINT sources ok, ${feed.signals.length} signals`);
  if (okCount === 0 || feed.signals.length === 0) fail("No OSINT sources returned usable signals; keeping the previous feed.");

  let previous = {};
  try {
    for (const s of JSON.parse(await readFile(OSINT_PATH, "utf8")).signals ?? []) if (s.assessment) previous[s.id] = s.assessment;
  } catch {}
  for (const s of feed.signals) if (previous[s.id]) s.assessment = previous[s.id];

  await writeFile(OSINT_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), ...feed }, null, 1) + "\n");
  for (const s of feed.signals.slice(0, 8)) console.log(`- [${s.severity}] ${s.category} · ${s.source}: ${s.title}`);
}
