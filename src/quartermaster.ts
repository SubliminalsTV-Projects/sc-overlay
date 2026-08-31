/**
 * Quartermaster store — capital-ship expense, stock and squad tracking for the
 * Quartermaster widget.
 *
 * What this is: the captain of a ship with hangar services (Idris, Polaris, Carrack,
 * 890 Jump, Ironclad Assault) tracks the stock it rearm/resupply/repair other ships
 * from (fuel, ammunition, missiles, repair materials), the aUEC it spends on its own
 * station services, the squad ships operating off its hangar, and — start/stop — an
 * "operation" whose cost report is the point of the whole exercise.
 *
 * The ledger of records is the single source of truth: In Stock and Spent are always
 * derived from it, never stored, so deleting a wrong row corrects the numbers
 * automatically. Money always carries provenance ("logged" = read off a real kiosk
 * purchase line; "entered" = typed by a human) and the report labels both.
 *
 * Repair/Rearm/Refuel here are the CAPITAL ship's own station services: aUEC amounts,
 * stock untouched (decided with Sub). Servicing squad ships from the capital's stock
 * happens through Consume — refuelling the Idris's snub with hydrogen from the Idris's
 * own fuel stock is a Consume on that fuel item.
 *
 * An operation spans hours and app restarts, so it is persisted while running (unlike
 * payout-scan's mode, which deliberately resets). Consume refuses when the amount
 * exceeds stock rather than clamping — a silent clamp is how a spreadsheet lies.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { writeFile, mkdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

export type QmCaptureMode = "off" | "chips" | "auto";

export type QmRecordKind =
  | "supply"
  | "consume"
  | "repair"
  | "rearm"
  | "refuel"
  | "loss";

export interface QmShip {
  id: string;
  /** Callsign the org actually uses. Orgs run more than one Idris; the type alone is not enough. */
  name: string;
  /** One of the curated carriers in data/qm-ships.json. */
  type: string;
}

export interface QmSquadShip {
  id: string;
  name: string;
  type: string;
  /** Free text: "2x S3 missiles, 1x NV-4" etc. */
  fit: string;
  /** Ship + fit value in aUEC, manual entry. Snapshoted as the loss value when destroyed. */
  value: number | null;
}

export interface QmItem {
  id: string;
  /** The capital ship whose stock this row belongs to. */
  shipId: string;
  name: string;
  /** "SCU" | "units" - free but suggested. Fuel/ammo bought at kiosks is SCU; discrete stores are units. */
  unit: string;
  /** Joins commodities.json when the item is a kiosk commodity (Hydrogen Fuel, Ship Ammunition sizes, ...). */
  commodityUuid?: string;
}

export interface QmRecord {
  id: string;
  shipId: string;
  /** The operation this was recorded during, or null when recorded outside any operation. */
  opId: string | null;
  at: string;
  kind: QmRecordKind;
  /** "logged" = price read off a real purchase line; "entered" = typed by a human. */
  source: "entered" | "logged";
  /** supply/consume: which stock item. loss: which squad ship. null for capital services. */
  itemId: string | null;
  /** supply/consume: quantity moved. null for aUEC-only records. */
  qty: number | null;
  /** supply: paid unit price, when known. null = starting stock or unknown price. */
  unitPrice: number | null;
  /** supply/repair/rearm/refuel: the aUEC amount. null for consume/loss. */
  cost: number | null;
  /** supply: where it came from ("Port Tressler"). repair etc: notes. */
  location: string | null;
  notes: string | null;
  /** loss only: the squad ship's value snapshot at destroy time. */
  lossValue: number | null;
}

export interface QmOperation {
  id: string;
  shipId: string;
  name: string;
  startedAt: string;
  endedAt: string | null;
}

export interface QmChip {
  id: string;
  shipId: string;
  at: string;
  commodityUuid: string;
  itemName: string;
  qty: number;
  unit: string;
  unitPrice: number;
  total: number;
  /** Shop token the purchase line carried (TDD_SCShop-001 style), shown raw for honesty. */
  shopName: string | null;
  opId: string | null;
}

export interface QmStockRow {
  item: QmItem;
  /** Derived: net supply - net consume, over ALL records (all time). */
  inStock: number;
  /** Derived: consumed during the CURRENT operation only (0 outside an op). */
  spent: number;
  /** Last known unit price (paid or entered), for supply-cost prefill and replacement estimates. */
  lastUnitPrice: number | null;
}

export interface QmView {
  ships: QmShip[];
  squad: QmSquadShip[];
  items: QmStockRow[];
  /** Newest first. */
  records: QmRecord[];
  ops: QmOperation[];
  /** The currently running operation, or null. Exactly one can run at a time. */
  currentOp: QmOperation | null;
  chips: QmChip[];
  capture: QmCaptureMode;
}

export interface QmReport {
  id: string;
  op: QmOperation;
  shipName: string;
  lines: { label: string; kind: QmRecordKind | "summary"; cost: number | null; source: "entered" | "logged" | null; qty?: number; unit?: string; item?: string; notes?: string }[];
  supplyTotal: number;
  servicesTotal: number;
  repairTotal: number;
  rearmTotal: number;
  refuelTotal: number;
  /** Consumed-from-stock valued at last known price; null entries mean unpriced stock. */
  consumedQty: { item: string; qty: number; unit: string; replacementCost: number | null }[];
  consumedTotal: number;
  unpricedConsumed: number;
  losses: { ship: string; value: number | null }[];
  lossesTotal: number;
  /** supply + services + consumed replacement + losses, priced portion only. */
  grandTotal: number;
  /** How many figures were unpriced and therefore excluded from the totals. */
  unpricedCount: number;
}

const MAX_SHIPS = 8;
const MAX_SQUAD = 24;
const MAX_ITEMS = 48;
const MAX_RECORDS = 4000;
const MAX_OPS = 200;
const MAX_CHIPS = 12;
const MAX_OPS_ON_DISK = 100;

interface Persisted {
  ships?: unknown;
  squad?: unknown;
  items?: unknown;
  records?: unknown;
  ops?: unknown;
  chips?: unknown;
}

function id(prefix: string): string {
  return prefix + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function str(v: unknown, max: number): string {
  return String(v ?? "").trim().slice(0, max);
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return isFinite(n) && n >= 0 ? n : null;
}

/** The commodity families the capture hook is allowed to notice when no inventory item
 *  joins by uuid. Fuel and ship ammunition only — a random Laranite buy is never
 *  guessed into someone's stock (refuse-rather-than-guess). */
const KNOWN_CAPTURE_NAME_HINT = /\b(hydrogen fuel|quantum fuel|ship ammunition|fuel)\b/i;

function setCaptureMode(mode: unknown): QmCaptureMode {
  return mode === "auto" ? "auto" : mode === "chips" ? "chips" : "off";
}

function sanitizeShips(raw: unknown): QmShip[] {
  return (Array.isArray(raw) ? raw : [])
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
    .map((s) => ({ id: str(s.id, 48) || id("ship"), name: str(s.name, 40), type: str(s.type, 40) }))
    .filter((s) => s.name)
    .slice(0, MAX_SHIPS);
}

function sanitizeSquad(raw: unknown): QmSquadShip[] {
  return (Array.isArray(raw) ? raw : [])
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
    .map((s) => ({
      id: str(s.id, 48) || id("sq"),
      name: str(s.name, 40),
      type: str(s.type, 40),
      fit: str(s.fit, 80),
      value: num(s.value),
    }))
    .filter((s) => s.name)
    .slice(0, MAX_SQUAD);
}

function sanitizeItems(raw: unknown): QmItem[] {
  return (Array.isArray(raw) ? raw : [])
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
    .map((s) => ({
      id: str(s.id, 48) || id("it"),
      shipId: str(s.shipId, 48),
      name: str(s.name, 60),
      unit: str(s.unit, 12) || "SCU",
      commodityUuid: str(s.commodityUuid, 64) || undefined,
    }))
    .filter((s) => s.name && s.shipId)
    .slice(0, MAX_ITEMS);
}

function sanitizeRecords(raw: unknown): QmRecord[] {
  return (Array.isArray(raw) ? raw : [])
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
    .map((s): QmRecord => ({
      id: str(s.id, 48) || id("rec"),
      shipId: str(s.shipId, 48),
      opId: str(s.opId, 48) || null,
      at: str(s.at, 40) || new Date().toISOString(),
      kind: (["supply", "consume", "repair", "rearm", "refuel", "loss"] as const).includes(s.kind as QmRecordKind) ? (s.kind as QmRecordKind) : "supply",
      source: s.source === "logged" ? "logged" as const : "entered" as const,
      itemId: str(s.itemId, 48) || null,
      qty: num(s.qty),
      unitPrice: num(s.unitPrice),
      cost: num(s.cost),
      location: str(s.location, 60) || null,
      notes: str(s.notes, 200) || null,
      lossValue: num(s.lossValue),
    }))
    .filter((r) => r.shipId)
    .slice(0, MAX_RECORDS);
}

function sanitizeOps(raw: unknown): QmOperation[] {
  return (Array.isArray(raw) ? raw : [])
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
    .map((s) => ({
      id: str(s.id, 48) || id("op"),
      shipId: str(s.shipId, 48),
      name: str(s.name, 80),
      startedAt: str(s.startedAt, 40) || new Date().toISOString(),
      endedAt: str(s.endedAt, 40) || null,
    }))
    .filter((o) => o.shipId)
    .slice(0, MAX_OPS);
}

function sanitizeChips(raw: unknown): QmChip[] {
  return (Array.isArray(raw) ? raw : [])
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
    .map((s) => ({
      id: str(s.id, 48) || id("chip"),
      shipId: str(s.shipId, 48),
      at: str(s.at, 40) || new Date().toISOString(),
      commodityUuid: str(s.commodityUuid, 64),
      itemName: str(s.itemName, 60),
      qty: num(s.qty) ?? 0,
      unit: str(s.unit, 12) || "SCU",
      unitPrice: num(s.unitPrice) ?? 0,
      total: num(s.total) ?? 0,
      shopName: str(s.shopName, 60) || null,
      opId: str(s.opId, 48) || null,
    }))
    .filter((c) => c.commodityUuid && c.qty > 0)
    .slice(0, MAX_CHIPS);
}

/** The Qm items that arrive from CommodityPurchase lines. cSCU volumes are converted to SCU by
 *  the caller; qty here is whatever unit the item stores in. */
export interface QmPurchaseSignal {
  commodityUuid: string;
  itemName: string;
  qty: number;
  unit: string;
  unitPrice: number;
  total: number;
  shopName: string | null;
}

export class Quartermaster {
  private ships: QmShip[] = [];
  private squad: QmSquadShip[] = [];
  private items: QmItem[] = [];
  private records: QmRecord[] = [];
  private ops: QmOperation[] = [];
  private chips: QmChip[] = [];
  private saveTimer: NodeJS.Timeout | null = null;
  /** Set when the capture loop commits a chip automatically, so the chip dismiss is honest. */
  private autoCommit = false;

  constructor(private readonly file: string, private readonly opsDir: string, capture: QmCaptureMode) {
    this.captureMode = capture;
    this.load();
  }

  // ── persistence ────────────────────────────────────────────────────────
  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const data = JSON.parse(readFileSync(this.file, "utf8")) as Persisted;
      this.ships = sanitizeShips(data.ships);
      this.squad = sanitizeSquad(data.squad);
      this.items = sanitizeItems(data.items);
      this.records = sanitizeRecords(data.records);
      this.ops = sanitizeOps(data.ops);
      this.chips = sanitizeChips(data.chips);
    } catch {
      /* corrupt or missing: empty, never damage, never crash the sidecar */
    }
  }

  private save(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      void (async () => {
        try {
          await mkdir(dirname(this.file), { recursive: true });
          await writeFile(this.file, JSON.stringify({
            ships: this.ships, squad: this.squad, items: this.items,
            records: this.records, ops: this.ops, chips: this.chips,
          }, null, 2));
        } catch {
          /* best-effort: never worth taking the sidecar down for */
        }
      })();
    }, 400);
  }

  // ── derived stock ─────────────────────────────────────────────────────
  private stockOf(itemId: string): { inStock: number; spent: number; lastUnitPrice: number | null } {
    let inStock = 0;
    let spent = 0;
    let lastUnitPrice: number | null = null;
    const currentOp = this.runningOp();
    for (const r of this.records) {
      if (r.itemId !== itemId) continue;
      if (r.kind === "supply" && r.qty != null) inStock += r.qty;
      if (r.kind === "consume" && r.qty != null) inStock -= r.qty;
      if (r.kind === "consume" && currentOp && r.opId === currentOp.id && r.qty != null) spent += r.qty;
      if (r.kind === "supply" && r.unitPrice != null) lastUnitPrice = r.unitPrice;
    }
    return { inStock, spent, lastUnitPrice };
  }

  private runningOp(): QmOperation | null {
    return this.ops.find((o) => !o.endedAt) ?? null;
  }

  // ── ships ──────────────────────────────────────────────────────────────
  addShip(name: string, type: string): QmShip {
    const ship: QmShip = { id: id("ship"), name: str(name, 40), type: str(type, 40) };
    if (!ship.name) throw new Error("name required");
    this.ships.push(ship);
    this.save();
    return ship;
  }

  removeShip(shipId: string): void {
    // A ship only goes when everything under it is already gone; the widget asks first.
    if (this.records.some((r) => r.shipId === shipId) || this.items.some((i) => i.shipId === shipId)) {
      throw new Error("ship still has items or records");
    }
    this.ops = this.ops.filter((o) => o.shipId !== shipId);
    this.ships = this.ships.filter((s) => s.id !== shipId);
    this.save();
  }

  // ── squad ──────────────────────────────────────────────────────────────
  addSquadShip(raw: unknown): QmSquadShip {
    if (this.squad.length >= MAX_SQUAD) throw new Error("squad is full");
    const b = (raw ?? {}) as Record<string, unknown>;
    const ship: QmSquadShip = {
      id: id("sq"), name: str(b.name, 40), type: str(b.type, 40),
      fit: str(b.fit, 80), value: num(b.value),
    };
    if (!ship.name) throw new Error("name required");
    this.squad.push(ship);
    this.save();
    return ship;
  }

  updateSquadShip(squadId: string, raw: unknown): QmSquadShip {
    const b = (raw ?? {}) as Record<string, unknown>;
    const s = this.squad.find((x) => x.id === squadId);
    if (!s) throw new Error("no such squad ship");
    s.name = str(b.name, 40) || s.name;
    s.type = str(b.type, 40) || s.type;
    s.fit = str(b.fit, 80);
    if ("value" in b) s.value = num(b.value);
    this.save();
    return s;
  }

  /** Mark destroyed: writes a loss record (value snapshot) and removes the squad ship. */
  destroySquadShip(squadId: string, shipId: string): QmRecord {
    const s = this.squad.find((x) => x.id === squadId);
    if (!s) throw new Error("no such squad ship");
    const op = this.runningOp();
    const rec: QmRecord = {
      id: id("rec"), shipId, opId: op ? op.id : null, at: new Date().toISOString(),
      kind: "loss", source: "entered", itemId: null, qty: null,
      unitPrice: null, cost: null, location: null,
      notes: s.name + " (" + s.type + ")", lossValue: s.value,
    };
    this.records.push(rec);
    this.squad = this.squad.filter((x) => x.id !== squadId);
    this.save();
    return rec;
  }

  removeSquadShip(squadId: string): void {
    this.squad = this.squad.filter((x) => x.id !== squadId);
    this.save();
  }

  // ── items ──────────────────────────────────────────────────────────────
  addItem(shipId: string, name: string, unit: string, commodityUuid?: string): QmItem {
    const ship = this.ships.find((s) => s.id === shipId);
    if (!ship) throw new Error("no such ship");
    const item: QmItem = { id: id("it"), shipId, name: str(name, 60), unit: str(unit, 12) || "SCU" };
    if (commodityUuid) item.commodityUuid = str(commodityUuid, 64);
    if (!item.name) throw new Error("name required");
    this.items.push(item);
    this.save();
    return item;
  }

  removeItem(itemId: string): void {
    if (this.records.some((r) => r.itemId === itemId)) throw new Error("item still has records");
    this.items = this.items.filter((i) => i.id !== itemId);
    this.save();
  }

  // ── ledger ─────────────────────────────────────────────────────────────
  addSupply(b: Record<string, unknown>): QmRecord {
    const shipId = str(b.shipId, 48);
    const item = this.items.find((i) => i.id === str(b.itemId, 48));
    if (!shipId || !item) throw new Error("no such item");
    const qty = num(b.qty);
    if (qty == null || qty <= 0) throw new Error("quantity required");
    const unitPrice = num(b.unitPrice);
    const cost = unitPrice != null ? unitPrice * qty : num(b.cost);
    const op = this.runningOp();
    const rec: QmRecord = {
      id: id("rec"), shipId, opId: op ? op.id : null, at: new Date().toISOString(),
      kind: "supply", source: b.source === "logged" ? "logged" : "entered",
      itemId: item.id, qty, unitPrice,
      cost: cost != null ? Math.round(cost) : null,
      location: str(b.location, 60) || null, notes: str(b.notes, 200) || null,
      lossValue: null,
    };
    this.records.push(rec);
    this.save();
    return rec;
  }

  addConsume(b: Record<string, unknown>): QmRecord {
    const shipId = str(b.shipId, 48);
    const item = this.items.find((i) => i.id === str(b.itemId, 48));
    if (!shipId || !item) throw new Error("no such item");
    const qty = num(b.qty);
    if (qty == null || qty <= 0) throw new Error("quantity required");
    // Refuse, never clamp: taking more than is in stock is a mistake, and a silent clamp
    // would turn it into a wrong number instead of a caught one.
    const stock = this.stockOf(item.id);
    if (qty > stock.inStock) throw new Error(`only ${stock.inStock} ${item.unit} in stock`);
    const op = this.runningOp();
    const rec: QmRecord = {
      id: id("rec"), shipId, opId: op ? op.id : null, at: new Date().toISOString(),
      kind: "consume", source: "entered", itemId: item.id, qty,
      unitPrice: null, cost: null, location: null,
      notes: str(b.notes, 200) || null, lossValue: null,
    };
    this.records.push(rec);
    this.save();
    return rec;
  }

  addService(kind: "repair" | "rearm" | "refuel", b: Record<string, unknown>): QmRecord {
    const shipId = str(b.shipId, 48);
    if (!shipId) throw new Error("ship required");
    const cost = num(b.cost);
    if (cost == null || cost < 0) throw new Error("cost required");
    const op = this.runningOp();
    const rec: QmRecord = {
      id: id("rec"), shipId, opId: op ? op.id : null, at: new Date().toISOString(),
      kind, source: "entered", itemId: null, qty: null,
      unitPrice: null, cost, location: null,
      notes: str(b.notes, 200) || null, lossValue: null,
    };
    this.records.push(rec);
    this.save();
    return rec;
  }

  deleteRecord(recordId: string): void {
    this.records = this.records.filter((r) => r.id !== recordId);
    this.save();
  }

  // ── operations ──────────────────────────────────────────────────────────
  startOp(shipId: string, name: string): QmOperation {
    if (this.runningOp()) throw new Error("an operation is already running");
    const op: QmOperation = {
      id: id("op"), shipId, name: str(name, 80) || this.defaultOpName(),
      startedAt: new Date().toISOString(), endedAt: null,
    };
    this.ops.push(op);
    this.save();
    return op;
  }

  private defaultOpName(): string {
    const d = new Date();
    return "Operation " + d.toLocaleString("en-US", { month: "short", day: "numeric" });
  }

  stopOp(): QmOperation {
    const op = this.runningOp();
    if (!op) throw new Error("no operation running");
    op.endedAt = new Date().toISOString();
    this.save();
    return op;
  }

  // ── chips (auto-capture suggestions) ────────────────────────────────────
  private captureMode: QmCaptureMode;
  getCapture(): QmCaptureMode { return this.captureMode; }
  /** Config-driven: the widget posts the mode; "off" is the default and the honest one. */
  setCapture(raw: unknown): void { this.captureMode = setCaptureMode(raw); }

  /** Called from the confirmed-purchase funnel for kiosk buys that join a stock item by uuid,
   *  or are one of the tracked commodity families (fuel, ship ammunition). */
  notePurchase(p: QmPurchaseSignal): { added: boolean; committed: boolean } {
    if (this.captureMode === "off" || this.ships.length === 0) return { added: false, committed: false };
    // Join: an existing inventory item with this commodity uuid wins; otherwise only the
    // known families are captured - never guess a random commodity into someone's stock.
    const item = this.items.find((i) => i.commodityUuid === p.commodityUuid);
    if (!item && !KNOWN_CAPTURE_NAME_HINT.test(p.itemName)) return { added: false, committed: false };
    const shipId = item ? item.shipId : this.ships[0].id;
    // Dedupe key: same commodity + qty + price within the same op is the same purchase.
    const opId = this.runningOp()?.id ?? null;
    const dup = this.chips.some((c) => c.commodityUuid === p.commodityUuid && c.qty === p.qty && c.unitPrice === p.unitPrice && c.opId === opId);
    if (dup) return { added: false, committed: false };
    // When no matching item exists yet, the chip carries the name itself, so one click
    // can create item + record together (commitChip); auto mode does the same unasked.
    const chip: QmChip = {
      id: id("chip"), shipId, at: new Date().toISOString(),
      commodityUuid: p.commodityUuid, itemName: item ? item.name : p.itemName,
      qty: p.qty, unit: item ? item.unit : p.unit, unitPrice: p.unitPrice,
      total: p.total, shopName: p.shopName, opId,
    };
    if (this.captureMode === "auto") {
      this.commitChipInternal(chip, item ?? null);
      return { added: false, committed: true };
    }
    this.chips.push(chip);
    if (this.chips.length > MAX_CHIPS) this.chips = this.chips.slice(-MAX_CHIPS);
    this.save();
    return { added: true, committed: false };
  }

  /** One click on a chip: create the item if needed, then the supply record at the real paid price. */
  commitChip(chipId: string): void {
    const chip = this.chips.find((c) => c.id === chipId);
    if (!chip) throw new Error("no such chip");
    this.commitChipInternal(chip, this.items.find((i) => i.commodityUuid === chip.commodityUuid && i.shipId === chip.shipId) ?? null);
    this.chips = this.chips.filter((c) => c.id !== chipId);
    this.save();
  }

  private commitChipInternal(chip: QmChip, item: QmItem | null): QmRecord {
    let it = item;
    if (!it) {
      it = this.items.find((i) => i.name.toLowerCase() === chip.itemName.toLowerCase() && i.shipId === chip.shipId)
        ?? this.addItem(chip.shipId, chip.itemName, chip.unit, chip.commodityUuid);
    }
    const op = this.runningOp();
    const rec: QmRecord = {
      id: id("rec"), shipId: chip.shipId, opId: chip.opId ?? (op ? op.id : null),
      at: chip.at, kind: "supply", source: "logged",
      itemId: it.id, qty: chip.qty, unitPrice: chip.unitPrice,
      cost: Math.round(chip.total), location: chip.shopName, notes: null, lossValue: null,
    };
    this.records.push(rec);
    this.save();
    return rec;
  }

  dismissChip(chipId: string): void {
    this.chips = this.chips.filter((c) => c.id !== chipId);
    this.save();
  }

  // ── report ─────────────────────────────────────────────────────────────
  buildReport(opId: string): QmReport {
    const op = this.ops.find((o) => o.id === opId);
    if (!op) throw new Error("no such operation");
    const ship = this.ships.find((s) => s.id === op.shipId);
    const recs = this.records.filter((r) => r.opId === op.id);
    const lines: QmReport["lines"] = [];
    let supplyTotal = 0;
    let repairTotal = 0;
    let rearmTotal = 0;
    let refuelTotal = 0;
    let unpricedCount = 0;
    const consumed = new Map<string, { qty: number; unit: string; name: string; price: number | null }>();
    const losses: { ship: string; value: number | null }[] = [];
    for (const r of recs) {
      const item = r.itemId ? this.items.find((i) => i.id === r.itemId) ?? null : null;
      if (r.kind === "supply") {
        const cost = r.cost;
        if (cost != null) supplyTotal += cost;
        lines.push({ label: "Supply " + (item ? item.name : "?"), kind: "supply", cost, source: r.source, qty: r.qty ?? undefined, unit: item?.unit, item: item?.name, notes: r.location ?? undefined });
      } else if (r.kind === "repair" || r.kind === "rearm" || r.kind === "refuel") {
        if (r.cost != null) {
          if (r.kind === "repair") repairTotal += r.cost;
          else if (r.kind === "rearm") rearmTotal += r.cost;
          else refuelTotal += r.cost;
        }
        lines.push({ label: r.kind[0].toUpperCase() + r.kind.slice(1), kind: r.kind, cost: r.cost, source: r.source, notes: r.notes ?? undefined });
      } else if (r.kind === "consume") {
        const key = r.itemId ?? "?";
        const name = item?.name ?? "?";
        const price = item ? this.stockOf(item.id).lastUnitPrice : null;
        const c = consumed.get(key) ?? { qty: 0, unit: item?.unit ?? "SCU", name, price };
        c.qty += r.qty ?? 0;
        consumed.set(key, c);
        lines.push({ label: "Consumed " + name, kind: "consume", cost: null, source: null, qty: r.qty ?? undefined, unit: item?.unit, item: name, notes: r.notes ?? undefined });
      } else if (r.kind === "loss") {
        const value = r.lossValue;
        losses.push({ ship: r.notes ?? "?", value });
        lines.push({ label: "Lost " + (r.notes ?? "squad ship"), kind: "loss", cost: value, source: "entered", notes: r.notes ?? undefined });
      }
      if ((r.kind === "supply" || r.kind === "repair" || r.kind === "rearm" || r.kind === "refuel") && r.cost == null) unpricedCount++;
    }
    const consumedQty = [...consumed.entries()].map(([k, c]) => {
      const replacementCost = c.price != null ? c.price * c.qty : null;
      return { item: c.name, qty: c.qty, unit: c.unit, replacementCost: replacementCost != null ? Math.round(replacementCost) : null };
    }).filter((c) => c.qty > 0);
    const consumedTotal = consumedQty.reduce((t, c) => t + (c.replacementCost ?? 0), 0);
    const unpricedConsumed = consumedQty.filter((c) => c.replacementCost == null).length;
    const lossesTotal = losses.reduce((t, l) => t + (l.value ?? 0), 0);
    const servicesTotal = repairTotal + rearmTotal + refuelTotal;
    const grandTotal = supplyTotal + servicesTotal + consumedTotal + lossesTotal;
    return {
      id: op.id, op, shipName: ship?.name ?? op.shipId, lines,
      supplyTotal, servicesTotal, repairTotal, rearmTotal, refuelTotal,
      consumedQty, consumedTotal, unpricedConsumed,
      losses, lossesTotal, grandTotal, unpricedCount,
    };
  }

  /** Plain-text twin of the report - the file an org treasurer opens days later. */
  renderReportText(rep: QmReport): string {
    const n = (v: number) => Math.round(v).toLocaleString("en-US");
    const start = new Date(rep.op.startedAt).toLocaleString("en-US");
    const end = rep.op.endedAt ? new Date(rep.op.endedAt).toLocaleString("en-US") : "(still running)";
    let mins = rep.op.endedAt ? Math.round((Date.parse(rep.op.endedAt) - Date.parse(rep.op.startedAt)) / 60000) : Math.round((Date.now() - Date.parse(rep.op.startedAt)) / 60000);
    const L: string[] = [
      "SC Overlay - Quartermaster operation report",
      "=".repeat(46),
      rep.op.name + "  (" + rep.shipName + ")",
      "Started: " + start,
      "Ended:   " + end + "  (" + mins + " min)",
      "",
      "Expenses",
      "-".repeat(46),
      "Supplies purchased:      " + n(rep.supplyTotal) + " aUEC",
      "Repairs:                 " + n(rep.repairTotal) + " aUEC",
      "Rearm:                   " + n(rep.rearmTotal) + " aUEC",
      "Refuel:                  " + n(rep.refuelTotal) + " aUEC",
    ];
    if (rep.consumedQty.length) {
      L.push("", "Consumed from stock (replacement cost at last known price)");
      for (const c of rep.consumedQty) {
        L.push("  " + c.item.padEnd(28) + String(c.qty).padStart(9) + " " + c.unit.padEnd(5) +
          (c.replacementCost != null ? "  " + n(c.replacementCost).padStart(11) + " aUEC" : "  (unpriced)"));
      }
      L.push("  " + "-".repeat(52));
      L.push("  " + "Consumed total".padEnd(28) + String("").padStart(9) + " ".padEnd(5) + n(rep.consumedTotal).padStart(11) + " aUEC");
    }
    if (rep.losses.length) {
      L.push("", "Squad losses");
      for (const l of rep.losses) {
        L.push("  " + l.ship.padEnd(28) + (l.value != null ? n(l.value).padStart(11) + " aUEC" : "(unvalued)"));
      }
      L.push("  " + "-".repeat(52));
      L.push("  " + "Losses total".padEnd(28) + String("").padStart(9) + " ".padEnd(5) + n(rep.lossesTotal).padStart(11) + " aUEC");
    }
    L.push("=".repeat(46));
    L.push("GRAND TOTAL  " + n(rep.grandTotal) + " aUEC");
    if (rep.unpricedCount > 0 || rep.unpricedConsumed > 0) {
      L.push("(" + (rep.unpricedCount + rep.unpricedConsumed) + " figure(s) unpriced and not counted)");
    }
    return L.join("\r\n") + "\r\n";
  }

  /** Write report twins (.json + .txt) to the ops folder, plus a regenerated index. */
  async writeReport(rep: QmReport): Promise<void> {
    try {
      await mkdir(this.opsDir, { recursive: true });
      await writeFile(join(this.opsDir, rep.id + ".json"), JSON.stringify(rep, null, 2));
      await writeFile(join(this.opsDir, rep.id + ".txt"), this.renderReportText(rep));
      await this.writeOpsIndex();
    } catch {
      /* best-effort: a failed report write must never take the sidecar down */
    }
  }

  opsFolder(): string { return this.opsDir; }

  private async writeOpsIndex(): Promise<void> {
    const reps: QmReport[] = [];
    try {
      if (existsSync(this.opsDir)) {
        for (const f of readdirSync(this.opsDir)) {
          if (!f.endsWith(".json") || f === "index.json") continue;
          try { reps.push(JSON.parse(readFileSync(join(this.opsDir, f), "utf8")) as QmReport); }
          catch { /* skip unreadable */ }
        }
      }
    } catch { /* folder unreadable: empty index */ }
    reps.sort((a, b) => Date.parse(b.op.startedAt) - Date.parse(a.op.startedAt));
    const rows = reps.slice(0, MAX_OPS_ON_DISK).map((r) => ({
      id: r.id, name: r.op.name, ship: r.shipName,
      startedAt: r.op.startedAt, endedAt: r.op.endedAt, grandTotal: r.grandTotal,
      supplyTotal: r.supplyTotal, servicesTotal: r.servicesTotal,
      consumedTotal: r.consumedTotal, lossesTotal: r.lossesTotal, unpricedCount: r.unpricedCount,
    }));
    const data = JSON.stringify(rows).replace(/</g, "\\u003c");
    const html = `<!doctype html>
<meta charset="utf-8"><title>SC Overlay - Quartermaster operation reports</title>
<style>
 :root{--bg:#0b1119;--pan:#101a24;--line:#1e3242;--cy:#45D0E0;--go:#FFD27A;--tx:#c4dbe6;--dim:#7fa7bb;--faint:#5d7e90}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.5 Inter,system-ui,sans-serif;padding:28px}
 h1{font-size:16px;letter-spacing:.18em;text-transform:uppercase;color:var(--cy);margin:0 0 4px}
 .sub{color:var(--faint);font-size:12px;margin-bottom:22px}
 .card{background:var(--pan);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin-bottom:14px;max-width:820px}
 .ch{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:8px}
 .ch b{font-size:15px;color:var(--cy)}
 .ch .w{color:var(--faint);font-size:12px;font-family:ui-monospace,Consolas,monospace}
 .ch .p{margin-left:auto;color:var(--go);font-family:ui-monospace,Consolas,monospace;font-weight:600}
 .row{display:flex;gap:26px;flex-wrap:wrap;font-size:13px;color:var(--dim)}
 .row b{color:var(--tx);font-family:ui-monospace,Consolas,monospace}
 .f{margin-top:6px;font-size:11px;color:var(--faint)}
 .empty{color:var(--faint)}
</style>
<h1>Quartermaster operation reports</h1>
<div class="sub">SC Overlay &middot; regenerated whenever an operation report is written. The matching .json and .txt files sit in this folder.</div>
<div id="out"></div>
<script>
const R=${data};
const n=v=>Math.round(v).toLocaleString();
const out=document.getElementById("out");
if(!R.length){out.innerHTML='<div class="empty">No operations reported yet.</div>';}
for(const r of R){
 const d=document.createElement("div");d.className="card";
 const h=document.createElement("div");h.className="ch";
 const b=document.createElement("b");b.textContent=r.name;
 const w=document.createElement("span");w.className="w";w.textContent=r.ship+" \\u00b7 "+new Date(r.startedAt).toLocaleString();
 h.append(b,w);
 const p=document.createElement("span");p.className="p";p.textContent=n(r.grandTotal)+" aUEC";
 h.append(p);d.append(h);
 const row=document.createElement("div");row.className="row";
 row.innerHTML="<span>Supplies <b>"+n(r.supplyTotal)+"</b></span><span>Services <b>"+n(r.servicesTotal)+"</b></span><span>Consumed <b>"+n(r.consumedTotal)+"</b></span><span>Losses <b>"+n(r.lossesTotal)+"</b></span>";
 d.append(row);
 if(r.unpricedCount>0){const f=document.createElement("div");f.className="f";f.textContent=r.unpricedCount+" unpriced figure(s) excluded from totals";d.append(f);}
 out.append(d);
}
</script>`;
    try { await writeFile(join(this.opsDir, "index.html"), html); }
    catch { /* best-effort */ }
  }

  /** Trim old op reports when the folder grows past MAX_OPS_ON_DISK. */
  async pruneOps(): Promise<void> {
    try {
      if (!existsSync(this.opsDir)) return;
      const files = readdirSync(this.opsDir)
        .filter((f) => f.endsWith(".json") && f !== "index.json")
        .map((f) => ({ f, t: statSync(join(this.opsDir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      for (const { f } of files.slice(MAX_OPS_ON_DISK)) {
        const base = f.replace(/\.json$/, "");
        await unlink(join(this.opsDir, base + ".json"));
        await unlink(join(this.opsDir, base + ".txt"));
      }
    } catch {
      /* best-effort: pruning is hygiene, never fatal */
    }
  }

  // ── view ───────────────────────────────────────────────────────────────
  view(): QmView {
    return {
      ships: this.ships,
      squad: this.squad,
      items: this.items.map((item) => {
        const s = this.stockOf(item.id);
        return { item, inStock: s.inStock, spent: s.spent, lastUnitPrice: s.lastUnitPrice };
      }),
      records: [...this.records].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, 400),
      ops: [...this.ops].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).slice(0, 50),
      currentOp: this.runningOp(),
      chips: this.chips,
      capture: this.captureMode,
    };
  }
}