import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  SESSION_EVENT_ERRORS,
  appendSessionEvent,
  createSession,
  createSessionContext,
  replaySession,
  undoLastSessionEvent,
  validateSession
} from "../js/session.js";
import {
  STORAGE_KEY,
  loadCollectionState,
  readActiveSession,
  readStoredOwnedParts,
  saveActiveSession,
  saveCollectionState
} from "../js/storage.js";
import {
  commitSessionGains,
  commitSuspendedSessionGains,
  injectOwnedCounts,
  ownershipChangesSimulationInput,
  persistSessionCandidate,
  shouldShowSessionGraduationRecap
} from "../js/app.js";
import { rankRelicsForMissing, simulateCurrentRotation } from "../js/simulator.js";

const primeItems = [
  { id: "frame", parts: [{ id: "blueprint", required: 1 }] },
  { id: "weapon", parts: [{ id: "barrel", required: 2 }] }
];
const relics = [
  {
    id: "shared",
    name: "Shared",
    costAya: 1,
    rewards: [
      { itemId: "frame", partId: "blueprint", rarity: "common" },
      { itemId: "weapon", partId: "barrel", rarity: "common" }
    ]
  },
  {
    // 只掉落 frame:blueprint —— 用于伪造“全局存在但该遗物不掉”的配对。
    id: "frame-only",
    name: "Frame Only",
    costAya: 1,
    rewards: [{ itemId: "frame", partId: "blueprint", rarity: "uncommon" }]
  }
];
const context = createSessionContext(primeItems, relics);

function memoryStorage(initial) {
  const map = new Map();
  if (initial !== undefined) map.set(STORAGE_KEY, initial);
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, value),
    _map: map
  };
}

/** 第 N 次 setItem 抛错的故障注入存储（N 从 1 计）。 */
function failingStorage({ failOnWrite }) {
  const backing = memoryStorage();
  let writes = 0;
  return {
    getItem: backing.getItem,
    _map: backing._map,
    setItem(key, value) {
      writes += 1;
      if (writes === failOnWrite) throw new Error("injected quota failure");
      backing.setItem(key, value);
    }
  };
}

function fissure(overrides = {}) {
  return {
    type: "fissure",
    at: "2026-08-22T10:05:00.000Z",
    relicId: "shared",
    refinement: "intact",
    ayaCost: 1,
    claimed: null,
    ...overrides
  };
}

function mapsFromPlain(plain) {
  return Object.fromEntries(Object.entries(plain || {}).map(([itemId, partCounts]) => [
    itemId,
    new Map(Object.entries(partCounts).map(([partId, count]) => [partId, Number(count) || 0]))
  ]));
}

function makeSession({ ownedParts = {}, ayaBudget = 4, events = [], rotationId = "rotation-a" }) {
  let session = createSession({
    rotationId,
    startedAt: "2026-08-22T10:00:00Z",
    selectedItemIds: ["frame", "weapon"],
    ownedParts,
    ayaBudget,
    validationSnapshot: context.validationSnapshot
  });
  for (const event of events) {
    const result = appendSessionEvent(session, event, context);
    assert.ok(result.ok, `fixture event rejected: ${result.error}`);
    session = result.session;
  }
  return session;
}

test("会话收获通过现有注入通道进入既有模拟器，且不改变概率语义", () => {
  const baselineItems = injectOwnedCounts(primeItems, new Map());
  const baselineRun = simulateCurrentRotation({
    primeItems: baselineItems,
    relics,
    budget: 3,
    squad: 1,
    strategy: "intact",
    trials: 2000,
    analysisCap: 24
  });
  assert.equal(baselineRun.summary.remainingParts, 3);

  let session = createSession({
    rotationId: "rotation-a",
    startedAt: "2026-08-22T10:00:00Z",
    selectedItemIds: ["frame", "weapon"],
    ownedParts: {},
    ayaBudget: 3,
    validationSnapshot: context.validationSnapshot
  });
  const claimed = appendSessionEvent(session, fissure({ claimed: { itemId: "weapon", partId: "barrel" } }), context);
  assert.ok(claimed.ok);
  session = claimed.session;
  const effective = replaySession(session, context);

  // The only bridge to simulation: effective owned counts enter through the
  // same injection helper the UI uses before every run.
  const effectiveItems = injectOwnedCounts(primeItems, mapsFromPlain(effective.ownedParts));
  assert.equal(effectiveItems[1].parts[0].ownedCount, 1);
  const effectiveRun = simulateCurrentRotation({
    primeItems: effectiveItems,
    relics,
    budget: effective.ayaBudget,
    squad: 1,
    strategy: "intact",
    trials: 2000,
    analysisCap: 24
  });
  assert.equal(effectiveRun.summary.remainingParts, 2);
  assert.equal(effective.ayaBudget, 2);
  assert.ok(effectiveRun.finishProbability > baselineRun.finishProbability);
});

test("基线+事件在持久化往返前后派生状态完全一致（防双计）", () => {
  const storage = memoryStorage();
  saveCollectionState(storage, {
    rotationId: "rotation-a",
    selectedItemIds: ["frame", "weapon"],
    owned: {},
    ayaBudget: 5
  });
  const saved = loadCollectionState(storage, primeItems, { rotationId: "rotation-a", activeItemIds: ["frame", "weapon"], defaultAyaBudget: 33 });

  let session = createSession({
    rotationId: "rotation-a",
    startedAt: "2026-08-22T10:00:00Z",
    selectedItemIds: saved.selectedItemIds,
    ownedParts: saved.owned,
    ayaBudget: saved.ayaBudget,
    validationSnapshot: context.validationSnapshot
  });
  session = appendSessionEvent(session, fissure({ claimed: { itemId: "frame", partId: "blueprint" } }), context).session;
  const direct = replaySession(session, context);

  // Simulated reload of the persisted document bytes.
  const reloadedSession = validateSession(JSON.parse(JSON.stringify(session)), context);
  const reloaded = replaySession(reloadedSession, context);
  assert.deepEqual(reloaded, direct);
  assert.deepEqual(reloaded.ownedParts, { frame: { blueprint: 1 } });
});

test("结束会话是绝对覆盖：中断后重复提交不会重复计入奖励", () => {
  const storage = memoryStorage();
  saveCollectionState(storage, {
    rotationId: "rotation-a",
    selectedItemIds: ["frame", "weapon"],
    owned: { weapon: { barrel: 1 } },
    ayaBudget: 4
  });
  const session = makeSession({
    ownedParts: { weapon: { barrel: 1 } },
    events: [
      fissure({ claimed: { itemId: "weapon", partId: "barrel" } })
    ]
  });
  const rejected = appendSessionEvent(session, fissure({ claimed: { itemId: "weapon", partId: "barrel" } }), context);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, SESSION_EVENT_ERRORS.rewardAlreadyComplete);
  saveActiveSession(storage, session);

  const first = commitSessionGains(session, { storage, context });
  assert.deepEqual(first, { committed: true, cleared: true, final: first.final });
  const committedDoc = storage.getItem(STORAGE_KEY);

  // Crash between collection write and session clear: the session survives
  // and finishing again must land on byte-identical absolute values.
  saveActiveSession(storage, session);
  const retry = commitSessionGains(session, { storage, context });
  assert.ok(retry.committed && retry.cleared);
  assert.equal(storage.getItem(STORAGE_KEY), committedDoc);

  const reloaded = loadCollectionState(storage, primeItems, { rotationId: "rotation-a", activeItemIds: ["frame", "weapon"], defaultAyaBudget: 33 });
  assert.deepEqual(reloaded.owned, { weapon: { barrel: 2 } });
  assert.equal(readActiveSession(storage), null);
});

test("故障注入：收藏写入失败时会话与原收藏都原样保留", () => {
  const storage = failingStorage({ failOnWrite: 1 });
  saveCollectionState(storage, {
    rotationId: "rotation-a",
    selectedItemIds: ["frame", "weapon"],
    owned: {},
    ayaBudget: 6
  });
  const session = makeSession({
    events: [fissure({ claimed: { itemId: "frame", partId: "blueprint" } })]
  });
  saveActiveSession(storage, session);

  // failOnWrite=1 targets the collection write inside commitSessionGains.
  const failing = failingStorage({ failOnWrite: 1 });
  failing._map.set(STORAGE_KEY, storage.getItem(STORAGE_KEY));
  const before = failing.getItem(STORAGE_KEY);
  const result = commitSessionGains(session, { storage: failing, context });
  assert.deepEqual(result, { committed: false, cleared: false, final: result.final });
  assert.equal(failing.getItem(STORAGE_KEY), before);
});

test("故障注入：清除会话失败时不伪造完成，重试幂等且只保存一次", () => {
  const storage = memoryStorage();
  saveCollectionState(storage, {
    rotationId: "rotation-a",
    selectedItemIds: ["frame", "weapon"],
    owned: {},
    ayaBudget: 6
  });
  const session = makeSession({
    events: [fissure({ claimed: { itemId: "frame", partId: "blueprint" } })]
  });
  saveActiveSession(storage, session);
  const preFailureDoc = storage.getItem(STORAGE_KEY);

  // First commit: collection write (#1) succeeds, clear write (#2) fails.
  const failing = failingStorage({ failOnWrite: 2 });
  failing._map.set(STORAGE_KEY, preFailureDoc);
  const result = commitSessionGains(session, { storage: failing, context });
  assert.equal(result.committed, true);
  assert.equal(result.cleared, false);
  const afterFailedClear = failing.getItem(STORAGE_KEY);
  const docAfterFailedClear = JSON.parse(afterFailedClear);
  // Collection gains saved exactly once…
  assert.deepEqual(docAfterFailedClear.ownedParts, { frame: { blueprint: 1 } });
  // …but the session record survives, so no false completion is possible.
  assert.ok(docAfterFailedClear.activeSession);

  // Retry on healthy storage: idempotent absolute values, session clears.
  const retried = commitSessionGains(session, { storage: failing, context });
  assert.ok(retried.committed && retried.cleared);
  const docAfterRetry = JSON.parse(failing.getItem(STORAGE_KEY));
  assert.deepEqual(docAfterRetry.ownedParts, { frame: { blueprint: 1 } });
  assert.equal(docAfterRetry.activeSession, undefined);

  // Cross-check against a plain successful commit: identical collection values.
  const clean = memoryStorage(preFailureDoc);
  commitSessionGains(session, { storage: clean, context });
  assert.deepEqual(JSON.parse(clean.getItem(STORAGE_KEY)).ownedParts, { frame: { blueprint: 1 } });
});

test("跨轮换规则：旧会话挂起，绝不自动提交或自动迁移，需显式 Finish/Cancel", () => {
  const storage = memoryStorage();
  saveCollectionState(storage, {
    rotationId: "rotation-old",
    selectedItemIds: ["frame"],
    owned: {},
    ayaBudget: 6
  });
  const session = makeSession({
    rotationId: "rotation-old",
    events: [fissure({ claimed: { itemId: "frame", partId: "blueprint" } })]
  });
  saveActiveSession(storage, session);
  const suspendedDoc = storage.getItem(STORAGE_KEY);

  // Simulated rotation-B load: validation + mismatch detection only. The
  // stored document must remain byte-identical (no auto-finalize).
  const stored = validateSession(readActiveSession(storage), context);
  assert.equal(stored.rotationId, "rotation-old");
  assert.notEqual(stored.rotationId, "rotation-new");
  assert.equal(storage.getItem(STORAGE_KEY), suspendedDoc);

  // Explicit Finish of the suspended session commits once; concurrent manual
  // edits made while suspended are preserved by the max-merge.
  saveCollectionState(storage, {
    rotationId: "rotation-new",
    selectedItemIds: ["weapon"],
    owned: { weapon: { barrel: 1 } },
    ayaBudget: 33
  });
  const finished = commitSuspendedSessionGains(stored, { storage, context });
  assert.ok(finished.committed && finished.cleared);
  const committed = JSON.parse(storage.getItem(STORAGE_KEY));
  assert.deepEqual(committed.ownedParts, { frame: { blueprint: 1 }, weapon: { barrel: 1 } });
  assert.equal(committed.activeSession, undefined);

  // A second explicit finish finds nothing left to do and cannot reapply.
  saveActiveSession(storage, stored);
  commitSuspendedSessionGains(stored, { storage, context });
  const second = JSON.parse(storage.getItem(STORAGE_KEY));
  assert.deepEqual(second.ownedParts, { frame: { blueprint: 1 }, weapon: { barrel: 1 } });
});

test("挂起会话显式取消：丢弃事件且不动收藏", () => {
  const storage = memoryStorage();
  saveCollectionState(storage, {
    rotationId: "rotation-old",
    selectedItemIds: ["frame"],
    owned: {},
    ayaBudget: 6
  });
  const session = makeSession({
    rotationId: "rotation-old",
    events: [fissure({ claimed: { itemId: "frame", partId: "blueprint" } })]
  });
  saveActiveSession(storage, session);
  const beforeCancel = JSON.parse(storage.getItem(STORAGE_KEY));

  assert.ok(saveActiveSession(storage, null));
  const afterCancel = JSON.parse(storage.getItem(STORAGE_KEY));
  assert.equal(afterCancel.activeSession, undefined);
  assert.deepEqual(afterCancel.ownedParts, beforeCancel.ownedParts);
  assert.deepEqual(readStoredOwnedParts(storage), {});
});

test("伪造的不可能配对在提交链路中被丢弃：Finish 无法写入不存在的收获", () => {
  const storage = memoryStorage();
  saveCollectionState(storage, {
    rotationId: "rotation-a",
    selectedItemIds: ["frame", "weapon"],
    owned: {},
    ayaBudget: 6
  });
  // Forged document: frame-only relic claiming weapon:barrel, which it cannot drop.
  const forged = makeSession({ ayaBudget: 6 });
  forged.events.push(
    { type: "fissure", at: "2026-08-22T10:05:00Z", relicId: "frame-only", refinement: "radiant", ayaCost: 1, claimed: { itemId: "weapon", partId: "barrel" } }
  );
  saveActiveSession(storage, forged);
  const sanitized = validateSession(readActiveSession(storage), context);
  assert.equal(sanitized.events.length, 0);

  const result = commitSessionGains(sanitized, { storage, context });
  assert.ok(result.committed && result.cleared);
  const committed = JSON.parse(storage.getItem(STORAGE_KEY));
  assert.deepEqual(committed.ownedParts, {});
});

test("零阿耶账本：ayaCost=0 只计次数不计花费，重载后口径一致", () => {
  let session = makeSession({ ayaBudget: 2 });
  session = appendSessionEvent(session, fissure({ ayaCost: 0, claimed: { itemId: "weapon", partId: "barrel" } }), context).session;
  session = appendSessionEvent(session, fissure({ ayaCost: 0 }), context).session;
  const direct = replaySession(session, context);
  assert.deepEqual(
    { runs: direct.runs, ayaSpent: direct.ayaSpent, claims: direct.claims, budget: direct.ayaBudget },
    { runs: 2, ayaSpent: 0, claims: 1, budget: 2 }
  );
  const reloaded = replaySession(validateSession(JSON.parse(JSON.stringify(session)), context), context);
  assert.deepEqual(reloaded, direct);
});

test("故障注入：Log 候选写入失败后，内存/持久化/派生显示都保持旧账本", () => {
  const previous = makeSession({ ayaBudget: 3 });
  const candidate = appendSessionEvent(previous, fissure({ claimed: { itemId: "frame", partId: "blueprint" } }), context).session;
  const healthy = memoryStorage();
  assert.ok(saveActiveSession(healthy, previous));
  const failing = failingStorage({ failOnWrite: 1 });
  failing._map.set(STORAGE_KEY, healthy.getItem(STORAGE_KEY));

  const mutation = persistSessionCandidate(previous, candidate, { storage: failing });
  assert.equal(mutation.ok, false);
  assert.strictEqual(mutation.session, previous);
  assert.deepEqual(readActiveSession(failing), previous);
  assert.deepEqual(replaySession(mutation.session), {
    selectedItemIds: ["frame", "weapon"], ownedParts: {}, ayaBudget: 3, runs: 0, ayaSpent: 0, claims: 0
  });
});

test("故障注入：Undo 候选写入失败后，内存/持久化/派生显示都保持原事件", () => {
  const previous = makeSession({
    ayaBudget: 3,
    events: [
      fissure(),
      fissure({ at: "2026-08-22T10:06:00.000Z", claimed: { itemId: "frame", partId: "blueprint" } })
    ]
  });
  const candidate = undoLastSessionEvent(previous);
  const healthy = memoryStorage();
  assert.ok(saveActiveSession(healthy, previous));
  const failing = failingStorage({ failOnWrite: 1 });
  failing._map.set(STORAGE_KEY, healthy.getItem(STORAGE_KEY));

  const mutation = persistSessionCandidate(previous, candidate, { storage: failing });
  assert.equal(mutation.ok, false);
  assert.strictEqual(mutation.session, previous);
  assert.deepEqual(readActiveSession(failing), previous);
  assert.deepEqual(replaySession(mutation.session), {
    selectedItemIds: ["frame", "weapon"], ownedParts: { frame: { blueprint: 1 } }, ayaBudget: 1, runs: 2, ayaSpent: 2, claims: 1
  });
});

// TODO(test-hardening): directly test finishSuspendedSession so CI catches removed renderItemOptions() and removed/unconditional scheduleRun().
test("挂起 Finish 只合并历史收藏，严格保留当前轮换规划字段", () => {
  const storage = memoryStorage();
  const planner = {
    schemaVersion: 4,
    selectionRotationId: "rotation-new",
    selectedPrimeIds: [],
    ownedParts: { weapon: { barrel: 2 } },
    inputRotationId: "rotation-new",
    ayaBudget: 17,
    plannerSentinel: { source: "current" }
  };
  storage.setItem(STORAGE_KEY, JSON.stringify(planner));
  const old = makeSession({
    rotationId: "rotation-old",
    ownedParts: { weapon: { barrel: 1 } },
    ayaBudget: 6,
    events: [
      fissure({ claimed: { itemId: "weapon", partId: "barrel" } }),
      fissure({ at: "2026-08-22T10:06:00.000Z", claimed: { itemId: "frame", partId: "blueprint" } })
    ]
  });
  assert.ok(saveActiveSession(storage, old));
  const beforePlanner = JSON.parse(storage.getItem(STORAGE_KEY));

  const result = commitSuspendedSessionGains(old, { storage, context });
  assert.ok(result.committed && result.cleared);
  const after = JSON.parse(storage.getItem(STORAGE_KEY));
  assert.deepEqual(after.ownedParts, { weapon: { barrel: 2 }, frame: { blueprint: 1 } });
  assert.equal(after.selectionRotationId, beforePlanner.selectionRotationId);
  assert.deepEqual(after.selectedPrimeIds, beforePlanner.selectedPrimeIds);
  assert.equal(after.inputRotationId, beforePlanner.inputRotationId);
  assert.equal(after.ayaBudget, beforePlanner.ayaBudget);
  assert.deepEqual(after.plannerSentinel, beforePlanner.plannerSentinel);
});

test("挂起 Finish 只在当前选中目标的有效 owned 输入改变时重跑现有模拟", () => {
  const unchanged = ownershipChangesSimulationInput({
    primeItems,
    selectedItemIds: ["frame"],
    previousOwned: { weapon: { barrel: 0 } },
    nextOwned: { weapon: { barrel: 1 } }
  });
  assert.equal(unchanged, false);

  const changed = ownershipChangesSimulationInput({
    primeItems,
    selectedItemIds: ["weapon"],
    previousOwned: { weapon: { barrel: 0 } },
    nextOwned: { weapon: { barrel: 1 } }
  });
  assert.equal(changed, true);

  const alreadyCapped = ownershipChangesSimulationInput({
    primeItems,
    selectedItemIds: ["weapon"],
    previousOwned: { weapon: { barrel: 2 } },
    nextOwned: { weapon: { barrel: 3 } }
  });
  assert.equal(alreadyCapped, false);
});

test("仅接受当前 Worker 结果后才刷新实时会话派生展示", () => {
  const source = fs.readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
  const finishRun = source.slice(source.indexOf("function finishRun"), source.indexOf("function failRun"));
  const guard = finishRun.indexOf("isSimulationResponseCurrent");
  const normalResult = finishRun.indexOf("renderResult(result, trials, completedRequest?.options || {});");
  const sessionRefresh = finishRun.indexOf("if (state.activeSession) renderSessionPanel();");
  assert.match(finishRun, /if \(!isSimulationResponseCurrent\([\s\S]*?\)\) return;/);
  assert.ok(guard >= 0 && normalResult > guard && sessionRefresh > normalResult);
});

test("挂起 Finish 的两阶段故障保持会话可恢复，且不改写当前规划", () => {
  const storage = memoryStorage();
  saveCollectionState(storage, {
    rotationId: "rotation-new",
    selectedItemIds: [],
    owned: {},
    ayaBudget: 17
  });
  const old = makeSession({
    rotationId: "rotation-old",
    events: [fissure({ claimed: { itemId: "frame", partId: "blueprint" } })]
  });
  assert.ok(saveActiveSession(storage, old));
  const before = storage.getItem(STORAGE_KEY);

  const firstWriteFails = failingStorage({ failOnWrite: 1 });
  firstWriteFails._map.set(STORAGE_KEY, before);
  const failed = commitSuspendedSessionGains(old, { storage: firstWriteFails, context });
  assert.equal(failed.committed, false);
  assert.equal(failed.cleared, false);
  assert.equal(firstWriteFails.getItem(STORAGE_KEY), before);

  const clearFails = failingStorage({ failOnWrite: 2 });
  clearFails._map.set(STORAGE_KEY, before);
  const partial = commitSuspendedSessionGains(old, { storage: clearFails, context });
  assert.equal(partial.committed, true);
  assert.equal(partial.cleared, false);
  const afterPartial = JSON.parse(clearFails.getItem(STORAGE_KEY));
  assert.deepEqual(afterPartial.selectedPrimeIds, []);
  assert.equal(afterPartial.inputRotationId, "rotation-new");
  assert.equal(afterPartial.ayaBudget, 17);
  assert.ok(afterPartial.activeSession);

  const retried = commitSuspendedSessionGains(old, { storage: clearFails, context });
  assert.ok(retried.committed && retried.cleared);
  const completed = JSON.parse(clearFails.getItem(STORAGE_KEY));
  assert.deepEqual(completed.ownedParts, { frame: { blueprint: 1 } });
  assert.equal(completed.activeSession, undefined);
});

test("冻结历史上下文在当前目录删除遗物后仍可 reload/replay/Finish", () => {
  const storage = memoryStorage();
  const historical = makeSession({
    rotationId: "rotation-old",
    events: [fissure({ claimed: { itemId: "frame", partId: "blueprint" } })]
  });
  assert.ok(saveActiveSession(storage, historical));
  // Simulate catalog evolution: no current relic remains. V2 ignores this
  // mutable context and trusts only the frozen ledger contract.
  const evolvedContext = createSessionContext(primeItems, []);
  const reloaded = validateSession(readActiveSession(storage), evolvedContext);
  assert.equal(reloaded.events.length, 1);
  assert.deepEqual(replaySession(reloaded, evolvedContext).ownedParts, { frame: { blueprint: 1 } });

  const result = commitSuspendedSessionGains(reloaded, { storage, context: evolvedContext });
  assert.ok(result.committed && result.cleared);
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEY)).ownedParts, { frame: { blueprint: 1 } });
});

test("未完成目标的会话不显示毕业百分位或幸运措辞", () => {
  const curve = [{ budget: 0, probability: 0 }, { budget: 2, probability: 1 }];
  assert.equal(shouldShowSessionGraduationRecap({
    selectedItemIds: ["frame"],
    missingTargets: [{ itemId: "frame", partId: "blueprint" }],
    ayaSpent: 1,
    curve
  }), false);
  assert.equal(shouldShowSessionGraduationRecap({
    selectedItemIds: ["frame"],
    missingTargets: [],
    ayaSpent: 1,
    curve
  }), true);
});

test("剩余阿耶为 0 时推荐排序返回空而不报错", () => {
  const items = injectOwnedCounts(primeItems, new Map());
  assert.deepEqual(rankRelicsForMissing({ primeItems: items, relics, squad: 4, strategy: "finish", availableAya: 0 }), []);
  assert.equal(rankRelicsForMissing({ primeItems: items, relics, squad: 4, strategy: "finish" }).length, 2);
});

test("纯会话层保持无随机、无第二模拟器、无概率表", () => {
  const source = fs.readFileSync(new URL("../js/session.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from\s+".*simulator/);
  assert.doesNotMatch(source, /Math\.random|RARITIES|rates\[|squadChance|simulateCurrentRotation|budgetCurve/);
});
