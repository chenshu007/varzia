import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateRotationData } from "../js/data-validation.js";

const rotation = JSON.parse(await readFile(new URL("../data/rotation.json", import.meta.url), "utf8"));
const primes = JSON.parse(await readFile(new URL("../data/primes.json", import.meta.url), "utf8"));
const relicData = JSON.parse(await readFile(new URL("../data/relics.json", import.meta.url), "utf8"));

test("当前轮换通过完整数据一致性校验", () => {
  assert.equal(validateRotationData(rotation, primes, relicData), true);
});

test("同一遗物内重复目标奖励会立即失败并指出具体条目", () => {
  const duplicateRelics = structuredClone(relicData);
  const relic = duplicateRelics.relics[0];
  const reward = relic.rewards[0];
  relic.rewards.push({ ...reward });
  assert.throws(
    () => validateRotationData(rotation, primes, duplicateRelics),
    new RegExp(`Duplicate relic reward:\\n${relic.name}\\n${reward.itemId} / ${reward.partId}`)
  );
});

test("轮换 itemId 与装备 partId 都必须唯一", () => {
  const duplicateRotation = structuredClone(rotation);
  duplicateRotation.rotation.itemIds.push(duplicateRotation.rotation.itemIds[0]);
  assert.throws(() => validateRotationData(duplicateRotation, primes, relicData), /Duplicate rotation itemId/);

  const duplicateParts = structuredClone(primes);
  duplicateParts.primeItems[0].parts.push({ ...duplicateParts.primeItems[0].parts[0] });
  assert.throws(() => validateRotationData(rotation, duplicateParts, relicData), /Duplicate partId/);
});

test("双向映射与稀有度不一致时数据校验失败", () => {
  const brokenMapping = structuredClone(primes);
  brokenMapping.primeItems[0].parts[0].relics = [];
  assert.throws(() => validateRotationData(rotation, brokenMapping, relicData), /Missing relic source/);

  const brokenRarity = structuredClone(relicData);
  brokenRarity.relics[0].rewards[0].rarity = "rare";
  assert.throws(() => validateRotationData(rotation, primes, brokenRarity), /Rarity mismatch/);
});

test("本期轮换包含两件战甲和四件武器", () => {
  const itemIds = new Set(rotation.rotation.itemIds);
  const items = primes.primeItems.filter((item) => itemIds.has(item.id));
  assert.equal(items.length, 6);
  assert.equal(items.filter((item) => item.type === "warframe").length, 2);
  assert.equal(items.filter((item) => ["primary", "secondary", "melee"].includes(item.type)).length, 4);
  assert.equal(items.filter((item) => !["warframe", "primary", "secondary", "melee"].includes(item.type)).length, 0);
});

test("每个本期部件都有双向遗物映射且只使用当前六枚遗物", () => {
  const relicMap = new Map(relicData.relics.map((relic) => [relic.id, relic]));
  assert.equal(relicMap.size, 6);
  for (const item of primes.primeItems) {
    assert.equal(item.rotation, rotation.rotation.id);
    assert.ok(item.relics.length > 0);
    for (const part of item.parts) {
      assert.ok(part.relics.length > 0, `${item.name} ${part.name} 缺少 part -> relic[]`);
      for (const relicId of part.relics) {
        const relic = relicMap.get(relicId);
        assert.ok(relic, `${relicId} 不在当前轮换`);
        assert.ok(relic.rewards.some((reward) => reward.itemId === item.id && reward.partId === part.id), `${relicId} 缺少反向奖励映射`);
      }
    }
  }
});

test("盗贼双枪 Prime 的重复制造需求计入整期部件总量", () => {
  const afuris = primes.primeItems.find((item) => item.id === "afuris-prime");
  assert.equal(afuris.parts.find((part) => part.id === "barrel").required, 2);
  assert.equal(afuris.parts.find((part) => part.id === "receiver").required, 2);
  const totalRequired = primes.primeItems.flatMap((item) => item.parts).reduce((sum, part) => sum + part.required, 0);
  assert.equal(totalRequired, 25);
});
