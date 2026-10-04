// Open-source intelligence feed: geopolitical and economic signals from open sources
// (GDELT, Google News topic searches, UN, ReliefWeb, GDACS, USGS, Crisis Group, central banks, WTO, EIA).
// Rule-based tagging only, so it runs without an API key; the Claude scan adds assessments later.
// Writes public/data/osint.json, keeping the previous assessments for signals still in the feed.
import { readFile, writeFile } from "node:fs/promises";
import { ECONOMIES, INDUSTRIES, fail, fetchFeed, fetchText, titleKey, txt } from "./shared.mjs";

const OSINT_PATH = new URL("../public/data/osint.json", import.meta.url);
const WINDOW_HOURS = 24;
const MAX_SIGNALS = 80;
const MAX_MEDIA = 45; // media items are plentiful; leave room for official, tracker and hazard sources

const RSS_SOURCES = [
  { name: "UN News", type: "Intergovernmental", url: "https://news.un.org/feed/subscribe/en/news/all/rss.xml" },
  { name: "ReliefWeb", type: "Humanitarian", url: "https://reliefweb.int/updates/rss.xml" },
  { name: "GDACS", type: "Disaster alerts", url: "https://www.gdacs.org/xml/rss.xml" },
  { name: "Crisis Group", type: "Conflict tracker", url: "https://www.crisisgroup.org/rss" },
  { name: "Federal Reserve", type: "Central bank", url: "https://www.federalreserve.gov/feeds/press_all.xml" },
  { name: "ECB", type: "Central bank", url: "https://www.ecb.europa.eu/rss/press.html" },
  { name: "Bank of England", type: "Central bank", url: "https://www.bankofengland.co.uk/rss/news" },
  { name: "WTO", type: "Official", url: "https://www.wto.org/library/rss/latest_news_e.xml" },
  { name: "US EIA", type: "Official", url: "https://www.eia.gov/rss/todayinenergy.xml" },
];

// GDELT monitors world news media in many languages; each query is one open API call.
// One combined query: GDELT rate-limits shared CI addresses after the first request.
const GDELT_QUERY = '(sanctions OR embargo OR "export controls" OR tariffs OR missile OR airstrike OR blockade OR coup OR "Strait of Hormuz" OR "Red Sea" OR "Suez Canal" OR "Taiwan Strait" OR "Black Sea" OR OPEC OR "oil supply" OR "gas supply" OR "pipeline attack")';

const CATEGORIES = [
  { id: "conflict", label: "Conflict & security", weight: 2, re: /\b(war|missile|airstrike|air strike|drone strike|military|troops|attack|shelling|ceasefire|insurgen|coup|clashes|navy|naval|invasion|hostage|terror)/i, ind: ["energy", "transport", "industrials"] },
  { id: "shipping", label: "Shipping & chokepoints", weight: 3, re: /\b(strait|shipping|canal|red sea|hormuz|bab el|freight|tanker|container ship|vessel|port closure|blockade|black sea)/i, ind: ["transport", "energy", "consumer"] },
  { id: "sanctions", label: "Sanctions & trade", weight: 2, re: /\b(sanction|embargo|export control|tariff|trade war|trade deal|blacklist|asset freeze|retaliat|anti-dumping|wto)/i, ind: ["industrials", "tech", "autos", "agrifood"] },
  { id: "energy", label: "Energy supply", weight: 2, re: /\b(oil|crude|opec|natural gas|\blng\b|pipeline|refiner|power grid|blackout|electricity|uranium|coal)/i, ind: ["energy", "materials", "transport"] },
  { id: "policy", label: "Policy & rates", weight: 1, re: /\b(central bank|interest rate|rate hike|rate cut|monetary|inflation|federal reserve|ecb|bank of england|imf|bond yield|devalu|currency|debt|default|fiscal)/i, ind: ["financials", "realestate"] },
  { id: "hazard", label: "Natural hazards", weight: 1, re: /\b(earthquake|cyclone|typhoon|hurricane|flood|drought|wildfire|volcan|tsunami|heatwave|storm)/i, ind: ["agrifood", "realestate", "transport"] },
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

export const ECONOMY_WORDS = [
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
export const COMPANY_MARKERS = /\b(Inc|Corp|Corporation|Ltd|LLC|plc|PLC|Holdings|N\.V\.)\b|\$[A-Z]{1,5}\b|\b(NYSE|NASDAQ|Nasdaq):/;
// Best effort: the largest firms that most often appear in geopolitical and energy headlines.
export const COMPANY_NAMES = new RegExp("\\b(" + [
  "Aramco", "Sinopec", "PetroChina", "CNOOC", "Exxon", "ExxonMobil", "Chevron", "Shell", "BP", "TotalEnergies", "Equinor", "Eni", "Repsol", "Petrobras", "Pemex", "ADNOC", "QatarEnergy", "Occidental", "ConocoPhillips", "Halliburton", "Schlumberger", "SLB", "Gazprom", "Rosneft", "Lukoil", "Novatek", "Vitol", "Trafigura", "Glencore", "Gunvor",
  "Raytheon", "RTX", "Lockheed", "Northrop", "General Dynamics", "Boeing", "Airbus", "BAE Systems", "Rheinmetall", "Thales", "Anduril", "Palantir",
  "Maersk", "MSC", "CMA CGM", "Hapag-Lloyd", "COSCO", "FedEx", "UPS", "DHL",
  "Apple", "Microsoft", "Google", "Alphabet", "Meta", "Nvidia", "Intel", "AMD", "Qualcomm", "Broadcom", "TSMC", "Samsung", "SK Hynix", "Micron", "ASML", "Huawei", "SMIC", "Foxconn", "Hon Hai", "Alibaba", "Tencent", "ByteDance", "TikTok", "Xiaomi", "OpenAI", "Anthropic",
  "Tesla", "Toyota", "Volkswagen", "BYD", "CATL", "Ford", "General Motors", "Stellantis", "Honda", "Nissan", "Hyundai", "Kia", "BMW", "Mercedes-Benz",
  "JPMorgan", "Goldman Sachs", "Morgan Stanley", "Citigroup", "Citi", "HSBC", "Barclays", "BlackRock", "Berkshire", "Mastercard",
  "Walmart", "Pfizer", "Moderna", "Novartis", "Roche", "AstraZeneca", "Bayer", "Nestle", "Unilever", "Cargill", "ADM", "Bunge", "BHP", "Rio Tinto", "ArcelorMittal", "Siemens", "Mitsubishi", "Sony", "Reliance", "Tata", "TCS", "Adani", "Infosys", "Wipro", "HDFC", "ICICI",
].join("|") + ")\\b");
const STOP = new Set(["about", "after", "against", "amid", "their", "there", "these", "which", "while", "would", "could", "says", "said", "with", "from", "that", "this", "into", "over", "under", "will", "have", "been", "more", "than"]);

// Places whose disruption tends to reach global markets (energy, shipping, chips, grain).
const MARKET_PLACES = new Set(["Russia", "Ukraine", "Israel", "Lebanon", "Iran", "Iraq", "Yemen", "Taiwan", "North Korea", "South Korea", "Venezuela", "Libya", "Red Sea", "Black Sea", "Strait of Hormuz", "Suez Canal", "Panama Canal", "Taiwan Strait"]);
// Central-bank and official feeds also publish appointments, events and speeches; keep only market business.
const POLICY_BUSINESS = /\b(rate|inflation|monetary|financial stability|policy statement|fomc|minutes of the monetary|balance sheet|stress test|liquidity|tariff|sanction|trade|outlook|forecast|growth|recession|debt|currency|exchange|oil|gas|energy|supply)/i;
const DIGEST = /^(world news in brief|news in brief|daily briefing|week in review)/i;

const warn = (msg) => console.warn(process.env.GITHUB_ACTIONS ? `::warning::${msg}` : msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchGdelt() {
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(`${GDELT_QUERY} sourcelang:english`)}&mode=ArtList&maxrecords=150&timespan=24h&sort=HybridRel&format=json`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const body = await fetchText(url);
      let data;
      try { data = JSON.parse(body); } catch { throw new Error(`not JSON: ${body.replace(/\s+/g, " ").slice(0, 140)}`); }
      const items = (data.articles ?? []).map((a) => {
        const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(a.seendate || "");
        return {
          title: String(a.title || "").trim(),
          link: a.url,
          published: m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN,
          source: a.domain || "GDELT",
          sourceType: "Media monitor (GDELT)",
        };
      });
      return { name: "GDELT", type: "Media monitor", ok: true, count: items.length, items };
    } catch (err) {
      if (attempt === 0 && /429/.test(err.message)) { await sleep(20000); continue; }
      warn(`GDELT failed: ${err.message}`);
    }
  }
  return { name: "GDELT", type: "Media monitor", ok: false, count: 0, items: [] };
}

// Google News topic searches as a second media monitor (GDELT often rate-limits CI servers).
const NEWS_SEARCHES = [
  'sanctions OR embargo OR "export controls" OR "trade war"',
  '"Strait of Hormuz" OR "Red Sea" OR "Suez Canal" OR "Taiwan Strait" OR "Black Sea" shipping',
  'OPEC OR "oil supply" OR "gas supply" OR "pipeline attack" OR "refinery"',
  'missile OR airstrike OR coup OR "military escalation" OR blockade',
];
async function fetchNewsSearches() {
  const items = [];
  let ok = 0;
  for (const q of NEWS_SEARCHES) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} when:1d`)}&hl=en-US&gl=US&ceid=US:en`;
    try {
      for (const it of await fetchFeed(url)) {
        const publisher = txt(it.raw?.source).trim();
        let title = it.title;
        if (publisher && title.endsWith(` - ${publisher}`)) title = title.slice(0, -publisher.length - 3).trim();
        items.push({ ...it, raw: undefined, title, source: publisher || "Google News", sourceType: "Media monitor (Google News)" });
      }
      ok++;
    } catch (err) {
      warn(`Google News search failed: ${err.message}`);
    }
  }
  return { name: "Google News searches", type: "Media monitor", ok: ok > 0, count: items.length, items };
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
    warn(`USGS failed: ${err.message}`);
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
    warn(`${src.name} failed: ${err.message}`);
    return { name: src.name, type: src.type, ok: false, count: 0, items: [] };
  }
}

function tag(item) {
  if (DIGEST.test(item.title)) return null;
  const text = `${item.title} ${item.summary || ""}`;
  let cats = CATEGORIES.filter((c) => c.re.test(item.title));
  let penalty = 0;
  if (!cats.length) { cats = CATEGORIES.filter((c) => c.re.test(item.summary || "")); penalty = 1; }
  const official = item.sourceType === "Central bank" || item.sourceType === "Official";
  if (official && !POLICY_BUSINESS.test(item.title)) return null;
  if (item.sourceType === "Disaster alerts" && !cats.some((c) => c.id === "hazard")) cats.unshift(CATEGORIES.find((c) => c.id === "hazard"));
  if (item.sourceType === "Central bank" && !cats.some((c) => c.id === "policy")) cats.unshift(CATEGORIES.find((c) => c.id === "policy"));
  if (!cats.length) return null;
  const primary = [...cats].sort((a, b) => b.weight - a.weight)[0];

  const industries = new Set(primary.ind);
  for (const c of cats) if (c !== primary) c.ind.slice(0, 1).forEach((i) => industries.add(i));
  for (const [id, re] of INDUSTRY_WORDS) if (re.test(text)) industries.add(id);
  const economies = ECONOMY_WORDS.filter(([, re]) => re.test(text)).map(([id]) => id);
  const places = PLACES.filter((p) => new RegExp(`\\b${p}\\b`, "i").test(text)).slice(0, 4);

  // Humanitarian and political stories only count when they touch a market-relevant place or economy.
  const marketPlace = places.some((p) => MARKET_PLACES.has(p));
  const marketCats = cats.some((c) => ["shipping", "sanctions", "energy", "food", "policy"].includes(c.id));
  const alerted = item.alert === "red" || item.alert === "orange" || item.magnitude >= 6;
  if (!marketPlace && !economies.length && !marketCats && !alerted) return null;

  let score = primary.weight - penalty;
  if (marketPlace) score += 1;
  if (/\b(rais|hik|cut|lower|hold|keep|leave)\w* (its |the )?(key |policy |benchmark |interest |bank )*rates?\b|rate decision|monetary policy decision|fomc statement/i.test(item.title)) score += 2;
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
  const sources = await Promise.all([...RSS_SOURCES.map(fetchRss), fetchUsgs(), fetchNewsSearches(), fetchGdelt()]);
  const cutoff = Date.now() - WINDOW_HOURS * 3600_000;
  const seen = new Set();
  const tagged = [];
  for (const s of sources) {
    for (const it of s.items) {
      if (!it.title || !/^https?:\/\//.test(it.link || "")) continue;
      if (!Number.isNaN(it.published) && it.published < cutoff) continue;
      if (COMPANY_MARKERS.test(it.title) || COMPANY_NAMES.test(it.title)) continue;
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
        severity: score >= 6 ? "high" : score >= 4 ? "elevated" : "watch",
        severityScore: score,
        reports: c.reports,
        also: c.also,
      };
    })
    .sort((a, b) => b.severityScore - a.severityScore || (b.published || "").localeCompare(a.published || ""));
  const isMedia = (s) => s.sourceType.startsWith("Media monitor");
  const media = signals.filter(isMedia).slice(0, MAX_MEDIA);
  const other = signals.filter((s) => !isMedia(s)).slice(0, MAX_SIGNALS - media.length);
  const selected = [...media, ...other].sort((a, b) => b.severityScore - a.severityScore || (b.published || "").localeCompare(a.published || ""));

  return {
    sources: sources.map(({ name, type, ok, count }) => ({ name, type, ok, count })),
    categories: CATEGORIES.map(({ id, label }) => ({ id, label })),
    signals: selected,
  };
}

// Run directly: write the feed, carrying over earlier Claude assessments by signal id.
if (import.meta.url === `file://${process.argv[1]}`) {
  const feed = await collectOsint();
  const okCount = feed.sources.filter((s) => s.ok).length;
  console.log(`${okCount}/${feed.sources.length} OSINT sources ok, ${feed.signals.length} signals`);
  if (okCount === 0 || feed.signals.length === 0) fail("No OSINT sources returned usable signals; keeping the previous feed.");

  let previous = {};
  let assessedAt;
  try {
    const old = JSON.parse(await readFile(OSINT_PATH, "utf8"));
    assessedAt = old.assessedAt;
    for (const s of old.signals ?? []) if (s.assessment) previous[s.id] = s.assessment;
  } catch {}
  for (const s of feed.signals) if (previous[s.id]) s.assessment = previous[s.id];

  await writeFile(OSINT_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), assessedAt, ...feed }, null, 1) + "\n");
  for (const s of feed.signals.slice(0, 8)) console.log(`- [${s.severity}] ${s.category} · ${s.source}: ${s.title}`);
}
