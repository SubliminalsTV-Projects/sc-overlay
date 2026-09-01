// Quartermaster store tests. Plain tsx + check(), the repo's no-framework pattern:
//   npx tsx src/quartermaster.test.ts
// Every rule the store promises is pinned here: ledger-derived stock, op stamping,
// consume refusal, chip dedupe/auto, report math, corrupt-file = empty.

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { Quartermaster, type QmReport } from "./quartermaster.js";

let passed = 0;
let failed = 0;
function check(what: string, ok: boolean, detail = ""): void {
  if (ok) { passed++; console.log("  ✓ " + what); }
  else { failed++; console.log("  ✗ " + what + (detail ? " — " + detail : "")); }
}

function fresh(): { qm: Quartermaster; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "qm-test-"));
  const qm = new Quartermaster(join(dir, "quartermaster.json"), join(dir, "quartermaster-ops"), "chips");
  return { qm, dir };
}

// ── ship + item setup ─────────────────────────────────────────────────────────
console.log("\nships and items");

{
  const { qm } = fresh();
  const ship = qm.addShip("Hammerfall", "Aegis Idris");
  check("a ship registers with a callsign and type", ship.name === "Hammerfall" && ship.type === "Aegis Idris");
  const item = qm.addItem(ship.id, "Hydrogen Fuel", "SCU");
  check("an item joins the ship's stock", item.shipId === ship.id && item.unit === "SCU");
  const v = qm.view();
  check("the view exposes ship + item rows", v.ships.length === 1 && v.items.length === 1);
  check("fresh stock is zero and null-priced", v.items[0].inStock === 0 && v.items[0].lastUnitPrice === null);
  let threw = "";
  try { qm.addItem("nope", "X", "SCU"); } catch (e) { threw = (e as Error).message; }
  check("an item for an unknown ship is refused", threw.includes("no such ship"), threw);
}

// ── supply / consume / derived stock ──────────────────────────────────────────
console.log("\nsupply and consume");

{
  const { qm } = fresh();
  const ship = qm.addShip("Hammerfall", "Aegis Idris");
  const fuel = qm.addItem(ship.id, "Hydrogen Fuel", "SCU");
  qm.addSupply({ shipId: ship.id, itemId: fuel.id, qty: 1000, unitPrice: 8 });
  qm.addSupply({ shipId: ship.id, itemId: fuel.id, qty: 500 }); // starting stock, no price
  let v = qm.view();
  check("in stock is derived from supply records", v.items[0].inStock === 1500, String(v.items[0].inStock));
  check("last known unit price is remembered", v.items[0].lastUnitPrice === 8);
  qm.addConsume({ shipId: ship.id, itemId: fuel.id, qty: 200 });
  v = qm.view();
  check("consume deducts from stock", v.items[0].inStock === 1300, String(v.items[0].inStock));
  check("spent outside an operation is zero", v.items[0].spent === 0, String(v.items[0].spent));
  const rec = v.records.find((r) => r.kind === "supply" && r.qty === 1000);
  check("supply cost is qty × unit price, rounded", rec?.cost === 8000, String(rec?.cost));
  let threw = "";
  try { qm.addConsume({ shipId: ship.id, itemId: fuel.id, qty: 99999 }); } catch (e) { threw = (e as Error).message; }
  check("consuming more than stock REFUSES rather than clamps", threw.includes("in stock"), threw);
  if (rec) qm.deleteRecord(rec.id);
  v = qm.view();
  check("deleting a ledger row corrects derived stock", v.items[0].inStock === 1500 - 200 - 1000, String(v.items[0].inStock));
}

// ── operations ────────────────────────────────────────────────────────────────
console.log("\noperations");

{
  const { qm } = fresh();
  const ship = qm.addShip("Hammerfall", "Aegis Idris");
  const fuel = qm.addItem(ship.id, "Hydrogen Fuel", "SCU");
  qm.addSupply({ shipId: ship.id, itemId: fuel.id, qty: 1000, unitPrice: 8 });
  const op = qm.startOp(ship.id, "Operation Hammerford");
  check("an op starts with a name and no end", op.endedAt === null);
  let threw = "";
  try { qm.startOp(ship.id, "second"); } catch (e) { threw = (e as Error).message; }
  check("a second concurrent op is refused", threw.includes("already running"), threw);
  qm.addConsume({ shipId: ship.id, itemId: fuel.id, qty: 100 });
  let v = qm.view();
  check("records during an op are stamped with its id", v.records.some((r) => r.opId === op.id && r.kind === "consume"), "no stamped record found");
  check("spent counts only the current op", v.items[0].spent === 100, String(v.items[0].spent));
  check("currentOp is exposed", v.currentOp?.id === op.id);
  qm.stopOp();
  v = qm.view();
  check("stop ends the op", v.currentOp === null);
  check("after stop, spent resets", v.items[0].spent === 0, String(v.items[0].spent));
  check("an op gets a default name when none given", qm.startOp(ship.id, "").name.startsWith("Operation "));
}

// ── ops survive a restart (they span hours and crashes) ───────────────────────
console.log("\noperations persist across a restart");

{
  const { qm, dir } = fresh();
  const ship = qm.addShip("Hammerfall", "Aegis Idris");
  const op = qm.startOp(ship.id, "Long haul");
  // Force the debounced save to land before reopening.
  await new Promise((r) => setTimeout(r, 600));
  const qm2 = new Quartermaster(join(dir, "quartermaster.json"), join(dir, "quartermaster-ops"), "chips");
  check("a running op is still running after reload", qm2.view().currentOp?.id === op.id);
}

// ── services and losses ───────────────────────────────────────────────────────
console.log("\nservices and losses");

{
  const { qm } = fresh();
  const ship = qm.addShip("Hammerfall", "Aegis Idris");
  const fuel = qm.addItem(ship.id, "Hydrogen Fuel", "SCU");
  qm.addSupply({ shipId: ship.id, itemId: fuel.id, qty: 100, unitPrice: 8 });
  const op = qm.startOp(ship.id, "Op");
  qm.addService("repair", { shipId: ship.id, cost: 45000 });
  qm.addService("rearm", { shipId: ship.id, cost: 12000 });
  qm.addService("refuel", { shipId: ship.id, cost: 3000 });
  const sq = qm.addSquadShip({ name: "Red Two", type: "Aegis Gladius", fit: "2x S3", value: 1200000 });
  qm.destroySquadShip(sq.id, ship.id);
  const v = qm.view();
  check("services record as aUEC costs under the running op", v.records.filter((r) => r.opId === op.id && r.cost != null).length === 3);
  check("destroy writes a loss record with the value snapshot", v.records.some((r) => r.kind === "loss" && r.lossValue === 1200000));
  check("destroy removes the squad ship", !v.squad.some((s) => s.id === sq.id));
  let threw = "";
  try { qm.addService("repair", { shipId: ship.id, cost: null }); } catch (e) { threw = (e as Error).message; }
  check("a service without a cost is refused", threw.includes("cost"), threw);
}

// ── chips (auto-capture suggestions) ──────────────────────────────────────────
console.log("\ncapture chips");

{
  const { qm } = fresh();
  const ship = qm.addShip("Hammerfall", "Aegis Idris");
  const sig = { commodityUuid: "de9f4d03-0000-0000-0000-000000000000", itemName: "Hydrogen Fuel", qty: 1000, unit: "SCU", unitPrice: 8, total: 8000, shopName: "TDD_SCShop-001" };
  const r1 = qm.notePurchase(sig);
  check("a kiosk fuel buy queues a chip in chips mode", r1.added && !r1.committed);
  check("the chip carries the real paid price", qm.view().chips[0].total === 8000);
  const r2 = qm.notePurchase(sig);
  check("an identical purchase does not queue twice", !r2.added && !r2.committed);
  const chipId = qm.view().chips[0].id;
  qm.commitChip(chipId);
  const v = qm.view();
  check("committing creates the item and a 'logged' supply record", v.chips.length === 0 && v.records.some((r) => r.kind === "supply" && r.source === "logged" && r.cost === 8000));
  check("committed chip stock shows up", v.items.some((i) => i.item.name === "Hydrogen Fuel" && i.inStock === 1000));
  // A second purchase of the same commodity now joins the EXISTING item.
  const r3 = qm.notePurchase({ ...sig, qty: 500, unitPrice: 9, total: 4500 });
  check("later purchases join by commodity uuid", r3.added);
}

{
  // AUTO mode: commits immediately, no chip.
  const { qm } = fresh();
  qm.setCapture("auto");
  qm.addShip("Hammerfall", "Aegis Idris");
  const r = qm.notePurchase({ commodityUuid: "de9f4d03-0000-0000-0000-000000000000", itemName: "Hydrogen Fuel", qty: 100, unit: "SCU", unitPrice: 8, total: 800, shopName: null });
  check("auto mode commits without a chip", r.committed && qm.view().chips.length === 0);
  check("auto commit is marked source logged", qm.view().records.some((x) => x.source === "logged"));
}

{
  // OFF mode, and unrelated commodities are never captured.
  const { qm } = fresh();
  qm.addShip("Hammerfall", "Aegis Idris");
  qm.setCapture("off");
  const r1 = qm.notePurchase({ commodityUuid: "x", itemName: "Hydrogen Fuel", qty: 1, unit: "SCU", unitPrice: 1, total: 1, shopName: null });
  check("off mode captures nothing", !r1.added && !r1.committed);
  qm.setCapture("chips");
  const r2 = qm.notePurchase({ commodityUuid: "unrelated-uuid", itemName: "Laranite", qty: 10, unit: "SCU", unitPrice: 5, total: 50, shopName: null });
  check("an untracked commodity is never guessed into stock", !r2.added && !r2.committed);
}

// ── the report ────────────────────────────────────────────────────────────────
console.log("\noperation report");

{
  const { qm } = fresh();
  const ship = qm.addShip("Hammerfall", "Aegis Idris");
  const fuel = qm.addItem(ship.id, "Hydrogen Fuel", "SCU");
  const ammo = qm.addItem(ship.id, "Ship Ammunition - Size 3", "units");
  const op = qm.startOp(ship.id, "Operation Hammerford");
  qm.addSupply({ shipId: ship.id, itemId: fuel.id, qty: 1000, unitPrice: 8 });   // 8000
  qm.addSupply({ shipId: ship.id, itemId: ammo.id, qty: 40, unitPrice: 50 });    // 2000
  qm.addConsume({ shipId: ship.id, itemId: fuel.id, qty: 600, notes: "refuelled Red Two" });
  qm.addService("repair", { shipId: ship.id, cost: 45000 });
  qm.addService("rearm", { shipId: ship.id, cost: 12000 });
  const sq = qm.addSquadShip({ name: "Red Two", type: "Aegis Gladius", fit: "", value: 1200000 });
  qm.destroySquadShip(sq.id, ship.id);
  qm.stopOp();
  // A post-op supply must NOT count toward this report.
  qm.addSupply({ shipId: ship.id, itemId: fuel.id, qty: 100, unitPrice: 8 });

  const rep = qm.buildReport(op.id);
  check("supply total counts only op-stamped records", rep.supplyTotal === 10000, String(rep.supplyTotal));
  check("repair and rearm totals separate", rep.repairTotal === 45000 && rep.rearmTotal === 12000);
  check("services total sums the three verbs", rep.servicesTotal === 45000 + 12000, String(rep.servicesTotal));
  check("consumed stock priced at last known price", rep.consumedQty[0]?.replacementCost === 4800, JSON.stringify(rep.consumedQty));
  check("consumed total", rep.consumedTotal === 4800, String(rep.consumedTotal));
  check("the loss snapshot lands in the report", rep.lossesTotal === 1200000, String(rep.lossesTotal));
  const expected = 10000 + 57000 + 4800 + 1200000;
  check("grand total = supplies + services + consumed + losses", rep.grandTotal === expected, rep.grandTotal + " vs " + expected);
  const text = qm.renderReportText(rep);
  check("the text twin names the operation and the ship", text.includes("Operation Hammerford") && text.includes("Hammerfall"));
  check("the text twin carries the grand total", text.includes("1,271,800"), text.slice(0, 400));
  await qm.writeReport(rep);
  check("report twins are written to the ops folder", existsSync(join(qm.opsFolder(), op.id + ".txt")));
  check("the ops index regenerates", existsSync(join(qm.opsFolder(), "index.html")));
}

{
  // Unpriced paths stay honest: no price → excluded, counted, labelled.
  const { qm } = fresh();
  const ship = qm.addShip("Hammerfall", "Aegis Idris");
  const rmc = qm.addItem(ship.id, "RMC", "units");
  const op = qm.startOp(ship.id, "Op");
  qm.addSupply({ shipId: ship.id, itemId: rmc.id, qty: 100 });   // starting stock, no price
  qm.addConsume({ shipId: ship.id, itemId: rmc.id, qty: 30 });
  qm.addService("repair", { shipId: ship.id, cost: 500 });
  qm.stopOp();
  const rep = qm.buildReport(op.id);
  check("an unpriced supply is excluded from totals", rep.supplyTotal === 0, String(rep.supplyTotal));
  check("unpriced figures are counted, not guessed", rep.unpricedCount === 1);
  check("unpriced consumed stock is labelled, not valued", rep.consumedQty[0]?.replacementCost === null && rep.unpricedConsumed === 1);
  check("grand total counts only what was priced", rep.grandTotal === 500);
  const text = qm.renderReportText(rep);
  check("the report says which figures are missing", text.includes("unpriced") && text.includes("not counted"), text);
}

// ── corrupt state = empty, never damage ───────────────────────────────────────
console.log("\ncorrupt state");

{
  const dir = mkdtempSync(join(tmpdir(), "qm-test-"));
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "quartermaster.json"), "{ not json at all");
  const qm = new Quartermaster(join(dir, "quartermaster.json"), join(dir, "quartermaster-ops"), "chips");
  check("a corrupt file loads as empty, not a crash", qm.view().ships.length === 0);
  const ship = qm.addShip("X", "Aegis Idris");
  check("an empty store still works afterwards", ship.id.startsWith("ship-"));
}

// ── sanitize caps ─────────────────────────────────────────────────────────────
console.log("\ncaps");

{
  const { qm, dir } = fresh();
  const ship = qm.addShip("Hammerfall", "Aegis Idris");
  const sq = qm.addSquadShip({ name: "Red Two", type: "Aegis Gladius", fit: "2x S3", value: 1200000,
    fitUrl: "https://www.spviewer.eu/performance?ship=aegs_gladius&loadout=Ab3xY9",
    fitItems: [{ name: "'Arrow' I Missile", price: 240 }, { name: "Mystery Gun", price: null }],
    fitHullPrice: 1200000 });
  qm.updateSquadShip(sq.id, { value: 1250000 });
  let v = qm.view();
  const s = v.squad[0];
  check("fit link + components persist on the squad ship", !!s.fitUrl?.includes("loadout=Ab3xY9") && s.fitItems.length === 2, JSON.stringify(s.fitItems));
  check("fit hull price persists", s.fitHullPrice === 1200000);
  check("updating value does not wipe the fit fields", s.fitItems.length === 2);
  check("value update sticks", s.value === 1250000);
  // Reload the SAME file after the debounced save lands.
  await new Promise((r) => setTimeout(r, 600));
  const qm2 = new Quartermaster(join(dir, "quartermaster.json"), join(dir, "quartermaster-ops"), "chips");
  const reloaded = qm2.view().squad.find((x) => x.name === "Red Two");
  check("fit fields survive a restart", reloaded?.fitUrl === s.fitUrl && reloaded?.fitItems.length === 2 && reloaded?.fitHullPrice === 1200000,
    JSON.stringify(reloaded?.fitItems));
}

{
  const { qm } = fresh();
  let threwAt = -1;
  for (let i = 0; i < 60; i++) {
    try { qm.addSquadShip({ name: "S" + i, type: "light", fit: "", value: i }); }
    catch { threwAt = i; break; }
  }
  check("squad is capped at 24 and the 25th is refused", threwAt === 24, "refused at " + threwAt);
}

console.log("\n" + (failed === 0 ? `all ${passed} checks passed` : `${failed} FAILED of ${passed + failed}`));
process.exit(failed === 0 ? 0 : 1);