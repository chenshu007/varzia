export const STORAGE_KEY = "varzia.collection.v1";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredCount(part) {
  return Math.max(1, Math.floor(Number(part.required || part.quantity || 1)));
}

function normalizeOptions(primeItems, options) {
  if (typeof options === "string") {
    return {
      rotationId: options,
      activeItemIds: primeItems.map((item) => item.id),
      defaultAyaBudget: 0,
      preview: false
    };
  }
  return {
    rotationId: typeof options?.rotationId === "string" ? options.rotationId : "",
    activeItemIds: Array.isArray(options?.activeItemIds) ? options.activeItemIds : primeItems.map((item) => item.id),
    defaultAyaBudget: Math.max(0, Math.floor(Number(options?.defaultAyaBudget) || 0)),
    preview: Boolean(options?.preview)
  };
}

function normalizeOwned(rawOwned, itemMap) {
  const owned = {};
  if (!isRecord(rawOwned)) return owned;

  for (const [itemId, rawParts] of Object.entries(rawOwned)) {
    const item = itemMap.get(itemId);
    if (!item) continue;
    const partMap = new Map(item.parts.map((part) => [part.id, part]));
    const counts = {};

    // V1 stored completed part ids as an array. Each migrated entry represents
    // the complete crafting requirement, including duplicated weapon parts.
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

    if (Object.values(counts).some((count) => count > 0)) owned[itemId] = counts;
  }
  return owned;
}

function fallbackState(activeItemIds, defaultAyaBudget, owned = {}) {
  return {
    selectedItemIds: [...activeItemIds],
    owned,
    ayaBudget: defaultAyaBudget
  };
}

export function loadCollectionState(storage, primeItems, options = {}) {
  const config = normalizeOptions(primeItems, options);
  const itemMap = new Map(primeItems.map((item) => [item.id, item]));
  const activeItemIds = config.activeItemIds.filter((id) => itemMap.has(id));
  const activeItemSet = new Set(activeItemIds);
  if (!storage || typeof storage.getItem !== "function") {
    return fallbackState(activeItemIds, config.defaultAyaBudget);
  }

  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) || "null");
    if (!isRecord(parsed)) return fallbackState(activeItemIds, config.defaultAyaBudget);

    const owned = normalizeOwned(parsed.ownedParts ?? parsed.owned, itemMap);
    if (config.preview) return fallbackState(activeItemIds, config.defaultAyaBudget, owned);

    const storedSelection = Array.isArray(parsed.selectedPrimeIds)
      ? parsed.selectedPrimeIds
      : Array.isArray(parsed.selectedItemIds)
        ? parsed.selectedItemIds
        : Array.isArray(parsed.selectedTargetIds)
          ? parsed.selectedTargetIds
          : null;
    const storedRotationId = typeof parsed.selectionRotationId === "string"
      ? parsed.selectionRotationId
      : typeof parsed.rotationId === "string"
        ? parsed.rotationId
        : "";
    const filteredSelection = storedSelection?.filter((id) => activeItemSet.has(id)) || [];
    let selectedItemIds = activeItemIds;

    if (storedSelection && storedRotationId && storedRotationId === config.rotationId) {
      // An empty list for the current rotation is an explicit user choice.
      selectedItemIds = filteredSelection;
    } else if (storedSelection && !storedRotationId && filteredSelection.length > 0) {
      // Legacy state without a rotation id can only be migrated when it still
      // contains an unambiguous valid target.
      selectedItemIds = filteredSelection;
    }

    const storedAyaBudget = Number(parsed.ayaBudget);
    const sameInputRotation = typeof parsed.inputRotationId === "string"
      && parsed.inputRotationId === config.rotationId;
    const ayaBudget = sameInputRotation && Number.isInteger(storedAyaBudget) && storedAyaBudget >= 0
      ? storedAyaBudget
      : config.defaultAyaBudget;

    return { selectedItemIds, owned, ayaBudget };
  } catch {
    return fallbackState(activeItemIds, config.defaultAyaBudget);
  }
}

export function saveCollectionState(storage, state) {
  if (!storage || typeof storage.setItem !== "function") return false;
  try {
    const rotationId = typeof state.selectionRotationId === "string"
      ? state.selectionRotationId
      : typeof state.rotationId === "string"
        ? state.rotationId
        : "";
    const selectedPrimeIds = Array.isArray(state.selectedPrimeIds)
      ? state.selectedPrimeIds
      : Array.isArray(state.selectedItemIds)
        ? state.selectedItemIds
        : [];
    const ownedParts = isRecord(state.ownedParts)
      ? state.ownedParts
      : isRecord(state.owned)
        ? state.owned
        : {};
    const ayaBudget = Math.max(0, Math.floor(Number(state.ayaBudget) || 0));

    storage.setItem(STORAGE_KEY, JSON.stringify({
      schemaVersion: 3,
      selectionRotationId: rotationId,
      selectedPrimeIds,
      ownedParts,
      inputRotationId: rotationId,
      ayaBudget
    }));
    return true;
  } catch {
    return false;
  }
}
