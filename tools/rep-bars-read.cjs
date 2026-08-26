// Electron half of `npm run probe:reppage` — decode a still and read the bar boxes out of it.
// Not run by hand: tools/rep-probe.mts spawns it and reads the JSON off stdout. It exists as a
// separate process for the same reason the app has one, namely that only a process with a
// bitmap can answer this, and it requires the app's own reader so the probe and the live path
// can never measure differently.
//
//   electron.exe tools/rep-bars-read.cjs <image> <cards.json>
const { app, nativeImage } = require("electron");
const fs = require("node:fs");
const { readBars, pixelsOf } = require("../electron/rep-bars.cjs");

app.on("ready", () => {
  try {
    const img = nativeImage.createFromPath(process.argv[2]);
    const cards = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
    const { width } = img.getSize();
    if (!width) throw new Error("could not decode " + process.argv[2]);
    console.log("REPBARS " + JSON.stringify(readBars(pixelsOf(img), cards, width)));
  } catch (e) {
    console.log("REPBARS-ERROR " + JSON.stringify(String((e && e.message) || e)));
  }
  app.quit();
});
