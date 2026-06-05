import { writeFileSync, mkdirSync } from "node:fs";

import { resolveLoadout } from "./erkul.js";

// Usage: npx tsx src/erkul-dump.ts [erkulUrlOrId] [outFile]
const idOrUrl = process.argv[2] ?? "Zjbboonv";
const out = process.argv[3] ?? "overlay/loadout.js";

const build = await resolveLoadout(idOrUrl);
mkdirSync("overlay", { recursive: true });
writeFileSync(out, `window.LOADOUT = ${JSON.stringify(build, null, 2)};\n`);
console.log(`wrote ${out} — ${build.ship.name}, ${build.items.length} top-level items`);
