# Market Pressure Map

Where the last 24 hours of news push Indian markets: tailwind or headwind, how hard, and why. Indian news comes first; foreign news is included only when it reaches Indian markets (oil and gas, US rates and the dollar, trade, metal and food prices, foreign investor flows). Refreshed daily for free.

- **11 Indian sectors:** oil, gas and power; banks and NBFCs; IT services; pharma and healthcare; autos; FMCG and consumer; capital goods and infra; metals, cement and chemicals; agri and fertilisers; real estate; aviation, shipping and logistics. (Ids in the data files: energy, financials, tech, healthcare, autos, consumer, industrials, materials, agrifood, realestate, transport.)
- **7 India market gauges** (stored under `economies`; positive = good for Indian markets): equities (Nifty and Sensex), rupee, bond market (G-Secs), inflation outlook, fiscal and trade balance, foreign investor flows, growth outlook.
- Stories are written without company names.
- **Personalised per visitor, no account:** on first visit the page asks which sectors you follow (up to three) and, optionally, what describes you (investor, exporter, importer, borrower, following the economy). It then leads with your sectors, puts the stories that move them first ("For you", with the rest folded below), pins and highlights them in the sector bars, narrows the exposure grid and signals to them, and suggests matching questions. Choices are saved only in the browser (`localStorage`); "Show everything" switches back to the full view.
- **Role lenses:** the role changes what counts as good or bad. Each role weighs the market gauges that matter to it and reverses some: for an exporter a weaker rupee is a tailwind; for a saver higher bond yields are a tailwind; an importer weighs the rupee and the import bill more; a borrower weighs bond yields and inflation more. The page shows one reading for the user ("For an exporter, today reads a headwind", with the main tailwind and headwind), marks each story "Good for you" or "Bad for you", notes reversed or heavier gauges, and counts stories the lens moves as "For you" even outside the chosen sectors. Readings are averaged per gauge so roles are comparable.

## How it works

The site refreshes once a day for free. There's no API key, no AI credit and nothing to switch on:

1. **GitHub Actions** (`.github/workflows/refresh.yml`, "Daily refresh") runs at 05:17 UTC. GitHub sometimes delays or drops scheduled runs, so the job is also scheduled at 08:47, 13:17 and 18:47 UTC; those backup runs stop straight away once today's refresh is done.
   - `scripts/osint.mjs` collects the open-source intelligence feed (`public/data/osint.json`).
   - `scripts/rule-scan.mjs` reads about fifteen India-focused Google News searches (Indian edition) plus the intelligence feed, matches each headline to an event rule, groups headlines about the same event into stories and scores them. It writes `scan.json` and `history.json`. Example rules are "oil prices rise", "central bank cuts rates", "new tariffs", "attacks on shipping lanes" and "weaker yen". Each rule carries a reviewed set of industry and economy exposures, and confidence grows with the number of separate reports. Single-firm news, explainers and questions are skipped.
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
              "economies": [{ "id": "rupee", "score": -2, "why": "…" }], "sources": ["https://…"] }],
  "signals": [{ "id": "<signal id from --list-signals>", "headline": "…", "risk": "high", "note": "…", "industries": [], "economies": [] }]
}
```

`node scripts/apply-scan.mjs --list-signals` prints the signals to assess and the allowed ids and themes.

## Open-source intelligence feed

`scripts/osint.mjs` runs in the daily job and needs no API key. It collects geopolitical and economic signals from open sources:

- **Media monitoring:** Google News topic searches and GDELT (which watches world news in many languages) for sanctions and trade, conflict, shipping chokepoints and energy supply. GDELT often rate-limits GitHub's servers, so Google News is the main media source.
- **Conflict and humanitarian:** UN News, ReliefWeb and Crisis Group.
- **Hazards:** GDACS disaster alerts (orange and red only) and USGS significant earthquakes.
- **Official:** RBI, SEBI, Federal Reserve, WTO and the US Energy Information Administration.

Signals are kept only when they reach Indian markets: anything about India, oil and gas routes and suppliers (the Gulf, Russia, the Red Sea and Hormuz), India's neighbours, energy, shipping, sanctions and food supply, and US monetary policy.

Each signal is tagged by rules with a category, the places and sectors it exposes, and a severity (watch, elevated or high). Severity rises with intensity words, disaster alert level, earthquake magnitude and how many separate sources report the same thing. Near-duplicate reports are merged. Headlines that name companies are dropped. The keyword-rule scan gives signals that match an event rule a short note and signed scores. When the optional Claude routine runs, it assesses the top 30 signals with a neutral headline, a market-impact risk level, a note and scores, and those assessments take precedence. Assessed signals show as "Assessed". The feed is written to `public/data/osint.json` and is published even when the scoring step doesn't run.

## Drill-down

Select any sector or gauge (in the bars, the headline verdicts, the exposure grid or a signal's chips) to open its details: net score and 24-hour change, a 7-day trend line, where the pressure lands across the other dimension, the stories driving it, related intelligence signals, and a shortcut to ask the desk about it. The industry × economy grid opens the stories linking any pair. Details have shareable links such as `#ind-energy`, `#eco-india` or `#pair-energy-india`.

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
