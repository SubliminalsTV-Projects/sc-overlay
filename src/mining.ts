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
  // `confirmed`: the scan glyph was found beside the number in the frame, so this came from a
  // real scan rather than being a number the OCR happened to find (see applyMineableRead).
  // `verdict`: what the number MEANS — see classifySignature. The widget renders and speaks off
  // this rather than re-deriving it from `matches.length`, so there is one rule, not two.
  scan: { signature: number; matches: { name: string; rarity: string; count: number }[]; at: number; confirmed: boolean; verdict: ScanVerdict } | null;
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
// One salvage panel of debris. Debris comes in whole panels, so a debris signature is always a
// MULTIPLE of this — that, and not "it isn't in the rock table", is what identifies debris
// (Sub, 2026-07-29).
const DEBRIS_STEP = 2000;

/** What a scanned number means.
 *  - `ore` — it resolves to a rock, and no amount of debris lands on that value. Say the rock.
 *  - `ore-or-debris` — it resolves to a rock AND is a whole number of debris panels. Genuinely
 *    ambiguous, and only flying over will settle it, so it is announced either way: the player
 *    has to go look regardless.
 *  - `debris` — a whole number of panels, no rock at that value.
 *  - `unknown` — in range, but neither. Not ore, not debris; a real scan of something we can't
 *    name (or an OCR read that came out wrong).
 *  A read outside [MIN_SIGNATURE, maxSignature] gets no verdict at all — see classifySignature. */
export type ScanVerdict = "ore" | "ore-or-debris" | "debris" | "unknown";

/** Is this value a whole number of debris panels? Replaces the old "2,000 or anything ≥4,000"
 *  rule, which let every large stray HUD number through as debris. Between 2,000 and the ceiling
 *  there are only 13 debris values, so this is a far tighter filter than a floor ever was. */
export function isDebrisValue(signature: number): boolean {
  return signature >= DEBRIS_STEP && signature % DEBRIS_STEP === 0;
}

/** Classify a scanned signature. `null` means the number cannot be a contact at all — below the
 *  floor, or above the largest signature the game can show — so it is a misread and gets no
 *  response of any kind.
 *
 *  🔑 The asymmetry that decides everything here: a value matching the rock table is honoured
 *  whatever else is true of it, because losing a real ore call-out is far worse than a stray
 *  debris one. Only the non-ore verdicts have to earn their announcement. */
export function classifySignature(signature: number, isOre: boolean, maxSignature: number): ScanVerdict | null {
  if (!Number.isFinite(signature) || signature < MIN_SIGNATURE || signature > maxSignature) return null;
  const debris = isDebrisValue(signature);
  if (isOre) return debris ? "ore-or-debris" : "ore";
  return debris ? "debris" : "unknown";
}

/** What a read did, so the sidecar can log it — this is the only place that knows the rules, so it
 *  is the only place that can explain them. `why` lands in sidecar.log for every single read. */
export interface ScanOutcome {
  verdict: ScanVerdict | null;
  /** A fresh call-out went out for this read. */
  announced: boolean;
  /** The read was USED — it is what the scanner is showing now. Distinct from `announced`, because
   *  the loop re-reads the same rock every poll: the second read of a rock you are still looking at
   *  announces nothing but is entirely valid. Conflating the two made the readout strike out the
   *  live number a second after it appeared, which read as "sometimes it just shows a crossed out
   *  number" (Sub, 2026-07-29). Struck through = NOT used, and nothing else. */
  used: boolean;
  why: string;
  repairedFrom?: number;
}

/** Digits the OCR confuses in the HUD's font. Sub, 2026-07-29: sixes and eights "are the only two
 *  numbers that are consistently making it so that it reads the wrong number". */
const CONFUSABLE_DIGITS: Record<string, string> = { "6": "8", "8": "6" };

/** Fix confused digits by CONSTRAINING the read to values the game can actually show.
 *
 *  This is the answer to "can you train it better": the OCR can't be trained, but it doesn't need to
 *  be. A signature is one of only ~165 legal values spread over 2,000–25,800 — **0.69% of that
 *  range** — so a wrong digit almost always lands on a number that cannot exist, and usually exactly
 *  one legal value is one or two 6/8 swaps away.
 *
 *  🔴 ONE-DIGIT-ONLY WAS TOO NARROW (Rytharr, 2026-08-07): a real read of 18,980 should have been
 *  16,960 (Copper ×4) — TWO digits confused in the same number, which the original one-swap-only
 *  version couldn't reach and so left as "unknown" all night. Measured over the real table before
 *  changing anything: allowing a SECOND simultaneous swap repairs 10 more real misreads (74 -> 84)
 *  with **zero** new ambiguity — no case that single-swap could uniquely resolve becomes ambiguous
 *  once pairs are tried too, because the same uniqueness rule below still applies across the whole
 *  combined search, not just within one swap count.
 *
 *  What keeps it honest:
 *  - **A value that is already legal is never touched** — 6,800 (Lindinium ×2) is taken at face
 *    value, not "corrected" to 8,600 (Ice ×2). An exact match is evidence in its own right.
 *  - **Ambiguity is left alone, never guessed** — across EVERY single- and double-swap candidate
 *    together, not just within one count. Only two pairs collide at one swap: 16,000 (Savrilium ×5)
 *    vs 18,000 (Bexalite ×5), and 6,000 vs 8,000 (debris either way, so it changes nothing) — both
 *    already caught by the "already legal" rule above, since 16,000/18,000/6,000/8,000 are all legal
 *    values in their own right and never reach the swap search at all. Naming the wrong rock is
 *    worse than naming none.
 *
 *  Returns the repaired value, or null if the read should stand as it is. */
export function repairConfusableDigits(signature: number, isLegal: (n: number) => boolean): number | null {
  if (!Number.isInteger(signature) || signature < 0) return null;
  if (isLegal(signature)) return null;               // already a value the game can show — trust it
  const s = String(signature);
  const confusable: number[] = [];
  for (let i = 0; i < s.length; i++) if (CONFUSABLE_DIGITS[s[i]]) confusable.push(i);
  const found = new Set<number>();
  const tryFlipping = (positions: number[]) => {
    const chars = s.split("");
    for (const i of positions) chars[i] = CONFUSABLE_DIGITS[s[i]];
    const n = Number(chars.join(""));
    if (isLegal(n)) found.add(n);
  };
  for (const i of confusable) tryFlipping([i]);
  for (let a = 0; a < confusable.length; a++)
    for (let b = a + 1; b < confusable.length; b++) tryFlipping([confusable[a], confusable[b]]);
  return found.size === 1 ? [...found][0] : null;    // 0 = nothing plausible, 2+ = don't guess
}

export class MiningTracker extends EventEmitter {
  private data: MineablesData | null = null;
  private jobs = new Map<string, RefineryJob>();
  private targets = new Set<string>();
  private scan: MiningView["scan"] = null;
  private readonly stateDir: string;
  private readonly statePath: string;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private maxSig: number | null = null; // lazily derived from the table — see maxSignature()
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

  /** The largest signature the game can put on screen: the richest cluster of the highest-base
   *  rock. Derived from the table rather than written down, so it tracks the data. Anything above
   *  it is a misread by definition — which also caps debris, since debris values are multiples of
   *  2,000 (so the biggest field this will accept is 12 panels). Every rejection is logged, so if
   *  a real field ever reads higher, sidecar.log will say so and this can be raised on evidence
   *  instead of a guess. */
  maxSignature(): number {
    if (this.maxSig === null) {
      this.maxSig = Math.max(0, ...(this.data?.rocks ?? []).flatMap((r) => r.sigs));
    }
    return this.maxSig;
  }

  /** Is this a value the game can actually put on screen — a rock signature, or a whole number of
   *  debris panels, inside the range? This is the vocabulary a misread gets constrained to. */
  private isLegalSignature(n: number): boolean {
    if (n < MIN_SIGNATURE || n > this.maxSignature()) return false;
    return (this.data?.index[String(n)] ?? []).length > 0 || isDebrisValue(n);
  }

  /** A scanned signature number -> a verdict (see classifySignature) plus the matching rock(s).
   *  Exact-match only against the table (values can be 5 apart, so a tolerance would pick the
   *  wrong rock) — with one exception: a single confused 6/8 digit is repaired when exactly one
   *  legal value is reachable (see repairConfusableDigits). That is a CONSTRAINT, not a tolerance;
   *  it can only ever land on a value the game could have shown.
   *
   *  `confirmed` = the frame showed the scan glyph beside this number, so a real scan produced it.
   *  A verdict that names a rock is applied either way — matching the table is its own evidence —
   *  but `debris` and `unknown` need that glyph, because without it a bare number is as likely to
   *  be some other bit of HUD the OCR grabbed as it is a contact. */
  applyMineableRead(signature: number, confirmed = false): ScanOutcome {
    if (!this.data) return { verdict: null, announced: false, used: false, why: "no rock table loaded" };
    // 🔑 A repair needs the GLYPH. An exact table hit is evidence on its own, but a repaired one is
    // weaker — without this, any stray HUD number one digit away from an ore signature would be
    // announced as that ore, which is the false-call-out class this whole area keeps relapsing into.
    const repaired = confirmed ? repairConfusableDigits(signature, (n) => this.isLegalSignature(n)) : null;
    const read = signature;
    if (repaired !== null) signature = repaired;
    const matches = this.data.index[String(signature)] ?? [];
    const verdict = classifySignature(signature, matches.length > 0, this.maxSignature());
    // Every line says so, because a repair changes which rock gets named and that must never be
    // silent — it is the one thing in here that could be confidently wrong.
    const fix = repaired !== null ? ` [repaired ${read.toLocaleString()} → ${signature.toLocaleString()}, one 6/8 digit]` : "";
    const out = (o: ScanOutcome): ScanOutcome =>
      (repaired !== null ? { ...o, repairedFrom: read, why: o.why + fix } : o);
    if (!verdict) {
      return out({ verdict, announced: false, used: false, why: signature < MIN_SIGNATURE
        ? `ignored (below the ${MIN_SIGNATURE.toLocaleString()} floor)`
        : `ignored (above ${this.maxSignature().toLocaleString()}, the largest signature the game can show — misread)` });
    }
    // 🔑 AN EXACT DEBRIS VALUE IS ITS OWN EVIDENCE, the same way a rock-table hit is (Sub,
    // 2026-08-03). Debris is a whole number of 2,000-unit salvage panels inside the signature
    // range — only 13 values in the whole band — so a read landing exactly on one is already a
    // far tighter filter than the glyph was ever asked to be. Requiring the glyph on top of that
    // meant a HUD the glyph check couldn't handle made debris permanently un-announceable, which
    // is exactly what happened. `unknown` still needs the glyph: it is, by definition, a number we
    // cannot vouch for, so a stray HUD figure must not become a call-out.
    if (!matches.length && !confirmed && verdict !== "debris") {
      return out({ verdict, announced: false, used: false, why: `${verdict}, not announced (no scan glyph beside the number)` });
    }
    // Ignore a repeat read of the same signature (the loop polls the same rock every ~3s);
    // only a CHANGED signature is news worth re-announcing.
    if (this.scan && this.scan.signature === signature) {
      // USED, not refused: this is the reading the scanner is currently showing.
      return out({ verdict, announced: false, used: true, why: `${verdict}, already announced (unchanged since the last read)` });
    }
    this.scan = { signature, matches, at: Date.now(), confirmed, verdict };
    const hit = matches.find((m) => this.targets.has(m.name));
    this.emit("change");
    if (hit) this.emit("target-hit", { ...hit, signature });
    const named = matches.length ? ` — ${matches.map((m) => `${m.name} ×${m.count}`).join(" / ")}` : "";
    return out({ verdict, announced: true, used: true, why: `${verdict}, announced${named}` });
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
