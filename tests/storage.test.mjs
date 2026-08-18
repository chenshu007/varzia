import test from "node:test";
import assert from "node:assert/strict";
import { STORAGE_KEY, loadCollectionState, saveCollectionState } from "../js/storage.js";

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
  assert.equal(serialized.schemaVersion, 3);
  assert.equal(serialized.selectionRotationId, "rotation-current");
  assert.equal(serialized.inputRotationId, "rotation-current");
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
