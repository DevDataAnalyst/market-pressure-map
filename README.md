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

The page totals the scores, counting high-confidence calls at 1.0, medium at 0.7 and low at 0.4. It also shows the change over the last 24 hours.

## Setup

1. **Add your Anthropic API key:** in the repository on GitHub, go to Settings → Secrets and variables → Actions → New repository secret. Name it `ANTHROPIC_API_KEY`.
2. **Optional, to change the model:** under the Variables tab, add `SCAN_MODEL` (for example `claude-sonnet-5-5`). The default is `claude-opus-5-5`.
3. **Run the first scan:** go to Actions → Hourly news scan → Run workflow.

### Question box ("Ask about the markets")

The page has a question box backed by a Vercel function (`api/ask.js`). It gives Claude the latest scan as context, allows up to two web searches per question, and streams the answer back. To switch it on:

1. In Vercel, open the project → Settings → Environment Variables and add `ANTHROPIC_API_KEY` for Production.
2. Redeploy, or wait for the next hourly data commit.

Optional variables: `ASK_MODEL` (default `claude-opus-5-5`) and `ASK_RATE_LIMIT` (questions per visitor per 10 minutes, default 8). The rate limit is best-effort because serverless instances don't share memory. Set a monthly spend limit on your Anthropic key, since anyone who can open the site can ask questions.

### Cost

Each run sends about 140 headlines and gets back about 15 scored stories. On the default model that's roughly $0.10–0.25 per run, or about $2.50–6 a day at one run an hour. `claude-sonnet-5-5` costs about half as much. Each question in the question box costs roughly $0.02–0.06, including web searches. To run less often, change the cron line in the workflow (for example `7 */3 * * *` for every 3 hours).

## Local use

```bash
npm ci
DRY_RUN=1 npm run refresh               # fetch headlines only, no API call
ANTHROPIC_API_KEY=... npm run refresh   # full scan, writes public/data/
npm run serve                           # view the site locally
```

Scores are a structured judgement about direction and size, not price forecasts or investment advice.
