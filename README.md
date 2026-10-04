# Market Pressure Map

Where the latest global headlines push the world's biggest industries and economies: tailwind or headwind, how hard, and why. Refreshed daily for free.

- **11 industries:** energy, banks, tech and chips, healthcare, autos, retail and consumer, industrials, materials, agriculture and food, real estate, transport.
- **7 economies:** United States, China, euro area, Japan, India, United Kingdom, Gulf states.
- Stories are written without company names.

## How it works

The site refreshes once a day for free. There's no API key, no AI credit and nothing to switch on:

1. **GitHub Actions** (`.github/workflows/refresh.yml`, "Daily refresh") runs at 05:17 UTC. GitHub sometimes delays or drops scheduled runs, so the job is also scheduled at 08:47, 13:17 and 18:47 UTC; those backup runs stop straight away once today's refresh is done.
   - `scripts/osint.mjs` collects the open-source intelligence feed (`public/data/osint.json`).
   - `scripts/rule-scan.mjs` reads about a dozen Google News market searches plus the intelligence feed, matches each headline to an event rule, groups headlines about the same event into stories and scores them. It writes `scan.json` and `history.json`. Example rules are "oil prices rise", "central bank cuts rates", "new tariffs", "attacks on shipping lanes" and "weaker yen". Each rule carries a reviewed set of industry and economy exposures, and confidence grows with the number of separate reports. Single-firm news, explainers and questions are skipped.
   - **Data window: the last 24 hours.** Only headlines and intelligence signals published in the past 24 hours are scored. Earlier days still count through the story memory (`public/data/memory.json`, the last 14 days of stories, written by every scan). Each new story is marked "New in the last 24 hours", "Ongoing" (with how many of the previous 7 days it appeared and since when) or "Turn" (earlier readings pointed the other way). Ongoing stories rank higher, and a story seen on two or more earlier days goes from low to medium confidence. A turn lowers high confidence to medium.
   - The job commits the data.
2. **Vercel** redeploys the static site on every push.

Running it by hand: Actions → Daily refresh → Run workflow. Tick `publish_rule_scan` to replace today's scan with the keyword-rule scan even if the Claude routine wrote it, or `test_rule_scan` to preview the keyword-rule stories in the run summary without committing.

### Optional: Claude routine (richer write-ups)

A Claude Code routine named "Market Pressure Map daily scan" can run at 05:42 UTC. It uses your Claude plan's usage, not API credit. It searches the last 24 hours of news, reads the previous 7 days of stories from the story memory (`--list-signals` prints them) to judge whether each development is new, ongoing, escalating or reversing, writes 8–16 stories in its own words and scores them by judgement. It also assesses the top 30 intelligence signals. When it has written a scan in the last 20 hours, the keyword-rule step leaves that scan alone, and history keeps one point per day. To rely on the free rules only, pause the routine in claude.ai under Routines; nothing else changes. The routine writes a draft and runs `node scripts/apply-scan.mjs draft.json`, which checks the draft and writes the site data.

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

Each signal is tagged by rules with a category, the places, industries and economies it exposes, and a severity (watch, elevated or high). Severity rises with intensity words, disaster alert level, earthquake magnitude and how many separate sources report the same thing. Near-duplicate reports are merged. Headlines that name companies are dropped. The keyword-rule scan gives signals that match an event rule a short note and signed scores. When the optional Claude routine runs, it assesses the top 30 signals with a neutral headline, a market-impact risk level, a note and scores, and those assessments take precedence. Assessed signals show as "Assessed". The feed is written to `public/data/osint.json` and is published even when the scoring step doesn't run.

## Drill-down

Select any industry or economy (in the bars, the headline verdicts, the exposure grid or a signal's chips) to open its details: net score and 24-hour change, a 7-day trend line, where the pressure lands across the other dimension, the stories driving it, related intelligence signals, and a shortcut to ask the desk about it. The industry × economy grid opens the stories linking any pair. Details have shareable links such as `#ind-energy`, `#eco-india` or `#pair-energy-india`.

The page totals the scores, counting high-confidence calls at 1.0, medium at 0.7 and low at 0.4. It also shows the change over the last 24 hours.

## Setup

1. **Daily refresh:** runs automatically on GitHub Actions; nothing to set up. To run it by hand, go to Actions → Daily refresh → Run workflow.
2. **Claude routine:** optional (see above). You can pause or resume it in claude.ai under Routines.
3. **Paid API mode and the question box:** optional; see below.

### Question box ("Ask about the markets")

The question box answers live, so it needs Anthropic API credit. It stays hidden unless it's switched on. To switch it on, add these in Vercel → Settings → Environment Variables (Production), then redeploy:

- `ANTHROPIC_API_KEY`: a key created inside a workspace, on an account with credit.
- `ASK_ENABLED` = `true`.

Optional variables: `ASK_MODEL` (default `claude-opus-5-5`) and `ASK_RATE_LIMIT` (questions per visitor per 10 minutes, default 8). The rate limit is best-effort because serverless instances don't share memory. Set a monthly spend limit, since anyone who can open the site can ask questions.

### Cost

The daily refresh runs on GitHub's free Actions minutes and costs nothing. The optional Claude routine counts toward your Claude plan's usage limits. In paid API mode, each scan costs roughly $0.10–0.25 on the default model, and each question-box question about $0.02–0.06.

## Local use

```bash
npm ci
node scripts/osint.mjs                  # intelligence feed, no API key
node scripts/rule-scan.mjs              # free keyword-rule scan, no API key
DRY_RUN=1 npm run refresh               # fetch headlines only, no API call
ANTHROPIC_API_KEY=... npm run refresh   # full scan, writes public/data/
npm run serve                           # view the site locally
```

Scores are a structured judgement about direction and size, not price forecasts or investment advice.
