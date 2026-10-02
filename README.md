# Market Pressure Map

Where the latest global headlines push the world's biggest industries and economies: tailwind or headwind, how hard, and why. Refreshed daily.

- **11 industries:** energy, banks, tech and chips, healthcare, autos, retail and consumer, industrials, materials, agriculture and food, real estate, transport.
- **7 economies:** United States, China, euro area, Japan, India, United Kingdom, Gulf states.
- Stories are written without company names.

## How it works

The site refreshes once a day, with no paid API credit needed:

1. **05:17 UTC, GitHub Actions** (`.github/workflows/refresh.yml`): `scripts/osint.mjs` collects the open-source intelligence feed and commits `public/data/osint.json`. This needs no key.
2. **05:42 UTC, a Claude Code routine** (scheduled in claude.ai, using the Claude plan rather than API credit): searches the day's market news, picks the 12–16 most market-moving developments, and scores each one from −3 (strong headwind) to +3 (strong tailwind) for every industry and economy it affects. It also assesses the top 30 intelligence signals. It writes a draft, and `node scripts/apply-scan.mjs draft.json` checks it and writes `scan.json`, `history.json` and the signal assessments. The routine then commits and pushes.
3. **Vercel** redeploys the static site on every push.

### Optional: paid API mode

`scripts/refresh.mjs` does the same scoring through the Anthropic API from inside GitHub Actions, using RSS feeds. It's off by default. To use it, add a repository secret `ANTHROPIC_API_KEY` (from a key created inside a workspace, with credit on the account) and a repository variable `SCAN_WITH_API` = `true`. You can then pause the Claude routine.

### Draft format for `apply-scan.mjs`

```json
{
  "items": [{ "id": "hormuz", "date": "2026-10-02", "theme": "Energy & geopolitics", "headline": "…", "summary": "…", "rationale": "…",
              "horizon": "weeks", "confidence": "high", "industries": [{ "id": "energy", "score": 2, "why": "…" }],
              "economies": [{ "id": "india", "score": -2, "why": "…" }], "sources": ["https://…"] }],
  "signals": [{ "id": "<signal id from --list-signals>", "headline": "…", "risk": "high", "note": "…", "industries": [], "economies": [] }]
}
```

`node scripts/apply-scan.mjs --list-signals` prints the signals to assess and the allowed ids and themes.

## Open-source intelligence feed

`scripts/osint.mjs` runs in the daily job and needs no API key. It collects geopolitical and economic signals from open sources:

- **Media monitoring:** Google News topic searches and GDELT (which watches world news in many languages) for sanctions and trade, conflict, shipping chokepoints and energy supply. GDELT often rate-limits GitHub's servers, so Google News is the main media source.
- **Conflict and humanitarian:** UN News, ReliefWeb and Crisis Group.
- **Hazards:** GDACS disaster alerts (orange and red only) and USGS significant earthquakes.
- **Official:** Federal Reserve, ECB, Bank of England, WTO and the US Energy Information Administration.

Each signal is tagged by rules with a category, the places, industries and economies it exposes, and a severity (watch, elevated or high). Severity rises with intensity words, disaster alert level, earthquake magnitude and how many separate sources report the same thing. Near-duplicate reports are merged. Headlines that name companies are dropped. When the daily Claude routine runs, it also assesses the top 30 signals with a neutral headline, a market-impact risk level, a short note and signed scores; those signals show as "Assessed". The feed is written to `public/data/osint.json` and is published even when the scoring step doesn't run.

## Drill-down

Select any industry or economy (in the bars, the headline verdicts, the exposure grid or a signal's chips) to open its details: net score and 24-hour change, a 7-day trend line, where the pressure lands across the other dimension, the stories driving it, related intelligence signals, and a shortcut to ask the desk about it. The industry × economy grid opens the stories linking any pair. Details have shareable links such as `#ind-energy`, `#eco-india` or `#pair-energy-india`.

The page totals the scores, counting high-confidence calls at 1.0, medium at 0.7 and low at 0.4. It also shows the change over the last 24 hours.

## Setup

1. **Daily scoring:** a Claude Code routine named "Market Pressure Map daily scan" runs at 05:42 UTC. You can manage or pause it in claude.ai under Routines.
2. **Intelligence feed:** runs automatically. To run it by hand, go to Actions → Daily intelligence feed → Run workflow.
3. **Paid API mode and the question box:** optional; see below.

### Question box ("Ask about the markets")

The question box answers live, so it needs Anthropic API credit. It stays hidden unless it's switched on. To switch it on, add these in Vercel → Settings → Environment Variables (Production), then redeploy:

- `ANTHROPIC_API_KEY`: a key created inside a workspace, on an account with credit.
- `ASK_ENABLED` = `true`.

Optional variables: `ASK_MODEL` (default `claude-opus-5-5`) and `ASK_RATE_LIMIT` (questions per visitor per 10 minutes, default 8). The rate limit is best-effort because serverless instances don't share memory. Set a monthly spend limit, since anyone who can open the site can ask questions.

### Cost

The daily routine and the intelligence feed cost nothing beyond your Claude plan and GitHub's free Actions minutes. The routine counts toward your plan's usage limits. In paid API mode, each scan costs roughly $0.10–0.25 on the default model, and each question-box question about $0.02–0.06.

## Local use

```bash
npm ci
node scripts/osint.mjs                  # intelligence feed only, no API key
DRY_RUN=1 npm run refresh               # fetch headlines only, no API call
ANTHROPIC_API_KEY=... npm run refresh   # full scan, writes public/data/
npm run serve                           # view the site locally
```

Scores are a structured judgement about direction and size, not price forecasts or investment advice.
