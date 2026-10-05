// Hourly scan: pull global business/world RSS feeds, have Claude pick and score the
// market-moving stories, then write public/data/scan.json and append to history.json.
// Needs API credit; the free daily path is the Claude routine using apply-scan.mjs.
// On any failure it exits without touching the last good scan.
import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { ECONOMIES, INDUSTRIES, THEMES, fail, fetchFeed, titleKey } from "./shared.mjs";
import { OSINT_PATH, normalizeItems, writeScan } from "./scan-store.mjs";

const MODEL = process.env.SCAN_MODEL || "claude-opus-5-5";
const WINDOW_HOURS = 36;
const MAX_HEADLINES = 140;
const MAX_SIGNALS_ASSESSED = 30;

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

if (!process.env.DRY_RUN && !process.env.ANTHROPIC_API_KEY) {
  fail("ANTHROPIC_API_KEY is not set. Add it under Settings → Secrets and variables → Actions.");
}

/* ---------- 1. Collect headlines ---------- */
const results = await Promise.allSettled(FEEDS.map(fetchFeed));
results.forEach((r, i) => { if (r.status === "rejected") console.warn(`feed failed: ${FEEDS[i]} (${r.reason?.message})`); });
const cutoff = Date.now() - WINDOW_HOURS * 3600_000;
const seen = new Set();
const headlines = results
  .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
  .filter((h) => h.title && /^https?:\/\//.test(h.link) && (Number.isNaN(h.published) || h.published >= cutoff))
  .filter((h) => {
    const key = titleKey(h.title);
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
    signals: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ref: { type: "integer" },
          headline: { type: "string" },
          risk: { type: "string", enum: ["watch", "elevated", "high"] },
          note: { type: "string" },
          industries: { type: "array", items: impact(INDUSTRIES) },
          economies: { type: "array", items: impact(ECONOMIES) },
        },
        required: ["ref", "headline", "risk", "note", "industries", "economies"],
        additionalProperties: false,
      },
    },
  },
  required: ["items", "signals"],
  additionalProperties: false,
};

let osint = null;
try { osint = JSON.parse(await readFile(OSINT_PATH, "utf8")); } catch {}
const osintSignals = (osint?.signals ?? []).slice(0, MAX_SIGNALS_ASSESSED);

const system = `You are a senior India markets strategist writing a market-impact wire on Indian markets.

From the numbered headlines, choose the 8 to 16 developments most likely to move Indian markets over the coming days to months: Indian news first, and foreign news only when it reaches India (oil and gas, US rates and the dollar, trade, metal or food prices, foreign investor flows). Merge headlines about the same development into one story and cite every headline you used in "refs". Skip celebrity, sport, crime and local stories unless they clearly matter for markets.

For each story, score its impact on these Indian sectors: ${Object.entries(INDUSTRIES).map(([k, v]) => `${k} (${v})`).join("; ")}.
And on these India market gauges (positive = good for Indian markets, e.g. a stronger rupee, falling yields, easing inflation, foreign inflows): ${Object.entries(ECONOMIES).map(([k, v]) => `${k} (${v})`).join("; ")}.

Rules:
- Never name a company, brand or listed firm anywhere. Write about industries and groups instead ("chipmakers", "large lenders"). Public institutions such as central banks, governments and OPEC+ may be named.
- Scores are integers from -3 (strong headwind) to 3 (strong tailwind). List only non-zero impacts: 1 to 6 industries and 0 to 6 economies per story, each with a "why" of at most 12 words.
- "headline": a neutral rewrite of at most 110 characters with the key figure in it. "summary": what happened, at most 45 words, with the numbers reported. "rationale": the transmission channel to markets, at most 55 words.
- "date": the date of the development as YYYY-MM-DD. "id": a short lowercase slug.
- Be calibrated: use 3 only for large, direct effects, and use "low" confidence for speculative calls.
- Use only facts present in the headlines. Do not invent figures.

Open-source intelligence signals:
After the headlines you may get numbered OSINT signals ([O1], [O2] …) from conflict trackers, disaster alerts, official bodies and media monitoring. Return one entry in "signals" for each signal that could plausibly move markets (skip the rest), with "ref" set to its number. "headline": a neutral rewrite of at most 100 characters with no company names. "risk": watch, elevated or high, judged by likely market impact rather than human severity. "note": at most 30 words on how it reaches markets. Score industries (0 to 4) and economies (0 to 4) with the same -3 to 3 scale. If there are no signals, return an empty array.`;

const today = new Date().toISOString().slice(0, 10);
const list = headlines
  .map((h, i) => `[${i + 1}] ${Number.isNaN(h.published) ? "" : new Date(h.published).toISOString().slice(0, 16).replace("T", " ") + " UTC · "}${h.title}${h.summary ? ` — ${h.summary}` : ""}`)
  .join("\n");
const signalList = osintSignals.length
  ? `\n\nOSINT signals:\n\n${osintSignals.map((s, i) => `[O${i + 1}] ${s.category} · ${s.sourceType}: ${s.source}${s.places.length ? ` · ${s.places.join(", ")}` : ""} · ${s.title}`).join("\n")}`
  : "";
const request = {
  model: MODEL,
  max_tokens: 32000,
  system,
  messages: [{ role: "user", content: `Today is ${today}. Headlines from the last ${WINDOW_HOURS} hours:\n\n${list}${signalList}` }],
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
const items = normalizeItems((parsed.items ?? []).map((it) => ({
  ...it,
  sources: (it.refs ?? []).map((n) => headlines[n - 1]?.link).filter(Boolean),
})));
await writeScan({ items, model: message.model, headlinesScanned: headlines.length, feedsOk, signals: parsed.signals ?? [] });
const u = message.usage;
console.log(`Used ${message.model} (input ${u.input_tokens}, output ${u.output_tokens} tokens).`);
