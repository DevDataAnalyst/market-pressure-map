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

const SEARCHES = [
  '"oil prices" OR brent OR "crude futures" OR OPEC',
  '"natural gas prices" OR "LNG prices" OR "gas prices Europe"',
  '"Federal Reserve" OR ECB OR "Bank of England" OR "Bank of Japan" OR RBI OR PBOC interest rates',
  'inflation data OR "consumer prices" OR CPI',
  '"bond yields" OR "Treasury yields" OR gilts OR bunds',
  'GDP OR PMI OR "jobs report" OR payrolls OR "retail sales" economy',
  'tariffs OR "trade deal" OR "export controls" OR "trade talks"',
  'semiconductors OR "chip demand" OR "AI spending" OR "data centers"',
  '"gold price" OR "copper price" OR "iron ore" OR "steel prices" OR lithium',
  'wheat OR rice OR "food prices" OR fertilizer OR harvest prices',
  'yen OR rupee OR yuan OR "dollar index" OR sterling OR euro currency',
  '"China economy" OR "China property" OR "China stimulus" OR "India economy" OR "Japan economy" OR "euro zone economy" OR "UK economy"',
];

// ---------- direction words ----------
const UP = /\b(rise[sn]?|rising|rose|jump(s|ed|ing)?|surg(e|es|ed|ing)|soar(s|ed|ing)?|climb(s|ed|ing)?|gain(s|ed)?|rall(y|ies|ied)|spik(e|es|ed)|higher|highs?|record high|tops?|top(ped)?|accelerat\w*|hotter|stronger|strengthen\w*|beat(s)?|boost(s|ed)?|rebound(s|ed)?|up \d|increase[sd]?|expand(s|ed|ing)?)\b/i;
const DOWN = /\b(fall(s|ing)?|fell|drop(s|ped)?|slid(e|es)?|slump(s|ed)?|plung(e|es|ed)|tumbl(e|es|ed)|sink(s)?|sank|declin(e|es|ed|ing)|lower|lows?|weak(er|ens?|ened|ening)?|cool(s|ed|ing)?|eas(e|es|ed|ing)|slow(s|ed|ing|down)?|miss(es|ed)?|contract(s|ed|ion)?|shrink(s|ing)?|shr[au]nk|retreat(s|ed)?|down \d|decrease[sd]?|lowest|tumbling|sliding)\b/i;
const INTENSE = /\b(surg|soar|plung|tumbl|record|spik|biggest|sharpest|crisis|collapse|shock|crash|slump)/i;
const SPECULATIVE = /\b(will|could|may|might|expected to|expects?|forecast|predict|outlook|seen|eyes?|weighs?|considers?|mulls?|threatens?|warns?|if )\b/i;
// Opinion, explainers, how-tos and single-firm news aren't market-wide events.
const SKIP = /\?|^\d+ (trends|things|reasons|ways|stocks|charts)\b|\b(opinion|explainer|what to know|how to|here's why|live updates|live:|podcast|video|watch:|newsletter|shares of|stock of|'s shares|earnings|quarterly results|q[1-4] results|ipo|ceo|top picks|stocks to buy)\b/i;

const dirOf = (t) => {
  const u = UP.test(t), d = DOWN.test(t);
  return u === d ? 0 : u ? 1 : -1;
};

// ---------- economies ----------
const ECON = [
  ["us", /\b(United States|U\.S\.|US|USA|America(n)?|Washington|Fed|Federal Reserve|FOMC|Treasur(y|ies)|payrolls|Wall Street|dollar)\b/],
  ["china", /\b(China|Chinese|Beijing|PBOC|PBoC|People's Bank|yuan|renminbi|Hong Kong)\b/],
  ["eurozone", /\b([Ee]uro[- ]?zone|[Ee]uro[- ]area|ECB|European Central Bank|EU|European Union|Germany|German|France|French|Italy|Italian|Spain|Spanish|bunds?|euro)\b/],
  ["japan", /\b(Japan|Japanese|Tokyo|BoJ|BOJ|Bank of Japan|yen|JGBs?|Nikkei)\b/],
  ["india", /\b(India|Indian|RBI|Reserve Bank of India|rupee|Sensex|Nifty|Delhi|Mumbai)\b/],
  ["uk", /\b(UK|U\.K\.|Britain|British|England|BoE|Bank of England|gilts?|sterling|pound)\b/],
  ["gulf", /\b(Saudi|UAE|Emirat\w*|Qatar|Kuwait|Oman|Bahrain|Gulf)\b/],
];
const econsOf = (t) => ECON.filter(([, re]) => re.test(t)).map(([id]) => id);

// ---------- event rules ----------
// up/down: { label, rationale, ind: { id: [score, why] }, eco: { id: [score, why] } }.
// "$" in eco stands for each economy the headline names (rules with perEconomy).
const RULES = [
  {
    id: "rates", theme: "Monetary policy", horizon: "months", weight: 3, perEconomy: true,
    subject: /\b(Fed|Federal Reserve|FOMC|ECB|European Central Bank|Bank of England|BoE|Bank of Japan|BoJ|BOJ|RBI|Reserve Bank of India|PBOC|PBoC|People's Bank|central bank)\b/,
    dir: (t) => /\b(hike[sd]?|hiking|rais(e|es|ed|ing) (interest )?rates?|tighten\w*|hawkish)\b/i.test(t) ? (/\b(dims?|dimm\w*|fad(e|es|ed|ing)|fall(s|en)?|fell|drop(s|ped)?|slip\w*|pare[sd]?|scal(e|es|ed) back|less likely|unwind\w*|cool(s|ed)?|cut(s)? (the )?odds|lower(s|ed)? (the )?odds)\b/i.test(t) ? -1 : 1) : /\b(cut(s|ting)?|lower(s|ed|ing)? (interest )?rates?|eas(e|es|ed|ing)|dovish|rate reduction)\b/i.test(t) ? -1 : 0,
    up: {
      label: "tighter monetary policy",
      rationale: "Higher policy rates raise borrowing costs, cool demand and weigh on rate-sensitive sectors such as property and long-duration growth stocks, while lenders' margins widen.",
      ind: { realestate: [-2, "Higher mortgage and funding costs"], financials: [1, "Wider lending margins"], tech: [-1, "Higher discount rates hit valuations"], consumer: [-1, "Dearer credit squeezes spending"] },
      eco: { $: [-1, "Tighter policy slows growth"] },
    },
    down: {
      label: "easier monetary policy",
      rationale: "Lower policy rates cut borrowing costs, support demand and lift rate-sensitive sectors, though lenders' margins narrow.",
      ind: { realestate: [2, "Cheaper mortgages and funding"], consumer: [1, "Cheaper credit supports spending"], tech: [1, "Lower discount rates lift valuations"], financials: [-1, "Narrower lending margins"] },
      eco: { $: [1, "Easier policy supports growth"] },
    },
  },
  {
    id: "chip-curbs", theme: "Tech cycle", horizon: "months", weight: 3,
    subject: /\b(chips?|semiconductors?|chipmaking|lithography)\b.*\b(export controls?|curbs?|bans?|restrictions?|blacklist)|\b(export controls?|curbs?|bans?|restrictions?)\b.*\b(chips?|semiconductors?)\b/i,
    dir: (t) => /\b(eas(e|es|ed|ing)|lift(s|ed)?|relax\w*|roll(s|ed)? back|exemptions?)\b/i.test(t) ? -1 : 1,
    up: {
      label: "tighter chip export controls",
      rationale: "Export curbs cut chipmakers off from part of their largest market and push China to build costlier domestic supply, adding friction across the electronics chain.",
      ind: { tech: [-2, "Lost sales and supply-chain friction"], industrials: [-1, "Equipment exports restricted"] },
      eco: { china: [-2, "Access to advanced chips curtailed"], us: [-1, "Chip exporters lose a key market"], japan: [-1, "Chip-tool exporters caught by curbs"] },
    },
    down: {
      label: "looser chip export controls",
      rationale: "Easing export curbs reopens sales for chipmakers and equipment suppliers and eases China's access to advanced hardware.",
      ind: { tech: [2, "Sales reopen to a major market"], industrials: [1, "Equipment exports resume"] },
      eco: { china: [1, "Better access to advanced chips"], us: [1, "Exporters regain sales"] },
    },
  },
  {
    id: "tariffs", theme: "Trade", horizon: "months", weight: 3,
    subject: /\b(tariffs?|trade war|trade deal|trade agreement|trade truce|trade talks|import duties|duties on|levies on)\b/i,
    dir: (t) => /\b(deal|agreement|truce|cut(s|ting)?|lift(s|ed|ing)?|remov(e|es|ed)|paus(e|es|ed)|exempt\w*|lower(s|ed)?|relief|progress|breakthrough)\b/i.test(t) ? -1 : /\b(impos\w*|rais\w*|hike[sd]?|new|threat\w*|slap\w*|retaliat\w*|escalat\w*|double[sd]?|steeper|higher|announce[sd]?|war)\b/i.test(t) ? 1 : 0,
    up: {
      label: "higher trade barriers",
      rationale: "New or higher tariffs raise input and import costs, disrupt supply chains and invite retaliation, hurting traded-goods sectors and the economies on both sides.",
      ind: { autos: [-2, "Cross-border supply chains taxed"], industrials: [-1, "Costlier inputs and lost exports"], consumer: [-1, "Import costs passed to shoppers"], agrifood: [-1, "Farm exports face retaliation"], transport: [-1, "Lower trade volumes"] },
      eco: { $: [-1, "Exposed to the trade dispute"] },
    },
    down: {
      label: "easing trade barriers",
      rationale: "Tariff cuts, truces or trade deals lower costs and uncertainty for traded-goods sectors and lift trade volumes.",
      ind: { autos: [1, "Lower cross-border costs"], industrials: [1, "Exports and inputs cheaper"], consumer: [1, "Import costs ease"], transport: [1, "Higher trade volumes"] },
      eco: { $: [1, "Party to the trade relief"] },
    },
  },
  {
    id: "chokepoints", theme: "Energy & geopolitics", horizon: "weeks", weight: 3,
    subject: /\b(Hormuz|Red Sea|Bab el|Bab al|Suez|Black Sea|Houthis?|tankers?|shipping lanes?|blockade)\b/i,
    gate: /\b(attack\w*|hit|struck|strikes?|seiz\w*|blockade|missile|drone|projectile|disrupt\w*|clos(e|ed|ure)|chokehold|threat\w*|war-risk|insurance|reroute\w*|halt\w*|plunge|zero|offensive|reopen\w*|resum\w*|recover\w*|ceasefire|truce|safe passage)\b/i,
    dir: (t) => /\b(reopen\w*|resum\w*|recover\w*|ceasefire|truce|safe passage|eas(e|es|ed|ing))\b/i.test(t) && !/\b(doubts?|fail\w*|stall\w*|collaps\w*|no sign|despite)\b/i.test(t) ? -1 : 1,
    up: {
      label: "shipping chokepoint disruption",
      rationale: "Attacks and blockades on key sea lanes cut oil and gas flows, raise freight and war-risk insurance costs and lengthen voyages, feeding into energy prices and import costs for energy importers.",
      ind: { energy: [2, "Supply risk lifts oil and gas prices"], transport: [-2, "Rerouting, insurance and fuel costs"], consumer: [-1, "Costlier imported goods"], industrials: [-1, "Delayed parts and higher input costs"] },
      eco: { india: [-2, "Large oil and gas import bill"], japan: [-1, "Imports most of its energy"], eurozone: [-1, "Energy and shipping costs rise"], china: [-1, "Biggest crude importer"], gulf: [-1, "Export routes under threat"] },
    },
    down: {
      label: "shipping lanes reopening",
      rationale: "Safer passage through key sea lanes restores oil and gas flows and lowers freight and insurance costs.",
      ind: { energy: [-1, "Risk premium in oil fades"], transport: [2, "Shorter routes, lower insurance"], consumer: [1, "Import costs ease"] },
      eco: { india: [1, "Energy import costs ease"], gulf: [1, "Export routes restored"], eurozone: [1, "Lower energy and freight costs"] },
    },
  },
  {
    id: "oil", theme: "Commodities", horizon: "weeks", weight: 3,
    subject: /\b(oil|crude|brent|wti|opec\+?)\b/i, exclude: /\b(palm|olive|cooking|edible|vegetable)\b/i,
    gate: /\b(prices?|futures|brent|wti|barrels?|output|opec|benchmark)\b/i,
    dir: (t) => /\b(output (cut|curb)|cut(s)? output|supply cut)/i.test(t) ? 1 : /\b(output (hike|increase|boost)|rais(e|es|ed) output|boost(s|ed)? output|glut|oversupply)\b/i.test(t) ? -1 : dirOf(t),
    up: {
      label: "higher oil prices",
      rationale: "Dearer crude lifts producers' revenue but raises fuel and input costs for transport, manufacturing and households, widening trade deficits in big importers.",
      ind: { energy: [2, "Higher realised prices for producers"], transport: [-2, "Fuel is a top cost for carriers"], autos: [-1, "Fuel costs dent vehicle demand"], consumer: [-1, "Less money for other spending"] },
      eco: { gulf: [2, "Export revenue rises"], india: [-2, "Imports most of its oil"], japan: [-1, "Higher import bill"], eurozone: [-1, "Energy importer"], china: [-1, "Biggest crude importer"] },
    },
    down: {
      label: "lower oil prices",
      rationale: "Cheaper crude cuts producers' revenue but lowers fuel and input costs, easing inflation and trade deficits in big importers.",
      ind: { energy: [-2, "Lower realised prices"], transport: [2, "Fuel bills fall"], consumer: [1, "More money for other spending"], autos: [1, "Cheaper running costs"] },
      eco: { gulf: [-2, "Export revenue falls"], india: [2, "Oil import bill shrinks"], japan: [1, "Lower import bill"], eurozone: [1, "Energy costs ease"], china: [1, "Cheaper crude imports"] },
    },
  },
  {
    id: "gas", theme: "Commodities", horizon: "weeks", weight: 2,
    subject: /\b(natural gas|LNG|gas prices?|TTF|Henry Hub)\b/i,
    gate: /\b(prices?|futures|TTF|Henry Hub|bills?|costs?)\b/i,
    dir: dirOf,
    up: {
      label: "higher gas prices",
      rationale: "Dearer gas raises power and heating bills and costs for energy-intensive industry such as chemicals, steel and fertiliser, hitting import-dependent Europe and Japan hardest.",
      ind: { energy: [2, "Producers and exporters earn more"], materials: [-1, "Energy-intensive output costlier"], industrials: [-1, "Higher power costs"], agrifood: [-1, "Fertiliser costs rise"] },
      eco: { eurozone: [-2, "Depends on imported gas"], uk: [-1, "Gas sets power prices"], japan: [-1, "Large LNG importer"], gulf: [1, "LNG exporters gain"] },
    },
    down: {
      label: "lower gas prices",
      rationale: "Cheaper gas eases power bills and costs for energy-intensive industry, helping import-dependent economies.",
      ind: { energy: [-1, "Lower realised gas prices"], materials: [1, "Cheaper energy for heavy industry"], industrials: [1, "Lower power costs"] },
      eco: { eurozone: [2, "Gas import costs fall"], uk: [1, "Power prices ease"], japan: [1, "Cheaper LNG imports"] },
    },
  },
  {
    id: "inflation", theme: "Growth data", horizon: "weeks", weight: 2, perEconomy: true, needsEconomy: true,
    subject: /\b(inflation|CPI|consumer prices|price growth|core prices)\b/i,
    dir: (t) => /\b(hotter|above (expectations|forecast)|sticky|unexpectedly (rose|rises|higher))\b/i.test(t) ? 1 : /\b(cooler|soft(er)?|below (expectations|forecast)|(less|slower) than (expected|forecast)|slow(s|ed)|eas(e|es|ed))\b/i.test(t) ? -1 : dirOf(t),
    up: {
      label: "firmer inflation",
      rationale: "Faster inflation erodes real incomes and makes rate cuts less likely or hikes more likely, weighing on spending and rate-sensitive sectors.",
      ind: { consumer: [-1, "Real incomes squeezed"], realestate: [-1, "Rate cuts pushed back"] },
      eco: { $: [-1, "Price pressure delays easing"] },
    },
    down: {
      label: "cooling inflation",
      rationale: "Slower inflation protects real incomes and opens room for rate cuts, helping spending and rate-sensitive sectors.",
      ind: { consumer: [1, "Real incomes recover"], realestate: [1, "Room for rate cuts"] },
      eco: { $: [1, "Room for easier policy"] },
    },
  },
  {
    id: "yields", theme: "Rates & bonds", horizon: "weeks", weight: 2, perEconomy: true, needsEconomy: true,
    subject: /\b(bond yields?|yields?|Treasur(y|ies)|gilts?|bunds?|JGBs?)\b/i,
    dir: dirOf,
    up: {
      label: "rising bond yields",
      rationale: "Higher long-term yields lift mortgage and corporate borrowing costs and lower the value of long-duration assets, though they help lenders' margins.",
      ind: { realestate: [-2, "Mortgage and funding costs rise"], tech: [-1, "Valuations compress"], financials: [1, "Better lending margins"] },
      eco: { $: [-1, "Tighter financial conditions"] },
    },
    down: {
      label: "falling bond yields",
      rationale: "Lower long-term yields ease borrowing costs for households, firms and governments and support long-duration assets.",
      ind: { realestate: [2, "Cheaper mortgages and funding"], tech: [1, "Valuations supported"] },
      eco: { $: [1, "Easier financial conditions"] },
    },
  },
  {
    id: "jobs", theme: "Growth data", horizon: "weeks", weight: 2, perEconomy: true, needsEconomy: true,
    subject: /\b(payrolls|jobs report|jobs data|unemployment|jobless|hiring|labou?r market|employment)\b/i,
    dir: (t) => (/\b(unemployment|jobless)\b/i.test(t) ? -dirOf(t) : dirOf(t)),
    up: {
      label: "stronger labour market",
      rationale: "Solid hiring supports household income and spending, though it can keep central banks cautious about cutting rates.",
      ind: { consumer: [1, "Jobs support spending"], financials: [1, "Healthier borrowers"] },
      eco: { $: [1, "Labour market holding up"] },
    },
    down: {
      label: "weaker labour market",
      rationale: "Softer hiring or rising unemployment weighs on household income and spending, and raises the odds of rate cuts.",
      ind: { consumer: [-1, "Weaker household income"], financials: [-1, "Credit quality risk"] },
      eco: { $: [-1, "Labour market softening"] },
    },
  },
  {
    id: "growth", theme: "Growth data", horizon: "weeks", weight: 2, perEconomy: true, needsEconomy: true,
    subject: /\b(GDP|economy|economic growth|PMI|factory activity|manufacturing|industrial output|industrial production|retail sales|exports|services activity|recession)\b/i,
    dir: (t) => /\brecession\b/i.test(t) && !/\b(avoid\w*|escap\w*|exit\w*)\b/i.test(t) ? -1 : dirOf(t),
    up: {
      label: "stronger growth data",
      rationale: "Better activity data points to firmer demand, supporting corporate revenue, imports of commodities and cyclical sectors.",
      ind: { industrials: [1, "Firmer orders"], consumer: [1, "Demand holding up"], materials: [1, "Stronger demand for inputs"] },
      eco: { $: [1, "Activity picking up"] },
    },
    down: {
      label: "weaker growth data",
      rationale: "Softer activity data points to weaker demand, weighing on cyclical sectors and commodity demand.",
      ind: { industrials: [-1, "Weaker orders"], consumer: [-1, "Demand softening"], materials: [-1, "Less demand for inputs"] },
      eco: { $: [-1, "Activity slowing"] },
    },
  },
  {
    id: "metals", theme: "Commodities", horizon: "weeks", weight: 2,
    subject: /\b(gold|copper|iron ore|aluminium|aluminum|nickel|lithium|steel|silver|metals?)\b/i,
    dir: dirOf,
    up: {
      label: "higher metal prices",
      rationale: "Rising metal prices lift miners' and producers' revenue while raising input costs for manufacturers and builders.",
      ind: { materials: [2, "Higher prices for miners"], autos: [-1, "Costlier metal inputs"], industrials: [-1, "Input costs rise"] },
      eco: {},
    },
    down: {
      label: "lower metal prices",
      rationale: "Falling metal prices cut miners' revenue, often signalling weaker industrial demand, while easing manufacturers' input costs.",
      ind: { materials: [-2, "Lower prices for miners"], industrials: [1, "Input costs ease"] },
      eco: {},
    },
  },
  {
    id: "food", theme: "Commodities", horizon: "months", weight: 2,
    subject: /\b(wheat|grains?|rice|corn|maize|soybeans?|food prices?|fertili[sz]ers?|cocoa|coffee|sugar)\b/i,
    dir: dirOf,
    up: {
      label: "higher food and farm prices",
      rationale: "Dearer staples raise grocery bills and food inflation, hitting import-dependent and lower-income economies, while farm producers earn more.",
      ind: { agrifood: [1, "Producers earn more, processors squeezed"], consumer: [-1, "Higher grocery bills"] },
      eco: { india: [-1, "Food is a large share of inflation"], gulf: [-1, "Imports most of its food"], china: [-1, "Large food importer"] },
    },
    down: {
      label: "lower food and farm prices",
      rationale: "Cheaper staples ease food inflation and household budgets, though farm incomes fall.",
      ind: { agrifood: [-1, "Lower farm incomes"], consumer: [1, "Grocery bills ease"] },
      eco: { india: [1, "Food inflation eases"], gulf: [1, "Cheaper food imports"] },
    },
  },
  {
    id: "fx", theme: "Currencies", horizon: "weeks", weight: 2,
    subject: /\b(yen|rupee|yuan|renminbi|dollar|sterling|pound|euro)\b/i,
    exclude: /\b(trillion|billion|million)[- ]dollar|\$\d|\beuro[- ]?(zone|area)\b/i,
    currency: true,
    dir: dirOf,
  },
  {
    id: "china-property", theme: "Growth data", horizon: "months", weight: 2,
    subject: /\b(China|Chinese)\b.*\b(property|developers?|housing|home prices|real estate)\b|\b(property|developers?|housing|home prices|real estate)\b.*\b(China|Chinese)\b/i,
    dir: (t) => /\b(stimulus|support|rescue|easing|rebound\w*|recover\w*|stabili[sz]\w*)\b/i.test(t) ? 1 : /\b(default\w*|crisis|liquidat\w*|slump\w*|declin\w*|fall\w*|fell|drop\w*|debt)\b/i.test(t) ? -1 : 0,
    up: {
      label: "support for China's property market",
      rationale: "Property is a big share of China's economy and of demand for steel, copper and building materials, so support for the sector lifts commodity demand.",
      ind: { realestate: [1, "Housing support"], materials: [1, "More demand for steel and copper"] },
      eco: { china: [1, "Property drag easing"] },
    },
    down: {
      label: "China's property slump",
      rationale: "Falling sales and developer debt problems weigh on China's growth, household wealth and demand for steel, copper and building materials.",
      ind: { realestate: [-2, "Sales and prices falling"], materials: [-1, "Less demand for steel and copper"], financials: [-1, "Bad-loan exposure"] },
      eco: { china: [-2, "Property is a large share of output"] },
    },
  },
  {
    id: "stimulus", theme: "Growth data", horizon: "months", weight: 2, perEconomy: true, needsEconomy: true,
    subject: /\b(stimulus|fiscal package|spending package|tax cuts?|infrastructure spending)\b/i,
    dir: (t) => (/\b(scrap\w*|cancel\w*|withdraw\w*|austerity|reject\w*)\b/i.test(t) ? -1 : 1),
    up: {
      label: "fiscal stimulus",
      rationale: "Government spending or tax cuts add to demand, helping construction, industrial and consumer sectors in the economy concerned.",
      ind: { industrials: [1, "Infrastructure and capex"], materials: [1, "More demand for inputs"], consumer: [1, "Support for households"] },
      eco: { $: [2, "Fiscal boost to demand"] },
    },
    down: {
      label: "fiscal tightening",
      rationale: "Spending cuts or withdrawn support subtract from demand in the economy concerned.",
      ind: { industrials: [-1, "Less public investment"], consumer: [-1, "Less household support"] },
      eco: { $: [-1, "Fiscal drag"] },
    },
  },
  {
    id: "ai-capex", theme: "Tech cycle", horizon: "months", weight: 2,
    subject: /\b(AI|artificial intelligence|data cent(er|re)s?|chips?|semiconductors?)\b/,
    gate: /\b(spending|investment|capex|demand|boom|sales|orders|shortage|glut|bubble|slowdown)\b/i,
    dir: (t) => /\b(glut|bubble|slowdown|cut\w*|slump\w*|fall\w*|fell|drop\w*|weak\w*)\b/i.test(t) ? -1 : 1,
    up: {
      label: "strong AI and chip demand",
      rationale: "Heavy spending on AI data centres drives orders for chips, servers, power equipment and electricity.",
      ind: { tech: [2, "Chip and server orders rise"], energy: [1, "Data centres need more power"], industrials: [1, "Power and cooling equipment"] },
      eco: { us: [1, "Hub of AI investment"] },
    },
    down: {
      label: "softer AI and chip demand",
      rationale: "Signs of slowing AI spending or a chip glut threaten orders across the hardware supply chain.",
      ind: { tech: [-2, "Orders and pricing at risk"], industrials: [-1, "Equipment orders slow"] },
      eco: { us: [-1, "AI investment cools"] },
    },
  },
  {
    id: "sanctions", theme: "Energy & geopolitics", horizon: "months", weight: 2,
    subject: /\b(sanctions?|embargo|price cap)\b/i,
    gate: /\b(oil|crude|tankers?|energy|gas|LNG|shadow fleet|Kharg|exports?)\b/i,
    dir: (t) => (/\b(lift\w*|eas(e|es|ed|ing)|waive\w*|relief|roll(s|ed)? back)\b/i.test(t) ? -1 : 1),
    up: {
      label: "tighter energy sanctions",
      rationale: "Sanctions on oil and gas exporters squeeze available supply and force buyers to pay more for replacement barrels.",
      ind: { energy: [1, "Less sanctioned supply supports prices"], transport: [-1, "Tankers face more restrictions"] },
      eco: { india: [-1, "Buys discounted sanctioned crude"], china: [-1, "Buys discounted sanctioned crude"], gulf: [1, "Replacement barrels in demand"] },
    },
    down: {
      label: "easing energy sanctions",
      rationale: "Lifting sanctions brings more oil and gas to market and lowers prices for importers.",
      ind: { energy: [-1, "More supply weighs on prices"] },
      eco: { india: [1, "Cheaper crude available"], gulf: [-1, "More competing supply"] },
    },
  },
  {
    id: "bank-stress", theme: "Rates & bonds", horizon: "weeks", weight: 2, perEconomy: true,
    subject: /\b(banks?|banking|lenders?|sovereign debt|debt crisis|bond market)\b/i,
    gate: /\b(collapse\w*|run|crisis|failure|fail(s|ed)|bailout|default\w*|contagion|turmoil|rescue)\b/i,
    dir: () => -1,
    down: {
      label: "financial stress",
      rationale: "Stress at lenders or in sovereign debt tightens credit and raises funding costs across the economy.",
      ind: { financials: [-2, "Funding and credit losses"], realestate: [-1, "Tighter credit"] },
      eco: { $: [-1, "Tighter credit conditions"] },
    },
  },
  {
    id: "taiwan-korea", theme: "Energy & geopolitics", horizon: "weeks", weight: 2,
    subject: /\b(Taiwan|Taiwan Strait|North Korea|Korean Peninsula|South China Sea)\b/i,
    gate: /\b(missile|drills?|blockade|military|warships?|escalat\w*|tensions?|launch\w*|incursion\w*|fires?)\b/i,
    dir: () => 1,
    up: {
      label: "East Asia security tensions",
      rationale: "Military tension around Taiwan and the Korean peninsula threatens the region that makes most advanced chips and electronics, and its sea lanes.",
      ind: { tech: [-1, "Chip supply concentrated in the region"], transport: [-1, "Regional shipping risk"] },
      eco: { japan: [-1, "On the front line"], china: [-1, "Sanctions and trade risk"] },
    },
  },
  {
    id: "hazard", theme: "Growth data", horizon: "weeks", weight: 1, perEconomy: true, needsEconomy: true,
    subject: /\b(earthquake|typhoon|cyclone|hurricane|floods?|drought|heatwave|wildfires?)\b/i,
    gate: /\b(kill\w*|dead|deaths|damage\w*|destroy\w*|evacuat\w*|emergency|disaster|magnitude|M ?[6-9])\b/i,
    dir: () => -1,
    down: {
      label: "natural disaster",
      rationale: "Major disasters disrupt output, supply chains and harvests and raise insurance claims, before rebuilding adds to demand later.",
      ind: { financials: [-1, "Insurance claims"], agrifood: [-1, "Crop and supply damage"] },
      eco: { $: [-1, "Disrupted activity"] },
    },
  },
];

// Currency moves: a weaker currency helps exporters and hurts importers in that economy.
const FX = [
  { re: /\byen\b/i, eco: "japan", weakLabel: "a weaker yen", strongLabel: "a stronger yen", weak: { ind: { autos: [1, "Exporters' overseas earnings rise"] }, eco: { japan: [1, "Exporters gain, imports costlier"] } }, strong: { ind: { autos: [-1, "Exporters' earnings shrink"] }, eco: { japan: [-1, "Exporters lose competitiveness"] } } },
  { re: /\brupee\b/i, eco: "india", weakLabel: "a weaker rupee", strongLabel: "a stronger rupee", weak: { ind: { energy: [-1, "Dollar-priced oil costs more"] }, eco: { india: [-1, "Imported inflation and oil bill"] } }, strong: { ind: {}, eco: { india: [1, "Import costs ease"] } } },
  { re: /\b(yuan|renminbi)\b/i, eco: "china", weakLabel: "a weaker yuan", strongLabel: "a stronger yuan", weak: { ind: { materials: [-1, "Commodities costlier for China"] }, eco: { china: [-1, "Signals capital outflow pressure"] } }, strong: { ind: { materials: [1, "Commodity imports cheaper"] }, eco: { china: [1, "Confidence in the currency"] } } },
  { re: /\b(sterling|pound)\b/i, eco: "uk", weakLabel: "a weaker pound", strongLabel: "a stronger pound", weak: { ind: {}, eco: { uk: [-1, "Imported inflation"] } }, strong: { ind: {}, eco: { uk: [1, "Import costs ease"] } } },
  { re: /\beuro\b(?![- ]?(zone|area))/i, eco: "eurozone", weakLabel: "a weaker euro", strongLabel: "a stronger euro", weak: { ind: { industrials: [1, "Exporters gain"] }, eco: { eurozone: [1, "Exporters more competitive"] } }, strong: { ind: { industrials: [-1, "Exporters less competitive"] }, eco: { eurozone: [-1, "Export headwind"] } } },
  { re: /\bdollar\b/i, eco: "us", weakLabel: "a weaker dollar", strongLabel: "a stronger dollar", weak: { ind: { materials: [1, "Dollar-priced commodities cheaper abroad"] }, eco: { india: [1, "Less pressure on emerging currencies"], us: [1, "Exporters gain"] } }, strong: { ind: { materials: [-1, "Commodities dearer for other buyers"] }, eco: { india: [-1, "Pressure on the rupee"], us: [-1, "Exporters less competitive"] } } },
];

function fxEvent(t) {
  const fx = FX.find((f) => f.re.test(t));
  if (!fx) return null;
  // "weaker", "falls" etc. mean the named currency lost value.
  const d = dirOf(t);
  if (!d) return null;
  const weak = d < 0;
  const side = weak ? fx.weak : fx.strong;
  return {
    key: `fx-${fx.eco}-${weak ? "weak" : "strong"}`,
    pair: `fx-${fx.eco}`,
    label: weak ? fx.weakLabel : fx.strongLabel,
    rationale: weak
      ? "A weaker currency raises import costs and imported inflation but makes exporters more competitive."
      : "A stronger currency lowers import costs and inflation but makes exporters less competitive.",
    ind: side.ind,
    eco: side.eco,
  };
}

// Match one headline to a rule; returns one event per affected economy. When several rules
// fit, the one whose subject comes first in the headline wins ("Gold falls as markets await
// US inflation data" is about gold). `pair` links opposite directions of the same event.
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
    const econs = econsOf(title);
    if (r.needsEconomy && !econs.length) continue;
    const ev = (suffix, extra) => ({ rule: r, key: `${r.id}-${dirName}${suffix}`, pair: `${r.id}${suffix}`, ...side, ...extra });
    if (r.perEconomy && econs.length) {
      // For central banks, the bank decides which economy is meant.
      const target = r.id === "rates" ? econs.filter((e) => ["us", "eurozone", "uk", "japan", "india", "china"].includes(e)).slice(0, 1) : econs.slice(0, 2);
      if (!target.length) continue;
      return target.map((e) => ev(`-${e}`, { econ: e }));
    }
    // Trade rules name the economies involved; others use fixed exposures.
    if (r.id === "tariffs" && econs.length) return [ev(`-${econs.slice(0, 3).join("-")}`, { econs: econs.slice(0, 3) })];
    if (side.eco.$) continue;
    return [ev("", {})];
  }
  return [];
}

const ECO_NAMES = { us: "US", china: "China", eurozone: "euro area", japan: "Japan", india: "India", uk: "UK", gulf: "Gulf" };

function toImpacts(map, ev, bump) {
  const out = [];
  for (const [id, [score, why]] of Object.entries(map ?? {})) {
    const ids = id === "$" ? (ev.econs ?? (ev.econ ? [ev.econ] : [])) : [id];
    for (const real of ids) {
      if (out.some((x) => x.id === real)) continue;
      const s = bump && Math.abs(score) === 2 ? Math.sign(score) * 3 : score;
      out.push({ id: real, score: s, why });
    }
  }
  return out;
}

// ---------- headlines ----------
async function fetchMarketHeadlines() {
  const items = [];
  let ok = 0;
  for (const q of SEARCHES) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} when:1d`)}&hl=en-US&gl=US&ceid=US:en`;
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
    if (SKIP.test(h.title) || COMPANY_MARKERS.test(h.title) || COMPANY_NAMES.test(h.title)) continue;
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
    const outlets = [...new Set(heads.flatMap((h) => [h.source, ...(h.also ?? []).map((a) => a.source)]))];
    const speculative = heads.filter((h) => SPECULATIVE.test(h.title)).length > heads.length / 2;
    let conf = reports >= 5 && outlets.length >= 3 ? "high" : reports >= 2 ? "medium" : "low";
    if (speculative) conf = conf === "high" ? "medium" : "low";
    const bump = !speculative && (reports >= 6 || heads.some((h) => INTENSE.test(h.title)));
    // Lead with the most corroborated, then most recent, headline.
    heads.sort((a, b) => (b.reports || 1) - (a.reports || 1) || (b.published || 0) - (a.published || 0));
    const lead = heads[0];
    const related = heads.slice(1).find((h) => h.title !== lead.title);
    const latest = Math.max(...heads.map((h) => h.published).filter((p) => !Number.isNaN(p)), 0);
    const date = latest ? new Date(Math.min(latest, Date.now())).toISOString().slice(0, 10) : today;
    const where = ev.econ ? ` (${ECO_NAMES[ev.econ]})` : ev.econs ? ` (${ev.econs.map((e) => ECO_NAMES[e]).join(", ")})` : "";
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
        industries: toImpacts(ev.ind, ev, bump),
        economies: toImpacts(ev.eco, ev, bump),
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
    industries: toImpacts(ev.ind, ev, false).slice(0, 4),
    economies: toImpacts(ev.eco, ev, false).slice(0, 4),
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
