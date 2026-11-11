// Builds public/world.json: the world map on the front page, pre-projected so the page needs no map library.
// Run once, and again only if the region groupings below change:
//   npm i --no-save world-atlas@2 topojson-client@3 d3-geo@3 && node scripts/build-world.mjs
// (These three packages are not in package.json, so the daily job and the site build stay light.)
// Countries are merged into the regions the page reports on; region names and keywords live in public/index.html.
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { feature, merge, mesh } from "topojson-client";
import { geoEqualEarth, geoPath } from "d3-geo";

const require = createRequire(import.meta.url);
const world = JSON.parse(await readFile(require.resolve("world-atlas/countries-110m.json"), "utf8"));

const REGIONS = {
  india: ["India"],
  southasia: ["Pakistan", "Bangladesh", "Sri Lanka", "Nepal", "Bhutan", "Afghanistan"],
  gulf: ["Iran", "Iraq", "Saudi Arabia", "United Arab Emirates", "Qatar", "Kuwait", "Oman", "Yemen", "Israel", "Palestine", "Jordan", "Syria", "Lebanon", "Turkey", "Cyprus", "N. Cyprus"],
  russia: ["Russia", "Ukraine", "Belarus", "Moldova", "Georgia", "Armenia", "Azerbaijan", "Kazakhstan", "Uzbekistan", "Turkmenistan", "Kyrgyzstan", "Tajikistan"],
  europe: ["Norway", "Sweden", "Finland", "Denmark", "Iceland", "United Kingdom", "Ireland", "France", "Germany", "Netherlands", "Belgium", "Luxembourg", "Switzerland", "Austria", "Italy", "Spain", "Portugal", "Poland", "Czechia", "Slovakia", "Hungary", "Romania", "Bulgaria", "Greece", "Albania", "Croatia", "Slovenia", "Bosnia and Herz.", "Macedonia", "Serbia", "Montenegro", "Kosovo", "Lithuania", "Latvia", "Estonia"],
  namerica: ["United States of America", "Canada", "Mexico", "Greenland"],
  china: ["China", "Taiwan", "Japan", "South Korea", "North Korea", "Mongolia"],
  seasia: ["Indonesia", "Malaysia", "Vietnam", "Thailand", "Philippines", "Myanmar", "Cambodia", "Laos", "Brunei", "Timor-Leste", "Papua New Guinea", "Australia", "New Zealand", "Fiji", "Solomon Is.", "Vanuatu", "New Caledonia"],
  latam: ["Argentina", "Chile", "Brazil", "Bolivia", "Peru", "Colombia", "Panama", "Costa Rica", "Nicaragua", "Honduras", "El Salvador", "Guatemala", "Belize", "Venezuela", "Guyana", "Suriname", "Ecuador", "Uruguay", "Paraguay", "Haiti", "Dominican Rep.", "Bahamas", "Falkland Is.", "Puerto Rico", "Jamaica", "Cuba", "Trinidad and Tobago"],
};
const SKIP = new Set(["Antarctica", "Fr. S. Antarctic Lands"]);

const geoms = world.objects.countries.geometries.filter((g) => !SKIP.has(g.properties.name));
const named = new Set(Object.values(REGIONS).flat());
const unknown = [...named].filter((n) => !geoms.some((g) => g.properties.name === n));
if (unknown.length) throw new Error(`Not in the atlas: ${unknown.join(", ")}`);
// Everything not listed above is Africa.
REGIONS.africa = geoms.map((g) => g.properties.name).filter((n) => !named.has(n));
const regionOf = Object.fromEntries(Object.entries(REGIONS).flatMap(([r, names]) => names.map((n) => [n, r])));

const W = 1000, PAD = 6;
// Centred a little east of Greenwich so the seam falls in the Bering Strait, not through Russia.
const ROTATE = -11;
const land = { type: "FeatureCollection", features: geoms.map((g) => feature(world, g)) };
const projection = geoEqualEarth().rotate([ROTATE, 0]).fitWidth(W - 2 * PAD, land);
const [[, y0], [, y1]] = geoPath(projection).bounds(land);
const [tx, ty] = projection.translate();
projection.translate([tx + PAD, ty - y0 + PAD]);
const H = Math.ceil(y1 - y0 + 2 * PAD);
const path = geoPath(projection).digits(1);

const regions = {};
for (const r of Object.keys(REGIONS)) regions[r] = path(merge(world, geoms.filter((g) => regionOf[g.properties.name] === r)));
// Borders between countries of the same region, drawn faintly over the fills.
const borders = path(mesh(world, { type: "GeometryCollection", geometries: geoms }, (a, b) => a !== b && regionOf[a.properties.name] === regionOf[b.properties.name]));

const out = { w: W, h: H, k: +projection.scale().toFixed(3), tx: +projection.translate()[0].toFixed(2), ty: +projection.translate()[1].toFixed(2), rotate: ROTATE, regions, borders };
const file = new URL("../public/world.json", import.meta.url);
await writeFile(file, JSON.stringify(out) + "\n");
console.log(`Wrote public/world.json: ${W}×${H}, ${Object.keys(regions).length} regions, ${(JSON.stringify(out).length / 1024).toFixed(0)} KB. Africa: ${REGIONS.africa.length} countries.`);
