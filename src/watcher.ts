import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { open, stat } from "node:fs/promises";

import { parseLine, type LogEvent } from "./parser.js";

export interface WatcherOptions {
  /** How often to check the file for new data, in ms. Default 500. */
  pollInterval?: number;
  /**
   * If true, read the file from the beginning on startup (process the current
   * session's backlog). If false (default), start at the end and only emit
   * lines written from now on, like `tail -f`.
   *
   * Note: after a rotation (new game launch), the file is always read from the
   * start regardless of this setting, so a fresh session is captured in full.
   */
  readExisting?: boolean;
}

/**
 * Tails a Star Citizen game.log and emits structured events.
 *
 * Robustness notes specific to this log:
 *  - SC truncates/overwrites game.log on every launch. We detect that as the
 *    file size shrinking below our read position, reset to 0, and emit "rotate".
 *  - The game keeps the file open and writes to it live; we open with a fresh
 *    read handle per poll (Node requests shared access), so we don't fight its
 *    lock and we never hold a handle to a stale, rotated-away file.
 *  - The file may not exist yet (game not launched). We wait and emit "appear"
 *    once it shows up.
 *
 * Events:
 *   "event"   (e: LogEvent)  a parsed line
 *   "line"    (raw: string)  the same line, unparsed
 *   "appear"  ()             the file came into existence
 *   "rotate"  ()             the file was truncated/replaced (new session)
 *   "error"   (err: Error)   a non-fatal read error; polling continues
 */
export class LogWatcher extends EventEmitter {
  private readonly filePath: string;
  private readonly pollInterval: number;
  private readonly readExisting: boolean;

  private position = 0;
  private exists = false;
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(filePath: string, options: WatcherOptions = {}) {
    super();
    this.filePath = filePath;
    this.pollInterval = options.pollInterval ?? 500;
    this.readExisting = options.readExisting ?? false;
  }

  start(): this {
    if (this.timer) return this;
    // Kick off immediately, then on an interval. We guard against overlap with
    // `polling` so a slow read never stacks up behind the timer.
    const tick = () => {
      if (this.polling) return;
      this.polling = true;
      this.poll().finally(() => {
        this.polling = false;
      });
    };
    this.timer = setInterval(tick, this.pollInterval);
    tick();
    return this;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    let size: number;
    try {
      ({ size } = await stat(this.filePath));
    } catch {
      // File missing — game not launched yet, or log deleted. Reset so that
      // when it reappears we treat it as a fresh session.
      if (this.exists) this.reset();
      this.exists = false;
      return;
    }

    if (!this.exists) {
      this.exists = true;
      // On first sight, honour readExisting; on reappearance, start from 0.
      this.position = this.readExisting ? 0 : size;
      this.emit("appear");
    }

    if (size < this.position) {
      // Truncated/overwritten in place — a new session began.
      this.reset();
      this.emit("rotate");
    }

    if (size > this.position) {
      try {
        await this.readFrom(this.position, size);
        this.position = size;
      } catch (err) {
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  private async readFrom(from: number, to: number): Promise<void> {
    const length = to - from;
    const buf = Buffer.allocUnsafe(length);
    const fd = await open(this.filePath, "r");
    try {
      await fd.read(buf, 0, length, from);
    } finally {
      await fd.close();
    }

    // The decoder buffers any incomplete multi-byte sequence across reads.
    this.buffer += this.decoder.write(buf);

    const parts = this.buffer.split(/\r?\n/);
    // The last element is whatever came after the final newline — possibly an
    // incomplete line still being written. Hold it for the next read.
    this.buffer = parts.pop() ?? "";

    for (const line of parts) {
      if (line.length === 0) continue;
      this.emit("line", line);
      this.emit("event", parseLine(line));
    }
  }

  private reset(): void {
    this.position = 0;
    this.buffer = "";
    this.decoder = new StringDecoder("utf8");
  }
}

// Typed event overloads for a nicer consumer API.
export interface LogWatcher {
  on(event: "event", listener: (e: LogEvent) => void): this;
  on(event: "line", listener: (raw: string) => void): this;
  on(event: "appear" | "rotate", listener: () => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
}
