import test from "node:test";
import assert from "node:assert/strict";
import { createRotationUiController, selectAnnouncementPreview } from "../js/rotation-ui-controller.js";

const rotations = [
  { id: "a", displayName: "Rotation A", publicationStatus: "published", startsAt: "2026-08-01T18:00:00Z", items: ["ember"] },
  { id: "b", displayName: "Rotation B", publicationStatus: "published", startsAt: "2026-09-01T18:00:00Z", items: ["frost"] },
  { id: "preview", displayName: "Provisional", publicationStatus: "provisional", startsAt: "2026-10-01T18:00:00Z", items: ["ember"] }
];
const boundary = Date.parse(rotations[1].startsAt);

function eventTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(callback);
    },
    emit(name) { for (const callback of listeners.get(name) || []) callback(); }
  };
}

function element() {
  const classes = new Set();
  const attributes = new Map();
  return {
    hidden: false, textContent: "", innerHTML: "", attributes,
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }
    },
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name)
  };
}

function harness({ now = boundary - 10_000, previewId = "", announcementPreview = null } = {}) {
  let timestamp = now;
  let nextTimer = 0;
  let tickerStops = 0;
  const state = {
    rotation: null,
    previewMode: false,
    previewId,
    realRotationState: { activeRotation: null, nextRotation: null, previousRotation: null },
    announcementPreview,
    allPrimeItems: [
      { id: "ember", name: "Ember Prime", type: "warframe" },
      { id: "frost", name: "Frost <Prime>", type: "warframe" }
    ],
    locale: "en",
    dataLoadErrors: [],
    publishedRotations: rotations.filter((rotation) => rotation.publicationStatus === "published"),
    rotations
  };
  const nodes = new Map();
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id);
  };
  const browser = eventTarget();
  const document = { ...eventTarget(), visibilityState: "visible" };
  const timers = new Map();
  const applied = [];
  const views = [];
  const warnings = [];
  const controller = createRotationUiController({
    getSnapshot: () => state,
    clearPreviewId: () => { state.previewId = ""; },
    onView: (view) => {
      views.push(view);
      state.realRotationState = {
        activeRotation: view.activeRotation,
        nextRotation: view.nextRotation,
        previousRotation: view.previousRotation
      };
    },
    applyRotation: (rotation, options) => {
      applied.push({ rotation, options });
      state.rotation = rotation;
      state.previewMode = options.preview;
      controller.renderRotationSchedule(timestamp);
    },
    stopSessionTicker: () => { tickerStops += 1; },
    $,
    message: (key, params) => params ? `${key}:${JSON.stringify(params)}` : key,
    localizedTypeLabel: (type) => `type.${type}`,
    browser,
    document,
    clock: () => timestamp,
    setTimer: (callback, delay) => {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    warn: (text) => warnings.push(text)
  });
  return {
    controller, state, $, browser, document, timers, applied, views, warnings,
    setNow: (next) => { timestamp = next; },
    get tickerStops() { return tickerStops; },
    fireTimer(nextTimestamp) {
      timestamp = nextTimestamp;
      assert.equal(timers.size, 1);
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      timer.callback();
    }
  };
}

test("the published active rotation advances at its boundary and provisional data stays out of the schedule", () => {
  const h = harness({ now: boundary - 1 });
  h.controller.checkForRotationChange();
  assert.equal(h.state.rotation.id, "a");
  assert.equal(h.state.realRotationState.nextRotation.id, "b");
  assert.equal([...h.timers.values()][0].delay, 1);
  h.fireTimer(boundary);
  assert.equal(h.state.rotation.id, "b");
  assert.equal(h.state.realRotationState.previousRotation.id, "a");
  assert.equal(h.state.realRotationState.nextRotation, null);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.applied.at(-1).options, { preview: false, announce: true });
});

test("an explicit provisional preview stays pinned while the real active rotation advances", () => {
  const h = harness({ now: boundary - 1, previewId: "preview" });
  h.controller.checkForRotationChange();
  assert.equal(h.state.rotation.id, "preview");
  assert.equal(h.state.previewMode, true);
  assert.equal(h.$("previewModeBanner").hidden, false);
  assert.match(h.$("previewModeText").textContent, /status.provisionalPreviewWithId/);
  h.fireTimer(boundary);
  assert.equal(h.state.rotation.id, "preview");
  assert.equal(h.state.realRotationState.activeRotation.id, "b");
  assert.equal(h.applied.length, 1);
  assert.equal(h.timers.size, 0);
});

test("route preview changes supplied by the caller select a new preview or return to the active rotation", () => {
  const h = harness({ now: boundary + 1 });
  h.controller.checkForRotationChange();
  h.state.previewId = "a";
  h.controller.checkForRotationChange();
  assert.equal(h.state.rotation.id, "a");
  assert.equal(h.state.previewMode, true);
  h.state.previewId = "preview";
  h.controller.checkForRotationChange();
  assert.equal(h.state.rotation.id, "preview");
  h.state.previewId = "";
  h.controller.checkForRotationChange();
  assert.equal(h.state.rotation.id, "b");
  assert.equal(h.state.previewMode, false);
  assert.equal(h.$("previewModeBanner").hidden, true);
});

test("invalid preview IDs clear to the real schedule and warn once across bootstrap and later checks", () => {
  const h = harness({ previewId: "missing" });
  const view = h.controller.resolveView();
  assert.equal(view.displayRotation.id, "a");
  assert.equal(view.isPreview, false);
  assert.equal(h.state.previewId, "");
  assert.deepEqual(h.warnings, ["Varzia rotation preview not found: missing"]);
  h.state.previewId = "also-missing";
  h.controller.checkForRotationChange();
  assert.equal(h.state.previewId, "");
  assert.equal(h.state.rotation.id, "a");
  assert.equal(h.warnings.length, 1);
});

test("countdown rendering keeps locale, escaped markup, and minute/second timer cadence", () => {
  const h = harness({ now: boundary - 2 * 24 * 60 * 60 * 1000 });
  h.controller.checkForRotationChange();
  assert.equal(h.$("rotationCountdown").textContent, "2d 00:00");
  assert.equal([...h.timers.values()][0].delay, 60_000);
  assert.equal(h.$("rotationSchedule").classList.contains("is-imminent"), false);
  assert.equal(h.$("nextRotationTime").attributes.get("datetime"), rotations[1].startsAt);
  assert.equal(h.$("nextRotationPreviewItems").innerHTML, "<li><span>Frost &lt;Prime&gt;</span><em>type.warframe</em></li>");
  h.state.locale = "zh";
  h.controller.renderRotationSchedule();
  assert.equal(h.$("rotationCountdown").textContent, "2 天 00:00");
  h.setNow(boundary - 1500);
  h.controller.checkForRotationChange();
  assert.equal(h.$("rotationCountdown").textContent, "00:00:02");
  assert.equal(h.$("rotationSchedule").classList.contains("is-imminent"), true);
  assert.equal([...h.timers.values()][0].delay, 1000);
  h.fireTimer(boundary - 500);
  assert.equal(h.$("rotationCountdown").textContent, "00:00:01");
  assert.equal([...h.timers.values()][0].delay, 500);
  assert.equal(h.applied.length, 1);
});

test("an announcement candidate is a display-only preview even after its announced date", () => {
  const candidate = {
    id: "announcement", status: "announced", relicDataStatus: "pending", verified: false,
    effectiveAt: "2026-09-08T18:00:00Z", primeWarframes: ["Ember Prime", "Frost <Prime>"]
  };
  const h = harness({ now: boundary + 1, announcementPreview: candidate });
  h.controller.checkForRotationChange();
  assert.equal(h.state.rotation.id, "b");
  assert.equal(h.state.realRotationState.nextRotation, null);
  assert.equal(h.$("nextRotationPreviewName").textContent, "Ember Prime & Frost <Prime>");
  assert.equal(h.$("nextRotationPreviewNotice").hidden, false);
  assert.equal(h.$("nextRotationPreviewNotice").textContent, "schedule.officiallyAnnounced schedule.relicDataPending");
  assert.equal(h.$("nextRotationPreviewTime").textContent, "2026-09-08 18:00 UTC");
  assert.match(h.$("nextRotationPreviewItems").innerHTML, /Frost &lt;Prime&gt;/);
  assert.equal(h.timers.size, 0);
  h.setNow(Date.parse(candidate.effectiveAt) + 1);
  h.controller.checkForRotationChange();
  assert.equal(h.state.rotation.id, "b");
  assert.equal(h.state.previewMode, false);
  assert.equal(h.$("rotationCountdown").textContent, "00:00:00");
  assert.equal(h.timers.size, 0);
  assert.equal(h.applied.length, 1);
});

test("announcement selection retains its pending/unverified filter and deterministic date/id ordering", () => {
  const candidates = [
    { id: "later", status: "announced", relicDataStatus: "pending", verified: false, effectiveDate: "2026-09-09" },
    { id: "b", status: "announced", relicDataStatus: "pending", verified: false, effectiveDate: "2026-09-08" },
    { id: "a", status: "announced", relicDataStatus: "pending", verified: false, effectiveDate: "2026-09-08" },
    { id: "verified", status: "announced", relicDataStatus: "pending", verified: true, effectiveDate: "2026-01-01" },
    { id: "ready", status: "announced", relicDataStatus: "ready", verified: false, effectiveDate: "2026-01-01" },
    { id: "draft", status: "draft", relicDataStatus: "pending", verified: false, effectiveDate: "2026-01-01" }
  ];
  assert.equal(selectAnnouncementPreview(candidates).id, "a");
  assert.equal(candidates[0].id, "later");
  assert.equal(selectAnnouncementPreview(undefined), null);
  const h = harness({ now: boundary + 1, announcementPreview: candidates[2] });
  h.state.announcementPreview = { ...candidates[2], primeWarframes: ["Ember Prime"] };
  h.controller.checkForRotationChange();
  assert.equal(h.$("rotationCountdown").textContent, "—");
  assert.equal(h.$("nextRotationTime").textContent, "schedule.timePending");
  assert.equal(h.$("nextRotationTime").attributes.has("datetime"), false);
});

test("lifecycle events bind once, refresh only when visible, and page departure clears timers and stops the session ticker", () => {
  const h = harness();
  h.controller.bindRotationLifecycle();
  h.controller.bindRotationLifecycle();
  assert.equal(h.browser.listeners.get("focus").length, 1);
  assert.equal(h.document.listeners.get("visibilitychange").length, 1);
  h.document.visibilityState = "hidden";
  h.document.emit("visibilitychange");
  assert.equal(h.views.length, 0);
  h.document.visibilityState = "visible";
  h.document.emit("visibilitychange");
  assert.equal(h.views.length, 1);
  assert.equal(h.timers.size, 1);
  h.browser.emit("pagehide");
  assert.equal(h.timers.size, 0);
  assert.equal(h.tickerStops, 1);
  h.browser.emit("pageshow");
  assert.equal(h.views.length, 2);
  assert.equal(h.timers.size, 1);
  h.browser.emit("focus");
  assert.equal(h.views.length, 3);
  h.browser.emit("beforeunload");
  assert.equal(h.timers.size, 0);
  assert.equal(h.tickerStops, 2);
});

test("data load errors prevent schedule transitions and an exhausted schedule renders its existing empty state", () => {
  const h = harness({ now: boundary + 1 });
  h.state.dataLoadErrors = ["data-validation"];
  h.controller.checkForRotationChange();
  assert.equal(h.applied.length, 0);
  assert.equal(h.views.length, 0);
  assert.equal(h.timers.size, 0);
  h.state.dataLoadErrors = [];
  h.controller.checkForRotationChange();
  assert.equal(h.$("rotationSchedule").classList.contains("is-empty"), true);
  assert.equal(h.$("rotationCountdown").textContent, "—");
  assert.equal(h.$("rotationCountdownLabel").textContent, "schedule.nextNotAnnounced");
  assert.equal(h.$("nextRotationPreview").hidden, true);
  assert.equal(h.$("nextRotationPreviewNotice").hidden, true);
});
