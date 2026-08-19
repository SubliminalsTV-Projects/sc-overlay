/**
 * CHAT — PEOPLE: who is here, who you know, and who is asking in.

 * Pending room applications, the person row shared by every list, this room's members, your own
 * me-popover, the here/friends rail, and the message log that renders them.
 *
 * Lifted verbatim out of chat.html (2026-08-19). Same page, same scope: classic scripts on one
 * document share a global lexical environment, so nothing here is exported and nothing that calls
 * it changed. Load order is preserved — this file sits where the block used to sit.
 */
  /** Pending applications for the room you are LOOKING at. The cog still holds the full list
   *  with everyone's note; this is the bit that must not need opening.
   *  🔑 Applications only ever reach the owner (the server omits the field for everyone else),
   *  so an empty list here means "none pending", never "not allowed to see". */
  function renderApps() {
    const bar = $("appbar");
    const c = chanOf(activeCh);
    const me = (view?.you?.handle ?? "").toLowerCase();
    const apps = (c && me && (c.owner ?? "") === me && Array.isArray(c.applications)) ? c.applications : [];
    bar.hidden = apps.length === 0;
    if (!apps.length) { bar.dataset.handle = ""; return; }
    const one = apps.length === 1;
    // The note is why an owner can decide at all, so it rides the line when there is room for it.
    $("appText").textContent = one
      ? apps[0].handle + " wants in" + (apps[0].note ? " — " + apps[0].note : "")
      : apps.length + " people want in";
    bar.title = apps.map((a) => a.handle + (a.note ? " — " + a.note : "")).join("\n");
    // 🔑 The handle lives on the bar, not captured in a listener: the buttons are wired ONCE at
    // startup, and re-binding them on every render is how a stale applicant gets accepted.
    bar.dataset.handle = one ? apps[0].handle : "";
    $("appYes").hidden = !one;
    $("appNo").hidden = !one;
    $("appMore").hidden = one;
  }

  /** Light the unread dot when a NEW applicant turns up in a room you are not looking at.
   *  🔑 First sight SEEDS SILENTLY. The widget's iframe reloads on every regroup and the server
   *  re-sends the whole application list on join, so without this every stack, every restart and
   *  every arrange pass would re-announce applicants the owner already knew about — the same
   *  "a widget re-announces stale state on mount" trap the mining scanner hit. */
  const seenApps = new Map();
  function noteApplications() {
    const me = (view?.you?.handle ?? "").toLowerCase();
    for (const c of chans()) {
      const mine = !!me && (c.owner ?? "") === me;
      const now = new Set(mine && Array.isArray(c.applications) ? c.applications.map((a) => a.handle) : []);
      const before = seenApps.get(c.ch);
      seenApps.set(c.ch, now);
      if (!before) continue;
      if (c.ch === activeCh) continue; // you are looking at it — the bar above is the signal
      for (const h of now) if (!before.has(h)) { unread.add(c.ch); break; }
    }
  }

  /** One person row, shared by both rail modes so a name reads the same in either. */
  function personRow(handle, { you = false, verified = false, star = false, where = "", activity = "", inGame = false, unseen = false, org = "", orgRank = "", orgStars = 0, showRank = false } = {}) {
    const row = document.createElement("div");
    row.className = "mrow" + (you ? " you" : "");
    row.addEventListener("contextmenu", (e) => { e.preventDefault(); openCtx(handle, e.clientX, e.clientY); });
    row.title = "Right-click for mention, friends and profile";
    // 🔴 THE DOT MEANS ONE THING NOW: are they in the game. A per-handle hash colour used to
    // live here and Sub asked what the red one meant — it meant nothing, which is the whole
    // problem with putting identity on a marker. Identity is the NAME's colour; a marker reads
    // as a status light, so it had better be a status.
    // 🔑 There are only two states, and neither is "offline". Everyone on this list is connected
    // by definition; someone you cannot see is simply not on it. Saying offline about them would
    // be a confident lie about a person sitting in a room you never joined.
    // A friend in no channel we share is `unseen`: we know nothing about them, so the row says
    // nothing about them. An empty slot keeps the names aligned without asserting a state.
    const dot = document.createElement("span");
    dot.className = "st" + (unseen ? " unseen" : inGame ? " ingame" : "");
    if (!unseen) dot.title = inGame ? "In the 'verse right now" : "Connected to chat, not in game";
    row.appendChild(dot);
    const nm = document.createElement("span");
    nm.className = "nm"; nm.textContent = handle;
    // The truncated name always has the whole thing on hover — that is what makes clipping it
    // here acceptable rather than a way of losing information.
    nm.title = handle;
    // Same colour the name carries in the log, so a member list and its messages agree.
    if (!you) nm.style.color = nameColor(handle);
    row.appendChild(nm);
    if (star) {
      const f = document.createElement("span");
      f.className = "fav"; f.textContent = "★"; f.title = "Friend";
      row.appendChild(f);
    }
    // Org standing — ONLY in that org's own channel, and shown as the ORG'S OWN WORD for the
    // tier ("SSGT", "President", "Tirones"), not a star count.
    // 🔑 Both of those are Sub's calls (2026-08-12) and they turn out to be the same call. A rank
    // is meaningless outside the org that issued it — "does it need to show on the global chat
    // what rank you are? I think it'll be just fine in the person's org chat" — and INSIDE that
    // org, everyone already knows what SSGT means, so the org's own label beats any abstraction
    // of it. The 1-5 stays in the data (it is what makes "who leads this org" answerable) and
    // rides the tooltip; it is no longer what anyone reads.
    if (showRank && orgRank) {
      const b = document.createElement("span");
      b.className = "orgr" + (orgStars >= 4 ? " lead" : "");
      b.textContent = orgRank;
      b.title = orgRank + (orgStars ? " — rank " + orgStars + " of 5" : "") + (org ? " · " + org.toUpperCase() : "");
      row.appendChild(b);
    }
    // 🔑 Only ever rendered when the person actually shared something. Nothing is drawn in its
    // place otherwise — most people will never turn this on, and a placeholder ("idle", a dash)
    // would be a confident claim about someone we know nothing about.
    if (activity) {
      const a = document.createElement("span");
      a.className = "act"; a.textContent = activity;
      a.title = handle + " is sharing: " + activity;
      row.appendChild(a);
    }
    if (where) {
      const w = document.createElement("span");
      w.className = "where"; w.textContent = where;
      w.title = "In " + where + " right now";
      row.appendChild(w);
    }
    return row;
  }

  /** The right rail has two modes and one body. `rightMode` decides which list fills it. */
  function renderMembers() {
    $("memTitle").textContent = rightMode === "friends" ? "Friends" : "Here";
    if (rightMode === "friends") renderFriendList(); else renderHere();
  }

  /** YOUR settings — everything in here is about you and applies in every channel, which is
   *  exactly what distinguishes it from the per-CHANNEL cog down in the tab row.
   *  🔑 Rebuilt on every open rather than kept in sync. It is a handful of controls, and a panel
   *  that can disagree with what is actually saved is worse than one that is rebuilt. */
  function renderMePop() {
    const pop = $("mePop");
    pop.textContent = "";

    const row = (label, hint) => {
      const r = document.createElement("div");
      r.className = "mp-row";
      const l = document.createElement("span");
      l.className = "mp-lbl";
      l.textContent = label;
      if (hint) {
        const h = document.createElement("span");
        h.className = "mp-hint"; h.textContent = hint;
        l.appendChild(h);
      }
      r.appendChild(l);
      pop.appendChild(r);
      return r;
    };
    const toggle = (r, on, onClick) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "sw";
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.addEventListener("click", () => onClick(!on));
      r.appendChild(b);
      return b;
    };

    // 🔴 Invisible first: it is the one with a consequence for other people.
    const hideRow = row("Hide where I am",
      "Keeps you out of your server and Nearby channels. Nobody sees which shard you're on.");
    toggle(hideRow, !!view?.hideLocation, (next) => {
      if (view) view.hideLocation = next;
      renderMePop();
      void post("/api/chat/hide-location", { hide: next });
    });

    // 🔑 The label says WHAT would be published, not merely that something would — "share my
    // activity" invites a shrug; the contract you are running is a decision someone can make.
    const actRow = row("Share what I'm doing",
      "Shows the contract you're running, or that you're scanning rocks, to people in your channels.");
    toggle(actRow, !!view?.shareActivity, async (next) => {
      if (view) view.shareActivity = next;
      renderMePop();
      await fetch("/api/config", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatShareActivity: next }),
      }).catch(() => { if (view) view.shareActivity = !next; renderMePop(); });
    });

    row("My name colour", "Everyone sees you in this colour.");
    const swatches = document.createElement("div");
    swatches.className = "mp-colors";
    const mine = typeof view?.you?.color === "number" ? view.you.color : null;
    const pick = (idx) => {
      if (view?.you) view.you.color = idx;
      // Optimistic: our own row and every message we have sent recolour at once. The server
      // echoes a `color` frame back, which is what makes it true for everyone else.
      const me = (view?.you?.handle ?? "").toLowerCase();
      if (idx === null) chosenColors.delete(me); else chosenColors.set(me, idx);
      renderMePop(); renderMembers(); renderLog();
      void post("/api/chat/color", { color: idx });
    };
    const none = document.createElement("button");
    none.type = "button"; none.className = "none" + (mine === null ? " sel" : "");
    none.title = "No colour — go back to the one your name gets automatically";
    none.addEventListener("click", () => pick(null));
    swatches.appendChild(none);
    NAME_COLORS.forEach((c, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.style.background = c;
      if (mine === i) b.className = "sel";
      b.title = "Use this colour for your name";
      b.addEventListener("click", () => pick(i));
      swatches.appendChild(b);
    });
    pop.appendChild(swatches);
  }
  function setMePop(open) {
    if (open) renderMePop();
    $("mePop").classList.toggle("open", !!open);
    $("meBtn").classList.toggle("active", !!open);
  }

  function renderHere() {
    const list = $("memList");
    list.textContent = "";
    const c = chanOf(activeCh);
    const members = c?.members ?? [];
    // 🔑 Learn colours from the SAME data this rail renders from. They were only being picked up
    // off the presence SSE frame, so a member list that arrived any other way (a state push, a
    // reconnect, a test driving the view directly) rendered the rail correctly while the LOG
    // still showed the old hash colour — two paths for one fact, disagreeing.
    noteColors(members);
    $("memCount").textContent = c && typeof c.count === "number" ? String(c.count) : "";
    if (!members.length) {
      const e = document.createElement("div");
      e.className = "empty";
      e.textContent = c ? "Just you so far." : "";
      list.appendChild(e);
      return;
    }
    const me = (view?.you?.handle ?? "").toLowerCase();
    // You first, then friends, then everyone alphabetically.
    const rank = (h) => (h.toLowerCase() === me ? 0 : isFriend(h) ? 1 : 2);
    for (const m of [...members].sort((a, b) => rank(a.handle) - rank(b.handle) || a.handle.localeCompare(b.handle))) {
      list.appendChild(personRow(m.handle, {
        you: m.handle.toLowerCase() === me,
        verified: !!m.verified,
        star: isFriend(m.handle),
        activity: m.activity ?? "",
        inGame: !!m.inGame,
        org: m.org ?? "", orgRank: m.orgRank ?? "", orgStars: m.orgStars ?? 0,
        // 🔑 Only in the org's OWN room. A rank issued by one org means nothing in Global, and
        // `c.kind` is the honest test — an org room is the one place every reader shares the
        // ladder the label comes from.
        showRank: c?.kind === "org",
      }));
    }
  }

  /* Your friends, and which channel can currently SEE each one.
     🔑 A friend with no channel beside them is NOT offline. Presence only covers rooms you are
     both in, so "offline" would be a confident lie about someone who may be sitting in a room
     you never joined. The row says nothing rather than something wrong — same rule that killed
     the per-handle status dot. */
  function renderFriendList() {
    const list = $("memList");
    list.textContent = "";
    $("memCount").textContent = friends.length ? String(friends.length) : "";
    if (!friends.length) {
      const e = document.createElement("div");
      e.className = "empty";
      e.textContent = "No friends yet. Right-click anyone in chat and pick “Add to friends”.";
      list.appendChild(e);
      return;
    }
    // handle → the first channel of yours they turn up in; tabs run in this order, so it matches.
    const seen = new Map();
    for (const c of chans()) {
      for (const m of c.members ?? []) {
        const k = m.handle.toLowerCase();
        if (!seen.has(k)) seen.set(k, { label: c.label, verified: !!m.verified, activity: m.activity ?? "",
                                        inGame: !!m.inGame, org: m.org ?? "", orgRank: m.orgRank ?? "",
                                        orgStars: m.orgStars ?? 0 });
      }
    }
    // The ones you can see right now first, then the rest alphabetically.
    for (const h of [...friends].sort((a, b) => {
      const sa = seen.has(a.toLowerCase()) ? 0 : 1, sb = seen.has(b.toLowerCase()) ? 0 : 1;
      return sa - sb || a.localeCompare(b);
    })) {
      const hit = seen.get(h.toLowerCase());
      // 🔑 A friend we cannot see gets NO row decoration at all — no marker, no "offline". The
      // absence of a `where` is the honest signal: they may simply be somewhere we can't look.
      list.appendChild(personRow(h, { verified: !!hit?.verified, star: true, where: hit?.label ?? "",
                                      activity: hit?.activity ?? "", inGame: !!hit?.inGame,
                                      org: hit?.org ?? "", orgRank: hit?.orgRank ?? "",
                                      orgStars: hit?.orgStars ?? 0, unseen: !hit }));
    }
  }

  function renderLog() {
    $("log").textContent = "";
    const c = chanOf(activeCh);
    if (!c) {
      if (view?.status === "connected") sys("Pick a channel on the left.");
      return;
    }
    for (const m of c.msgs) append(msgRow(m));
    $("log").scrollTop = $("log").scrollHeight;
  }
