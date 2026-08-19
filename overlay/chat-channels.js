/**
 * CHAT — CHANNELS AND ROOMS: the tabs, the list, and one room's settings.

 * Tab strip and unread bells, the channel list with its hidden-row recovery, the per-channel
 * settings sheet, the room "about" panel, and the pinned message bar.
 *
 * Lifted verbatim out of chat.html (2026-08-19). Same page, same scope: classic scripts on one
 * document share a global lexical environment, so nothing here is exported and nothing that calls
 * it changed. Load order is preserved — this file sits where the block used to sit.
 */
  const chans = () => view?.channels ?? [];
  const chanOf = (ch) => chans().find((c) => c.ch === ch) ?? null;

  function renderTabs() {
    const tabs = $("tabs");
    tabs.textContent = "";
    for (const c of chans()) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tab" + (c.ch === activeCh ? " active" : "");
      b.textContent = c.label + (typeof c.count === "number" ? ` [${c.count}]` : "");
      if (unread.has(c.ch)) {
        const u = document.createElement("span");
        u.className = "unread";
        b.appendChild(u);
      }
      // Pending applications, on the TAB — the one place you see without opening anything.
      const me = (view?.you?.handle ?? "").toLowerCase();
      const pending = (c.owner && c.owner === me && Array.isArray(c.applications)) ? c.applications.length : 0;
      if (pending) {
        const ap = document.createElement("span");
        ap.className = "apps"; ap.textContent = String(pending);
        ap.title = pending === 1 ? "1 person is waiting to join" : pending + " people are waiting to join";
        b.appendChild(ap);
      }
      b.addEventListener("click", () => select(c.ch));
      tabs.appendChild(b);
    }
  }

  /** The per-channel mute toggle that rides each joined row. */
  function bellFor(c) {
    const b = document.createElement("span");
    const off = isMuted(c.ch);
    b.className = "bell" + (off ? " off" : "");
    b.title = off ? "Muted — mentions here stay silent. Click to unmute." : "Mute mention call-outs for this channel";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    const bell = document.createElementNS("http://www.w3.org/2000/svg", "path");
    bell.setAttribute("d", "M8 2a4 4 0 0 0-4 4c0 3-1.2 4-1.2 4h10.4S12 9 12 6a4 4 0 0 0-4-4zM6.6 12.5a1.6 1.6 0 0 0 2.8 0");
    svg.appendChild(bell);
    if (off) {
      // The slash is what says "silenced" at a glance; colour alone would not survive a skin.
      const slash = document.createElementNS("http://www.w3.org/2000/svg", "path");
      slash.setAttribute("d", "M2.5 2.5l11 11");
      svg.appendChild(slash);
    }
    b.appendChild(svg);
    b.addEventListener("click", (e) => {
      e.stopPropagation();   // the row itself selects the channel
      if (off) mutedChans.delete(c.ch); else mutedChans.add(c.ch);
      listSave("chatMuted", [...mutedChans]);
      renderChannels();
    });
    return b;
  }

  /** "N hidden — show" row. Hiding is only useful if getting them back is obvious. */
  function unhideRow(hidden) {
    const row = document.createElement("div");
    row.className = "crow unhide";
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = hidden.length + " hidden";
    row.appendChild(nm);
    const a = document.createElement("span");
    a.className = "ct"; a.textContent = "show";
    row.appendChild(a);
    row.title = "Bring these back into the list";
    row.addEventListener("click", () => {
      for (const d of hidden) hiddenRooms.delete(d.ch);
      listSave("chatHiddenRooms", [...hiddenRooms]);
      renderChannels();
    });
    return row;
  }

  /* The left rail is BOTH your channel list and the browser for ones you could join —
     the same thing EVE splits across two windows, which is why it reads as one list here. */
  function renderChannels() {
    const list = $("chanList");
    list.textContent = "";
    for (const g of GROUPS) {
      const mine = chans().filter((c) => c.kind === g.kind);
      let avail = g.kind === "browse" ? (view?.directory ?? []) : [];
      // Conversations the server knows about that aren't open as tabs — including any that
      // arrived while the app was closed, which is the case DMs exist for.
      // A DM opened from the right-click menu has no server room yet, so it lives here.
      const pending = g.kind === "dm" && pendingDm && !chanOf(dmChKey(pendingDm)) ? [pendingDm] : [];
      // 🔑 ...and it must then be EXCLUDED from the waiting-conversations list, or the person
      // you just opened appears twice — once as the pending tab and once as a thread — and the
      // duplicate looks undeletable because a DM has no leave button until it exists server-side
      // (Sub, 2026-08-09: "the last DM you were in shows up a second time").
      const threads = g.kind === "dm"
        ? (view?.dmThreads ?? []).filter((t) => !pending.some((h) => h.toLowerCase() === t.other.toLowerCase()))
        : [];
      // Rooms the user has waved away stay out of the browsable list until they ask for them.
      const hiddenHere = avail.filter((d) => hiddenRooms.has(d.ch));
      avail = avail.filter((d) => !hiddenRooms.has(d.ch));
      if (!mine.length && !avail.length && !threads.length && !pending.length && !hiddenHere.length) continue;

      const isShut = collapsed.has(g.kind);
      const h = document.createElement("div");
      h.className = "grp" + (isShut ? " shut" : "");
      const tw = document.createElement("span");
      tw.className = "tw"; tw.textContent = isShut ? "▸" : "▾";   // ▸ / ▾
      h.appendChild(tw);
      h.appendChild(document.createTextNode(g.title));
      // The count is what makes a rolled-up group honest — you can see there is something in
      // there without opening it.
      const n = mine.length + avail.length + threads.length + pending.length;
      if (isShut && n) {
        const ct = document.createElement("span");
        ct.className = "gct"; ct.textContent = String(n);
        h.appendChild(ct);
      }
      h.title = (isShut ? "Show" : "Hide") + " " + g.title;
      h.addEventListener("click", () => {
        if (collapsed.has(g.kind)) collapsed.delete(g.kind); else collapsed.add(g.kind);
        listSave("chatCollapsed", [...collapsed]);
        renderChannels();
      });
      list.appendChild(h);
      if (isShut) {
        // Still offer the way back for rooms hidden inside a collapsed group.
        if (hiddenHere.length) list.appendChild(unhideRow(hiddenHere));
        continue;
      }
      for (const c of mine) {
        const row = document.createElement("div");
        row.className = "crow" + (c.ch === activeCh ? " on" : "");
        const nm = document.createElement("span");
        nm.className = "nm"; nm.textContent = c.label;
        row.appendChild(nm);
        // A padlock marks a room whose door you are holding — it tells you at a glance that
        // what you say here isn't in the public directory.
        if (c.privacy === "private") {
          const lk = document.createElement("span");
          lk.className = "lock"; lk.textContent = "🔒"; lk.title = "Private room";
          row.appendChild(lk);
        }
        if (typeof c.count === "number") {
          const ct = document.createElement("span");
          ct.className = "ct"; ct.textContent = String(c.count);
          row.appendChild(ct);
        }
        row.addEventListener("click", () => select(c.ch));
        row.appendChild(bellFor(c));
        // Custom rooms and DMs can be closed — the rest follow your log and your org.
        if (c.kind === "custom" || c.kind === "dm") {
          const x = document.createElement("span");
          x.className = "x"; x.textContent = "✕";
          x.title = c.kind === "dm" ? "Close this conversation" : "Leave this channel";
          x.addEventListener("click", (e) => { e.stopPropagation(); leave(c.ch); });
          row.appendChild(x);
        }
        list.appendChild(row);
      }
      // Rooms you could join, grouped by what people are DOING in them (Sub, 2026-08-09) —
      // one flat list of names says nothing about whether a room is worth opening.
      const byCat = new Map();
      for (const d of avail) {
        const k = d.category ?? "social";
        if (!byCat.has(k)) byCat.set(k, []);
        byCat.get(k).push(d);
      }
      // Busiest activity first: the rooms with people in them are the ones worth showing.
      const cats = [...byCat.entries()].sort((a, b) =>
        b[1].reduce((n, d) => n + (d.count ?? 0), 0) - a[1].reduce((n, d) => n + (d.count ?? 0), 0)
        || catLabel(a[0]).localeCompare(catLabel(b[0])));
      for (const [slug, ds] of cats) {
        const sh = document.createElement("div");
        sh.className = "subgrp"; sh.textContent = catLabel(slug);
        list.appendChild(sh);
        for (const d of ds.sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || a.label.localeCompare(b.label))) {
          const row = document.createElement("div");
          row.className = "crow";
          row.title = "Join " + d.label;
          const nm = document.createElement("span");
          nm.className = "nm"; nm.style.color = "var(--faint)"; nm.textContent = d.label;
          row.appendChild(nm);
          // A listing has to say enough to be worth choosing over the one below it. Anything
          // absent is simply left out rather than rendered as an empty field.
          if (d.party) {
            const flag = document.createElement("span");
            flag.className = "pflag";
            flag.textContent = d.joinMode === "apply" ? "ASK" : "OPEN";
            flag.title = d.joinMode === "apply" ? "The owner approves who joins" : "Anyone can join";
            row.appendChild(flag);
            const bits = [];
            if (d.location) bits.push(d.location);
            if (d.voice && d.voice !== "none") bits.push(d.voice === "required" ? "voice req" : "voice ok");
            if (bits.length) {
              const meta = document.createElement("span");
              meta.className = "pmeta"; meta.textContent = bits.join(" · ");
              row.appendChild(meta);
            }
          }
          const ct = document.createElement("span");
          ct.className = "ct";
          // 🔑 The live count comes from PRESENCE, never from sizeMax — sizeMax is what the
          // leader wants, not who is actually there, and showing it as though it were real
          // headcount is the "confidently wrong" failure this project keeps relearning.
          ct.textContent = d.party && d.sizeMax ? (d.count ?? 0) + "/" + d.sizeMax : String(d.count ?? 0);
          row.appendChild(ct);
          // 🔑 An apply listing must not be clicked into. The server refuses it anyway, but
          // sending a join we KNOW will bounce, just to show the user an error, is a worse
          // experience than doing the right thing from the start.
          row.addEventListener("click", () => {
            if (d.party && d.joinMode === "apply") void post("/api/chat/apply", { ch: d.ch });
            else joinNamed(d.label, "join");
          });
          if (d.party && d.joinMode === "apply") row.title = "Ask to join " + d.label;
          // Wave a room away without touching membership — it is a room you could join, not one
          // you are in, so this is purely "stop showing me this".
          const hx = document.createElement("span");
          hx.className = "x"; hx.textContent = "✕"; hx.title = "Hide this from the list";
          hx.addEventListener("click", (e) => {
            e.stopPropagation();
            hiddenRooms.add(d.ch);
            listSave("chatHiddenRooms", [...hiddenRooms]);
            renderChannels();
          });
          row.appendChild(hx);
          list.appendChild(row);
        }
      }
      for (const handle of pending) {
        const ch = dmChKey(handle);
        const row = document.createElement("div");
        row.className = "crow" + (ch === activeCh ? " on" : "");
        const nm = document.createElement("span");
        nm.className = "nm"; nm.textContent = handle;
        row.appendChild(nm);
        row.addEventListener("click", () => select(ch));
        const x = document.createElement("span");
        x.className = "x"; x.textContent = "✕"; x.title = "Close this conversation";
        x.addEventListener("click", (e) => {
          e.stopPropagation(); pendingDm = null;
          if (activeCh === ch) select("global"); else renderChannels();
        });
        row.appendChild(x);
        list.appendChild(row);
      }
      if (hiddenHere.length) list.appendChild(unhideRow(hiddenHere));
      for (const t of threads) {
        const row = document.createElement("div");
        row.className = "crow";
        row.title = "Open your conversation with " + t.other;
        const nm = document.createElement("span");
        nm.className = "nm"; nm.style.color = "var(--faint)"; nm.textContent = t.other;
        row.appendChild(nm);
        const dot = document.createElement("span");
        dot.className = "dmdot";
        row.appendChild(dot);
        row.addEventListener("click", () => openDm(t.other));
        list.appendChild(row);
      }
    }
    if (!list.childElementCount) {
      const e = document.createElement("div");
      e.className = "empty";
      e.textContent = "No channels yet — they appear as you connect and fly.";
      list.appendChild(e);
    }
  }

  /* The private-room strip: the join code, and — if the room is yours — the invite box.
     🔑 It is only ever shown for a room you are ALREADY IN. The code is what admits the next
     person, so it must never appear anywhere someone outside the room can reach. */
  /* Everything about the CURRENT channel, behind one cog (Sub, 2026-08-10). Replaces the old
     always-on room bar — its Delete button sat exposed for as long as you were in a room you
     made, which is exactly the kind of destructive control that should take a deliberate act to
     reach. 🔑 The cog is ALWAYS present, even on Global where the only thing to change is the
     mute, because a control that appears and disappears is one people stop looking for. */
  function renderChanSettings() {
    const c = chanOf(activeCh);
    const me = (view?.you?.handle ?? "").toLowerCase();
    const mine = !!c && c.kind === "custom" && !!c.owner && c.owner === me;
    const secret = !!c && c.kind === "custom" && c.privacy === "private" && !!c.code;

    $("csTitle").textContent = c?.label ?? (activeCh.startsWith("dm:") ? dmOther(activeCh) || "Conversation" : "Channel");

    const muted = isMuted(activeCh);
    $("csMute").textContent = muted ? "Muted" : "On";
    $("csMute").classList.toggle("active", !muted);
    $("csMuteNote").textContent = muted
      ? "You will still see the highlight and the unread dot — you just won't hear it."
      : "HAL says so when someone @mentions you here.";

    // The pin section shows for anyone (it is the room's notice) but only the owner may clear it.
    const pin = c?.pin ?? null;
    $("csPinRow").hidden = !pin;
    if (pin) {
      $("csPinText").textContent = pin.handle + ": " + pin.text;
      $("csPinRemove").hidden = !canPin(activeCh);
    }

    // Applications only ever reach the owner, so an empty list here means "none pending",
    // never "not allowed to see".
    const apps = (mine && Array.isArray(c?.applications)) ? c.applications : [];
    $("csAppsRow").hidden = apps.length === 0;
    if (apps.length) {
      $("csAppsLbl").textContent = apps.length === 1 ? "1 person wants in" : apps.length + " people want in";
      const box = $("csApps");
      box.textContent = "";
      for (const a of apps) {
        const wrap = document.createElement("div");
        const row = document.createElement("div");
        row.className = "ap";
        const nm = document.createElement("span");
        nm.className = "nm"; nm.textContent = a.handle;
        row.appendChild(nm);
        const yes = document.createElement("button");
        yes.type = "button"; yes.className = "hbtn sm"; yes.textContent = "Accept";
        yes.addEventListener("click", () => void post("/api/chat/application", { ch: activeCh, handle: a.handle, accept: true }));
        row.appendChild(yes);
        const no = document.createElement("button");
        no.type = "button"; no.className = "hbtn sm danger"; no.textContent = "No";
        no.title = "Decline";
        no.addEventListener("click", () => void post("/api/chat/application", { ch: activeCh, handle: a.handle, accept: false }));
        row.appendChild(no);
        wrap.appendChild(row);
        // Their note is why the owner can decide at all — show it, but never let it push the
        // buttons off the row.
        if (a.note) {
          const note = document.createElement("div");
          note.className = "note"; note.textContent = a.note;
          wrap.appendChild(note);
        }
        box.appendChild(wrap);
      }
    }

    // What the room is for and who can find it — the owner's to change, nobody else's to see.
    $("csAboutRow").hidden = !mine;
    if (mine) renderRoomAbout(c);

    $("csCodeRow").hidden = !secret;
    if (secret) $("csCode").textContent = c.code;
    // Inviting is meaningless for a public room — anyone can already walk in.
    $("csInviteRow").hidden = !(secret && mine);
    $("csDangerRow").hidden = !mine;
    $("csNothing").hidden = !!(pin || secret || mine);

    // The DM disclaimer rides the same render pass, so it can never disagree with which channel
    // is actually on screen.
    // 🔑 Keyed off the CHANNEL, not the channel object: a DM you have opened but not yet sent
    // into has no server-side room, so chanOf() is null for it — and that is exactly the moment
    // the warning matters most, right before someone types their first message.
    $("dmWarn").classList.toggle("show", activeCh.startsWith("dm:"));
  }

  /* The owner's two dropdowns. Both read the SERVER's answer every pass — the change is applied
     by the server and arrives back as a roominfo, so these never show a state the room is not
     actually in. (That is also why nothing here updates optimistically: a privacy change can be
     refused, and a switch that flips before the refusal lands is a lie for as long as it takes.) */
  function renderRoomAbout(c) {
    // Rebuilt from the server's list, same as the create dialog — a category added server-side
    // has to appear here without an app release, or the two lists drift apart.
    const sel = $("csCat");
    sel.textContent = "";
    for (const cat of (view?.categories ?? [])) {
      const o = document.createElement("option");
      o.value = cat.slug; o.textContent = cat.label;
      sel.appendChild(o);
    }
    sel.value = c.category ?? "social";
    if (!sel.value) sel.value = sel.options[0]?.value ?? "";

    // 🔑 A listing that approves people has to STAY findable — the server refuses to make one
    // private, so the option is disabled here rather than offered and rejected. Same rule the pin
    // ✕ already follows: never show a control whose only outcome is an error.
    const applyParty = c.party === true && c.joinMode === "apply";
    const priv = $("csPriv");
    priv.value = c.privacy === "private" ? "private" : "public";
    priv.options[1].disabled = applyParty;
    priv.disabled = applyParty;

    $("csAboutNote").textContent = applyParty
      ? "A group that approves people stays listed, so it can be found and applied to."
      : c.privacy === "private"
        ? "Not listed anywhere. Making it public drops the join code — anyone could then walk in by name."
        : "Listed for everyone. Making it private keeps everyone who is here right now and gives you a new code to share.";
  }
  async function setRoomConfig(field, value) {
    const c = chanOf(activeCh);
    if (!c) return;
    await post("/api/chat/room-config", { ch: c.ch, [field]: value });
  }

  function setChanSettings(open) {
    $("chanSettings").hidden = !open;
    $("chanCog").classList.toggle("on", !!open);
    if (open) { renderChanSettings(); try { host()?.summonCog?.(); } catch { /* not embedded */ } }
  }

  /* ── pinned notice ────────────────────────────────────────────────────────
     Only a custom room's OWNER may pin, which is the same authority that invites and deletes.
     The ownerless rooms (Global, the region, Nearby, org) are pinned by a moderator over the
     server's loopback route, so they can still SHOW a pin here — they just can't be pinned from
     the widget, and the ✕ hides itself rather than offering something the server will refuse. */
  const canPin = (ch) => {
    const c = chanOf(ch);
    const me = (view?.you?.handle ?? "").toLowerCase();
    return !!c && c.kind === "custom" && !!me && (c.owner ?? "") === me;
  };
  function renderPin() {
    const bar = $("pinbar");
    const pin = chanOf(activeCh)?.pin ?? null;
    bar.hidden = !pin;
    if (!pin) return;
    $("pinText").textContent = "";
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = pin.handle + ": ";
    $("pinText").appendChild(who);
    $("pinText").appendChild(document.createTextNode(pin.text));
    // The full text lives in the tooltip because the bar is deliberately one line.
    bar.title = pin.handle + ": " + pin.text + "  — pinned by " + pin.by;
    $("pinX").hidden = !canPin(activeCh);
  }
