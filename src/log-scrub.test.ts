/**
 * Synthetic self-check for the Game.log scrubber (no real player data). Run with:
 *   npx tsx src/log-scrub.test.ts
 * Asserts the fake handle / account id / geid / IP / session are fully stripped and
 * that mission-signal lines survive. Exits non-zero on any leak.
 */
import { scrubGameLog } from "./log-scrub.js";

const HANDLE = "TestPilot-42";
const ACCT = "998877";
const GEID = "204772220757";
const IP = "203.0.113.77";

const raw = [
  `<2026-07-07T15:15:14Z> [Notice] <InitiateLogin> Started. LoginSessionId: 4c385195-28f6-f940-bee2-a89784f0f6b4 [Login]`,
  `<2026-07-07T15:15:28Z> [Notice] <AccountLoginCharacterStatus_Character> Character: geid ${GEID} - accountId ${ACCT} - name ${HANDLE} - state STATE_CURRENT [Login]`,
  `<2026-07-07T15:15:31Z> [Notice] <Legacy login response> User Login Success - Handle[${HANDLE}] - Time[256] [Login]`,
  `<2026-07-07T15:16:00Z> [Notice] <Network> connected to ${IP}:443 as player ${ACCT} (geid ${GEID})`,
  `<2026-07-07T15:17:00Z> [Notice] <CSCChatController> ${HANDLE}: hello everyone`,
  `<2026-07-07T15:20:00Z> [Notice] <Mission> Contract accepted: Locate Missing Cargo (owner geid ${GEID})`,
  `<2026-07-07T15:25:00Z> [Notice] <EntityBlueprintReward> received blueprint 'A03 Sniper Rifle'`,
].join("\n");

const { text, removed } = scrubGameLog(raw);
const has = (s: string) => text.includes(s);
const checks: [string, boolean][] = [
  ["handle stripped", !has(HANDLE)],
  ["account id stripped", !has(ACCT)],
  ["geid stripped", !has(GEID)],
  ["ip stripped", !has(IP)],
  ["session stripped", !has("4c385195-28f6-f940")],
  ["chat line dropped", !has("hello everyone")],
  ["mission line kept", has("Locate Missing Cargo")],
  ["blueprint line kept", has("A03 Sniper Rifle")],
  ["removed flags set", removed.handle && removed.accountId && removed.geid && removed.ips === 1 && removed.sessions === 1],
];
let fail = false;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) fail = true;
}
console.log(fail ? "\nlog-scrub.test: FAIL" : "\nlog-scrub.test: PASS");
process.exit(fail ? 1 : 0);
