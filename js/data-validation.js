const VALID_RARITIES = new Set(["common", "uncommon", "rare"]);

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

export function validateRotationData(rotationData, primeData, relicData) {
  const rotation = rotationData?.rotation;
  const primeItems = primeData?.primeItems || [];
  const relics = relicData?.relics || [];

  requireValue(rotation?.id, "Missing rotation id");
  requireValue(Array.isArray(rotation.itemIds), "Missing rotation itemIds");
  requireUnique(rotation.itemIds, "Duplicate rotation itemId");
  requireUnique(primeItems.map((item) => item.id), "Duplicate prime itemId");
  requireUnique(relics.map((relic) => relic.id), "Duplicate relic id");

  const rotationItemIds = new Set(rotation.itemIds);
  const itemMap = new Map(primeItems.map((item) => [item.id, item]));
  const relicMap = new Map(relics.map((relic) => [relic.id, relic]));

  for (const itemId of rotation.itemIds) {
    const item = itemMap.get(itemId);
    requireValue(item, `Missing rotation item: ${itemId}`);
    requireValue(item.rotation === rotation.id, `Rotation mismatch: ${itemId}`);
    requireValue(Array.isArray(item.parts) && item.parts.length > 0, `Missing parts: ${itemId}`);
    requireValue(Array.isArray(item.relics), `Missing item relics: ${itemId}`);
    requireUnique(item.parts.map((part) => part.id), `Duplicate partId in ${itemId}`);

    for (const part of item.parts) {
      const required = Number(part.required ?? part.quantity ?? 1);
      requireValue(Number.isInteger(required) && required > 0, `Invalid required quantity: ${itemId} / ${part.id}`);
      requireValue(VALID_RARITIES.has(part.rarity), `Invalid part rarity: ${itemId} / ${part.id}`);
      requireValue(Array.isArray(part.relics) && part.relics.length > 0, `Missing relic source: ${itemId} / ${part.id}`);
      requireUnique(part.relics, `Duplicate part relic route: ${itemId} / ${part.id}`);

      for (const relicId of part.relics) {
        const relic = relicMap.get(relicId);
        requireValue(relic, `Missing relic: ${relicId} for ${itemId} / ${part.id}`);
        requireValue(item.relics.includes(relicId), `Item relic list mismatch: ${itemId} / ${relicId}`);
        const reward = relic.rewards?.find((entry) => entry.itemId === itemId && entry.partId === part.id);
        requireValue(reward, `Missing reverse reward mapping: ${relicId} / ${itemId} / ${part.id}`);
        requireValue(reward.rarity === part.rarity, `Rarity mismatch: ${relicId} / ${itemId} / ${part.id}`);
      }
    }
  }

  for (const relic of relics) {
    requireValue(relic.rotation === rotation.id, `Relic rotation mismatch: ${relic.id}`);
    requireValue(Array.isArray(relic.rewards), `Missing relic rewards: ${relic.id}`);
    const seenRewards = new Set();
    for (const reward of relic.rewards) {
      const rewardKey = `${reward.itemId}:${reward.partId}`;
      if (seenRewards.has(rewardKey)) {
        throw new Error(`Duplicate relic reward:\n${relic.name || relic.id}\n${reward.itemId} / ${reward.partId}`);
      }
      seenRewards.add(rewardKey);

      requireValue(rotationItemIds.has(reward.itemId), `Reward item is not in rotation: ${relic.id} / ${reward.itemId}`);
      const item = itemMap.get(reward.itemId);
      const part = item?.parts?.find((entry) => entry.id === reward.partId);
      requireValue(part, `Unknown relic reward: ${relic.id} / ${reward.itemId} / ${reward.partId}`);
      requireValue(part.relics.includes(relic.id), `Missing part relic mapping: ${relic.id} / ${reward.itemId} / ${reward.partId}`);
      requireValue(item.relics.includes(relic.id), `Missing item relic mapping: ${relic.id} / ${reward.itemId}`);
      requireValue(reward.rarity === part.rarity, `Rarity mismatch: ${relic.id} / ${reward.itemId} / ${reward.partId}`);
    }
  }

  return true;
}
