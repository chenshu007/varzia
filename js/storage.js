export const STORAGE_KEY = "varzia.collection.v1";
export const STORAGE_SCHEMA_VERSION = 4;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readStoredDocument(storage) {
  try {
    const raw = storage?.getItem?.(STORAGE_KEY);
    if (raw === null || raw === undefined || raw === "") {
      return { root: {}, locked: false };
    }
    const parsed = JSON.parse(raw);
    // A non-object document has no safe legacy migration path. Keep its raw
    // bytes intact rather than treating it like an absent document.
    if (!isRecord(parsed)) return { root: {}, locked: true };
    return { root: parsed, locked: isUnsupportedSchemaRoot(parsed) };
  } catch {
    // Invalid JSON is not an absent legacy document. A write here would
    // destroy bytes that may be recoverable by a newer implementation.
    return { root: {}, locked: true };
  }
}

/**
 * A schema version is authoritative only when it is absent (legacy) or a
 * supported integer. Any explicit but malformed/unknown version locks the
 * document read-only: treating "4", 4.5, null, or a future value as legacy
 * would silently rewrite and downgrade user data.
 */
function isUnsupportedSchemaRoot(root) {
  if (!Object.prototype.hasOwnProperty.call(root, "schemaVersion")) return false;
  const version = root.schemaVersion;
  return typeof version !== "number"
    || !Number.isInteger(version)
    || version < 1
    || version > STORAGE_SCHEMA_VERSION;
}

export function hasFutureSchemaDocument(storage) {
  if (!storage || typeof storage.getItem !== "function") return false;
  return readStoredDocument(storage).locked;
}

function writeStoredRoot(storage, root) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ ...root, schemaVersion: STORAGE_SCHEMA_VERSION }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Raw active-session value, or null when absent/unreadable/locked by a newer
 * schema. Validation against the catalogs happens in the session layer.
 */
export function readActiveSession(storage) {
  if (!storage || typeof storage.getItem !== "function") return null;
  const { root, locked } = readStoredDocument(storage);
  if (locked) return null;
  return isRecord(root.activeSession) ? root.activeSession : null;
}

/**
 * Persisted collection ownership for merge-style commits; null when absent,
 * unreadable, or locked by a newer schema.
 */
export function readStoredOwnedParts(storage) {
  if (!storage || typeof storage.getItem !== "function") return null;
  const { root, locked } = readStoredDocument(storage);
  if (locked) return null;
  const owned = root.ownedParts ?? root.owned;
  return isRecord(owned) ? owned : null;
}

/**
 * Persist or clear the active session without touching collection fields.
 * Passing null removes the session (finish/cancel), never the collection.
 * Refuses to write when a newer schema document is stored.
 */
export function saveActiveSession(storage, session) {
  if (!storage || typeof storage.setItem !== "function") return false;
  const { root, locked } = readStoredDocument(storage);
  if (locked) return false;
  if (session === null || session === undefined) delete root.activeSession;
  else if (!isRecord(session)) return false;
  else root.activeSession = session;
  return writeStoredRoot(storage, root);
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
    const { root: parsed, locked } = readStoredDocument(storage);
    // A malformed, unknown, or newer document is read only as safe runtime
    // defaults; its raw bytes stay untouched and no migration is attempted.
    if (locked) return fallbackState(activeItemIds, config.defaultAyaBudget);

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

    // Preserve any concurrently stored active session; only collection
    // fields are owned by this write path. A newer schema document is never
    // rewritten.
    const { root, locked } = readStoredDocument(storage);
    if (locked) return false;
    const next = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      selectionRotationId: rotationId,
      selectedPrimeIds,
      ownedParts,
      inputRotationId: rotationId,
      ayaBudget
    };
    if (root.activeSession !== undefined) next.activeSession = root.activeSession;

    storage.setItem(STORAGE_KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

/**
 * Reconcile collection ownership without taking authority over planner fields.
 * Suspended historical sessions use this path: current rotation, selection,
 * and Aya input remain exactly the document owner’s values.
 */
export function saveOwnedParts(storage, ownedParts) {
  if (!storage || typeof storage.setItem !== "function" || !isRecord(ownedParts)) return false;
  const { root, locked } = readStoredDocument(storage);
  if (locked) return false;
  return writeStoredRoot(storage, { ...root, ownedParts });
}
