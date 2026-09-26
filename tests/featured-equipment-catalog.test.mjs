import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  featuredEquipmentFor,
  loadFeaturedEquipmentCatalog,
  validateFeaturedEquipmentCatalog,
  validateFeaturedEquipmentExports
} from "../scripts/lib/featured-equipment-catalog.mjs";
import { lineupFromVaultExport } from "../scripts/lib/prime-vault-preview.mjs";
import { parseDropTables, SYNC_MUTABLE_DATA_PATHS } from "../scripts/lib/prime-resurgence-sync.mjs";

const fixture = async name => JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const candidate = { primeWarframes: ["Ivara Prime", "Protea Prime"], effectiveAt: "2026-10-01T18:00:00Z" };

async function ivaraProteaEvidence() {
  const evidence = await fixture("prime-resurgence-braton-official.json");
  return { ...evidence, exportUrls: evidence.lineup.previewEvidence.exportUrls };
}

test("人工 featured 目录保留四组官方来源和 Public Export 身份", async () => {
  const catalog = loadFeaturedEquipmentCatalog();
  const old = await fixture("prime-vault-inventory.json");
  const next = await ivaraProteaEvidence();
  assert.deepEqual(catalog.entries.map(entry => [entry.warframe.name, entry.items.map(item => item.name), entry.sourceUrl]), [
    ["Banshee Prime", ["Euphona Prime", "Helios Prime"], "https://www.warframe.com/en/news/banshee-ve-mirage-prime-vault"],
    ["Mirage Prime", ["Akbolto Prime", "Kogake Prime"], "https://www.warframe.com/en/news/banshee-ve-mirage-prime-vault"],
    ["Ivara Prime", ["Aksomati Prime", "Baza Prime"], "https://www.warframe.com/en/news/-549"],
    ["Protea Prime", ["Okina Prime", "Velox Prime"], "https://www.warframe.com/en/news/protea-prime-access"]
  ]);
  validateFeaturedEquipmentExports(catalog.entries, [...old.equipmentEn, ...next.equipmentEn]);
  assert.ok(SYNC_MUTABLE_DATA_PATHS.every(file => !file.includes("featured-equipment")));
});

test("两种已支持组合保持原 featured、全部奖励及附带装备结果", async () => {
  const old = await fixture("prime-vault-inventory.json");
  const dropRelics = parseDropTables(await readFile(new URL("./fixtures/prime-resurgence-drop-tables.html", import.meta.url), "utf8"));
  const oldCandidate = { primeWarframes: ["Banshee Prime", "Mirage Prime"], effectiveAt: "2026-09-03T18:00:00Z" };
  const oldLineup = lineupFromVaultExport(oldCandidate, old, dropRelics);
  assert.deepEqual(oldLineup.items.map(item => item.name), ["Akbolto Prime", "Banshee Prime", "Euphona Prime", "Helios Prime", "Kogake Prime", "Mirage Prime"]);
  assert.deepEqual(oldLineup.rewardItems, oldLineup.items);
  assert.deepEqual(oldLineup.previewEvidence.incidentalItemNames, []);
  assert.deepEqual(oldLineup.inventoryRelics.map(relic => relic.name).sort(), ["Axi A12", "Axi H5", "Lith K5", "Lith M7", "Meso E5", "Neo B6"]);

  const next = await ivaraProteaEvidence();
  const lineup = lineupFromVaultExport(candidate, next, next.dropRelics);
  const featuredNames = ["Aksomati Prime", "Baza Prime", "Ivara Prime", "Okina Prime", "Protea Prime", "Velox Prime"];
  assert.deepEqual(lineup.items, next.lineup.items.filter(item => featuredNames.includes(item.name)));
  assert.deepEqual(lineup.rewardItems, next.lineup.items);
  assert.deepEqual(lineup.warframes, next.lineup.warframes);
  assert.deepEqual(lineup.inventoryRelics, next.lineup.inventoryRelics);
  assert.deepEqual(lineup.previewEvidence.incidentalItemNames, ["Braton Prime", "Burston Prime"]);
  assert.deepEqual(lineupFromVaultExport({ ...candidate, primeWarframes: [...candidate.primeWarframes].reverse() }, next, next.dropRelics).items, lineup.items);
});

test("未知组合或缺失归属明确要求补录，不从遗物奖励猜测", async () => {
  const official = await ivaraProteaEvidence();
  assert.throws(() => lineupFromVaultExport({ ...candidate, primeWarframes: ["Unknown Prime", "Protea Prime"] }, official, official.dropRelics), /Missing official featured equipment ownership for Unknown Prime.*human review/);
  const catalog = loadFeaturedEquipmentCatalog();
  catalog.entries = catalog.entries.filter(entry => entry.warframe.name !== "Ivara Prime");
  assert.throws(() => lineupFromVaultExport(candidate, official, official.dropRelics, { featuredCatalog: catalog }), /Missing official featured equipment ownership for Ivara Prime/);
  // A supported announcement without its Vault export still waits for evidence.
  assert.equal(lineupFromVaultExport(candidate, { ...official, relicExport: [] }, official.dropRelics), null);
  assert.throws(() => featuredEquipmentFor(["Ivara Prime", "Ivara Prime"]), /two distinct/);
});

test("目录拒绝无来源、非可信来源、重复或含歧义的装备归属", () => {
  for (const sourceUrl of [undefined, "http://www.warframe.com/en/news/example", "https://warframe.com.evil.test/en/news/example", "https://www.warframe.com@evil.test/en/news/example", "https://name:secret@www.warframe.com/en/news/example", "https://www.warframe.com:444/en/news/example", "https://www.warframe.com/en/news/example?token=secret"]) {
    const catalog = loadFeaturedEquipmentCatalog();
    catalog.entries[0].sourceUrl = sourceUrl;
    assert.throws(() => validateFeaturedEquipmentCatalog(catalog), /Missing or untrusted official featured equipment source.*human review/);
  }
  for (const mutate of [
    catalog => catalog.entries.push(structuredClone(catalog.entries[0])),
    catalog => catalog.entries[1].items[0] = structuredClone(catalog.entries[0].items[0]),
    catalog => catalog.entries[0].items[1].uniqueName = catalog.entries[0].items[0].uniqueName,
    catalog => catalog.entries[0].items[1].name = catalog.entries[0].items[0].name,
    catalog => catalog.entries[0].items[0] = structuredClone(catalog.entries[0].warframe)
  ]) {
    const catalog = loadFeaturedEquipmentCatalog();
    mutate(catalog);
    assert.throws(() => validateFeaturedEquipmentCatalog(catalog), /Duplicate or ambiguous featured equipment ownership/);
  }
});

test("目录版本、名称、标识和装备数量必须合法", () => {
  for (const [mutate, expected] of [
    [catalog => catalog.schemaVersion = 2, /schemaVersion/],
    [catalog => catalog.entries = [], /entries are missing/],
    [catalog => catalog.entries[0].items.pop(), /two equipment items/],
    [catalog => catalog.entries[0].items[0].name = " Euphona Prime", /Invalid.*name/],
    [catalog => catalog.entries[0].items[0].uniqueName = "/Lotus/../Secret", /Invalid.*identifier/]
  ]) {
    const catalog = loadFeaturedEquipmentCatalog();
    mutate(catalog);
    assert.throws(() => validateFeaturedEquipmentCatalog(catalog), expected);
  }
});

test("官方导出与目录的身份或装备角色冲突一律停止", async () => {
  for (const mutate of [
    official => official.equipmentEn.find(item => item.name === "Baza Prime").uniqueName += "Changed",
    official => official.equipmentEn.find(item => item.name === "Baza Prime").name = "Wrong Prime",
    official => official.equipmentEn.find(item => item.name === "Baza Prime").productCategory = "Suits",
    official => official.equipmentEn.find(item => item.name === "Baza Prime").productCategory = "Unknown",
    official => official.equipmentEn.find(item => item.name === "Baza Prime").productCategory = "constructor",
    official => official.equipmentEn.find(item => item.name === "Ivara Prime").productCategory = "Pistols",
    official => official.equipmentEn = official.equipmentEn.filter(item => item.name !== "Baza Prime"),
    official => official.equipmentEn.push(structuredClone(official.equipmentEn.find(item => item.name === "Baza Prime")))
  ]) {
    const official = await ivaraProteaEvidence();
    mutate(official);
    assert.throws(() => lineupFromVaultExport(candidate, official, official.dropRelics), /catalog disagrees with official export identity or ownership role.*human review/);
  }
  const official = await ivaraProteaEvidence();
  const catalog = loadFeaturedEquipmentCatalog();
  const entry = catalog.entries.find(entry => entry.warframe.name === "Ivara Prime");
  entry.items[0].uniqueName = official.equipmentEn.find(item => item.name === "Braton Prime").uniqueName;
  assert.throws(() => lineupFromVaultExport(candidate, official, official.dropRelics, { featuredCatalog: catalog }), /catalog disagrees with official export identity or ownership role/);
});

test("目录中的装备必须有本期官方遗物奖励证据", async () => {
  const official = await ivaraProteaEvidence();
  for (const relic of official.dropRelics) {
    relic.rewards = relic.rewards.map(reward => reward.name.startsWith("Baza Prime ") ? { ...reward, name: "Forma Blueprint" } : reward);
  }
  assert.throws(() => lineupFromVaultExport(candidate, official, official.dropRelics), /Featured Prime equipment is missing.*human review/);
});

test("错误归属即使装备本身存在于官方导出，也不能用无关装备替换本期目标", async () => {
  const official = await ivaraProteaEvidence();
  const previous = await fixture("prime-vault-inventory.json");
  official.equipmentEn.push(...previous.equipmentEn);
  const catalog = loadFeaturedEquipmentCatalog();
  const banshee = catalog.entries.find(entry => entry.warframe.name === "Banshee Prime");
  const ivara = catalog.entries.find(entry => entry.warframe.name === "Ivara Prime");
  [banshee.items[0], ivara.items[0]] = [ivara.items[0], banshee.items[0]];
  assert.throws(() => lineupFromVaultExport(candidate, official, official.dropRelics, { featuredCatalog: catalog }), /Featured Prime equipment is missing.*human review/);
});

test("目录加载只读并对缺失或损坏 JSON 明确失败", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "varzia-featured-catalog-"));
  const filename = path.join(directory, "catalog.json");
  assert.throws(() => loadFeaturedEquipmentCatalog(filename), /could not be read as JSON.*human review/);
  await writeFile(filename, "{broken", "utf8");
  assert.throws(() => loadFeaturedEquipmentCatalog(filename), /could not be read as JSON.*human review/);
  assert.equal(await readFile(filename, "utf8"), "{broken");
});
