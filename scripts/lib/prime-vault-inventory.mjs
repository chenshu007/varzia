export const WORLD_STATE_URL = "https://api.warframe.com/cdn/worldState.php";

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function timestamp(value, label) {
  const raw = value?.$date?.$numberLong;
  requireValue(typeof raw === "string" && /^\d+$/.test(raw), `Invalid World State ${label}.`);
  const number = Number(raw);
  requireValue(Number.isSafeInteger(number) && number % 1000 === 0 && number <= 8.64e15, `Invalid World State ${label}.`);
  return new Date(number).toISOString().replace(".000Z", "Z");
}

export function canonicalItemPath(value) {
  requireValue(typeof value === "string" && value.startsWith("/Lotus/"), "Invalid Public Export item path.");
  return value.replace(/^\/Lotus\/StoreItems\//, "/Lotus/");
}

export function parsePrimeVaultTrader(payload, now) {
  const traders = payload?.PrimeVaultTraders;
  requireValue(Array.isArray(traders) && traders.length === 1, "Expected exactly one Prime Vault trader.");
  const trader = traders[0];
  const startsAt = timestamp(trader.Activation, "Activation");
  const endsAt = timestamp(trader.Expiry, "Expiry");
  requireValue(Date.parse(startsAt) < Date.parse(endsAt), "World State trader interval is invalid.");
  requireValue(Array.isArray(trader.Manifest) && trader.Manifest.length > 0, "Prime Vault Manifest is missing.");
  const seen = new Set();
  for (const entry of trader.Manifest) {
    const id = canonicalItemPath(entry.ItemType);
    requireValue(!seen.has(id), `Duplicate Prime Vault Manifest item: ${id}.`);
    seen.add(id);
  }
  const current = Date.parse(now);
  requireValue(Number.isFinite(current), "Invalid World State observation time.");
  return { startsAt, endsAt, manifest: trader.Manifest, active: Date.parse(startsAt) <= current && current < Date.parse(endsAt) };
}

function indexed(records, label, selectedIds) {
  requireValue(Array.isArray(records) && records.length > 0, `Missing ${label} records.`);
  const result = new Map();
  for (const record of records) {
    // Equipment exports overlap for some unrelated Archwing items. Ambiguity
    // matters for the IDs actually present in this trader's manifest.
    if (!selectedIds.has(record?.uniqueName)) continue;
    const id = canonicalItemPath(record.uniqueName);
    requireValue(!result.has(id), `Duplicate ${label} item: ${id}.`);
    result.set(id, record);
  }
  return result;
}

export function lineupFromInventory(trader, { equipmentEn, equipmentZh, relicExport, exportUrls }) {
  const selectedIds = new Set(trader.manifest.map(entry => canonicalItemPath(entry.ItemType)));
  const english = indexed(equipmentEn, "English equipment export", selectedIds);
  const chinese = indexed(equipmentZh, "Chinese equipment export", selectedIds);
  const relics = indexed(relicExport, "relic export", selectedIds);
  const typeByCategory = { Suits: "warframe", LongGuns: "primary", Pistols: "secondary", Melee: "melee", Sentinels: "companion" };
  const items = [];
  const inventoryRelics = [];
  for (const entry of trader.manifest) {
    const id = canonicalItemPath(entry.ItemType);
    if (id.startsWith("/Lotus/Types/Game/Projections/")) {
      requireValue(entry.RegularPrice === 1 && entry.PrimePrice === undefined, `Unsupported Aya price for ${id}.`);
      const relic = relics.get(id);
      requireValue(relic && /Bronze$/.test(id) && /^(Lith|Meso|Neo|Axi) [A-Z]\d+ Relic$/.test(relic.name), `Missing or unsupported Intact relic export: ${id}.`);
      requireValue(Array.isArray(relic.relicRewards) && relic.relicRewards.length === 6, `Incomplete relic export rewards: ${id}.`);
      const rarities = relic.relicRewards.map(reward => reward.rarity).sort();
      requireValue(JSON.stringify(rarities) === JSON.stringify(["COMMON", "COMMON", "COMMON", "RARE", "UNCOMMON", "UNCOMMON"]), `Invalid relic export rarity slots: ${id}.`);
      inventoryRelics.push({ itemType: entry.ItemType, name: relic.name.replace(/ Relic$/, ""), costAya: entry.RegularPrice });
    } else if (/^\/Lotus\/(Powersuits\/|Weapons\/|Types\/Sentinels\/SentinelPowersuits\/)/.test(id)) {
      const item = english.get(id);
      const localized = chinese.get(id);
      requireValue(item && localized?.name && item.name?.endsWith(" Prime") && typeByCategory[item.productCategory], `Missing or unsupported Prime equipment export: ${id}.`);
      requireValue(Number.isSafeInteger(entry.PrimePrice) && entry.PrimePrice > 0, `Invalid Prime equipment price: ${id}.`);
      items.push({ name: item.name, chineseName: localized.name, type: typeByCategory[item.productCategory], uniqueName: id });
    }
  }
  requireValue(items.filter(item => item.type === "warframe").length === 2, "Inventory must identify exactly two Prime Warframes.");
  requireValue(new Set(items.map(item => item.name)).size === items.length, "Duplicate Prime equipment name.");
  requireValue(inventoryRelics.length > 0 && new Set(inventoryRelics.map(relic => relic.name)).size === inventoryRelics.length, "Missing or duplicate inventory relic names.");
  return {
    items,
    warframes: items.filter(item => item.type === "warframe"),
    startsAt: trader.startsAt,
    inventoryRelics,
    inventoryEvidence: { type: "digital-extremes-world-state", url: WORLD_STATE_URL, startsAt: trader.startsAt, endsAt: trader.endsAt, relics: inventoryRelics, exportUrls }
  };
}
