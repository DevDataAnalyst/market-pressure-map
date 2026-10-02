# Market Pressure Map

Where the latest global headlines push the world's biggest industries and economies: tailwind or headwind, how hard, and why. Refreshed every hour.

- **11 industries:** energy, banks, tech and chips, healthcare, autos, retail and consumer, industrials, materials, agriculture and food, real estate, transport.
- **7 economies:** United States, China, euro area, Japan, India, United Kingdom, Gulf states.
- Stories are written without company names.

## How it works

1. A GitHub Actions job (`.github/workflows/refresh.yml`) runs at 7 minutes past every hour.
2. `scripts/refresh.mjs` pulls about 14 public business and world RSS feeds and keeps the last 36 hours of headlines.
3. Claude picks the 12–16 most market-moving developments and scores each one from −3 (strong headwind) to +3 (strong tailwind) for every industry and economy it affects. The script checks the output and keeps the previous scan if anything looks wrong.
4. The job commits `public/data/scan.json` and `public/data/history.json`. Vercel redeploys the static site on every push.

## Open-source intelligence feed

`scripts/osint.mjs` runs first in every hourly job and needs no API key. It collects geopolitical and economic signals from open sources:

- **Media monitoring:** GDELT, which watches world news in many languages, queried in one request for sanctions and trade, conflict, shipping chokepoints and energy supply.
- **Conflict and humanitarian:** UN News, ReliefWeb and Crisis Group.
- **Hazards:** GDACS disaster alerts (orange and red only) and USGS significant earthquakes.
- **Official:** Federal Reserve, ECB, Bank of England, WTO and the US Energy Information Administration.

Each signal is tagged by rules with a category, the places, industries and economies it exposes, and a severity (watch, elevated or high). Severity rises with intensity words, disaster alert level, earthquake magnitude and how many separate sources report the same thing. Near-duplicate reports are merged. Headlines that name companies are dropped. When the Claude scan runs, it also assesses the top 30 signals with a neutral headline, a market-impact risk level, a short note and signed scores; those signals show as "Assessed". The feed is written to `public/data/osint.json` and is committed even if the Claude scan fails.

## Drill-down

Select any industry or economy (in the bars, the headline verdicts, the exposure grid or a signal's chips) to open its details: net score and 24-hour change, a 7-day trend line, where the pressure lands across the other dimension, the stories driving it, related intelligence signals, and a shortcut to ask the desk about it. The industry × economy grid opens the stories linking any pair. Details have shareable links such as `#ind-energy`, `#eco-india` or `#pair-energy-india`.

The page totals the scores, counting high-confidence calls at 1.0, medium at 0.7 and low at 0.4. It also shows the change over the last 24 hours.

## Setup

1. **Add your Anthropic API key:** in the repository on GitHub, go to Settings → Secrets and variables → Actions → New repository secret. Name it `ANTHROPIC_API_KEY`.
2. **If your key isn't scoped to a workspace:** the API rejects requests unless they name a workspace. Add a repository variable or secret `ANTHROPIC_WORKSPACE_ID` (it starts with `wrkspc_`; find it in the Claude Console under Settings → Workspaces). Alternatively, create a new API key inside a workspace and use that instead.
3. **Optional, to change the model:** under the Variables tab, add `SCAN_MODEL` (for example `claude-sonnet-5-5`). The default is `claude-opus-5-5`.
4. **Run the first scan:** go to Actions → Hourly news scan → Run workflow.

### Question box ("Ask about the markets")

The page has a question box backed by a Vercel function (`api/ask.js`). It gives Claude the latest scan as context, allows up to two web searches per question, and streams the answer back. To switch it on:

1. In Vercel, open the project → Settings → Environment Variables and add `ANTHROPIC_API_KEY` for Production.
2. Redeploy, or wait for the next hourly data commit.

If your key needs a workspace, also add `ANTHROPIC_WORKSPACE_ID` there. Optional variables: `ASK_MODEL` (default `claude-opus-5-5`) and `ASK_RATE_LIMIT` (questions per visitor per 10 minutes, default 8). The rate limit is best-effort because serverless instances don't share memory. Set a monthly spend limit on your Anthropic key, since anyone who can open the site can ask questions.

### Cost

Each run sends about 140 headlines and gets back about 15 scored stories. On the default model that's roughly $0.10–0.25 per run, or about $2.50–6 a day at one run an hour. `claude-sonnet-5-5` costs about half as much. Each question in the question box costs roughly $0.02–0.06, including web searches. To run less often, change the cron line in the workflow (for example `7 */3 * * *` for every 3 hours).

## Local use

```bash
npm ci
node scripts/osint.mjs                  # intelligence feed only, no API key
DRY_RUN=1 npm run refresh               # fetch headlines only, no API call
ANTHROPIC_API_KEY=... npm run refresh   # full scan, writes public/data/
npm run serve                           # view the site locally
```

Scores are a structured judgement about direction and size, not price forecasts or investment advice.
