import test from "node:test";
import assert from "node:assert/strict";
import {
  SESSION_EVENT_ERRORS,
  SESSION_SCHEMA_VERSION,
  appendSessionEvent,
  createSession,
  createSessionContext,
  deriveSessionSummary,
  replaySession,
  undoLastSessionEvent,
  validateSession
} from "../js/session.js";

const primeItems = [
  { id: "frame", parts: [{ id: "blueprint", required: 1 }, { id: "systems", required: 1 }] },
  { id: "weapon", parts: [{ id: "barrel", required: 3 }, { id: "link", required: 2 }] }
];
const relics = [
  {
    id: "lith-a9",
    rewards: [
      { itemId: "frame", partId: "blueprint", rarity: "common" },
      { itemId: "frame", partId: "systems", rarity: "common" },
      { itemId: "weapon", partId: "barrel", rarity: "uncommon" },
      { itemId: "weapon", partId: "link", rarity: "rare" }
    ]
  },
  // meso-r6 只能掉落 frame:blueprint，用于验证“全局存在但遗物不掉”的配对拒绝。
  { id: "meso-r6", rewards: [{ itemId: "frame", partId: "blueprint", rarity: "common" }] }
];
const context = createSessionContext(primeItems, relics);

function baseSession(overrides = {}) {
  return createSession({
    rotationId: "rotation-a",
    startedAt: "2026-08-22T10:00:00.000Z",
    selectedItemIds: ["frame", "weapon"],
    ownedParts: {},
    ayaBudget: 10,
    validationSnapshot: context.validationSnapshot,
    ...overrides
  });
}

function fissure(overrides = {}) {
  return {
    type: "fissure",
    at: "2026-08-22T10:05:00.000Z",
    relicId: "lith-a9",
    refinement: "radiant",
    ayaCost: 1,
    claimed: null,
    ...overrides
  };
}

test("createSession 深拷贝基线，后续修改原始对象不影响会话", () => {
  const selected = ["frame"];
  const owned = { weapon: { barrel: 1 } };
  const session = createSession({
    rotationId: "rotation-a",
    startedAt: "2026-08-22T10:00:00Z",
    selectedItemIds: selected,
    ownedParts: owned,
    ayaBudget: 33,
    validationSnapshot: context.validationSnapshot
  });
  selected.push("weapon");
  owned.weapon.barrel = 3;
  owned.weapon.link = 9;
  assert.equal(session.version, SESSION_SCHEMA_VERSION);
  assert.deepEqual(session.baseline.selectedItemIds, ["frame"]);
  assert.deepEqual(session.baseline.ownedParts, { weapon: { barrel: 1 } });
  assert.equal(session.baseline.ayaBudget, 33);
  assert.deepEqual(session.events, []);
});

test("createSession 拒绝非法轮换或时间戳", () => {
  assert.equal(createSession({ rotationId: "", startedAt: "2026-08-22T10:00:00Z", validationSnapshot: context.validationSnapshot }), null);
  assert.equal(createSession({ rotationId: "rotation-a", startedAt: "not-a-date", validationSnapshot: context.validationSnapshot }), null);
  assert.equal(createSession({ rotationId: "rotation-a", startedAt: "2026-08-22T10:00:00Z" }), null);
});

test("createSession 与直接 replay 都以冻结需求钳制基线收藏", () => {
  const session = baseSession({ ownedParts: { weapon: { barrel: 99 }, frame: { blueprint: 2 } } });
  assert.deepEqual(session.baseline.ownedParts, { weapon: { barrel: 3 }, frame: { blueprint: 1 } });
  const tampered = JSON.parse(JSON.stringify(session));
  tampered.baseline.ownedParts.weapon.barrel = 999;
  assert.equal(replaySession(tampered).ownedParts.weapon.barrel, 3);
});

test("无目标奖励的裂缝只消耗阿耶并累计次数", () => {
  const session = appendSessionEvent(baseSession(), fissure(), context).session;
  const effective = replaySession(session, context);
  assert.equal(effective.runs, 1);
  assert.equal(effective.ayaSpent, 1);
  assert.equal(effective.claims, 0);
  assert.equal(effective.ayaBudget, 9);
  assert.deepEqual(effective.ownedParts, {});
});

test("有目标奖励的裂缝把部件写入有效收藏", () => {
  let session = baseSession();
  session = appendSessionEvent(session, fissure({ claimed: { itemId: "frame", partId: "blueprint" } }), context).session;
  const effective = replaySession(session, context);
  assert.equal(effective.claims, 1);
  assert.deepEqual(effective.ownedParts, { frame: { blueprint: 1 } });
});

test("required>1 的部件可以多次领取并逐次累计", () => {
  let session = baseSession();
  for (let index = 0; index < 2; index += 1) {
    session = appendSessionEvent(session, fissure({ claimed: { itemId: "weapon", partId: "barrel" } }), context).session;
  }
  const effective = replaySession(session, context);
  assert.equal(effective.ownedParts.weapon.barrel, 2);
  assert.equal(effective.claims, 2);
});

test("领取次数在达到 required 时被拒绝，重放也不会超出上限", () => {
  let session = baseSession();
  for (let index = 0; index < 3; index += 1) {
    const result = appendSessionEvent(session, fissure({ claimed: { itemId: "weapon", partId: "barrel" } }), context);
    assert.ok(result.ok);
    session = result.session;
  }
  const capped = appendSessionEvent(session, fissure({ claimed: { itemId: "weapon", partId: "barrel" } }), context);
  assert.equal(capped.ok, false);
  assert.equal(capped.error, SESSION_EVENT_ERRORS.rewardAlreadyComplete);
  // 防御性重放：即使历史数据里混入超领事件，收藏也被钳制在 required 内。
  const tampered = validateSession(
    { ...JSON.parse(JSON.stringify(session)), events: [...session.events, fissure({ claimed: { itemId: "weapon", partId: "barrel" } })] },
    context
  );
  const effective = replaySession(tampered, context);
  assert.equal(effective.ownedParts.weapon.barrel, 3);
  assert.equal(effective.claims, 3);
});

test("重放是确定性的：重复执行与 JSON 存储往返结果一致", () => {
  let session = baseSession();
  session = appendSessionEvent(session, fissure({ claimed: { itemId: "frame", partId: "systems" } }), context).session;
  session = appendSessionEvent(session, fissure({ refinement: "intact", ayaCost: 0 }), context).session;
  session = appendSessionEvent(session, fissure({ claimed: { itemId: "weapon", partId: "link" } }), context).session;
  const stored = JSON.parse(JSON.stringify(session));
  const first = replaySession(stored, context);
  const second = replaySession(stored, context);
  assert.deepEqual(first, second);
  assert.deepEqual(replaySession(validateSession(stored, context), context), first);
});

test("多事件序列按顺序重放且派生汇总正确", () => {
  let session = baseSession();
  session = appendSessionEvent(session, fissure({ at: "2026-08-22T10:01:00Z" }), context).session;
  session = appendSessionEvent(session, fissure({ at: "2026-08-22T10:02:00Z", claimed: { itemId: "frame", partId: "blueprint" } }), context).session;
  session = appendSessionEvent(session, fissure({ at: "2026-08-22T10:03:00Z", claimed: { itemId: "weapon", partId: "link" } }), context).session;
  const summary = deriveSessionSummary(session, { now: Date.parse("2026-08-22T10:33:00Z"), context });
  assert.deepEqual(summary, { fissures: 3, ayaSpent: 3, claims: 2, elapsedMs: 33 * 60_000 });
  const effective = replaySession(session, context);
  assert.deepEqual(effective.ownedParts, { frame: { blueprint: 1 }, weapon: { link: 1 } });
  assert.equal(effective.ayaBudget, 7);
});

test("Aya 支出从事件推导，混合 0/1 花费且预算下限为 0", () => {
  let session = baseSession({ ayaBudget: 2 });
  session = appendSessionEvent(session, fissure(), context).session;
  session = appendSessionEvent(session, fissure({ ayaCost: 0 }), context).session;
  session = appendSessionEvent(session, fissure(), context).session;
  const effective = replaySession(session, context);
  assert.equal(effective.ayaSpent, 2);
  assert.equal(effective.ayaBudget, 0);
  // 钱包见底后仍可记录（账本是事实记录），但预算不会变成负数。
  session = appendSessionEvent(session, fissure(), context).session;
  assert.equal(replaySession(session, context).ayaBudget, 0);
  assert.equal(replaySession(session, context).runs, 4);
});

test("undo 一条事件即可完整恢复该裂缝之前的状态", () => {
  let session = baseSession();
  session = appendSessionEvent(session, fissure(), context).session;
  const beforeUndo = JSON.parse(JSON.stringify(session));
  session = appendSessionEvent(session, fissure({ claimed: { itemId: "frame", partId: "blueprint" } }), context).session;
  const undone = undoLastSessionEvent(session);
  assert.deepEqual(replaySession(undone, context), replaySession(beforeUndo, context));
  assert.equal(undone.events.length, 1);
  assert.equal(undoLastSessionEvent(undone).events.length, 0);
  assert.equal(undoLastSessionEvent(undoLastSessionEvent(undone)), null);
});

test("undo 到空事件时会话仍在，派生状态回到纯基线", () => {
  let session = baseSession({ ownedParts: { frame: { systems: 1 } }, ayaBudget: 5 });
  session = appendSessionEvent(session, fissure(), context).session;
  const emptied = undoLastSessionEvent(session);
  const effective = replaySession(emptied, context);
  assert.equal(effective.runs, 0);
  assert.equal(effective.ayaSpent, 0);
  assert.deepEqual(effective.ownedParts, { frame: { systems: 1 } });
  assert.equal(effective.ayaBudget, 5);
});

test("reload 重放等价：持久化字节往返后有效收藏完全一致", () => {
  let session = baseSession({ ownedParts: { weapon: { barrel: 1 } } });
  session = appendSessionEvent(session, fissure({ claimed: { itemId: "weapon", partId: "barrel" } }), context).session;
  session = appendSessionEvent(session, fissure({ claimed: { itemId: "frame", partId: "blueprint" } }), context).session;
  const persisted = JSON.stringify(session);
  const reloaded = validateSession(JSON.parse(persisted), context);
  assert.deepEqual(replaySession(reloaded, context), replaySession(session, context));
  assert.equal(reloaded.events.length, 2);
});

test("畸形事件被拒绝且不改变会话", () => {
  const session = baseSession();
  const invalidEvents = [
    null,
    "fissure",
    {},
    fissure({ type: "run" }),
    fissure({ relicId: "" }),
    fissure({ refinement: "omni" }),
    fissure({ ayaCost: 2 }),
    fissure({ ayaCost: 0.5 }),
    fissure({ at: "yesterday-ish" }),
    fissure({ claimed: { itemId: "frame" } }),
    fissure({ claimed: "blueprint" })
  ];
  for (const event of invalidEvents) {
    const result = appendSessionEvent(session, event, context);
    assert.equal(result.ok, false);
    assert.equal(result.error, SESSION_EVENT_ERRORS.invalidEvent);
  }
  const unknownRelic = appendSessionEvent(session, fissure({ relicId: "lith-zzz" }), context);
  assert.equal(unknownRelic.error, SESSION_EVENT_ERRORS.unknownRelic);
  const unknownReward = appendSessionEvent(session, fissure({ claimed: { itemId: "old-frame", partId: "blueprint" } }), context);
  assert.equal(unknownReward.error, SESSION_EVENT_ERRORS.unknownReward);
  assert.deepEqual(session.events, []);
});

test("validateSession 对损坏结构整体失败关闭", () => {
  const invalidPayloads = [
    null,
    "session",
    [],
    {},
    { version: 2, rotationId: "rotation-a", startedAt: "2026-08-22T10:00:00Z", baseline: {}, events: [] },
    { version: 1, rotationId: "", startedAt: "2026-08-22T10:00:00Z", baseline: {}, events: [] },
    { version: 1, rotationId: "rotation-a", startedAt: "nope", baseline: {}, events: [] },
    { version: 1, rotationId: "rotation-a", startedAt: "2026-08-22T10:00:00Z" },
    { version: 1, rotationId: "rotation-a", startedAt: "2026-08-22T10:00:00Z", baseline: { ownedParts: "nope" }, events: [] },
    { version: 1, rotationId: "rotation-a", startedAt: "2026-08-22T10:00:00Z", baseline: {}, events: "three" }
  ];
  for (const payload of invalidPayloads) {
    assert.equal(validateSession(payload, context), null);
  }
});

test("validateSession 丢弃引用未知遗物或部件的事件，保留合法事件", () => {
  let session = baseSession();
  session = appendSessionEvent(session, fissure({ claimed: { itemId: "frame", partId: "blueprint" } }), context).session;
  const polluted = JSON.parse(JSON.stringify({
    ...session,
    events: [
      ...session.events,
      fissure({ relicId: "lith-gone" }),
      fissure({ claimed: { itemId: "gone-item", partId: "blueprint" } }),
      "garbage"
    ]
  }));
  const sanitized = validateSession(polluted, context);
  assert.equal(sanitized.events.length, 1);
  assert.equal(sanitized.events[0].claimed.itemId, "frame");
});

test("领取奖励必须由所记录的遗物掉落：合法配对接受，全局存在但遗物不掉的配对拒绝", () => {
  const session = baseSession();
  const valid = appendSessionEvent(session, fissure({ relicId: "meso-r6", claimed: { itemId: "frame", partId: "blueprint" } }), context);
  assert.ok(valid.ok);
  const impossible = appendSessionEvent(session, fissure({ relicId: "meso-r6", claimed: { itemId: "weapon", partId: "link" } }), context);
  assert.equal(impossible.ok, false);
  assert.equal(impossible.error, SESSION_EVENT_ERRORS.rewardNotFromRelic);
  assert.deepEqual(session.events, []);
});

test("存储中的伪造配对在验证时被确定性丢弃", () => {
  let session = baseSession();
  session = appendSessionEvent(session, fissure({ claimed: { itemId: "frame", partId: "blueprint" } }), context).session;
  const forgedEvent = { ...fissure({ claimed: { itemId: "weapon", partId: "link" } }), relicId: "meso-r6" };
  const forged = JSON.parse(JSON.stringify({ ...session, events: [...session.events, forgedEvent] }));
  const sanitized = validateSession(forged, context);
  assert.equal(sanitized.events.length, 1);
  assert.equal(replaySession(sanitized, context).ownedParts.weapon?.link, undefined);
});

test("ayaCost 必须严格为数字 0 或 1，拒绝一切可被强转的形态", () => {
  const session = baseSession();
  const invalidCosts = [null, undefined, "0", "1", -1, 2, 0.5, Number.NaN, Number.POSITIVE_INFINITY, true];
  for (const ayaCost of invalidCosts) {
    const result = appendSessionEvent(session, fissure({ ayaCost }), context);
    assert.equal(result.ok, false, `ayaCost=${String(ayaCost)} should be rejected`);
    assert.equal(result.error, SESSION_EVENT_ERRORS.invalidEvent);
  }
  for (const ayaCost of [0, 1]) {
    const result = appendSessionEvent(session, fissure({ ayaCost }), context);
    assert.ok(result.ok, `ayaCost=${ayaCost} should be accepted`);
  }
});

test("基线收藏按目录需求显式钳制：required=2 时 99 收敛为 2，0/1/2 原样保留，负数丢弃", () => {
  const build = (count) => JSON.parse(JSON.stringify({
    version: 1,
    rotationId: "rotation-a",
    startedAt: "2026-08-22T10:00:00Z",
    baseline: { selectedItemIds: ["weapon"], ownedParts: { weapon: { link: count } }, ayaBudget: 5 },
    events: []
  }));
  assert.equal(validateSession(build(99), context).baseline.ownedParts.weapon.link, 2);
  assert.equal(validateSession(build(2), context).baseline.ownedParts.weapon.link, 2);
  assert.equal(validateSession(build(1), context).baseline.ownedParts.weapon.link, 1);
  assert.equal(validateSession(build(0), context).baseline.ownedParts.weapon, undefined);
  assert.equal(validateSession(build(-3), context).baseline.ownedParts.weapon, undefined);
});

test("v2 冻结遗物与部件验证上下文：目录演进后历史有效事件仍可重放和结算", () => {
  let session = baseSession();
  session = appendSessionEvent(session, fissure({ claimed: { itemId: "frame", partId: "blueprint" } }), context).session;
  const evolvedCatalogContext = createSessionContext(primeItems, []);
  const reloaded = validateSession(JSON.parse(JSON.stringify(session)), evolvedCatalogContext);
  assert.ok(reloaded);
  assert.equal(reloaded.version, SESSION_SCHEMA_VERSION);
  assert.deepEqual(reloaded.validationSnapshot, session.validationSnapshot);
  assert.equal(reloaded.events.length, 1);
  assert.deepEqual(replaySession(reloaded, evolvedCatalogContext).ownedParts, { frame: { blueprint: 1 } });
});

test("v2 会话拒绝全局有效但不属于冻结轮换的遗物", () => {
  const globalRelics = [
    ...relics,
    { id: "axi-other", rewards: [{ itemId: "frame", partId: "blueprint", rarity: "rare" }] }
  ];
  const rotationAContext = createSessionContext(primeItems, globalRelics, {
    itemIds: ["frame", "weapon"],
    relicIds: ["lith-a9", "meso-r6"]
  });
  const session = createSession({
    rotationId: "rotation-a",
    startedAt: "2026-08-22T10:00:00Z",
    selectedItemIds: ["frame"],
    ownedParts: {},
    ayaBudget: 3,
    validationSnapshot: rotationAContext.validationSnapshot
  });
  const globallyValidButForeign = appendSessionEvent(session, fissure({
    relicId: "axi-other",
    claimed: { itemId: "frame", partId: "blueprint" }
  }), createSessionContext(primeItems, globalRelics));
  assert.equal(globallyValidButForeign.ok, false);
  assert.equal(globallyValidButForeign.error, SESSION_EVENT_ERRORS.unknownRelic);
});

test("v1 仅在可重建的轮换上下文存在时迁移为冻结 v2 账本", () => {
  const legacy = {
    version: 1,
    rotationId: "rotation-a",
    startedAt: "2026-08-22T10:00:00Z",
    baseline: { selectedItemIds: ["frame"], ownedParts: {}, ayaBudget: 3 },
    events: [fissure({ claimed: { itemId: "frame", partId: "blueprint" } })]
  };
  assert.equal(validateSession(legacy), null);
  const migrated = validateSession(legacy, context);
  assert.equal(migrated.version, SESSION_SCHEMA_VERSION);
  assert.equal(migrated.events.length, 1);
  assert.deepEqual(replaySession(migrated).ownedParts, { frame: { blueprint: 1 } });

  const missingHistoricalRelic = JSON.parse(JSON.stringify(legacy));
  assert.equal(validateSession(missingHistoricalRelic, createSessionContext(primeItems, [])), null);
});
