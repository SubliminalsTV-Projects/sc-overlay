// Render a ship's cargo grids to PNG — for a first-look video, drawn with the Stow widget's own
// isometric code (overlay/hauling-stow.js) so the pictures look like the app and stay to scale.
//
//   npx tsx tools/render-cargo-grids.ts <ShipClass> <outDir> [--theme anvil] [--order port,port]
//                                       [--label port=Name ...]
//
// Writes three 3440x1440 PNGs with a transparent background (they drop straight onto a timeline):
//   <Class>-grids.png       every grid, empty, at one common scale
//   <Class>-full-load.png   the biggest-boxes-first load the real packer (src/cargo-pack.ts) fits
//   <Class>-<port>.png      one close-up per grid, full load
//
// The fill is greedy on purpose: for each box size, largest first, keep adding one box while the
// packer still places every box. It is "what the packer can fit", not a claim about the game's
// own auto-stow. Grid sizes come from HaulingDataStore, i.e. exactly what the widget will use.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { HaulingDataStore } from "../src/hauling-data.js";
import { packCargo, type PackItem } from "../src/cargo-pack.js";

const args = process.argv.slice(2);
const shipClass = args[0];
const outDir = args[1] ? resolve(args[1]) : "";
if (!shipClass || !outDir) {
  console.error("usage: npx tsx tools/render-cargo-grids.ts <ShipClass> <outDir> [--theme <skin>] [--label port=Name]");
  process.exit(2);
}
let theme = "";
let order: string[] = [];
const labels: Record<string, string> = {};
for (let i = 2; i < args.length; i++) {
  if (args[i] === "--theme") theme = args[++i] ?? "";
  else if (args[i] === "--order") order = (args[++i] ?? "").split(",").filter(Boolean);
  else if (args[i] === "--label") {
    const [k, ...v] = (args[++i] ?? "").split("=");
    if (k && v.length) labels[k] = v.join("=");
  }
}

const data = new HaulingDataStore(join(process.cwd(), "data"));
const ship = data.ship(shipClass);
if (!ship || !ship.grids?.length) {
  console.error(`no cargo grids for ${shipClass}`);
  process.exit(1);
}
// Left-to-right order on the page; ports not named keep the data's order after the named ones.
const rank = (p: string) => (order.includes(p) ? order.indexOf(p) : order.length);
const grids = [...ship.grids].sort((x, y) => rank(String(x.port)) - rank(String(y.port))).map((g) => ({ name: String(g.port), w: g.w, l: g.l, h: g.h, maxBox: g.maxBox ?? undefined }));

// Same footprints the widget draws (overlay/hauling-stow.js header).
const DIMS: Record<number, [number, number, number]> = {
  32: [2, 8, 2], 24: [2, 6, 2], 16: [2, 4, 2], 8: [2, 2, 2], 4: [2, 2, 1], 2: [1, 2, 1], 1: [1, 1, 1],
};
const items: PackItem[] = [];
let n = 0;
for (const scu of [32, 24, 16, 8, 4, 2, 1]) {
  for (;;) {
    const trial = [...items, { id: `b${n}`, scu, dims: DIMS[scu], group: `${scu} SCU` }];
    const r = packCargo(grids, trial);
    if (!r.fits || r.unplaced.length) break;
    items.push(trial[trial.length - 1]);
    n++;
  }
}
const pack = packCargo(grids, items);
const loaded = pack.placements.reduce((s, p) => s + p.scu, 0);
const tally: Record<string, number> = {};
for (const p of pack.placements) tally[p.scu] = (tally[p.scu] ?? 0) + 1;
console.log(`${ship.displayName}: ${ship.totalScu} SCU in ${grids.length} grids; packer fits ${loaded} SCU as`,
  Object.entries(tally).sort((a, b) => Number(b[0]) - Number(a[0])).map(([s, c]) => `${c}x${s}`).join(" + "));

const spec = {
  className: ship.className,
  displayName: ship.displayName,
  totalScu: ship.totalScu,
  // The patch the GRIDS were measured on: ships-extra.json's when the hull comes from there.
  version: (() => {
    try {
      const x = JSON.parse(readFileSync(join(process.cwd(), "data", "ships-extra.json"), "utf8"));
      if (x.ships?.[ship.className]) return String(x.version);
    } catch { /* no extras file */ }
    return data.counts().version ?? "";
  })(),
  theme,
  labels,
  grids,
  placements: pack.placements,
};
mkdirSync(outDir, { recursive: true });
const specPath = join(tmpdir(), `cargo-grids-${shipClass}-${process.pid}.json`);
writeFileSync(specPath, JSON.stringify(spec));

const electron = join(process.cwd(), "node_modules", "electron", "dist", "electron.exe");
const r = spawnSync(electron, [join(process.cwd(), "tools", "render-cargo-grids.cjs"), specPath, outDir], {
  stdio: "inherit", timeout: 120_000, killSignal: "SIGKILL", windowsHide: true,
});
process.exit(r.status ?? 1);
