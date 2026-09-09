import { validateSimulationBudget } from "./simulator.js";

export const PLAN_HASH_PREFIX = "#plan=";
export const MAX_PLAN_LENGTH = 6000;
const strategies = ["finish", "efficient", "intact", "radiant"];
const trialCounts = [5000, 20000, 100000];
const modes = ["budget", "goal"];
const goals = ["0.5", "0.9", "0.95", "0.99"];
const safeId = (value) => typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,95}$/.test(value);
const required = (part) => Math.max(1, Math.floor(Number(part.required || part.quantity || 1)));

/** Share only the completed simulation's selected targets, never the global collection or session ledger. */
export function encodePlan({ rotationId, options, mode = "budget", goal = "0.95" }) {
  const { budget, squad, strategy, trials, primeItems } = options;
  const payload = [1, rotationId, budget, squad, strategies.indexOf(strategy), trialCounts.indexOf(trials),
    modes.indexOf(mode), goals.indexOf(String(goal)), primeItems.map((item) => [item.id,
      item.parts.filter((part) => part.ownedCount > 0).map((part) => [part.id, part.ownedCount])])];
  const json = JSON.stringify(payload);
  // Catalog IDs and the versioned payload are ASCII, so no platform-specific encoding is needed.
  const encoded = btoa(json).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  if (encoded.length > MAX_PLAN_LENGTH) throw new RangeError("Plan is too large");
  return encoded;
}

export function decodePlan(hash, { rotations = [], primeItems = [] } = {}) {
  if (!String(hash).startsWith(PLAN_HASH_PREFIX)) return { status: "absent" };
  try {
    const encoded = hash.slice(PLAN_HASH_PREFIX.length);
    if (!encoded || encoded.length > MAX_PLAN_LENGTH || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("Invalid encoding");
    const payload = JSON.parse(atob(encoded.replaceAll("-", "+").replaceAll("_", "/")));
    if (!Array.isArray(payload) || payload.length !== 9 || payload[0] !== 1) throw new Error("Unknown version");
    const [, rotationId, budget, squad, strategyIndex, trialsIndex, modeIndex, goalIndex, targets] = payload;
    const rotation = rotations.find((entry) => entry.id === rotationId && entry.publicationStatus === "published");
    if (!rotation) return { status: "unavailable" };
    if (!safeId(rotationId) || typeof budget !== "number" || !validateSimulationBudget(budget).valid
      || !Number.isInteger(squad) || squad < 1 || squad > 4
      || ![strategyIndex, trialsIndex, modeIndex, goalIndex].every(Number.isInteger)
      || !strategies[strategyIndex] || !trialCounts[trialsIndex] || !modes[modeIndex] || !goals[goalIndex]
      || !Array.isArray(targets) || targets.length > rotation.items.length) throw new Error("Invalid settings");
    const itemMap = new Map(primeItems.map((item) => [item.id, item]));
    const selectedItemIds = [];
    const owned = {};
    for (const entry of targets) {
      if (!Array.isArray(entry) || entry.length !== 2) throw new Error("Invalid target");
      const [itemId, counts] = entry;
      const item = itemMap.get(itemId);
      if (!safeId(itemId) || !item || !rotation.items.includes(itemId) || selectedItemIds.includes(itemId)
        || !Array.isArray(counts) || counts.length > item.parts.length) throw new Error("Unknown target");
      selectedItemIds.push(itemId);
      owned[itemId] = {};
      for (const pair of counts) {
        if (!Array.isArray(pair) || pair.length !== 2) throw new Error("Invalid count");
        const [partId, count] = pair;
        const part = item.parts.find((candidate) => candidate.id === partId);
        if (!safeId(partId) || !part || Object.hasOwn(owned[itemId], partId)
          || !Number.isInteger(count) || count < 0 || count > required(part)) throw new Error("Invalid part");
        owned[itemId][partId] = count;
      }
    }
    return { status: "ok", plan: { rotationId, selectedItemIds, owned, budget, squad,
      strategy: strategies[strategyIndex], trials: trialCounts[trialsIndex], mode: modes[modeIndex], goal: goals[goalIndex] } };
  } catch {
    return { status: "invalid" };
  }
}

export function planUrl(encoded, locale = "en", origin = "https://varzia.starport1116.com") {
  const url = new URL(`/${locale === "zh" ? "zh" : "en"}/`, origin);
  url.hash = `plan=${encoded}`;
  return url.href;
}

export function planNavigationChanged(oldUrl, newUrl) {
  const before = new URL(oldUrl).hash;
  const after = new URL(newUrl).hash;
  return before !== after && (before.startsWith(PLAN_HASH_PREFIX) || after.startsWith(PLAN_HASH_PREFIX));
}
