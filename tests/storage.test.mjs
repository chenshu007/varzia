import test from "node:test";
import assert from "node:assert/strict";
import {
  STORAGE_KEY,
  hasFutureSchemaDocument,
  loadCollectionState,
  readActiveSession,
  readStoredOwnedParts,
  saveActiveSession,
  saveCollectionState
} from "../js/storage.js";

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, value)
  };
}

const primeItems = [
  { id: "frame", parts: [{ id: "blueprint", required: 1 }] },
  { id: "weapon", parts: [{ id: "barrel", required: 2 }] },
  { id: "future-frame", parts: [{ id: "systems", required: 1 }] }
];

const currentOptions = {
  rotationId: "rotation-current",
  activeItemIds: ["frame", "weapon"],
  defaultAyaBudget: 33
};

test("首次进入默认全选本期所有 Prime 并使用本期 Aya 默认值", () => {
  assert.deepEqual(loadCollectionState(memoryStorage(), primeItems, currentOptions), {
    selectedItemIds: ["frame", "weapon"],
    owned: {},
    ayaBudget: 33
  });
});

test("同一轮换主动全不选与手工 Aya 输入都会保存并恢复", () => {
  const storage = memoryStorage();
  saveCollectionState(storage, {
    rotationId: "rotation-current",
    selectedItemIds: [],
    owned: { weapon: { barrel: 1 } },
    ayaBudget: 42
  });
  assert.deepEqual(loadCollectionState(storage, primeItems, currentOptions), {
    selectedItemIds: [],
    owned: { weapon: { barrel: 1 } },
    ayaBudget: 42
  });
  const serialized = JSON.parse(storage.getItem(STORAGE_KEY));
  assert.equal(serialized.schemaVersion, 4);
  assert.equal(serialized.selectionRotationId, "rotation-current");
  assert.equal(serialized.inputRotationId, "rotation-current");
});

test("V3 文档迁移：写入会话后升级为 V4 且收藏字段原样保留", () => {
  const storage = memoryStorage();
  storage.setItem(STORAGE_KEY, JSON.stringify({
    schemaVersion: 3,
    selectionRotationId: "rotation-current",
    selectedPrimeIds: ["frame"],
    ownedParts: { weapon: { barrel: 1 } },
    inputRotationId: "rotation-current",
    ayaBudget: 42
  }));
  const session = { version: 1, rotationId: "rotation-current", startedAt: "2026-08-22T10:00:00Z", baseline: {}, events: [] };
  assert.ok(saveActiveSession(storage, session));
  const doc = JSON.parse(storage.getItem(STORAGE_KEY));
  assert.equal(doc.schemaVersion, 4);
  assert.deepEqual(doc.selectedPrimeIds, ["frame"]);
  assert.deepEqual(doc.ownedParts, { weapon: { barrel: 1 } });
  assert.equal(doc.ayaBudget, 42);
  assert.deepEqual(readActiveSession(storage), session);
});

test("清除会话不会触碰收藏，收藏写入也不会丢失活动会话", () => {
  const storage = memoryStorage();
  saveCollectionState(storage, {
    rotationId: "rotation-current",
    selectedItemIds: ["weapon"],
    owned: { weapon: { barrel: 2 } },
    ayaBudget: 7
  });
  const session = { version: 1, rotationId: "rotation-current", startedAt: "2026-08-22T10:00:00Z", baseline: {}, events: [] };
  saveActiveSession(storage, session);

  // Collection write must preserve the concurrently stored session.
  saveCollectionState(storage, {
    rotationId: "rotation-current",
    selectedItemIds: ["frame"],
    owned: {},
    ayaBudget: 9
  });
  assert.deepEqual(readActiveSession(storage), session);

  // Clearing the session must preserve collection fields.
  assert.ok(saveActiveSession(storage, null));
  assert.equal(readActiveSession(storage), null);
  const doc = JSON.parse(storage.getItem(STORAGE_KEY));
  assert.deepEqual(doc.selectedPrimeIds, ["frame"]);
  assert.deepEqual(doc.ownedParts, {});
  assert.equal(doc.ayaBudget, 9);
  assert.equal(doc.schemaVersion, 4);
});

test("畸形或缺失的活动会话读取为 null，不影响收藏加载", () => {
  const malformed = memoryStorage();
  malformed.setItem(STORAGE_KEY, JSON.stringify({
    schemaVersion: 4,
    selectedPrimeIds: ["frame"],
    ownedParts: {},
    ayaBudget: 5,
    activeSession: "not-an-object"
  }));
  assert.equal(readActiveSession(malformed), null);
  assert.deepEqual(loadCollectionState(malformed, primeItems, currentOptions).owned, {});

  const legacy = memoryStorage();
  legacy.setItem(STORAGE_KEY, JSON.stringify({ schemaVersion: 3, selectedPrimeIds: ["frame"], ownedParts: {}, ayaBudget: 5 }));
  assert.equal(readActiveSession(legacy), null);

  const broken = memoryStorage();
  broken.setItem(STORAGE_KEY, "{not json");
  const rawBroken = broken.getItem(STORAGE_KEY);
  assert.equal(readActiveSession(broken), null);
  assert.equal(saveActiveSession(broken, null), false);
  assert.equal(broken.getItem(STORAGE_KEY), rawBroken);
});

function futureStorage() {
  const storage = memoryStorage();
  storage.setItem(STORAGE_KEY, JSON.stringify({
    schemaVersion: 9,
    selectionRotationId: "rotation-current",
    selectedPrimeIds: ["frame"],
    ownedParts: { frame: { blueprint: 1 } },
    inputRotationId: "rotation-current",
    ayaBudget: 7,
    futureOnlyField: { keepMe: true }
  }));
  return storage;
}

test("未来 schema 文档：读取回退默认值且原始字节不被改写", () => {
  const storage = futureStorage();
  const before = storage.getItem(STORAGE_KEY);
  assert.ok(hasFutureSchemaDocument(storage));
  assert.deepEqual(loadCollectionState(storage, primeItems, currentOptions), {
    selectedItemIds: ["frame", "weapon"],
    owned: {},
    ayaBudget: 33
  });
  assert.equal(readActiveSession(storage), null);
  assert.equal(readStoredOwnedParts(storage), null);
  assert.equal(saveCollectionState(storage, {
    rotationId: "rotation-current",
    selectedItemIds: ["frame"],
    owned: {},
    ayaBudget: 9
  }), false);
  assert.equal(saveActiveSession(storage, null), false);
  assert.equal(storage.getItem(STORAGE_KEY), before);
});

test("显式但非受支持的 schemaVersion 一律只读，普通操作不得降级原始字节", () => {
  for (const schemaVersion of ["9", "4", 4.5, null, {}, [], -1]) {
    const storage = memoryStorage();
    storage.setItem(STORAGE_KEY, JSON.stringify({ schemaVersion, sentinel: "KEEP", activeSession: { version: 1 } }));
    const before = storage.getItem(STORAGE_KEY);
    assert.ok(hasFutureSchemaDocument(storage), `schemaVersion=${JSON.stringify(schemaVersion)} must lock`);
    assert.deepEqual(loadCollectionState(storage, primeItems, currentOptions), {
      selectedItemIds: ["frame", "weapon"],
      owned: {},
      ayaBudget: 33
    });
    assert.equal(saveActiveSession(storage, null), false);
    assert.equal(saveCollectionState(storage, {
      rotationId: "rotation-current",
      selectedItemIds: ["frame"],
      owned: {},
      ayaBudget: 9
    }), false);
    assert.equal(storage.getItem(STORAGE_KEY), before);
  }
});

test("缺少 schemaVersion 的旧文档仍可迁移并保存", () => {
  const storage = memoryStorage();
  storage.setItem(STORAGE_KEY, JSON.stringify({ selectedItemIds: ["frame"], owned: { frame: { blueprint: 1 } } }));
  assert.equal(hasFutureSchemaDocument(storage), false);
  assert.ok(saveCollectionState(storage, {
    rotationId: "rotation-current",
    selectedItemIds: ["frame"],
    owned: { frame: { blueprint: 1 } },
    ayaBudget: 33
  }));
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).schemaVersion, 4);
});

test("V4 与旧版文档不受前向版本门影响", () => {
  const v4 = memoryStorage();
  v4.setItem(STORAGE_KEY, JSON.stringify({
    schemaVersion: 4,
    selectionRotationId: "rotation-current",
    selectedPrimeIds: ["weapon"],
    ownedParts: {},
    inputRotationId: "rotation-current",
    ayaBudget: 11
  }));
  assert.equal(hasFutureSchemaDocument(v4), false);
  assert.deepEqual(loadCollectionState(v4, primeItems, currentOptions).ayaBudget, 11);

  // 无整型版本号的旧文档沿用既有迁移行为。
  const legacy = memoryStorage();
  legacy.setItem(STORAGE_KEY, JSON.stringify({ selectedItemIds: ["frame"], owned: {} }));
  assert.equal(hasFutureSchemaDocument(legacy), false);
  assert.deepEqual(loadCollectionState(legacy, primeItems, currentOptions).selectedItemIds, ["frame"]);
});

test("进入新轮换时默认全选并改用新一期 Aya 默认值", () => {
  const storage = memoryStorage();
  saveCollectionState(storage, {
    rotationId: "rotation-old",
    selectedItemIds: [],
    owned: {},
    ayaBudget: 42
  });
  assert.deepEqual(loadCollectionState(storage, primeItems, {
    rotationId: "rotation-future",
    activeItemIds: ["future-frame"],
    defaultAyaBudget: 37
  }), {
    selectedItemIds: ["future-frame"],
    owned: {},
    ayaBudget: 37
  });
});

test("owned parts 是全局收藏，跨轮换仍完整保留", () => {
  const storage = memoryStorage();
  saveCollectionState(storage, {
    rotationId: "rotation-current",
    selectedItemIds: ["frame"],
    owned: { frame: { blueprint: 1 }, "future-frame": { systems: 1 } },
    ayaBudget: 33
  });
  const loaded = loadCollectionState(storage, primeItems, {
    rotationId: "rotation-future",
    activeItemIds: ["future-frame"],
    defaultAyaBudget: 37
  });
  assert.deepEqual(loaded.owned, { frame: { blueprint: 1 }, "future-frame": { systems: 1 } });
});

test("V2 当前轮换空目标能迁移为明确的主动全不选", () => {
  const storage = memoryStorage();
  storage.setItem(STORAGE_KEY, JSON.stringify({
    schemaVersion: 2,
    rotationId: "rotation-current",
    selectedItemIds: [],
    owned: { weapon: { barrel: 1 } }
  }));
  assert.deepEqual(loadCollectionState(storage, primeItems, currentOptions), {
    selectedItemIds: [],
    owned: { weapon: { barrel: 1 } },
    ayaBudget: 33
  });
});

test("无轮换 id 的旧选择只有仍含合法目标时才迁移", () => {
  const valid = memoryStorage();
  valid.setItem(STORAGE_KEY, JSON.stringify({ selectedItemIds: ["frame", "old-item"], owned: {} }));
  assert.deepEqual(loadCollectionState(valid, primeItems, currentOptions).selectedItemIds, ["frame"]);

  const invalid = memoryStorage();
  invalid.setItem(STORAGE_KEY, JSON.stringify({ selectedItemIds: [], owned: {} }));
  assert.deepEqual(loadCollectionState(invalid, primeItems, currentOptions).selectedItemIds, ["frame", "weapon"]);
});

test("V1 数组收藏会迁移为数量模型", () => {
  const storage = memoryStorage();
  storage.setItem(STORAGE_KEY, JSON.stringify({
    selectedTargetIds: ["frame"],
    owned: { frame: ["blueprint"], weapon: ["barrel"] }
  }));
  assert.deepEqual(loadCollectionState(storage, primeItems, currentOptions), {
    selectedItemIds: ["frame"],
    owned: { frame: { blueprint: 1 }, weapon: { barrel: 2 } },
    ayaBudget: 33
  });
});

test("预览模式读取全局收藏但不复用正式选择或 Aya 输入", () => {
  const storage = memoryStorage();
  saveCollectionState(storage, {
    rotationId: "rotation-current",
    selectedItemIds: [],
    owned: { "future-frame": { systems: 1 } },
    ayaBudget: 88
  });
  const before = storage.getItem(STORAGE_KEY);
  assert.deepEqual(loadCollectionState(storage, primeItems, {
    rotationId: "rotation-future",
    activeItemIds: ["future-frame"],
    defaultAyaBudget: 37,
    preview: true
  }), {
    selectedItemIds: ["future-frame"],
    owned: { "future-frame": { systems: 1 } },
    ayaBudget: 37
  });
  assert.equal(storage.getItem(STORAGE_KEY), before);
});

test("损坏的本地状态不会阻止页面打开", () => {
  const storage = memoryStorage();
  storage.setItem(STORAGE_KEY, "not-json");
  assert.deepEqual(loadCollectionState(storage, primeItems, currentOptions), {
    selectedItemIds: ["frame", "weapon"],
    owned: {},
    ayaBudget: 33
  });
});
