/**
 * REAL DATA, captured 2026-08-24 from a sidecar on :8782 against the LIVE UEX table.
 *
 * Nothing here is invented. Reproduce it with:
 *   GET /api/trade/status
 *   GET /api/trade/routes?ship=MISC%20Freelancer%20MAX&limit=14
 *   GET /api/trade/commodity?name=Neon
 *
 * 🔴 The Pyro skew in BOARD is REAL and it is the whole product problem: 12 of the 14 top runs
 * both start and end in Pyro. That is the system players get killed in.
 */
const STATUS = {
  "source": "live",
  "fetchedAt": 1787621798518,
  "version": null,
  "quotes": 2572,
  "droppedOffline": 21,
  "lastError": null,
  "canRefresh": true,
  "systems": [
    "Stanton",
    "Pyro",
    "Nyx"
  ],
  "here": null
};

const BOARD = {
  "routes": [
    {
      "commodity": "Bexalite",
      "from": {
        "terminal": "Fallow Field",
        "terminalShort": "Fallow Field",
        "place": "Fallow Field",
        "body": "Pyro IV",
        "system": "Pyro",
        "price": 23556,
        "scu": 104,
        "maxContainerScu": 24,
        "asOf": 1786998184
      },
      "to": {
        "terminal": "Sacren's Plot",
        "terminalShort": "Sacren's Plot",
        "place": "Sacren's Plot",
        "body": "Pyro IV",
        "system": "Pyro",
        "price": 36000,
        "scu": 507,
        "maxContainerScu": 16,
        "asOf": 1786789026
      },
      "marginPerScu": 12444,
      "marginPct": 52.827305145185946,
      "moveScu": 104,
      "scuBound": "stock",
      "capitalRequired": 2449824,
      "profit": 1294176,
      "minutes": 13,
      "profitPerHour": 5973120,
      "crossSystem": false,
      "ageDays": 9.64827886574074
    },
    {
      "commodity": "Bexalite",
      "from": {
        "terminal": "Bueno Ravine",
        "terminalShort": "Bueno Ravine",
        "place": "Bueno Ravine",
        "body": "Bloom",
        "system": "Pyro",
        "price": 23556,
        "scu": 70,
        "maxContainerScu": 16,
        "asOf": 1786749807
      },
      "to": {
        "terminal": "Sacren's Plot",
        "terminalShort": "Sacren's Plot",
        "place": "Sacren's Plot",
        "body": "Pyro IV",
        "system": "Pyro",
        "price": 36000,
        "scu": 507,
        "maxContainerScu": 16,
        "asOf": 1786789026
      },
      "marginPerScu": 12444,
      "marginPct": 52.827305145185946,
      "moveScu": 70,
      "scuBound": "stock",
      "capitalRequired": 1648920,
      "profit": 871080,
      "minutes": 14,
      "profitPerHour": 3733200,
      "crossSystem": false,
      "ageDays": 10.102202476851852
    },
    {
      "commodity": "Elespo",
      "from": {
        "terminal": "Chawla's Beach",
        "terminalShort": "Chawla's Beach",
        "place": "Chawla's Beach",
        "body": "Pyro IV",
        "system": "Pyro",
        "price": 6000,
        "scu": 95,
        "maxContainerScu": 16,
        "asOf": 1787374926
      },
      "to": {
        "terminal": "Ashland",
        "terminalShort": "Ashland",
        "place": "Ashland",
        "body": "Ignis",
        "system": "Pyro",
        "price": 15000,
        "scu": 332,
        "maxContainerScu": 24,
        "asOf": 1785955336
      },
      "marginPerScu": 9000,
      "marginPct": 150,
      "moveScu": 95,
      "scuBound": "stock",
      "capitalRequired": 570000,
      "profit": 855000,
      "minutes": 14,
      "profitPerHour": 3664285.714285714,
      "crossSystem": false,
      "ageDays": 19.297468680555557
    },
    {
      "commodity": "CK13-GID Seed Blend",
      "from": {
        "terminal": "Ashland",
        "terminalShort": "Ashland",
        "place": "Ashland",
        "body": "Ignis",
        "system": "Pyro",
        "price": 2513,
        "scu": 92,
        "maxContainerScu": 24,
        "asOf": 1787440401
      },
      "to": {
        "terminal": "Chawla's Beach",
        "terminalShort": "Chawla's Beach",
        "place": "Chawla's Beach",
        "body": "Pyro IV",
        "system": "Pyro",
        "price": 11000,
        "scu": 282,
        "maxContainerScu": 16,
        "asOf": 1787335131
      },
      "marginPerScu": 8487,
      "marginPct": 337.72383605252685,
      "moveScu": 92,
      "scuBound": "stock",
      "capitalRequired": 231196,
      "profit": 780804,
      "minutes": 14,
      "profitPerHour": 3346302.8571428573,
      "crossSystem": false,
      "ageDays": 3.3276191435185187
    },
    {
      "commodity": "Pitambu",
      "from": {
        "terminal": "Shepherd's Rest",
        "terminalShort": "Shepherd's Rest",
        "place": "Shepherd's Rest",
        "body": "Bloom",
        "system": "Pyro",
        "price": 49114,
        "scu": 48,
        "maxContainerScu": 32,
        "asOf": 1787434575
      },
      "to": {
        "terminal": "Sacren's Plot",
        "terminalShort": "Sacren's Plot",
        "place": "Sacren's Plot",
        "body": "Pyro IV",
        "system": "Pyro",
        "price": 78000,
        "scu": 26,
        "maxContainerScu": 16,
        "asOf": 1786789113
      },
      "marginPerScu": 28886,
      "marginPct": 58.81418740074113,
      "moveScu": 26,
      "scuBound": "demand",
      "capitalRequired": 1276964,
      "profit": 751036,
      "minutes": 14,
      "profitPerHour": 3218725.714285714,
      "crossSystem": false,
      "ageDays": 9.647271921296296
    },
    {
      "commodity": "Osoian Hides",
      "from": {
        "terminal": "The Golden Riviera",
        "terminalShort": "The Golden Riviera",
        "place": "The Golden Riviera",
        "body": "Bloom",
        "system": "Pyro",
        "price": 283500,
        "scu": 2,
        "maxContainerScu": 24,
        "asOf": 1787616990
      },
      "to": {
        "terminal": "Devlin Scrap and Salvage",
        "terminalShort": "Devlin Scrap",
        "place": "Devlin Scrap & Salvage",
        "body": "Euterpe",
        "system": "Stanton",
        "price": 870000,
        "scu": 4,
        "maxContainerScu": 32,
        "asOf": 1787431417
      },
      "marginPerScu": 586500,
      "marginPct": 206.8783068783069,
      "moveScu": 2,
      "scuBound": "stock",
      "capitalRequired": 567000,
      "profit": 1173000,
      "minutes": 24,
      "profitPerHour": 2932500,
      "crossSystem": true,
      "ageDays": 2.2131978472222222
    },
    {
      "commodity": "Degnous Root",
      "from": {
        "terminal": "Canard View",
        "terminalShort": "Canard View",
        "place": "Canard View",
        "body": "Terminus",
        "system": "Pyro",
        "price": 44156,
        "scu": null,
        "maxContainerScu": 16,
        "asOf": 1786795061
      },
      "to": {
        "terminal": "The Golden Riviera",
        "terminalShort": "The Golden Riviera",
        "place": "The Golden Riviera",
        "body": "Bloom",
        "system": "Pyro",
        "price": 59000,
        "scu": 45,
        "maxContainerScu": 24,
        "asOf": 1787454419
      },
      "marginPerScu": 14844,
      "marginPct": 33.61717546879247,
      "moveScu": 45,
      "scuBound": "demand",
      "capitalRequired": 1987020,
      "profit": 667980,
      "minutes": 14,
      "profitPerHour": 2862771.4285714286,
      "crossSystem": false,
      "ageDays": 9.578429328703704
    },
    {
      "commodity": "E'tam",
      "from": {
        "terminal": "Ashland",
        "terminalShort": "Ashland",
        "place": "Ashland",
        "body": "Ignis",
        "system": "Pyro",
        "price": 16295,
        "scu": 98,
        "maxContainerScu": 24,
        "asOf": 1787440401
      },
      "to": {
        "terminal": "Admin - Rod's Fuel 'N Supplies",
        "terminalShort": "Rod's Fuel",
        "place": "Rod's Fuel 'N Supplies",
        "body": "Pyro V",
        "system": "Pyro",
        "price": 23000,
        "scu": 232,
        "maxContainerScu": 32,
        "asOf": 1787600445
      },
      "marginPerScu": 6705,
      "marginPct": 41.14759128567045,
      "moveScu": 98,
      "scuBound": "stock",
      "capitalRequired": 1596910,
      "profit": 657090,
      "minutes": 14,
      "profitPerHour": 2816100,
      "crossSystem": false,
      "ageDays": 2.109216365740741
    },
    {
      "commodity": "Amioshi Plague",
      "from": {
        "terminal": "Ashland",
        "terminalShort": "Ashland",
        "place": "Ashland",
        "body": "Ignis",
        "system": "Pyro",
        "price": 17389,
        "scu": 89,
        "maxContainerScu": 24,
        "asOf": 1787440401
      },
      "to": {
        "terminal": "The Golden Riviera",
        "terminalShort": "The Golden Riviera",
        "place": "The Golden Riviera",
        "body": "Bloom",
        "system": "Pyro",
        "price": 24000,
        "scu": 126,
        "maxContainerScu": 24,
        "asOf": 1787617029
      },
      "marginPerScu": 6611,
      "marginPct": 38.01828742308356,
      "moveScu": 89,
      "scuBound": "stock",
      "capitalRequired": 1547621,
      "profit": 588379,
      "minutes": 14,
      "profitPerHour": 2521624.2857142854,
      "crossSystem": false,
      "ageDays": 2.109216365740741
    },
    {
      "commodity": "Neon",
      "from": {
        "terminal": "Last Landings",
        "terminalShort": "Last Landings",
        "place": "Last Landings",
        "body": "Terminus",
        "system": "Pyro",
        "price": 14206,
        "scu": 476,
        "maxContainerScu": 16,
        "asOf": 1787225503
      },
      "to": {
        "terminal": "Admin - Patch City",
        "terminalShort": "Patch City",
        "place": "Patch City",
        "body": "Bloom",
        "system": "Pyro",
        "price": 19000,
        "scu": 329,
        "maxContainerScu": 32,
        "asOf": 1787584132
      },
      "marginPerScu": 4794,
      "marginPct": 33.746304378431645,
      "moveScu": 120,
      "scuBound": "hold",
      "capitalRequired": 1704720,
      "profit": 575280,
      "minutes": 14,
      "profitPerHour": 2465485.714285714,
      "crossSystem": false,
      "ageDays": 4.596461736111111
    },
    {
      "commodity": "Audio-Visual Equipment",
      "from": {
        "terminal": "Fallow Field",
        "terminalShort": "Fallow Field",
        "place": "Fallow Field",
        "body": "Pyro IV",
        "system": "Pyro",
        "price": 25004,
        "scu": 51,
        "maxContainerScu": 24,
        "asOf": 1786998184
      },
      "to": {
        "terminal": "Chawla's Beach",
        "terminalShort": "Chawla's Beach",
        "place": "Chawla's Beach",
        "body": "Pyro IV",
        "system": "Pyro",
        "price": 35000,
        "scu": 51,
        "maxContainerScu": 16,
        "asOf": 1787335126
      },
      "marginPerScu": 9996,
      "marginPct": 39.97760358342665,
      "moveScu": 51,
      "scuBound": "stock",
      "capitalRequired": 1275204,
      "profit": 509796,
      "minutes": 13,
      "profitPerHour": 2352904.6153846155,
      "crossSystem": false,
      "ageDays": 7.227468680555556
    },
    {
      "commodity": "E'tam",
      "from": {
        "terminal": "Fallow Field",
        "terminalShort": "Fallow Field",
        "place": "Fallow Field",
        "body": "Pyro IV",
        "system": "Pyro",
        "price": 19350,
        "scu": 142,
        "maxContainerScu": 24,
        "asOf": 1786998188
      },
      "to": {
        "terminal": "Brio's Breaker Yard",
        "terminalShort": "Brio's Breaker",
        "place": "Brio's Breaker Yard",
        "body": "Daymar",
        "system": "Stanton",
        "price": 27000,
        "scu": 258,
        "maxContainerScu": 24,
        "asOf": 1787000151
      },
      "marginPerScu": 7650,
      "marginPct": 39.53488372093023,
      "moveScu": 120,
      "scuBound": "hold",
      "capitalRequired": 2322000,
      "profit": 918000,
      "minutes": 24,
      "profitPerHour": 2295000,
      "crossSystem": true,
      "ageDays": 7.227422384259259
    },
    {
      "commodity": "Fresh Food",
      "from": {
        "terminal": "Shepherd's Rest",
        "terminalShort": "Shepherd's Rest",
        "place": "Shepherd's Rest",
        "body": "Bloom",
        "system": "Pyro",
        "price": 20821,
        "scu": 128,
        "maxContainerScu": 32,
        "asOf": 1787434575
      },
      "to": {
        "terminal": "Ashland",
        "terminalShort": "Ashland",
        "place": "Ashland",
        "body": "Ignis",
        "system": "Pyro",
        "price": 25000,
        "scu": null,
        "maxContainerScu": 24,
        "asOf": 1785955328
      },
      "marginPerScu": 4179,
      "marginPct": 20.071082080591708,
      "moveScu": 120,
      "scuBound": "hold",
      "capitalRequired": 2498520,
      "profit": 501480,
      "minutes": 14,
      "profitPerHour": 2149200,
      "crossSystem": false,
      "ageDays": 19.297561273148148
    },
    {
      "commodity": "Audio-Visual Equipment",
      "from": {
        "terminal": "Seer's Canyon",
        "terminalShort": "Seer's Canyon",
        "place": "Seer's Canyon",
        "body": "Vatra",
        "system": "Pyro",
        "price": 25004,
        "scu": 50,
        "maxContainerScu": 16,
        "asOf": 1787228206
      },
      "to": {
        "terminal": "Chawla's Beach",
        "terminalShort": "Chawla's Beach",
        "place": "Chawla's Beach",
        "body": "Pyro IV",
        "system": "Pyro",
        "price": 35000,
        "scu": 51,
        "maxContainerScu": 16,
        "asOf": 1787335126
      },
      "marginPerScu": 9996,
      "marginPct": 39.97760358342665,
      "moveScu": 50,
      "scuBound": "stock",
      "capitalRequired": 1250200,
      "profit": 499800,
      "minutes": 14,
      "profitPerHour": 2142000,
      "crossSystem": false,
      "ageDays": 4.5651770138888885
    }
  ],
  "capacityScu": 120,
  "ship": "MISC Freelancer MAX",
  "source": "live",
  "fetchedAt": 1787621798518,
  "version": null,
  "quotes": 2572,
  "droppedOffline": 21,
  "lastError": null,
  "canRefresh": true,
  "systems": [
    "Stanton",
    "Pyro",
    "Nyx"
  ],
  "here": null
};

const NEON = {
  "commodity": "Neon",
  "buy": {
    "terminals": 3,
    "low": 14206,
    "high": 15449,
    "median": 14206,
    "freshestDays": 2.107515324074074,
    "stalestDays": 4.594760694444444
  },
  "sell": {
    "terminals": 19,
    "low": 17000,
    "high": 21000,
    "median": 19000,
    "freshestDays": 0.06338337962962963,
    "stalestDays": 20.094922731481482
  },
  "buyAt": [
    {
      "terminal": "Rustville",
      "terminalShort": "Rustville",
      "place": "Rustville",
      "body": "Pyro I",
      "system": "Pyro",
      "price": 14206,
      "scu": 103,
      "maxContainerScu": 16,
      "asOf": 1787332492
    },
    {
      "terminal": "Last Landings",
      "terminalShort": "Last Landings",
      "place": "Last Landings",
      "body": "Terminus",
      "system": "Pyro",
      "price": 14206,
      "scu": 476,
      "maxContainerScu": 16,
      "asOf": 1787225503
    },
    {
      "terminal": "Ashland",
      "terminalShort": "Ashland",
      "place": "Ashland",
      "body": "Ignis",
      "system": "Pyro",
      "price": 15449,
      "scu": 348,
      "maxContainerScu": 24,
      "asOf": 1787440401
    }
  ],
  "sellAt": [
    {
      "terminal": "Reclamation and Disposal Orinth",
      "terminalShort": "Reclamation Orinth",
      "place": "Reclamation & Disposal Orinth",
      "body": "Hurston",
      "system": "Stanton",
      "price": 21000,
      "scu": 100,
      "maxContainerScu": 32,
      "asOf": 1785886289
    },
    {
      "terminal": "Locker Room - CRU-L4",
      "terminalShort": "CRU-L4 Locker",
      "place": "CRU-L4 Shallow Fields Station",
      "body": "Crusader",
      "system": "Stanton",
      "price": 21000,
      "scu": 302,
      "maxContainerScu": 32,
      "asOf": 1787246480
    },
    {
      "terminal": "Samson & Son's Salvage Center",
      "terminalShort": "Samson & Son's",
      "place": "Samson & Son's Salvage Center",
      "body": "Wala",
      "system": "Stanton",
      "price": 19000,
      "scu": 170,
      "maxContainerScu": 24,
      "asOf": 1787383135
    },
    {
      "terminal": "Brio's Breaker Yard",
      "terminalShort": "Brio's Breaker",
      "place": "Brio's Breaker Yard",
      "body": "Daymar",
      "system": "Stanton",
      "price": 19000,
      "scu": 37,
      "maxContainerScu": 24,
      "asOf": 1787000156
    },
    {
      "terminal": "Devlin Scrap and Salvage",
      "terminalShort": "Devlin Scrap",
      "place": "Devlin Scrap & Salvage",
      "body": "Euterpe",
      "system": "Stanton",
      "price": 19000,
      "scu": 232,
      "maxContainerScu": 32,
      "asOf": 1787431422
    },
    {
      "terminal": "Admin - Rod's Fuel 'N Supplies",
      "terminalShort": "Rod's Fuel",
      "place": "Rod's Fuel 'N Supplies",
      "body": "Pyro V",
      "system": "Pyro",
      "price": 19000,
      "scu": 24,
      "maxContainerScu": 32,
      "asOf": 1787600465
    },
    {
      "terminal": "Admin - Patch City",
      "terminalShort": "Patch City",
      "place": "Patch City",
      "body": "Bloom",
      "system": "Pyro",
      "price": 19000,
      "scu": 329,
      "maxContainerScu": 32,
      "asOf": 1787584132
    },
    {
      "terminal": "Admin - Starlight Service",
      "terminalShort": "Starlight Service",
      "place": "Starlight Service Station",
      "body": "Bloom",
      "system": "Pyro",
      "price": 19000,
      "scu": 38,
      "maxContainerScu": 32,
      "asOf": 1787583900
    },
    {
      "terminal": "Admin - Endgame",
      "terminalShort": "Endgame",
      "place": "Endgame",
      "body": "Pyro IV",
      "system": "Pyro",
      "price": 19000,
      "scu": null,
      "maxContainerScu": 32,
      "asOf": 1787582302
    },
    {
      "terminal": "Admin - Gaslight",
      "terminalShort": "Gaslight",
      "place": "Gaslight",
      "body": "Pyro V",
      "system": "Pyro",
      "price": 19000,
      "scu": 123,
      "maxContainerScu": 32,
      "asOf": 1787570755
    },
    {
      "terminal": "Admin - Rat's Nest",
      "terminalShort": "Rat's Nest",
      "place": "Rat's Nest",
      "body": "Pyro V",
      "system": "Pyro",
      "price": 19000,
      "scu": 26,
      "maxContainerScu": 32,
      "asOf": 1787540333
    },
    {
      "terminal": "Admin - Dudley & Daughters",
      "terminalShort": "Dudley & Daughters",
      "place": "Dudley & Daughters",
      "body": "Terminus",
      "system": "Pyro",
      "price": 19000,
      "scu": 40,
      "maxContainerScu": 32,
      "asOf": 1787514246
    },
    {
      "terminal": "Admin - GrimHEX",
      "terminalShort": "GrimHEX",
      "place": "Green Imperial Housing Exchange",
      "body": "Yela",
      "system": "Stanton",
      "price": 19000,
      "scu": 40,
      "maxContainerScu": 32,
      "asOf": 1787329022
    },
    {
      "terminal": "Fallow Field",
      "terminalShort": "Fallow Field",
      "place": "Fallow Field",
      "body": "Pyro IV",
      "system": "Pyro",
      "price": 19000,
      "scu": 192,
      "maxContainerScu": 24,
      "asOf": 1786998222
    },
    {
      "terminal": "The Golden Riviera",
      "terminalShort": "The Golden Riviera",
      "place": "The Golden Riviera",
      "body": "Bloom",
      "system": "Pyro",
      "price": 19000,
      "scu": 138,
      "maxContainerScu": 24,
      "asOf": 1787617014
    },
    {
      "terminal": "Admin - Ruin Station",
      "terminalShort": "Ruin Station",
      "place": "Ruin Station",
      "body": "Terminus",
      "system": "Pyro",
      "price": 17000,
      "scu": 1,
      "maxContainerScu": 32,
      "asOf": 1787455907
    },
    {
      "terminal": "Admin - Checkmate",
      "terminalShort": "Checkmate",
      "place": "Checkmate Station",
      "body": "Monox",
      "system": "Pyro",
      "price": 17000,
      "scu": 185,
      "maxContainerScu": 32,
      "asOf": 1787607569
    },
    {
      "terminal": "Admin - Megumi Refueling",
      "terminalShort": "Megumi",
      "place": "Megumi Refueling",
      "body": "Terminus",
      "system": "Pyro",
      "price": 17000,
      "scu": 176,
      "maxContainerScu": 32,
      "asOf": 1787494173
    },
    {
      "terminal": "Admin - Orbituary",
      "terminalShort": "Orbituary",
      "place": "Orbituary",
      "body": "Bloom",
      "system": "Pyro",
      "price": 17000,
      "scu": 4,
      "maxContainerScu": 32,
      "asOf": 1787393803
    }
  ],
  "source": "live",
  "fetchedAt": 1787621798518,
  "version": null,
  "quotes": 2572,
  "droppedOffline": 21,
  "lastError": null,
  "canRefresh": true,
  "systems": [
    "Stanton",
    "Pyro",
    "Nyx"
  ],
  "here": null
};
