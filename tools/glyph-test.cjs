// Scan-glyph detection tests — `npm run test:glyph` (needs Electron for nativeImage only).
//
// The mining scanner used to call out any comma-grouped number the OCR found near screen centre,
// which is how "Debris" ended up in the player's ear mid-flight. A real signature is drawn beside
// a map-pin glyph; Windows OCR is text-only and can't see it, so the check is done on pixels.
//
// These build synthetic frames from the values MEASURED off Sub's 3440×1440 frame (2026-07-24):
// pin 15×22px, number 37×13px, gap 11px, pin mean RGB (190,200,113), HUD yellow B≈25–43. That
// means the geometry and the colour band can both be tested without a live game, and a real frame
// later only needs to confirm the thresholds — not discover them.
const { app, nativeImage } = require("electron");
const path = require("path");

const { findScanGlyph, GLYPH } = require(path.join(__dirname, "..", "electron", "capture.cjs"));

const results = [];
const ok = (name, pass, detail = "") => results.push({ name, pass: !!pass, detail: String(detail) });

/** Build a BGRA bitmap of `w`×`h`, fill it, then paint `rects` of [colour] onto it. */
function frame(w, h, bg, rects = []) {
  const buf = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    buf[i * 4] = bg[2]; buf[i * 4 + 1] = bg[1]; buf[i * 4 + 2] = bg[0]; buf[i * 4 + 3] = 255;
  }
  for (const { x, y, w: rw, h: rh, rgb } of rects) {
    for (let yy = y; yy < y + rh; yy++) {
      for (let xx = x; xx < x + rw; xx++) {
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const i = (yy * w + xx) * 4;
        buf[i] = rgb[2]; buf[i + 1] = rgb[1]; buf[i + 2] = rgb[0]; buf[i + 3] = 255;
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: w, height: h });
}

const SPACE = [8, 10, 14];        // dark space behind the HUD
const PIN = [190, 200, 113];      // measured pin mean
const HUD_YELLOW = [200, 190, 35];// the SCANNING label etc. — B far too low
const HUD_CYAN = [69, 208, 224];  // the overlay's own accent
const WHITE = [255, 255, 255];

app.whenReady().then(() => {
  // 🔴 THE "MATCHES THE NUMBER'S COLOUR" INVARIANT THIS FILE USED TO TEST WAS ITSELF WRONG, not
  // just mistuned (Rytharr, 2026-08-07). A real capture showed the pin GOLD beside a WHITE number
  // on the same frame — chromaDist 0.297, past the old 0.22 "must match" threshold, so that real,
  // correctly-scanned pin could never have been found. The colour still can't be hardcoded either
  // (confirmed to vary ship to ship) — so the invariant is now SATURATION: the pin is the only
  // COLOURFUL thing in the search box, whatever its specific hue, because the translucent pill and
  // the number text both measured under 0.1 saturation on the real frame while pin ink measured
  // 0.3+. These cases sweep several HUD colours, now including one that deliberately does NOT
  // match its number, because that is the case that was actually observed.
  const searchBox = { x: 110, y: 88, w: 34, h: 29 };
  const NUM = { x: 146, y: 96, w: 37, h: 13 };  // the number's own bbox, the BRIGHTNESS reference now
  const PIN_AT = { x: 120, y: 92, w: 15, h: 22 };
  /** A scene with a number in `numRgb` and, optionally, a pin in `pinRgb` beside it. */
  const scene = (numRgb, pinRgb, extra = []) => frame(400, 200, SPACE, [
    ...(pinRgb ? [{ ...PIN_AT, rgb: pinRgb }] : []),
    { ...NUM, rgb: numRgb },
    ...extra,
  ]);
  const look = (numRgb, pinRgb, extra) => findScanGlyph(scene(numRgb, pinRgb, extra), searchBox, NUM);

  // Every one of these is a plausible ship HUD, number and pin sharing one colour. All must
  // confirm — saturation doesn't care that it's the SAME colour as the number, only that it's a
  // colour at all.
  for (const [label, hud] of [
    ["the measured yellow-green HUD", PIN],
    ["a cyan HUD", HUD_CYAN],
    ["an amber HUD", [235, 170, 40]],
    ["a red HUD", [220, 70, 60]],
    ["a green HUD", [80, 220, 110]],
  ]) {
    const r = look(hud, hud);
    ok(`${label}: pin matching its number is FOUND`, r.seen, JSON.stringify({ f: r.fraction, ref: r.ref && r.ref.mean }));
  }

  // THE REAL CASE: a gold pin beside a white number — measured directly off a real screenshot
  // (Rytharr, 2026-08-07), not guessed. This is the one the old hue-matching test asserted must
  // NOT be found; it is a real, correctly-scanned signature, so it must.
  const GOLD_PIN = [236, 215, 110];   // real measured pin ink mean
  const WHITE_NUM = [250, 255, 253];  // real measured number ink mean
  ok("a gold pin beside a WHITE number is FOUND (the real observed case)",
     look(WHITE_NUM, GOLD_PIN).seen, JSON.stringify(look(WHITE_NUM, GOLD_PIN)));

  ok("a bare number with no pin is not", !look(WHITE, null).seen, JSON.stringify(look(WHITE, null)));
  ok("empty space is not", !findScanGlyph(frame(400, 200, SPACE), searchBox, NUM).seen);
  // A HUD label elsewhere on screen must not leak in — the search box is anchored on the number.
  ok("a SCANNING label outside the box does not count",
     !look(WHITE, null, [{ x: 40, y: 40, w: 90, h: 16, rgb: WHITE }]).seen);
  // 🔑 THE CASE EVERY COLOUR-BASED VERSION FAILED, now found. A pure white/grey pin is invisible to
  // anything keyed on colour: an absolute band, a hue matched to the number, and a saturation floor
  // all reject it by construction. It is not hypothetical — the debug capture showed Sub's own pin
  // rendering near-white. Brightness-plus-shape has no colour term at all, so the pin's hue simply
  // stops being part of the question.
  ok("a pure white pin (fully achromatic) IS found — no colour term left to fail on",
     look(WHITE, WHITE).seen, JSON.stringify(look(WHITE, WHITE)));

  // Translucency: the pill blends with whatever is behind it. Saturation survives a 50% blend
  // into either a dark or a lit backdrop because the RATIO between channels barely moves even as
  // overall brightness drops — only the luminance floor (checked separately) cares about that.
  const mix = (a, b, t) => a.map((v, i) => Math.round(v * (1 - t) + b[i] * t));
  ok("still found blended 50% into dark space", look(PIN, mix(PIN, SPACE, 0.5)).seen,
     JSON.stringify(look(PIN, mix(PIN, SPACE, 0.5))));
  const ROCK = [150, 140, 120];
  ok("still found blended 50% into a lit rock", look(PIN, mix(PIN, ROCK, 0.5)).seen,
     JSON.stringify(look(PIN, mix(PIN, ROCK, 0.5))));

  // Without a text rect there is nothing to calibrate BRIGHTNESS against, and it must REFUSE
  // rather than fall back to a guess.
  const noRef = findScanGlyph(scene(PIN, PIN), searchBox, null);
  ok("no text rect -> refuses, and says why", !noRef.seen && /calibrate/.test(noRef.why), noRef.why);

  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`  ${r.pass ? "ok  " : "FAIL"} ${r.name}${r.detail ? "   [" + r.detail + "]" : ""}`);
  console.log(`\n  ${results.length - failed.length}/${results.length} passed` + (failed.length ? `  <<< ${failed.length} FAILED` : ""));
  app.exit(failed.length ? 1 : 0);
});
