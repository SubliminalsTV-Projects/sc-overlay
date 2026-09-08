/**
 * WHAT COUNTS AS A HOTKEY — the ONE place the accelerator vocabulary lives.
 *
 * Loaded by `config.html` (the Settings rows) and by `missions.html` (the per-widget row in a
 * widget's own settings, via canvas.js). Two surfaces, one vocabulary.
 *
 * 🔴 The reason this is a file rather than a copy: a key table in front of a parser is a second,
 * invisible copy of that parser's rules, and it drifts the first time somebody improves one of
 * them. Here the drift is worse than usual — the two surfaces write into the SAME
 * `config.widgetHotkeys` map, so a canvas that accepted a chord Settings rejects (or spelled a
 * key differently) would produce a binding Settings could not display or re-set.
 *
 * Nothing here touches the DOM or the config. It turns a KeyboardEvent into an Electron
 * accelerator string, or says why it will not.
 */
(function () {
  /** KeyboardEvent.code → Electron accelerator key token (layout-independent for QWERTY). */
  function keyName(code) {
    var m;
    if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
    if ((m = /^Digit([0-9])$/.exec(code))) return m[1];
    if ((m = /^F([0-9]{1,2})$/.exec(code))) return (+m[1] >= 1 && +m[1] <= 24) ? code : null; // F1–F24 (Electron's max)
    return ({ Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backslash: "\\",
      BracketLeft: "[", BracketRight: "]", Minus: "-", Equal: "=", Backquote: "`",
      Space: "Space", Tab: "Tab", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right" })[code] || null;
  }

  /** How an accelerator reads to a person. "" is a real value meaning "no hotkey". */
  function pretty(accel) {
    return (accel || "").split("+").map(function (p) {
      return p === "Control" ? "Ctrl" : p === "Super" ? "Win" : p;
    }).join(" + ");
  }

  /** Is this key allowed with no modifier at all?
   *  F3 and F13–F24 are free in Star Citizen (F4–F12 are taken), so they are allowed bare — that
   *  is the whole point of a dedicated overlay key. Everything else needs a modifier. */
  function bareAllowed(key) { return /^F(3|1[3-9]|2[0-4])$/.test(key || ""); }

  /** A modifier key on its own is not an answer — the caller should keep waiting. */
  function isModifierOnly(e) {
    return ["Control", "Alt", "Shift", "Meta"].indexOf(e.key) !== -1;
  }

  /**
   * Turn a keydown into an accelerator.
   * @param {KeyboardEvent} e
   * @param {{bare?: boolean}} [opts] `bare: true` for an action whose key is HELD (interact),
   *        where a modifier would have to be held too.
   * @returns {{accel: string} | {reject: "needs-modifier"}}
   */
  function fromEvent(e, opts) {
    var mods = [];
    if (e.ctrlKey) mods.push("Control");
    if (e.altKey) mods.push("Alt");
    if (e.shiftKey) mods.push("Shift");
    if (e.metaKey) mods.push("Super");
    var key = keyName(e.code);
    var bareOk = (opts && opts.bare) || bareAllowed(key);
    if (!key || (!mods.length && !bareOk)) return { reject: "needs-modifier" };
    return { accel: mods.concat([key]).join("+") };
  }

  /** The one sentence explaining a rejection, so both surfaces say it the same way. */
  var REJECT_TEXT = {
    "needs-modifier": "Use at least one modifier (Ctrl / Alt / Shift) plus a key — or a bare F3 / F13–F24.",
  };

  window.SCHotkeyKeys = {
    keyName: keyName,
    pretty: pretty,
    bareAllowed: bareAllowed,
    isModifierOnly: isModifierOnly,
    fromEvent: fromEvent,
    rejectText: function (r) { return REJECT_TEXT[r] || "That key can't be used."; },
  };
})();
