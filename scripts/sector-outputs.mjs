// Per-sector outputs written after every scan: an RSS feed per sector (public/data/feeds/<slug>.xml,
// plus all.xml) and a small share page per sector (public/data/sector/<slug>.html) whose title and
// description carry today's reading, so links preview well in chat apps. The share page forwards
// visitors to the site with that sector open (/#sector=<slug>).
import { mkdir, writeFile } from "node:fs/promises";
import { CONF, ECONOMIES, INDUSTRIES, SECTOR_SLUGS, SITE_URL } from "./shared.mjs";

const DATA = new URL("../public/data/", import.meta.url);
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const signed = (n) => (n > 0 ? "+" : n < 0 ? "−" : "±") + Math.abs(n).toFixed(1);
const word = (n) => (n >= 3 ? "Strong tailwind" : n >= 1 ? "Tailwind" : n > -1 ? "Mixed" : n > -3 ? "Headwind" : "Strong headwind");
const scoreWord = (s) => ({ 3: "strong tailwind", 2: "tailwind", 1: "mild tailwind", "-1": "mild headwind", "-2": "headwind", "-3": "strong headwind" })[s] || "";

function sectorView(items, id) {
  const stories = items
    .map((it) => ({ it, s: it.industries.find((x) => x.id === id) }))
    .filter((x) => x.s)
    .sort((a, b) => Math.abs(b.s.score) * (CONF[b.it.confidence] || 0.7) - Math.abs(a.s.score) * (CONF[a.it.confidence] || 0.7));
  const net = Math.round(stories.reduce((t, x) => t + x.s.score * (CONF[x.it.confidence] || 0.7), 0) * 10) / 10;
  return { stories, net };
}

function rss({ title, description, link, entries, at }) {
  const items = entries.map(({ it, s }) => {
    const gauges = it.economies.map((e) => `${ECONOMIES[e.id]} ${e.score > 0 ? "+" : "−"}${Math.abs(e.score)}`).join(", ");
    const body = [it.summary, s ? `${INDUSTRIES[s.id]}: ${scoreWord(s.score)} (${s.score > 0 ? "+" : "−"}${Math.abs(s.score)}) — ${s.why}` : "", `Why it matters: ${it.rationale}`, gauges ? `Market gauges: ${gauges}` : "", `Confidence: ${it.confidence} · horizon: ${it.horizon}`]
      .filter(Boolean).map((p) => `<p>${esc(p)}</p>`).join("");
    const tag = s ? `[${s.score > 0 ? "+" : "−"}${Math.abs(s.score)}] ` : "";
    return `    <item>
      <title>${esc(tag + it.headline)}</title>
      <link>${esc(it.sources[0] || link)}</link>
      <guid isPermaLink="false">${esc(`mpm-${it.date}-${it.id}`)}</guid>
      <pubDate>${new Date(it.date + "T06:00:00Z").toUTCString()}</pubDate>
      <category>${esc(it.theme)}</category>
      <description>${esc(body)}</description>
    </item>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${esc(title)}</title>
    <link>${esc(link)}</link>
    <description>${esc(description)}</description>
    <language>en-in</language>
    <lastBuildDate>${new Date(at).toUTCString()}</lastBuildDate>
${items.join("\n")}
  </channel>
</rss>
`;
}

function sharePage({ slug, label, net, n, top }) {
  const url = `${SITE_URL}/#sector=${slug}`;
  const title = `${label}: ${word(net).toLowerCase()} today (${signed(net)}) · Market Pressure Map`;
  const desc = n ? `${n} ${n === 1 ? "story" : "stories"} in the last 24 hours. Biggest driver: ${top}` : "No stories touch this sector in the last 24 hours.";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(`${SITE_URL}/sector/${slug}`)}">
<meta name="twitter:card" content="summary">
<link rel="alternate" type="application/rss+xml" title="${esc(label)} · Market Pressure Map" href="/feeds/${slug}.xml">
<link rel="canonical" href="${esc(url)}">
<meta http-equiv="refresh" content="0; url=/#sector=${slug}">
<style>body{font:16px/1.5 system-ui,sans-serif;margin:2rem;color:#15202b;background:#eef1f4}@media (prefers-color-scheme:dark){body{color:#e5eaef;background:#0e1419}a{color:#e3a740}}</style>
</head>
<body>
<p>Opening <a href="/#sector=${slug}">${esc(label)} on Market Pressure Map</a>…</p>
</body>
</html>
`;
}

export async function writeSectorOutputs(scan) {
  await mkdir(new URL("feeds/", DATA), { recursive: true });
  await mkdir(new URL("sector/", DATA), { recursive: true });
  for (const [id, label] of Object.entries(INDUSTRIES)) {
    const slug = SECTOR_SLUGS[id];
    const { stories, net } = sectorView(scan.items, id);
    await writeFile(new URL(`feeds/${slug}.xml`, DATA), rss({
      title: `${label} · Market Pressure Map`,
      description: `Daily news scored for its impact on ${label} in Indian markets. Today: ${word(net).toLowerCase()} (${signed(net)}).`,
      link: `${SITE_URL}/#sector=${slug}`, entries: stories, at: scan.scannedAt,
    }));
    await writeFile(new URL(`sector/${slug}.html`, DATA), sharePage({ slug, label, net, n: stories.length, top: stories[0]?.it.headline || "" }));
  }
  await writeFile(new URL("feeds/all.xml", DATA), rss({
    title: "Market Pressure Map · Indian markets",
    description: "Daily news scored for its impact on Indian market sectors and the rupee, bonds, inflation and foreign flows.",
    link: SITE_URL, entries: scan.items.map((it) => ({ it, s: null })), at: scan.scannedAt,
  }));
}
