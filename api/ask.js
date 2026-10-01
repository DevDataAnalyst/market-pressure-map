// POST /api/ask — answers a market question with the latest scan as context.
// Streams plain text; after the answer, a \u001e separator and a JSON footer with sources.
import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import path from "node:path";

const MODEL = process.env.ASK_MODEL || "claude-opus-5-5";
const MAX_QUESTION = 600;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = Number(process.env.ASK_RATE_LIMIT || 8);
const END = "\u001e";

const INDUSTRIES = {
  energy: "Energy", financials: "Banks & financials", tech: "Technology & semiconductors",
  healthcare: "Healthcare & pharma", autos: "Autos & mobility", consumer: "Retail & consumer goods",
  industrials: "Industrials & machinery", materials: "Materials & mining", agrifood: "Agriculture & food",
  realestate: "Real estate & construction", transport: "Transport & logistics",
};
const ECONOMIES = {
  us: "United States", china: "China", eurozone: "Euro area", japan: "Japan",
  india: "India", uk: "United Kingdom", gulf: "Gulf states",
};
const CONF = { high: 1, medium: 0.7, low: 0.4 };

// Best-effort per-instance limit; serverless instances don't share memory.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return false;
}

let cachedScan = null;
async function scanContext() {
  if (cachedScan) return cachedScan;
  try {
    const raw = await readFile(path.join(process.cwd(), "public/data/scan.json"), "utf8");
    const scan = JSON.parse(raw);
    const sign = (n) => (n > 0 ? `+${n}` : String(n));
    const totals = (key, names) => {
      const t = Object.fromEntries(Object.keys(names).map((k) => [k, 0]));
      for (const it of scan.items) for (const s of it[key]) if (s.id in t) t[s.id] += s.score * (CONF[it.confidence] ?? 0.7);
      return Object.entries(t)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${names[k]} ${sign(Math.round(v * 10) / 10)}`)
        .join("; ");
    };
    const stories = scan.items
      .map((it, i) => {
        const imp = (arr, names) => arr.map((s) => `${names[s.id]} ${sign(s.score)} (${s.why})`).join("; ");
        return `${i + 1}. [${it.date} · ${it.theme} · horizon ${it.horizon} · ${it.confidence} confidence] ${it.headline}
   ${it.summary}
   Why it matters: ${it.rationale}
   Industries: ${imp(it.industries, INDUSTRIES) || "none"}
   Economies: ${imp(it.economies, ECONOMIES) || "none"}`;
      })
      .join("\n");
    cachedScan = `Latest scan (${scan.window}, scanned ${scan.scannedAt}). Scores run from -3 (strong headwind) to +3 (strong tailwind); totals weight high confidence 1.0, medium 0.7, low 0.4.
Industry totals: ${totals("industries", INDUSTRIES)}
Economy totals: ${totals("economies", ECONOMIES)}

Stories:
${stories}`;
  } catch {
    cachedScan = "The latest scan could not be loaded.";
  }
  return cachedScan;
}

const RULES = `You are the market desk assistant on Market Pressure Map, a site that scores global news for its impact on the largest industries and economies. Visitors ask about markets, economies, industries, commodities, currencies and economic policy.

- Ground your answer in the scan below. Use web search for recent facts the scan doesn't cover, and say plainly when neither has the answer.
- Never name individual companies, brands or listed firms. Discuss industries and groups instead. If someone asks about a specific company, say the site covers sectors and answer at the industry level. Central banks, governments and bodies such as OPEC+ may be named.
- Don't give personal investment advice or tell anyone to buy, sell or hold anything. Explain the drivers, scenarios and risks.
- Keep answers to 80–200 words. Use plain text: short paragraphs, and "- " bullets if a list helps. No headings, tables or bold.
- Give figures with their date. If you are unsure, say so.
- If a question has nothing to do with markets or the economy, politely say this box is for market questions.`;

function toMessages(history, question) {
  const messages = [];
  for (const turn of Array.isArray(history) ? history.slice(-3) : []) {
    const q = String(turn?.q ?? "").slice(0, MAX_QUESTION).trim();
    const a = String(turn?.a ?? "").slice(0, 2000).trim();
    if (q && a) messages.push({ role: "user", content: q }, { role: "assistant", content: a });
  }
  messages.push({ role: "user", content: question });
  return messages;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST." });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: "The question box isn't switched on yet. Check back soon." });
  }
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) {
    return res.status(429).json({ error: "That's a lot of questions in a short time. Try again in a few minutes." });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const question = String(body?.question ?? "").trim();
  if (!question) return res.status(400).json({ error: "Type a question first." });
  if (question.length > MAX_QUESTION) {
    return res.status(400).json({ error: `Keep questions under ${MAX_QUESTION} characters.` });
  }

  const params = {
    model: MODEL,
    max_tokens: 8000,
    system: [{ type: "text", text: `${RULES}\n\n${await scanContext()}`, cache_control: { type: "ephemeral" } }],
    messages: toMessages(body.history, question),
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 2 }],
    output_config: { effort: "low" },
  };

  const client = new Anthropic();
  let stream = client.beta.messages.stream({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
  let started = false;

  const pump = async (s) => {
    for await (const event of s) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        if (!started) {
          res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
          started = true;
        }
        res.write(event.delta.text);
      }
    }
    return s.finalMessage();
  };

  try {
    let message;
    try {
      message = await pump(stream);
    } catch (err) {
      if (started || !(err instanceof Anthropic.BadRequestError)) throw err;
      console.warn(`Retrying without refusal fallbacks: ${err.message}`);
      stream = client.messages.stream(params);
      message = await pump(stream);
    }
    if (!started) {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      started = true;
    }
    if (message.stop_reason === "refusal") {
      res.write("I can't help with that one. Try asking about a market, industry or economy.");
    }
    const sources = [];
    for (const block of message.content) {
      if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
        for (const r of block.content) {
          if (r.url && !sources.some((s) => s.url === r.url)) sources.push({ url: r.url, title: r.title || r.url });
        }
      }
    }
    res.end(END + JSON.stringify({ sources: sources.slice(0, 5) }));
  } catch (err) {
    console.error(err);
    if (!started) {
      const status = err instanceof Anthropic.RateLimitError ? 429 : 502;
      return res.status(status).json({ error: status === 429 ? "The desk is busy right now. Try again in a minute." : "The answer couldn't be generated. Try again." });
    }
    res.end("\n\n(The answer was cut off. Try asking again.)" + END + JSON.stringify({ sources: [] }));
  }
}
