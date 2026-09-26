import { escapeHtml } from "./dom-helpers.js";
import { browserLocale } from "./i18n.js";
import {
  countdownUpdateDelay,
  formatRotationCountdown,
  formatRotationLocalTime,
  getTimeUntilRotation,
  resolveRotationView
} from "./rotation-schedule.js";

export function selectAnnouncementPreview(candidates) {
  return (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => candidate?.status === "announced" && candidate.relicDataStatus === "pending" && candidate.verified === false)
    .sort((left, right) => (
      String(left.effectiveAt || left.effectiveDate || "9999-12-31").localeCompare(String(right.effectiveAt || right.effectiveDate || "9999-12-31"))
        || left.id.localeCompare(right.id)
    ))[0] || null;
}

/** Coordinates schedule presentation and timer events; rotation adoption stays
 * with the application because it also switches collection and session state. */
export function createRotationUiController({
  getSnapshot,
  clearPreviewId,
  onView,
  applyRotation,
  stopSessionTicker,
  $,
  message,
  localizedTypeLabel,
  browser = globalThis.window,
  document = globalThis.document,
  clock = () => Date.now(),
  setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimer = (timer) => globalThis.clearTimeout(timer),
  warn = (text) => console.warn(text)
}) {
  let rotationTimer = null;
  let lifecycleBound = false;
  let invalidPreviewWarned = false;

  function itemNamesForRotation(rotation, allPrimeItems) {
    const itemMap = new Map(allPrimeItems.map((item) => [item.id, item]));
    return (rotation?.items || []).map((id) => itemMap.get(id)).filter(Boolean);
  }

  function formatUtcTimestamp(timestamp) {
    return typeof timestamp === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(timestamp)
      ? `${timestamp.slice(0, 16).replace("T", " ")} UTC`
      : message("schedule.timePending");
  }

  function renderRotationSchedule(now = clock()) {
    const state = getSnapshot();
    const schedule = $("rotationSchedule");
    const preview = $("nextRotationPreview");
    const upcoming = state.realRotationState.nextRotation;
    const announcement = upcoming ? null : state.announcementPreview;
    const displayedUpcoming = upcoming || announcement;
    const hasActive = Boolean(state.realRotationState.activeRotation);

    $("previewModeBanner").hidden = !state.previewMode;
    if (state.previewMode) {
      const key = state.rotation?.publicationStatus === "provisional"
        ? "status.provisionalPreviewWithId"
        : "status.previewWithId";
      $("previewModeText").textContent = message(key, { id: state.rotation?.id || state.previewId });
    }

    if (!displayedUpcoming) {
      schedule.classList.remove("is-imminent");
      schedule.classList.add("is-empty");
      $("rotationScheduleStatus").textContent = message("schedule.table");
      $("rotationCountdownLabel").textContent = message("schedule.nextNotAnnounced");
      $("rotationCountdown").textContent = "—";
      $("nextRotationTime").textContent = message("schedule.ongoing");
      $("nextRotationTime").removeAttribute("datetime");
      $("nextRotationPreviewNotice").hidden = true;
      preview.hidden = true;
      return;
    }

    if (announcement) {
      const hasEffectiveAt = Boolean(announcement.effectiveAt);
      const remaining = hasEffectiveAt ? getTimeUntilRotation({ startsAt: announcement.effectiveAt }, now) : 0;
      schedule.classList.remove("is-empty");
      schedule.classList.toggle("is-imminent", hasEffectiveAt && remaining <= 24 * 60 * 60 * 1_000);
      $("rotationScheduleStatus").textContent = message("schedule.nextAnnounced");
      $("rotationCountdownLabel").textContent = hasEffectiveAt ? message("schedule.starts") : message("schedule.timePending");
      $("rotationCountdown").textContent = hasEffectiveAt ? formatRotationCountdown(remaining, state.locale) : "—";
      $("nextRotationTime").textContent = formatUtcTimestamp(announcement.effectiveAt);
      if (hasEffectiveAt) $("nextRotationTime").setAttribute("datetime", announcement.effectiveAt);
      else $("nextRotationTime").removeAttribute("datetime");
      $("nextRotationPreviewName").textContent = announcement.primeWarframes.join(" & ");
      $("nextRotationPreviewTime").textContent = formatUtcTimestamp(announcement.effectiveAt);
      $("nextRotationPreviewCountdown").textContent = hasEffectiveAt ? formatRotationCountdown(remaining, state.locale) : "—";
      $("nextRotationPreviewItems").innerHTML = announcement.primeWarframes
        .map((name) => `<li><span>${escapeHtml(name)}</span><em>${escapeHtml(message("schedule.primeWarframe"))}</em></li>`)
        .join("");
      $("nextRotationPreviewNotice").textContent = `${message("schedule.officiallyAnnounced")} ${message("schedule.relicDataPending")}`;
      $("nextRotationPreviewNotice").hidden = false;
      preview.hidden = false;
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
    $("nextRotationPreviewItems").innerHTML = itemNamesForRotation(upcoming, state.allPrimeItems)
      .map((item) => `<li><span>${escapeHtml(item.name)}</span><em>${escapeHtml(localizedTypeLabel(item.type))}</em></li>`)
      .join("");
    $("nextRotationPreviewNotice").hidden = true;
    preview.hidden = false;
  }

  function resolveView(now = clock()) {
    const state = getSnapshot();
    let view = resolveRotationView(state.publishedRotations, now, state.previewId, state.rotations);
    if (view.invalidPreviewId) {
      if (!invalidPreviewWarned) {
        warn(`Varzia rotation preview not found: ${view.invalidPreviewId}`);
        invalidPreviewWarned = true;
      }
      clearPreviewId();
      view = resolveRotationView(state.publishedRotations, now, "", state.rotations);
    }
    onView(view);
    return view;
  }

  function scheduleRotationWatcher(now = clock()) {
    clearTimer(rotationTimer);
    rotationTimer = null;
    const nextRotation = getSnapshot().realRotationState.nextRotation;
    if (!nextRotation) return;
    const remaining = getTimeUntilRotation(nextRotation, now);
    if (remaining <= 0) {
      rotationTimer = setTimer(() => checkForRotationChange(clock()), 0);
      return;
    }
    rotationTimer = setTimer(
      () => checkForRotationChange(clock()),
      countdownUpdateDelay(remaining)
    );
  }

  function checkForRotationChange(now = clock()) {
    if (getSnapshot().dataLoadErrors.length) return;
    const view = resolveView(now);
    const state = getSnapshot();
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
    clearTimer(rotationTimer);
    rotationTimer = null;
    stopSessionTicker();
  }

  function bindRotationLifecycle() {
    if (lifecycleBound) return;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") checkForRotationChange(clock());
    });
    browser.addEventListener("pageshow", () => checkForRotationChange(clock()));
    browser.addEventListener("focus", () => checkForRotationChange(clock()));
    browser.addEventListener("pagehide", clearRotationWatcher);
    browser.addEventListener("beforeunload", clearRotationWatcher);
    lifecycleBound = true;
  }

  return {
    renderRotationSchedule,
    scheduleRotationWatcher,
    checkForRotationChange,
    clearRotationWatcher,
    bindRotationLifecycle,
    resolveView
  };
}
