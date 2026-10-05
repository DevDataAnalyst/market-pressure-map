// Free daily scan: scores the day's market news with keyword rules, no AI and no API key.
// Collects market headlines (Google News searches) plus the intelligence feed (osint.json),
// matches each headline to an event rule (oil prices up, rate cut, new tariffs...), groups
// matching headlines into stories and writes scan.json and history.json via writeScan.
//   node scripts/rule-scan.mjs            fetch headlines and write the scan
//   node scripts/rule-scan.mjs file.json  score headlines from a file ([{title, link, source, published}]) instead
//   DRY_RUN=1 prints the stories (and a GitHub run summary) without writing anything
// Only headlines from the last 24 hours are scored; the story memory (memory.json) from earlier
// days marks each story as new, ongoing or a reversal and adjusts its confidence and rank.
// If the Claude routine already wrote a scan in the last 20 hours, this leaves it alone.
import { appendFile, readFile } from "node:fs/promises";
import { fetchFeed, titleKey, txt } from "./shared.mjs";
import { COMPANY_MARKERS, COMPANY_NAMES } from "./osint.mjs";
import { OSINT_PATH, SCAN_PATH, loadMemory, normalizeItems, writeScan } from "./scan-store.mjs";

const MODEL = "Keyword rules (no AI)";
const MAX_ITEMS = 16;
const WINDOW_HOURS = 24;
const CONTEXT_DAYS = 7;
const warn = (msg) => console.warn(process.env.GITHUB_ACTIONS ? `::warning::${msg}` : msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Indian market news first, then the foreign drivers that reach Indian markets.
const SEARCHES = [
  'RBI OR "repo rate" OR "Reserve Bank of India" OR "monetary policy committee"',
  'rupee dollar OR "forex reserves" OR "Indian rupee"',
  '"bond yields" India OR "G-Sec" OR "government securities" OR "10-year yield" RBI',
  'India inflation OR CPI OR WPI OR "food inflation" OR "retail inflation"',
  'India GDP OR PMI OR "industrial output" OR IIP OR "core sector" OR "GST collections"',
  '"trade deficit" India OR "fiscal deficit" OR "current account deficit" OR exports India',
  'FPI OR FII OR "foreign investors" Indian equities OR "foreign portfolio"',
  'monsoon OR kharif OR rabi OR sowing OR IMD rainfall',
  'India tariffs OR "trade deal" India OR "import duty" OR "export duty" OR "anti-dumping" India',
  '"crude oil" OR brent OR OPEC OR "oil prices" India',
  '"Strait of Hormuz" OR "Red Sea" OR "Russian oil" OR LNG India',
  '"Federal Reserve" OR "Fed rate" OR "Treasury yields" OR "dollar index" OR "US inflation"',
  '"steel prices" OR "metal prices" OR copper OR aluminium OR "gold price" India',
  'India budget OR capex OR "government spending" OR "infrastructure" OR "tax cuts" India',
  '"IT services" demand OR "tech spending" OR "AI spending" India',
];

// ---------- direction words ----------
const UP = /\b(rise[sn]?|rising|rose|jump(s|ed|ing)?|surg(e|es|ed|ing)|soar(s|ed|ing)?|climb(s|ed|ing)?|gain(s|ed)?|rall(y|ies|ied)|spik(e|es|ed)|higher|highs?|record high|tops?|top(ped)?|accelerat\w*|hotter|stronger|strengthen\w*|beat(s)?|boost(s|ed)?|rebound(s|ed)?|up \d|increase[sd]?|expand(s|ed|ing)?|grow(s|n|ing)?|grew|widen(s|ed|ing)?)\b/i;
const DOWN = /\b(fall(s|ing)?|fell|drop(s|ped)?|slid(e|es)?|slump(s|ed)?|plung(e|es|ed)|tumbl(e|es|ed)|sink(s)?|sank|declin(e|es|ed|ing)|lower|lows?|weak(er|ens?|ened|ening)?|cool(s|ed|ing)?|eas(e|es|ed|ing)|slow(s|ed|ing|down)?|miss(es|ed)?|contract(s|ed|ion)?|shrink(s|ing)?|shr[au]nk|retreat(s|ed)?|down \d|decrease[sd]?|lowest|tumbling|sliding|narrow(s|ed|ing)?|slip(s|ped|ping)?|dip(s|ped)?|soften(s|ed|ing)?)\b/i;
const INTENSE = /\b(surg|soar|plung|tumbl|record|spik|biggest|sharpest|crisis|collapse|shock|crash|slump)/i;
const SPECULATIVE = /\b(will|could|may|might|expected to|expects?|forecast|predict|outlook|seen|eyes?|weighs?|considers?|mulls?|threatens?|warns?|if )\b/i;
// Opinion, explainers, how-tos and single-firm news aren't market-wide events.
const SKIP = /\?|^\d+\.\s|\b(wins?|bags?|secures?|lands?|signs?) (an? )?(\$|rs\.? ?|₹)?[\d.,]+ ?(million|billion|crore|bn|mn|cr)?\b.*\b(deal|order|contract)s?\b|\|.*\||^(how|why|what|inside|explainer)\b|^\d+ (trends|things|reasons|ways|stocks|charts)\b|\b(opinion|explainer|explained|what to know|what it means|how to|here's why|preview|these \d+ factors|factors to watch|things to watch|live updates|live news|live blog|latest live|live:|week ahead|to test markets|price update|short-term scenario|podcast|video|watch:|newsletter|shares of|stock of|'s shares|earnings|quarterly results|q[1-4] results|ipo|ceo|top picks|stocks to buy|stocks? that could|could benefit|black[- ]market|parallel market|informal (currency |exchange |forex )?market|(dow( jones)?|stocks?|stock market|wall street|markets?|sensex|nifty) today)\b|\b\d+\s+[\w.'-]+(\s+[\w.'-]+){0,3}\s+stocks\b/i;
// Ticker lists ("ORCL, TSLA In Focus") mark single-stock market wraps.
const TICKERS = /\b[A-Z][\w&.-]+( [A-Z][\w&.-]+){0,3}['’]s( [A-Z][\w-]+){0,2} ([Pp]roject|[Mm]ine|[Pp]lant|[Rr]efinery|[Ff]actory|[Dd]eal|[Bb]id|[Ss]take|[Bb]onds?|[Ss]hares|[Ss]tock|[Rr]esults|[Pp]rofit|[Rr]evenue|CEO)\b|\b[A-Z]{2,6} results\b|:\s*[A-Z]{2,5}(,\s*[A-Z]{2,5})+\b|\b[A-Z]{3,5}(,\s*[A-Z]{3,5}){3,}\b/;
// Lead-headline preference: global or official sources over local angles.
const GLOBAL_BODY = /\b(RBI|SEBI|Finance Ministry|NSO|MoSPI|IMD|PIB|CAG|FAO|IMF|World Bank|WTO|OECD|IEA|OPEC\+?|EIA|UN|United Nations|G-?7|G-?20|BIS|Fed|Federal Reserve|FOMC|ECB|European Central Bank|Bank of England|BoE|Bank of Japan|BoJ|BOJ|RBI|Reserve Bank|PBOC|PBoC|People's Bank|Eurostat|Treasury)\b/;
const GLOBAL_WORD = /\b(global|world|worldwide|international|benchmark|Brent)\b/i;
const WIRE = /\b(Reuters|Economic Times|ET|Mint|Livemint|Business Standard|Moneycontrol|PTI|Hindu BusinessLine|BusinessLine|Financial Express|NDTV Profit|CNBC-TV18|Bloomberg|Financial Times|FT|Associated Press|AP|Wall Street Journal|WSJ|CNBC|BBC|Economist|Nikkei|Al Jazeera|AFP|Barron's|MarketWatch)\b/i;
const LOCAL = /\b(mandi|tola|per kg|per quintal|district|municipal|village|panchayat|taluk|tehsil|city|county|local)\b/i;
const leadScore = (h) => (GLOBAL_BODY.test(h.title) ? 2 : 0) + (GLOBAL_WORD.test(h.title) ? 1 : 0) + (WIRE.test(h.source || "") ? 1 : 0) - (LOCAL.test(h.title) ? 3 : 0);
// Long-range forecasts ("by 2050") aren't news about the next weeks or months.
const LONG_RANGE = new RegExp(`\\b(by|in|until|through|to) (${Array.from({ length: 70 }, (_, i) => new Date().getUTCFullYear() + 2 + i).join("|")})\\b`, "i");

const dirOf = (t) => {
  const u = UP.test(t), d = DOWN.test(t);
  return u === d ? 0 : u ? 1 : -1;
};
// Direction from the words right after the subject ("Copper ticks up as Fed bets cool" is about copper
// rising), falling back to the whole headline.
const NUDGE_UP = /\b(ticks?|edges?|inch(es)?|moves?|creeps?) (up|higher)\b|\b(relief|recover\w*|firm(s|ed|er)?|steadies)\b/i;
const NUDGE_DOWN = /\b(ticks?|edges?|inch(es)?|moves?|creeps?) (down|lower)\b/i;
function dirNear(t, re) {
  const at = t.search(re);
  if (at < 0) return dirOf(t);
  const near = t.slice(at, at + 50);
  const pos = (r) => { const m = near.match(r); return m ? m.index : Infinity; };
  const up = Math.min(pos(UP), pos(NUDGE_UP)), down = Math.min(pos(DOWN), pos(NUDGE_DOWN));
  return up < down ? 1 : down < up ? -1 : dirOf(t);
}

// ---------- source economies ----------
// Which economy a headline is about. Only India and the economies whose news reaches Indian
// markets (US rates and demand, China's metals demand) have scored variants; the rest are skipped.
const ECON = [
  ["india", /\b(India|Indian|RBI|Reserve Bank of India|MPC|rupee|Sensex|Nifty|Dalal Street|SEBI|G-?Secs?|GST|Mumbai|Delhi|Sitharaman|NSO|MoSPI|kharif|rabi|Union Budget|Union government|Centre)\b/],
  ["us", /\b(United States|U\.S\.|US|USA|America(n)?|Washington|Fed|Federal Reserve|FOMC|Powell|Treasur(y|ies)|payrolls|Wall Street|Trump)\b/],
  ["china", /\b(China|Chinese|Beijing|PBOC|PBoC|People's Bank|yuan|renminbi)\b/],
  ["eurozone", /\b([Ee]uro[- ]?zone|[Ee]uro[- ]area|ECB|European Central Bank|EU|European Union|Germany|German|France|French|Italy|Italian|Spain|Spanish|bunds?)\b/],
  ["japan", /\b(Japan|Japanese|Tokyo|BoJ|BOJ|Bank of Japan|yen|JGBs?|Nikkei)\b/],
  ["uk", /\b(UK|U\.K\.|Britain|British|England|BoE|Bank of England|gilts?|sterling|pound)\b/],
];
const econsOf = (t) => ECON.filter(([, re]) => re.test(t)).map(([id]) => id);
const BANKS = [["india", /\b(RBI|Reserve Bank of India|MPC)\b/], ["us", /\b(Fed|Federal Reserve|FOMC|Powell)\b/]];
const PREFER = ["india", "us", "china"];
const ECO_NAMES = { india: "India", us: "US", china: "China", global: "global" };

// ---------- event rules ----------
// up/down: { label, rationale, ind: { sector: [score, why] }, eco: { gauge: [score, why] } }.
// byEcon rules key up/down by the economy the headline is about (india, us, china, global);
// a headline about an economy with no variant is skipped as not relevant to Indian markets.
const FOREIGN_RATES = "Higher US rates and yields pull foreign money out of emerging markets, weaken the rupee and push up Indian bond yields.";
const FOREIGN_EASE = "Lower US rates and yields send foreign money back to emerging markets, supporting the rupee, Indian bonds and equities.";
const RULES = [
  {
    id: "rates", theme: "Monetary policy", horizon: "months", weight: 3, byEcon: true, needsEconomy: true,
    subject: /\b(Fed|Federal Reserve|FOMC|RBI|Reserve Bank of India|MPC|repo rate)\b/,
    dir: (t) => /\b(hike[sd]?|hiking|rais(e|es|ed|ing) (the )?(interest |repo )?rates?|tighten\w*|hawkish)\b/i.test(t) ? (/\b(dims?|dimm\w*|fad(e|es|ed|ing)|reduced|lower(ed)? (prospects|odds|bets)|bets cool\w*|eas(e|es|ed|ing)|fears? (eas|fad|recede)\w*|fall(s|en)?|fell|drop(s|ped)?|slip\w*|pare[sd]?|scal(e|es|ed) back|less likely|unwind\w*|cool(s|ed)?|cut(s)? (the )?odds|lower(s|ed)? (the )?odds)\b/i.test(t) ? -1 : 1) : /\b(cut(s|ting)?|lower(s|ed|ing)? (the )?(interest |repo )?rates?|eas(e|es|ed|ing)|dovish|rate reduction)\b/i.test(t) ? -1 : 0,
    up: {
      india: {
        label: "RBI tightening",
        rationale: "A higher repo rate lifts loan rates for homes, vehicles and businesses and pushes up bond yields, though it supports the rupee and lenders' margins at first.",
        ind: { realestate: [-2, "Home loans get dearer"], autos: [-1, "Vehicle loans get dearer"], consumer: [-1, "Dearer credit squeezes spending"], financials: [1, "Lending margins widen at first"] },
        eco: { bonds: [-2, "G-Sec yields rise"], equities: [-1, "Higher discount rates"], growth: [-1, "Credit growth slows"], rupee: [1, "Wider rate gap supports the rupee"] },
      },
      us: {
        label: "tighter US monetary policy", rationale: FOREIGN_RATES,
        ind: { financials: [-1, "Foreign selling in heavyweight lenders"], realestate: [-1, "Funding costs rise"] },
        eco: { flows: [-2, "Foreign investors move money to the US"], rupee: [-1, "Dollar strengthens"], bonds: [-1, "Indian yields follow US yields up"], equities: [-1, "Risk appetite falls"] },
      },
    },
    down: {
      india: {
        label: "RBI easing",
        rationale: "A lower repo rate cuts loan rates and bond yields, supporting housing, vehicle sales and borrowing, though lenders' margins narrow.",
        ind: { realestate: [2, "Cheaper home loans"], autos: [1, "Cheaper vehicle loans"], consumer: [1, "Cheaper credit supports spending"], financials: [-1, "Margins narrow as loans reprice"] },
        eco: { bonds: [2, "G-Sec yields fall"], equities: [1, "Lower discount rates"], growth: [1, "Credit growth picks up"], rupee: [-1, "Narrower rate gap"] },
      },
      us: {
        label: "easier US monetary policy", rationale: FOREIGN_EASE,
        ind: { financials: [1, "Foreign buying returns to lenders"], realestate: [1, "Funding costs ease"] },
        eco: { flows: [2, "Foreign money returns to emerging markets"], rupee: [1, "Dollar softens"], bonds: [1, "Indian yields follow US yields down"], equities: [1, "Risk appetite improves"] },
      },
    },
  },
  {
    id: "tariffs", theme: "Trade", horizon: "months", weight: 3, byEcon: true,
    subject: /\b(tariffs?|trade war|trade deal|trade agreement|trade pact|pact|FTA|trade truce|trade talks|import duty|import duties|export duty|duties on|levies on|anti-dumping)\b/i,
    dir: (t) => /\b(deal|agreement|pact|truce|cut(s|ting)?|lift(s|ed|ing)?|remov(e|es|ed)|paus(e|es|ed)|exempt\w*|lower(s|ed)?|relief|progress|breakthrough|accelerat\w*)\b/i.test(t) ? -1 : /\b(impos\w*|rais\w*|hike[sd]?|new|threat\w*|slap\w*|retaliat\w*|escalat\w*|double[sd]?|steeper|higher|announce[sd]?|war|probe)\b/i.test(t) ? 1 : 0,
    up: {
      india: {
        label: "higher trade barriers on Indian goods",
        rationale: "Tariffs on Indian exports hit engineering goods, auto parts, farm and seafood shipments, widening the trade gap and weighing on the rupee and growth.",
        ind: { industrials: [-1, "Engineering exports taxed"], autos: [-1, "Auto-parts exports exposed"], agrifood: [-1, "Farm and seafood exports exposed"] },
        eco: { growth: [-1, "Exports slow"], rupee: [-1, "Weaker export earnings"], fiscal: [-1, "Trade deficit widens"], equities: [-1, "Exporters de-rated"] },
      },
      global: {
        label: "global trade barriers",
        rationale: "Tariff escalation between major economies slows world trade and demand for Indian exports, though some supply chains may shift towards India.",
        ind: { industrials: [-1, "Slower world trade"] },
        eco: { growth: [-1, "Weaker global demand for exports"] },
      },
    },
    down: {
      india: {
        label: "trade deal or tariff relief for India",
        rationale: "Lower tariffs or a trade deal open markets for Indian exporters and attract investment into export manufacturing.",
        ind: { industrials: [1, "Engineering exports gain access"], autos: [1, "Auto-parts exports gain"], agrifood: [1, "Farm exports gain access"] },
        eco: { growth: [1, "Exports pick up"], rupee: [1, "Better export earnings"], equities: [1, "Exporters re-rated"] },
      },
      global: {
        label: "easing global trade barriers",
        rationale: "Trade truces between major economies support world trade and demand for Indian exports.",
        ind: { industrials: [1, "World trade recovers"] },
        eco: { growth: [1, "Better global demand"] },
      },
    },
  },
  {
    id: "chokepoints", theme: "Energy & geopolitics", horizon: "weeks", weight: 3,
    subject: /\b(Hormuz|Red Sea|Bab el|Bab al|Suez|Black Sea|Houthis?|tankers?|shipping lanes?|blockade)\b/i,
    gate: /\b(attack\w*|hit|struck|strikes?|seiz\w*|blockade|missile|drone|projectile|disrupt\w*|clos(e|ed|ure)|chokehold|threat\w*|war-risk|insurance|reroute\w*|halt\w*|plunge|zero|offensive|reopen\w*|resum\w*|recover\w*|ceasefire|truce|safe passage)\b/i,
    dir: (t) => /\b(reopen\w*|resum\w*|recover\w*|ceasefire|truce|safe passage|eas(e|es|ed|ing))\b/i.test(t) && !/\b(doubts?|fail\w*|stall\w*|collaps\w*|no sign|despite)\b/i.test(t) ? -1 : 1,
    up: {
      label: "shipping chokepoint disruption",
      rationale: "India imports most of its crude and much of its LNG through Hormuz and the Red Sea; disruption lifts oil, freight and insurance costs, widening the import bill and pressuring the rupee.",
      ind: { transport: [-2, "Freight, insurance and fuel costs rise"], energy: [-1, "Fuel marketers' margins squeezed"], materials: [-1, "Crude-linked inputs costlier"], consumer: [-1, "Imported inputs costlier"] },
      eco: { fiscal: [-2, "Oil import bill swells"], inflation: [-1, "Fuel and freight costs"], rupee: [-1, "Importers' dollar demand rises"], equities: [-1, "Risk premium on Indian assets"] },
    },
    down: {
      label: "shipping lanes reopening",
      rationale: "Safer passage through Hormuz and the Red Sea eases oil, freight and insurance costs for an import-dependent India.",
      ind: { transport: [2, "Shorter routes, lower insurance"], energy: [1, "Marketers' margins recover"], consumer: [1, "Input costs ease"] },
      eco: { fiscal: [1, "Import bill eases"], inflation: [1, "Fuel and freight costs ease"], rupee: [1, "Less dollar demand"] },
    },
  },
  {
    id: "oil", theme: "Commodities", horizon: "weeks", weight: 3,
    subject: /\b(oil|crude|brent|wti|opec\+?)\b/i, exclude: /\b(palm|olive|cooking|edible|vegetable)\b/i,
    gate: /\b(prices?|futures|brent|wti|barrels?|output|opec|benchmark)\b/i,
    dir: (t) => /\b(output (cut|curb)|cut(s)? output|supply cut)/i.test(t) ? 1 : /\b(output (hike|increase|boost)|rais(e|es|ed) output|boost(s|ed)? output|glut|oversupply|fuel release|stock release)\b/i.test(t) ? -1 : dirNear(t, /\b(oil|crude|brent|wti)\b/i),
    up: {
      label: "higher oil prices",
      rationale: "India imports over 80% of its crude, so dearer oil widens the trade deficit, weakens the rupee, feeds inflation and squeezes fuel marketers, airlines and companies using crude-based inputs.",
      ind: { transport: [-2, "Jet fuel is airlines' biggest cost"], energy: [-1, "Fuel marketers squeezed; upstream gains"], autos: [-1, "Running costs dent demand"], consumer: [-1, "Paint and packaging inputs costlier"], materials: [-1, "Petrochemical inputs costlier"] },
      eco: { fiscal: [-2, "Oil import bill and subsidies rise"], inflation: [-1, "Fuel feeds into prices"], rupee: [-1, "Importers' dollar demand rises"], equities: [-1, "Margin pressure across sectors"] },
    },
    down: {
      label: "lower oil prices",
      rationale: "Cheaper crude shrinks India's import bill, supports the rupee, eases inflation and lifts margins for fuel marketers, airlines and crude-linked manufacturers.",
      ind: { transport: [2, "Jet fuel costs fall"], energy: [1, "Fuel marketers' margins recover"], autos: [1, "Cheaper running costs"], consumer: [1, "Input costs ease"], materials: [1, "Petrochemical inputs cheaper"] },
      eco: { fiscal: [2, "Oil import bill shrinks"], inflation: [1, "Fuel prices ease"], rupee: [1, "Less dollar demand"], equities: [1, "Margins improve"] },
    },
  },
  {
    id: "gas", theme: "Commodities", horizon: "weeks", weight: 2,
    subject: /\b(natural gas|LNG|gas prices?|TTF|Henry Hub)\b/i,
    gate: /\b(prices?|futures|TTF|Henry Hub|bills?|costs?|supply|imports?)\b/i,
    dir: dirOf,
    up: {
      label: "higher gas prices",
      rationale: "India imports about half its gas as LNG; dearer gas squeezes city-gas distributors, raises the fertiliser subsidy bill and lifts power and industrial fuel costs.",
      ind: { energy: [-1, "City-gas margins squeezed"], agrifood: [-1, "Fertiliser costs and subsidy rise"], materials: [-1, "Costlier fuel for industry"] },
      eco: { fiscal: [-1, "Higher LNG import and subsidy bill"], inflation: [-1, "Cooking and transport gas costlier"] },
    },
    down: {
      label: "lower gas prices",
      rationale: "Cheaper LNG helps city-gas distributors, fertiliser makers and gas-using industry, and trims the subsidy bill.",
      ind: { energy: [1, "City-gas margins improve"], agrifood: [1, "Cheaper fertiliser feedstock"], materials: [1, "Cheaper fuel for industry"] },
      eco: { fiscal: [1, "Lower import and subsidy bill"], inflation: [1, "Gas prices ease"] },
    },
  },
  {
    id: "inflation", theme: "Growth data", horizon: "weeks", weight: 2, byEcon: true, needsEconomy: true,
    subject: /\b(inflation|CPI|WPI|consumer prices|wholesale prices|retail inflation|price growth|core prices)\b/i,
    dir: (t) => /\b(hotter|above (expectations|forecast)|sticky|unexpectedly (rose|rises|higher))\b/i.test(t) ? 1 : /\b(cooler|soft(er)?|below (expectations|forecast)|(less|slower) than (expected|forecast)|slow(s|ed)|eas(e|es|ed))\b/i.test(t) ? -1 : dirOf(t),
    up: {
      india: {
        label: "firmer Indian inflation",
        rationale: "Faster price growth erodes household budgets and makes RBI rate cuts less likely or hikes more likely, lifting bond yields.",
        ind: { consumer: [-1, "Real incomes squeezed"], realestate: [-1, "Rate cuts pushed back"] },
        eco: { inflation: [-2, "Price pressure building"], bonds: [-1, "RBI less likely to ease"], equities: [-1, "Valuations face higher rates"] },
      },
      us: {
        label: "hotter US inflation", rationale: "Sticky US inflation keeps the Fed tight, strengthening the dollar and drawing money out of Indian assets.",
        ind: { financials: [-1, "Foreign selling in lenders"] },
        eco: { flows: [-1, "Higher US rates for longer"], rupee: [-1, "Dollar strengthens"], bonds: [-1, "US yields lift Indian yields"] },
      },
    },
    down: {
      india: {
        label: "cooling Indian inflation",
        rationale: "Slower price growth protects household budgets and opens room for RBI rate cuts, lowering bond yields.",
        ind: { consumer: [1, "Real incomes recover"], realestate: [1, "Room for rate cuts"] },
        eco: { inflation: [2, "Price pressure easing"], bonds: [1, "Room for RBI easing"], equities: [1, "Lower rates support valuations"] },
      },
      us: {
        label: "cooler US inflation", rationale: "Softer US inflation lets the Fed ease, weakening the dollar and drawing money back to Indian assets.",
        ind: { financials: [1, "Foreign buying in lenders"] },
        eco: { flows: [1, "Fed can ease"], rupee: [1, "Dollar softens"], bonds: [1, "US yields ease"] },
      },
    },
  },
  {
    id: "yields", theme: "Rates & bonds", horizon: "weeks", weight: 2, byEcon: true, needsEconomy: true,
    subject: /\b(bond yields?|yields?|Treasur(y|ies)|G-?Secs?|government bonds?)\b/i,
    dir: dirOf,
    up: {
      india: {
        label: "rising Indian bond yields",
        rationale: "Higher G-Sec yields raise borrowing costs across the economy and cause mark-to-market losses on banks' bond holdings.",
        ind: { financials: [-1, "Losses on bond portfolios"], realestate: [-1, "Funding costs rise"] },
        eco: { bonds: [-2, "G-Sec yields rising"], equities: [-1, "Higher discount rates"] },
      },
      us: {
        label: "rising US Treasury yields", rationale: FOREIGN_RATES,
        ind: { financials: [-1, "Foreign selling in lenders"], realestate: [-1, "Funding costs rise"] },
        eco: { flows: [-2, "Money moves to US bonds"], rupee: [-1, "Dollar strengthens"], bonds: [-1, "Indian yields follow"], equities: [-1, "Risk appetite falls"] },
      },
    },
    down: {
      india: {
        label: "falling Indian bond yields",
        rationale: "Lower G-Sec yields cut borrowing costs and lift the value of banks' bond holdings.",
        ind: { financials: [1, "Gains on bond portfolios"], realestate: [1, "Funding costs ease"] },
        eco: { bonds: [2, "G-Sec yields falling"], equities: [1, "Lower discount rates"] },
      },
      us: {
        label: "falling US Treasury yields", rationale: FOREIGN_EASE,
        ind: { financials: [1, "Foreign buying in lenders"], realestate: [1, "Funding costs ease"] },
        eco: { flows: [2, "Money returns to emerging markets"], rupee: [1, "Dollar softens"], bonds: [1, "Indian yields follow"], equities: [1, "Risk appetite improves"] },
      },
    },
  },
  {
    id: "jobs", theme: "Growth data", horizon: "weeks", weight: 2, byEcon: true, needsEconomy: true,
    subject: /\b(payrolls|jobs report|jobs data|unemployment|jobless|hiring|labou?r market|employment)\b/i,
    dir: (t) => (/\b(unemployment|jobless)\b/i.test(t) ? -dirOf(t) : dirOf(t)),
    up: {
      india: { label: "stronger Indian jobs data", rationale: "Firmer hiring supports household income and consumer demand.", ind: { consumer: [1, "Jobs support spending"] }, eco: { growth: [1, "Labour market firm"] } },
      us: {
        label: "strong US jobs data", rationale: "Strong US hiring supports demand for Indian IT services but keeps the Fed cautious, firming the dollar.",
        ind: { tech: [1, "US clients keep spending"] }, eco: { flows: [-1, "Fed stays cautious"], rupee: [-1, "Dollar firms"] },
      },
    },
    down: {
      india: { label: "weaker Indian jobs data", rationale: "Softer hiring weighs on household income and consumer demand.", ind: { consumer: [-1, "Weaker household income"] }, eco: { growth: [-1, "Labour market softening"] } },
      us: {
        label: "weak US jobs data", rationale: "Weak US hiring raises the odds of Fed easing, which helps flows into India, but signals softer demand for Indian IT services.",
        ind: { tech: [-1, "US clients may trim budgets"] }, eco: { flows: [1, "Fed hike risk fades"], rupee: [1, "Dollar softens"] },
      },
    },
  },
  {
    id: "growth", theme: "Growth data", horizon: "weeks", weight: 2, byEcon: true, needsEconomy: true,
    subject: /\b(GDP|economy|economic growth|PMI|factory activity|manufacturing|industrial output|industrial production|IIP|core sector|retail sales|exports|services activity|recession)\b/i,
    dir: (t) => /\brecession\b/i.test(t) && !/\b(avoid\w*|escap\w*|exit\w*)\b/i.test(t) ? -1 : dirOf(t),
    up: {
      india: {
        label: "stronger Indian growth data",
        rationale: "Better activity data points to firmer demand, orders and credit growth, supporting earnings across cyclical sectors.",
        ind: { industrials: [1, "Orders and capex firm"], consumer: [1, "Demand holding up"], financials: [1, "Credit demand rises"] },
        eco: { growth: [2, "Activity picking up"], equities: [1, "Earnings outlook improves"] },
      },
      us: { label: "stronger US growth", rationale: "Firmer US demand supports India's IT services and goods exports to its largest export market.", ind: { tech: [1, "Largest market for IT services"] }, eco: { growth: [1, "Exports to the US hold up"] } },
      china: { label: "stronger Chinese growth", rationale: "Firmer Chinese demand supports global metal prices, which lifts Indian metal producers.", ind: { materials: [1, "Firmer metal prices"] }, eco: {} },
    },
    down: {
      india: {
        label: "weaker Indian growth data",
        rationale: "Softer activity data points to weaker demand, orders and credit growth, weighing on cyclical sectors.",
        ind: { industrials: [-1, "Orders soften"], consumer: [-1, "Demand softening"], financials: [-1, "Credit demand slows"] },
        eco: { growth: [-2, "Activity slowing"], equities: [-1, "Earnings outlook dims"] },
      },
      us: { label: "weaker US growth", rationale: "Slower US demand threatens India's IT services and goods exports to its largest export market.", ind: { tech: [-1, "US clients may cut spending"] }, eco: { growth: [-1, "Exports to the US slow"] } },
      china: { label: "weaker Chinese growth", rationale: "Weak Chinese demand pushes metal prices down and diverts cheap Chinese steel to other markets, including India.", ind: { materials: [-1, "Weaker prices, cheap steel imports"] }, eco: {} },
    },
  },
  {
    id: "fpi", theme: "Foreign flows", horizon: "weeks", weight: 3,
    subject: /\b(FPIs?|FIIs?|foreign (portfolio )?investors?|foreign funds?|foreign (in|out)flows?)\b/i,
    dir: (t) => /\b(sell\w*|sold|pull(s|ed)? out|outflows?|withdr\w*|exit\w*|dump\w*|offload\w*)\b/i.test(t) ? -1 : /\b(buy\w*|bought|inflows?|invest(s|ed)?|pour\w*|return\w*|net buyers?)\b/i.test(t) ? 1 : 0,
    up: {
      label: "foreign investor buying",
      rationale: "Foreign portfolio inflows lift Indian equities, especially large lenders and index heavyweights, and support the rupee.",
      ind: { financials: [1, "Foreign buying favours large lenders"] },
      eco: { flows: [2, "Foreign investors buying"], equities: [1, "Index heavyweights supported"], rupee: [1, "Dollar inflows"] },
    },
    down: {
      label: "foreign investor selling",
      rationale: "Foreign portfolio outflows weigh on Indian equities, especially large lenders and index heavyweights, and pressure the rupee.",
      ind: { financials: [-1, "Foreign selling hits large lenders"] },
      eco: { flows: [-2, "Foreign investors selling"], equities: [-1, "Index heavyweights under pressure"], rupee: [-1, "Dollar outflows"] },
    },
  },
  {
    id: "monsoon", theme: "Monsoon & farm", horizon: "months", weight: 2,
    subject: /\b(monsoon|rainfall|kharif|rabi|sowing|IMD)\b/i,
    dir: (t) => /\b(deficit|deficient|below[- ]normal|weak|delayed|drought|dry spell|erratic|shortfall|lag\w*|behind|fall\w*|declin\w*)\b/i.test(t) ? -1 : /\b(normal|above[- ]normal|surplus|excess|good|bountiful|reviv\w*|recover\w*|ahead|record|rise\w*|higher)\b/i.test(t) ? 1 : 0,
    up: {
      label: "good monsoon and sowing",
      rationale: "Good rains lift harvests and rural incomes, supporting farm, rural consumer and tractor demand and easing food inflation.",
      ind: { agrifood: [2, "Better harvests and farm incomes"], consumer: [1, "Rural demand improves"], autos: [1, "Tractor and two-wheeler demand"] },
      eco: { inflation: [1, "Food prices ease"], growth: [1, "Rural economy supported"] },
    },
    down: {
      label: "weak monsoon or sowing",
      rationale: "Poor rains hurt harvests and rural incomes, weighing on rural demand and raising food inflation.",
      ind: { agrifood: [-2, "Crop output at risk"], consumer: [-1, "Rural demand weakens"], autos: [-1, "Tractor and two-wheeler demand"] },
      eco: { inflation: [-1, "Food prices may rise"], growth: [-1, "Rural economy hit"] },
    },
  },
  {
    id: "india-fiscal", theme: "Fiscal", horizon: "months", weight: 2, byEcon: true, needsEconomy: true,
    subject: /\b(fiscal deficit|trade deficit|current account|GST collections?|tax collections?|direct tax|tax revenue|disinvestment|government borrowing)\b/i,
    dir: (t) => (/\b(deficit|borrowing)\b/i.test(t) ? -dirOf(t) : dirOf(t)),
    up: { india: {
      label: "stronger fiscal or trade position",
      rationale: "Better tax collections or narrower deficits mean less government borrowing and a steadier rupee, easing pressure on bond yields.",
      ind: {},
      eco: { fiscal: [2, "Fiscal or trade balance improving"], bonds: [1, "Less borrowing pressure"], rupee: [1, "Steadier external position"] },
    } },
    down: { india: {
      label: "weaker fiscal or trade position",
      rationale: "Wider deficits or weak collections mean more borrowing or a bigger external gap, pressuring bond yields and the rupee.",
      ind: {},
      eco: { fiscal: [-2, "Fiscal or trade balance worsening"], bonds: [-1, "More borrowing pressure"], rupee: [-1, "Wider external gap"] },
    } },
  },
  {
    id: "reserves", theme: "Currencies", horizon: "weeks", weight: 1, byEcon: true, needsEconomy: true,
    subject: /\b(forex reserves|foreign exchange reserves|FX reserves)\b/i,
    dir: dirOf,
    up: { india: { label: "rising forex reserves", rationale: "Bigger reserves give the RBI more room to steady the rupee.", ind: {}, eco: { rupee: [1, "More firepower to steady the rupee"] } } },
    down: { india: { label: "falling forex reserves", rationale: "Falling reserves usually mean the RBI is selling dollars to defend the rupee.", ind: {}, eco: { rupee: [-1, "RBI spending reserves on the rupee"] } } },
  },
  {
    id: "gold", theme: "Commodities", horizon: "weeks", weight: 1,
    subject: /\bgold\b/i, exclude: /\bgold loans?\b/i,
    dir: (t) => dirNear(t, /\bgold\b/i),
    up: {
      label: "higher gold prices",
      rationale: "India is one of the largest gold importers, so dearer gold widens the trade deficit and cools jewellery demand, while lifting gold-loan collateral values.",
      ind: { financials: [1, "Gold-loan collateral worth more"], consumer: [-1, "Jewellery demand softens"] },
      eco: { fiscal: [-1, "Gold imports widen the trade gap"] },
    },
    down: {
      label: "lower gold prices",
      rationale: "Cheaper gold trims India's import bill and supports jewellery demand.",
      ind: { consumer: [1, "Jewellery demand improves"], financials: [-1, "Gold-loan collateral worth less"] },
      eco: { fiscal: [1, "Smaller gold import bill"] },
    },
  },
  {
    id: "metals", theme: "Commodities", horizon: "weeks", weight: 2,
    subject: /\b(copper|iron ore|aluminium|aluminum|nickel|zinc|lithium|steel|silver|base metals?|metal prices?)\b/i,
    dir: (t) => dirNear(t, /\b(copper|iron ore|aluminium|aluminum|nickel|zinc|lithium|steel|silver|base metals?|metal prices?)\b/i),
    up: {
      label: "higher metal prices",
      rationale: "Rising metal prices lift Indian steel, aluminium and zinc producers while raising input costs for automakers, builders and capital-goods makers.",
      ind: { materials: [2, "Higher realisations for producers"], autos: [-1, "Costlier steel and aluminium"], industrials: [-1, "Input costs rise"] },
      eco: {},
    },
    down: {
      label: "lower metal prices",
      rationale: "Falling metal prices cut Indian producers' realisations, often on weak Chinese demand, while easing input costs for manufacturers.",
      ind: { materials: [-2, "Lower realisations for producers"], autos: [1, "Cheaper inputs"], industrials: [1, "Input costs ease"] },
      eco: {},
    },
  },
  {
    id: "food", theme: "Commodities", horizon: "months", weight: 2, byEcon: true,
    subject: /\b(wheat|grains?|rice|pulses|onions?|tomato(es)?|vegetables?|edible oils?|food prices?|food inflation|fertili[sz]ers?|sugar)\b/i,
    dir: dirOf,
    up: {
      india: {
        label: "rising Indian food prices",
        rationale: "Food carries a large weight in India's CPI, so rising food prices squeeze household budgets and limit the RBI's room to cut rates.",
        ind: { consumer: [-1, "Food bills squeeze budgets"], agrifood: [1, "Better farm-gate prices"] },
        eco: { inflation: [-2, "Food inflation rising"], bonds: [-1, "RBI less able to ease"] },
      },
      global: {
        label: "higher global food prices",
        rationale: "Dearer world food, edible oil and fertiliser raise India's import costs and food inflation.",
        ind: { consumer: [-1, "Edible oil and food costlier"], agrifood: [1, "Export prices firm"] },
        eco: { inflation: [-1, "Imported food inflation"], fiscal: [-1, "Edible oil and fertiliser imports costlier"] },
      },
    },
    down: {
      india: {
        label: "easing Indian food prices",
        rationale: "Cooling food prices ease household budgets and open room for RBI rate cuts.",
        ind: { consumer: [1, "Food bills ease"], agrifood: [-1, "Lower farm-gate prices"] },
        eco: { inflation: [2, "Food inflation easing"], bonds: [1, "Room for RBI easing"] },
      },
      global: {
        label: "lower global food prices",
        rationale: "Cheaper world food, edible oil and fertiliser ease India's import costs and food inflation.",
        ind: { consumer: [1, "Edible oil and food cheaper"] },
        eco: { inflation: [1, "Imported food costs ease"], fiscal: [1, "Smaller import bill"] },
      },
    },
  },
  {
    id: "fx", theme: "Currencies", horizon: "weeks", weight: 2,
    subject: /\b(rupee|dollar index|dollar|DXY|yuan|renminbi)\b/i,
    exclude: /\b(trillion|billion|million)[- ]dollar|\$\d|\b(Australian|Aussie|Canadian|New Zealand|Kiwi|Singapore|Hong Kong|Taiwan(ese)?|Zimbabwe(an)?)[- ]dollar/i,
    currency: true,
    dir: dirOf,
  },
  {
    id: "china-property", theme: "Growth data", horizon: "months", weight: 1,
    subject: /\b(China|Chinese)\b.*\b(property|developers?|housing|home prices|real estate)\b|\b(property|developers?|housing|home prices|real estate)\b.*\b(China|Chinese)\b/i,
    dir: (t) => /\b(stimulus|support|rescue|easing|rebound\w*|recover\w*|stabili[sz]\w*)\b/i.test(t) ? 1 : /\b(default\w*|crisis|liquidat\w*|slump\w*|declin\w*|fall\w*|fell|drop\w*|debt)\b/i.test(t) ? -1 : 0,
    up: { label: "support for China's property market", rationale: "Chinese construction drives world steel and metal demand, so support for it lifts prices for Indian metal producers.", ind: { materials: [1, "Firmer steel and metal prices"] }, eco: {} },
    down: { label: "China's property slump", rationale: "A weak Chinese property market cuts metal demand and pushes cheap Chinese steel into export markets, including India.", ind: { materials: [-1, "Weaker prices, cheap steel imports"] }, eco: {} },
  },
  {
    id: "stimulus", theme: "Fiscal", horizon: "months", weight: 2, byEcon: true, needsEconomy: true,
    subject: /\b(stimulus|fiscal package|spending package|tax cuts?|infrastructure spending|capex push|capital expenditure|budget)\b/i,
    dir: (t) => (/\b(scrap\w*|cancel\w*|withdraw\w*|austerity|reject\w*|cut(s)? (capex|spending))\b/i.test(t) ? -1 : /\b(stimulus|package|tax cuts?|boost\w*|raise\w*|increase\w*|push)\b/i.test(t) ? 1 : 0),
    up: {
      india: {
        label: "Indian fiscal stimulus or capex push",
        rationale: "More government capex or tax relief adds orders for infrastructure, cement and steel and supports demand, at the cost of more borrowing.",
        ind: { industrials: [2, "Public capex orders"], materials: [1, "Cement and steel demand"], realestate: [1, "Infrastructure-led demand"] },
        eco: { growth: [1, "Fiscal boost to demand"], fiscal: [-1, "Wider deficit"], bonds: [-1, "More government borrowing"] },
      },
      china: { label: "Chinese stimulus", rationale: "Chinese stimulus supports world metal demand and prices, lifting Indian metal producers.", ind: { materials: [1, "Metal prices supported"] }, eco: {} },
    },
    down: {
      india: {
        label: "Indian fiscal tightening",
        rationale: "Lower government spending trims orders for infrastructure and capital goods but eases borrowing pressure.",
        ind: { industrials: [-1, "Fewer public orders"], materials: [-1, "Less cement and steel demand"] },
        eco: { growth: [-1, "Fiscal drag"], fiscal: [1, "Deficit narrows"], bonds: [1, "Less borrowing"] },
      },
    },
  },
  {
    id: "ai-capex", theme: "Tech cycle", horizon: "months", weight: 1,
    subject: /\b(AI|artificial intelligence|data cent(er|re)s?|IT services|tech spending)\b/,
    gate: /\b(spending|investment|capex|demand|boom|deals?|orders|budgets?|slowdown|cuts?)\b/i,
    dir: (t) => /\b(slowdown|cut\w*|slump\w*|fall\w*|fell|drop\w*|weak\w*|bubble)\b/i.test(t) ? -1 : 1,
    up: { label: "strong tech and AI spending", rationale: "Rising global tech and AI budgets add deals for Indian IT services firms and power demand for data centres.", ind: { tech: [1, "More digital and AI deals"], energy: [1, "Data-centre power demand"] }, eco: {} },
    down: { label: "weaker tech and AI spending", rationale: "Slowing global tech budgets threaten deal flow and pricing for Indian IT services firms.", ind: { tech: [-1, "Deal flow and pricing at risk"] }, eco: {} },
  },
  {
    id: "sanctions", theme: "Energy & geopolitics", horizon: "months", weight: 2,
    subject: /\b(sanctions?|embargo|price cap)\b/i,
    gate: /\b(Russian? oil|Russia|crude|tankers?|energy|shadow fleet|refiner\w*)\b/i,
    dir: (t) => (/\b(lift\w*|eas(e|es|ed|ing)|waive\w*|relief|roll(s|ed)? back)\b/i.test(t) ? -1 : 1),
    up: {
      label: "tighter energy sanctions",
      rationale: "Indian refiners buy discounted Russian crude; tighter sanctions shrink that discount and force costlier replacement barrels.",
      ind: { energy: [-1, "Refiners lose discounted crude"] },
      eco: { fiscal: [-1, "Costlier replacement barrels"] },
    },
    down: {
      label: "easing energy sanctions",
      rationale: "Easier sanctions widen access to discounted crude for Indian refiners.",
      ind: { energy: [1, "Wider access to discounted crude"] },
      eco: { fiscal: [1, "Cheaper crude imports"] },
    },
  },
  {
    id: "bank-stress", theme: "Rates & bonds", horizon: "weeks", weight: 2, byEcon: true, needsEconomy: true,
    subject: /\b(banks?|banking|lenders?|NBFCs?|sovereign debt|debt crisis|bond market)\b/i,
    gate: /\b(collapse\w*|run|crisis|failure|fail(s|ed)|bailout|default\w*|contagion|turmoil|rescue)\b/i,
    dir: () => -1,
    down: {
      india: { label: "Indian financial stress", rationale: "Stress at Indian lenders tightens credit and raises funding costs across the economy.", ind: { financials: [-2, "Funding and credit losses"], realestate: [-1, "Tighter credit"] }, eco: { equities: [-1, "Risk premium rises"], growth: [-1, "Credit tightens"] } },
      us: { label: "US financial stress", rationale: "Financial stress abroad triggers global risk aversion and foreign selling of Indian assets.", ind: { financials: [-1, "Global risk-off hits lenders"] }, eco: { flows: [-1, "Risk aversion"], equities: [-1, "Global sell-off spills over"] } },
    },
  },
  {
    id: "hazard", theme: "Growth data", horizon: "weeks", weight: 1, byEcon: true, needsEconomy: true,
    subject: /\b(earthquake|cyclone|floods?|drought|heatwave|landslides?)\b/i,
    gate: /\b(kill\w*|dead|deaths|damage\w*|destroy\w*|evacuat\w*|emergency|disaster|magnitude|M ?[6-9]|crops?)\b/i,
    dir: () => -1,
    down: { india: { label: "natural disaster in India", rationale: "Major disasters disrupt output, crops and supply chains and raise insurance claims.", ind: { agrifood: [-1, "Crop damage"], consumer: [-1, "Disrupted demand"], financials: [-1, "Insurance claims and loan stress"] }, eco: { growth: [-1, "Disrupted activity"], inflation: [-1, "Supply shocks lift prices"] } } },
  },
];

// Currency moves seen from India: a weaker rupee helps exporters and hurts importers.
const FX = [
  { re: /\brupee\b/i, eco: "rupee", weakLabel: "a weaker rupee", strongLabel: "a stronger rupee",
    weak: { ind: { tech: [2, "IT exporters earn more in rupees"], healthcare: [1, "Pharma exporters gain"], energy: [-1, "Crude imports costlier"], transport: [-1, "Dollar-linked costs rise"] }, eco: { rupee: [-2, "Rupee weakening"], inflation: [-1, "Imported inflation"], flows: [-1, "Currency losses deter foreign investors"] } },
    strong: { ind: { tech: [-1, "Exporters' rupee earnings shrink"], energy: [1, "Crude imports cheaper"], transport: [1, "Dollar costs ease"] }, eco: { rupee: [2, "Rupee strengthening"], inflation: [1, "Imported inflation eases"], flows: [1, "Currency gains attract investors"] } } },
  { re: /\b(dollar index|dollar|DXY)\b/i, eco: "dollar", weakLabel: "a weaker dollar", strongLabel: "a stronger dollar",
    weak: { ind: { tech: [-1, "Dollar earnings worth less"] }, eco: { rupee: [1, "Less pressure on the rupee"], flows: [1, "Money flows to emerging markets"] } },
    strong: { ind: { tech: [1, "Dollar earnings worth more"] }, eco: { rupee: [-1, "Pressure on the rupee"], flows: [-1, "Money flows to dollar assets"] } } },
  { re: /\b(yuan|renminbi)\b/i, eco: "yuan", weakLabel: "a weaker yuan", strongLabel: "a stronger yuan",
    weak: { ind: { materials: [-1, "Cheaper Chinese steel and chemicals"] }, eco: {} },
    strong: { ind: { materials: [1, "Chinese imports less competitive"] }, eco: {} } },
];

function fxEvent(t) {
  const fx = FX.find((f) => f.re.test(t));
  if (!fx) return null;
  // "weaker", "falls" etc. mean the named currency lost value; read the words right after the currency
  // ("rupee set for relief from dip in oil" is about the rupee rising).
  const d = dirNear(t, fx.re);
  if (!d) return null;
  const weak = d < 0;
  const side = weak ? fx.weak : fx.strong;
  return {
    key: `fx-${fx.eco}-${weak ? "weak" : "strong"}`,
    pair: `fx-${fx.eco}`,
    label: weak ? fx.weakLabel : fx.strongLabel,
    rationale: fx.eco === "rupee"
      ? (weak ? "A weaker rupee raises the cost of oil and other imports and imported inflation, but lifts IT and pharma exporters' rupee earnings." : "A stronger rupee lowers import costs and inflation but trims IT and pharma exporters' rupee earnings.")
      : fx.eco === "dollar"
        ? (weak ? "A softer dollar eases pressure on the rupee and draws foreign money back to emerging markets." : "A stronger dollar pressures the rupee and draws foreign money out of emerging markets.")
        : (weak ? "A weaker yuan makes Chinese steel, chemicals and goods cheaper, raising import competition for Indian producers." : "A stronger yuan makes Chinese imports less competitive with Indian producers."),
    ind: side.ind,
    eco: side.eco,
  };
}

// Match one headline to a rule. When several rules fit, the one whose subject comes first in the
// headline wins ("Gold falls as markets await US inflation data" is about gold). `pair` links
// opposite directions of the same event. Foreign events count only through a channel into India.
function match(title) {
  const candidates = RULES.map((r, order) => ({ r, order, at: title.search(r.subject) }))
    .filter(({ r, at }) => at >= 0 && !r.exclude?.test(title) && (!r.gate || r.gate.test(title)))
    .sort((a, b) => a.at - b.at || a.order - b.order);
  for (const { r } of candidates) {
    if (r.currency) {
      const e = fxEvent(title);
      if (e) return [{ rule: r, ...e }];
      continue;
    }
    const d = r.dir(title);
    const side = d > 0 ? r.up : d < 0 ? r.down : null;
    if (!side) continue;
    const dirName = d > 0 ? "up" : "down";
    if (!r.byEcon) return [{ rule: r, key: `${r.id}-${dirName}`, pair: r.id, ...side }];
    // The central bank named decides the economy for rate news; otherwise the economies named.
    const econs = r.id === "rates" ? BANKS.filter(([, re]) => re.test(title)).map(([id]) => id) : econsOf(title);
    const econ = PREFER.find((e) => econs.includes(e) && side[e]) ?? (side.global && !r.needsEconomy ? "global" : null);
    if (!econ) continue;
    return [{ rule: r, key: `${r.id}-${dirName}-${econ}`, pair: `${r.id}-${econ}`, econ, ...side[econ] }];
  }
  return [];
}

function toImpacts(map, bump) {
  return Object.entries(map ?? {}).map(([id, [score, why]]) => ({ id, score: bump && Math.abs(score) === 2 ? Math.sign(score) * 3 : score, why }));
}

// ---------- headlines ----------
async function fetchMarketHeadlines() {
  const items = [];
  let ok = 0;
  for (const q of SEARCHES) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} when:1d`)}&hl=en-IN&gl=IN&ceid=IN:en`;
    try {
      for (const it of await fetchFeed(url)) {
        const publisher = txt(it.raw?.source).trim();
        let title = it.title;
        if (publisher && title.endsWith(` - ${publisher}`)) title = title.slice(0, -publisher.length - 3).trim();
        items.push({ title, link: it.link, source: publisher || "Google News", published: it.published, reports: 1 });
      }
      ok++;
    } catch (err) {
      warn(`Market search failed (${q.slice(0, 40)}…): ${err.message}`);
    }
    await sleep(600);
  }
  return { items, ok };
}

async function osintHeadlines() {
  try {
    const osint = JSON.parse(await readFile(OSINT_PATH, "utf8"));
    return (osint.signals ?? []).map((s) => ({
      title: s.title, link: s.link, source: s.source, published: Date.parse(s.published),
      reports: s.reports || 1, also: s.also ?? [], signalId: s.id, severity: s.severity,
    }));
  } catch {
    return [];
  }
}

export function score(headlines, memory = []) {
  const cutoff = Date.now() - WINDOW_HOURS * 3600_000;
  const seen = new Set();
  const clusters = new Map();
  const signalHits = [];
  for (const h of headlines) {
    if (!h.title || !/^https:\/\//.test(h.link || "")) continue;
    if (!Number.isNaN(h.published) && h.published < cutoff) continue;
    if (SKIP.test(h.title) || LONG_RANGE.test(h.title) || TICKERS.test(h.title) || COMPANY_MARKERS.test(h.title) || COMPANY_NAMES.test(h.title)) continue;
    const key = titleKey(h.title);
    if (seen.has(key)) continue;
    seen.add(key);
    const events = match(h.title);
    if (h.signalId && events.length) signalHits.push({ h, ev: events[0] });
    for (const ev of events) {
      if (!clusters.has(ev.key)) clusters.set(ev.key, { ev, heads: [] });
      clusters.get(ev.key).heads.push(h);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const stories = [...clusters.values()].map(({ ev, heads }) => {
    const reports = heads.reduce((n, h) => n + (h.reports || 1), 0);
    // Outlets run by listed firms (broker news sites) would put a company name on the page; leave them out of the list.
    const outlets = [...new Set(heads.flatMap((h) => [h.source, ...(h.also ?? []).map((a) => a.source)]))].filter((o) => !COMPANY_NAMES.test(o) && !COMPANY_MARKERS.test(o));
    const speculative = heads.filter((h) => SPECULATIVE.test(h.title)).length > heads.length / 2;
    let conf = reports >= 5 && outlets.length >= 3 ? "high" : reports >= 2 ? "medium" : "low";
    if (speculative) conf = conf === "high" ? "medium" : "low";
    const bump = !speculative && (reports >= 6 || heads.some((h) => INTENSE.test(h.title)));
    // Lead with the most global headline (official bodies, wires, world-level wording), then the
    // most corroborated, then the most recent; local and regional angles go last.
    heads.sort((a, b) => leadScore(b) - leadScore(a) || (b.reports || 1) - (a.reports || 1) || (b.published || 0) - (a.published || 0));
    const lead = heads[0];
    const related = heads.slice(1).find((h) => h.title !== lead.title);
    const latest = Math.max(...heads.map((h) => h.published).filter((p) => !Number.isNaN(p)), 0);
    const date = latest ? new Date(Math.min(latest, Date.now())).toISOString().slice(0, 10) : today;
    const where = ev.econ ? ` (${ECO_NAMES[ev.econ]})` : "";
    const sourceList = outlets.slice(0, 3).join(", ") + (outlets.length > 3 ? ` and ${outlets.length - 3} more` : "");
    return {
      pair: ev.pair,
      reports,
      weight: ev.rule.weight * Math.log2(1 + reports) * (speculative ? 0.6 : 1),
      item: {
        id: ev.key,
        date,
        theme: ev.rule.theme,
        headline: lead.title,
        summary: `Signal: ${ev.label}${where}. ${reports} report${reports === 1 ? "" : "s"} from ${sourceList}.` + (related ? ` Related: “${related.title}”.` : ""),
        rationale: ev.rationale,
        horizon: ev.rule.horizon,
        confidence: conf,
        industries: toImpacts(ev.ind, bump),
        economies: toImpacts(ev.eco, bump),
        sources: [...new Set(heads.map((h) => h.link))].slice(0, 3),
      },
    };
  });
  // Opposite readings of the same event (oil up and oil down): keep the better-supported side
  // and lower its confidence when the other side is close.
  const byPair = new Map();
  for (const st of stories) {
    const other = byPair.get(st.pair);
    if (!other) { byPair.set(st.pair, st); continue; }
    const [win, lose] = st.reports > other.reports ? [st, other] : [other, st];
    if (lose.reports * 2 >= win.reports) {
      win.item.confidence = win.item.confidence === "high" ? "medium" : "low";
      win.item.summary += ` Mixed: ${lose.reports} report${lose.reports === 1 ? " points" : "s point"} the other way.`;
    }
    byPair.set(st.pair, win);
  }
  stories.splice(0, stories.length, ...byPair.values());
  const past = pastEvents(memory, today);
  for (const st of stories) addContext(st, past);
  stories.sort((a, b) => b.weight - a.weight);

  // Rule-based assessments for intelligence signals the Claude routine hasn't assessed.
  const signals = signalHits.slice(0, 30).map(({ h, ev }) => ({
    id: h.signalId,
    headline: h.title,
    risk: h.severity,
    note: `Keyword rules read this as ${ev.label}${ev.econ ? ` (${ECO_NAMES[ev.econ]})` : ""}.`,
    industries: toImpacts(ev.ind, false).slice(0, 4),
    economies: toImpacts(ev.eco, false).slice(0, 4),
  }));
  return { items: stories.slice(0, MAX_ITEMS).map((s) => s.item), signals, matched: seen.size };
}

// ---------- context from earlier days ----------
// Each earlier day's stories (from the keyword rules or the Claude routine) are re-read with the
// same rules, so a story counts as ongoing whatever wrote it. Ongoing stories gain rank and,
// once seen on two or more earlier days, confidence; a reading that flips direction is flagged.
const fmtDay = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
function pastEvents(memory, today) {
  const since = new Date(Date.parse(today + "T00:00:00Z") - CONTEXT_DAYS * 864e5).toISOString().slice(0, 10);
  return memory.filter((d) => d.day < today && d.day >= since).map((d) => {
    const keys = new Set(), pairs = new Set();
    for (const it of d.items ?? []) {
      keys.add(it.id);
      for (const e of match(it.headline || "")) { keys.add(e.key); pairs.add(e.pair); }
    }
    return { day: d.day, keys, pairs };
  });
}
function addContext(st, past) {
  const same = past.filter((d) => d.keys.has(st.item.id)).map((d) => d.day);
  const opposite = past.filter((d) => d.pairs.has(st.pair) && !d.keys.has(st.item.id)).map((d) => d.day);
  if (opposite.length && (!same.length || opposite.at(-1) > same.at(-1))) {
    st.item.summary += ` Turn: earlier readings (${fmtDay(opposite.at(-1))}) pointed the other way.`;
    st.item.confidence = st.item.confidence === "high" ? "medium" : st.item.confidence;
    return;
  }
  if (!same.length) {
    st.item.summary += " New in the last 24 hours.";
    return;
  }
  st.item.summary += ` Ongoing: also reported on ${same.length} of the previous ${CONTEXT_DAYS} days (first ${fmtDay(same[0])}).`;
  if (same.length >= 2 && st.item.confidence === "low") st.item.confidence = "medium";
  st.weight *= 1 + 0.2 * Math.min(same.length, 3);
}

// ---------- run ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const prev = JSON.parse(await readFile(SCAN_PATH, "utf8"));
    const age = Date.now() - Date.parse(prev.scannedAt);
    if (/claude/i.test(prev.model || "") && age < 20 * 3600_000 && !process.env.FORCE_RULE_SCAN) {
      console.log(`The Claude routine scored the news ${Math.round(age / 3600_000)} h ago; keeping its scan.`);
      process.exit(0);
    }
  } catch {}

  let market;
  if (process.argv[2]) market = { items: JSON.parse(await readFile(process.argv[2], "utf8")), ok: 1 };
  else market = await fetchMarketHeadlines();
  const intel = await osintHeadlines();
  console.log(`${market.ok}/${SEARCHES.length} market searches ok, ${market.items.length} market headlines, ${intel.length} intelligence signals`);

  const memory = await loadMemory();
  const { items, signals, matched } = score([...market.items, ...intel], memory);
  console.log(`${matched} unique headlines, ${items.length} stories after rule matching`);
  if (items.length < 6) {
    warn(`Only ${items.length} stories matched the rules; keeping the previous scan.`);
    process.exit(0);
  }
  if (process.env.DRY_RUN) {
    // Test mode: show the stories and their context labels, write nothing.
    const label = (it) => it.summary.match(/(New in the last 24 hours|Ongoing:[^.]*|Turn:[^.]*)\./)?.[1] ?? "";
    for (const it of items) console.log(`- [${it.confidence}] ${it.id}: ${it.headline} | ${label(it)}`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      const esc = (t) => String(t).replace(/\|/g, "\\|");
      const rows = items.map((it) => `| ${it.confidence} | ${esc(it.headline)} | ${esc(label(it))} |`);
      await appendFile(process.env.GITHUB_STEP_SUMMARY, [`### Keyword-rule test scan (not committed)`, `${market.ok}/${SEARCHES.length} market searches ok, ${matched} unique headlines, ${items.length} stories.`, "", "| Confidence | Story | Context |", "|---|---|---|", ...rows, ""].join("\n"));
    }
    process.exit(0);
  }
  // Keep Claude's assessments; only fill signals it hasn't assessed.
  let assessed = new Set();
  try {
    const osint = JSON.parse(await readFile(OSINT_PATH, "utf8"));
    assessed = new Set(osint.signals.filter((s) => s.assessment && !/^Keyword rules/.test(s.assessment.note || "")).map((s) => s.id));
  } catch {}
  await writeScan({
    items: normalizeItems(items),
    model: MODEL,
    headlinesScanned: market.items.length + intel.length,
    feedsOk: market.ok,
    signals: signals.filter((s) => !assessed.has(s.id)),
  });
  for (const it of items) console.log(`- [${it.confidence}] ${it.id}: ${it.headline}`);
}
