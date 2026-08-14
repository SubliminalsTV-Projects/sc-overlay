// Where the player is — planet-side or in space — inferred from the game log.
//
// WHY: a scan signature that is a multiple of 2,000 is genuinely ambiguous. It can be
// debris (whole salvage panels) or harvestable flora (every plant in the game sits at
// exactly 2,000). The COUNT is identical either way, so the only open question is the
// KIND — and that is a question about where you are, not about the number.
//
// 🔑 THIS IS A HINT, NOT A GATE. The engine prints its terrain-streaming report roughly
// every TEN MINUTES, so a reading can be that stale, and you can fly from a belt to a
// planet surface in well under that. It is good enough to ORDER two possibilities in a
// sentence. It must never be used to suppress a call-out, and the widget shows the age
// so the player can see when to stop trusting it.
//
// The log shape (one block per report, every body listed, cells > 0 only for the body
// whose terrain is streaming):
//
//   <2026-08-10T16:47:36.296Z>   planet cells:  137 [16384] meshes:   32 [ 2048] name: pyro2
//   <2026-08-10T16:47:36.296Z>   planet cells:    0 [    0] meshes:    0 [    0] name: pyro3
//
// ⚠️ A block can straddle a millisecond, so the timestamp is NOT the block key — an
// earlier attempt grouped by timestamp and split one report into two, inventing a
// spurious "deep space" reading at the boundary. Blocks are delimited by the run of
// `planet cells:` lines ending, and nothing else.

/** Which STAR SYSTEM the player is in, read off the quantum-navigation lines.
 *
 *  🔑 A different signal from the terrain report above, and a much better one for this question.
 *  The log DOES say what system you are in — it just doesn't say it in the place you'd look
 *  first. Every `[QuantumTravel]` line from `CSCItemNavigation` names it, either outright
 *  ("Projected Start Location is Pyro System", "routing from Pyro System to Orbituary") or in
 *  the route point it is talking about (`rs_ext_pyro6_leo`, `pyro3`, `..._pyro_final_...`).
 *  Measured on a real 2-hour session: 23 such lines against 2 terrain dumps, unanimous, spanning
 *  the whole session — so this answers within seconds of the player touching a quantum drive
 *  instead of waiting up to ten minutes for a body to stream.
 *
 *  ⚠️ Restricted to QuantumTravel lines ON PURPOSE. "Pyro" also appears in NPC archetype names
 *  (`PU_Human-Populace-Shopkeeper-Bartender-Male-Pyro_01_…`) hundreds of times, and matching
 *  those would report a system from whoever happens to be standing nearby.
 *
 *  🔑 NOT expired, unlike a place reading. You cannot leave a system without a quantum jump, and
 *  a jump writes more of these lines — so the last one seen is still true until another replaces
 *  it. That is the same reasoning the payout scanner uses for its own cached system. */
const QT_TAG = /\[QuantumTravel\]/;

export class SystemWatcher {
  private system: string | null = null;
  private at = 0;
  /** Known system names, lowercase — supplied from the dataset so a new system in a patch needs
   *  no code change. Matching is restricted to these so a stray word can't become a "system". */
  constructor(private known: Set<string> = new Set(["pyro", "stanton", "nyx"])) {}

  /** Feed every log line. Returns true when the system CHANGED. */
  push(line: string, now = Date.now()): boolean {
    if (!QT_TAG.test(line)) return false;
    for (const name of this.known) {
      // Word-boundary forms: "Pyro System", a bare "pyro", "pyro3"/"stanton2a", "_pyro_".
      const re = new RegExp(`(?:\\b|_)${name}(?:[0-9][a-z0-9]*)?(?:\\b|_)`, "i");
      if (!re.test(line)) continue;
      const changed = this.system !== name;
      this.system = name;
      this.at = now;
      return changed;
    }
    return false;
  }

  /** The system, or null before any quantum activity this session. */
  current(): string | null { return this.system; }
  /** How long ago it was last confirmed — for saying how sure we are, never for expiry. */
  ageMs(now = Date.now()): number { return this.at ? now - this.at : Infinity; }
}

/** Where the player is, as far as the log can tell. */
export type Place =
  | { kind: "planet"; body: string; name: string; at: number }
  | { kind: "space"; at: number }
  | { kind: "unknown" };

const LINE = /planet cells:\s*(\d+)\s*\[\s*\d+\]\s*meshes:\s*\d+\s*\[\s*\d+\]\s*name:\s*(\S+)/;

/** How long a reading stays worth showing. Two report intervals: one missed dump is
 *  normal, two means the log stopped reporting and we should stop claiming to know. */
export const PLACE_STALE_MS = 21 * 60_000;

export class PlaceWatcher {
  private place: Place = { kind: "unknown" };
  /** Bodies seen streaming in the block currently being read. */
  private streaming: string[] = [];
  private inBlock = false;
  /** body key -> display name, from the dataset (`pyro2` -> "Monox"). */
  constructor(private names: Record<string, string> = {}) {}

  /** Feed every log line. Returns true when the place CHANGED. */
  push(line: string, now = Date.now()): boolean {
    const m = LINE.exec(line);
    if (m) {
      this.inBlock = true;
      if (Number(m[1]) > 0) this.streaming.push(m[2]);
      return false;
    }
    if (!this.inBlock) return false;
    // The block just ended — this is the only moment we know the report was complete,
    // and therefore the only moment "nothing was streaming" means deep space rather
    // than "we haven't read the rest of the list yet".
    this.inBlock = false;
    const bodies = this.streaming;
    this.streaming = [];
    const before = this.describe();
    this.place = bodies.length
      ? { kind: "planet", body: bodies[0], name: this.displayName(bodies[0]), at: now }
      : { kind: "space", at: now };
    return this.describe() !== before;
  }

  /** Two shapes in the log, and they need different handling:
   *    `pyro2`                 -> key the dataset's `bodies` map directly
   *    `OOC_Stanton_2a_Cellin` -> system + body code is the map key (`stanton2a`), and
   *                               the TRAILING part is already the display name
   *  Naively stripping every underscore gives `stanton2acellin`, which matches nothing.
   *  Try the map, then the trailing name, then give the raw string back — a body we
   *  can't name keeps its own name rather than getting an invented one. */
  private displayName(body: string): string {
    const parts = body.replace(/^OOC_/i, "").split("_");
    const key = (parts.length > 1 ? parts[0] + parts[1] : parts[0]).toLowerCase();
    if (this.names[key]) return this.names[key];
    if (parts.length > 2) return parts.slice(2).join(" ");
    return body;
  }

  /** The current place, downgraded to `unknown` once the reading is too old to trust. */
  current(now = Date.now()): Place {
    if (this.place.kind === "unknown") return this.place;
    return now - this.place.at > PLACE_STALE_MS ? { kind: "unknown" } : this.place;
  }

  /** Milliseconds since the reading, or null when there has never been one. */
  ageMs(now = Date.now()): number | null {
    return this.place.kind === "unknown" ? null : now - this.place.at;
  }

  private describe(): string {
    return this.place.kind === "planet" ? `planet:${this.place.body}` : this.place.kind;
  }
}

/** How to word a signature that is a whole number of 2,000s.
 *
 *  Both debris panels and harvestable plants step by exactly 2,000, so the count is the
 *  same either way and only the kind is in question. Rather than pick one and be
 *  confidently wrong, name both and let the place decide the ORDER. With no place, the
 *  wording commits to neither — which is the honest answer, not a degraded one. */
export function debrisStepWording(units: number, place: Place): { lead: string; detail: string } {
  const n = units === 1 ? "1" : String(units);
  const panels = `${n} debris panel${units === 1 ? "" : "s"}`;
  const flora = `${n} harvestable${units === 1 ? "" : "s"}`;
  // 🔑 PLANET-SIDE NAMES ONLY HARVESTABLES (Sub, 2026-08-11: "it definitely shouldn't say debris
  // when they're playing planetside — I don't know that I've ever seen debris on a planet").
  //
  // This is NOT the "never suppress" rule at the top of this file being broken. The call-out still
  // happens and the COUNT is untouched, because both kinds step by exactly 2,000 — the only thing
  // dropped is a second kind the player says does not occur down there. Suppressing a call-out
  // means going silent about a contact; this stays just as loud and says one fewer wrong thing.
  //
  // ⚠️ The trade it DOES make: a reading is trusted for up to PLACE_STALE_MS, and you can leave a
  // planet in well under that, so a stale "planet" over a real debris field now says
  // "harvestables" where it used to hedge. That is a mislabel, never a miss, and the widget shows
  // the reading's age next to an Auto/Planet/Space override for exactly this case.
  if (place.kind === "planet") return { lead: flora, detail: "" };
  // Space keeps the pairing: flora in space is the unlikely half here, but nobody has ruled it
  // out the way Sub has ruled out debris planet-side, and inventing symmetry he didn't ask for is
  // how the asteroid types got shipped and retracted.
  if (place.kind === "space") return { lead: panels, detail: `or ${flora}` };
  return { lead: `${n} units`, detail: `debris panels or harvestables` };
}
