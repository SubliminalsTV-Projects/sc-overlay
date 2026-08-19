/**
 * CHAT — A MESSAGE: how it renders, and what you can do with it.

 * The log's append/scroll rules, per-handle name colours, @mentions, auto-linked blueprint and
 * item tokens, the message body, relative timestamps, the row itself, and the right-click menus
 * that act on a name or a message (mention, friend, copy, report).
 *
 * Lifted verbatim out of chat.html (2026-08-19). Same page, same scope: classic scripts on one
 * document share a global lexical environment, so nothing here is exported and nothing that calls
 * it changed. Load order is preserved — this file sits where the block used to sit.
 */
  // ── rendering ────────────────────────────────────────────────────────────
  const atBottom = () => {
    const el = $("log");
    return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  function append(node) {
    const el = $("log");
    const stick = atBottom();
    el.appendChild(node);
    while (el.childElementCount > MAX_ROWS) el.removeChild(el.firstChild);
    if (stick) el.scrollTop = el.scrollHeight;
  }
  function sys(text) {
    const d = document.createElement("div");
    d.className = "sys";
    d.textContent = text;
    append(d);
  }
  /* Eight name colours, Sub's call (2026-08-12: "just pick eight colors and allow the people to
     go and change the color of their name"). The PALETTE lives here rather than on the server
     because only the client knows which of the 16 manufacturer skins is on — and because a
     colour VALUE arriving from another player's client would be arbitrary CSS in this DOM. The
     wire carries an index; these are what the index means.
     🔑 Chosen to stay apart at 11.5px on a dark panel: no two adjacent hues, nothing so dark it
     reads as disabled, and nothing so close to the gold that "you" stops standing out. */
  const NAME_COLORS = [
    "#e0b341", // amber
    "#5fd0e8", // cyan
    "#5fe08a", // green
    "#f08a4b", // orange
    "#ef7fa8", // pink
    "#b98cf0", // violet
    "#ef6b6b", // red
    "#7fa8ef", // blue
  ];
  /** handle (lowercase) → chosen colour index. Fed by every presence frame and kept for the
   *  session, so a message from someone who has since left the room still renders in their
   *  colour. 🔑 It degrades to the name hash rather than to a default colour — an unset name has
   *  always had a stable colour here and that should not change just because the feature exists. */
  const chosenColors = new Map();
  function noteColors(members) {
    if (!Array.isArray(members)) return;
    for (const m of members) {
      const k = (m.handle ?? "").toLowerCase();
      if (!k) continue;
      if (typeof m.color === "number") chosenColors.set(k, m.color);
      else chosenColors.delete(k);
    }
  }
  function nameColor(handle) {
    const idx = chosenColors.get((handle ?? "").toLowerCase());
    return typeof idx === "number" && NAME_COLORS[idx] ? NAME_COLORS[idx] : handleColor(handle);
  }

  function handleColor(handle) {
    let h = 0;
    for (const c of handle) h = (h * 31 + c.codePointAt(0)) % 360;
    return `hsl(${h} 65% 70%)`;
  }
  // ── mentions, links and the message body ─────────────────────────────────
  // Rendered as NODES, never innerHTML: message text is other players' input, and the one
  // place it could become markup is the one place it must not.
  const MENTION_RE = /@([A-Za-z0-9._-]{3,30})/g;
  // Tokens the app itself writes when you use a slash command. `bp:` is a blueprint on the
  // site; `item:` is a starcitizen.tools lookup. Both survive as plain text for old clients.
  // A token carries the display text AND the id the link needs: [bp:Name|uuid],
  // [mission:Title|contractKey], [item:Name]. The id half is optional so an older client's
  // plain [bp:Name] still renders (it just links by name).
  // 🔑 The site's routes are /blueprints/<ITEM UUID> and /missions/<CONTRACT KEY> — NOT the
  // display name. Linking by name 404s, which is exactly what Sub hit.
  // `build:` is an erkul.games ship loadout the SENDER named — erkul's share links are an
  // opaque hash with no ship in them, and its old API host (server.erkul.games) no longer
  // exists, so there is nothing to look up. The person pasting it is the one who knows what
  // it is. The id half is longer here because it holds a URL rather than a uuid.
  // 🔑 ONE alternation-free pattern with three groups. A second top-level alternation for
  // `build` would shift the capture-group positions the replace() callback reads by name, and
  // the id length simply widens to fit a URL.
  const TOKEN_RE = /\[(bp|item|mission|build):([^\]|]{1,80})(?:\|([^\]]{1,200}))?\]/g;

  /** An erkul share link, or null. 🔴 Called on RENDER, not just on send: the token arrives
   *  over the wire from another player, so "we validated it when we made it" guarantees
   *  nothing. This is the allowlist that stops a chat message opening javascript: or any other
   *  URL of a stranger's choosing in the user's real browser. */
  function erkulUrl(raw) {
    let u;
    try { u = new URL(String(raw).trim()); } catch { return null; }
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== "erkul.games") return null;
    // /s/<id> is the current short link; /loadout/<id> is the older format still in the wild.
    if (!/^\/(s|loadout)\/[A-Za-z0-9_-]{4,40}\/?$/.test(u.pathname)) return null;
    return "https://" + host + u.pathname.replace(/\/$/, "");
  }
  const bpUrl = (id) => "https://subliminal.gg/blueprints/" + encodeURIComponent(id);
  const missionUrl = (key) => "https://subliminal.gg/missions/" + encodeURIComponent(key);
  // starcitizen.tools page titles are the item name with underscores for spaces
  // (verified: /Deadbolt_III_Cannon → 200).
  const toolsUrl = (name) => "https://starcitizen.tools/" + name.trim().replace(/\s+/g, "_").split("/").map(encodeURIComponent).join("/");
  function openLink(url) {
    if (host()?.openUrl) host().openUrl(url);
    else window.open(url, "_blank", "noopener");
  }
  // Every link out of chat is built here so the KIND TAG can never go missing on one path and
  // not another — which is exactly how [bp:…] and [item:…] came to look the same.
  const KIND_TAG = { bp: "BP", item: "ITEM", mission: "MISSION", build: "BUILD" };
  const KIND_TITLE = {
    bp: "Open this blueprint on subliminal.gg",
    item: "Look this up on starcitizen.tools",
    mission: "Open this mission on subliminal.gg",
    build: "Open this loadout on erkul.games",
  };
  function linkNode(kind, label, url, title) {
    const wrap = document.createElement("span");
    wrap.className = "lnk " + kind;
    wrap.title = title ?? KIND_TITLE[kind] ?? "";
    const tag = document.createElement("span");
    tag.className = "lkk";
    tag.textContent = KIND_TAG[kind] ?? "";
    const txt = document.createElement("span");
    txt.className = "lkt";
    txt.textContent = label;
    wrap.append(tag, txt);
    wrap.addEventListener("click", () => openLink(url));
    return wrap;
  }
  // Blueprint names recognised on sight — no command needed (Sub, 2026-08-09). The list and the
  // "is it distinctive enough" judgement are the sidecar's (see autoLinkNames); this just
  // matches them. One regex, built once, longest-name-first so the longer of two overlapping
  // names wins. Word boundaries on both ends, so "Bolt" inside "Deadbolt" never matches.
  let bpRe = null;
  let bpCanon = new Map();   // matched text (lowercase) → the canonical blueprint name
  async function loadAutoLinks() {
    try {
      const d = await (await fetch("/api/blueprint-names")).json();
      const rows = (d.names ?? []).filter((r) => r && r.match);
      if (!rows.length) return;
      bpCanon = new Map(rows.map((r) => [r.match.toLowerCase(), { name: r.name, item: r.item }]));
      const esc = rows.map((r) => r.match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      bpRe = new RegExp("(?<![\\w-])(" + esc.join("|") + ")(?![\\w-])", "gi");
    } catch { /* no dataset yet — chat still works, just without auto-links */ }
  }
  /** Append `text`, turning any known blueprint name inside it into a link. */
  function appendLinkified(frag, text) {
    if (!bpRe) { frag.appendChild(document.createTextNode(text)); return; }
    bpRe.lastIndex = 0;
    let last = 0, m;
    while ((m = bpRe.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const canon = bpCanon.get(m[0].toLowerCase());           // …but link the real item's UUID
      frag.appendChild(linkNode(
        "bp",
        m[0],                                                  // show what they typed…
        bpUrl(canon?.item ?? m[0]),
        !canon || canon.name === m[0]
          ? "Open this blueprint on subliminal.gg"
          : "Open “" + canon.name + "” on subliminal.gg",
      ));
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  }

  function renderBody(text) {
    const frag = document.createDocumentFragment();
    const me = (view?.you?.handle ?? "").toLowerCase();
    let mentionedMe = false;
    // One pass over both patterns, so a mention inside a token can't double-render.
    const parts = [];
    let idx = 0;
    const all = [];
    text.replace(TOKEN_RE, (m, kind, name, id, at) => { all.push({ at, len: m.length, kind, name, id }); return m; });
    text.replace(MENTION_RE, (m, handle, at) => { all.push({ at, len: m.length, kind: "at", name: handle }); return m; });
    all.sort((a, b) => a.at - b.at);
    for (const t of all) {
      if (t.at < idx) continue;                       // overlapping match — first one wins
      if (t.at > idx) parts.push({ text: text.slice(idx, t.at) });
      parts.push(t);
      idx = t.at + t.len;
    }
    if (idx < text.length) parts.push({ text: text.slice(idx) });
    for (const p of parts) {
      // Plain text is where auto-linking happens; an explicit [bp:…] token or an @mention is
      // already something, and must not be re-scanned into something else.
      if (p.text !== undefined) { appendLinkified(frag, p.text); continue; }
      if (p.kind === "at") {
        const s = document.createElement("span");
        const isMe = p.name.toLowerCase() === me;
        if (isMe) mentionedMe = true;
        s.className = "at" + (isMe ? " me" : "");
        s.textContent = "@" + p.name;
        frag.appendChild(s);
        continue;
      }
      if (p.kind === "build") {
        // Refuse anything that isn't a real erkul link, and show it as PLAIN TEXT rather than
        // dropping it — a message that silently loses part of itself is worse than one that
        // shows a suspect link un-clickable.
        const safe = erkulUrl(p.id ?? "");
        if (!safe) { frag.appendChild(document.createTextNode(p.name)); continue; }
        // The destination rides in the tooltip. Sub's ask: erkul's hash says nothing about the
        // build, so the name is the sender's and hovering tells you where you're actually going.
        frag.appendChild(linkNode("build", p.name, safe, p.name + " — " + safe));
        continue;
      }
      const url = p.kind === "mission" ? missionUrl(p.id ?? p.name)
        : p.kind === "bp" ? bpUrl(p.id ?? bpCanon.get(p.name.toLowerCase())?.item ?? p.name)
        : toolsUrl(p.name);
      frag.appendChild(linkNode(p.kind, p.name, url));
    }
    return { frag, mentionedMe };
  }

  /** How long ago, in the fewest characters that cannot be misread.
   *
   *  🔑 The units stop at DAYS. Weeks and months are ambiguous to read at a glance ("2mo" — two
   *  months or two minutes?) and scrollback is capped at 200 messages per room anyway, so
   *  anything that old is rare enough to be worth the full date instead of a compressed one.
   *  🔑 Under a minute says "now" rather than "0m". A counter that sits on zero looks broken. */
  function agoText(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "";
    const s = Math.floor((Date.now() - t) / 1000);
    if (s < 45) return "now";
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + "m";
    if (s < 86400) return Math.round(s / 3600) + "h";
    const d = Math.round(s / 86400);
    if (d <= 6) return d + "d";
    // Past a week the relative form stops helping — say the date outright.
    try { return new Date(t).toLocaleDateString([], { month: "short", day: "numeric" }); } catch { return d + "d"; }
  }
  /** Write the relative text and hang the exact time off the tooltip. */
  function stampTs(el) {
    const iso = el.dataset.at;
    if (!iso) return;
    el.textContent = agoText(iso);
    try { el.title = new Date(iso).toLocaleString(); } catch { /* bad ts */ }
  }
  /** 🔑 "5m" becomes wrong just by sitting there, so the rendered rows have to be re-stamped on
   *  a timer — nothing else in this widget re-renders while you read it. One pass a minute over
   *  the visible log is cheap and keeps every row honest without touching the DOM structure. */
  setInterval(() => {
    for (const el of document.querySelectorAll("#log .ts")) stampTs(el);
  }, 60_000);

  function msgRow(m) {
    const row = document.createElement("div");
    row.className = "msg";
    const ts = document.createElement("span");
    ts.className = "ts";
    // 🔴 A clock time is a LIE about old scrollback. Chat rooms are quiet for days at a time, so
    // the top of the log is routinely last week — and "14:32" reads as today to everyone
    // (Sub, 2026-08-12: "a user might think that that was actually sent today, but it's not").
    // The relative form is the one that cannot be misread; the exact time is on hover, where it
    // costs nothing and is there when someone actually needs it.
    ts.dataset.at = m.at ?? "";
    stampTs(ts);
    row.appendChild(ts);
    const who = m.from?.handle ?? "?";
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = who;
    nm.style.color = nameColor(who);
    // Right-click a name in the log for the same menu as the member list. 🔑 stopPropagation, or
    // the ROW's message menu fires straight after and replaces it — the name is the more specific
    // target and has to win.
    nm.addEventListener("contextmenu", (e) => {
      e.preventDefault(); e.stopPropagation();
      openCtx(who, e.clientX, e.clientY);
    });
    row.addEventListener("contextmenu", (e) => { e.preventDefault(); openMsgCtx(m, e.clientX, e.clientY); });
    row.appendChild(nm);
    // 🔑 No verified tick. Chat is RSI-verified accounts ONLY — the gate is the entry
    // requirement, so a badge saying so is true of every single row and therefore says nothing
    // (Sub, 2026-08-12: "we're not going to allow anybody whose account isn't verified to even
    // use the app… it's just kind of a waste of space"). `verified` stays on the wire because
    // the SERVER still uses it; it simply is not worth pixels.
    const sep = document.createElement("span");
    sep.className = "sep"; sep.textContent = ":";
    row.appendChild(sep);
    const tx = document.createElement("span");
    tx.className = "tx";
    const body = renderBody(m.text);   // builds NODES — still no innerHTML anywhere
    tx.appendChild(body.frag);
    row.appendChild(tx);
    if (body.mentionedMe) row.classList.add("mention");
    return row;
  }

  // ── right-click a name: mention, friend, copy ────────────────────────────
  // Friends are a LOCAL list (this machine), not a server relationship — nothing to accept,
  // nothing to sync, and it can't leak who you fly with. It sorts them to the top of the
  // member list and marks them.
  const readFriends = () => { try { return JSON.parse(localStorage.getItem("chatFriends") || "[]"); } catch { return []; } };
  let friends = readFriends();
  const isFriend = (h) => friends.some((f) => f.toLowerCase() === h.toLowerCase());
  function toggleFriend(h) {
    friends = isFriend(h) ? friends.filter((f) => f.toLowerCase() !== h.toLowerCase()) : [...friends, h];
    try { localStorage.setItem("chatFriends", JSON.stringify(friends)); } catch { /* private mode */ }
    renderMembers();
  }
  function mention(handle) {
    const el = $("sendInput");
    const pad = el.value && !el.value.endsWith(" ") ? " " : "";
    el.value = el.value + pad + "@" + handle + " ";
    // 🔑 Focus only — NEVER switch typing mode on from a helper. Typing mode asks the shell for
    // a keyboard grab, and that grab makes the WHOLE canvas swallow clicks, so a mention or an
    // emoji pick would silently take the mouse away from the game and nothing turned it back off
    // (Sub, 2026-08-09: "the chat app is forcing me to click it"). The user turns it on
    // deliberately with the pencil, and the pencil turns it off.
    el.focus();
  }
  function closeCtx() { $("ctx").classList.remove("open"); }
  function openCtx(handle, clientX, clientY) {
    const ctx = $("ctx");
    ctx.textContent = "";
    const who = document.createElement("div");
    who.className = "ct-who"; who.textContent = handle;
    ctx.appendChild(who);
    const add = (label, fn) => {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = label;
      b.addEventListener("click", () => { closeCtx(); fn(); });
      ctx.appendChild(b);
    };
    // A DM is the natural way to hand someone a join code, so it leads.
    if (handle.toLowerCase() !== (view?.you?.handle ?? "").toLowerCase()) {
      add("Send a direct message", () => openDm(handle));
    }
    add("Mention in chat", () => mention(handle));
    add(isFriend(handle) ? "Remove from friends" : "Add to friends", () => toggleFriend(handle));
    add("Open their profile", () => openLink("https://subliminal.gg/citizens/" + encodeURIComponent(handle)));
    placeCtx(clientX, clientY);
  }

  /** Add one row to the open context menu. */
  function ctxAdd(label, fn) {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = label;
    b.addEventListener("click", () => { closeCtx(); fn(); });
    $("ctx").appendChild(b);
  }

  /** Position INSIDE the panel — this popover hangs over the message list, and a menu that
   *  runs off the widget is a menu the shell never hit-tests. */
  function placeCtx(clientX, clientY) {
    const ctx = $("ctx");
    const box = $("panel").getBoundingClientRect();
    // Cap the height BEFORE measuring, so a menu taller than a small widget scrolls instead of
    // being cut off with its last items unreachable (Sub, 2026-08-10: "it will get cut off").
    ctx.style.maxHeight = Math.max(72, box.height - 8) + "px";
    ctx.classList.add("open");
    const w = ctx.offsetWidth, h = ctx.offsetHeight;
    // 🔑 FLIP toward the free side rather than clamping. Clamping slides the menu back under the
    // cursor, so whichever item happens to land there is the one you are about to click — which
    // is how a "Delete" ends up under a pointer that was aiming at a name. Opening up-and-left
    // from the cursor keeps the pointer at a CORNER of the menu, never on top of an item.
    let x = (clientX - box.left) + w > box.width - 4 ? (clientX - box.left) - w : (clientX - box.left);
    let y = (clientY - box.top) + h > box.height - 4 ? (clientY - box.top) - h : (clientY - box.top);
    // Only after flipping does clamping make sense: it is the last resort for a widget so small
    // the menu does not fit either way.
    ctx.style.left = Math.max(4, Math.min(x, box.width - w - 4)) + "px";
    ctx.style.top = Math.max(4, Math.min(y, box.height - h - 4)) + "px";
    try { host()?.summonCog?.(); } catch { /* not embedded */ }
  }

  /* Right-click a MESSAGE. Deliberately a different menu from right-clicking a NAME: that one is
     about the person (DM, mention, friend, profile), this one is about the message in front of
     you. Reporting lives here because what you are reporting is a specific thing that was said. */
  function openMsgCtx(m, clientX, clientY) {
    const ctx = $("ctx");
    ctx.textContent = "";
    const who = document.createElement("div");
    who.className = "ct-who";
    who.textContent = m.from?.handle ?? "message";
    ctx.appendChild(who);
    const me = (view?.you?.handle ?? "").toLowerCase();
    const from = (m.from?.handle ?? "");
    if (canPin(activeCh)) {
      const pinned = chanOf(activeCh)?.pin;
      ctxAdd("Pin this message", () => post("/api/chat/pin", { ch: activeCh, id: m.id }));
      if (pinned) ctxAdd("Remove the current pin", () => post("/api/chat/unpin", { ch: activeCh }));
    }
    ctxAdd("Copy text", () => { try { navigator.clipboard.writeText(m.text); } catch { /* no clipboard */ } });
    // 🔑 You cannot report yourself (the server refuses it too) — offering it would just be a
    // button that always errors.
    if (from && from.toLowerCase() !== me) {
      ctxAdd("Report this message…", () => openReportConfirm(m, clientX, clientY));
    }
    placeCtx(clientX, clientY);
  }

  /* Reporting is SILENT on the server: nothing is broadcast, nothing changes in the room, and
     the reported player is never told. An action with no visible consequence is one people fire
     by accident and then cannot take back, so it asks first.
     🔑 A second MENU, not `confirm()` — a native modal dialog over a transparent, always-on-top,
     click-through overlay is exactly the class of thing that traps a user, and the room bar's
     delete button already established the two-step idiom here. */
  function openReportConfirm(m, clientX, clientY) {
    const ctx = $("ctx");
    ctx.textContent = "";
    const who = document.createElement("div");
    who.className = "ct-who";
    who.textContent = "Report " + (m.from?.handle ?? "") + "?";
    ctx.appendChild(who);
    const note = document.createElement("div");
    note.className = "ct-note";
    note.textContent = "Goes to the moderators for review. They are not told who reported it.";
    ctx.appendChild(note);
    ctxAdd("Yes, report it", () => post("/api/chat/report", {
      ch: activeCh, handle: m.from?.handle ?? "", id: m.id,
    }));
    ctxAdd("Cancel", () => { /* closing is the whole action */ });
    placeCtx(clientX, clientY);
  }
