/**
 * Resolves an erkul.games saved loadout into a clean, typed structure.
 *
 * Pipeline (all against https://server.erkul.games — the SPA's API host):
 *   1. GET /loadouts/<id>            -> { created, loadout: <base64 JSON> }
 *   2. base64-decode + JSON.parse    -> a tree of slots
 *   3. resolve each item's localName -> display name/size/grade via /live/<type>
 *
 * The host 403s datacenter IPs (Cloudflare), so requests carry browser-like
 * headers. From a residential IP (the streamer's PC) this returns 200.
 *
 * "Modified" (non-stock) is `item.stock !== true`: erkul tags untouched slots
 * with stock:true and omits/clears it on the ones the user changed.
 */

const API = "https://server.erkul.games";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  Accept: "application/json",
  Origin: "https://www.erkul.games",
  Referer: "https://www.erkul.games/",
};

/** calculatorType -> /live/<endpoint> for name resolution. */
const ENDPOINTS: Record<string, string> = {
  "power-plant": "power-plants",
  cooler: "coolers",
  shield: "shields",
  "controller-flight": "controllers",
  radar: "radars",
  qdrive: "qdrives",
  jumpdrive: "jumpdrives",
  mount: "mounts",
  weapon: "weapons",
  turret: "turrets",
  "missile-rack": "missile-racks",
  missile: "missiles",
  bomb: "bombs",
  module: "modules",
  emp: "emps",
  qed: "qeds",
  "mining-laser": "mining-lasers",
  utility: "utilities",
  paint: "paints",
};

export interface BuildItem {
  category: string;
  localName: string;
  name: string;
  size: number | null;
  grade: string | null;
  subType: string | null;
  modified: boolean;
  children: BuildItem[];
}

export interface Build {
  id: string;
  ship: { localName: string; name: string; size: number | null };
  items: BuildItem[];
  fetchedAt: string;
}

async function api(path: string): Promise<any> {
  const r = await fetch(API + path, { headers: HEADERS });
  if (!r.ok) throw new Error(`erkul ${path} -> HTTP ${r.status}`);
  return r.json();
}

/** localName -> item `data` object, per calculatorType. Cached for the process. */
const refCache = new Map<string, Map<string, any>>();
async function refMap(calcType: string): Promise<Map<string, any>> {
  const cached = refCache.get(calcType);
  if (cached) return cached;
  const map = new Map<string, any>();
  const ep = ENDPOINTS[calcType];
  if (ep) {
    for (const r of await api(`/live/${ep}`)) map.set(r.localName, r.data ?? {});
  }
  refCache.set(calcType, map);
  return map;
}

function parseId(idOrUrl: string): string {
  const m = idOrUrl.match(/loadout\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  const trimmed = idOrUrl.trim();
  // A URL with no /loadout/<id> segment (e.g. the live calculator) can't resolve —
  // the working build only lives in the browser until you Share it.
  if (trimmed.includes("/")) {
    throw new Error(
      "No loadout ID in that link. In erkul, click Share to save the build, then paste the /loadout/<id> URL it gives you.",
    );
  }
  return trimmed;
}

async function resolveNodes(nodes: any[]): Promise<BuildItem[]> {
  const out: BuildItem[] = [];
  for (const n of nodes ?? []) {
    const it = n.item;
    if (!it?.localName) {
      // A structural node with no item of its own — flatten its children up.
      out.push(...(await resolveNodes(n.loadout)));
      continue;
    }
    const d = (await refMap(it.calculatorType)).get(it.localName) ?? {};
    out.push({
      category: it.calculatorType,
      localName: it.localName,
      name: d.name ?? it.localName,
      size: d.size ?? null,
      grade: d.grade ?? null,
      subType: d.subType ?? d.type ?? null,
      modified: it.stock !== true,
      children: await resolveNodes(n.loadout),
    });
  }
  return out;
}

export async function resolveLoadout(idOrUrl: string): Promise<Build> {
  const id = parseId(idOrUrl);
  const lo = await api(`/loadouts/${id}`);
  const tree = JSON.parse(Buffer.from(lo.loadout, "base64").toString("utf8"));

  const shipLocal = tree.ship?.localName ?? "";
  const shipData =
    (await api("/live/ships")).find((s: any) => s.localName === shipLocal)?.data ?? {};

  return {
    id,
    ship: { localName: shipLocal, name: shipData.name ?? shipLocal, size: shipData.size ?? null },
    items: await resolveNodes(tree.loadout),
    fetchedAt: new Date().toISOString(),
  };
}
