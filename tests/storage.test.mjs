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
  { id: "weapon", parts: [{ id: "barrel", required: 2 }] }
];

test("首次进入默认全选本期所有 Prime 装备", () => {
  const state = loadCollectionState(memoryStorage(), primeItems);
  assert.deepEqual(state.selectedItemIds, ["frame", "weapon"]);
  assert.deepEqual(state.owned, {});
});

test("收藏数量与主动清空目标可以保存并恢复", () => {
  const storage = memoryStorage();
  const state = { selectedItemIds: [], owned: { weapon: { barrel: 1 } } };
  assert.equal(saveCollectionState(storage, state), true);
  assert.deepEqual(loadCollectionState(storage, primeItems), state);
});

test("同一轮换主动全不选会保留空目标", () => {
  const storage = memoryStorage();
  saveCollectionState(storage, { rotationId: "rotation-current", selectedItemIds: [], owned: {} });
  assert.deepEqual(loadCollectionState(storage, primeItems, "rotation-current"), {
    selectedItemIds: [],
    owned: {}
  });
});

test("旧轮换目标全部失效时默认全选新轮换", () => {
  const storage = memoryStorage();
  storage.setItem(STORAGE_KEY, JSON.stringify({
    schemaVersion: 2,
    rotationId: "rotation-old",
    selectedItemIds: ["old-frame", "old-weapon"],
    owned: {}
  }));
  assert.deepEqual(loadCollectionState(storage, primeItems, "rotation-current"), {
    selectedItemIds: ["frame", "weapon"],
    owned: {}
  });
});

test("旧轮换主动全不选不会让新轮换停在空目标", () => {
  const storage = memoryStorage();
  saveCollectionState(storage, { rotationId: "rotation-old", selectedItemIds: [], owned: {} });
  assert.deepEqual(loadCollectionState(storage, primeItems, "rotation-current"), {
    selectedItemIds: ["frame", "weapon"],
    owned: {}
  });
});

test("损坏的本地状态不会阻止页面打开并回到默认全选", () => {
  const storage = memoryStorage();
  storage.setItem(STORAGE_KEY, "not-json");
  assert.deepEqual(loadCollectionState(storage, primeItems), { selectedItemIds: ["frame", "weapon"], owned: {} });
});

test("V1 数组收藏会迁移为数量模型且新版本默认全选", () => {
  const storage = memoryStorage();
  storage.setItem(STORAGE_KEY, JSON.stringify({
    selectedTargetIds: ["frame"],
    owned: { frame: ["blueprint"], weapon: ["barrel"] }
  }));
  assert.deepEqual(loadCollectionState(storage, primeItems), {
    selectedItemIds: ["frame", "weapon"],
    owned: { frame: { blueprint: 1 }, weapon: { barrel: 2 } }
  });
});
