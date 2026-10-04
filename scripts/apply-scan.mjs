// Entry point for the daily Claude routine, which scores the news on the Claude plan
// instead of the paid API.
//   node scripts/apply-scan.mjs --list-signals   prints the top intelligence signals to assess,
//                                                plus the stories of the previous 7 days for context
//   node scripts/apply-scan.mjs draft.json       validates a draft and writes the site data
// Draft shape: { "items": [story...], "signals": [assessment...] } — see README.
import { readFile } from "node:fs/promises";
import { ECONOMIES, INDUSTRIES, THEMES, fail } from "./shared.mjs";
import { OSINT_PATH, loadMemory, normalizeItems, writeScan } from "./scan-store.mjs";

const arg = process.argv[2];

if (arg === "--list-signals") {
  const osint = JSON.parse(await readFile(OSINT_PATH, "utf8"));
  console.log(`Feed updated ${osint.updatedAt}. Assess these (use "id"):`);
  for (const s of osint.signals.slice(0, 30)) {
    console.log(JSON.stringify({ id: s.id, severity: s.severity, category: s.category, source: `${s.sourceType}: ${s.source}`, places: s.places, title: s.title }));
  }
  const today = new Date().toISOString().slice(0, 10);
  const recent = (await loadMemory()).filter((d) => d.day < today).slice(-7);
  if (recent.length) {
    console.log("\nRecent context (earlier scans; judge whether today's news is new, ongoing, escalating or reversing):");
    for (const d of recent) {
      console.log(`${d.day}:`);
      for (const it of d.items ?? []) console.log(`  - [${it.theme}] ${it.headline}`);
    }
  }
  console.log(`\nIndustry ids: ${Object.keys(INDUSTRIES).join(", ")}\nEconomy ids: ${Object.keys(ECONOMIES).join(", ")}\nThemes: ${THEMES.join(" | ")}`);
  process.exit(0);
}

if (!arg) fail("Usage: node scripts/apply-scan.mjs <draft.json> | --list-signals");
let draft;
try { draft = JSON.parse(await readFile(arg, "utf8")); } catch (err) { fail(`Could not read ${arg}: ${err.message}`); }

const problems = [];
for (const [i, it] of (draft.items ?? []).entries()) {
  const where = `items[${i}] (${it.id || it.headline || "?"})`;
  if (!THEMES.includes(it.theme)) problems.push(`${where}: theme must be one of ${THEMES.join(", ")}`);
  for (const x of [...(it.industries ?? []), ...(it.economies ?? [])]) {
    if (!INDUSTRIES[x.id] && !ECONOMIES[x.id]) problems.push(`${where}: unknown id "${x.id}"`);
    if (!Number.isInteger(x.score) || x.score < -3 || x.score > 3 || x.score === 0) problems.push(`${where}: score for ${x.id} must be a non-zero integer from -3 to 3`);
  }
  if (!(it.sources ?? []).some((u) => /^https:\/\//.test(u))) problems.push(`${where}: needs at least one https source URL`);
}
if (problems.length) fail(`Draft has problems:\n- ${problems.join("\n- ")}`);

const items = normalizeItems(draft.items);
await writeScan({ items, model: draft.model || "Claude daily routine", signals: draft.signals ?? [] });
