import {
  MAX_SIMULATION_BUDGET,
  RARITIES,
  refinementFor,
  squadChance,
  validateSimulationBudget
} from "./simulator.js";
import { validateRotationData } from "./data-validation.js";
import {
  assertValidBudgetCurve,
  formatProbability,
  formatProbabilityPrecise
} from "./presentation.js";
import {
  browserLocale,
  getLocale,
  loadLocaleMessages,
  localizeDisplayData,
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
import {
  calculateGraduationRecap,
  calculatePercentileDeltas,
  formatRecapPercent
} from "./wave1.js";
import {
  buildShareCardModel,
  renderShareCardSvg,
  svgToPngBlob
} from "./share-card.js";
import { loadCollectionState, saveCollectionState } from "./storage.js";
import {
  countdownUpdateDelay,
  formatRotationCountdown,
  formatRotationLocalTime,
  getTimeUntilRotation,
  isSimulationResponseCurrent,
  publishedRotations,
  resolveRotationView
} from "./rotation-schedule.js";
import {
  createSimulationWorkerClient,
  schedulePendingRunAfterFailure,
  simulationWorkerUrl
} from "./simulation-worker-client.js";

const fallbackSchedule = {
  schemaVersion: 2,
  lastVerified: "2026-08-14",
  source: { name: "Warframe 官方简体中文 Prime 重生页面", url: "https://www.warframe.com/zh-hans/prime-resurgence" },
  rotations: []
};

const state = {
  scheduleData: fallbackSchedule,
  rotations: [],
  publishedRotations: [],
  realRotationState: { activeRotation: null, nextRotation: null, previousRotation: null },
  rotation: null,
  previewId: "",
  previewMode: false,
  invalidPreviewWarned: false,
  allPrimeItems: [],
  allRelics: [],
  primeItems: [],
  relics: [],
  selectedItemIds: [],
  owned: {},
  squad: 4,
  mode: "budget",
  runTimer: null,
  running: false,
  pendingRun: false,
  simulationClient: null,
  workerRequestId: 0,
  activeSimulation: null,
  lastBudgetChart: null,
  chartResizeObserver: null,
  chartResizeTimer: null,
  rotationTimer: null,
  lifecycleBound: false,
  dataLoadErrors: [],
  locale: "en",
  localeMessages: {},
  recapAya: "",
  shareCardBlob: null,
  shareCardUrl: "",
  lastResult: null,
  lastResultOptions: null,
  lastTrials: 0,
  currentRecap: null
};

const $ = (id) => document.getElementById(id);
const format = (number) => Number(number || 0).toLocaleString(browserLocale(state.locale));
const formatDate = (value) => String(value || "—").replaceAll("-", ".");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

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

async function readJson(path, fallback) {
  try {
    const response = await fetch(path, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch {
    state.dataLoadErrors.push(path);
    return fallback;
  }
}

function getStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function requiredCount(part) {
  return Math.max(1, Math.floor(Number(part.required || part.quantity || 1)));
}

function ownedMap(itemId) {
  if (!state.owned[itemId]) state.owned[itemId] = new Map();
  return state.owned[itemId];
}

function ownedCount(itemId, partId) {
  return Math.max(0, Number(ownedMap(itemId).get(partId)) || 0);
}

function itemById(itemId) {
  return state.primeItems.find((item) => item.id === itemId);
}

function selectedItems() {
  return state.selectedItemIds.map(itemById).filter(Boolean);
}

function relicsForPart(itemId, partId) {
  return state.relics.filter((relic) => relic.rewards.some((reward) => (
    reward.itemId === itemId && reward.partId === partId
  )));
}

function raritiesForPart(itemId, partId, fallback) {
  const rarities = relicsForPart(itemId, partId).flatMap((relic) => relic.rewards
    .filter((reward) => reward.itemId === itemId && reward.partId === partId)
    .map((reward) => reward.rarity))
    .filter((rarity) => RARITIES[rarity]);
  return [...new Set(rarities.length ? rarities : [fallback])]
    .sort((left, right) => RARITIES[left].rank - RARITIES[right].rank);
}

function currentPrimeItems() {
  return selectedItems().map((item) => ({
    ...item,
    parts: item.parts.map((part) => ({
      ...part,
      ownedCount: Math.min(requiredCount(part), ownedCount(item.id, part.id))
    }))
  }));
}

function setStatus(text, isError = false) {
  const status = $("dataStatus");
  status.textContent = text;
  status.closest(".source-status")?.classList.toggle("is-error", isError);
}

function groupForType(type) {
  if (type === "warframe") return { id: "warframes", labelKey: "group.warframes", shortLabelKey: "type.warframe" };
  if (["primary", "secondary", "melee"].includes(type)) return { id: "weapons", labelKey: "group.weapons", shortLabelKey: "type.weapon" };
  return { id: "other", labelKey: "group.other", shortLabelKey: "type.other" };
}

function groupedPrimeItems(items) {
  const order = ["warframes", "weapons", "other"];
  const groups = new Map();
  for (const item of items) {
    const group = groupForType(item.type);
    if (!groups.has(group.id)) groups.set(group.id, { ...group, items: [] });
    groups.get(group.id).items.push(item);
  }
  return order.map((id) => groups.get(id)).filter(Boolean);
}

function renderRotation() {
  const rotation = state.rotation;
  $("rotationName").textContent = rotation?.displayName || message("rotation.empty");
  $("rotationIndex").textContent = rotation?.id || message("rotation.waiting");
  $("targetRotationTitle").textContent = state.previewMode ? message("target.previewTitle") : message("target.title");
  const featured = groupedPrimeItems(state.primeItems).map((group) => `
    <section class="rotation-group" aria-label="${escapeHtml(message(group.labelKey))}">
      <span class="rotation-group-label">${escapeHtml(message(group.labelKey))}</span>
      <div class="rotation-group-grid">
        ${group.items.map((item) => `<span class="rotation-chip">${escapeHtml(item.name)} <em>${escapeHtml(localizedTypeLabel(item.type))}</em></span>`).join("")}
      </div>
    </section>
  `).join("");
  $("rotationFeatured").innerHTML = featured || `<p class="rotation-empty">${escapeHtml(message("rotation.empty"))}</p>`;
}

function itemNamesForRotation(rotation) {
  const itemMap = new Map(state.allPrimeItems.map((item) => [item.id, item]));
  return (rotation?.items || []).map((id) => itemMap.get(id)).filter(Boolean);
}

function renderRotationSchedule(now = Date.now()) {
  const schedule = $("rotationSchedule");
  const preview = $("nextRotationPreview");
  const upcoming = state.realRotationState.nextRotation;
  const hasActive = Boolean(state.realRotationState.activeRotation);

  $("previewModeBanner").hidden = !state.previewMode;
  if (state.previewMode) {
    const key = state.rotation?.publicationStatus === "provisional"
      ? "status.provisionalPreviewWithId"
      : "status.previewWithId";
    $("previewModeText").textContent = message(key, { id: state.rotation?.id || state.previewId });
  }

  if (!upcoming) {
    schedule.classList.remove("is-imminent");
    schedule.classList.add("is-empty");
    $("rotationScheduleStatus").textContent = message("schedule.table");
    $("rotationCountdownLabel").textContent = message("schedule.nextNotAnnounced");
    $("rotationCountdown").textContent = "—";
    $("nextRotationTime").textContent = message("schedule.ongoing");
    $("nextRotationTime").removeAttribute("datetime");
    preview.hidden = true;
    return;
  }

  const remaining = getTimeUntilRotation(upcoming, now);
  schedule.classList.remove("is-empty");
  schedule.classList.toggle("is-imminent", remaining <= 24 * 60 * 60 * 1_000);
  $("rotationScheduleStatus").textContent = hasActive ? message("schedule.nextAnnounced") : message("schedule.firstUpcoming");
  $("rotationCountdownLabel").textContent = hasActive ? message("schedule.until") : message("schedule.firstUpcoming");
  $("rotationCountdown").textContent = formatRotationCountdown(remaining, state.locale);
  $("nextRotationTime").textContent = formatRotationLocalTime(upcoming.startsAt, browserLocale(state.locale));
  $("nextRotationTime").setAttribute("datetime", upcoming.startsAt);
  $("nextRotationPreviewName").textContent = upcoming.displayName || upcoming.id;
  $("nextRotationPreviewTime").textContent = formatRotationLocalTime(upcoming.startsAt, browserLocale(state.locale));
  $("nextRotationPreviewCountdown").textContent = formatRotationCountdown(remaining, state.locale);
  $("nextRotationPreviewItems").innerHTML = itemNamesForRotation(upcoming)
    .map((item) => `<li><span>${escapeHtml(item.name)}</span><em>${escapeHtml(localizedTypeLabel(item.type))}</em></li>`)
    .join("");
  preview.hidden = false;
}

function renderItemOptions() {
  $("targetOptions").innerHTML = state.primeItems.length
    ? groupedPrimeItems(state.primeItems).map((group) => `<section class="item-option-group">
      <div class="item-option-group-heading"><span>${escapeHtml(message(group.labelKey))}</span><em>${escapeHtml(message("target.group.count", { count: format(group.items.length) }))}</em></div>
      <div class="target-option-grid">
        ${group.items.map((item) => {
          const required = item.parts.reduce((sum, part) => sum + requiredCount(part), 0);
          const owned = item.parts.reduce((sum, part) => sum + Math.min(requiredCount(part), ownedCount(item.id, part.id)), 0);
          const selected = state.selectedItemIds.includes(item.id);
          const missing = Math.max(0, required - owned);
          const completion = Math.round((owned / Math.max(1, required)) * 100);
          return `<label class="target-option${selected ? " is-selected" : ""}">
            <input type="checkbox" data-item-id="${escapeHtml(item.id)}" ${selected ? "checked" : ""} />
            <span class="target-option-main">
              <span class="target-option-name">${escapeHtml(item.name)}</span>
            <span class="target-option-meta">${escapeHtml(message("target.itemParts", { type: localizedTypeLabel(item.type), count: item.parts.length }))}</span>
            </span>
            <span class="target-option-progress">${owned} / ${required}</span>
            <span class="target-option-status">${missing ? message("target.missing", { count: missing }) : message("target.completed")}</span>
            <span class="target-option-meter" aria-hidden="true"><span style="width: ${completion}%"></span></span>
          </label>`;
        }).join("")}
      </div>
    </section>`).join("")
    : `<p class="field-hint">${escapeHtml(message("target.noData"))}</p>`;
}

function renderCollections() {
  const items = selectedItems();
  $("collectionList").innerHTML = items.length
    ? items.map((item) => {
      const totalRequired = item.parts.reduce((sum, part) => sum + requiredCount(part), 0);
      const totalOwned = item.parts.reduce((sum, part) => sum + Math.min(requiredCount(part), ownedCount(item.id, part.id)), 0);
      const complete = totalOwned >= totalRequired;
      return `<section class="collection-card${complete ? " is-complete" : ""}">
        <div class="collection-card-heading">
          <div>
            <span class="collection-card-title">${escapeHtml(item.name)}</span>
            <span class="collection-card-subtitle">${escapeHtml(message("collection.subtitle", { type: localizedTypeLabel(item.type), owned: totalOwned, total: totalRequired }))}</span>
          </div>
          ${complete
            ? `<span class="complete-button">${escapeHtml(message("collection.complete"))}</span>`
            : `<button type="button" class="complete-button" data-complete-item="${escapeHtml(item.id)}">${escapeHtml(message("collection.ownAll"))}</button>`}
        </div>
        ${item.parts.map((part) => {
          const required = requiredCount(part);
          const count = Math.min(required, ownedCount(item.id, part.id));
          const isOwned = count >= required;
          const relicCount = relicsForPart(item.id, part.id).length;
          const rarityBadges = raritiesForPart(item.id, part.id, part.rarity)
            .map((rarity) => `<span class="rarity rarity-${escapeHtml(rarity)}">${escapeHtml(localizedRarityLabel(rarity))}</span>`)
            .join(" ");
          const checkboxId = `owned-${item.id}-${part.id}`;
          const quantityControl = required > 1 ? `<span class="part-quantity" aria-label="${escapeHtml(message("collection.partQuantity", { name: part.name }))}">
            <button type="button" data-item-id="${escapeHtml(item.id)}" data-part-id="${escapeHtml(part.id)}" data-part-delta="-1" aria-label="${escapeHtml(message("collection.decrease", { name: part.name }))}">−</button>
            <span>${count} / ${required}</span>
            <button type="button" data-item-id="${escapeHtml(item.id)}" data-part-id="${escapeHtml(part.id)}" data-part-delta="1" aria-label="${escapeHtml(message("collection.increase", { name: part.name }))}">+</button>
          </span>` : "";
          return `<div class="part-row${isOwned ? " is-owned" : ""}">
            <input id="${escapeHtml(checkboxId)}" type="checkbox" data-item-id="${escapeHtml(item.id)}" data-part-id="${escapeHtml(part.id)}" ${isOwned ? "checked" : ""} />
            <label class="part-name" for="${escapeHtml(checkboxId)}">${escapeHtml(part.name)}${required > 1 ? ` ×${required}` : ""}</label>
            ${quantityControl}
            <span class="part-rarities">${rarityBadges}</span>
            <span class="part-meta">${escapeHtml(message("collection.partMeta", { count: relicCount }))}</span>
          </div>`;
        }).join("")}
      </section>`;
    }).join("")
    : `<p class="field-hint">${escapeHtml(message("target.noSelection"))}</p>`;

  const selected = items.length;
  const totalParts = items.reduce((sum, item) => sum + item.parts.reduce((partSum, part) => partSum + requiredCount(part), 0), 0);
  const totalOwned = items.reduce((sum, item) => sum + item.parts.reduce((partSum, part) => (
    partSum + Math.min(requiredCount(part), ownedCount(item.id, part.id))
  ), 0), 0);
  $("targetCount").textContent = selected
    ? message("target.count", { count: selected, owned: totalOwned, total: totalParts })
    : message("target.none");
}

function persistCollection({ quiet = false } = {}) {
  if (state.previewMode || !state.rotation) {
    if (!quiet && state.previewMode) {
      setStatus(message(state.rotation?.publicationStatus === "provisional" ? "status.provisionalPreview" : "status.preview"));
    }
    return false;
  }
  const owned = Object.fromEntries(Object.entries(state.owned).map(([itemId, parts]) => [
    itemId,
    Object.fromEntries([...parts].filter(([, count]) => count > 0))
  ]));
  const saved = saveCollectionState(getStorage(), {
    rotationId: state.rotation.id,
    selectedItemIds: state.selectedItemIds,
    owned,
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

function bindEvents() {
  document.querySelectorAll("[data-locale-link]").forEach((link) => {
    link.addEventListener("click", () => {
      writeStoredLocale(getStorage(), link.dataset.localeLink);
    });
  });

  $("budgetJump")?.addEventListener("click", () => {
    $("planner")?.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => $("budget")?.focus(), 450);
  });

  $("targetOptions").addEventListener("change", (event) => {
    const itemId = event.target.dataset.itemId;
    if (!itemId) return;
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

  $("selectAllTargets").addEventListener("click", () => {
    state.selectedItemIds = state.primeItems.map((item) => item.id);
    persistCollection();
    renderItemOptions();
    renderCollections();
    scheduleRun();
  });

  $("clearTargets").addEventListener("click", () => {
    state.selectedItemIds = [];
    persistCollection();
    renderItemOptions();
    renderCollections();
    scheduleRun();
  });

  $("selectWarframes").addEventListener("click", () => {
    state.selectedItemIds = state.primeItems.filter((item) => item.type === "warframe").map((item) => item.id);
    persistCollection();
    renderItemOptions();
    renderCollections();
    scheduleRun();
  });

  $("selectWeapons").addEventListener("click", () => {
    state.selectedItemIds = state.primeItems.filter((item) => ["primary", "secondary", "melee"].includes(item.type)).map((item) => item.id);
    persistCollection();
    renderItemOptions();
    renderCollections();
    scheduleRun();
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
  $("observedAya")?.addEventListener("input", (event) => {
    state.recapAya = event.target.value;
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
  $("shareDownloadLink")?.addEventListener("click", (event) => {
    if (!state.shareCardBlob) event.preventDefault();
  });
}

function scheduleRun() {
  window.clearTimeout(state.runTimer);
  setResultsUpdating(true);
  state.runTimer = window.setTimeout(run, 80);
}

function setResultsUpdating(updating) {
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
      analysisCap: Math.min(120, Math.max(80, budget))
    }
  };
}

function finishRun(result, trials, completedRequest) {
  if (!isSimulationResponseCurrent(
    state.activeSimulation,
    completedRequest,
    state.rotation?.id || ""
  )) return;
  state.running = false;
  state.activeSimulation = null;
  if (state.pendingRun) {
    state.pendingRun = false;
    scheduleRun();
    return;
  }
  renderResult(result, trials, completedRequest?.options || {});
  setResultsUpdating(false);
  $("runButton").disabled = false;
  $("runButtonLabel").textContent = message("run.button");
}

function failRun(request = state.activeSimulation, failureKind = "simulation") {
  if (request && !isSimulationResponseCurrent(
    state.activeSimulation,
    request,
    state.rotation?.id || ""
  )) return;
  const rerunRequested = state.pendingRun;
  state.running = false;
  state.activeSimulation = null;
  state.pendingRun = false;
  $("runButton").disabled = false;
  $("runButtonLabel").textContent = message("run.button");
  setResultsUpdating(false);
  const failureMessage = failureKind === "unavailable"
    ? message("run.workerUnavailable")
    : failureKind === "timeout"
      ? message("run.timeout")
      : message("run.workerFailed");
  $("trialBadge").textContent = failureMessage;
  $("runCaption").textContent = failureMessage;
  schedulePendingRunAfterFailure(rerunRequested, scheduleRun);
}

function initSimulationWorker() {
  if (state.simulationClient) return;
  state.simulationClient = createSimulationWorkerClient({
    workerUrl: simulationWorkerUrl(),
    createWorker: (url) => {
      if (!("Worker" in window)) throw new Error("Worker unavailable");
      return new Worker(url, { type: "module" });
    },
    onResult: (result, completedRequest) => {
      if (!isSimulationResponseCurrent(state.activeSimulation, completedRequest, state.rotation?.id || "")) return;
      finishRun(result, completedRequest.trials, completedRequest);
    },
    onFailure: (failedRequest, failureKind) => failRun(failedRequest, failureKind),
    scheduleFrame: (callback) => window.requestAnimationFrame(callback),
    setTimer: (callback, delay) => window.setTimeout(callback, delay),
    clearTimer: (timer) => window.clearTimeout(timer)
  });
}

function run() {
  if (state.running) {
    state.pendingRun = true;
    return;
  }
  setResultsUpdating(true);
  const budgetValidation = validateSimulationBudget($("budget").value);
  if (!budgetValidation.valid) {
    showBudgetValidationError();
    return;
  }
  clearBudgetValidationError();
  const request = simulationOptions(budgetValidation.budget);
  if (!request.options.primeItems.length) {
    state.pendingRun = false;
    $("runButton").disabled = false;
    renderNoTargets();
    return;
  }
  state.running = true;
  state.pendingRun = false;
  const button = $("runButton");
  button.disabled = true;
  $("runButtonLabel").textContent = message("run.running");
  $("runCaption").textContent = message("run.running");
  const requestId = ++state.workerRequestId;
  const rotationId = state.rotation?.id || "";
  state.activeSimulation = { ...request, requestId, rotationId };
  const activeRequest = state.activeSimulation;
  initSimulationWorker();
  state.simulationClient.start(activeRequest);
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
  state.recapAya = "";
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
  state.shareCardBlob = null;
  if (state.shareCardUrl) {
    URL.revokeObjectURL(state.shareCardUrl);
    state.shareCardUrl = "";
  }
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function boxesOverlap(left, right, padding = 5) {
  return !(left.x + left.width + padding <= right.x
    || right.x + right.width + padding <= left.x
    || left.y + left.height + padding <= right.y
    || right.y + right.height + padding <= left.y);
}

function layoutBudgetLabels(markers, bounds) {
  const placed = [];
  const priority = { current: 0, p50: 1, p95: 2, p99: 3, p90: 4 };
  const ordered = [...markers].sort((left, right) => priority[left.id] - priority[right.id]);
  for (const marker of ordered) {
    if (!marker.showLabel) continue;
    const width = marker.id === "current" ? Math.min(138, bounds.width - 8) : marker.capped ? 76 : 64;
    const height = marker.id === "current" ? 42 : 34;
    const preferredDirection = marker.y < bounds.top + bounds.height * 0.32 ? 1 : -1;
    const verticalCandidates = [
      marker.y + preferredDirection * 49,
      marker.y - preferredDirection * 49,
      marker.y + preferredDirection * 88,
      marker.y - preferredDirection * 88
    ];
    for (let laneY = bounds.top + height / 2 + 4; laneY <= bounds.top + bounds.height - height / 2 - 4; laneY += height + 7) {
      verticalCandidates.push(laneY);
    }
    verticalCandidates.sort((left, right) => Math.abs(left - marker.y) - Math.abs(right - marker.y));
    const horizontalCandidates = [marker.x, marker.x - width * 0.7, marker.x + width * 0.7];
    let selected = null;
    for (const centerY of verticalCandidates) {
      for (const centerX of horizontalCandidates) {
        const box = {
          x: clamp(centerX - width / 2, bounds.left + 4, bounds.left + bounds.width - width - 4),
          y: clamp(centerY - height / 2, bounds.top + 4, bounds.top + bounds.height - height - 4),
          width,
          height
        };
        if (!placed.some((entry) => boxesOverlap(box, entry.box))) {
          selected = box;
          break;
        }
      }
      if (selected) break;
    }
    if (!selected) continue;
    marker.box = selected;
    placed.push({ marker, box: selected });
  }
  return markers;
}

function emptyBudgetChart(message) {
  const svg = $("budgetChart");
  const shell = $("budgetChartShell");
  if (!svg || !shell) return;
  const width = Math.max(260, Math.floor(shell.clientWidth || 800));
  const height = Math.max(260, Math.floor(shell.clientHeight || 330));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("aria-label", message);
  svg.innerHTML = `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" class="budget-axis-title">${escapeHtml(message)}</text>`;
  $("budgetMarkerLegend").innerHTML = "";
  $("budgetChartTooltip").hidden = true;
}

function renderBudgetDistribution(result, budget = Number($("budget").value) || 0, analysisCap = result?.analysisCap) {
  const renderStartedAt = performance.now();
  const currentBudget = Math.max(0, Math.floor(Number(budget) || 0));
  $("budgetKpiCurrent").textContent = localizedBudgetMarker(currentBudget, null);
  if (!result) {
    state.lastBudgetChart = null;
    $("budgetKpiProbability").textContent = "—";
    $("budgetKpiProbabilityNote").textContent = message("kpi.waiting");
    ["budgetKpiP50", "budgetKpiP95", "budgetKpiP99"].forEach((id) => { $(id).textContent = "—"; });
    emptyBudgetChart(message("chart.waiting"));
    return;
  }

  state.lastBudgetChart = { result, budget: currentBudget, analysisCap };
  $("budgetKpiProbability").textContent = formatProbabilityPrecise(result.finishProbability);
  $("budgetKpiProbabilityNote").textContent = localizedProbabilityDescriptor(result.finishProbability);
  $("budgetKpiP50").textContent = localizedBudgetMarker(result.p50, analysisCap);
  $("budgetKpiP95").textContent = localizedBudgetMarker(result.p95, analysisCap);
  $("budgetKpiP99").textContent = localizedBudgetMarker(result.p99, analysisCap);

  try {
    assertValidBudgetCurve(result.budgetCurve);
  } catch (error) {
    console.warn("Varzia budget curve validation failed", error);
    emptyBudgetChart(message("chart.validation"));
    return;
  }

  const svg = $("budgetChart");
  const shell = $("budgetChartShell");
  const tooltip = $("budgetChartTooltip");
  const width = Math.max(260, Math.floor(shell.clientWidth || 800));
  const height = Math.max(260, Math.floor(shell.clientHeight || 390));
  const mobile = width < 520;
  const margin = { top: 18, right: 14, bottom: 47, left: mobile ? 42 : 52 };
  const plot = {
    left: margin.left,
    top: margin.top,
    width: width - margin.left - margin.right,
    height: height - margin.top - margin.bottom
  };
  const curveCap = result.budgetCurve.at(-1).budget;
  const rightAnchor = Number.isFinite(result.p99) ? Math.max(currentBudget, result.p99) : curveCap;
  const xMargin = Math.max(2, Math.ceil(rightAnchor * 0.07));
  const maxX = Math.max(1, Math.min(curveCap, rightAnchor + xMargin));
  const visibleCurve = result.budgetCurve.filter((point) => point.budget <= maxX);
  const xFor = (aya) => plot.left + (clamp(aya, 0, maxX) / maxX) * plot.width;
  const yFor = (probability) => plot.top + (1 - clamp(probability, 0, 1)) * plot.height;
  const path = visibleCurve.map((point, index) => {
    const x = xFor(point.budget);
    const y = yFor(point.finishProbability);
    if (index === 0) return `M ${x.toFixed(2)} ${y.toFixed(2)}`;
    return `H ${x.toFixed(2)} V ${y.toFixed(2)}`;
  }).join(" ");
  const firstPoint = visibleCurve[0];
  const lastPoint = visibleCurve.at(-1);
  const areaPath = `${path} L ${xFor(lastPoint.budget).toFixed(2)} ${yFor(0).toFixed(2)} L ${xFor(firstPoint.budget).toFixed(2)} ${yFor(0).toFixed(2)} Z`;
  const yTicks = mobile ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1];
  const xTicks = [...new Set(Array.from({ length: mobile ? 4 : 6 }, (_, index) => (
    Math.round((maxX * index) / (mobile ? 3 : 5))
  )))];
  const pointAtBudget = (aya) => result.budgetCurve[Math.min(curveCap, Math.max(0, aya))];
  const markerSpecs = [
    { id: "current", label: message("chart.current"), budget: currentBudget, probability: result.finishProbability, showLabel: true },
    { id: "p50", label: "P50", budget: result.p50, target: 0.50, showLabel: true },
    { id: "p90", label: "P90", budget: result.p90, target: 0.90, showLabel: !mobile },
    { id: "p95", label: "P95", budget: result.p95, target: 0.95, showLabel: true },
    { id: "p99", label: "P99", budget: result.p99, target: 0.99, showLabel: true }
  ].map((marker) => {
    const capped = !Number.isFinite(marker.budget);
    const markerBudget = capped ? curveCap : marker.budget;
    const point = pointAtBudget(markerBudget);
    return {
      ...marker,
      capped,
      markerBudget,
      probability: marker.id === "current" ? marker.probability : point.finishProbability,
      x: xFor(Math.min(markerBudget, maxX)),
      y: yFor(marker.id === "current" ? marker.probability : point.finishProbability)
    };
  });
  layoutBudgetLabels(markerSpecs, plot);

  const gridMarkup = yTicks.map((tick) => {
    const y = yFor(tick);
    return `<line class="budget-grid-line" x1="${plot.left}" y1="${y}" x2="${plot.left + plot.width}" y2="${y}"></line>
      <text class="budget-axis-label" x="${plot.left - 8}" y="${y + 3}" text-anchor="end">${Math.round(tick * 100)}%</text>`;
  }).join("");
  const xAxisMarkup = xTicks.map((tick) => {
    const x = xFor(tick);
    return `<line class="budget-axis-line" x1="${x}" y1="${plot.top + plot.height}" x2="${x}" y2="${plot.top + plot.height + 4}"></line>
      <text class="budget-axis-label" x="${x}" y="${plot.top + plot.height + 17}" text-anchor="middle">${tick}</text>`;
  }).join("");
  const markerMarkup = [...markerSpecs].sort((left, right) => (
    Number(left.id === "current") - Number(right.id === "current")
  )).map((marker) => {
    const isCurrent = marker.id === "current";
    const labelValue = isCurrent
      ? `${localizedBudgetMarker(marker.markerBudget, null)} · ${formatProbabilityPrecise(marker.probability)}`
      : localizedBudgetMarker(marker.capped ? null : marker.markerBudget, marker.capped ? marker.markerBudget : null);
    const label = marker.box ? `<line class="budget-marker-line" x1="${marker.x}" y1="${marker.y}" x2="${marker.box.x + marker.box.width / 2}" y2="${marker.box.y + marker.box.height / 2}"></line>
      <rect class="budget-label-box${isCurrent ? " is-current" : ""}" x="${marker.box.x}" y="${marker.box.y}" width="${marker.box.width}" height="${marker.box.height}" rx="7"></rect>
      <text class="budget-label-kicker${isCurrent ? " is-current" : ""}" x="${marker.box.x + 8}" y="${marker.box.y + 13}">${escapeHtml(marker.label)}</text>
      <text class="budget-label-value" x="${marker.box.x + 8}" y="${marker.box.y + marker.box.height - 9}">${escapeHtml(labelValue)}</text>` : "";
    return `${label}<circle class="budget-marker-dot${isCurrent ? " is-current" : ""}" cx="${marker.x}" cy="${marker.y}" r="${isCurrent ? 5 : 3.5}"></circle>`;
  }).join("");
  const ariaLabel = message("chart.aria", {
    budget: format(currentBudget),
    probability: formatProbabilityPrecise(result.finishProbability),
    p95: localizedBudgetMarker(result.p95, analysisCap)
  });

  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("aria-label", ariaLabel);
  svg.innerHTML = `<title>${escapeHtml(ariaLabel)}</title>
    <desc>${escapeHtml(message("chart.desc"))}</desc>
    <defs><linearGradient id="budgetAreaGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--champagne-bright)" stop-opacity=".11"></stop><stop offset="1" stop-color="var(--champagne-bright)" stop-opacity=".015"></stop></linearGradient></defs>
    ${gridMarkup}
    <line class="budget-axis-line" x1="${plot.left}" y1="${plot.top + plot.height}" x2="${plot.left + plot.width}" y2="${plot.top + plot.height}"></line>
    ${xAxisMarkup}
    <text class="budget-axis-title" x="${plot.left}" y="11">${escapeHtml(message("chart.axisProbability"))}</text>
    <text class="budget-axis-title" x="${plot.left + plot.width / 2}" y="${height - 7}" text-anchor="middle">${escapeHtml(message("chart.axisBudget"))}</text>
    <path class="budget-area" d="${areaPath}"></path>
    <path class="budget-path" d="${path}"></path>
    <line class="budget-current-line" x1="${xFor(currentBudget)}" y1="${plot.top}" x2="${xFor(currentBudget)}" y2="${plot.top + plot.height}"></line>
    ${markerMarkup}
    <g id="budgetHoverMarker" visibility="hidden"><line class="budget-hover-line" x1="0" y1="${plot.top}" x2="0" y2="${plot.top + plot.height}"></line><circle class="budget-hover-dot" cx="0" cy="0" r="4"></circle></g>
    <rect class="budget-hit-target" x="${plot.left}" y="${plot.top}" width="${plot.width}" height="${plot.height}" tabindex="0" role="application" aria-label="${escapeHtml(message("chart.keyboard"))}"></rect>`;

  $("budgetMarkerLegend").innerHTML = [
    ["P50", result.p50], ["P90", result.p90], ["P95", result.p95], ["P99", result.p99]
  ].map(([label, value]) => `<span class="${Number.isFinite(value) ? "" : "is-capped"}"${Number.isFinite(value) ? "" : ` data-cap-note="${escapeHtml(message("chart.overCap"))}"`}><b>${label}</b><strong>${escapeHtml(localizedBudgetMarker(value, analysisCap))}</strong></span>`).join("");

  const hitTarget = svg.querySelector(".budget-hit-target");
  const hoverMarker = svg.querySelector("#budgetHoverMarker");
  const hoverLine = hoverMarker.querySelector("line");
  const hoverDot = hoverMarker.querySelector("circle");
  let activeBudget = currentBudget;
  const showPoint = (aya) => {
    activeBudget = clamp(Math.round(aya), 0, maxX);
    const point = pointAtBudget(activeBudget);
    const x = xFor(activeBudget);
    const y = yFor(point.finishProbability);
    hoverMarker.setAttribute("visibility", "visible");
    hoverLine.setAttribute("x1", x);
    hoverLine.setAttribute("x2", x);
    hoverDot.setAttribute("cx", x);
    hoverDot.setAttribute("cy", y);
    tooltip.hidden = false;
    tooltip.innerHTML = `<strong>${escapeHtml(message("chart.tooltip", { budget: format(activeBudget), probability: formatProbabilityPrecise(point.finishProbability) }))}</strong>`;
    const left = clamp((x / width) * shell.clientWidth + 10, 8, Math.max(8, shell.clientWidth - 166));
    const top = clamp((y / height) * shell.clientHeight - 58, 8, Math.max(8, shell.clientHeight - 58));
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  };
  hitTarget.addEventListener("pointermove", (event) => {
    const bounds = svg.getBoundingClientRect();
    const localX = (event.clientX - bounds.left) * (width / bounds.width);
    showPoint(((localX - plot.left) / plot.width) * maxX);
  });
  hitTarget.addEventListener("pointerdown", (event) => {
    const bounds = svg.getBoundingClientRect();
    const localX = (event.clientX - bounds.left) * (width / bounds.width);
    showPoint(((localX - plot.left) / plot.width) * maxX);
  });
  hitTarget.addEventListener("pointerleave", (event) => {
    if (event.pointerType === "mouse") {
      hoverMarker.setAttribute("visibility", "hidden");
      tooltip.hidden = true;
    }
  });
  hitTarget.addEventListener("focus", () => showPoint(currentBudget));
  hitTarget.addEventListener("blur", () => {
    hoverMarker.setAttribute("visibility", "hidden");
    tooltip.hidden = true;
  });
  hitTarget.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Home") showPoint(0);
    else if (event.key === "End") showPoint(maxX);
    else showPoint(activeBudget + (event.key === "ArrowRight" ? 1 : -1));
  });
  svg.dataset.renderMs = (performance.now() - renderStartedAt).toFixed(2);
}

function initBudgetChartResize() {
  if (!("ResizeObserver" in window)) return;
  const observer = new ResizeObserver(() => {
    window.clearTimeout(state.chartResizeTimer);
    state.chartResizeTimer = window.setTimeout(() => {
      if (state.lastBudgetChart && !state.running) {
        renderBudgetDistribution(
          state.lastBudgetChart.result,
          state.lastBudgetChart.budget,
          state.lastBudgetChart.analysisCap
        );
      }
    }, 50);
  });
  observer.observe($("budgetChartShell"));
  state.chartResizeObserver = observer;
}

function verdictFor(probability, result, budget) {
  if (probability >= 0.95) {
    return { label: message("verdict.lucky"), message: message("verdict.luckyMessage", { probability: formatProbability(probability) }) };
  }
  if (probability >= 0.90) {
    return { label: message("verdict.podium"), message: message("verdict.podiumMessage") };
  }
  if (probability >= 0.75) {
    return { label: message("verdict.advantage"), message: message("verdict.advantageMessage") };
  }
  if (probability >= 0.45) {
    return { label: message("verdict.coinflip"), message: message("verdict.coinflipMessage") };
  }
  const extra = result.p90 === null
    ? message("verdict.redExtraCap")
    : message("verdict.redExtraP90", { budget: format(result.p90) });
  return { label: message("verdict.red"), message: message("verdict.redMessage", { extra }) };
}

function renderResult(result, trials, options = {}) {
  const budget = Number(options.budget) || 0;
  const analysisCap = Number(options.analysisCap);
  const goal = Number($("goalLine").value) || 0.9;
  const goalBudget = goal === 0.5 ? result.p50 : goal === 0.95 ? result.p95 : goal === 0.99 ? result.p99 : result.p90;
  const displayProbability = state.mode === "goal" ? localizedBudgetMarker(goalBudget, analysisCap) : formatProbabilityPrecise(result.finishProbability);

  state.lastResult = result;
  state.lastResultOptions = options;
  state.lastTrials = trials;

  $("trialBadge").textContent = result.empty ? message("result.graduated") : `${format(trials)} ${unit("trial")}`;
  $("primaryResultLabel").textContent = state.mode === "goal"
    ? message("result.goal", { percent: Math.round(goal * 100) })
    : message("result.primary");
  $("finishProbability").textContent = displayProbability;
  $("finishDetail").textContent = result.empty
    ? message("result.emptyDetail")
    : state.mode === "goal"
      ? message("result.analysisDetail", { budget: localizedBudgetMarker(analysisCap, null) })
      : message("result.currentDetail", { budget: localizedBudgetMarker(budget, null) });
  $("probabilityBar").style.width = `${Math.max(0, Math.min(100, result.finishProbability * 100))}%`;
  $("meanAya").textContent = format(result.empty ? 0 : Math.ceil(result.averageAya));
  $("traceTotal").textContent = result.empty ? message("trace.zero") : message("trace.median", { count: format(result.medianTraces) });
  $("runCaption").textContent = result.empty ? message("run.completed") : message("run.updated", { trials: format(trials) });
  $("summaryTargets").textContent = `${format(result.summary?.itemCount)} ${unit("item")}`;
  $("summaryCompleted").textContent = `${format(result.summary?.completedItems)} / ${format(result.summary?.itemCount)}`;
  $("summaryRemaining").textContent = `${format(result.summary?.remainingParts)} ${unit("part")}`;
  $("summaryBudget").textContent = localizedBudgetMarker(result.summary?.budget, null);

  const verdict = $("verdict");
  if (result.empty) {
    $("resultStatus").textContent = message("result.graduated");
    $("resultSentence").textContent = message("result.finishedSentence");
    verdict.innerHTML = `<span class="verdict-mark" aria-hidden="true">✦</span><strong class="verdict-status">${escapeHtml(message("result.finishedVerdict"))}</strong><span>${escapeHtml(message("result.finishedAdvice"))}</span>`;
  } else if (result.finishProbability === 0) {
    const gaps = [
      ["P50", result.p50],
      ["P90", result.p90],
      ["P95", result.p95]
    ].filter(([, line]) => Number.isFinite(line) && line >= budget)
      .map(([label, line]) => message(`verdict.gap${label}`, { gap: format(line - budget) }));
    const gapMessage = gaps.length ? gaps.join(state.locale === "zh" ? "；" : "; ") : message("verdict.noStableLine");
    const status = message("verdict.zeroStatus");
    $("resultStatus").textContent = status;
    $("resultSentence").textContent = message("verdict.zeroSentence", { budget: format(budget), trials: format(trials) });
    verdict.innerHTML = `<span class="verdict-mark" aria-hidden="true">✦</span><strong class="verdict-status">${escapeHtml(status)}</strong><span>${escapeHtml(message("verdict.zeroMessage", { gaps: gapMessage }))}</span><span class="verdict-tail">${escapeHtml(message("verdict.zeroTail"))}</span>`;
  } else {
    const outcome = verdictFor(result.finishProbability, result, budget);
    $("resultStatus").textContent = outcome.label;
    $("resultSentence").textContent = result.p95 === null
      ? message("verdict.p95Missing", { budget: format(budget) })
      : budget < result.p95
        ? message("verdict.p95Short", { budget: format(budget), gap: format(result.p95 - budget) })
        : message("verdict.p95Reached", { budget: format(budget) });
    const insurance = result.p95 !== null && budget < result.p95
      ? `<span class="verdict-tail">${escapeHtml(message("verdict.p95ShortTail", { gap: format(result.p95 - budget) }))}</span>`
      : `<span class="verdict-tail">${escapeHtml(message("verdict.p95ReachedTail"))}</span>`;
    verdict.innerHTML = `<span class="verdict-mark" aria-hidden="true">✦</span><strong class="verdict-status">${outcome.label}</strong><span>${outcome.message}</span>${insurance}`;
  }

  renderBudgetDistribution(result, budget, result.analysisCap || analysisCap);

  $("timelineHeadline").textContent = result.empty
    ? message("timeline.emptyHeadline")
    : result.finishProbability === 0
      ? message("timeline.zeroHeadline", { trials: format(trials) })
      : message("timeline.normalHeadline", { trials: format(trials) });
  $("timelineDetail").textContent = result.empty
    ? message("timeline.emptyDetail")
    : result.finishProbability === 0
      ? message("timeline.zeroDetail")
      : message("timeline.normalDetail", { failed: format(result.timelines.failed) });
  $("timelineSuccess").textContent = result.empty ? "100%" : message("timeline.success", { count: format(result.timelines.success) });

  renderBreakdown();
  renderItemResults(result);
  renderRecommendation(result);
  renderPercentileDeltas(result, budget);
  $("sharePanel").hidden = false;
  $("recapPanel").hidden = false;
  renderGraduationRecap();
}

function renderPercentileDeltas(result, currentBudget) {
  const deltas = calculatePercentileDeltas({ currentBudget, percentiles: result });
  $("targetDeltaList").innerHTML = deltas.map((entry) => {
    const body = entry.status === "capped"
      ? message("delta.exceeds", { label: entry.label })
      : entry.status === "remaining"
        ? message("delta.remaining", { delta: format(entry.delta), label: entry.label })
        : message("delta.reached", { label: entry.label });
    const tone = entry.status === "remaining" ? "is-open" : entry.status === "capped" ? "is-capped" : "is-reached";
    return `<article class="target-delta-card ${tone}"><span class="target-delta-label">${escapeHtml(entry.label)}</span><strong>${escapeHtml(body)}</strong>${entry.status === "remaining" ? `<small>${escapeHtml(localizedBudgetMarker(entry.budget, null))}</small>` : ""}</article>`;
  }).join("");
}

function renderGraduationRecap() {
  const input = $("observedAya");
  const output = $("recapResult");
  if (!input || !output) return;
  if (!state.lastResult) {
    input.disabled = true;
    output.textContent = message("recap.waiting");
    state.currentRecap = null;
    return;
  }
  input.disabled = false;
  const value = input.value.trim();
  if (!value) {
    output.textContent = message("recap.waiting");
    state.currentRecap = null;
    return;
  }
  const recap = calculateGraduationRecap({ curve: state.lastResult.budgetCurve, observedAya: value });
  state.currentRecap = recap;
  if (recap.status !== "ok") {
    output.innerHTML = `<span class="recap-result-status is-outside">${escapeHtml(message("recap.outside"))}</span>`;
    return;
  }
  const percentile = formatRecapPercent(recap.faceBlackIndex);
  const beat = formatRecapPercent(recap.beatPercentage);
  const band = message(`recap.band.${recap.band}`);
  const description = recap.percentile < 0.1
    ? message("recap.luckyMessage", { aya: format(recap.observedAya), value: beat })
    : message("recap.message", { value: percentile });
  output.innerHTML = `<div class="recap-result-heading"><strong>${escapeHtml(band)}</strong><span>${escapeHtml(message("recap.index", { value: percentile }))}</span><span>${escapeHtml(message("recap.beat", { value: beat }))}</span></div><p>${escapeHtml(description)}</p>`;
}

function shareCardLabels() {
  return {
    brand: "VARZIA",
    subtitle: message("share.cardSubtitle"),
    rotation: message("share.cardRotation"),
    targets: message("share.cardTargets"),
    targetUnit: message("share.cardTargetUnit"),
    currentAya: message("share.cardCurrentAya"),
    probability: message("share.cardProbability"),
    percentile: message("share.cardPercentile"),
    squad: message("share.cardSquad"),
    simulations: message("share.cardSimulations"),
    recap: message("share.cardRecap"),
    faceBlack: message("share.cardFaceBlack"),
    beat: message("share.cardBeat"),
    overCap: message("share.cardOverCap")
  };
}

function shareFilename() {
  const id = state.rotation?.id || "rotation";
  return `varzia-${state.locale}-${id}-result.png`;
}

async function generateShareCard() {
  if (!state.lastResult) {
    $("shareStatus").textContent = message("share.needsResult");
    return;
  }
  const button = $("shareResultButton");
  const status = $("shareStatus");
  button.disabled = true;
  status.textContent = message("share.generating");
  try {
    const result = state.lastResult;
    const model = buildShareCardModel({
      locale: state.locale,
      rotationName: state.rotation?.displayName || state.rotation?.id,
      itemCount: result.summary?.itemCount,
      currentBudget: state.lastResultOptions?.budget,
      finishProbability: result.finishProbability,
      percentiles: result,
      analysisCap: result.analysisCap || state.lastResultOptions?.analysisCap,
      squad: state.squad,
      trials: state.lastTrials,
      recap: state.currentRecap,
      labels: shareCardLabels()
    });
    const svg = renderShareCardSvg(model);
    const png = await svgToPngBlob(svg);
    state.shareCardBlob = png;
    if (state.shareCardUrl) URL.revokeObjectURL(state.shareCardUrl);
    state.shareCardUrl = URL.createObjectURL(png);
    const preview = $("sharePreview");
    const image = $("sharePreviewImage");
    const link = $("shareDownloadLink");
    image.src = state.shareCardUrl;
    link.href = state.shareCardUrl;
    link.download = shareFilename();
    preview.hidden = false;
    status.textContent = message("share.success");

    const canUseSystemShare = typeof navigator !== "undefined"
      && typeof navigator.share === "function"
      && typeof File === "function";
    if (canUseSystemShare) {
      const file = new File([png], shareFilename(), { type: "image/png" });
      const canShare = typeof navigator.canShare !== "function"
        || navigator.canShare({ files: [file] });
      if (!canShare) return;
      try {
        const sharePromise = navigator.share({ title: message("share.title"), text: message("share.subtitle"), files: [file] });
        button.disabled = false;
        await sharePromise;
      } catch (error) {
        if (error?.name === "AbortError") status.textContent = message("share.canceled");
      }
    }
  } catch (error) {
    console.warn("Varzia share card generation failed", error);
    status.textContent = message("share.failed");
  } finally {
    button.disabled = false;
  }
}

function renderBreakdown() {
  const body = $("breakdownBody");
  const missing = currentPrimeItems().flatMap((item) => item.parts
    .filter((part) => part.ownedCount < requiredCount(part))
    .map((part) => ({ ...part, item, missingCount: requiredCount(part) - part.ownedCount })));
  if (!missing.length) {
    body.innerHTML = `<tr><td class="empty-row" colspan="5">${escapeHtml(message("breakdown.noMissing"))}</td></tr>`;
    return;
  }
  const strategy = $("strategy").value;
  const squad = state.squad;
  body.innerHTML = missing.map(({ item, missingCount, ...part }) => {
    const routes = relicsForPart(item.id, part.id).map((relic) => {
      const reward = relic.rewards.find((candidate) => candidate.itemId === item.id && candidate.partId === part.id);
      const rarity = reward?.rarity || part.rarity;
      const refinement = refinementFor(rarity, strategy);
      const chance = squadChance(RARITIES[rarity]?.rates[refinement] || 0, squad);
      return { relic, rarity, refinement, chance };
    }).sort((left, right) => right.chance - left.chance || left.relic.name.localeCompare(right.relic.name, "zh-CN"));
    const bestRoute = routes[0];
    const rarity = bestRoute?.rarity || part.rarity;
    const refinement = bestRoute?.refinement || refinementFor(rarity, strategy);
    const chance = bestRoute?.chance || 0;
    const routeLabel = routes.map((route) => route.relic.name).join(" / ");
    const quantityLabel = missingCount > 1 ? ` ×${missingCount}` : "";
    const label = state.selectedItemIds.length > 1 ? `${item.name} · ${part.name}${quantityLabel}` : `${part.name}${quantityLabel}`;
    return `<tr>
      <td data-label="${escapeHtml(message("breakdown.missing"))}">${escapeHtml(label)}${routeLabel ? `<small class="table-route">${escapeHtml(routeLabel)}</small>` : ""}</td>
      <td data-label="${escapeHtml(message("breakdown.rarity"))}"><span class="rarity rarity-${escapeHtml(rarity)}">${escapeHtml(localizedRarityLabel(rarity))}</span></td>
      <td data-label="${escapeHtml(message("breakdown.refinement"))}">${escapeHtml(localizedRefinementLabel(refinement))}</td>
      <td data-label="${escapeHtml(message("breakdown.chance"))}">${(chance * 100).toFixed(2)}%</td>
      <td data-label="${escapeHtml(message("breakdown.average"))}">${chance ? (1 / chance).toFixed(2) : "—"} ${unit("relic")}</td>
    </tr>`;
  }).join("");
}

function renderItemResults(result) {
  $("targetResultList").innerHTML = result.itemProbabilities?.length
    ? result.itemProbabilities.map((item) => `<div class="target-result-row">
      <span class="target-result-name">${escapeHtml(item.name)}</span>
      <span class="target-result-probability">${escapeHtml(message("targetBoard.itemProbability", { probability: formatProbability(item.probability) }))}</span>
    </div>`).join("")
    : `<p class="field-hint">${escapeHtml(message("targetBoard.empty"))}</p>`;
}

function renderRecommendation(result) {
  const recommendation = result.recommendation || { items: [], totalAya: 0 };
  $("recommendationAya").textContent = recommendation.items.length
    ? message("recommendation.total", { count: format(recommendation.totalAya) })
    : message("recommendation.none");
  $("recommendationList").innerHTML = recommendation.items.length
    ? recommendation.items.map((item) => {
      const tokens = Array.from({ length: Math.min(item.count, 8) }, () => `<i class="aya-token" aria-hidden="true"></i>`).join("");
      return `<div class="recommendation-row">
        <div class="recommendation-main">
          <strong>${escapeHtml(item.name)}</strong>
          <span>${escapeHtml(message("recommendation.item", { rewards: format(item.rewardCount), items: format(item.itemCount) }))}</span>
        </div>
        <div class="aya-stack"><span class="aya-tokens">${tokens}</span><span>× ${format(item.count)}</span></div>
      </div>`;
    }).join("")
    : `<p class="field-hint">${escapeHtml(message("recommendation.empty"))}</p>`;

}

function cancelActiveSimulation() {
  window.clearTimeout(state.runTimer);
  state.runTimer = null;
  state.simulationClient?.cancel(state.activeSimulation);
  state.workerRequestId += 1;
  state.activeSimulation = null;
  state.running = false;
  state.pendingRun = false;
  $("runButton").disabled = false;
  $("runButtonLabel").textContent = message("run.button");
  setResultsUpdating(false);
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
  $("budgetHint").textContent = rotation
    ? message("budget.savedHint", { budget: format(defaultAyaBudget) })
    : message("status.waitingFirstRotation");

  renderRotation();
  renderItemOptions();
  renderCollections();
  renderRotationSchedule();
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

function scheduleRotationWatcher(now = Date.now()) {
  window.clearTimeout(state.rotationTimer);
  state.rotationTimer = null;
  const nextRotation = state.realRotationState.nextRotation;
  if (!nextRotation) return;
  const remaining = getTimeUntilRotation(nextRotation, now);
  if (remaining <= 0) {
    state.rotationTimer = window.setTimeout(() => checkForRotationChange(Date.now()), 0);
    return;
  }
  state.rotationTimer = window.setTimeout(
    () => checkForRotationChange(Date.now()),
    countdownUpdateDelay(remaining)
  );
}

function checkForRotationChange(now = Date.now()) {
  if (state.dataLoadErrors.length) return;
  let view = resolveRotationView(state.publishedRotations, now, state.previewId, state.rotations);
  if (view.invalidPreviewId) {
    if (!state.invalidPreviewWarned) {
      console.warn(`Varzia rotation preview not found: ${view.invalidPreviewId}`);
      state.invalidPreviewWarned = true;
    }
    state.previewId = "";
    view = resolveRotationView(state.publishedRotations, now, "", state.rotations);
  }

  state.realRotationState = {
    activeRotation: view.activeRotation,
    nextRotation: view.nextRotation,
    previousRotation: view.previousRotation
  };
  const displayChanged = (state.rotation?.id || "") !== (view.displayRotation?.id || "")
    || state.previewMode !== view.isPreview;
  if (displayChanged) {
    applyRotation(view.displayRotation, { preview: view.isPreview, announce: true });
  } else {
    renderRotationSchedule(now);
  }
  scheduleRotationWatcher(now);
}

function clearRotationWatcher() {
  window.clearTimeout(state.rotationTimer);
  state.rotationTimer = null;
}

function bindRotationLifecycle() {
  if (state.lifecycleBound) return;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkForRotationChange(Date.now());
  });
  window.addEventListener("pageshow", () => checkForRotationChange(Date.now()));
  window.addEventListener("focus", () => checkForRotationChange(Date.now()));
  window.addEventListener("pagehide", clearRotationWatcher);
  window.addEventListener("beforeunload", clearRotationWatcher);
  state.lifecycleBound = true;
}

async function loadData() {
  if (!ensureLocaleRoute()) return;
  try {
    const localeMessages = await loadLocaleMessages(state.locale);
    setLocaleMessages(state.locale, localeMessages, localeMessages);
    state.localeMessages = localeMessages;
  } catch (error) {
    console.warn("Varzia locale data failed to load", error);
    setLocaleMessages(state.locale, {}, {});
    state.localeMessages = {};
  }
  applyStaticTranslations();
  state.dataLoadErrors = [];
  const [scheduleData, primes, relicData] = await Promise.all([
    readJson("/data/rotation.json", fallbackSchedule),
    readJson("/data/primes.json", { primeItems: [] }),
    readJson("/data/relics.json", { relics: [] })
  ]);
  try {
    validateRotationData(scheduleData, primes, relicData);
  } catch (error) {
    console.warn("Varzia rotation data validation failed", error);
    state.dataLoadErrors.push("data-validation");
  }

  state.scheduleData = state.dataLoadErrors.length ? fallbackSchedule : scheduleData;
  const displayData = localizeDisplayData({
    rotations: state.scheduleData.rotations || [],
    primeItems: state.dataLoadErrors.length ? [] : (primes?.primeItems || []),
    relics: state.dataLoadErrors.length ? [] : (relicData?.relics || [])
  }, state.locale);
  state.rotations = displayData.rotations;
  state.publishedRotations = publishedRotations(state.rotations);
  state.allPrimeItems = displayData.primeItems;
  state.allRelics = displayData.relics;
  state.previewId = new URLSearchParams(window.location.search).get("rotation")?.trim() || "";

  let view = resolveRotationView(state.publishedRotations, Date.now(), state.previewId, state.rotations);
  if (view.invalidPreviewId) {
    console.warn(`Varzia rotation preview not found: ${view.invalidPreviewId}`);
    state.invalidPreviewWarned = true;
    state.previewId = "";
    view = resolveRotationView(state.publishedRotations, Date.now(), "", state.rotations);
  }
  state.realRotationState = {
    activeRotation: view.activeRotation,
    nextRotation: view.nextRotation,
    previousRotation: view.previousRotation
  };
  applyRotation(view.displayRotation, { preview: view.isPreview, scheduleSimulation: false });

  $("dataUpdatedAt").textContent = formatDate([
    scheduleData?.lastVerified,
    primes?.updatedAt,
    relicData?.updatedAt
  ].filter(Boolean).sort().at(-1));
  if (state.dataLoadErrors.length) {
    setStatus(message("status.dataError"), true);
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
