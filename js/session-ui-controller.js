import {
  appendSessionEvent,
  createSession,
  createSessionContext,
  deriveSessionSummary,
  isLegacySessionDocument,
  replaySession,
  undoLastSessionEvent,
  validateSession
} from "./session.js";
import {
  readActiveSession,
  readStoredOwnedParts,
  saveActiveSession,
  saveCollectionState,
  saveOwnedParts
} from "./storage.js";
import { rankRelicsForMissing } from "./simulator.js";
import { formatProbabilityPrecise } from "./presentation.js";
import { calculateGraduationRecap, formatRecapPercent } from "./wave1.js";
import {
  injectOwnedCounts,
  isSafeOwnedKey,
  ownedMapsFromPlain,
  ownedPlainObject,
  ownershipChangesSimulationInput,
  requiredCount
} from "./planner-ownership.js";

/**
 * Commit session gains exactly once. The final collection is derived from
 * baseline + replay, merged (max per part) with the currently persisted
 * global collection, then written as absolute replacement values. Repeated
 * or interrupted commits therefore can never double-apply rewards.
 *
 * Finish is only complete when the collection write AND the session clear
 * both succeed; each step reports its outcome separately so recovery stays
 * actionable and idempotent.
 */
export function commitSessionGains(session, { storage, context } = {}) {
  const final = replaySession(session, context);
  const persistedOwned = readStoredOwnedParts(storage);
  if (persistedOwned) {
    const merged = normalizeMergedOwned(final.ownedParts, persistedOwned, session);
    final.ownedParts = merged;
  }
  const committed = saveCollectionState(storage, {
    rotationId: session.rotationId,
    selectedItemIds: final.selectedItemIds,
    owned: final.ownedParts,
    ayaBudget: final.ayaBudget
  });
  if (!committed) return { committed: false, cleared: false, final };
  // Clear only after the collection write succeeds; an interrupted finish
  // leaves the session resumable and replaying it again lands on identical
  // absolute values.
  const cleared = saveActiveSession(storage, null);
  return { committed: true, cleared, final };
}

/**
 * Resolve an old suspended ledger without taking authority over the current
 * planner. Only ownership is reconciled; rotation, selected targets, Aya,
 * and all other current-root fields are deliberately left untouched.
 */
export function commitSuspendedSessionGains(session, { storage, context } = {}) {
  const final = replaySession(session, context);
  const persistedOwned = readStoredOwnedParts(storage) || {};
  final.ownedParts = normalizeMergedOwned(final.ownedParts, persistedOwned, session);
  const committed = saveOwnedParts(storage, final.ownedParts);
  if (!committed) return { committed: false, cleared: false, final };
  const cleared = saveActiveSession(storage, null);
  return { committed: true, cleared, final };
}

/**
 * Merge progress maps by keeping the higher count per part. Frozen ledger
 * keys are capped by their historical requirements; unrelated global keys
 * are merely preserved, so suspended reconciliation cannot double-count.
 */
function normalizeMergedOwned(primary, secondary, session) {
  const frozenContext = session?.version ? replayContextForMerge(session) : null;
  const merged = {};
  const keys = new Set([...Object.keys(primary || {}), ...Object.keys(secondary || {})]);
  for (const itemId of keys) {
    if (!isSafeOwnedKey(itemId)) continue;
    const partKeys = new Set([
      ...Object.keys(primary?.[itemId] || {}),
      ...Object.keys(secondary?.[itemId] || {})
    ]);
    const counts = {};
    for (const partId of partKeys) {
      if (!isSafeOwnedKey(partId)) continue;
      const uncapped = Math.max(
        Number(primary?.[itemId]?.[partId]) || 0,
        Number(secondary?.[itemId]?.[partId]) || 0
      );
      const required = frozenContext?.requiredOf(itemId, partId);
      const count = Number.isFinite(required) ? Math.min(uncapped, required) : uncapped;
      if (count > 0) counts[partId] = count;
    }
    if (Object.keys(counts).length) merged[itemId] = counts;
  }
  return merged;
}

function replayContextForMerge(session) {
  // replaySession has already derived the historical state from this v2
  // snapshot. Reconstructing the same context here caps only keys the ledger
  // owns, while leaving unrelated global collection keys untouched.
  const snapshot = session?.validationSnapshot;
  if (!snapshot) return null;
  const requiredCounts = snapshot.requiredCounts || {};
  return {
    requiredOf(itemId, partId) {
      const count = requiredCounts[`${itemId}:${partId}`];
      return typeof count === "number" && Number.isInteger(count) && count > 0 ? count : null;
    }
  };
}

/** Persist first; only a durable candidate may become live app state. */
export function persistSessionCandidate(previousSession, candidateSession, { storage } = {}) {
  if (!candidateSession || !saveActiveSession(storage, candidateSession)) {
    return { ok: false, session: previousSession };
  }
  return { ok: true, session: candidateSession };
}

/** Graduation/luck language is meaningful only once the session targets are done. */
export function shouldShowSessionGraduationRecap({ selectedItemIds, missingTargets, ayaSpent, curve }) {
  return Array.isArray(selectedItemIds)
    && selectedItemIds.length > 0
    && Array.isArray(missingTargets)
    && missingTargets.length === 0
    && Number(ayaSpent) > 0
    && Boolean(curve);
}

/**
 * Own the live-session UI lifecycle. Domain validation and replay stay in
 * session.js; planner changes cross only the applyPlannerState bridge.
 * getPlannerState supplies the catalog, rotation and selected planner inputs,
 * never a mutable reference to the app's full state.
 */
export function createSessionUIController({
  getPlannerState,
  applyPlannerState,
  $,
  message,
  format,
  escapeHtml,
  getStorage,
  renderItemOptions,
  renderCollections,
  scheduleRun,
  setStatus,
  now = () => Date.now(),
  setInterval = (...args) => window.setInterval(...args),
  clearInterval = (...args) => window.clearInterval(...args),
  requestAnimationFrame = (...args) => window.requestAnimationFrame(...args)
}) {
  let activeSession = null;
  let suspendedSession = null;
  let unresolvedSession = null;
  let sessionTicker = null;

  function itemById(itemId) {
    return getPlannerState().primeItems.find((item) => item.id === itemId);
  }

  function currentPrimeItems() {
    const planner = getPlannerState();
    const selectedItems = planner.selectedItemIds.map(itemById).filter(Boolean);
    return injectOwnedCounts(selectedItems, planner.owned);
  }

  function allSessionContext() {
    const planner = getPlannerState();
    return createSessionContext(planner.allPrimeItems, planner.allRelics);
  }

  /**
   * Freeze only the historical contract this rotation needs: its claimable
   * parts/relics plus requirement caps for any collection state in the
   * baseline. The latter keeps unrelated already-owned parts intact on replay
   * without granting the session authority over other-rotation relics.
   */
  function sessionContextForRotation(rotation, baselineOwned = {}) {
    const planner = getPlannerState();
    if (!rotation) return null;
    const itemIds = [...new Set([
      ...(Array.isArray(rotation.items) ? rotation.items : []),
      ...Object.keys(baselineOwned || {})
    ])];
    return createSessionContext(planner.allPrimeItems, planner.allRelics, {
      itemIds,
      relicIds: Array.isArray(rotation.relics) ? rotation.relics : []
    });
  }

  function sessionContextForStoredLedger(raw) {
    const planner = getPlannerState();
    const rotationId = typeof raw?.rotationId === "string" ? raw.rotationId : "";
    const historicalRotation = planner.rotations.find((candidate) => candidate.id === rotationId);
    return sessionContextForRotation(historicalRotation, raw?.baseline?.ownedParts);
  }

  function stopSessionTicker() {
    if (sessionTicker) {
      clearInterval(sessionTicker);
      sessionTicker = null;
    }
  }

  function startSessionTicker() {
    stopSessionTicker();
    sessionTicker = setInterval(() => {
      if (!activeSession) {
        stopSessionTicker();
        return;
      }
      updateSessionElapsed();
    }, 30_000);
  }

  function formatSessionElapsed(elapsedMs) {
    const totalMinutes = Math.floor(Math.max(0, elapsedMs) / 60_000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return hours ? message("session.elapsed.hm", { h: hours, m: minutes }) : message("session.elapsed.m", { m: minutes });
  }

  function updateSessionElapsed() {
    const element = $("sessionElapsed");
    if (!element || !activeSession) return;
    const summary = deriveSessionSummary(activeSession, { now: now(), context: allSessionContext() });
    element.textContent = formatSessionElapsed(summary.elapsedMs);
  }

  function announceSession(text) {
    const announcement = $("sessionAnnouncement");
    if (!announcement) return;
    announcement.textContent = "";
    requestAnimationFrame(() => {
      announcement.textContent = text;
    });
  }

  function setBudgetInputEnabled(enabled) {
    const input = $("budget");
    if (input) input.disabled = !enabled;
  }

  function startLiveSession() {
    const planner = getPlannerState();
    if (!planner.rotation || planner.previewMode || activeSession || suspendedSession || unresolvedSession) return;
    const baselineOwned = ownedPlainObject(planner.owned);
    const frozenContext = sessionContextForRotation(planner.rotation, baselineOwned);
    const session = createSession({
      rotationId: planner.rotation.id,
      startedAt: new Date(now()).toISOString(),
      selectedItemIds: planner.selectedItemIds,
      ownedParts: baselineOwned,
      ayaBudget: Number($("budget").value) || 0,
      validationSnapshot: frozenContext?.validationSnapshot
    });
    if (!session) return;
    if (!saveActiveSession(getStorage(), session)) {
      setStatus(message("session.error.storage"), true);
      return;
    }
    activeSession = session;
    setBudgetInputEnabled(false);
    startSessionTicker();
    applyEffectiveSessionState({ reschedule: false });
    announceSession(message("session.startedAnnounce"));
  }

  /** Hydrate app state from baseline + replay; the only session→app bridge. */
  function applyEffectiveSessionState({ reschedule = true } = {}) {
    if (!activeSession) return;
    const effective = replaySession(activeSession, allSessionContext());
    applyPlannerState({
      selectedItemIds: effective.selectedItemIds.filter((id) => itemById(id)),
      owned: ownedMapsFromPlain(effective.ownedParts),
      ayaBudget: effective.ayaBudget
    });
    renderItemOptions();
    renderCollections();
    renderSessionPanel();
    if (reschedule) scheduleRun();
  }

  function logLiveFissure() {
    if (!activeSession) return;
    const [claimedItemId, claimedPartId] = ($("sessionClaimed").value || "").split("|");
    const event = {
      type: "fissure",
      at: new Date(now()).toISOString(),
      relicId: $("sessionRelic").value || "",
      refinement: $("sessionRefinement").value || "",
      ayaCost: $("sessionOwnedRelic").checked ? 0 : 1,
      claimed: claimedItemId && claimedPartId ? { itemId: claimedItemId, partId: claimedPartId } : null
    };
    const result = appendSessionEvent(activeSession, event, allSessionContext());
    if (!result.ok) {
      announceSession(message(`session.error.${result.error}`));
      return;
    }
    const persisted = persistSessionCandidate(activeSession, result.session, { storage: getStorage() });
    if (!persisted.ok) {
      setStatus(message("session.error.storage"), true);
      announceSession(message("session.error.storage"));
      return;
    }
    activeSession = persisted.session;
    $("sessionOwnedRelic").checked = false;
    applyEffectiveSessionState();
    announceSession(message("session.loggedAnnounce"));
    $("sessionLogButton")?.focus();
  }

  function undoLastLiveFissure() {
    if (!activeSession) return;
    const next = undoLastSessionEvent(activeSession);
    if (!next) return;
    const persisted = persistSessionCandidate(activeSession, next, { storage: getStorage() });
    if (!persisted.ok) {
      setStatus(message("session.error.storage"), true);
      announceSession(message("session.error.storage"));
      return;
    }
    activeSession = persisted.session;
    applyEffectiveSessionState();
    announceSession(message("session.undoAnnounce"));
    $("sessionLogButton")?.focus();
  }

  function finishLiveSession() {
    if (!activeSession) return;
    const summary = deriveSessionSummary(activeSession, { now: now(), context: allSessionContext() });
    const result = commitSessionGains(activeSession, { storage: getStorage(), context: allSessionContext() });
    if (!result.committed) {
      setStatus(message("session.error.storage"), true);
      announceSession(message("session.error.storage"));
      return;
    }
    if (!result.cleared) {
      // Collection gains are saved exactly once, but the local session record
      // could not be cleared. Stay in the session with actionable guidance;
      // retrying Finish is idempotent.
      setStatus(message("session.error.clearFailed"), true);
      announceSession(message("session.error.clearFailed"));
      return;
    }
    stopSessionTicker();
    activeSession = null;
    setBudgetInputEnabled(true);
    applyPlannerState({ ayaBudget: result.final.ayaBudget });
    renderItemOptions();
    renderCollections();
    renderSessionPanel();
    announceSession(message("session.finishedAnnounce", { count: summary.fissures, aya: format(summary.ayaSpent) }));
    $("sessionStartButton")?.focus();
  }

  function cancelLiveSession() {
    if (!activeSession) return;
    const baseline = activeSession.baseline;
    if (!saveActiveSession(getStorage(), null)) {
      setStatus(message("session.error.storage"), true);
      announceSession(message("session.error.storage"));
      return;
    }
    stopSessionTicker();
    activeSession = null;
    setBudgetInputEnabled(true);
    applyPlannerState({
      selectedItemIds: baseline.selectedItemIds.filter((id) => itemById(id)),
      owned: ownedMapsFromPlain(baseline.ownedParts),
      ayaBudget: baseline.ayaBudget
    });
    renderItemOptions();
    renderCollections();
    renderSessionPanel();
    announceSession(message("session.canceledAnnounce"));
    scheduleRun();
    $("sessionStartButton")?.focus();
  }

  /**
   * Rotation rule for stored sessions. Preview mode and missing rotation data
   * never touch the stored session. A session bound to another rotation is
   * SUSPENDED: it is never replayed into the displayed rotation and never
   * finalized implicitly — the user must explicitly Finish (commit once) or
   * Cancel (discard) it from the Live Session panel before a new session can
   * start on the current rotation.
   */
  function adoptStoredSessionForRotation(rotation, { preview = false } = {}) {
    stopSessionTicker();
    activeSession = null;
    suspendedSession = null;
    unresolvedSession = null;
    const storage = getStorage();
    const raw = readActiveSession(storage);
    if (preview || !rotation) return;
    const session = validateSession(raw, sessionContextForStoredLedger(raw));
    if (!session) {
      if (raw !== null) {
        // A ledger we cannot safely validate is preserved byte-for-byte. This
        // includes v1 sessions whose historical rotation context is no longer
        // available, so no event is silently discarded or auto-finished.
        unresolvedSession = raw;
        announceSession(message("session.recoveryPreserved"));
      }
      return;
    }
    if (isLegacySessionDocument(raw)) {
      // v1 can be upgraded only after its rotation-scoped contract was rebuilt;
      // persistence succeeds before the v2 session becomes app authority.
      if (!saveActiveSession(storage, session)) {
        unresolvedSession = raw;
        announceSession(message("session.error.storage"));
        return;
      }
    }
    if (session.rotationId !== rotation.id) {
      suspendedSession = session;
      return;
    }
    activeSession = session;
  }

  function finishSuspendedSession() {
    const planner = getPlannerState();
    const session = suspendedSession;
    if (!session) return;
    const summary = deriveSessionSummary(session, { now: now(), context: allSessionContext() });
    const result = commitSuspendedSessionGains(session, { storage: getStorage(), context: allSessionContext() });
    if (!result.committed) {
      setStatus(message("session.error.storage"), true);
      announceSession(message("session.error.storage"));
      return;
    }
    if (!result.cleared) {
      setStatus(message("session.error.clearFailed"), true);
      announceSession(message("session.error.clearFailed"));
      return;
    }
    const ownershipChanged = ownershipChangesSimulationInput({
      primeItems: planner.primeItems,
      selectedItemIds: planner.selectedItemIds,
      previousOwned: planner.owned,
      nextOwned: result.final.ownedParts
    });
    suspendedSession = null;
    applyPlannerState({ owned: ownedMapsFromPlain(result.final.ownedParts) });
    renderItemOptions();
    renderCollections();
    renderSessionPanel();
    if (ownershipChanged) scheduleRun();
    announceSession(message("session.suspendedFinishedAnnounce", { count: summary.fissures }));
    $("sessionStartButton")?.focus();
  }

  function cancelSuspendedSession() {
    if (!suspendedSession && !unresolvedSession) return;
    if (!saveActiveSession(getStorage(), null)) {
      setStatus(message("session.error.storage"), true);
      announceSession(message("session.error.storage"));
      return;
    }
    suspendedSession = null;
    unresolvedSession = null;
    renderSessionPanel();
    announceSession(message("session.suspendedCanceledAnnounce"));
    $("sessionStartButton")?.focus();
  }

  function sessionMissingTargets() {
    return currentPrimeItems().flatMap((item) => item.parts
      .filter((part) => part.ownedCount < requiredCount(part))
      .map((part) => ({
        itemId: item.id,
        itemName: item.name,
        partId: part.id,
        partName: part.name,
        missingCount: requiredCount(part) - part.ownedCount
      })));
  }

  function fillSelectPreserving(select, options, preferredValue = "") {
    const previous = select.value;
    select.innerHTML = options.map((option) => (
      `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`
    )).join("");
    const next = options.some((option) => option.value === previous)
      ? previous
      : (options.some((option) => option.value === preferredValue) ? preferredValue : options[0]?.value ?? "");
    if (next) select.value = next;
  }

  function renderSessionPanel() {
    const planner = getPlannerState();
    if (!$("liveSessionPanel")) return;
    const active = Boolean(activeSession);
    const suspended = Boolean(suspendedSession);
    const unresolved = Boolean(unresolvedSession);
    const blocked = suspended || unresolved;
    $("sessionIdleView").hidden = active || blocked;
    $("sessionActiveView").hidden = !active;
    $("sessionSuspendedView").hidden = !blocked;
    $("sessionStartButton").disabled = !planner.rotation || planner.previewMode || active || blocked;
    $("sessionIdleHint").textContent = message(
      planner.previewMode
        ? "session.previewHint"
        : planner.rotation
          ? "session.startHint"
          : "session.waitingRotationHint"
    );
    $("sessionElapsed").hidden = !active;
    $("targetLockHint").hidden = !active;

    const targetButtons = ["selectAllTargets", "selectWarframes", "selectWeapons", "clearTargets"];
    for (const id of targetButtons) {
      const button = $(id);
      if (button) button.disabled = active;
    }

    if (unresolved) {
      $("sessionSuspendedTitle").textContent = message("session.recoveryTitle");
      $("sessionSuspendedHint").textContent = message("session.recoveryHint");
      $("sessionSuspendedStats").textContent = "";
      $("sessionSuspendFinishButton").hidden = true;
      $("sessionSuspendCancelButton").textContent = message("session.recoveryDiscard");
      return;
    }

    $("sessionSuspendedTitle").textContent = message("session.suspendedTitle");
    $("sessionSuspendedHint").textContent = message("session.suspendedHint");
    $("sessionSuspendFinishButton").hidden = false;
    $("sessionSuspendCancelButton").textContent = message("session.suspendedCancel");
    if (suspended) {
      const summary = deriveSessionSummary(suspendedSession, { now: now(), context: allSessionContext() });
      $("sessionSuspendedStats").textContent = message("session.suspendedStats", {
        count: format(summary.fissures),
        aya: format(summary.ayaSpent)
      });
      return;
    }

    if (!active) {
      $("sessionElapsed").textContent = "—";
      return;
    }

    updateSessionElapsed();
    const effective = replaySession(activeSession, allSessionContext());
    const summary = deriveSessionSummary(activeSession, { now: now(), context: allSessionContext() });
    const missing = sessionMissingTargets();

    $("sessionStatFissures").textContent = format(summary.fissures);
    $("sessionStatAya").textContent = format(summary.ayaSpent);
    $("sessionStatClaims").textContent = format(summary.claims);
    $("sessionStatRemaining").textContent = format(missing.reduce((sum, entry) => sum + entry.missingCount, 0));
    $("sessionStatChance").textContent = planner.lastResult
      ? formatProbabilityPrecise(planner.lastResult.finishProbability)
      : "—";

    const percentileLine = $("sessionPercentileLine");
    const curve = planner.lastResult?.budgetCurve;
    const showGraduationRecap = shouldShowSessionGraduationRecap({
      selectedItemIds: planner.selectedItemIds,
      missingTargets: missing,
      ayaSpent: summary.ayaSpent,
      curve
    });
    percentileLine.textContent = showGraduationRecap
      ? (() => {
        const recap = calculateGraduationRecap({ curve, observedAya: summary.ayaSpent });
        return recap.status === "ok"
          ? message("session.percentileLine", { band: message(`recap.band.${recap.band}`), value: formatRecapPercent(recap.faceBlackIndex) })
          : message("recap.outside");
      })()
      : "";

    // Recommendation ranking stays budget-aware, but the LOGGING selector lists
    // every current-rotation relic so an already-owned relic stays recordable
    // at 0 Aya even when no purchase is affordable.
    const ranked = rankRelicsForMissing({
      primeItems: currentPrimeItems(),
      relics: planner.relics,
      squad: planner.squad,
      strategy: $("strategy").value,
      availableAya: effective.ayaBudget
    });
    $("sessionNextHint").textContent = ranked[0]
      ? message("session.nextRecommended", { relic: ranked[0].name })
      : message("session.noRecommendation");

    const rankedIds = new Set(ranked.map((entry) => entry.id));
    const relicOptions = [
      ...ranked.map((entry, index) => ({
        value: entry.id,
        label: index === 0 ? `${entry.name} · ${message("session.recommendedMark")}` : entry.name
      })),
      ...planner.relics
        .filter((relic) => !rankedIds.has(relic.id))
        .map((relic) => ({ value: relic.id, label: relic.name }))
    ];
    const relicSelect = $("sessionRelic");
    if (relicOptions.length) fillSelectPreserving(relicSelect, relicOptions);
    else relicSelect.innerHTML = `<option value="">${escapeHtml(message("session.noRelics"))}</option>`;
    relicSelect.disabled = !relicOptions.length;

    updateSessionClaimOptions();

    $("sessionUndoButton").disabled = !activeSession.events.length;
  }

  /**
   * Claim choices are filtered by the currently selected relic through the
   * catalog-derived relic→reward relation; an impossible pairing is never
   * offered. Called on every panel render and whenever the relic selection
   * changes.
   */
  function updateSessionClaimOptions() {
    const relicSelect = $("sessionRelic");
    const claimSelect = $("sessionClaimed");
    if (!relicSelect || !claimSelect) return;
    const selectedRelicId = relicSelect.value || "";
    const context = allSessionContext();
    const eligible = sessionMissingTargets()
      .filter((entry) => context.hasReward(selectedRelicId, entry.itemId, entry.partId));
    fillSelectPreserving(claimSelect, [
      { value: "", label: message("session.claimNone") },
      ...eligible.map((entry) => ({
        value: `${entry.itemId}|${entry.partId}`,
        label: `${entry.itemName} · ${entry.partName}${entry.missingCount > 1 ? ` ×${entry.missingCount}` : ""}`
      }))
    ], "");
    $("sessionLogButton").disabled = !selectedRelicId;
  }

  return {
    get activeSession() { return activeSession; },
    get suspendedSession() { return suspendedSession; },
    get unresolvedSession() { return unresolvedSession; },
    allSessionContext,
    sessionContextForRotation,
    sessionContextForStoredLedger,
    adoptStoredSessionForRotation,
    startSessionTicker,
    stopSessionTicker,
    setBudgetInputEnabled,
    applyEffectiveSessionState,
    renderSessionPanel,
    updateSessionClaimOptions,
    startLiveSession,
    logLiveFissure,
    undoLastLiveFissure,
    finishLiveSession,
    cancelLiveSession,
    finishSuspendedSession,
    cancelSuspendedSession,
    commitSessionGains: (session, { storage = getStorage(), context = allSessionContext() } = {}) => (
      commitSessionGains(session, { storage, context })
    ),
    commitSuspendedSessionGains: (session, { storage = getStorage(), context = allSessionContext() } = {}) => (
      commitSuspendedSessionGains(session, { storage, context })
    ),
    persistSessionCandidate: (previous, candidate, { storage = getStorage() } = {}) => (
      persistSessionCandidate(previous, candidate, { storage })
    )
  };
}
