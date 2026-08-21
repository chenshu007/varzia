import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateRotationData } from "../js/data-validation.js";

const rotation = JSON.parse(await readFile(new URL("../data/rotation.json", import.meta.url), "utf8"));
const primes = JSON.parse(await readFile(new URL("../data/primes.json", import.meta.url), "utf8"));
const relicData = JSON.parse(await readFile(new URL("../data/relics.json", import.meta.url), "utf8"));
const currentRotation = rotation.rotations.find(({ id }) => id === "revenant-baruuk-2026-08");
const nextRotation = rotation.rotations.find(({ id }) => id === "banshee-mirage-2026-09");
const DAY_MS = 24 * 60 * 60 * 1_000;

function utcSecondsAfter(startsAt, days) {
  return new Date(Date.parse(startsAt) + days * DAY_MS).toISOString().replace(".000Z", "Z");
}

function appendFixtureRotation(schedule, primeCatalog, relicCatalog, suffix, startsAt) {
  const itemId = `future-item-${suffix}`;
  const relicId = `future-relic-${suffix}`;
  const rotationId = `future-rotation-${suffix}`;
  primeCatalog.primeItems.push({
    id: itemId,
    name: `Future Item ${suffix.toUpperCase()}`,
    type: "warframe",
    rotation: rotationId,
    relics: [relicId],
    parts: [
      { id: "blueprint", name: "蓝图", required: 1, rarity: "rare", relics: [relicId] }
    ]
  });
  relicCatalog.relics.push({
    id: relicId,
    name: `Future Relic ${suffix.toUpperCase()}`,
    costAya: 1,
    rotation: rotationId,
    rewards: [
      { itemId, partId: "blueprint", rarity: "rare" }
    ]
  });
  schedule.rotations.push({
    id: rotationId,
    publicationStatus: "published",
    displayName: `Future Rotation ${suffix.toUpperCase()}`,
    startsAt,
    items: [itemId],
    relics: [relicId],
    defaults: { ayaBudget: 10 }
  });
}

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
  duplicateRotation.rotations[0].items.push(duplicateRotation.rotations[0].items[0]);
  assert.throws(() => validateRotationData(duplicateRotation, primes, relicData), /Duplicate rotation item/);

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
  const itemMap = new Map(primes.primeItems.map((item) => [item.id, item]));
  const currentItems = currentRotation.items.map((itemId) => itemMap.get(itemId));
  assert.equal(currentItems.length, 6);
  assert.ok(currentItems.every(Boolean));
  assert.equal(currentItems.filter((item) => item.type === "warframe").length, 2);
  assert.equal(currentItems.filter((item) => ["primary", "secondary", "melee"].includes(item.type)).length, 4);
  assert.equal(currentItems.filter((item) => !["warframe", "primary", "secondary", "melee"].includes(item.type)).length, 0);
});

test("每个本期部件都有双向遗物映射且只使用当前六枚遗物", () => {
  const itemMap = new Map(primes.primeItems.map((item) => [item.id, item]));
  const allRelicMap = new Map(relicData.relics.map((relic) => [relic.id, relic]));
  const currentItems = currentRotation.items.map((itemId) => itemMap.get(itemId));
  const currentRelicMap = new Map(currentRotation.relics.map((relicId) => [relicId, allRelicMap.get(relicId)]));
  assert.equal(currentRelicMap.size, 6);
  assert.ok([...currentRelicMap.values()].every(Boolean));
  for (const item of currentItems) {
    for (const part of item.parts) {
      const currentRoutes = part.relics.filter((relicId) => currentRelicMap.has(relicId));
      assert.ok(currentRoutes.length > 0, `${item.name} ${part.name} 缺少本期遗物路线`);
      for (const relicId of currentRoutes) {
        const relic = currentRelicMap.get(relicId);
        assert.ok(relic.rewards.some((reward) => reward.itemId === item.id && reward.partId === part.id), `${relicId} 缺少反向奖励映射`);
      }
    }
  }
});

test("每一期都引用非空、存在且相互一致的装备与遗物", () => {
  const itemMap = new Map(primes.primeItems.map((item) => [item.id, item]));
  const relicMap = new Map(relicData.relics.map((relic) => [relic.id, relic]));

  for (const scheduledRotation of rotation.rotations) {
    assert.ok(scheduledRotation.items.length > 0, `${scheduledRotation.id} 没有装备`);
    assert.ok(scheduledRotation.relics.length > 0, `${scheduledRotation.id} 没有遗物`);
    assert.equal(new Set(scheduledRotation.items).size, scheduledRotation.items.length);
    assert.equal(new Set(scheduledRotation.relics).size, scheduledRotation.relics.length);

    const scheduledItemIds = new Set(scheduledRotation.items);
    const scheduledRelicIds = new Set(scheduledRotation.relics);
    for (const itemId of scheduledItemIds) {
      const item = itemMap.get(itemId);
      assert.ok(item, `${scheduledRotation.id} 引用了未知装备 ${itemId}`);
      for (const part of item.parts) {
        assert.ok(part.relics.some((relicId) => scheduledRelicIds.has(relicId)), `${scheduledRotation.id} 的 ${itemId}/${part.id} 没有本期路线`);
      }
    }
    for (const relicId of scheduledRelicIds) {
      const relic = relicMap.get(relicId);
      assert.ok(relic, `${scheduledRotation.id} 引用了未知遗物 ${relicId}`);
      assert.ok(relic.rewards.every((reward) => scheduledItemIds.has(reward.itemId)), `${relicId} 奖励超出 ${scheduledRotation.id}`);
    }
  }
});

test("下一期详细数据保持 provisional，并记录已确认来源及待更新轮换页", () => {
  assert.equal(rotation.lastVerified, "2026-08-14");
  assert.equal(primes.updatedAt, "2026-08-14");
  assert.equal(relicData.updatedAt, "2026-08-14");
  assert.equal(nextRotation.publicationStatus, "provisional");
  assert.deepEqual(
    [nextRotation.source.rotationUrl, nextRotation.source.announcementUrl, nextRotation.source.dropTableUrl],
    [
      null,
      "https://x.com/PlayWarframe/status/2090499222894231614",
      "https://www.warframe.com/droptables"
    ]
  );
  assert.match(nextRotation.source.recipeExportUrl, /^https:\/\/content\.warframe\.com\/PublicExport\/Manifest\/ExportRecipes_en\.json/);
  assert.deepEqual(nextRotation.source.recipeExceptions.map(({ itemId, status, sourceUrl, publicExportStatus }) => ({ itemId, status, sourceUrl, publicExportStatus })), [
    { itemId: "euphona-prime", status: "curated-manual", sourceUrl: null, publicExportStatus: "missing" }
  ]);
  assert.ok(nextRotation.source.rarityWarnings.length > 0);
});

test("Meso E5 的 Banshee route 与官方 fixture 一致为 blueprint", () => {
  const relic = relicData.relics.find(({ id }) => id === "meso-e5");
  assert.ok(relic.rewards.some((reward) => reward.itemId === "banshee-prime" && reward.partId === "blueprint" && reward.rarity === "uncommon"));
  assert.ok(!relic.rewards.some((reward) => reward.itemId === "banshee-prime" && reward.partId === "chassis"));
  const banshee = primes.primeItems.find(({ id }) => id === "banshee-prime");
  assert.ok(banshee.parts.find(({ id }) => id === "blueprint").relics.includes("meso-e5"));
  assert.ok(!banshee.parts.find(({ id }) => id === "chassis").relics.includes("meso-e5"));
});

test("provisional 轮换缺少角色化来源占位时校验失败", () => {
  const missingSourceField = structuredClone(rotation);
  delete missingSourceField.rotations.find(({ id }) => id === nextRotation.id).source.dropTableUrl;
  assert.throws(
    () => validateRotationData(missingSourceField, primes, relicData),
    /Missing provisional source field/
  );

  const missingRecipeSource = structuredClone(primes);
  delete missingRecipeSource.provisionalSources[nextRotation.id].recipeExportUrl;
  assert.throws(
    () => validateRotationData(rotation, missingRecipeSource, relicData),
    /Missing provisional source field: primes .* recipeExportUrl/
  );
});

test("curated recipe exception 不能伪装成 official source", () => {
  const invalidException = structuredClone(rotation);
  invalidException.rotations.find(({ id }) => id === nextRotation.id).source.recipeExceptions[0].sourceUrl = "https://content.warframe.com/fake";
  assert.throws(() => validateRotationData(invalidException, primes, relicData), /sourceUrl must be null/);

  const unsafeQuantity = structuredClone(primes);
  unsafeQuantity.primeItems.find(({ id }) => id === "akbolto-prime").parts.find(({ id }) => id === "barrel").required = 65_536;
  assert.throws(() => validateRotationData(rotation, unsafeQuantity, relicData), /Invalid required quantity/);
});

test("追加未来 B、C 的装备、遗物和时间表后仍通过通用校验", () => {
  const futureSchedule = structuredClone(rotation);
  const futurePrimes = structuredClone(primes);
  const futureRelics = structuredClone(relicData);
  const futureBStartsAt = utcSecondsAfter(futureSchedule.rotations.at(-1).startsAt, 31);
  appendFixtureRotation(futureSchedule, futurePrimes, futureRelics, "b", futureBStartsAt);
  const futureCStartsAt = utcSecondsAfter(futureSchedule.rotations.at(-1).startsAt, 31);
  appendFixtureRotation(futureSchedule, futurePrimes, futureRelics, "c", futureCStartsAt);
  assert.equal(validateRotationData(futureSchedule, futurePrimes, futureRelics), true);
});

test("轮换 id 与 startsAt 必须各自唯一", () => {
  const duplicateId = structuredClone(rotation);
  duplicateId.rotations.push({
    ...structuredClone(currentRotation),
    startsAt: utcSecondsAfter(duplicateId.rotations.at(-1).startsAt, 31)
  });
  assert.throws(() => validateRotationData(duplicateId, primes, relicData), /Duplicate rotation id/);

  const duplicateStart = structuredClone(rotation);
  duplicateStart.rotations.push({ ...structuredClone(currentRotation), id: "future" });
  assert.throws(() => validateRotationData(duplicateStart, primes, relicData), /Duplicate rotation startsAt/);
});

test("startsAt 必须是精确到秒的 ISO 8601 UTC 且时间表严格递增", () => {
  for (const invalid of ["2026/08/06 18:00", "2026-08-06T18:00:00+00:00", "2026-02-30T18:00:00Z"]) {
    const broken = structuredClone(rotation);
    broken.rotations[0].startsAt = invalid;
    assert.throws(() => validateRotationData(broken, primes, relicData), /Invalid rotation startsAt/);
  }

  const unordered = structuredClone(rotation);
  unordered.rotations.push({ ...structuredClone(currentRotation), id: "earlier", startsAt: "2026-07-06T18:00:00Z" });
  assert.throws(() => validateRotationData(unordered, primes, relicData), /strictly chronological/);
});

test("轮换引用未知装备或未知遗物时校验失败", () => {
  const unknownItem = structuredClone(rotation);
  unknownItem.rotations[0].items[0] = "future-item";
  assert.throws(() => validateRotationData(unknownItem, primes, relicData), /Item is not listed by rotation|Missing rotation item/);

  const unknownRelic = structuredClone(rotation);
  unknownRelic.rotations[0].relics[0] = "future-relic";
  assert.throws(() => validateRotationData(unknownRelic, primes, relicData), /Relic is not listed by rotation|Missing rotation relic source|Missing rotation relic/);
});

test("同一期 relic 不能重复且默认 Aya 必须是非负整数", () => {
  const duplicateRelic = structuredClone(rotation);
  duplicateRelic.rotations[0].relics.push(duplicateRelic.rotations[0].relics[0]);
  assert.throws(() => validateRotationData(duplicateRelic, primes, relicData), /Duplicate rotation relic/);

  const invalidBudget = structuredClone(rotation);
  invalidBudget.rotations[0].defaults.ayaBudget = -1;
  assert.throws(() => validateRotationData(invalidBudget, primes, relicData), /Invalid default ayaBudget/);
});

test("每一期必须至少包含一件装备和一枚遗物", () => {
  const emptyItems = structuredClone(rotation);
  emptyItems.rotations[0].items = [];
  assert.throws(
    () => validateRotationData(emptyItems, primes, relicData),
    /Rotation revenant-baruuk-2026-08 must contain at least one item\./
  );

  const emptyRelics = structuredClone(rotation);
  emptyRelics.rotations[0].relics = [];
  assert.throws(
    () => validateRotationData(emptyRelics, primes, relicData),
    /Rotation revenant-baruuk-2026-08 must contain at least one relic\./
  );
});

test("盗贼双枪 Prime 的重复制造需求计入整期部件总量", () => {
  const afuris = primes.primeItems.find((item) => item.id === "afuris-prime");
  assert.equal(afuris.parts.find((part) => part.id === "barrel").required, 2);
  assert.equal(afuris.parts.find((part) => part.id === "receiver").required, 2);
  const itemMap = new Map(primes.primeItems.map((item) => [item.id, item]));
  const currentItems = currentRotation.items.map((itemId) => itemMap.get(itemId));
  const totalRequired = currentItems.flatMap((item) => item.parts).reduce((sum, part) => sum + part.required, 0);
  assert.equal(totalRequired, 25);
});
