// Taxonomy and feed helpers shared by the news scan and the intelligence feed.
import { XMLParser } from "fast-xml-parser";

export const INDUSTRIES = {
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
export const ECONOMIES = {
  us: "United States", china: "China", eurozone: "Euro area", japan: "Japan",
  india: "India", uk: "United Kingdom", gulf: "Gulf states",
};
export const THEMES = ["Energy & geopolitics", "Monetary policy", "Rates & bonds", "Trade", "Growth data", "Tech cycle", "Commodities", "Currencies"];
export const CONF = { high: 1, medium: 0.7, low: 0.4 };

export const fail = (msg) => {
  console.error(process.env.GITHUB_ACTIONS ? `::error::${msg}` : msg);
  process.exit(1);
};

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
export const txt = (v) => (v == null ? "" : typeof v === "object" ? String(v["#text"] ?? "") : String(v));
export const clean = (s) => txt(s).replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
const linkOf = (it) => {
  const l = it.link;
  if (typeof l === "string") return l.trim();
  if (Array.isArray(l)) return l.map((x) => x["@_href"] || txt(x)).find(Boolean) || "";
  if (l && typeof l === "object") return l["@_href"] || txt(l);
  return txt(it.guid);
};

export async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; market-pressure-map/1.0; +https://github.com/DevDataAnalyst/market-pressure-map)",
      accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, application/json;q=0.9, */*;q=0.8",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// RSS 2.0, Atom and RSS 1.0 (RDF). `raw` keeps the original item for source-specific fields.
export async function fetchFeed(url) {
  const doc = parser.parse(await fetchText(url));
  const raw = doc?.rss?.channel?.item ?? doc?.feed?.entry ?? doc?.["rdf:RDF"]?.item ?? [];
  return (Array.isArray(raw) ? raw : [raw]).map((it) => ({
    title: clean(it.title),
    link: linkOf(it),
    summary: clean(it.description ?? it.summary ?? it.content).slice(0, 280),
    published: Date.parse(txt(it.pubDate ?? it.published ?? it.updated ?? it["dc:date"])),
    raw: it,
  }));
}

export const titleKey = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 90);
