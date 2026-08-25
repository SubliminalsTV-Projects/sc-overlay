# Commodities tab — three mockups

Design only. **Nothing here is wired to anything** and nothing in this folder is loaded by the app.

Open **`index.html`** — option / width / skin selectors across the top, and the three states side by
side underneath at real widget size. Double-clicking the file works; no server needed.

Pre-rendered PNGs are in `shots/`, named `<option>-<state>-<skin>-<width>.png`.

---

## The problem, in Sub's words

> "The commodities tab is going to help people find the most profitable routes at a glance. But if
> they don't want to do the most profitable routes — because those are also almost certainly the
> most dangerous, from other players trying to kill you — then maybe they're willing to do an
> alternative route that pays a little less but might be safer."

The tab today answers **"what is most profitable"** and cannot answer **"what can I do with Neon"**.

🔴 **The live data says the thesis is right.** The board captured for these mockups is a real
`/api/trade/routes` response for a Freelancer MAX: **12 of the top 14 runs both start and end in
Pyro.** A player who does not want to fly Pyro has, today, no control on this tab that helps them.

## The three options

| | idea | optimises for | costs |
|---|---|---|---|
| **A** `option-a-filter.html` | one kind of row, always — search narrows the ranked board | continuity; a player who never types cannot tell it from today | the answer is still a money ranking, so "safer" is found by reading down, not by looking |
| **B** `option-b-funnel.html` | three constraint slots: **what → buy at → sell at** | steering — "from where I'm standing" and "sell it in Stanton" are one click each | the most chrome and the most state of the three |
| **C** `option-c-dossier.html` | search returns **places**, not runs — every terminal that sells it, every terminal that buys it | seeing the whole option space, which is what choosing safety over money needs | two row shapes on one tab; the leaderboard moves below the search field |

Each option file carries its own reasoning in a header comment. **Recommendation and the fallback
judgement are in the flight strip**, `.atc/sc-loadout-overlay/tradelook.md`.

## The "+ Route" button

> "It would look a lot better if it was right justified. Right now it's a massive pill right next to
> the smaller pills for the different commodities."

Two answers, one per option, so they can be compared rather than argued about:

- **A** — `.tdchips .pushright { margin-left: auto }`. One declaration; the button keeps its place
  in the chip row and lands in a column of its own at the right edge.
- **B and C** — a right **rail**: the profit figure *and* the button leave the text block for a
  right-hand column. This is the "same column as the price" reading, and it also frees the title
  line, which at 320px is where the row is tightest.

The rail is the **last** child of the row, so its right edge comes from the row's own padding and
one right edge is guaranteed across every row with no spacer element to keep in sync.

## Files

| file | what it is |
|---|---|
| `index.html` | the compare rig — option / width / skin, three states side by side |
| `option-a-filter.html` · `option-b-funnel.html` · `option-c-dossier.html` | the designs. Each is a real widget page: `?state=rest\|search\|route`, `?theme=<skin>`, `?embedded` |
| `_hauling-style.css` | **VERBATIM** copy of the `<style>` block in `overlay/hauling.html`. Not edited. This is what the widget looks like today |
| `_new.css` | **everything that is proposed.** Split from the file above on purpose: the whole cost of a design is then readable as one file, and a design that needs less CSS is visibly a design that needs less CSS |
| `_rig.js` | helpers lifted from `overlay/hauling-tab-trade.js` so a mocked row renders exactly like a shipped one, plus the head/summary/credit scaffold |
| `_mock-data.js` | **real data**, captured 2026-08-24 off a live sidecar. See below |
| `shoot.cjs` | renders every state to `shots/` in the app's own Chromium at exact widget size |
| `_probe-colors.cjs` | asserts the classes `_new.css` introduces are actually painted, and distinct, in two skins |

## The data is real

No lorem, no invented numbers. Reproduce with a sidecar on any spare port:

```bash
APPDATA=/e/tmp/scratch PORT=8782 SC_NO_SYNC=1 npx tsx src/overlay-server.ts
```

then

```bash
curl -s "http://localhost:8782/api/trade/commodity?name=Neon"
```

`_mock-data.js` holds three payloads verbatim — `/api/trade/status` (live, 2,572 quotes),
`/api/trade/routes?ship=MISC%20Freelancer%20MAX&limit=14`, and `/api/trade/commodity?name=Neon`
(3 buy terminals, 19 sell terminals). Everything the mockups draw is either one of those fields or
is derived from them by `pairingsFor()` in `_rig.js`, which uses the same arithmetic the finder
uses so the mocked figures agree with the shipped ones.

🔑 **The search Sub is asking for is a UI gap, not a data gap.** `lookupCommodity()` in
`src/trade-finder.ts` already returns `buyAt` (cheapest first) and `sellAt` (best first), both with
prices, stock, body, system and per-quote age; `GET /api/trade/names` already returns every
tradable commodity for an autocomplete. Neither endpoint needs to change for any of these three.

## Sizes are a real constraint

`overlay/canvas.js` gives hauling `w 440, h 620, minW 320, maxW 1200`. Every option is rendered at
**440** and at **320**; judge at 320, because that is the width where a design either holds or folds.
All three hold — the differences show up in what has to truncate.

## Two things this exercise found

🔴 **The system badge's home/away distinction collapses on the Drake skin.** First cut used
`--cyan-bright` against `--amber`: obvious on mobiGlas (cyan vs amber), and on Drake those two
tokens compute to `rgb(251,178,74)` and `rgb(246,169,58)` — **30 units apart across all three
channels**, i.e. invisible, on a skin that is one click away. Fixed by giving `away` a *fill* rather
than only a colour, which no palette can collapse. `_probe-colors.cjs` now requires a real channel
distance **or** a different background, and it is negative-controlled: removing the fill makes it
report the Drake case and pass mobiGlas, which is exactly how the defect would have shipped.

⚠️ **`--good` is defined in zero themes.** `var(--good)` renders as the inherited colour while
reading as deliberate in the source. `_new.css` uses only `--green` / `--cyan` / `--gold` /
`--amber` / `--red` / `--value-rgb`, all of which are defined in every skin.
