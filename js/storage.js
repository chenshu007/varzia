export const STORAGE_KEY = "varzia.collection.v1";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredCount(part) {
  return Math.max(1, Math.floor(Number(part.required || part.quantity || 1)));
}

function defaultState(primeItems) {
  return { selectedItemIds: primeItems.map((item) => item.id), owned: {} };
}

function normalizeOwned(rawOwned, itemMap) {
  const owned = {};
  if (!isRecord(rawOwned)) return owned;

  for (const [itemId, rawParts] of Object.entries(rawOwned)) {
    const item = itemMap.get(itemId);
    if (!item) continue;
    const partMap = new Map(item.parts.map((part) => [part.id, part]));
    const counts = {};

    // V1 stored completed part ids as an array. Treat each migrated entry as
    // owning the full crafting requirement, including duplicated weapon parts.
    if (Array.isArray(rawParts)) {
      for (const partId of rawParts) {
        const part = partMap.get(partId);
        if (part) counts[partId] = requiredCount(part);
      }
    } else if (isRecord(rawParts)) {
      for (const [partId, rawCount] of Object.entries(rawParts)) {
        const part = partMap.get(partId);
        if (!part) continue;
        counts[partId] = Math.max(0, Math.min(requiredCount(part), Math.floor(Number(rawCount) || 0)));
      }
    }

    if (Object.keys(counts).length) owned[itemId] = counts;
  }
  return owned;
}

export function loadCollectionState(storage, primeItems, rotationId = "") {
  const fallback = defaultState(primeItems);
  if (!storage || typeof storage.getItem !== "function") return fallback;
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) || "null");
    if (!isRecord(parsed)) return fallback;
    const itemMap = new Map(primeItems.map((item) => [item.id, item]));
    const hasCurrentSelection = Array.isArray(parsed.selectedItemIds);
    const filteredSelection = hasCurrentSelection
      ? parsed.selectedItemIds.filter((id) => itemMap.has(id))
      : fallback.selectedItemIds;
    const sameRotation = Boolean(rotationId) && parsed.rotationId === rotationId;
    const selectedItemIds = !hasCurrentSelection
      ? fallback.selectedItemIds
      : sameRotation || !rotationId || filteredSelection.length
        ? filteredSelection
        : fallback.selectedItemIds;
    return {
      selectedItemIds,
      owned: normalizeOwned(parsed.owned, itemMap)
    };
  } catch {
    return fallback;
  }
}

export function saveCollectionState(storage, state) {
  if (!storage || typeof storage.setItem !== "function") return false;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({
      schemaVersion: 2,
      rotationId: typeof state.rotationId === "string" ? state.rotationId : "",
      selectedItemIds: Array.isArray(state.selectedItemIds) ? state.selectedItemIds : [],
      owned: isRecord(state.owned) ? state.owned : {}
    }));
    return true;
  } catch {
    return false;
  }
}
