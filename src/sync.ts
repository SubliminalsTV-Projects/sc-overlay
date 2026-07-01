/**
 * Pushes the player's collected blueprints + currently-tracked mission to their
 * subliminal.gg account (the /blueprints collection tracker). Bearer-authed with a
 * device token the player mints on the site ("Connect the desktop tracker").
 *
 * Snapshot model: every push sends the FULL current set as an authoritative replace
 * (the server swaps the log-sourced collection for it), so a corrected resync fixes
 * any earlier over-count instead of only ever adding. A provider supplies the fresh
 * snapshot at flush time, so frequent state changes just markDirty() cheaply.
 *
 * Offline-safe: debounced, retries on the next tick, disables on a rejected token,
 * never throws into the caller.
 */
const SYNC_PATH = "/api/sc/sync";
const DEBOUNCE_MS = 1500;

export interface SyncSnapshot {
  /** Collected blueprints as { uuid, unlockedAt } (unlockedAt = ISO in-game unlock
   *  time, or null when unknown — the server falls back to when it first saw it). */
  got: { uuid: string; unlockedAt: string | null }[];
  mission: { debugName: string; patch: string } | null;
}

export class SiteSync {
  private readonly baseUrl: string;
  private token = "";
  private enabled = false;
  private provider: (() => SyncSnapshot) | null = null;

  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /** Set/replace credentials. Returns whether sync is now active. */
  configure(token: string, enabled: boolean): boolean {
    this.token = (token ?? "").trim();
    this.enabled = enabled;
    return this.active;
  }

  /** Supplies the current full snapshot at flush time (computed lazily). */
  setProvider(fn: () => SyncSnapshot): void {
    this.provider = fn;
  }

  get active(): boolean {
    return this.enabled && this.token.length > 0 && !!this.provider;
  }

  /** Mark state as changed; a debounced flush will push the latest snapshot. */
  markDirty(): void {
    if (!this.active) return;
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, DEBOUNCE_MS);
  }

  private async flush(): Promise<void> {
    if (!this.active || this.flushing || !this.dirty) return;
    this.flushing = true;
    this.dirty = false;
    const snap = this.provider!();
    try {
      const res = await fetch(`${this.baseUrl}${SYNC_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({
          got: snap.got,
          replace: true, // authoritative full-state — server swaps the log collection
          currentMission: snap.mission?.debugName ?? "",
          patch: snap.mission?.patch ?? "",
        }),
      });
      if (res.status === 401) {
        console.error("[sync] subliminal.gg rejected the token (401) — re-paste it in config.");
        this.enabled = false;
      } else if (!res.ok) {
        console.error(`[sync] subliminal.gg returned ${res.status}`);
        this.dirty = true; // retry
      }
    } catch {
      this.dirty = true; // offline — retry on next schedule
    } finally {
      this.flushing = false;
      if (this.active && this.dirty) {
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.flush();
        }, DEBOUNCE_MS);
      }
    }
  }
}
