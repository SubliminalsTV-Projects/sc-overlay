/**
 * WHAT THE LAST REP-PAGE SCAN DID, IN WORDS — the ONE place those words live.
 *
 * Loaded by both `config.html` (the durable line under the switch) and `missions.html` (the
 * status strip on the widget face, via canvas.js). Two surfaces, one vocabulary.
 *
 * 🔴 THE POINT OF `prefs.repScanLast` WAS THAT "it synced" AND "it refused, here is why" CAN
 * NEVER BE REPORTED BY TWO THINGS THAT DISAGREE. That argument applies just as hard to the
 * STRINGS as it does to the field: a second copy of this table in a second page drifts the first
 * time somebody improves one of them, and then the settings window and the widget explain the
 * same refusal differently. So the table is here and neither page owns a refusal string.
 *
 * Two registers, one table. `long` is the settings sentence — it has a whole line to itself and
 * can afford to explain. `short` rides `#ocrBar`, which is ONE ellipsised line on a widget that
 * may be 320px wide, so it leads with the thing to DO and drops the explanation. They are two
 * phrasings of one fact, kept adjacent so they cannot say different things.
 */
(function () {
  /** How long a read stays on the WIDGET face. The scan re-fires every capture tick while the
   *  page is up, so `at` keeps moving and the line stays live for as long as the player is
   *  looking at REP; it clears a few seconds after they leave. Settings ignores this and always
   *  shows the last read — that surface is the durable record, this one is a live indicator. */
  var FRESH_MS = 20000;

  var WHY = {
    "cards-incomplete": {
      long: "the rank list is scrolled — bring every rank into view and it will read",
      short: "scroll the rank list until every rank is in view",
    },
    "scope-ambiguous": {
      long: "could not tell which reputation track this page is showing",
      short: "can't tell which track this page is showing",
    },
    "no-scope": {
      long: "this faction's track isn't in the app's data yet",
      short: "this track isn't in the app's data yet",
    },
    // The framing sentence already says the page was read and names the faction, so this is the
    // reason alone — it used to open "read the page, but" and now that would say "read" twice.
    "no-giver": {
      long: "this faction isn't one the app tracks missions for",
      short: "not a faction the app tracks missions for",
    },
    "not-live": {
      long: "read your page, but this is the PTU — nothing was saved",
      short: "PTU — read, deliberately not saved",
    },
    "bars-unreadable": {
      long: "could not read the progress bars on this page",
      short: "couldn't read the progress bars",
    },
    "no-rank-reached": {
      long: "no rank on this page is filled in yet",
      short: "no rank on this page is filled in yet",
    },
    "rank-not-contiguous": {
      long: "the progress bars didn't make sense — nothing was saved",
      short: "the progress bars didn't make sense",
    },
    "reader-failed": {
      long: "something went wrong reading the page",
      short: "something went wrong reading the page",
    },
  };

  function ago(ms) {
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return s + "s ago";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    return Math.round(s / 3600) + "h ago";
  }

  function num(n) {
    return typeof n === "number" ? n.toLocaleString() : String(n);
  }

  /** Who the page was about. The giver when it resolved; otherwise the faction HEADING the OCR
   *  read, which on `no-giver` is the only thing that says which faction was refused — and is
   *  exactly what Sub could not see when he reported "it didn't know the name". */
  function who(last) {
    return last.giver || last.faction || "";
  }

  /** `{ ok, tone, short, long }` for one `repScanLast`, or null when there has never been a read.
   *  `tone` is the class the widget strip wants: "on" for a good read, "warn" for anything the
   *  app declined to save — including the PTU refusal, which is correct behaviour but is still
   *  not a save, and saying so in colour beats letting it look like one. */
  function describe(last) {
    if (!last) return null;
    var subject = who(last);
    var rank = last.standing ? " — " + last.standing : "";

    if (last.ok) {
      var moved = last.before === last.after
        ? "already matched"
        : (last.outcome === "raised" ? "corrected up" : "corrected down")
          + " from " + num(last.before) + " to " + num(last.after);
      // ⚠️ The strip is ONE ellipsised line. Measured on the real widget at its 378px content
      // width, the sentence form truncated at "corrected up from 25,314 …" and threw away the
      // second number — and Sub asked for the rank AND the movement, not one of them. An arrow
      // says the same thing in 20 fewer characters and both figures survive.
      var movedShort = last.before === last.after
        ? "already matched"
        : num(last.before) + " " + String.fromCharCode(8594) + " " + num(last.after);
      var est = last.estimated ? " (estimated from the progress bar)" : "";
      return {
        ok: true,
        tone: "on",
        short: "REP · " + (subject || "that faction") + rank + " · " + movedShort,
        long: "Last read " + ago(last.at) + ": " + (subject || "that faction") + rank
          + " · " + moved + est + ".",
      };
    }

    // 🔑 The PTU case is NOT an error and must not read like one: the page was understood
    // perfectly and the refusal is deliberate. It reports the rank it read, so the player can
    // see the feature working even where it will never write anything.
    if (last.refusal === "not-live") {
      return {
        ok: false,
        tone: "warn",
        short: "REP · read " + (subject || "the page") + rank + " · PTU, not saved",
        long: "Last read " + ago(last.at) + ": read your page correctly"
          + (subject ? " (" + subject + rank + ")" : "")
          + ", but this is the PTU — test-server reputation is never saved over your live "
          + "standing.",
      };
    }

    var w = WHY[last.refusal] || { long: last.refusal, short: last.refusal };
    // 🔑 NAME THE FACTION ON EVERY REFUSAL THAT KNOWS ONE, not just `no-giver`. Sub reported two
    // factions "not working" and the strip could only have said "scroll the rank list" with no
    // clue which page it meant — which is indistinguishable from the widget talking about some
    // other faction entirely. `cards-incomplete`, `no-scope` and `scope-ambiguous` all carry the
    // heading now; before, only `no-giver` did.
    var named = subject ? ' "' + subject + '"' : "";
    return {
      ok: false,
      tone: "warn",
      short: "REP" + (named ? " ·" + named : "") + rank + " · " + w.short,
      long: "Last read " + ago(last.at) + ":" + (named ? named + rank + " ·" : "")
        + " not saved — " + w.long + ".",
    };
  }

  window.REP_SCAN_STATUS = { FRESH_MS: FRESH_MS, WHY: WHY, ago: ago, describe: describe };
})();
