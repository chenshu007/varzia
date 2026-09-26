import test from "node:test";
import assert from "node:assert/strict";
import { createSessionUIController } from "../js/session-ui-controller.js";
import { STORAGE_KEY, readActiveSession, saveCollectionState } from "../js/storage.js";

const primeItems = [
  { id: "frame", name: "Frame", parts: [{ id: "blueprint", name: "Blueprint", required: 1 }] },
  { id: "weapon", name: "Weapon", parts: [{ id: "barrel", name: "Barrel", required: 2 }] }
];
const relics = [
  { id: "shared", name: "Shared", costAya: 1, rewards: [
    { itemId: "frame", partId: "blueprint", rarity: "common" },
    { itemId: "weapon", partId: "barrel", rarity: "common" }
  ] },
  { id: "frame-only", name: "Frame Only", costAya: 1, rewards: [
    { itemId: "frame", partId: "blueprint", rarity: "uncommon" }
  ] }
];
const rotation = { id: "rotation-a", items: ["frame", "weapon"], relics: ["shared", "frame-only"] };

function memoryStorage(initial = null) {
  let raw = initial;
  return {
    failWrite: false,
    getItem(key) { assert.equal(key, STORAGE_KEY); return raw; },
    setItem(key, value) {
      assert.equal(key, STORAGE_KEY);
      if (this.failWrite) throw new Error("quota");
      raw = value;
    }
  };
}

function harness({ storage = memoryStorage(), planner: overrides = {} } = {}) {
  const elements = new Map();
  const $ = (id) => {
    if (!elements.has(id)) {
      let html = "";
      elements.set(id, {
        value: "", checked: false, hidden: false, disabled: false, textContent: "", focuses: 0,
        focus() { this.focuses += 1; },
        get innerHTML() { return html; },
        set innerHTML(value) {
          html = value;
          // Selects adopt their first option before fillSelectPreserving picks
          // the still-valid previous value, as they do in the browser.
          if (id === "sessionRelic" || id === "sessionClaimed") {
            this.value = value.match(/<option value="([^"]*)"/)?.[1] ?? "";
          }
        }
      });
    }
    return elements.get(id);
  };
  $("budget").value = "4";
  $("strategy").value = "finish";
  $("sessionRefinement").value = "intact";
  const planner = {
    rotation, previewMode: false, rotations: [rotation],
    allPrimeItems: primeItems, allRelics: relics, primeItems, relics,
    selectedItemIds: ["frame", "weapon"], owned: {}, squad: 4, lastResult: null,
    ...overrides
  };
  const calls = { items: 0, collections: 0, runs: 0, statuses: [], patches: [] };
  let timestamp = Date.parse("2026-08-22T10:00:00Z");
  let nextTimerId = 1;
  const timers = new Map();
  const controller = createSessionUIController({
    getPlannerState: () => ({ ...planner }),
    applyPlannerState(patch) {
      calls.patches.push(patch);
      if (Object.hasOwn(patch, "selectedItemIds")) planner.selectedItemIds = patch.selectedItemIds;
      if (Object.hasOwn(patch, "owned")) planner.owned = patch.owned;
      if (Object.hasOwn(patch, "ayaBudget")) $("budget").value = String(patch.ayaBudget);
    },
    $, message: (key, variables = {}) => `${key}${Object.keys(variables).length ? `:${JSON.stringify(variables)}` : ""}`,
    format: String, escapeHtml: (value) => String(value ?? ""), getStorage: () => storage,
    renderItemOptions: () => calls.items++, renderCollections: () => calls.collections++,
    scheduleRun: () => calls.runs++, setStatus: (...args) => calls.statuses.push(args),
    now: () => timestamp,
    setInterval(callback, delay) { const id = nextTimerId++; timers.set(id, { callback, delay }); return id; },
    clearInterval: (id) => timers.delete(id), requestAnimationFrame: (callback) => callback()
  });
  function claim(value = "weapon|barrel") {
    $("sessionRelic").value = "shared";
    $("sessionClaimed").value = value;
    controller.logLiveFissure();
  }
  return { controller, planner, storage, $, calls, timers, claim, advance: (ms) => { timestamp += ms; } };
}

test("session UI starts durably, logs and undoes through the planner bridge, then finishes", () => {
  const ui = harness();
  ui.controller.startLiveSession();
  assert.equal(ui.controller.activeSession.rotationId, rotation.id);
  assert.deepEqual(readActiveSession(ui.storage), ui.controller.activeSession);
  assert.equal(ui.$("budget").disabled, true);
  assert.equal(ui.$("sessionActiveView").hidden, false);
  assert.equal(ui.$("selectAllTargets").disabled, true);
  assert.equal(ui.timers.size, 1);
  assert.equal([...ui.timers.values()][0].delay, 30_000);
  assert.equal(ui.calls.runs, 0);

  ui.advance(65_000);
  [...ui.timers.values()][0].callback();
  assert.equal(ui.$("sessionElapsed").textContent, 'session.elapsed.m:{"m":1}');
  ui.claim();
  assert.equal(ui.planner.owned.weapon.get("barrel"), 1);
  assert.equal(ui.$("budget").value, "3");
  assert.equal(ui.calls.runs, 1);
  assert.equal(ui.$("sessionStatFissures").textContent, "1");
  assert.equal(ui.$("sessionStatRemaining").textContent, "2");
  assert.deepEqual(readActiveSession(ui.storage), ui.controller.activeSession);
  assert.equal(ui.$("sessionLogButton").focuses, 1);

  ui.controller.undoLastLiveFissure();
  assert.deepEqual(ui.planner.owned, {});
  assert.equal(ui.$("budget").value, "4");
  assert.equal(ui.controller.activeSession.events.length, 0);
  assert.equal(ui.$("sessionUndoButton").disabled, true);
  assert.equal(ui.calls.runs, 2);

  ui.claim("frame|blueprint");
  ui.controller.finishLiveSession();
  assert.equal(ui.controller.activeSession, null);
  assert.equal(readActiveSession(ui.storage), null);
  assert.deepEqual(JSON.parse(ui.storage.getItem(STORAGE_KEY)).ownedParts, { frame: { blueprint: 1 } });
  assert.equal(ui.$("budget").disabled, false);
  assert.equal(ui.$("budget").value, "3");
  assert.equal(ui.timers.size, 0);
  assert.equal(ui.$("sessionStartButton").focuses, 1);
});

test("stored session resumes from replay and cancellation restores its baseline", () => {
  const before = harness();
  before.controller.startLiveSession();
  before.claim();
  const persisted = before.storage.getItem(STORAGE_KEY);
  const resumed = harness({ storage: before.storage });
  resumed.controller.adoptStoredSessionForRotation(rotation);
  assert.equal(resumed.storage.getItem(STORAGE_KEY), persisted);
  resumed.controller.applyEffectiveSessionState({ reschedule: false });
  resumed.controller.startSessionTicker();
  assert.equal(resumed.controller.activeSession.events.length, 1);
  assert.equal(resumed.planner.owned.weapon.get("barrel"), 1);
  assert.equal(resumed.$("budget").value, "3");
  resumed.controller.cancelLiveSession();
  assert.equal(readActiveSession(resumed.storage), null);
  assert.equal(resumed.controller.activeSession, null);
  assert.deepEqual(resumed.planner.owned, {});
  assert.deepEqual(resumed.planner.selectedItemIds, ["frame", "weapon"]);
  assert.equal(resumed.$("budget").value, "4");
  assert.equal(resumed.calls.runs, 1);
  assert.equal(resumed.timers.size, 0);
});

test("start, log, undo and finish storage failures preserve the last durable session", () => {
  const ui = harness();
  ui.storage.failWrite = true;
  ui.controller.startLiveSession();
  assert.equal(ui.controller.activeSession, null);
  assert.equal(ui.calls.patches.length, 0);
  assert.equal(ui.timers.size, 0);
  ui.storage.failWrite = false;
  ui.controller.startLiveSession();
  const initial = ui.controller.activeSession;
  const persisted = ui.storage.getItem(STORAGE_KEY);
  ui.storage.failWrite = true;
  ui.claim();
  assert.equal(ui.controller.activeSession, initial);
  assert.equal(ui.storage.getItem(STORAGE_KEY), persisted);
  assert.deepEqual(ui.planner.owned, {});
  assert.equal(ui.calls.runs, 0);
  ui.storage.failWrite = false;
  ui.claim();
  const logged = ui.controller.activeSession;
  ui.storage.failWrite = true;
  ui.controller.undoLastLiveFissure();
  assert.equal(ui.controller.activeSession, logged);
  assert.equal(ui.planner.owned.weapon.get("barrel"), 1);
  ui.controller.finishLiveSession();
  assert.equal(ui.controller.activeSession, logged);
  assert.equal(ui.$("budget").disabled, true);
  assert.deepEqual(ui.calls.statuses.at(-1), ["session.error.storage", true]);
});

test("future root schema and unknown ledger versions remain byte-for-byte preserved", () => {
  const future = JSON.stringify({ schemaVersion: 999, marker: "KEEP", activeSession: { version: 999 } });
  const ui = harness({ storage: memoryStorage(future) });
  ui.controller.adoptStoredSessionForRotation(rotation);
  ui.controller.startLiveSession();
  assert.equal(ui.controller.activeSession, null);
  assert.equal(ui.storage.getItem(STORAGE_KEY), future);
  assert.deepEqual(ui.calls.statuses.at(-1), ["session.error.storage", true]);

  const unknownLedger = { version: 999, rotationId: rotation.id, marker: "KEEP" };
  const unknown = JSON.stringify({ schemaVersion: 4, activeSession: unknownLedger });
  const blocked = harness({ storage: memoryStorage(unknown) });
  blocked.controller.adoptStoredSessionForRotation(rotation);
  blocked.controller.renderSessionPanel();
  blocked.controller.startLiveSession();
  assert.deepEqual(blocked.controller.unresolvedSession, unknownLedger);
  assert.equal(blocked.controller.activeSession, null);
  assert.equal(blocked.$("sessionStartButton").disabled, true);
  assert.equal(blocked.$("sessionSuspendFinishButton").hidden, true);
  assert.equal(blocked.storage.getItem(STORAGE_KEY), unknown);
});

test("preview preserves a stored ledger without adopting or starting a live session", () => {
  const origin = harness();
  origin.controller.startLiveSession();
  origin.claim();
  const saved = origin.storage.getItem(STORAGE_KEY);
  const preview = harness({ storage: origin.storage, planner: { previewMode: true } });
  preview.controller.adoptStoredSessionForRotation(rotation, { preview: true });
  preview.controller.startLiveSession();
  preview.controller.renderSessionPanel();
  assert.equal(preview.controller.activeSession, null);
  assert.equal(preview.controller.suspendedSession, null);
  assert.equal(preview.storage.getItem(STORAGE_KEY), saved);
  assert.equal(preview.calls.patches.length, 0);
  assert.equal(preview.$("sessionStartButton").disabled, true);
});

for (const selected of ["frame", "weapon"]) {
  test(`suspended Finish preserves planner inputs and reruns only affected targets (${selected})`, () => {
    const origin = harness();
    origin.controller.startLiveSession();
    origin.claim("weapon|barrel");
    const nextRotation = { ...rotation, id: "rotation-b" };
    saveCollectionState(origin.storage, {
      rotationId: nextRotation.id, selectedItemIds: [selected], owned: {}, ayaBudget: 17
    });
    const next = harness({ storage: origin.storage, planner: {
      rotation: nextRotation, rotations: [rotation, nextRotation], selectedItemIds: [selected]
    } });
    next.$("budget").value = "17";
    const before = next.storage.getItem(STORAGE_KEY);
    next.controller.adoptStoredSessionForRotation(nextRotation);
    assert.equal(next.storage.getItem(STORAGE_KEY), before);
    assert.equal(next.controller.activeSession, null);
    assert.equal(next.controller.suspendedSession.rotationId, rotation.id);
    assert.equal(next.calls.patches.length, 0);
    next.controller.finishSuspendedSession();
    assert.equal(next.controller.suspendedSession, null);
    assert.equal(next.planner.owned.weapon.get("barrel"), 1);
    assert.deepEqual(next.planner.selectedItemIds, [selected]);
    assert.equal(next.$("budget").value, "17");
    assert.equal(next.calls.items, 1);
    assert.equal(next.calls.collections, 1);
    assert.equal(next.calls.runs, selected === "weapon" ? 1 : 0);
    const stored = JSON.parse(next.storage.getItem(STORAGE_KEY));
    assert.equal(stored.selectionRotationId, nextRotation.id);
    assert.equal(stored.inputRotationId, nextRotation.id);
    assert.equal(stored.ayaBudget, 17);
    assert.deepEqual(stored.selectedPrimeIds, [selected]);
    assert.equal(stored.activeSession, undefined);
  });
}

test("zero-Aya sessions retain relic logging choices and filter impossible claim pairs", () => {
  const ui = harness();
  ui.$("budget").value = "0";
  ui.controller.startLiveSession();
  assert.match(ui.$("sessionRelic").innerHTML, /value="shared"/);
  assert.match(ui.$("sessionRelic").innerHTML, /value="frame-only"/);
  ui.$("sessionRelic").value = "frame-only";
  ui.controller.updateSessionClaimOptions();
  assert.match(ui.$("sessionClaimed").innerHTML, /value="frame\|blueprint"/);
  assert.doesNotMatch(ui.$("sessionClaimed").innerHTML, /weapon\|barrel/);
  ui.$("sessionOwnedRelic").checked = true;
  ui.$("sessionClaimed").value = "frame|blueprint";
  ui.controller.logLiveFissure();
  assert.equal(ui.controller.activeSession.events.length, 1);
  assert.equal(ui.$("budget").value, "0");
  assert.equal(ui.planner.owned.frame.get("blueprint"), 1);
  assert.equal(ui.$("sessionOwnedRelic").checked, false);
});
