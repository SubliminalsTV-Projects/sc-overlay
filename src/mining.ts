// Mining Assistant tracker — two jobs, fed by the screen OCR:
//   1. Signature scanner: a scanned mineable's signature number -> the rock type + cluster
//      size (exact lookup in data/mineables.json). If it's a rock the player flagged as a
//      target, emit "target-hit" so the overlay can speak + flash.
//   2. Refinery timer: each active PROCESSING order's "TIME REMAINING" becomes a local
//      countdown (absolute end time), so a 14-hour refine survives an app restart. Emits
//      "refinery-done" once when a job finishes so the overlay can alarm.
//
// State (targets + jobs) persists to %APPDATA%/sc-blueprint-tracker/mining.json.
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RefineryRead } from "./screen-read.js";

interface Mineable { name: string; rarity: string; base: number; sigs: number[]; }
interface MineablesData {
  rocks: Mineable[];
  index: Record<string, { name: string; rarity: string; count: number }[]>;
}

/** A tracked refinery job (an active PROCESSING order). `endAt` is absolute so the
 *  countdown is correct across app restarts. */
export interface RefineryJob {
  id: string;
  key: string;           // station#order — the STABLE dedup identity (not the material)
  station: string | null;
  order: number;
  material: string | null;
  yieldScu: number | null;
  endAt: number;         // epoch ms when the refine finishes
  readAt: number;        // when last read off the console
  doneNotified: boolean; // the "done" alarm already fired
}

export interface MiningView {
  rocks: { name: string; rarity: string }[]; // catalog for the target picker
  targets: string[];                          // rock names the player is hunting
  scan: { signature: number; matches: { name: string; rarity: string; count: number }[]; at: number } | null;
  jobs: {
    id: string; station: string | null; material: string | null; yieldScu: number | null;
    endAt: number; remainingSec: number; done: boolean;
  }[];
}

const DONE_KEEP_MS = 6 * 3600 * 1000; // keep a finished job visible ~6h, then auto-clear
// Signature floor: the scanner ignores any read below this entirely — no rock/debris call-out
// and no scanner display. Filters out low-value noise (tiny/distant contacts) the player doesn't
// want announced; only 2,000+ signatures get a response.
const MIN_SIGNATURE = 2000;

export class MiningTracker extends EventEmitter {
  private data: MineablesData | null = null;
  private jobs = new Map<string, RefineryJob>();
  private targets = new Set<string>();
  private scan: MiningView["scan"] = null;
  private readonly stateDir: string;
  private readonly statePath: string;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private seq = 0;

  constructor(opts: { dataDir: string; stateDir: string }) {
    super();
    this.stateDir = opts.stateDir;
    this.statePath = join(opts.stateDir, "mining.json");
    try {
      this.data = JSON.parse(readFileSync(join(opts.dataDir, "mineables.json"), "utf8")) as MineablesData;
    } catch {
      this.data = null;
    }
    this.load();
    // Fire "refinery-done" as jobs cross zero, and prune long-finished ones.
    this.ticker = setInterval(() => this.tick(), 2000);
    if (typeof this.ticker.unref === "function") this.ticker.unref();
  }

  // ---- signature scanner ----

  /** A scanned signature number -> the matching rock(s). Exact-match only (values can be
   *  5 apart, so a tolerance would pick the wrong rock). Unknown numbers are ignored. */
  applyMineableRead(signature: number): void {
    if (!this.data) return;
    if (signature < MIN_SIGNATURE) return; // below the floor -> ignore entirely (no display, no call-out)
    const matches = this.data.index[String(signature)] ?? []; // empty = not a rock -> salvage debris
    // Ignore a repeat read of the same signature (the loop polls the same rock every ~3s);
    // only a CHANGED signature is news worth re-announcing.
    if (this.scan && this.scan.signature === signature) return;
    this.scan = { signature, matches, at: Date.now() };
    const hit = matches.find((m) => this.targets.has(m.name));
    this.emit("change");
    if (hit) this.emit("target-hit", { ...hit, signature });
  }

  setTarget(name: string, on: boolean): void {
    if (on) this.targets.add(name);
    else this.targets.delete(name);
    this.save();
    this.emit("change");
  }

  // ---- refinery ----

  /** Fold the PROCESSING orders read off the console into the tracked-job set. Re-viewing
   *  the console re-reads the same job (its remaining has ticked down consistently), so it
   *  updates in place rather than duplicating — matched by station+material and either an
   *  equal yield or a predicted-remaining that lines up with the fresh read. */
  applyRefineryRead(read: RefineryRead): void {
    const now = Date.now();
    let changed = false;
    for (const j of read.jobs) {
      if (j.remainingSec <= 0) continue;
      const endAt = now + j.remainingSec * 1000;
      const key = `${read.station ?? ""}#${j.order}`; // stable per work-order slot
      const ex = [...this.jobs.values()].find((e) => e.key === key);
      if (ex) {
        // Guard against an occasional dropped-hours misread (e.g. "9h 20m" read as "20m")
        // yanking a good long timer down to minutes: ignore a read that suddenly SHORTENS
        // the job by >40min, unless it already finished (a new job may have taken the slot).
        if ((ex.endAt - now) / 1000 - j.remainingSec > 2400 && ex.endAt > now) continue;
        ex.endAt = endAt;
        ex.readAt = now;
        ex.doneNotified = false;
        if (j.material) ex.material = j.material;
        if (j.yieldScu != null) ex.yieldScu = j.yieldScu;
      } else {
        const id = `job${++this.seq}`;
        this.jobs.set(id, { id, key, station: read.station, order: j.order, material: j.material, yieldScu: j.yieldScu, endAt, readAt: now, doneNotified: false });
      }
      changed = true;
    }
    if (changed) { this.save(); this.emit("change"); }
  }

  removeJob(id: string): void {
    if (this.jobs.delete(id)) { this.save(); this.emit("change"); }
  }

  private tick(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, j] of this.jobs) {
      if (!j.doneNotified && j.endAt <= now) {
        j.doneNotified = true;
        changed = true;
        this.emit("refinery-done", { id, station: j.station, material: j.material, yieldScu: j.yieldScu });
      }
      if (j.doneNotified && now - j.endAt > DONE_KEEP_MS) { this.jobs.delete(id); changed = true; }
    }
    if (changed) { this.save(); this.emit("change"); }
  }

  view(): MiningView {
    const now = Date.now();
    return {
      rocks: (this.data?.rocks ?? []).map((r) => ({ name: r.name, rarity: r.rarity })),
      targets: [...this.targets],
      scan: this.scan,
      jobs: [...this.jobs.values()]
        .sort((a, b) => a.endAt - b.endAt)
        .map((j) => ({
          id: j.id, station: j.station, material: j.material, yieldScu: j.yieldScu,
          endAt: j.endAt, remainingSec: Math.max(0, Math.round((j.endAt - now) / 1000)), done: j.endAt <= now,
        })),
    };
  }

  private load(): void {
    try {
      const d = JSON.parse(readFileSync(this.statePath, "utf8"));
      this.targets = new Set(d.targets ?? []);
      // Drop pre-fix stale jobs (they lack the work-order `key`) so old wrong timers with
      // dropped hours / duplicate materials clear themselves out on the next launch.
      for (const j of d.jobs ?? []) if (j.key) this.jobs.set(j.id, j);
      this.seq = d.seq ?? this.jobs.size;
    } catch {
      /* first run */
    }
  }

  private save(): void {
    try {
      if (!existsSync(this.stateDir)) mkdirSync(this.stateDir, { recursive: true });
      const tmp = this.statePath + ".tmp";
      writeFileSync(tmp, JSON.stringify({ targets: [...this.targets], jobs: [...this.jobs.values()], seq: this.seq }, null, 2));
      renameSync(tmp, this.statePath);
    } catch {
      /* non-fatal */
    }
  }
}
