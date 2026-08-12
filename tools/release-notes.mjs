// Generate GitHub release notes from a version's changelog block.
//
//   node tools/release-notes.mjs 0.1.39 > notes.md
//
// Step 3 of the release recipe used to be a one-liner that joined overlay/changelog.json's notes
// with "- ". Notes are objects now ({ kind, label, text }), so that line would emit a list of
// [object Object] — hence a real generator rather than a note in the docs saying "careful".
//
// The grouping and its order are the card's, deliberately: the release page and the in-app
// "What's new" are the same notes read in two places, and they should not disagree about what
// counts as a fix. A legacy plain-string note (0.1.33 and older) still renders, as a bare bullet.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KINDS = [["new", "New"], ["improved", "Improved"], ["fixed", "Fixed"]];

const version = process.argv[2];
if (!version) {
  console.error("usage: node tools/release-notes.mjs <version>");
  process.exit(2);
}

const changelog = JSON.parse(readFileSync(join(ROOT, "overlay", "changelog.json"), "utf8"));
const block = changelog[version];
if (!block) {
  console.error(`no changelog block for ${version} — add one before cutting the release`);
  process.exit(1);
}

const notes = (Array.isArray(block) ? block : block.notes ?? [])
  .map((n) => (typeof n === "string" ? { kind: null, label: null, text: n } : n))
  .filter((n) => n && typeof n.text === "string" && n.text.trim());
if (!notes.length) {
  console.error(`${version}'s block has no notes`);
  process.exit(1);
}

const bullet = (n) => (n.label ? `- **${n.label}** — ${n.text}` : `- ${n.text}`);
const out = [];

// Unkinded notes first and unheaded, matching the card: an old block is shown as it was written,
// not sorted into sections it never had.
const unkinded = notes.filter((n) => !n.kind);
if (unkinded.length) out.push(unkinded.map(bullet).join("\n"));

for (const [kind, heading] of KINDS) {
  const group = notes.filter((n) => n.kind === kind);
  if (group.length) out.push(`### ${heading}\n\n${group.map(bullet).join("\n")}`);
}

process.stdout.write(out.join("\n\n") + "\n");
