import { createRotationUiController, selectAnnouncementPreview } from "./rotation-ui-controller.js";
import { createShareUiController } from "./share-ui-controller.js";
import { createSessionUIController } from "./session-ui-controller.js";
export { shouldShowSessionGraduationRecap } from "./session-ui-controller.js";
import { createSimulationController } from "./simulation-controller.js";
import { createResultsView } from "./results-view.js";
import { createBudgetChartView } from "./budget-chart-view.js";
import { createCollectionView } from "./collection-view.js";
import { escapeHtml } from "./dom-helpers.js";
import { requiredCount, isSafeOwnedKey, ownedCountIn, ownedMapsFromPlain, injectOwnedCounts, ownedPlainObject as collectionOwnedPlainObject } from "./planner-ownership.js";
export { injectOwnedCounts, ownershipChangesSimulationInput } from "./planner-ownership.js";
import {
  MAX_SIMULATION_BUDGET,
  analysisCapFor,
  validateSimulationBudget
} from "./simulator.js";
import { FALLBACK_SCHEDULE, loadAppData } from "./app-data-loader.js";
import {
  browserLocale,
  loadLocaleMessages,
  localeFromPathname,
  localePath,
  localeTag,
  normalizeLocale,
  readStoredLocale,
  resolveLocale,
  setLocaleMessages,
  t,
  typeLabelKey,
  rarityKey,
  refinementKey,
  writeStoredLocale
} from "./i18n.js";
import { decodePlan, encodePlan, planUrl, planNavigationChanged } from "./plan-share.js";
import {
  loadCollectionState,
  saveCollectionState,
  hasFutureSchemaDocument
} from "./storage.js";

const state = {
  scheduleData: FALLBACK_SCHEDULE,
  announcementCandidates: [],
  announcementPreview: null,
  rotations: [],
  publishedRotations: [],
  realRotationState: { activeRotation: null, nextRotation: null, previousRotation: null },
  rotation: null,
  previewId: "",
  previewMode: false,
  allPrimeItems: [],
  allRelics: [],
  primeItems: [],
  relics: [],
  selectedItemIds: [],
  owned: {},
  squad: 4,
  mode: "budget",
  dataLoadErrors: [],
  locale: "en",
  localeMessages: {},
  sharedPlan: null,
  resultsUpdating: true,
  shareReady: false,
  lastResult: null,
  lastResultOptions: null,
  lastTrials: 0,
  currentRecap: null,
  storageLocked: false
};

const $ = (id) => document.getElementById(id);
const format = (number) => Number(number || 0).toLocaleString(browserLocale(state.locale));
const formatDate = (value) => String(value || "—").replaceAll("-", ".");

function message(key, variables = {}) {
  return t(key, variables);
}

function localizedTypeLabel(type) {
  return message(typeLabelKey(type));
}

function localizedRarityLabel(rarity) {
  return message(rarityKey(rarity));
}

function localizedRefinementLabel(refinement) {
  return message(refinementKey(refinement));
}

function localizedProbabilityDescriptor(probability) {
  const value = Math.max(0, Math.min(1, Number(probability) || 0));
  if (value >= 0.99) return message("probability.almostCertain");
  if (value >= 0.95) return message("probability.veryLikely");
  if (value >= 0.90) return message("probability.likely");
  if (value >= 0.75) return message("probability.advantage");
  if (value >= 0.55) return message("probability.aboveHalf");
  if (value >= 0.45) return message("probability.nearHalf");
  if (value >= 0.25) return message("probability.risky");
  if (value > 0) return message("probability.small");
  return message("probability.zero");
}

export function localizedBudgetMarker(value, analysisCap) {
  const unit = message("unit.aya");
  if (value !== null && value !== undefined && Number.isFinite(Number(value))) return `${format(value)} ${unit}`;
  if (analysisCap !== null && analysisCap !== undefined && Number.isFinite(Number(analysisCap))) return `>${format(analysisCap)} ${unit}`;
  return "—";
}

function unit(key) {
  return message(`unit.${key}`);
}

// Compose state owners and views once. All DOM access is deferred until bootstrap.
const collectionView = createCollectionView({ $, message, format, localizedTypeLabel, localizedRarityLabel });

// The controller owns request identity and timers; hooks own page presentation.
const simulation = createSimulationController({
  getRotationId: () => state.rotation?.id || "",
  prepareRequest() {
    const validation = validateSimulationBudget($("budget").value);
    if (!validation.valid) {
      showBudgetValidationError();
      return null;
    }
    clearBudgetValidationError();
    return simulationOptions(validation.budget);
  },
  hooks: {
    updating: setResultsUpdating,
    started() {
      $("runButton").disabled = true;
      $("runButtonLabel").textContent = message("run.running");
      $("runCaption").textContent = message("run.running");
    },
    completed(result, trials, completedRequest) {
      renderResult(result, trials, completedRequest?.options || {});
      if (sessionUi.activeSession) renderSessionPanel();
      state.shareReady = true;
      setResultsUpdating(false);
      $("runButton").disabled = false;
      $("runButtonLabel").textContent = message("run.button");
    },
    failed(failureKind) {
      $("runButton").disabled = false;
      $("runButtonLabel").textContent = message("run.button");
      setResultsUpdating(false);
      const failureMessage = failureKind === "unavailable"
        ? message("run.workerUnavailable")
        : failureKind === "timeout" ? message("run.timeout") : message("run.workerFailed");
      $("trialBadge").textContent = failureMessage;
      $("runCaption").textContent = failureMessage;
    },
    empty() {
      $("runButton").disabled = false;
      renderNoTargets();
    },
    progress(progress) {
      $("runCaption").textContent = message("run.progress", {
        completed: format(progress.completedTrials), trials: format(progress.totalTrials)
      });
    },
    cancelled() {
      $("runButton").disabled = false;
      $("runButtonLabel").textContent = message("run.button");
      setResultsUpdating(false);
    }
  }
});
const { schedule: scheduleRun, run, cancel: cancelActiveSimulation, init: initSimulationWorker } = simulation;

const shareUi = createShareUiController({
  getSnapshot: () => ({
    shareReady: state.shareReady, resultsUpdating: state.resultsUpdating, running: simulation.running,
    rotation: state.rotation, locale: state.locale, lastResult: state.lastResult,
    lastResultOptions: state.lastResultOptions, lastTrials: state.lastTrials,
    currentRecap: state.currentRecap, mode: state.mode, goal: $("goalLine").value
  }),
  $, message
});
const { copyPlanLink, generateShareCard, shareGeneratedCard } = shareUi;

const budgetChart = createBudgetChartView({ $, message, format, localizedBudgetMarker, localizedProbabilityDescriptor,
  isRunning: () => simulation.running });
const { renderBudgetDistribution, initBudgetChartResize } = budgetChart;

const resultsView = createResultsView({ $, message, format, unit, localizedBudgetMarker,
  localizedRarityLabel, localizedRefinementLabel, renderBudgetDistribution });
const { renderItemResults } = resultsView;

const sessionUi = createSessionUIController({
  getPlannerState: () => ({
    rotation: state.rotation, previewMode: state.previewMode, rotations: state.rotations,
    allPrimeItems: state.allPrimeItems, allRelics: state.allRelics,
    primeItems: state.primeItems, relics: state.relics, selectedItemIds: state.selectedItemIds,
    owned: state.owned, squad: state.squad, lastResult: state.lastResult
  }),
  applyPlannerState(patch) {
    if (patch.selectedItemIds !== undefined) state.selectedItemIds = patch.selectedItemIds;
    if (patch.owned !== undefined) state.owned = patch.owned;
    if (patch.ayaBudget !== undefined) $("budget").value = String(patch.ayaBudget);
  },
  $, message, format, escapeHtml, getStorage, renderItemOptions, renderCollections, scheduleRun, setStatus
});
const {
  adoptStoredSessionForRotation, startSessionTicker, stopSessionTicker, setBudgetInputEnabled,
  applyEffectiveSessionState, renderSessionPanel, updateSessionClaimOptions,
  startLiveSession, logLiveFissure, undoLastLiveFissure, finishLiveSession, cancelLiveSession,
  finishSuspendedSession, cancelSuspendedSession
} = sessionUi;
export const { commitSessionGains, commitSuspendedSessionGains, persistSessionCandidate } = sessionUi;

const rotationUi = createRotationUiController({
  getSnapshot: () => ({
    rotation: state.rotation, previewMode: state.previewMode, previewId: state.previewId,
    realRotationState: state.realRotationState, announcementPreview: state.announcementPreview,
    allPrimeItems: state.allPrimeItems, locale: state.locale, dataLoadErrors: state.dataLoadErrors,
    publishedRotations: state.publishedRotations, rotations: state.rotations
  }),
  clearPreviewId: () => { state.previewId = ""; },
  onView(view) {
    state.realRotationState = { activeRotation: view.activeRotation,
      nextRotation: view.nextRotation, previousRotation: view.previousRotation };
  },
  applyRotation, stopSessionTicker, $, message, localizedTypeLabel
});
const { renderRotationSchedule, scheduleRotationWatcher, bindRotationLifecycle } = rotationUi;

function applyStaticTranslations() {
  document.documentElement.lang = localeTag(state.locale);
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = message(element.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-aria-label]").forEach((element) => {
    element.setAttribute("aria-label", message(element.dataset.i18nAriaLabel));
  });
  document.querySelectorAll("[data-i18n-title]").forEach((element) => {
    element.setAttribute("title", message(element.dataset.i18nTitle));
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
    element.setAttribute("placeholder", message(element.dataset.i18nPlaceholder));
  });
  document.querySelectorAll("[data-i18n-alt]").forEach((element) => {
    element.setAttribute("alt", message(element.dataset.i18nAlt));
  });
  document.querySelectorAll("[data-i18n-href]").forEach((element) => {
    element.setAttribute("href", message(element.dataset.i18nHref));
  });
  document.querySelectorAll("[data-locale-link]").forEach((link) => {
    const linkLocale = normalizeLocale(link.dataset.localeLink);
    link.href = localePath(linkLocale, window.location);
    link.classList.toggle("is-active", linkLocale === state.locale);
    link.setAttribute("aria-current", linkLocale === state.locale ? "page" : "false");
  });
  const brand = document.querySelector(".brand");
  if (brand) brand.href = localePath(state.locale, window.location);
  updateSeoMetadata();
}

function updateSeoMetadata() {
  const locale = state.locale;
  const canonicalPath = `/${locale}/`;
  const canonical = document.querySelector('link[rel="canonical"]');
  if (canonical) canonical.href = `https://varzia.starport1116.com${canonicalPath}`;
  document.title = message("seo.title");
  const description = document.querySelector('meta[name="description"]');
  if (description) description.content = message("seo.description");
  const ogLocale = document.querySelector('meta[property="og:locale"]');
  if (ogLocale) ogLocale.content = locale === "zh" ? "zh_CN" : "en_US";
  const ogTitle = document.querySelector('meta[property="og:title"]');
  if (ogTitle) ogTitle.content = message("seo.title");
  const ogDescription = document.querySelector('meta[property="og:description"]');
  if (ogDescription) ogDescription.content = message("seo.ogDescription");
  const ogUrl = document.querySelector('meta[property="og:url"]');
  if (ogUrl) ogUrl.content = `https://varzia.starport1116.com${canonicalPath}`;
  const twitterTitle = document.querySelector('meta[name="twitter:title"]');
  if (twitterTitle) twitterTitle.content = message("seo.title");
  const twitterDescription = document.querySelector('meta[name="twitter:description"]');
  if (twitterDescription) twitterDescription.content = message("seo.description");
}

function ensureLocaleRoute() {
  const pathLocale = localeFromPathname(window.location.pathname);
  if (pathLocale) {
    state.locale = pathLocale;
    return true;
  }
  const preferred = resolveLocale({
    savedLocale: readStoredLocale(getStorage()),
    navigatorLanguage: window.navigator?.language,
    defaultLocale: "en"
  });
  window.location.replace(localePath(preferred, window.location));
  return false;
}

function getStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function ownedMap(itemId) {
  if (!isSafeOwnedKey(itemId)) return new Map();
  if (!state.owned[itemId]) state.owned[itemId] = new Map();
  return state.owned[itemId];
}

function ownedCount(itemId, partId) {
  return ownedCountIn(state.owned, itemId, partId);
}

function ownedPlainObject() {
  return collectionOwnedPlainObject(state.owned);
}

function itemById(itemId) {
  return state.primeItems.find((item) => item.id === itemId);
}

function selectedItems() {
  return state.selectedItemIds.map(itemById).filter(Boolean);
}

function currentPrimeItems() {
  return injectOwnedCounts(selectedItems(), state.owned);
}

function setStatus(text, isError = false) {
  const status = $("dataStatus");
  status.textContent = text;
  status.closest(".source-status")?.classList.toggle("is-error", isError);
}

function collectionModel() {
  return { rotation: state.rotation, previewMode: state.previewMode, primeItems: state.primeItems,
    relics: state.relics, selectedItemIds: state.selectedItemIds, owned: state.owned, activeSession: sessionUi.activeSession };
}
function renderRotation() { collectionView.renderRotation(collectionModel()); }
function renderItemOptions() { collectionView.renderItemOptions(collectionModel()); }
function renderCollections() { collectionView.renderCollections(collectionModel()); }

function persistCollection({ quiet = false } = {}) {
  // While a live session is active the persisted collection stays untouched:
  // effective state lives in baseline + replay and is committed exactly once
  // on finish.
  if (sessionUi.activeSession) return false;
  if (state.previewMode || !state.rotation) {
    if (!quiet && state.previewMode) {
      setStatus(message(state.rotation?.publicationStatus === "provisional" ? "status.provisionalPreview" : "status.preview"));
    }
    return false;
  }
  const saved = saveCollectionState(getStorage(), {
    rotationId: state.rotation.id,
    selectedItemIds: state.selectedItemIds,
    owned: ownedPlainObject(),
    ayaBudget: Number($("budget").value) || 0
  });
  if (!quiet && saved && state.dataLoadErrors.length) setStatus(message("status.dataError"), true);
  else if (!quiet && saved) setStatus(message("status.dataSaved", { date: formatDate(state.scheduleData.lastVerified) }));
  return saved;
}

function updateStrategyNote() {
  $("strategyNote").textContent = message(`strategy.note.${$("strategy").value}`);
}

function setMode(mode) {
  state.mode = mode;
  $("modePicker").querySelectorAll("button").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
  });
  $("budgetLabel").textContent = message(mode === "goal" ? "budget.goalLabel" : "budget.label");
  $("goalLine").closest(".goal-line-field").hidden = mode !== "goal";
  scheduleRun();
}

function applySharedPlan(plan) {
  state.selectedItemIds = [...plan.selectedItemIds];
  state.owned = ownedMapsFromPlain(plan.owned);
  state.squad = plan.squad;
  state.mode = plan.mode;
  $("budget").value = String(plan.budget);
  $("strategy").value = plan.strategy;
  $("trials").value = String(plan.trials);
  $("goalLine").value = plan.goal;
  $("budgetLabel").textContent = message(plan.mode === "goal" ? "budget.goalLabel" : "budget.label");
  $("goalLine").closest(".goal-line-field").hidden = plan.mode !== "goal";
  $("modePicker").querySelectorAll("button").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.mode === plan.mode)));
  $("squadPicker").querySelectorAll("button").forEach((button) => button.setAttribute("aria-pressed", String(Number(button.dataset.squad) === plan.squad)));
  $("budgetHint").textContent = message("share.previewHint");
  renderItemOptions();
  renderCollections();
  renderSessionPanel();
  updateStrategyNote();
}

function revealSharedPlanNotice(status) {
  $("sharedPlanNotice").hidden = false;
  $("sharedPlanTitle").textContent = message(status === "ok" ? "share.previewTitle" : "share.invalidTitle");
  $("sharedPlanDescription").textContent = message(status === "ok" ? "share.previewHint" : status === "unavailable" ? "share.unavailable" : "share.invalid");
  $("sharedPlanReturn").href = `/${state.locale}/#planner`;
  $("sharedPlanOwnCollection").hidden = status !== "ok";
}

function bindEvents() {
  window.addEventListener("hashchange", (event) => {
    // Same-document links and Back/Forward must enter or leave preview through a fresh bootstrap.
    if (planNavigationChanged(event.oldURL, event.newURL)) window.location.reload();
  });
  document.querySelectorAll("[data-locale-link]").forEach((link) => {
    link.addEventListener("click", (event) => {
      if (state.sharedPlan) {
        const validation = validateSimulationBudget($("budget").value);
        if (!validation.valid) {
          event.preventDefault();
          showBudgetValidationError();
          $("budget").focus();
          return;
        }
        // Language navigation preserves current edits even while their simulation is still running.
        link.href = planUrl(encodePlan({ rotationId: state.rotation.id,
          options: simulationOptions(validation.budget).options, mode: state.mode, goal: $("goalLine").value
        }), link.dataset.localeLink, window.location.origin);
      }
      writeStoredLocale(getStorage(), link.dataset.localeLink);
    });
  });
  document.querySelectorAll('a[href="#planner"]').forEach((link) => {
    link.addEventListener("click", (event) => {
      // In-page navigation must not discard the plan stored in the URL fragment.
      if (!state.sharedPlan) return;
      event.preventDefault();
      $("planner")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  $("budgetJump")?.addEventListener("click", () => {
    $("planner")?.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => $("budget")?.focus(), 450);
  });

  $("targetOptions").addEventListener("change", (event) => {
    const itemId = event.target.dataset.itemId;
    if (!itemId) return;
    // Selected targets come from the session baseline while a session is
    // active; planning edits cannot become authoritative session state.
    if (sessionUi.activeSession) return;
    state.selectedItemIds = event.target.checked
      ? [...new Set([...state.selectedItemIds, itemId])]
      : state.selectedItemIds.filter((id) => id !== itemId);
    persistCollection();
    renderItemOptions();
    renderCollections();
    scheduleRun();
  });

  $("collectionList").addEventListener("change", (event) => {
    const { itemId, partId } = event.target.dataset;
    if (!itemId || !partId) return;
    // Owned counts are session-owned while a live session is active.
    if (sessionUi.activeSession) return;
    const item = itemById(itemId);
    const part = item?.parts.find((candidate) => candidate.id === partId);
    if (!part) return;
    ownedMap(itemId).set(partId, event.target.checked ? requiredCount(part) : 0);
    persistCollection();
    renderItemOptions();
    renderCollections();
    scheduleRun();
  });

  $("collectionList").addEventListener("click", (event) => {
    const completeItemId = event.target.dataset.completeItem;
    const delta = Number(event.target.dataset.partDelta || 0);
    const itemId = completeItemId || event.target.dataset.itemId;
    if (!itemId) return;
    // Owned counts are session-owned while a live session is active.
    if (sessionUi.activeSession) return;
    const item = itemById(itemId);
    if (!item) return;

    if (completeItemId) {
      item.parts.forEach((part) => ownedMap(itemId).set(part.id, requiredCount(part)));
    } else if (delta) {
      const partId = event.target.dataset.partId;
      const part = item.parts.find((candidate) => candidate.id === partId);
      if (!part) return;
      const next = Math.max(0, Math.min(requiredCount(part), ownedCount(itemId, partId) + delta));
      ownedMap(itemId).set(partId, next);
    } else {
      return;
    }
    persistCollection();
    renderItemOptions();
    renderCollections();
    scheduleRun();
  });

  const changeSelection = (nextIds) => {
    // Selected targets come from the session baseline while a session is
    // active; planning edits cannot become authoritative session state.
    if (sessionUi.activeSession) return;
    state.selectedItemIds = nextIds;
    persistCollection();
    renderItemOptions();
    renderCollections();
    scheduleRun();
  };

  $("selectAllTargets").addEventListener("click", () => {
    changeSelection(state.primeItems.map((item) => item.id));
  });

  $("clearTargets").addEventListener("click", () => {
    changeSelection([]);
  });

  $("selectWarframes").addEventListener("click", () => {
    changeSelection(state.primeItems.filter((item) => item.type === "warframe").map((item) => item.id));
  });

  $("selectWeapons").addEventListener("click", () => {
    changeSelection(state.primeItems.filter((item) => ["primary", "secondary", "melee"].includes(item.type)).map((item) => item.id));
  });

  $("modePicker").addEventListener("click", (event) => {
    if (event.target.dataset.mode) setMode(event.target.dataset.mode);
  });
  $("budget").addEventListener("input", () => {
    persistCollection({ quiet: true });
    scheduleRun();
  });
  $("strategy").addEventListener("change", () => { updateStrategyNote(); scheduleRun(); });
  $("trials").addEventListener("change", scheduleRun);
  $("goalLine").addEventListener("change", scheduleRun);
  $("observedAya")?.addEventListener("input", () => {
    shareUi.invalidate();
    $("sharePreview").hidden = true;
    $("shareStatus").textContent = "";
    $("shareResultButton").disabled = state.resultsUpdating || !state.shareReady;
    renderGraduationRecap();
  });
  $("squadPicker").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-squad]");
    if (!button) return;
    state.squad = Number(button.dataset.squad);
    $("squadPicker").querySelectorAll("button").forEach((item) => {
      item.setAttribute("aria-pressed", String(item === button));
    });
    scheduleRun();
  });
  $("runButton").addEventListener("click", run);
  $("shareResultButton")?.addEventListener("click", generateShareCard);
  $("sharePlanButton")?.addEventListener("click", copyPlanLink);
  $("shareSystemButton")?.addEventListener("click", shareGeneratedCard);
  $("sharedPlanOwnCollection")?.addEventListener("click", () => {
    // Use the recipient's collection only in this temporary preview. Never adopt or write a ledger.
    if (!state.sharedPlan) return;
    const saved = loadCollectionState(getStorage(), state.allPrimeItems, {
      rotationId: state.rotation.id, activeItemIds: state.rotation.items, preview: true
    });
    state.owned = ownedMapsFromPlain(saved.owned);
    renderItemOptions();
    renderCollections();
    $("sharedPlanDescription").textContent = message("share.ownCollectionUsed");
    scheduleRun();
  });
  $("shareDownloadLink")?.addEventListener("click", (event) => {
    if (!shareUi.hasCard) event.preventDefault();
  });
  $("liveSessionPanel")?.addEventListener("submit", (event) => {
    event.preventDefault();
    logLiveFissure();
  });
  $("sessionRelic")?.addEventListener("change", () => {
    // The eligible claim list always follows the selected relic.
    updateSessionClaimOptions();
  });
  $("sessionStartButton")?.addEventListener("click", startLiveSession);
  $("sessionUndoButton")?.addEventListener("click", undoLastLiveFissure);
  $("sessionFinishButton")?.addEventListener("click", finishLiveSession);
  $("sessionCancelButton")?.addEventListener("click", cancelLiveSession);
  $("sessionSuspendFinishButton")?.addEventListener("click", finishSuspendedSession);
  $("sessionSuspendCancelButton")?.addEventListener("click", cancelSuspendedSession);
}

function setResultsUpdating(updating) {
  state.resultsUpdating = updating;
  if (updating) state.shareReady = false;
  for (const id of ["shareResultButton", "sharePlanButton"]) {
    const button = $(id);
    if (button) button.disabled = updating || !state.shareReady || state.rotation?.publicationStatus !== "published";
  }
  if (updating) {
    shareUi.invalidate();
    $("sharePreview").hidden = true;
    $("shareLinkFallback").hidden = true;
    $("shareStatus").textContent = "";
  }
  const results = $("resultsSection");
  results?.classList.toggle("is-updating", updating);
  results?.setAttribute("aria-busy", String(updating));
  $("budgetDistribution")?.setAttribute("aria-busy", String(updating));
  if (updating) $("trialBadge").textContent = message("results.updating");
}

function clearBudgetValidationError() {
  $("budget")?.removeAttribute("aria-invalid");
  const error = $("budgetError");
  if (error) {
    error.hidden = true;
    error.textContent = "";
  }
}

function showBudgetValidationError() {
  const text = message("budget.outOfRange", { max: format(MAX_SIMULATION_BUDGET) });
  $("budget")?.setAttribute("aria-invalid", "true");
  const error = $("budgetError");
  if (error) {
    error.textContent = text;
    error.hidden = false;
  }
  setResultsUpdating(false);
  $("runButton").disabled = false;
  $("runButtonLabel").textContent = message("run.button");
  $("trialBadge").textContent = text;
  $("runCaption").textContent = text;
}

function simulationOptions(budget = Number($("budget").value) || 0) {
  const trials = Number($("trials").value) || 100000;
  return {
    trials,
    options: {
      primeItems: currentPrimeItems(),
      relics: state.relics,
      budget,
      squad: state.squad,
      strategy: $("strategy").value,
      trials,
      analysisCap: analysisCapFor(budget, 120)
    }
  };
}

function renderNoTargets() {
  setResultsUpdating(false);
  $("runButtonLabel").textContent = message("run.button");
  $("trialBadge").textContent = message("results.waiting");
  $("primaryResultLabel").textContent = message("result.waitingTarget");
  $("finishProbability").textContent = "—";
  $("finishDetail").textContent = message("result.waitingDetail");
  $("resultStatus").textContent = message("result.waitingStatus");
  $("resultSentence").textContent = message("result.chooseSentence");
  $("probabilityBar").style.width = "0%";
  ["meanAya", "budgetKpiCurrent", "budgetKpiProbability", "budgetKpiP50", "budgetKpiP95", "budgetKpiP99"].forEach((id) => { $(id).textContent = "—"; });
  $("budgetKpiProbabilityNote").textContent = message("kpi.waiting");
  ["summaryTargets", "summaryCompleted", "summaryRemaining", "summaryBudget"].forEach((id) => { $(id).textContent = "—"; });
  $("traceTotal").textContent = "—";
  $("runCaption").textContent = message("run.waitingTarget");
  $("verdict").innerHTML = `<span class="verdict-mark" aria-hidden="true">✦</span><span>${escapeHtml(message("verdict.choose"))}</span>`;
  $("timelineHeadline").textContent = message("app.noTargetTimeline");
  $("timelineDetail").textContent = message("app.noTargetTimelineDetail");
  $("timelineSuccess").textContent = "—";
  renderBudgetDistribution(null, Number($("budget").value) || 0);
  $("breakdownBody").innerHTML = `<tr><td class="empty-row" colspan="5">${escapeHtml(message("app.noTargetSelection"))}</td></tr>`;
  renderItemResults({ itemProbabilities: [] });
  $("recommendationAya").textContent = "—";
  $("recommendationList").innerHTML = `<p class="field-hint">${escapeHtml(message("app.noTargetRecommendation"))}</p>`;
  $("targetDeltaList").innerHTML = `<p class="field-hint">${escapeHtml(message("delta.waiting"))}</p>`;
  $("sharePanel").hidden = true;
  $("recapPanel").hidden = true;
  $("observedAya").value = "";
}

function resetSimulationResults() {
  renderNoTargets();
  if (!state.selectedItemIds.length) return;
  $("trialBadge").textContent = message("results.waiting");
  $("primaryResultLabel").textContent = state.previewMode ? message("target.previewTitle") : message("result.primary");
  $("finishDetail").textContent = message("result.updatedDetail");
  $("resultSentence").textContent = message("result.newRotation");
  $("runCaption").textContent = message("app.waitingCurrentRotation");
  $("verdict").innerHTML = `<span class="verdict-mark" aria-hidden="true">✦</span><span>${escapeHtml(message("verdict.waitingRotation"))}</span>`;
  $("timelineHeadline").textContent = message("app.waitingCurrentRotation");
  $("timelineDetail").textContent = message("app.newRotation");
  $("breakdownBody").innerHTML = `<tr><td class="empty-row" colspan="5">${escapeHtml(message("app.waitingRotation"))}</td></tr>`;
  $("recommendationList").innerHTML = `<p class="field-hint">${escapeHtml(message("app.waitingRecommendation"))}</p>`;
  $("targetDeltaList").innerHTML = `<p class="field-hint">${escapeHtml(message("delta.waiting"))}</p>`;
  $("sharePanel").hidden = true;
  $("recapPanel").hidden = true;
  shareUi.clearCard();
}

function renderResult(result, trials, options = {}) {
  state.lastResult = result;
  state.lastResultOptions = options;
  state.lastTrials = trials;
  resultsView.renderResult(result, trials, options, { mode: state.mode, locale: state.locale,
    primeItems: currentPrimeItems(), selectedItemIds: state.selectedItemIds, relics: state.relics, squad: state.squad });
  renderGraduationRecap();
}
function renderGraduationRecap() {
  state.currentRecap = resultsView.renderGraduationRecap(state.lastResult);
}

function announceRotationChange(rotation) {
  const announcement = $("rotationAnnouncement");
  announcement.textContent = "";
  window.requestAnimationFrame(() => {
    announcement.textContent = rotation
      ? message("status.rotationChanged", { name: rotation.displayName || rotation.id })
      : message("status.rotationStateUpdated");
  });
}

function applyRotation(rotation, { preview = false, announce = false, scheduleSimulation = true } = {}) {
  cancelActiveSimulation();
  state.rotation = rotation || null;
  state.previewMode = Boolean(preview && rotation);
  const provisionalPreview = state.previewMode && rotation?.publicationStatus === "provisional";
  $("dataSources").hidden = provisionalPreview;

  const itemIds = new Set(rotation?.items || []);
  const relicIds = new Set(rotation?.relics || []);
  state.primeItems = rotation ? state.allPrimeItems.filter((item) => itemIds.has(item.id)) : [];
  state.relics = rotation ? state.allRelics.filter((relic) => relicIds.has(relic.id)) : [];

  adoptStoredSessionForRotation(rotation, { preview: state.previewMode });

  const defaultAyaBudget = Math.max(0, Math.floor(Number(rotation?.defaults?.ayaBudget) || 0));
  const saved = loadCollectionState(getStorage(), state.allPrimeItems, {
    rotationId: rotation?.id || "",
    activeItemIds: rotation?.items || [],
    defaultAyaBudget,
    preview: state.previewMode
  });
  state.selectedItemIds = saved.selectedItemIds;
  state.owned = Object.fromEntries(Object.entries(saved.owned || {}).map(([itemId, partCounts]) => [
    itemId,
    new Map(Object.entries(partCounts).map(([partId, count]) => [partId, Number(count) || 0]))
  ]));
  $("budget").value = String(saved.ayaBudget);

  if (sessionUi.activeSession) {
    // Resume: effective collection is baseline + replay and overrides whatever
    // the normal document held; the persisted collection stays untouched.
    setBudgetInputEnabled(false);
    startSessionTicker();
    applyEffectiveSessionState({ reschedule: false });
  } else {
    setBudgetInputEnabled(true);
  }

  $("budgetHint").textContent = rotation
    ? message("budget.savedHint", { budget: format(defaultAyaBudget) })
    : message("status.waitingFirstRotation");

  renderRotation();
  renderItemOptions();
  renderCollections();
  renderRotationSchedule();
  renderSessionPanel();
  resetSimulationResults();

  if (!state.previewMode && rotation) persistCollection({ quiet: true });
  if (state.previewMode) {
    setStatus(message(provisionalPreview ? "status.provisionalPreview" : "status.preview"));
  } else if (announce) {
    announceRotationChange(rotation);
    setStatus(message("status.rotationUpdated", { date: formatDate(state.scheduleData.lastVerified) }));
  }

  if (scheduleSimulation && rotation && state.primeItems.length) scheduleRun();
}

async function loadData() {
  if (!ensureLocaleRoute()) return;
  $("budget").max = String(MAX_SIMULATION_BUDGET);
  try {
    const localeMessages = await loadLocaleMessages(state.locale);
    setLocaleMessages(state.locale, localeMessages, localeMessages);
    state.localeMessages = localeMessages;
  } catch (error) {
    console.warn("Varzia locale data failed to load", error);
    let fallback = {};
    try { fallback = JSON.parse($("localeMessages")?.textContent || "{}"); } catch { /* Keep the static page readable. */ }
    setLocaleMessages(state.locale, fallback, fallback);
    state.localeMessages = fallback;
  }
  if (Object.keys(state.localeMessages).length) applyStaticTranslations();
  state.dataLoadErrors = [];
  // A newer schema wrote local data; persistence is locked this session so
  // the document can never be downgraded or destroyed. Catalog data itself
  // is unaffected, so this stays out of dataLoadErrors.
  state.storageLocked = hasFutureSchemaDocument(getStorage());
  const loaded = await loadAppData({ locale: state.locale });
  state.dataLoadErrors = loaded.dataLoadErrors;
  state.scheduleData = loaded.scheduleData;
  state.rotations = loaded.rotations;
  state.publishedRotations = loaded.publishedRotations;
  state.announcementCandidates = loaded.announcementCandidates;
  state.announcementPreview = selectAnnouncementPreview(state.announcementCandidates);
  state.allPrimeItems = loaded.allPrimeItems;
  state.allRelics = loaded.allRelics;
  const shared = decodePlan(window.location.hash, { rotations: state.publishedRotations, primeItems: state.allPrimeItems });
  state.sharedPlan = shared.status === "ok" ? shared.plan : null;
  state.previewId = new URLSearchParams(window.location.search).get("rotation")?.trim() || "";
  if (state.sharedPlan) state.previewId = state.sharedPlan.rotationId;

  const view = rotationUi.resolveView();
  applyRotation(view.displayRotation, { preview: view.isPreview, scheduleSimulation: false });
  if (state.sharedPlan) applySharedPlan(state.sharedPlan);
  if (shared.status !== "absent") revealSharedPlanNotice(shared.status);

  $("dataUpdatedAt").textContent = formatDate(loaded.dataUpdatedAt);
  if (state.dataLoadErrors.length) {
    setStatus(message("status.dataError"), true);
  } else if (state.storageLocked) {
    setStatus(message("storage.futureVersion"), true);
  } else if (!state.previewMode) {
    setStatus(message("status.dataChecked", { date: formatDate(state.scheduleData.lastVerified) }));
  }
  updateStrategyNote();
  bindEvents();
  initBudgetChartResize();
  initSimulationWorker();
  bindRotationLifecycle();
  scheduleRotationWatcher(Date.now());
  if (state.rotation && state.primeItems.length) run();
  else renderNoTargets();
}

if (typeof document !== "undefined" && typeof window !== "undefined") loadData();
