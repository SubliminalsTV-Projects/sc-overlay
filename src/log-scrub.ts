/**
 * Scrub personally-identifying data from a Star Citizen Game.log before it is shared
 * (opt-in) with SubliminalsTV to improve the tracker. This runs entirely on the user's
 * machine — nothing leaves until after scrubbing.
 *
 * The player's handle, account id, and character geid each appear 150-220× across a
 * single session (not just at login — the log references the player entity constantly),
 * so we extract each identifier ONCE from the login/character-status lines, then
 * global-replace every occurrence. IP addresses and the login session id are regex-
 * scrubbed. Chat lines are dropped wholesale (they can carry other players' names and
 * are useless to the tracker). Everything else — timestamps, mission events, blueprint
 * drops — is left intact; that's the signal we actually want.
 */

export interface ScrubResult {
  text: string;
  /** What was found + removed, for the client's "we stripped X" confidence + logging. */
  removed: { handle: boolean; accountId: boolean; geid: boolean; ips: number; sessions: number; chatLines: number };
}

// `<…> geid 204772220757 - accountId 379202 - name Handle - state STATE_CURRENT`
const RE_CHAR = /geid (\d+) - accountId (\d+) - name (\S+) - state STATE_CURRENT/;
// `User Login Success - Handle[Handle] - Time[…]`
const RE_HANDLE = /Handle\[([^\]]+)\]/;
// `Subscribing player 379202 to contacts topics`
const RE_ACCT_PLAYER = /Subscribing player (\d+)/;
const RE_IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
const RE_SESSION = /LoginSessionId:\s*[0-9a-fA-F-]{8,}/g;
const RE_JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const RE_CHAT = /chat/i; // substring: catches <CSCChatController>, [Chat], chat messages — none are tracker signal

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function scrubGameLog(raw: string): ScrubResult {
  const removed = { handle: false, accountId: false, geid: false, ips: 0, sessions: 0, chatLines: 0 };

  // Pass 1 — extract the player's own identifiers from the character-status / login lines.
  let handle = "", accountId = "", geid = "";
  const cm = raw.match(RE_CHAR);
  if (cm) { geid = cm[1]; accountId = cm[2]; handle = cm[3]; }
  if (!handle) { const h = raw.match(RE_HANDLE); if (h) handle = h[1]; }
  if (!accountId) { const a = raw.match(RE_ACCT_PLAYER); if (a) accountId = a[1]; }

  // Pass 2 — drop chat lines (never useful, may name other players).
  const kept: string[] = [];
  for (const line of raw.split("\n")) {
    if (RE_CHAT.test(line)) { removed.chatLines++; continue; }
    kept.push(line);
  }
  let text = kept.join("\n");

  // Pass 3 — global-replace the extracted identifiers everywhere they appear.
  if (handle) {
    text = text.replace(new RegExp(escapeRe(handle), "g"), "<PLAYER>");
    removed.handle = true;
  }
  if (accountId && accountId.length >= 4) {
    text = text.replace(new RegExp("\\b" + escapeRe(accountId) + "\\b", "g"), "<ACCT>");
    removed.accountId = true;
  }
  if (geid && geid.length >= 6) {
    text = text.replace(new RegExp("\\b" + escapeRe(geid) + "\\b", "g"), "<GEID>");
    removed.geid = true;
  }

  // Pass 4 — regex-scrub network + session identifiers.
  text = text.replace(RE_IPV4, () => { removed.ips++; return "<IP>"; });
  text = text.replace(RE_SESSION, () => { removed.sessions++; return "LoginSessionId: <SESSION>"; });
  text = text.replace(RE_JWT, "<JWT>");

  return { text, removed };
}
