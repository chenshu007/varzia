// Collection adapters shared by the planner and session UI. No persistence or DOM access.
export function requiredCount(part) {
  return Math.max(1, Math.floor(Number(part.required || part.quantity || 1)));
}

export function isSafeOwnedKey(value) {
  return typeof value === "string" && !["__proto__", "constructor", "prototype"].includes(value);
}

export function ownedCountIn(owned, itemId, partId) {
  if (!isSafeOwnedKey(itemId) || !isSafeOwnedKey(partId)) return 0;
  const parts = owned?.[itemId];
  if (!parts) return 0;
  const count = parts instanceof Map ? parts.get(partId) : parts[partId];
  return Math.max(0, Number(count) || 0);
}

export function ownedMapsFromPlain(plain) {
  return Object.fromEntries(Object.entries(plain || {})
    .filter(([itemId, partCounts]) => isSafeOwnedKey(itemId) && partCounts && typeof partCounts === "object" && !Array.isArray(partCounts))
    .map(([itemId, partCounts]) => [
      itemId,
      new Map(Object.entries(partCounts)
        .filter(([partId]) => isSafeOwnedKey(partId))
        .map(([partId, count]) => [partId, Number(count) || 0]))
    ]));
}

export function injectOwnedCounts(primeItems, owned) {
  return (primeItems || []).map((item) => ({
    ...item,
    parts: (item.parts || []).map((part) => ({
      ...part,
      ownedCount: Math.min(requiredCount(part), ownedCountIn(owned, item.id, part.id))
    }))
  }));
}

export function ownershipChangesSimulationInput({ primeItems, selectedItemIds, previousOwned, nextOwned }) {
  const selected = new Set(selectedItemIds || []);
  return (primeItems || []).some((item) => selected.has(item.id) && item.parts.some((part) => {
    const required = requiredCount(part);
    return Math.min(required, ownedCountIn(previousOwned, item.id, part.id))
      !== Math.min(required, ownedCountIn(nextOwned, item.id, part.id));
  }));
}

export function ownedPlainObject(owned) {
  return Object.fromEntries(Object.entries(owned).map(([itemId, parts]) => [
    itemId,
    Object.fromEntries([...parts].filter(([, count]) => count > 0))
  ]));
}
