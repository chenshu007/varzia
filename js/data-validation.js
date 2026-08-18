const VALID_RARITIES = new Set(["common", "uncommon", "rare"]);
const SUPPORTED_ROTATION_SCHEMA = 2;
const ISO_UTC_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function requireUnique(values, label) {
  const seen = new Set();
  for (const value of values) {
    requireValue(!seen.has(value), `${label}: ${value}`);
    seen.add(value);
  }
}

function isExactUtcTimestamp(value) {
  if (typeof value !== "string" || !ISO_UTC_SECONDS.test(value)) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  return new Date(timestamp).toISOString() === value.replace(/Z$/, ".000Z");
}

export function validateRotationData(rotationData, primeData, relicData) {
  const rotations = rotationData?.rotations;
  const primeItems = primeData?.primeItems;
  const relics = relicData?.relics;

  requireValue(rotationData?.schemaVersion === SUPPORTED_ROTATION_SCHEMA, `Unsupported rotation schemaVersion: ${rotationData?.schemaVersion ?? "missing"}`);
  requireValue(Array.isArray(rotations), "Missing rotations array");
  requireValue(Array.isArray(primeItems), "Missing primeItems array");
  requireValue(Array.isArray(relics), "Missing relics array");
  requireUnique(rotations.map((rotation) => rotation?.id), "Duplicate rotation id");
  requireUnique(rotations.map((rotation) => rotation?.startsAt), "Duplicate rotation startsAt");
  requireUnique(primeItems.map((item) => item?.id), "Duplicate prime itemId");
  requireUnique(relics.map((relic) => relic?.id), "Duplicate relic id");

  let previousStartsAt = -Infinity;
  for (const rotation of rotations) {
    requireValue(typeof rotation?.id === "string" && rotation.id.length > 0, "Missing rotation id");
    requireValue(isExactUtcTimestamp(rotation.startsAt), `Invalid rotation startsAt: ${rotation?.startsAt ?? "missing"}`);
    const startsAt = Date.parse(rotation.startsAt);
    requireValue(startsAt > previousStartsAt, `Rotations must be strictly chronological: ${rotation.id}`);
    previousStartsAt = startsAt;
    requireValue(Array.isArray(rotation.items), `Missing rotation items: ${rotation.id}`);
    requireValue(Array.isArray(rotation.relics), `Missing rotation relics: ${rotation.id}`);
    requireValue(rotation.items.length > 0, `Rotation ${rotation.id} must contain at least one item.`);
    requireValue(rotation.relics.length > 0, `Rotation ${rotation.id} must contain at least one relic.`);
    requireUnique(rotation.items, `Duplicate rotation item: ${rotation.id}`);
    requireUnique(rotation.relics, `Duplicate rotation relic: ${rotation.id}`);
    if (rotation.defaults?.ayaBudget !== undefined) {
      requireValue(
        Number.isInteger(rotation.defaults.ayaBudget) && rotation.defaults.ayaBudget >= 0,
        `Invalid default ayaBudget: ${rotation.id}`
      );
    }
  }

  const itemMap = new Map(primeItems.map((item) => [item.id, item]));
  const relicMap = new Map(relics.map((relic) => [relic.id, relic]));

  for (const item of primeItems) {
    requireValue(typeof item?.id === "string" && item.id.length > 0, "Missing prime item id");
    requireValue(Array.isArray(item.parts) && item.parts.length > 0, `Missing parts: ${item.id}`);
    requireValue(Array.isArray(item.relics), `Missing item relics: ${item.id}`);
    requireUnique(item.parts.map((part) => part?.id), `Duplicate partId in ${item.id}`);

    for (const part of item.parts) {
      const required = Number(part.required ?? part.quantity ?? 1);
      requireValue(Number.isInteger(required) && required > 0, `Invalid required quantity: ${item.id} / ${part.id}`);
      requireValue(VALID_RARITIES.has(part.rarity), `Invalid part rarity: ${item.id} / ${part.id}`);
      requireValue(Array.isArray(part.relics) && part.relics.length > 0, `Missing relic source: ${item.id} / ${part.id}`);
      requireUnique(part.relics, `Duplicate part relic route: ${item.id} / ${part.id}`);

      for (const relicId of part.relics) {
        const relic = relicMap.get(relicId);
        requireValue(relic, `Missing relic: ${relicId} for ${item.id} / ${part.id}`);
        requireValue(item.relics.includes(relicId), `Item relic list mismatch: ${item.id} / ${relicId}`);
        const reward = relic.rewards?.find((entry) => entry.itemId === item.id && entry.partId === part.id);
        requireValue(reward, `Missing reverse reward mapping: ${relicId} / ${item.id} / ${part.id}`);
        requireValue(reward.rarity === part.rarity, `Rarity mismatch: ${relicId} / ${item.id} / ${part.id}`);
      }
    }
  }

  for (const relic of relics) {
    requireValue(typeof relic?.id === "string" && relic.id.length > 0, "Missing relic id");
    requireValue(Array.isArray(relic.rewards), `Missing relic rewards: ${relic.id}`);
    const seenRewards = new Set();
    for (const reward of relic.rewards) {
      const rewardKey = `${reward.itemId}:${reward.partId}`;
      requireValue(!seenRewards.has(rewardKey), `Duplicate relic reward:\n${relic.name || relic.id}\n${reward.itemId} / ${reward.partId}`);
      seenRewards.add(rewardKey);
      const item = itemMap.get(reward.itemId);
      requireValue(item, `Unknown relic reward item: ${relic.id} / ${reward.itemId}`);
      const part = item.parts.find((entry) => entry.id === reward.partId);
      requireValue(part, `Unknown relic reward: ${relic.id} / ${reward.itemId} / ${reward.partId}`);
      requireValue(part.relics.includes(relic.id), `Missing part relic mapping: ${relic.id} / ${reward.itemId} / ${reward.partId}`);
      requireValue(item.relics.includes(relic.id), `Missing item relic mapping: ${relic.id} / ${reward.itemId}`);
      requireValue(reward.rarity === part.rarity, `Rarity mismatch: ${relic.id} / ${reward.itemId} / ${reward.partId}`);
    }
  }

  for (const rotation of rotations) {
    const rotationItemIds = new Set(rotation.items);
    const rotationRelicIds = new Set(rotation.relics);

    for (const itemId of rotation.items) {
      const item = itemMap.get(itemId);
      requireValue(item, `Missing rotation item: ${rotation.id} / ${itemId}`);
      for (const part of item.parts) {
        const currentRoutes = part.relics.filter((relicId) => rotationRelicIds.has(relicId));
        requireValue(currentRoutes.length > 0, `Missing rotation relic source: ${rotation.id} / ${itemId} / ${part.id}`);
      }
    }

    for (const relicId of rotation.relics) {
      const relic = relicMap.get(relicId);
      requireValue(relic, `Missing rotation relic: ${rotation.id} / ${relicId}`);
      for (const reward of relic.rewards) {
        requireValue(rotationItemIds.has(reward.itemId), `Reward item is not in rotation: ${rotation.id} / ${relic.id} / ${reward.itemId}`);
      }
    }
  }

  return true;
}
