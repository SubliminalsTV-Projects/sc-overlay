import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Phrasebook, findLanguageFile, readGameLanguage } from "./localization.js";

let passed = 0;
function ok(cond: unknown, what: string): void {
  assert(cond, what);
  passed++;
}

const root = mkdtempSync(join(tmpdir(), "loc-"));
const dataDir = join(root, "data");
mkdirSync(dataDir, { recursive: true });

// The shipped phrasebook, in miniature. `keyToEnglish` is what lets us pivot a file we have
// never seen; `languages` is the precomputed table for players with no loose file at all.
writeFileSync(
  join(dataDir, "lang.latest.json"),
  JSON.stringify({
    schema: 1,
    version: "test",
    changelist: "1",
    keyToEnglish: {
      item_Name_COOL_AEGS_S01_Glacier: "Glacier",
      item_Name_QDRV_JUST_S01_Colossus: "Colossus",
      item_Name_SHLD_BASL_S02_Rampart: "Rampart",
      SomeContract_title: "Deep space hit",
    },
    languages: {
      "german_(germany)": { "Omnisky-III-Kanone": "Omnisky III Cannon" },
      "french_(france)": { "Canon Omnisky III": "Omnisky III Cannon" },
    },
  }),
);

function install(name: string, files: Record<string, string>): string {
  const channel = join(root, name);
  mkdirSync(channel, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const p = join(channel, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
  }
  writeFileSync(join(channel, "Game.log"), "");
  return join(channel, "Game.log");
}

// ── No loose file: the bundled tables carry it ──────────────────────────────
// This is the ordinary install, and the case nobody has ever reported because it looks
// exactly like "sync isn't working".
const vanillaLog = install("VANILLA", {});
const pbV = new Phrasebook(dataDir);
const infoV = pbV.load(vanillaLog);
ok(infoV.source === "bundled", "no loose file must fall back to the bundled tables");
ok(pbV.translate("Omnisky-III-Kanone") === "Omnisky III Cannon", "a German name must translate");
ok(pbV.translate("Canon Omnisky III") === "Omnisky III Cannon", "a French name must translate");
ok(pbV.translate("Glacier") === null, "an English name needs no translation and must return null");
ok(pbV.translate("Totally Made Up") === null, "an unknown name must not be guessed at");

// ── A language pack: the file on disk wins, whatever pack it came from ──────
// ExoAE's shape (suffix), Remix2's (quoted designation) and BeltaKoda's (leading code) are
// all just values in this file — we never identify which pack it is.
const packIni = [
  "item_Name_COOL_AEGS_S01_Glacier=Glacier Military A",
  'item_Name_SHLD_BASL_S02_Rampart=MIL-2A "Rampart"',
  "item_Name_QDRV_JUST_S01_Colossus=B10 Colossus",
  "SomeContract_title=Deep space hit <EM4>[300 Rep] [BP]*</EM4>",
].join("\r\n");
const packLog = install("PACK", {
  "user.cfg": "g_language = english\n",
  "data/Localization/english/global.ini": packIni,
});
ok(readGameLanguage(join(root, "PACK")) === "english", "g_language must be read out of user.cfg");
const found = findLanguageFile(packLog);
ok(found?.path.endsWith(join("english", "global.ini")) === true, "the loose global.ini must be located from the log path");

const pbP = new Phrasebook(dataDir);
const infoP = pbP.load(packLog);
ok(infoP.source === "ini", "a loose global.ini must take precedence over the bundled tables");
ok(pbP.translate("Glacier Military A") === "Glacier", "ExoAE's suffix form must resolve");
ok(pbP.translate('MIL-2A "Rampart"') === "Rampart", "Remix2's quoted form must resolve");
ok(pbP.translate("B10 Colossus") === "Colossus", "Remix's leading-code form must resolve — it failed 166/166 before this");
ok(pbP.translate("Deep space hit <EM4>[300 Rep] [BP]*</EM4>") === "Deep space hit", "a decorated mission title must resolve");
ok(pbP.translate("Omnisky-III-Kanone") === null, "the bundled tables must NOT leak in once a real file is in play");

// ── Ambiguity is declined, never guessed ───────────────────────────────────
// Remix points a number of item names at the literal "PLACEHOLDER". Crediting one of them
// would put a wrong blueprint in the collection and sync it to the site under that name.
const ambLog = install("AMBIGUOUS", {
  "user.cfg": "g_language = english\n",
  "data/Localization/english/global.ini": [
    "item_Name_COOL_AEGS_S01_Glacier=PLACEHOLDER",
    "item_Name_SHLD_BASL_S02_Rampart=PLACEHOLDER",
    "item_Name_QDRV_JUST_S01_Colossus=B10 Colossus",
  ].join("\n"),
});
const pbA = new Phrasebook(dataDir);
pbA.load(ambLog);
ok(pbA.translate("PLACEHOLDER") === null, "a string meaning two different items must be declined");
ok(pbA.translate("B10 Colossus") === "Colossus", "...without taking its unambiguous neighbours down with it");

// ── Format drift is DETECTED, not silently mis-parsed ──────────────────────
// No pack or language does this today (all four packs only wrap the notification in markup,
// which the parser strips), which is why the parser has no per-install patterns. This is the
// tripwire for that decision — if it ever changes, diagnostics say so rather than the app
// quietly going blind.
ok(pbP.status().formatDrift.length === 0, "markup-only decoration is not drift — the parser handles it");
const driftLog = install("DRIFT", {
  "user.cfg": "g_language = english\n",
  "data/Localization/english/global.ini":
    "crafting_hud_notification_received_blueprint,P=BP Unlocked: %s\nitem_Name_COOL_AEGS_S01_Glacier=Glacier X",
});
const pbD = new Phrasebook(dataDir);
pbD.load(driftLog);
ok(pbD.status().formatDrift.includes("crafting_hud_notification_received_blueprint,P"),
  "reworded notification text must be reported as drift");
ok(pbD.translate("Glacier X") === "Glacier", "...while the names in the same file still resolve");

// ── g_language picks between several installed folders ─────────────────────
// The tiebreaker only matters when more than one exists, which is exactly what a player
// accumulates by trying two packs.
const multiLog = install("MULTI", {
  "user.cfg": "g_language = german\n",
  "data/Localization/english/global.ini": "item_Name_COOL_AEGS_S01_Glacier=WRONG ONE",
  "data/Localization/german/global.ini": "item_Name_COOL_AEGS_S01_Glacier=Gletscher",
});
const pbM = new Phrasebook(dataDir);
pbM.load(multiLog);
ok(pbM.translate("Gletscher") === "Glacier", "g_language must decide which folder is live");
ok(pbM.translate("WRONG ONE") === null, "the folder g_language did not name must be ignored");

// ── Rebuild semantics ──────────────────────────────────────────────────────
// Calibrate exists because a pack updates. A cache keyed on the path alone would serve the
// old names forever and the button would appear to do nothing.
const before = pbP.status().at;
writeFileSync(join(root, "PACK", "data", "Localization", "english", "global.ini"),
  packIni.replace("Glacier Military A", "Glacier Mil A v2"));
pbP.load(packLog, null, true);
ok(pbP.translate("Glacier Mil A v2") === "Glacier", "a forced reload must pick up an edited file");
ok(pbP.translate("Glacier Military A") === null, "...and must drop what the old file said");
ok(pbP.status().at !== before, "a rebuild must restamp, so diagnostics can show when it happened");

// ── Missing data file degrades quietly ─────────────────────────────────────
const pbNone = new Phrasebook(join(root, "no-such-dir"));
const infoN = pbNone.load(vanillaLog);
ok(infoN.source === "none", "a missing lang file must report source 'none'");
ok(pbNone.translate("Omnisky-III-Kanone") === null, "...and must translate nothing rather than throw");

// ── End to end through the tracker, against the REAL shipped data ──────────
// The unit tests above prove the lookup. These prove the thing that actually broke: that a
// receipt logged in another language ends up in the collection as the English name, so the
// pool lights up and the sync payload is identical to an English player's.
{
  const { MissionTracker } = await import("./missions.js");
  const receipt = (name: string) =>
    ({ kind: "blueprintReceived", ts: new Date().toISOString(), name, missionId: null }) as never;

  const tk = new MissionTracker({ dataDir: "data", stateDir: mkdtempSync(join(tmpdir(), "loc-tk-")) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const t = tk as any;
  t.loadDataset();
  t.setLogPath(install("STOCK-DE", {}));
  ok(t.localizationStatus().source === "bundled", "a stock install must use the bundled tables");

  // "Omnisky-III-Kanone" is the real German name for a real pool blueprint.
  t.apply(receipt("Omnisky-III-Kanone"));
  ok(t.isOwned("Omnisky III Cannon")?.owned === true,
    "a German receipt must satisfy the English pool entry");
  ok([...t.observed].includes("Omnisky III Cannon"),
    "the collection must store English — it syncs with replace:true and the site renders it");
  ok(![...t.observed].includes("Omnisky-III-Kanone"),
    "...and must NOT store the localized string, which would sync a name nothing can render");
  ok(t.localizationStatus().unrecognized.length === 0, "a translated name is not unrecognized");

  // A name no phrasebook can place is kept, flagged, and never guessed at.
  t.apply(receipt("Ein Völlig Erfundener Gegenstand"));
  const un = t.localizationStatus().unrecognized;
  ok(un.length === 1 && un[0].name === "Ein Völlig Erfundener Gegenstand",
    "an unplaceable name must be surfaced, not silently dropped");
  ok(t.isOwned("Omnisky III Cannon")?.owned === true, "...without disturbing what did resolve");

  // An English install must behave exactly as it did before any of this existed.
  const tkEn = new MissionTracker({ dataDir: "data", stateDir: mkdtempSync(join(tmpdir(), "loc-en-")) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = tkEn as any;
  e.loadDataset();
  e.setLogPath(install("STOCK-EN", {}));
  e.apply(receipt("Omnisky III Cannon"));
  ok(e.isOwned("Omnisky III Cannon")?.owned === true, "an English receipt must still resolve");
  ok(e.localizationStatus().unrecognized.length === 0, "an English receipt must never be flagged");
}

rmSync(root, { recursive: true, force: true });
console.log(`localization: ${passed}/${passed} passed`);
