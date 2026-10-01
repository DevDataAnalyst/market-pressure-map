// Hourly scan: pull global business/world RSS feeds, have Claude pick and score the
// market-moving stories, then write public/data/scan.json and append to history.json.
// On any failure it exits without touching the last good scan.
import Anthropic from "@anthropic-ai/sdk";
import { XMLParser } from "fast-xml-parser";
import { readFile, writeFile } from "node:fs/promises";

const MODEL = process.env.SCAN_MODEL || "claude-opus-5-5";
const WINDOW_HOURS = 36;
const MAX_HEADLINES = 140;
const SCAN_PATH = new URL("../public/data/scan.json", import.meta.url);
const HISTORY_PATH = new URL("../public/data/history.json", import.meta.url);

const FEEDS = [
  "https://feeds.bbci.co.uk/news/business/rss.xml",
  "https://feeds.bbci.co.uk/news/world/rss.xml",
  "https://www.theguardian.com/business/economics/rss",
  "https://www.theguardian.com/business/rss",
  "https://www.cnbc.com/id/100727362/device/rss/rss.html",
  "https://www.cnbc.com/id/20910258/device/rss/rss.html",
  "https://www.aljazeera.com/xml/rss/all.xml",
  "https://rss.dw.com/rdf/rss-en-bus",
  "https://economictimes.indiatimes.com/news/economy/rssfeeds/1373380680.cms",
  "https://www.scmp.com/rss/92/feed",
  "https://asia.nikkei.com/rss/feed/nar",
  "https://feeds.content.dowjones.io/public/rss/mw_topstories",
  "https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/search?q=central+bank+OR+oil+OR+tariffs+OR+inflation+when:1d&hl=en-US&gl=US&ceid=US:en",
];

const INDUSTRIES = {
  energy: "Energy (oil, gas & power)",
  financials: "Banks & financials",
  tech: "Technology & semiconductors",
  healthcare: "Healthcare & pharma",
  autos: "Autos & mobility",
  consumer: "Retail & consumer goods",
  industrials: "Industrials & machinery",
  materials: "Materials & mining",
  agrifood: "Agriculture & food",
  realestate: "Real estate & construction",
  transport: "Transport & logistics",
};
const ECONOMIES = {
  us: "United States", china: "China", eurozone: "Euro area", japan: "Japan",
  india: "India", uk: "United Kingdom", gulf: "Gulf states",
};
const THEMES = ["Energy & geopolitics", "Monetary policy", "Rates & bonds", "Trade", "Growth data", "Tech cycle", "Commodities", "Currencies"];
const CONF = { high: 1, medium: 0.7, low: 0.4 };
const fail = (msg) => {
  console.error(process.env.GITHUB_ACTIONS ? `::error::${msg}` : msg);
  process.exit(1);
};

if (!process.env.DRY_RUN && !process.env.ANTHROPIC_API_KEY) {
  fail("ANTHROPIC_API_KEY is not set. Add it under Settings → Secrets and variables → Actions.");
}

/* ---------- 1. Collect headlines ---------- */
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
const txt = (v) => (v == null ? "" : typeof v === "object" ? String(v["#text"] ?? "") : String(v));
const clean = (s) => txt(s).replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
const linkOf = (it) => {
  const l = it.link;
  if (typeof l === "string") return l.trim();
  if (Array.isArray(l)) return l.map((x) => x["@_href"] || txt(x)).find(Boolean) || "";
  if (l && typeof l === "object") return l["@_href"] || txt(l);
  return txt(it.guid);
};

async function fetchFeed(url) {
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; market-pressure-map/1.0)" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const doc = parser.parse(await res.text());
  const raw = doc?.rss?.channel?.item ?? doc?.feed?.entry ?? doc?.["rdf:RDF"]?.item ?? [];
  return (Array.isArray(raw) ? raw : [raw]).map((it) => ({
    title: clean(it.title),
    link: linkOf(it),
    summary: clean(it.description ?? it.summary ?? it.content).slice(0, 280),
    published: Date.parse(txt(it.pubDate ?? it.published ?? it.updated ?? it["dc:date"])),
  }));
}

const results = await Promise.allSettled(FEEDS.map(fetchFeed));
results.forEach((r, i) => { if (r.status === "rejected") console.warn(`feed failed: ${FEEDS[i]} (${r.reason?.message})`); });
const cutoff = Date.now() - WINDOW_HOURS * 3600_000;
const seen = new Set();
const headlines = results
  .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
  .filter((h) => h.title && /^https?:\/\//.test(h.link) && (Number.isNaN(h.published) || h.published >= cutoff))
  .filter((h) => {
    const key = h.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 90);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  })
  .sort((a, b) => (b.published || 0) - (a.published || 0))
  .slice(0, MAX_HEADLINES);

const feedsOk = results.filter((r) => r.status === "fulfilled").length;
console.log(`${feedsOk}/${FEEDS.length} feeds ok, ${headlines.length} headlines in the last ${WINDOW_HOURS}h`);
if (process.env.DRY_RUN) {
  for (const h of headlines.slice(0, 15)) console.log(`- ${h.title}`);
  process.exit(0);
}
if (headlines.length < 15) {
  fail(`Only ${headlines.length} headlines from ${feedsOk} feeds; keeping the previous scan.`);
}

/* ---------- 2. Ask Claude to select and score ---------- */
const impact = (ids) => ({
  type: "object",
  properties: {
    id: { type: "string", enum: Object.keys(ids) },
    score: { type: "integer" },
    why: { type: "string" },
  },
  required: ["id", "score", "why"],
  additionalProperties: false,
});
const schema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          date: { type: "string" },
          theme: { type: "string", enum: THEMES },
          headline: { type: "string" },
          summary: { type: "string" },
          rationale: { type: "string" },
          horizon: { type: "string", enum: ["days", "weeks", "months"] },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
          industries: { type: "array", items: impact(INDUSTRIES) },
          economies: { type: "array", items: impact(ECONOMIES) },
          refs: { type: "array", items: { type: "integer" } },
        },
        required: ["id", "date", "theme", "headline", "summary", "rationale", "horizon", "confidence", "industries", "economies", "refs"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

const system = `You are a senior macro strategist writing a market-impact wire for a global audience.

From the numbered headlines, choose the 12 to 16 developments most likely to move global markets over the coming days to months. Merge headlines about the same development into one story and cite every headline you used in "refs". Skip celebrity, sport, crime and local stories unless they clearly matter for markets.

For each story, score its impact on these industries: ${Object.entries(INDUSTRIES).map(([k, v]) => `${k} (${v})`).join("; ")}.
And on these economies: ${Object.entries(ECONOMIES).map(([k, v]) => `${k} (${v})`).join("; ")}.

Rules:
- Never name a company, brand or listed firm anywhere. Write about industries and groups instead ("chipmakers", "large lenders"). Public institutions such as central banks, governments and OPEC+ may be named.
- Scores are integers from -3 (strong headwind) to 3 (strong tailwind). List only non-zero impacts: 1 to 6 industries and 0 to 6 economies per story, each with a "why" of at most 12 words.
- "headline": a neutral rewrite of at most 110 characters with the key figure in it. "summary": what happened, at most 45 words, with the numbers reported. "rationale": the transmission channel to markets, at most 55 words.
- "date": the date of the development as YYYY-MM-DD. "id": a short lowercase slug.
- Be calibrated: use 3 only for large, direct effects, and use "low" confidence for speculative calls.
- Use only facts present in the headlines. Do not invent figures.`;

const today = new Date().toISOString().slice(0, 10);
const list = headlines
  .map((h, i) => `[${i + 1}] ${Number.isNaN(h.published) ? "" : new Date(h.published).toISOString().slice(0, 16).replace("T", " ") + " UTC · "}${h.title}${h.summary ? ` — ${h.summary}` : ""}`)
  .join("\n");
const request = {
  model: MODEL,
  max_tokens: 32000,
  system,
  messages: [{ role: "user", content: `Today is ${today}. Headlines from the last ${WINDOW_HOURS} hours:\n\n${list}` }],
  output_config: { effort: "medium", format: { type: "json_schema", schema } },
};

// Keys not scoped to a workspace must name one on every request.
const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID?.trim();
const client = new Anthropic(workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {});
let message;
try {
  message = await client.beta.messages
    .stream({ ...request, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
    .finalMessage();
} catch (err) {
  if (!(err instanceof Anthropic.BadRequestError)) fail(`Claude API error: ${err.message}`);
  console.warn(`Retrying without refusal fallbacks: ${err.message}`);
  try {
    message = await client.messages.stream(request).finalMessage();
  } catch (retryErr) {
    fail(`Claude API error: ${retryErr.message}`);
  }
}
if (message.stop_reason === "refusal" || message.stop_reason === "max_tokens") {
  fail(`Scan stopped early (${message.stop_reason}); keeping the previous scan.`);
}
const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
const parsed = JSON.parse(text);

/* ---------- 3. Validate and write ---------- */
const clampScore = (v) => Math.max(-3, Math.min(3, Math.round(Number(v) || 0)));
const impacts = (arr, known) => {
  const out = [];
  for (const x of arr ?? []) {
    if (!known[x.id] || out.some((y) => y.id === x.id)) continue;
    const score = clampScore(x.score);
    if (score) out.push({ id: x.id, score, why: String(x.why ?? "").slice(0, 140) });
  }
  return out;
};
const items = (parsed.items ?? [])
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
    sources: [...new Set((it.refs ?? []).map((n) => headlines[n - 1]?.link).filter(Boolean))].slice(0, 3),
  }))
  .filter((it) => it.headline && (it.industries.length || it.economies.length));

if (items.length < 6) {
  fail(`Only ${items.length} usable stories; keeping the previous scan.`);
}

const dates = items.map((i) => i.date).sort();
const fmt = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const scan = {
  scannedAt: new Date().toISOString(),
  window: dates[0] === dates.at(-1) ? fmt(dates[0]) : `${fmt(dates[0]).replace(/ \d{4}$/, "")} – ${fmt(dates.at(-1))}`,
  model: message.model,
  headlinesScanned: headlines.length,
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
history.push({ at: scan.scannedAt, ind: net("industries", INDUSTRIES), eco: net("economies", ECONOMIES) });
await writeFile(HISTORY_PATH, JSON.stringify(history.slice(-24 * 14)) + "\n");

const u = message.usage;
console.log(`Wrote ${items.length} stories with ${message.model} (input ${u.input_tokens}, output ${u.output_tokens} tokens).`);
