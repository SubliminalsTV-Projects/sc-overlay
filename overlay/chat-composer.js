/**
 * CHAT — THE COMPOSER: everything that helps you write the message.

 * The emoji picker, slash commands (which rewrite what you SEND into a token the renderer turns
 * into a link, so it still reads as plain text on an older build), and the autocomplete menu.
 *
 * Two chunks of the old file, joined: the emoji block and the slash/autocomplete block, which sat
 * either side of the being-mentioned handler. That handler is about RECEIVING a mention, not
 * writing one, so it stayed on the page.
 *
 * Lifted verbatim out of chat.html (2026-08-19). Same page, same scope: classic scripts on one
 * document share a global lexical environment, so nothing here is exported and nothing that calls
 * it changed. Load order is preserved — this file sits where the block used to sit.
 */
  // ── emoji ────────────────────────────────────────────────────────────────
  // Curated rather than exhaustive: a full Unicode set is a scroll you never finish, and the
  // point here is the twenty you actually send while flying. SC-flavoured group first — o7 is
  // the salute every SC player types, so it earns the top-left slot.
  const EMOJI = [
    ["Verse", [["o7", "🫡"], ["ship", "🚀"], ["mining", "⛏️"], ["salvage", "🔧"], ["cargo", "📦"], ["money", "💰"],
               ["boom", "💥"], ["fire", "🔥"], ["skull", "💀"], ["medic", "🩺"], ["fuel", "⛽"], ["star", "⭐"]]],
    ["Reactions", [["yes", "👍"], ["thumbsup", "👍"], ["no", "👎"], ["ok", "👌"], ["wave", "👋"], ["clap", "👏"],
                   ["pray", "🙏"], ["muscle", "💪"], ["eyes", "👀"], ["brain", "🧠"], ["100", "💯"], ["check", "✅"]]],
    ["Faces", [["smile", "🙂"], ["grin", "😄"], ["joy", "😂"], ["wink", "😉"], ["cool", "😎"], ["think", "🤔"],
               ["sad", "🙁"], ["cry", "😭"], ["angry", "😠"], ["shock", "😱"], ["sweat", "😅"], ["shrug", "🤷"]]],
    ["Signals", [["warn", "⚠️"], ["sos", "🆘"], ["question", "❓"], ["bang", "❗"], ["clock", "⏰"], ["pin", "📍"],
                 ["up", "⬆️"], ["down", "⬇️"], ["left", "⬅️"], ["right", "➡️"], ["heart", "❤️"], ["party", "🎉"]]],
  ];
  /** :shortcode: → emoji, applied on send. Typing beats hunting a grid mid-flight. */
  const SHORTCODES = new Map(EMOJI.flatMap(([, rows]) => rows.map(([name, ch]) => [name, ch])));
  function expandShortcodes(text) {
    return text.replace(/:([a-z0-9_+-]{1,20}):/gi, (m, name) => SHORTCODES.get(name.toLowerCase()) ?? m);
  }
  function buildEmojiPicker() {
    const pop = $("emojiPop");
    for (const [group, rows] of EMOJI) {
      const h = document.createElement("div");
      h.className = "egrp"; h.textContent = group;
      pop.appendChild(h);
      const row = document.createElement("div");
      row.className = "erow";
      for (const [name, ch] of rows) {
        const b = document.createElement("button");
        b.type = "button"; b.textContent = ch; b.title = ":" + name + ":";
        b.addEventListener("click", () => insertEmoji(ch));
        row.appendChild(b);
      }
      pop.appendChild(row);
    }
  }
  function insertEmoji(ch) {
    const el = $("sendInput");
    // Insert at the CARET, not the end — an emoji mid-sentence is the common case.
    const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? el.value.length;
    el.value = el.value.slice(0, s) + ch + el.value.slice(e);
    const at = s + ch.length;
    el.setSelectionRange(at, at);
    setEmojiPop(false);
    // Keep the keyboard grab: over a focused game, losing it sends the next keys to SC.
    // 🔑 Focus only — NEVER switch typing mode on from a helper. Typing mode asks the shell for
    // a keyboard grab, and that grab makes the WHOLE canvas swallow clicks, so a mention or an
    // emoji pick would silently take the mouse away from the game and nothing turned it back off
    // (Sub, 2026-08-09: "the chat app is forcing me to click it"). The user turns it on
    // deliberately with the pencil, and the pencil turns it off.
    el.focus();
  }
  function setEmojiPop(on) {
    $("emojiPop").classList.toggle("open", !!on);
    $("emojiBtn").classList.toggle("active", !!on);
    // The popover hangs OUTSIDE the widget's own box, so the shell must be told to hit-test it
    // or it is unclickable over the game (the clipping/RSEL trap every widget chrome hits).
    try { host()?.summonCog?.(); } catch { /* not embedded */ }
  }

  // ── slash commands ───────────────────────────────────────────────────────
  // They rewrite what you SEND into a token the renderer turns into a link, so the message
  // still reads as plain text for anyone on an older build. Kept deliberately short: these
  // are typed mid-flight, one-handed.
  // `inline: true` = the command produces a TOKEN inside a sentence, so it is offered wherever
  // the caret is. The others rewrite the whole message and are start-of-message only.
  const COMMANDS = [
    { cmd: "/bp", args: "<blueprint>", hint: "link a blueprint on subliminal.gg", inline: true,
      run: (rest) => rest ? "[bp:" + rest + "]" : null },
    { cmd: "/item", args: "<item>", hint: "look it up on starcitizen.tools", inline: true,
      run: (rest) => rest ? "[item:" + rest + "]" : null },
    { cmd: "/mission", args: "<mission>", hint: "link a mission on subliminal.gg", inline: true,
      run: (rest) => rest ? "[mission:" + rest + "]" : null },
    // Name it yourself: erkul's share link is an opaque hash and its old API host is gone, so
    // nothing can look the ship up. `run` is unused — /build is expanded in applyCommand because
    // it takes TWO arguments and has to validate the second.
    { cmd: "/build", args: "<name> <erkul link>", hint: "share an erkul loadout", inline: true,
      run: (rest) => rest ? null : null },
    { cmd: "/me", args: "<action>", hint: "speak in the third person",
      run: (rest) => rest ? "* " + (view?.you?.handle ?? "") + " " + rest : null },
    { cmd: "/shrug", args: "", hint: "¯\\_(ツ)_/¯", run: () => "¯\\_(ツ)_/¯" },
  ];
  /** Expand a leading slash command. Returns the text to send, or null to refuse. */
  function applyCommand(text) {
    // /me and /shrug rewrite the WHOLE message, so they only count at the very start.
    if (/^\/(me|shrug)\b/i.test(text)) {
      const sp = text.indexOf(" ");
      const name = (sp < 0 ? text : text.slice(0, sp)).toLowerCase();
      const rest = sp < 0 ? "" : text.slice(sp + 1).trim();
      const c = COMMANDS.find((x) => x.cmd === name);
      const out = c?.run(rest);
      if (!out) { sys(c.cmd + " needs something after it - " + c.cmd + " " + c.args); return null; }
      return out;
    }
    // /build <name> <erkul link>. Two arguments, and the second has to be VALIDATED — so it is
    // expanded here rather than through a one-argument `run`. The name is free text (it is the
    // sender's description) and the URL is the last whitespace-separated word, which is how
    // people paste links: "/build Vulture salvage fit https://erkul.games/s/akeei4v0".
    // Refusing loudly matters: a silently-dropped link looks like the app ate the message.
    // 🔑 Matched ANYWHERE in the message, not just at the start. It was anchored `^\/build`
    // while ALSO being advertised as an inline command in the slash menu — so
    // "@Bob check this /build Vulture <link>" sent the raw text and produced no link, while the
    // same command alone on a line worked (Sub, 2026-08-09). The other link commands were
    // already inline; this one has to match them.
    //
    // The URL TERMINATES the command: everything between "/build" and the first link is the
    // name, and anything after the link stays as ordinary message text. That is what lets it
    // sit mid-sentence — "…want to try /build Vulture salvage fit <link> tonight?".
    if (/(^|\s)\/build\b/i.test(text)) {
      let matched = false, bad = false;
      const out2 = text.replace(/(^|\s)\/build\s+(\S[^]*?)\s+(https?:\/\/\S+)/gi, (m, pre, name, link) => {
        const safe = erkulUrl(link);
        if (!safe) { bad = true; return m; }
        matched = true;
        return pre + "[build:" + name.trim().replace(/[[\]|]/g, "") + "|" + safe + "]";
      });
      if (matched) return out2;
      // Nothing expanded — say which half is missing rather than sending the raw text, which
      // reads as the app having eaten the message.
      if (bad) { sys("That doesn't look like an erkul.games loadout link. In erkul, hit Share and paste the link it gives you."); return null; }
      if (/(^|\s)\/build\s+\S+\s*$/i.test(text) && !/https?:\/\//i.test(text)) {
        sys("/build needs a link too - /build Vulture salvage fit https://erkul.games/s/…"); return null;
      }
      sys("/build takes a name then a link - /build Vulture salvage fit https://erkul.games/s/…");
      return null;
    }
    // 🔑 The link commands are INLINE and are normally turned into a token by accepting a
    // suggestion. A leftover "/bp something" — typed and sent without picking — is expanded
    // here so it still links rather than being sent as literal slash text. Anywhere in the
    // message, any number of times.
    let out = text.replace(/(^|\s)\/(bp|item|mission)\s+([^[\]]+?)(?=\s\/|$)/gi, (m, pre, kind, rest) => {
      const k = kind.toLowerCase();
      const name = rest.trim();
      if (!name) return m;
      if (k === "bp") {
        const hit = bpCanon.get(name.toLowerCase());
        return pre + "[bp:" + (hit?.name ?? name) + (hit?.item ? "|" + hit.item : "") + "]";
      }
      if (k === "item") return pre + "[item:" + name + "]";
      return pre + "[mission:" + name + "]";   // no key: the site resolves what it can
    });
    // An unknown slash word at the very start is a typo worth naming, not silent plain text.
    if (/^\//.test(out) && !/^\[/.test(out)) {
      const first = out.split(/\s/)[0].toLowerCase();
      if (!COMMANDS.some((c) => c.cmd === first)) {
        sys("No command called " + first + ". Try " + COMMANDS.map((c) => c.cmd).join(", ") + ".");
        return null;
      }
    }
    return out;
  }
  // ── autocomplete ─────────────────────────────────────────────────────────
  // Sub's ask: "I don't know exactly what to type." So every place a NAME is expected — a
  // person after @, a blueprint after /bp, an item after /item — suggests as you type, and the
  // command list itself completes. `sugg` is the current list; `suggAt` is where in the input
  // the replacement starts, so accepting rewrites only the token being typed.
  let sugg = [];
  let suggIx = 0;
  let suggAt = 0;
  let bpTimer = null;

  function closeSugg() { $("slash").classList.remove("open"); sugg = []; }

  function drawSugg(rows, startAt) {
    const box = $("slash");
    sugg = rows; suggAt = startAt; suggIx = 0;
    box.textContent = "";
    if (!rows.length) { box.classList.remove("open"); return; }
    rows.forEach((row, i) => {
      const r = document.createElement("div");
      r.className = "sc-row" + (i === 0 ? " on" : "");
      const a = document.createElement("span");
      a.className = row.mono ? "sc-cmd" : "sc-name";
      a.textContent = row.label;
      r.appendChild(a);
      if (row.hint) {
        const b = document.createElement("span");
        b.className = "sc-hint"; b.textContent = row.hint;
        r.appendChild(b);
      }
      r.addEventListener("mousedown", (e) => { e.preventDefault(); acceptSugg(i); });
      box.appendChild(r);
    });
    box.classList.add("open");
    try { host()?.summonCog?.(); } catch { /* not embedded */ }
  }

  function moveSugg(by) {
    if (!sugg.length) return;
    suggIx = (suggIx + by + sugg.length) % sugg.length;
    [...$("slash").children].forEach((el, i) => el.classList.toggle("on", i === suggIx));
    $("slash").children[suggIx]?.scrollIntoView({ block: "nearest" });
  }

  function acceptSugg(i) {
    const row = sugg[i ?? suggIx];
    if (!row) return;
    const el = $("sendInput");
    el.value = el.value.slice(0, suggAt) + row.insert;
    closeSugg();
    // 🔑 Focus only — NEVER switch typing mode on from a helper. Typing mode asks the shell for
    // a keyboard grab, and that grab makes the WHOLE canvas swallow clicks, so a mention or an
    // emoji pick would silently take the mouse away from the game and nothing turned it back off
    // (Sub, 2026-08-09: "the chat app is forcing me to click it"). The user turns it on
    // deliberately with the pencil, and the pencil turns it off.
    el.focus();
    // A command still needs its argument, so re-run the pass to offer the next thing.
    renderSlash(el.value);
  }

  /** Who is in the channel you are looking at — the only people worth suggesting. */
  const channelHandles = () => (chanOf(activeCh)?.members ?? []).map((m) => m.handle);

  function renderSlash(text) {
    const caretToken = (re) => {
      const m = text.match(re);
      return m ? { frag: m[1] ?? "", at: m.index ?? 0 } : null;
    };
    // 1. a command being typed.
    // 🔑 Matched at the CARET, not only at the start of the message. The list used to be
    // anchored `^\/\S*$`, so typing "hey Bob, want to run /" mid-sentence offered NOTHING and
    // the inline link commands were undiscoverable unless you already knew to type the whole
    // word (Sub, 2026-08-09: "the slash commands don't do anything when you type slash — the
    // user may not even know"). Mid-message offers only the INLINE commands: /me and /shrug
    // rewrite the entire message, so accepting one after the first word would silently mangle
    // what you had already typed.
    const slash = text.match(/(?:^|\s)(\/\S*)$/);
    if (slash) {
      const frag = slash[1].toLowerCase();
      const atStart = slash.index === 0;
      const pool = atStart ? COMMANDS : COMMANDS.filter((c) => c.inline);
      const matches = pool.filter((c) => c.cmd.startsWith(frag));
      drawSugg(matches.map((c) => ({
        label: c.cmd + (c.args ? " " + c.args : ""), hint: c.hint, mono: true,
        insert: c.cmd + (c.args ? " " : ""),
      })), text.length - slash[1].length);
      return;
    }
    // 2. a blueprint / item / mission name after its command — asked of the local dataset.
    // 🔑 Matched ANYWHERE in the message, not just at the start (Sub: "type a message
    // afterwards, or maybe even in the middle"). Accepting a suggestion replaces the command
    // fragment IN PLACE with a finished token, so you carry on typing around it.
    const bp = text.match(/(?:^|\s)\/(bp|item|mission)\s+([^/]*)$/i);
    if (bp) {
      const kind = bp[1].toLowerCase();
      const frag = bp[2];
      const start = text.length - frag.length - bp[1].length - 2;   // back over "/cmd "
      clearTimeout(bpTimer);
      if (frag.trim().length < 2) { closeSugg(); return; }
      bpTimer = setTimeout(async () => {
        try {
          if (kind === "mission") {
            const d = await (await fetch("/api/mission-search?q=" + encodeURIComponent(frag))).json();
            const rows = d.missions ?? [];
            if (!rows.length) { closeSugg(); return; }
            drawSugg(rows.map((m) => ({
              label: m.title, mono: false, hint: "subliminal.gg",
              insert: "[mission:" + m.title + "|" + m.key + "] ",
            })), start);
            return;
          }
          const d = await (await fetch("/api/blueprint-search?q=" + encodeURIComponent(frag))).json();
          const rows = d.names ?? [];
          if (!rows.length) { closeSugg(); return; }
          drawSugg(rows.map((r) => ({
            label: r.name, mono: false,
            hint: kind === "bp" ? "subliminal.gg" : "starcitizen.tools",
            // The blueprint link needs the item UUID (the site's route); the wiki link needs
            // only the name, and its page title is the name with underscores.
            insert: kind === "bp"
              ? "[bp:" + r.name + "|" + r.item + "] "
              : "[item:" + r.name + "] ",
          })), start);
        } catch { closeSugg(); }
      }, 120);   // debounce: this fires on every keystroke
      return;
    }
    // 3. someone's name after @ — from the members actually in this channel
    const at = text.match(/(?:^|\s)@([A-Za-z0-9._-]*)$/);
    if (at) {
      const frag = (at[1] ?? "").toLowerCase();
      const start = text.length - frag.length - 1;   // include the "@"
      const pool = channelHandles().filter((h) => h.toLowerCase() !== (view?.you?.handle ?? "").toLowerCase());
      const hits = pool.filter((h) => h.toLowerCase().startsWith(frag)).slice(0, 8);
      if (!hits.length) { closeSugg(); return; }
      drawSugg(hits.map((h) => ({
        label: h, mono: false, hint: isFriend(h) ? "friend" : "", insert: "@" + h + " ",
      })), start);
      return;
    }
    closeSugg();
  }
