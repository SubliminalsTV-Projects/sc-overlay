/**
 * Parses a single Star Citizen game.log line into a structured event.
 *
 * Typical line shapes (all fields except `message` are optional):
 *
 *   <2026-06-04T01:34:29.449Z> [Notice] <CreateChannel> Opening channel ... [Team_OnlineTech][gRPC]
 *   <2026-06-04T01:34:31.677Z> [PSOCacheGen] Loaded PSOCache (270802 entries)
 *   [PSOCacheGen] 6 duplicated entries            (no leading timestamp)
 *
 * Layout, left to right:
 *   <ISO timestamp>   optional, the engine's UTC clock
 *   [Severity]        optional, one of the known severity keywords below
 *   <EventTag>        optional, the angle-bracket event name (e.g. "Actor Death")
 *   message           free text in the middle
 *   [Tag][Tag]...     optional run of subsystem tags at the very end
 */

/** Severity keywords the engine emits in `[...]`. Anything else stays in the message. */
const SEVERITIES = new Set(["Notice", "Warning", "Error", "Trace", "Debug", "Verbose"]);

export interface LogEvent {
  /** The original, untouched line. */
  raw: string;
  /** ISO-8601 UTC timestamp, or null if the line had none. */
  timestamp: string | null;
  /** One of the known severity keywords, or null. */
  severity: string | null;
  /** The `<EventTag>` name (e.g. "Actor Death"), or null. */
  eventTag: string | null;
  /** Trailing subsystem tags, in order (e.g. ["Team_OnlineTech", "gRPC"]). */
  tags: string[];
  /** Whatever text remains after stripping the fields above. */
  message: string;
}

const TIMESTAMP_RE = /^<(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)>\s*/;
const SEVERITY_RE = /^\[([A-Za-z]+)\]\s*/;
const EVENT_TAG_RE = /^<([^>]+)>\s*/;
// A run of one or more [..] tags anchored to the end of the line.
const TRAILING_TAGS_RE = /\s*((?:\[[^\]]*\])+)\s*$/;

export function parseLine(raw: string): LogEvent {
  let rest = raw;

  let timestamp: string | null = null;
  const ts = rest.match(TIMESTAMP_RE);
  if (ts) {
    timestamp = ts[1];
    rest = rest.slice(ts[0].length);
  }

  let severity: string | null = null;
  const sev = rest.match(SEVERITY_RE);
  if (sev && SEVERITIES.has(sev[1])) {
    severity = sev[1];
    rest = rest.slice(sev[0].length);
  }

  let eventTag: string | null = null;
  const evt = rest.match(EVENT_TAG_RE);
  if (evt) {
    eventTag = evt[1];
    rest = rest.slice(evt[0].length);
  }

  let tags: string[] = [];
  const trailing = rest.match(TRAILING_TAGS_RE);
  if (trailing) {
    tags = trailing[1].match(/\[([^\]]*)\]/g)!.map((t) => t.slice(1, -1));
    rest = rest.slice(0, trailing.index).trimEnd();
  }

  return {
    raw,
    timestamp,
    severity,
    eventTag,
    tags,
    message: rest.trim(),
  };
}
