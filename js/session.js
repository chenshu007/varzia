// A session is a historical ledger. Version 2 freezes the small validation
// contract needed to replay that ledger, so later catalog/rotation changes
// cannot reinterpret a fissure that was valid when it was recorded.
export const SESSION_SCHEMA_VERSION = 2;
export const LEGACY_SESSION_SCHEMA_VERSION = 1;

export const SESSION_REFINEMENTS = Object.freeze([
  "intact",
  "exceptional",
  "flawless",
  "radiant"
]);

export const SESSION_EVENT_TYPE = "fissure";

export const SESSION_EVENT_ERRORS = Object.freeze({
  invalidSession: "invalidSession",
  invalidEvent: "invalidEvent",
  unknownRelic: "unknownRelic",
  unknownReward: "unknownReward",
  rewardNotFromRelic: "rewardNotFromRelic",
  rewardAlreadyComplete: "rewardAlreadyComplete"
});

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function requiredCount(part) {
  return Math.max(1, Math.floor(Number(part?.required ?? part?.quantity) || 1));
}

function normalizeAyaBudget(value) {
  const budget = Math.floor(Number(value));
  return Number.isFinite(budget) && budget > 0 ? budget : 0;
}

function partKey(itemId, partId) {
  return `${itemId}:${partId}`;
}

function parsePartKey(key) {
  if (!nonEmptyString(key)) return null;
  const separator = key.indexOf(":");
  if (separator <= 0 || separator >= key.length - 1) return null;
  const itemId = key.slice(0, separator);
  const partId = key.slice(separator + 1);
  return nonEmptyString(itemId) && nonEmptyString(partId) ? { itemId, partId } : null;
}

export function normalizeOwnedParts(rawOwned) {
  const owned = {};
  if (!isRecord(rawOwned)) return owned;
  for (const [itemId, rawParts] of Object.entries(rawOwned)) {
    if (!nonEmptyString(itemId) || !isRecord(rawParts)) continue;
    const counts = {};
    for (const [partId, rawCount] of Object.entries(rawParts)) {
      if (!nonEmptyString(partId)) continue;
      const count = Math.floor(Number(rawCount));
      if (Number.isFinite(count) && count > 0) counts[partId] = count;
    }
    if (Object.keys(counts).length) owned[itemId] = counts;
  }
  return owned;
}

function cloneSnapshot(snapshot) {
  return {
    requiredCounts: { ...snapshot.requiredCounts },
    relicRewards: Object.fromEntries(
      Object.entries(snapshot.relicRewards).map(([relicId, rewards]) => [relicId, [...rewards]])
    )
  };
}

/**
 * Validate and canonicalize the frozen v2 ledger contract. The snapshot is
 * deliberately small: part caps and allowed relic→reward edges only.
 */
export function normalizeValidationSnapshot(rawSnapshot) {
  if (!isRecord(rawSnapshot)
    || !isRecord(rawSnapshot.requiredCounts)
    || !isRecord(rawSnapshot.relicRewards)) return null;

  const requiredCounts = {};
  for (const [key, rawRequired] of Object.entries(rawSnapshot.requiredCounts)) {
    if (!parsePartKey(key)
      || typeof rawRequired !== "number"
      || !Number.isInteger(rawRequired)
      || rawRequired < 1) return null;
    requiredCounts[key] = rawRequired;
  }

  const relicRewards = {};
  for (const [relicId, rawRewards] of Object.entries(rawSnapshot.relicRewards)) {
    if (!nonEmptyString(relicId) || !Array.isArray(rawRewards)) return null;
    const rewards = [];
    const seen = new Set();
    for (const key of rawRewards) {
      if (!parsePartKey(key) || !Object.hasOwn(requiredCounts, key)) return null;
      if (!seen.has(key)) {
        seen.add(key);
        rewards.push(key);
      }
    }
    relicRewards[relicId] = rewards;
  }

  return { requiredCounts, relicRewards };
}

function contextFromSnapshot(snapshot) {
  const requiredByKey = new Map(Object.entries(snapshot.requiredCounts));
  const rewardsByRelic = new Map(
    Object.entries(snapshot.relicRewards).map(([relicId, rewards]) => [relicId, new Set(rewards)])
  );
  return {
    validationSnapshot: cloneSnapshot(snapshot),
    hasRelic: (relicId) => rewardsByRelic.has(relicId),
    hasReward: (relicId, itemId, partId) => rewardsByRelic.get(relicId)?.has(partKey(itemId, partId)) ?? false,
    requiredOf: (itemId, partId) => requiredByKey.get(partKey(itemId, partId)) ?? null
  };
}

/** Build a context and a serializable snapshot from a rotation-scoped catalog. */
export function createSessionContext(primeItems, relics, { itemIds, relicIds } = {}) {
  const allowedItems = Array.isArray(itemIds) ? new Set(itemIds) : null;
  const allowedRelics = Array.isArray(relicIds) ? new Set(relicIds) : null;
  const requiredCounts = {};
  for (const item of primeItems || []) {
    if (!isRecord(item) || !nonEmptyString(item.id) || (allowedItems && !allowedItems.has(item.id))) continue;
    for (const part of item.parts || []) {
      if (!isRecord(part) || !nonEmptyString(part.id)) continue;
      requiredCounts[partKey(item.id, part.id)] = requiredCount(part);
    }
  }
  const relicRewards = {};
  for (const relic of relics || []) {
    if (!isRecord(relic) || !nonEmptyString(relic.id) || (allowedRelics && !allowedRelics.has(relic.id))) continue;
    const offered = [];
    const seen = new Set();
    for (const reward of relic.rewards || []) {
      if (!isRecord(reward) || !nonEmptyString(reward.itemId) || !nonEmptyString(reward.partId)) continue;
      const key = partKey(reward.itemId, reward.partId);
      if (Object.hasOwn(requiredCounts, key) && !seen.has(key)) {
        seen.add(key);
        offered.push(key);
      }
    }
    // A real fissure can be logged even when it has no selected-target reward.
    relicRewards[relic.id] = offered;
  }
  return contextFromSnapshot({ requiredCounts, relicRewards });
}

export function createSessionContextFromSnapshot(snapshot) {
  const normalized = normalizeValidationSnapshot(snapshot);
  return normalized ? contextFromSnapshot(normalized) : null;
}

function cloneBaseline(baseline) {
  return {
    selectedItemIds: [...(baseline.selectedItemIds || [])],
    ownedParts: normalizeOwnedParts(baseline.ownedParts),
    ayaBudget: normalizeAyaBudget(baseline.ayaBudget)
  };
}

function normalizeSelectedIds(rawIds) {
  return Array.isArray(rawIds)
    ? [...new Set(rawIds.filter(nonEmptyString))]
    : [];
}

export function createSession({ rotationId, startedAt, selectedItemIds, ownedParts, ayaBudget, validationSnapshot }) {
  if (!nonEmptyString(rotationId)) return null;
  const timestamp = Date.parse(startedAt);
  const snapshot = normalizeValidationSnapshot(validationSnapshot);
  if (!Number.isFinite(timestamp) || !snapshot) return null;
  const context = contextFromSnapshot(snapshot);
  return {
    version: SESSION_SCHEMA_VERSION,
    rotationId,
    startedAt: new Date(timestamp).toISOString(),
    baseline: normalizedBoundedBaseline({ selectedItemIds, ownedParts, ayaBudget }, context),
    validationSnapshot: snapshot,
    events: []
  };
}

function cloneSession(session) {
  return {
    version: session.version,
    rotationId: session.rotationId,
    startedAt: session.startedAt,
    baseline: cloneBaseline(session.baseline),
    validationSnapshot: cloneSnapshot(session.validationSnapshot),
    events: session.events.map((event) => ({
      ...event,
      claimed: event.claimed ? { ...event.claimed } : null
    }))
  };
}

function isValidEventShape(event) {
  if (!isRecord(event)) return false;
  if (event.type !== SESSION_EVENT_TYPE) return false;
  if (!nonEmptyString(event.relicId)) return false;
  if (!SESSION_REFINEMENTS.includes(event.refinement)) return false;
  // Strict ledger contract: ayaCost must be exactly the number 0 or 1.
  if (typeof event.ayaCost !== "number"
    || !Number.isInteger(event.ayaCost)
    || (event.ayaCost !== 0 && event.ayaCost !== 1)) return false;
  if (!Number.isFinite(Date.parse(event.at))) return false;
  if (event.claimed === null || event.claimed === undefined) return true;
  if (!isRecord(event.claimed)) return false;
  return nonEmptyString(event.claimed.itemId) && nonEmptyString(event.claimed.partId);
}

function normalizedEvent(event) {
  return {
    type: SESSION_EVENT_TYPE,
    at: new Date(Date.parse(event.at)).toISOString(),
    relicId: event.relicId,
    refinement: event.refinement,
    ayaCost: event.ayaCost,
    claimed: event.claimed ? { itemId: event.claimed.itemId, partId: event.claimed.partId } : null
  };
}

function sessionContext(session, fallbackContext) {
  if (session?.version === SESSION_SCHEMA_VERSION) {
    return createSessionContextFromSnapshot(session.validationSnapshot);
  }
  return fallbackContext || null;
}

function isAllowedEvent(event, context) {
  if (!isValidEventShape(event) || !context?.hasRelic(event.relicId)) return false;
  if (!event.claimed) return true;
  return Number.isFinite(context.requiredOf(event.claimed.itemId, event.claimed.partId))
    && context.hasReward(event.relicId, event.claimed.itemId, event.claimed.partId);
}

/**
 * Replay baseline + events into the effective collection. Version 2 derives
 * its validation context from the frozen ledger snapshot, never today’s
 * mutable catalog. Passing a context remains only for v1 migration/tests.
 */
export function replaySession(session, fallbackContext) {
  const context = sessionContext(session, fallbackContext);
  const ownedParts = context
    ? normalizedBoundedBaseline(session?.baseline || {}, context).ownedParts
    : normalizeOwnedParts(session?.baseline?.ownedParts);
  let ayaSpent = 0;
  let claims = 0;
  let runs = 0;
  const events = Array.isArray(session?.events) ? session.events : [];
  for (const event of events) {
    if (!isAllowedEvent(event, context)) continue;
    runs += 1;
    ayaSpent += event.ayaCost;
    if (!event.claimed) continue;
    const required = context.requiredOf(event.claimed.itemId, event.claimed.partId);
    const current = ownedParts[event.claimed.itemId]?.[event.claimed.partId] || 0;
    if (current >= required) continue;
    claims += 1;
    const itemCounts = ownedParts[event.claimed.itemId] || {};
    ownedParts[event.claimed.itemId] = { ...itemCounts, [event.claimed.partId]: current + 1 };
  }
  const baseline = session?.baseline || {};
  return {
    selectedItemIds: normalizeSelectedIds(baseline.selectedItemIds),
    ownedParts,
    ayaBudget: Math.max(0, normalizeAyaBudget(baseline.ayaBudget) - ayaSpent),
    runs,
    ayaSpent,
    claims
  };
}

/** Append exactly one atomic fissure event against this ledger’s frozen contract. */
export function appendSessionEvent(session, event, fallbackContext) {
  if (!isRecord(session) || !Array.isArray(session.events)) {
    return { ok: false, error: SESSION_EVENT_ERRORS.invalidSession };
  }
  const context = sessionContext(session, fallbackContext);
  if (!context) return { ok: false, error: SESSION_EVENT_ERRORS.invalidSession };
  if (!isValidEventShape(event)) {
    return { ok: false, error: SESSION_EVENT_ERRORS.invalidEvent };
  }
  if (!context.hasRelic(event.relicId)) {
    return { ok: false, error: SESSION_EVENT_ERRORS.unknownRelic };
  }
  if (event.claimed) {
    const required = context.requiredOf(event.claimed.itemId, event.claimed.partId);
    if (!Number.isFinite(required)) {
      return { ok: false, error: SESSION_EVENT_ERRORS.unknownReward };
    }
    if (!context.hasReward(event.relicId, event.claimed.itemId, event.claimed.partId)) {
      return { ok: false, error: SESSION_EVENT_ERRORS.rewardNotFromRelic };
    }
    const effective = replaySession(session, context);
    const owned = effective.ownedParts[event.claimed.itemId]?.[event.claimed.partId] || 0;
    if (owned >= required) {
      return { ok: false, error: SESSION_EVENT_ERRORS.rewardAlreadyComplete };
    }
  }
  const next = cloneSession(session);
  next.events.push(normalizedEvent(event));
  return { ok: true, session: next };
}

/** Remove the most recent fissure event; returns null when there is none. */
export function undoLastSessionEvent(session) {
  if (!isRecord(session) || !Array.isArray(session.events) || !session.events.length) return null;
  if (session.version === SESSION_SCHEMA_VERSION && !normalizeValidationSnapshot(session.validationSnapshot)) return null;
  const next = cloneSession(session);
  next.events.pop();
  return next;
}

export function deriveSessionSummary(session, { now = Date.now(), context } = {}) {
  const effective = replaySession(session, context);
  const startedAt = Date.parse(session?.startedAt || "");
  return {
    fissures: effective.runs,
    ayaSpent: effective.ayaSpent,
    claims: effective.claims,
    elapsedMs: Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : 0
  };
}

function normalizedBoundedBaseline(rawBaseline, context) {
  const ownedParts = {};
  for (const [itemId, counts] of Object.entries(normalizeOwnedParts(rawBaseline.ownedParts))) {
    for (const [partId, count] of Object.entries(counts)) {
      const required = context.requiredOf(itemId, partId);
      if (!Number.isFinite(required)) continue;
      const itemCounts = ownedParts[itemId] || {};
      itemCounts[partId] = Math.min(count, required);
      ownedParts[itemId] = itemCounts;
    }
  }
  return {
    selectedItemIds: normalizeSelectedIds(rawBaseline.selectedItemIds),
    ownedParts,
    ayaBudget: normalizeAyaBudget(rawBaseline.ayaBudget)
  };
}

function validateWithContext(raw, context, snapshot) {
  if (!context || !snapshot || !nonEmptyString(raw.rotationId) || !Number.isFinite(Date.parse(raw.startedAt))) return null;
  const baseline = raw.baseline;
  if (!isRecord(baseline)
    || !Array.isArray(baseline.selectedItemIds)
    || !isRecord(baseline.ownedParts)
    || !Number.isFinite(Number(baseline.ayaBudget))
    || !Array.isArray(raw.events)) return null;

  const session = {
    version: SESSION_SCHEMA_VERSION,
    rotationId: raw.rotationId,
    startedAt: new Date(Date.parse(raw.startedAt)).toISOString(),
    baseline: normalizedBoundedBaseline(baseline, context),
    validationSnapshot: cloneSnapshot(snapshot),
    events: []
  };
  for (const event of raw.events.slice(0, 10000)) {
    if (isAllowedEvent(event, context)) session.events.push(normalizedEvent(event));
  }
  return session;
}

export function isLegacySessionDocument(raw) {
  return isRecord(raw) && raw.version === LEGACY_SESSION_SCHEMA_VERSION;
}

/**
 * Fail-closed validation of untrusted stored session data. V2 validates and
 * replays against its frozen snapshot. A v1 document may migrate only when a
 * rotation-scoped context can reconstruct that contract; otherwise callers
 * must preserve it unchanged as an unresolved historical ledger.
 */
export function validateSession(raw, legacyContext) {
  if (!isRecord(raw)) return null;
  if (raw.version === SESSION_SCHEMA_VERSION) {
    const snapshot = normalizeValidationSnapshot(raw.validationSnapshot);
    const context = snapshot ? contextFromSnapshot(snapshot) : null;
    return validateWithContext(raw, context, snapshot);
  }
  if (raw.version === LEGACY_SESSION_SCHEMA_VERSION) {
    const snapshot = normalizeValidationSnapshot(legacyContext?.validationSnapshot);
    const context = snapshot ? contextFromSnapshot(snapshot) : null;
    // V1 has no frozen historical contract. A structurally valid event that
    // cannot be checked today might be a catalog-evolution casualty rather
    // than a forged entry, so refuse migration and let the caller preserve
    // the raw ledger for explicit recovery instead of silently dropping it.
    if (Array.isArray(raw.events)
      && raw.events.some((event) => isValidEventShape(event) && !isAllowedEvent(event, context))) return null;
    return validateWithContext(raw, context, snapshot);
  }
  return null;
}
