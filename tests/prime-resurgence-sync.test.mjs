import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  OFFICIAL_SOURCES,
  candidateIdFor,
  escapeMarkdownInline,
  fetchOfficialInputs,
  fetchResource,
  failureSummary,
  nearRotationWatchWindow,
  parseAnnouncementText,
  parseDropTables,
  parseOfficialAnnouncements,
  parsePrimeResurgencePages,
  parseRecipeExceptions,
  parseRecipes,
  resolveRecipeRequirements,
  runNearRotationWatcher,
  runPrimeResurgenceSync,
  SYNC_MUTABLE_DATA_PATHS,
  selectNearRotationCandidate,
  selectRelicSet,
  validateVaultRewardCatalog,
  writeAtomically
} from "../scripts/lib/prime-resurgence-sync.mjs";
import { validateAnnouncementCandidates, validateRotationData } from "../js/data-validation.js";
import { normalizeOfficialTimestamp } from "../js/prime-resurgence-candidate.js";
import { publishedRotations, resolveRotationState } from "../js/rotation-schedule.js";
import { lineupFromInventory, parsePrimeVaultTrader } from "../scripts/lib/prime-vault-inventory.mjs";
import { lineupFromVaultExport } from "../scripts/lib/prime-vault-preview.mjs";

const fixtureDirectory = new URL("./fixtures/", import.meta.url);
const inventoryNames = ["Lith K5", "Lith M7", "Meso E5", "Neo B6", "Axi A12", "Axi H5"];
const repositoryRoot = path.resolve(new URL("..", import.meta.url).pathname);

async function fixture(name) {
  return await readFile(new URL(name, fixtureDirectory), "utf8");
}

test("PR 摘要中的外部文本被限制为单行 Markdown 文本", () => {
  assert.equal(escapeMarkdownInline("Banshee *Prime*\n## forged"), "Banshee \\*Prime\\* \\#\\# forged");
  const unprintable = { toString() { throw new Error("do not mask the original failure"); } };
  assert.match(failureSummary(unprintable), /could not be converted to text safely/);
});

async function fixtureInputs() {
  return {
    ...JSON.parse(await fixture("prime-vault-inventory.json")),
    englishHtml: await fixture("prime-resurgence-en.html"),
    chineseHtml: await fixture("prime-resurgence-zh.html"),
    announcementText: await fixture("prime-resurgence-announcements.json"),
    dropTablesHtml: await fixture("prime-resurgence-drop-tables.html"),
    recipesText: await fixture("prime-resurgence-recipes.json"),
    recipeUrl: "https://content.warframe.com/PublicExport/Manifest/ExportRecipes_en.json!00_fixture"
  };
}

async function temporaryRepository() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "varzia-prime-sync-"));
  await mkdir(path.join(directory, "data"));
  for (const name of ["rotation.json", "primes.json", "relics.json", "prime-resurgence-recipe-exceptions.json"]) {
    await writeFile(path.join(directory, "data", name), await readFile(path.join(repositoryRoot, "data", name), "utf8"), "utf8");
  }
  // The workflow runs tests after syncing live announcements. Start each
  // scenario empty so newly generated candidates cannot leak into fixtures.
  await writeFile(path.join(directory, "data/prime-resurgence-candidates.json"), `${JSON.stringify({ schemaVersion: 1, candidates: [] }, null, 2)}\n`, "utf8");

  // Production data may already contain the currently published rotation.
  // Candidate-pipeline tests need the prior published rotation as their
  // baseline so the fixture lineup can exercise the promotion path.
  const candidateId = "banshee-mirage-2026-09";
  const rotationPath = path.join(directory, "data/rotation.json");
  const primesPath = path.join(directory, "data/primes.json");
  const relicsPath = path.join(directory, "data/relics.json");
  const rotation = JSON.parse(await readFile(rotationPath, "utf8"));
  rotation.rotations = rotation.rotations.filter((entry) => entry.id !== candidateId);

  const primes = JSON.parse(await readFile(primesPath, "utf8"));
  primes.primeItems = primes.primeItems.filter((item) => item.rotation !== candidateId);
  delete primes.provisionalSources?.[candidateId];

  const relics = JSON.parse(await readFile(relicsPath, "utf8"));
  relics.relics = relics.relics.filter((relic) => relic.rotation !== candidateId);
  delete relics.provisionalSources?.[candidateId];

  await Promise.all([
    writeFile(rotationPath, `${JSON.stringify(rotation, null, 2)}\n`, "utf8"),
    writeFile(primesPath, `${JSON.stringify(primes, null, 2)}\n`, "utf8"),
    writeFile(relicsPath, `${JSON.stringify(relics, null, 2)}\n`, "utf8")
  ]);
  return directory;
}

async function temporaryRepositoryWithoutPreparedCandidate() {
  return await temporaryRepository();
}

async function announcementOnlyInputs() {
  const inputs = await fixtureInputs();
  const previous = JSON.parse(JSON.stringify(inputs).replaceAll("Banshee", "Revenant").replaceAll("Mirage", "Baruuk"));
  previous.announcementText = inputs.announcementText;
  previous.dropTablesHtml = inputs.dropTablesHtml;
  previous.recipesText = inputs.recipesText;
  previous.equipmentEn.push(...inputs.equipmentEn.filter(item => item.productCategory === "Suits"));
  const world = JSON.parse(previous.worldStateText);
  world.PrimeVaultTraders[0].Activation = { $date: { $numberLong: String(Date.parse("2026-08-06T18:00:00Z")) } };
  previous.worldStateText = JSON.stringify(world);
  return previous;
}

async function prelaunchInputs() {
  const inputs = await fixtureInputs();
  const previous = await announcementOnlyInputs();
  return { ...inputs, worldStateText: previous.worldStateText, englishHtml: previous.englishHtml, chineseHtml: previous.chineseHtml };
}

test("开卖前从官方组合专属 Vault 组完成候选，旧商店和旧官网不阻挡审核", async () => {
  const rootDir = await temporaryRepository();
  const before = (await dataSnapshot(rootDir)).map(text => JSON.parse(text));
  const inputs = await prelaunchInputs();
  const result = await runPrimeResurgenceSync({ rootDir, inputs, now: "2026-08-21T18:00:00Z" });
  assert.equal(result.candidate.status, "ready-for-review");
  assert.equal(result.itemCount, 6);
  assert.equal(result.relicCount, 6);
  assert.equal(result.totalRequiredParts, 26);
  assert.equal(result.candidate.source.officialData.worldState, undefined);
  assert.equal(result.candidate.source.officialData.vaultExport.group, "BansheeMirageVault");
  assert.match(result.summary, /actual sale price has not been observed/);
  const [rotations, primes, relics] = (await dataSnapshot(rootDir)).map(text => JSON.parse(text));
  const prepared = rotations.rotations.find(rotation => rotation.id === result.candidate.id);
  assert.equal(prepared.publicationStatus, "provisional");
  assert.equal(prepared.source.inventory, undefined);
  assert.deepEqual(prepared.relics.slice().sort(), inventoryNames.map(name => name.toLowerCase().replaceAll(" ", "-")).sort());
  for (const previous of before[0].rotations) assert.deepEqual(rotations.rotations.find(rotation => rotation.id === previous.id), previous);
  assert.equal(validateRotationData(rotations, primes, relics), true);
  assert.equal(publishedRotations(rotations.rotations).some(rotation => rotation.id === prepared.id), false);
  // A human-reviewed future rotation is published now, then activated on time.
  prepared.publicationStatus = "published";
  assert.equal(validateRotationData(rotations, primes, relics), true);
  const schedule = publishedRotations(rotations.rotations);
  assert.equal(resolveRotationState(schedule, Date.parse("2026-09-03T17:59:59Z")).activeRotation.id, "revenant-baruuk-2026-08");
  assert.equal(resolveRotationState(schedule, Date.parse("2026-09-03T18:00:00Z")).activeRotation.id, prepared.id);
  const snapshot = await dataSnapshot(rootDir);
  const rerun = await runPrimeResurgenceSync({ rootDir, inputs, now: "2026-08-22T18:00:00Z" });
  assert.equal(rerun.status, "NO_OP");
  assert.deepEqual(await dataSnapshot(rootDir), snapshot);
});

test("World State 暂不可用也不阻挡提前准备，有明确来源警告", async () => {
  const fixture = await prelaunchInputs();
  const fetchFixture = officialFetchFixture(fixture, []);
  const inputs = await fetchOfficialInputs({ decompress: fixtureIndexDecompress,
    fetchImpl: async (url, options) => url === OFFICIAL_SOURCES.worldState ? new Response("unavailable", { status: 403 }) : fetchFixture(url, options)
  });
  assert.equal(inputs.worldStateText, undefined);
  const result = await runPrimeResurgenceSync({ rootDir: await temporaryRepository(), inputs, now: "2026-08-21T18:00:00Z" });
  assert.equal(result.candidate.status, "ready-for-review");
  assert.match(result.summary, /World State unavailable: Official source returned HTTP 403/);
});

test("提前审核发布后按实际商店复核，清单变化会报错而不覆盖已发布数据", async () => {
  const rootDir = await temporaryRepository();
  const prepared = await runPrimeResurgenceSync({ rootDir, inputs: await prelaunchInputs(), now: "2026-08-21T18:00:00Z" });
  const rotations = JSON.parse(await readFile(path.join(rootDir, "data/rotation.json"), "utf8"));
  rotations.rotations.find(rotation => rotation.id === prepared.candidate.id).publicationStatus = "published";
  await writeFile(path.join(rootDir, "data/rotation.json"), JSON.stringify(rotations));
  await writeFile(path.join(rootDir, "data/prime-resurgence-candidates.json"), JSON.stringify({ schemaVersion: 1, candidates: [] }));
  const before = await dataSnapshot(rootDir);
  const actual = await fixtureInputs();
  const verified = await runPrimeResurgenceSync({ rootDir, inputs: actual, now: "2026-09-03T18:00:00Z" });
  assert.equal(verified.publicationStatus, "published");
  assert.deepEqual(verified.changedFiles, []);
  assert.deepEqual(await dataSnapshot(rootDir), before);
  const feed = JSON.parse(actual.announcementText);
  const next = structuredClone(feed.feed[0]);
  next.post.uri = next.post.uri.replace("3mtjt7pmvpr2o", "3mvqabe4v5m2w");
  next.post.record.createdAt = "2026-09-17T18:00:20.412Z";
  next.post.record.text = "Ivara Prime and Protea Prime enter Prime Resurgence on October 1 at 2 p.m. ET.";
  feed.feed.unshift(next);
  actual.announcementText = JSON.stringify(feed);
  const pending = await runPrimeResurgenceSync({ rootDir, inputs: actual, now: "2026-09-21T18:00:00Z", dryRun: true });
  assert.equal(pending.candidateStage, "announced");
  assert.equal(pending.publishedVerification, prepared.candidate.id);
  assert.match(pending.summary, /Published preview verified against live inventory/);
  // Revalidation must still run while the following rotation is pending.
  const world = JSON.parse(actual.worldStateText);
  world.PrimeVaultTraders[0].Manifest = world.PrimeVaultTraders[0].Manifest.filter(entry => !entry.ItemType.endsWith("T1VoidProjectionBansheeMirageVaultBBronze"));
  actual.worldStateText = JSON.stringify(world);
  await assert.rejects(runPrimeResurgenceSync({ rootDir, inputs: actual, now: "2026-09-21T18:00:00Z" }), /Incomplete|differs|mismatch|missing/i);
  assert.deepEqual(await dataSnapshot(rootDir), before);
});

test("提前准备只使用精确 Vault 组合，不按历史奖励覆盖率猜测或截断遗物", async () => {
  const inputs = await prelaunchInputs();
  const candidate = { primeWarframes: ["Banshee Prime", "Mirage Prime"], effectiveAt: "2026-09-03T18:00:00Z" };
  const dropRelics = parseDropTables(inputs.dropTablesHtml);
  const unrelated = structuredClone(inputs.relicExport[0]);
  unrelated.uniqueName = unrelated.uniqueName.replace("BansheeMirageVault", "BansheeOtherVault");
  unrelated.name = "Axi Z99 Relic";
  inputs.relicExport.push(unrelated);
  dropRelics.push({ ...structuredClone(dropRelics[0]), name: "Axi Z99" });
  assert.equal(lineupFromVaultExport(candidate, inputs, dropRelics).inventoryRelics.length, 6);
  inputs.relicExport.at(-1).uniqueName = inputs.relicExport.at(-1).uniqueName.replace("BansheeOtherVaultB", "BansheeMirageVaultC");
  assert.equal(lineupFromVaultExport(candidate, inputs, dropRelics).inventoryRelics.length, 7);
  assert.equal(lineupFromVaultExport({ ...candidate, primeWarframes: ["Ivara Prime", "Protea Prime"] }, inputs, dropRelics), null);
});

test("提前准备遇到歧义、部分数据和来源冲突时停止且不写四份数据", async () => {
  for (const variant of ["ambiguous-group", "duplicate-id", "missing-table", "partial-parts", "wrong-reward", "wrong-warframes", "missing-translation"]) {
    const rootDir = await temporaryRepository();
    const before = await dataSnapshot(rootDir);
    const inputs = await prelaunchInputs();
    if (variant === "ambiguous-group") inputs.relicExport.push({ ...structuredClone(inputs.relicExport[0]), uniqueName: inputs.relicExport[0].uniqueName.replace("BansheeMirageVault", "MirageBansheeVault") });
    if (variant === "duplicate-id") inputs.relicExport.push(structuredClone(inputs.relicExport[0]));
    if (variant === "missing-table") inputs.relicExport[0].name = "Axi Z99 Relic";
    if (variant === "partial-parts") inputs.relicExport = inputs.relicExport.slice(0, 2);
    if (variant === "wrong-reward") inputs.relicExport[0].relicRewards[0].rewardName = "/Lotus/StoreItems/Types/Recipes/Weapons/WeaponParts/AkboltoPrimeBarrel";
    if (variant === "wrong-warframes") inputs.dropTablesHtml = inputs.dropTablesHtml.replaceAll("Mirage Prime", "Ivara Prime");
    if (variant === "missing-translation") inputs.equipmentZh = inputs.equipmentZh.slice(1);
    await assert.rejects(runPrimeResurgenceSync({ rootDir, inputs, now: "2026-08-21T18:00:00Z" }), /Ambiguous|Duplicate|missing|Incomplete|Missing|disagree/i, variant);
    assert.deepEqual(await dataSnapshot(rootDir), before, variant);
  }
});

test("Vault 预备证据必须绑定公告组合、生效时间和完整遗物集合", async () => {
  const rootDir = await temporaryRepository();
  await runPrimeResurgenceSync({ rootDir, inputs: await prelaunchInputs(), now: "2026-08-21T18:00:00Z" });
  const [rotations, primes, relics, candidates] = (await dataSnapshot(rootDir)).map(text => JSON.parse(text));
  for (const variant of ["wrong-group", "wrong-time", "wrong-price-basis"]) {
    const altered = structuredClone(candidates);
    const evidence = altered.candidates[0].source.officialData.vaultExport;
    if (variant === "wrong-group") evidence.group = "IvaraProteaVault";
    if (variant === "wrong-time") evidence.startsAt = "2026-09-04T18:00:00Z";
    if (variant === "wrong-price-basis") evidence.priceBasis = "observed-sale-price";
    assert.throws(() => validateAnnouncementCandidates(altered), /disagree|basis/i);
  }
  rotations.rotations.find(rotation => rotation.source?.vaultExport).source.vaultExport.relics.pop();
  assert.throws(() => validateRotationData(rotations, primes, relics), /disagree with Vault export/);
});

function officialFetchFixture(inputs, requested) {
  const payloads = new Map([
    [OFFICIAL_SOURCES.rotationEn, inputs.englishHtml],
    [OFFICIAL_SOURCES.rotationZh, inputs.chineseHtml],
    [OFFICIAL_SOURCES.announcementFeed, inputs.announcementText],
    [OFFICIAL_SOURCES.worldState, inputs.worldStateText],
    [OFFICIAL_SOURCES.dropTables, inputs.dropTablesHtml],
    [OFFICIAL_SOURCES.publicExportIndex, Buffer.from("en")],
    ["https://content.warframe.com/PublicExport/index_zh.txt.lzma", Buffer.from("zh")],
    [inputs.recipeUrl, inputs.recipesText],
    [inputs.exportUrls.RelicArcane_en, JSON.stringify({ ExportRelicArcane: inputs.relicExport })]
  ]);
  const categories = { Warframes: ["Suits"], Weapons: ["LongGuns", "Pistols", "Melee"], Sentinels: ["Sentinels"] };
  for (const locale of ["en", "zh"]) {
    for (const [type, allowed] of Object.entries(categories)) {
      const records = inputs[locale === "en" ? "equipmentEn" : "equipmentZh"].filter(item => allowed.includes(item.productCategory));
      payloads.set(inputs.exportUrls[`${type}_${locale}`], JSON.stringify({ [`Export${type}`]: records }));
    }
  }
  return async (url) => {
    requested.push(url);
    const payload = payloads.get(url);
    if (payload === undefined) throw new Error(`Unexpected official request: ${url}`);
    return new Response(payload, { status: 200 });
  };
}

function fixtureIndexDecompress(buffer) {
  const locale = buffer.toString();
  return ["Recipes", "RelicArcane", "Warframes", "Weapons", "Sentinels"].map(type => `Export${type}_${locale}.json!00_fixture`).join("\n");
}

async function fixtureRecipeExceptions() {
  return parseRecipeExceptions(await readFile(path.join(repositoryRoot, "data/prime-resurgence-recipe-exceptions.json"), "utf8"));
}

async function fixtureRequirements(inputs, lineup, selection, recipesOverride = null) {
  return resolveRecipeRequirements(
    parseRecipes(recipesOverride || inputs.recipesText),
    lineup.items,
    selection.expectedByItem,
    { recipeExceptions: await fixtureRecipeExceptions(), recipeUrl: inputs.recipeUrl }
  );
}

async function dataSnapshot(directory) {
  return await Promise.all(["rotation.json", "primes.json", "relics.json", "prime-resurgence-candidates.json"].map((name) => readFile(path.join(directory, "data", name), "utf8")));
}

async function candidateSnapshot(directory) {
  return JSON.parse(await readFile(path.join(directory, "data/prime-resurgence-candidates.json"), "utf8"));
}

async function repositoryWithAnnouncedCandidate() {
  const directory = await temporaryRepositoryWithoutPreparedCandidate();
  await runPrimeResurgenceSync({
    rootDir: directory,
    inputs: await announcementOnlyInputs(),
    now: "2026-08-20T18:01:00.000Z"
  });
  return directory;
}

test("正常官方页面与官方公告可确定性解析", async () => {
  const inputs = await fixtureInputs();
  const lineup = parsePrimeResurgencePages(inputs.englishHtml, inputs.chineseHtml);
  assert.deepEqual(lineup.warframes.map((item) => item.name), ["Banshee Prime", "Mirage Prime"]);
  assert.equal(lineup.items.length, 6);
  assert.equal(lineup.items.find((item) => item.name === "Helios Prime").chineseName, "赫利俄斯 Prime");

  const announcements = parseOfficialAnnouncements(JSON.parse(inputs.announcementText));
  assert.equal(announcements.length, 1);
  assert.equal(announcements[0].startsAt, "2026-09-03T18:00:00Z");
  assert.equal(announcements[0].url, "https://bsky.app/profile/warframe.com/post/3mtjt7pmvpr2o");
  assert.equal(announcements[0].createdAt, "2026-08-20T18:00:25.166Z");
  assert.equal(announcements[0].rawCreatedAt, "2026-08-20T18:00:25.166437193Z");
});

test("实际 World State 物品 ID 精确映射售卖遗物、价格和中英文装备", async () => {
  const inputs = await fixtureInputs();
  const trader = parsePrimeVaultTrader(JSON.parse(inputs.worldStateText), "2026-09-03T18:00:00Z");
  const lineup = lineupFromInventory(trader, inputs);
  assert.equal(trader.active, true);
  assert.deepEqual(lineup.inventoryRelics.map(relic => relic.name).sort(), [...inventoryNames].sort());
  assert.equal(lineup.items.find(item => item.name === "Euphona Prime").chineseName, "悦音 Prime");
  assert.ok(lineup.inventoryRelics.every(relic => relic.costAya === 1));
  assert.equal(lineup.inventoryEvidence.url, OFFICIAL_SOURCES.worldState);
  const unrelated = { uniqueName: "/Lotus/Weapons/UnrelatedArchgun", name: "Unrelated", productCategory: "SpaceGuns" };
  assert.deepEqual(lineupFromInventory(trader, { ...inputs, equipmentEn: [...inputs.equipmentEn, unrelated, unrelated] }), lineup);
});

test("World State 拒绝重复商人、重复物品和非法时间，区分未来与过期清单", async () => {
  const inputs = await fixtureInputs();
  const payload = JSON.parse(inputs.worldStateText);
  assert.equal(parsePrimeVaultTrader(payload, "2026-09-03T17:59:59Z").active, false);
  assert.equal(parsePrimeVaultTrader(payload, "2026-10-01T18:00:00Z").active, false);
  assert.throws(() => parsePrimeVaultTrader({ PrimeVaultTraders: [] }, "2026-09-03T18:00:00Z"), /exactly one/);
  const duplicate = structuredClone(payload);
  duplicate.PrimeVaultTraders[0].Manifest.push(duplicate.PrimeVaultTraders[0].Manifest[0]);
  assert.throws(() => parsePrimeVaultTrader(duplicate, "2026-09-03T18:00:00Z"), /Duplicate Prime Vault/);
  payload.PrimeVaultTraders[0].Activation.$date.$numberLong = "1e12";
  assert.throws(() => parsePrimeVaultTrader(payload, "2026-09-03T18:00:00Z"), /Invalid World State Activation/);
});

test("售卖遗物缺 Export、重复 ID、缺中文名称及非 1 Aya 价格均拒绝", async () => {
  const inputs = await fixtureInputs();
  const trader = parsePrimeVaultTrader(JSON.parse(inputs.worldStateText), "2026-09-03T18:00:00Z");
  assert.throws(() => lineupFromInventory(trader, { ...inputs, relicExport: inputs.relicExport.slice(1) }), /Missing or unsupported Intact/);
  assert.throws(() => lineupFromInventory(trader, { ...inputs, equipmentEn: [...inputs.equipmentEn, inputs.equipmentEn[0]] }), /Duplicate English equipment/);
  assert.throws(() => lineupFromInventory(trader, { ...inputs, equipmentZh: inputs.equipmentZh.slice(1) }), /Missing or unsupported Prime equipment/);
  trader.manifest.find(entry => entry.ItemType.includes("/Projections/")).RegularPrice = 2;
  assert.throws(() => lineupFromInventory(trader, inputs), /Unsupported Aya price/);
});

test("清单决定遗物数量，七种实际售卖遗物不会被裁成六种", async () => {
  const inputs = await fixtureInputs();
  const lineup = parsePrimeResurgencePages(inputs.englishHtml, inputs.chineseHtml);
  const relics = parseDropTables(inputs.dropTablesHtml);
  relics.push({ ...structuredClone(relics[0]), name: "Axi Z99" });
  assert.equal(selectRelicSet(relics, lineup.items, [...inventoryNames, "Axi Z99"]).relics.length, 7);
  assert.throws(() => selectRelicSet(relics, lineup.items, [...inventoryNames, "Axi X99"]), /missing from official Drop Tables/);
  assert.throws(() => selectRelicSet(relics, lineup.items, [...inventoryNames, inventoryNames[0]]), /Duplicate inventory/);
});

test("官网停留上一期不阻挡真实清单生成候选，但未知阵容冲突必须停止", async () => {
  const inputs = await fixtureInputs();
  const old = await announcementOnlyInputs();
  inputs.englishHtml = old.englishHtml;
  inputs.chineseHtml = old.chineseHtml;
  const rootDir = await temporaryRepository();
  const result = await runPrimeResurgenceSync({ rootDir, inputs, now: "2026-09-03T18:01:00Z" });
  assert.equal(result.candidate.status, "ready-for-review");
  assert.match(result.summary, /previous published rotation/);
  const candidate = (await candidateSnapshot(rootDir)).candidates[0];
  assert.equal(candidate.source.officialData.worldState.startsAt, candidate.effectiveAt);
  const conflicted = await fixtureInputs();
  conflicted.englishHtml = conflicted.englishHtml.replaceAll("Mirage", "X");
  conflicted.chineseHtml = conflicted.chineseHtml.replaceAll("Mirage", "X");
  const other = await temporaryRepository();
  const before = await dataSnapshot(other);
  await assert.rejects(runPrimeResurgenceSync({ rootDir: other, inputs: conflicted, now: "2026-09-03T18:01:00Z" }), /Auxiliary official page conflicts/);
  assert.deepEqual(await dataSnapshot(other), before);
});

test("官网不可用时仍由有效 World State 完成候选验证并保留警告", async () => {
  const inputs = await fixtureInputs();
  const fetchFixture = officialFetchFixture(inputs, []);
  const rootDir = await repositoryWithAnnouncedCandidate();
  const result = await runNearRotationWatcher({ rootDir, now: "2026-09-03T19:00:00Z", minimumRelics: 1, minimumRecipes: 1, decompress: fixtureIndexDecompress,
    fetchImpl: async (url, options) => [OFFICIAL_SOURCES.rotationEn, OFFICIAL_SOURCES.rotationZh].includes(url) ? new Response("unavailable", { status: 503 }) : fetchFixture(url, options)
  });
  assert.equal(result.candidate.status, "ready-for-review");
  assert.match(result.summary, /Auxiliary page unavailable/);
});

test("清单生效时间与公告不一致或奖励来源冲突时四份数据均不写入", async () => {
  for (const variant of ["time", "rewards", "missing-part"]) {
    const inputs = await fixtureInputs();
    if (variant === "time") {
      const world = JSON.parse(inputs.worldStateText);
      world.PrimeVaultTraders[0].Activation.$date.$numberLong = String(Date.parse("2026-09-03T18:30:00Z"));
      inputs.worldStateText = JSON.stringify(world);
    } else if (variant === "rewards") {
      const rewards = inputs.relicExport[0].relicRewards;
      [rewards[0].rarity, rewards[1].rarity] = [rewards[1].rarity, rewards[0].rarity];
    } else inputs.dropTablesHtml = inputs.dropTablesHtml.replace("Akbolto Prime Link", "Forma Blueprint");
    const rootDir = await temporaryRepository();
    const before = await dataSnapshot(rootDir);
    await assert.rejects(runPrimeResurgenceSync({ rootDir, inputs, now: "2026-09-03T19:00:00Z" }), /activation differs|rewards disagree/);
    assert.deepEqual(await dataSnapshot(rootDir), before);
  }
});

test("生成候选的 inventory provenance 必须与轮换清单一致", async () => {
  const rootDir = await temporaryRepository();
  await runPrimeResurgenceSync({ rootDir, inputs: await fixtureInputs(), now: "2026-09-03T19:00:00Z" });
  const [rotation, primes, relics, candidates] = (await dataSnapshot(rootDir)).map(text => JSON.parse(text));
  assert.equal(validateRotationData(rotation, primes, relics), true);
  const proposed = rotation.rotations.find(entry => entry.id === "banshee-mirage-2026-09");
  proposed.source.inventory.relics.pop();
  assert.throws(() => validateRotationData(rotation, primes, relics), /disagree with sale inventory/);
  candidates.candidates[0].source.officialData.worldState.startsAt = "2026-09-03T19:00:00Z";
  assert.throws(() => validateAnnouncementCandidates(candidates), /Inventory activation disagrees/);
});

test("官方 Bluesky 时间戳在摄取边界规范化为 canonical UTC，拒绝非 RFC3339 输入", () => {
  assert.equal(normalizeOfficialTimestamp("2026-08-20T19:00:24Z"), "2026-08-20T19:00:24.000Z");
  assert.equal(normalizeOfficialTimestamp("2026-08-20T19:00:24.166Z"), "2026-08-20T19:00:24.166Z");
  assert.equal(normalizeOfficialTimestamp("2026-08-20T19:00:24.166437Z"), "2026-08-20T19:00:24.166Z");
  assert.equal(normalizeOfficialTimestamp("2026-08-20T19:00:24.166437193Z"), "2026-08-20T19:00:24.166Z");
  assert.equal(normalizeOfficialTimestamp("not-a-timestamp"), null);
  assert.equal(normalizeOfficialTimestamp("99999999-08-20T19:00:24Z"), null);
});

test("真实格式的纳秒 Bluesky createdAt 可以写入 announced candidate，同时保留 raw provenance", async () => {
  const directory = await temporaryRepositoryWithoutPreparedCandidate();
  const result = await runPrimeResurgenceSync({
    rootDir: directory,
    inputs: await announcementOnlyInputs(),
    now: "2026-08-20T18:01:00.000Z"
  });
  const candidate = (await candidateSnapshot(directory)).candidates[0];
  assert.equal(result.candidateStage, "announced");
  assert.equal(candidate.source.publishedAt, "2026-08-20T18:00:25.166Z");
  assert.equal(candidate.source.rawPublishedAt, "2026-08-20T18:00:25.166437193Z");
  assert.equal(validateAnnouncementCandidates(await candidateSnapshot(directory)), true);
});

test("Bluesky self-repost wrapper 不会复制公告或触发 duplicate URL failure", async () => {
  const announcements = parseOfficialAnnouncements(JSON.parse(await fixture("prime-resurgence-announcements-repost.json")));
  assert.equal(announcements.length, 1);
  assert.equal(announcements[0].url, "https://bsky.app/profile/warframe.com/post/3mtjt7pmvpr2o");
});

test("官方页面缺少关键 current 结构时 fail closed", async () => {
  const inputs = await fixtureInputs();
  const malformed = inputs.englishHtml.replace('id="current"', 'id="changed-upstream"');
  assert.throws(
    () => parsePrimeResurgencePages(malformed, inputs.chineseHtml),
    /Expected exactly one Prime Resurgence #current section/
  );
});

test("遗物 mapping 缺失会在 recipe 交叉核对时失败", async () => {
  const inputs = await fixtureInputs();
  const lineup = parsePrimeResurgencePages(inputs.englishHtml, inputs.chineseHtml);
  const malformed = inputs.dropTablesHtml.replace("Akbolto Prime Link", "Forma Blueprint");
  const selection = selectRelicSet(parseDropTables(malformed), lineup.items, inventoryNames);
  const recipes = parseRecipes(inputs.recipesText);
  assert.throws(
    () => resolveRecipeRequirements(recipes, lineup.items, selection.expectedByItem),
    /Unexpected item ingredient for Akbolto Prime|missing a Prime part for Akbolto Prime/
  );
});

test("历史同奖励遗物不会取代实际售卖清单", async () => {
  const inputs = await fixtureInputs();
  const lineup = parsePrimeResurgencePages(inputs.englishHtml, inputs.chineseHtml);
  const relics = parseDropTables(inputs.dropTablesHtml);
  relics.push({ ...structuredClone(relics[0]), name: "Axi Z99" });
  assert.deepEqual(selectRelicSet(relics, lineup.items, inventoryNames).relics.map(relic => relic.name), inventoryNames);
  assert.throws(() => selectRelicSet(relics, lineup.items), /explicit official relic selection/);
});

test("Public Export recipe 同时计算 ×1 与 ×2 Prime 部件", async () => {
  const inputs = await fixtureInputs();
  const lineup = parsePrimeResurgencePages(inputs.englishHtml, inputs.chineseHtml);
  const selection = selectRelicSet(parseDropTables(inputs.dropTablesHtml), lineup.items, inventoryNames);
  const requirements = await fixtureRequirements(inputs, lineup, selection);
  assert.equal(requirements.get("banshee-prime").quantities.get("systems"), 1);
  assert.equal(requirements.get("akbolto-prime").quantities.get("barrel"), 2);
  assert.equal(requirements.get("akbolto-prime").quantities.get("receiver"), 2);
  assert.equal(requirements.get("kogake-prime").quantities.get("boot"), 2);
  assert.equal(requirements.get("kogake-prime").quantities.get("gauntlet"), 2);
  assert.equal(requirements.get("helios-prime").recipeUniqueName, "/Lotus/Types/Recipes/SentinelRecipes/PrimeHeliosSentinelBlueprint");
  assert.equal(requirements.get("helios-prime").provenance.status, "public-export");
  assert.equal(requirements.get("euphona-prime").quantities.get("barrel"), 1);
  assert.equal(requirements.get("euphona-prime").quantities.get("receiver"), 1);
  assert.equal(requirements.get("euphona-prime").recipeUniqueName, "/Lotus/Types/Recipes/Weapons/Prime1HShotgunBlueprint");
  assert.equal(requirements.get("euphona-prime").provenance.status, "public-export");
  assert.equal(requirements.get("euphona-prime").provenance.sourceUrl, inputs.recipeUrl);
});

test("malformed upstream rarity 与 recipe JSON 均 fail closed", async () => {
  const inputs = await fixtureInputs();
  assert.throws(
    () => parseDropTables(inputs.dropTablesHtml.replace("Rare (2.00%)", "Rare (3.00%)")),
    /Unsupported Intact relic probability/
  );
  assert.throws(() => parseRecipes({ ExportRecipes: null }), /recipes payload is malformed/);
});

test("未知缺失 recipe 继续 fail closed，curated exception 只适用于明确 item", async () => {
  const inputs = await fixtureInputs();
  const lineup = parsePrimeResurgencePages(inputs.englishHtml, inputs.chineseHtml);
  const selection = selectRelicSet(parseDropTables(inputs.dropTablesHtml), lineup.items, inventoryNames);
  const recipes = parseRecipes(inputs.recipesText).filter((recipe) => !recipe.uniqueName.includes("KogakePrimeBlueprint"));
  const exceptions = await fixtureRecipeExceptions();
  assert.throws(
    () => resolveRecipeRequirements(recipes, lineup.items, selection.expectedByItem, {
      recipeExceptions: exceptions,
      recipeUrl: inputs.recipeUrl
    }),
    /Kogake Prime; found 0, and no curated exception exists/
  );
});

test("官方 textual rarity 与数值概率分开审计，数值概率保持 canonical", async () => {
  const inputs = await fixtureInputs();
  const parsed = parseDropTables(inputs.dropTablesHtml);
  const warning = parsed.find((relic) => relic.name === "Meso E5").rewards.find((reward) => reward.name === "Helios Prime Carapace");
  assert.equal(warning.sourceRarity, "uncommon");
  assert.equal(warning.probability, 25.33);
  assert.equal(warning.rarity, "common");
  assert.equal(warning.rarityDisagreement, true);

  const impossibleLabel = parseDropTables(inputs.dropTablesHtml.replace("Rare (2.00%)", "Common (2.00%)"))[0].rewards[0];
  assert.equal(impossibleLabel.sourceRarity, "common");
  assert.equal(impossibleLabel.rarity, "rare");
  assert.equal(impossibleLabel.rarityDisagreement, true);
  assert.throws(() => parseDropTables(inputs.dropTablesHtml.replace("Rare (2.00%)", "Legendary (2.00%)")), /Malformed rarity/);
});

test("重复 target reward 在 relic 评分前 fail closed", async () => {
  const inputs = await fixtureInputs();
  const lineup = parsePrimeResurgencePages(inputs.englishHtml, inputs.chineseHtml);
  const duplicate = inputs.dropTablesHtml.replace("Forma Blueprint", "Akbolto Prime Receiver");
  const parsed = parseDropTables(duplicate);
  assert.throws(() => selectRelicSet(parsed, lineup.items, inventoryNames), /Duplicate target reward in Axi A12/);
});

test("公告拒绝重复 Warframe、非法时间、DST 歧义和多段匹配", () => {
  const createdAt = "2026-08-20T12:00:00Z";
  assert.throws(
    () => parseAnnouncementText("Banshee Prime and Banshee Prime return with the next Prime Resurgence rotation on September 3 at 2 p.m. ET.", createdAt),
    /repeats the same Prime Warframe/
  );
  assert.throws(
    () => parseAnnouncementText("Banshee Prime and Mirage Prime return with the next Prime Resurgence rotation on September 3 at 13 p.m. ET.", createdAt),
    /hour is invalid/
  );
  assert.throws(
    () => parseAnnouncementText("Banshee Prime and Mirage Prime return with the next Prime Resurgence rotation on November 1 at 1:30 a.m. ET.", createdAt),
    /ambiguous in America\/New_York/
  );
  assert.throws(
    () => parseAnnouncementText("Banshee Prime and Mirage Prime return with the next Prime Resurgence rotation on September 3 at 2 p.m. ET. Banshee Prime and Mirage Prime return with the next Prime Resurgence rotation on October 3 at 2 p.m. ET.", createdAt),
    /Expected one Prime Resurgence announcement/
  );
});

test("Banshee Prime 与 Mirage Prime 公告 fixture 解析为 announced candidate 所需事实", async () => {
  const inputs = await fixtureInputs();
  const announcement = parseOfficialAnnouncements(JSON.parse(inputs.announcementText))[0];
  assert.deepEqual(announcement.warframes, ["Banshee Prime", "Mirage Prime"]);
  assert.equal(announcement.startsAt, "2026-09-03T18:00:00Z");
  assert.equal(announcement.effectiveDate, "2026-09-03");
  assert.equal(announcement.rawEffectiveText, "September 3 at 2 p.m. ET");
});

test("Ivara/Protea 新公告句式生成 pending candidate，保留生产数据及严格校验", async () => {
  const text = "Prepare to take aim and manipulate time itself.\n\nIvara Prime and Protea Prime enter Prime Resurgence on October 1 at 2 p.m. ET.";
  const createdAt = "2026-09-17T18:00:20.412666127Z";
  const inputs = await announcementOnlyInputs();
  const payload = JSON.parse(inputs.announcementText);
  const entry = payload.feed.find((entry) => !entry.reason && entry.post?.author?.handle === "warframe.com");
  entry.post.record.text = text;
  entry.post.record.createdAt = createdAt;
  entry.post.uri = "at://did:plc:24m2xjetjmjfdbgo752skciu/app.bsky.feed.post/3mvqabe4v5m2w";
  inputs.announcementText = JSON.stringify({ feed: [entry] });
  const [announcement] = parseOfficialAnnouncements(JSON.parse(inputs.announcementText));
  assert.deepEqual(announcement.warframes, ["Ivara Prime", "Protea Prime"]);
  assert.equal(announcement.startsAt, "2026-10-01T18:00:00Z");

  const directory = await temporaryRepositoryWithoutPreparedCandidate();
  const names = ["rotation.json", "primes.json", "relics.json"];
  const before = await Promise.all(names.map((name) => readFile(path.join(directory, "data", name), "utf8")));
  const result = await runPrimeResurgenceSync({ rootDir: directory, inputs, now: "2026-09-19T13:10:19Z" });
  assert.deepEqual(result.changedFiles, ["data/prime-resurgence-candidates.json"]);
  const candidate = (await candidateSnapshot(directory)).candidates[0];
  assert.equal(candidate.id, "ivara-protea-2026-10");
  assert.equal(candidate.effectiveAt, "2026-10-01T18:00:00Z");
  assert.equal(candidate.status, "announced");
  assert.equal(candidate.relicDataStatus, "pending");
  assert.equal(candidate.verified, false);
  assert.deepEqual(await Promise.all(names.map((name) => readFile(path.join(directory, "data", name), "utf8"))), before);

  assert.throws(() => parseAnnouncementText(`${text} ${text}`, createdAt), /Expected one Prime Resurgence announcement/);
  assert.throws(() => parseAnnouncementText(text.replace("2 p.m.", "13 p.m."), createdAt), /hour is invalid/);
  assert.equal(parseAnnouncementText(text.replace("Ivara Prime and Protea Prime enter", "Ivara Prime enters"), createdAt), null);
  entry.post.author.did = "did:plc:untrusted";
  assert.throws(() => parseOfficialAnnouncements({ feed: [entry] }), /author DID changed/);
});

test("官方 arrive 句式保留两名 Prime、轮换语境和精确日期", () => {
  const text = "Protea Prime and Ivara Prime arrive with the next Prime Resurgence rotation on October 1 at 2 p.m. ET.";
  const parsed = parseAnnouncementText(text, "2026-09-24T18:00:19.05131294Z");
  assert.deepEqual(parsed?.warframes, ["Protea Prime", "Ivara Prime"]);
  assert.equal(parsed?.startsAt, "2026-10-01T18:00:00Z");
  assert.equal(parseAnnouncementText("Protea Prime and Ivara Prime arrive on October 1 at 2 p.m. ET.", "2026-09-24T18:00:19Z"), null);
});

test("公告 grammar 拒绝 Prime Access、缺日期、单个 Prime 和无轮换语境", () => {
  const createdAt = "2026-09-24T18:00:19Z";
  for (const text of [
    "Protea Prime and Ivara Prime arrive with the next Prime Access rotation on October 1 at 2 p.m. ET.",
    "Protea Prime and Ivara Prime arrive with the next Prime Resurgence rotation.",
    "Protea Prime arrives with the next Prime Resurgence rotation on October 1 at 2 p.m. ET.",
    "Protea Prime and Ivara Prime arrive on October 1 at 2 p.m. ET."
  ]) assert.equal(parseAnnouncementText(text, createdAt), null);
  assert.throws(() => parseAnnouncementText("Protea Prime and Protea Prime arrive with the next Prime Resurgence rotation on October 1 at 2 p.m. ET.", createdAt), /repeats the same Prime Warframe/);
});

test("多个官方公告按生效日期确定顺序，无关宣传文案被忽略", async () => {
  const payload = JSON.parse(await fixture("prime-resurgence-announcements.json"));
  const oldEntry = payload.feed.find((entry) => !entry.reason);
  const nextEntry = structuredClone(oldEntry);
  nextEntry.post.record.text = "Ivara Prime and Protea Prime enter Prime Resurgence on October 1 at 2 p.m. ET.";
  nextEntry.post.record.createdAt = "2026-09-17T18:00:20.412666127Z";
  nextEntry.post.uri = "at://did:plc:24m2xjetjmjfdbgo752skciu/app.bsky.feed.post/3mvqabe4v5m2w";
  const unrelated = structuredClone(oldEntry);
  unrelated.post.record.text = "Get ready for Prime Resurgence this weekend.";
  unrelated.post.uri = "at://did:plc:24m2xjetjmjfdbgo752skciu/app.bsky.feed.post/3mabcdef1234";
  const announcements = parseOfficialAnnouncements({ feed: [nextEntry, unrelated, oldEntry] });
  assert.deepEqual(announcements.map((announcement) => announcement.warframes), [
    ["Banshee Prime", "Mirage Prime"],
    ["Ivara Prime", "Protea Prime"]
  ]);
  assert.deepEqual(announcements.map((announcement) => announcement.startsAt), [
    "2026-09-03T18:00:00Z", "2026-10-01T18:00:00Z"
  ]);
});

test("官方 featured 归属只选六件装备，Braton/Burston 附带奖励仍逐项校验", async () => {
  const evidence = JSON.parse(await fixture("prime-resurgence-braton-official.json"));
  const official = {
    relicExport: evidence.relicExport, recipesText: evidence.recipesText,
    equipmentEn: evidence.equipmentEn, equipmentZh: evidence.equipmentZh,
    exportUrls: evidence.lineup.previewEvidence.exportUrls
  };
  const candidate = { primeWarframes: ["Ivara Prime", "Protea Prime"], effectiveAt: "2026-10-01T18:00:00Z" };
  const lineup = lineupFromVaultExport(candidate, official, evidence.dropRelics);
  assert.deepEqual(lineup.items.map(item => item.name), [
    "Aksomati Prime", "Baza Prime", "Ivara Prime", "Okina Prime", "Protea Prime", "Velox Prime"
  ]);
  assert.deepEqual(lineup.previewEvidence.incidentalItemNames, ["Braton Prime", "Burston Prime"]);
  assert.deepEqual(lineup.rewardItems.map(item => item.name), evidence.lineup.items.map(item => item.name));
  validateVaultRewardCatalog(lineup, evidence.dropRelics, official);
  const selection = selectRelicSet(evidence.dropRelics, lineup.items, lineup.inventoryRelics.map(relic => relic.name));
  assert.equal(resolveRecipeRequirements(parseRecipes(official.recipesText), lineup.items, selection.expectedByItem).size, 6);

  const complete = structuredClone(evidence);
  const relic = complete.dropRelics.find((entry) => entry.name === "Neo O4");
  relic.rewards.find((reward) => reward.name === "Forma Blueprint").name = "Braton Prime Stock";
  const exported = complete.relicExport.find((entry) => entry.name === "Neo O4 Relic");
  exported.relicRewards.find((reward) => reward.rewardName.endsWith("FormaBlueprint")).rewardName = "/Lotus/Types/Recipes/Weapons/WeaponParts/BratonPrimeStock";
  const completeOfficial = { ...official, relicExport: complete.relicExport };
  const completeLineup = lineupFromVaultExport(candidate, completeOfficial, complete.dropRelics);
  validateVaultRewardCatalog(completeLineup, complete.dropRelics, completeOfficial);
  assert.deepEqual(completeLineup.previewEvidence.incidentalItemNames, ["Braton Prime", "Burston Prime"]);

  const invalid = structuredClone(evidence);
  const invalidRecipes = JSON.parse(invalid.recipesText);
  invalidRecipes.ExportRecipes.find((entry) => entry.uniqueName.endsWith("BratonPrimeBlueprint")).ingredients.find((ingredient) => ingredient.ItemType.endsWith("BratonPrimeStock")).ItemType = "/Lotus/Types/Recipes/Weapons/WeaponParts/BratonPrimeAntenna";
  assert.throws(() => validateVaultRewardCatalog(lineup, invalid.dropRelics, { ...official, recipesText: JSON.stringify(invalidRecipes) }), /absent from official Drop Tables/);

  const inconsistent = structuredClone(evidence);
  inconsistent.relicExport.find((entry) => entry.name === "Neo P11 Relic").relicRewards.find((reward) => reward.rewardName.endsWith("BratonPrimeReceiver")).rarity = "RARE";
  assert.throws(() => validateVaultRewardCatalog(lineup, inconsistent.dropRelics, { ...official, relicExport: inconsistent.relicExport }), /Public Export rewards disagree with official Drop Tables/);
});

test("ET 时间使用 America/New_York 正确处理 EDT 和 EST", () => {
  const edt = parseAnnouncementText(
    "Banshee Prime and Mirage Prime return with the next Prime Resurgence rotation on September 3 at 2 p.m. ET.",
    "2026-08-20T18:00:25.031Z"
  );
  const est = parseAnnouncementText(
    "Banshee Prime and Mirage Prime return with the next Prime Resurgence rotation on December 3 at 2 p.m. ET.",
    "2026-11-20T18:00:25.031Z"
  );
  assert.equal(edt.startsAt, "2026-09-03T18:00:00Z");
  assert.equal(est.startsAt, "2026-12-03T19:00:00Z");
});

test("公告只给日期时保留 pending effectiveAt，单个 Prime 不会形成完整 candidate", () => {
  const dated = parseAnnouncementText(
    "Banshee Prime and Mirage Prime return with the next Prime Resurgence rotation on September 3.",
    "2026-08-20T18:00:25.031Z"
  );
  assert.equal(dated.startsAt, null);
  assert.equal(dated.effectiveDate, "2026-09-03");
  assert.equal(dated.rawEffectiveText, "September 3");
  assert.equal(
    parseAnnouncementText("Banshee Prime returns with the next Prime Resurgence rotation on September 3 at 2 p.m. ET.", "2026-08-20T18:00:25.031Z"),
    null
  );
});

test("日期-only 公告只写 announced candidate，单个 Prime 公告不会写 candidate", async () => {
  const directory = await temporaryRepositoryWithoutPreparedCandidate();
  const dateOnly = await announcementOnlyInputs();
  dateOnly.announcementText = dateOnly.announcementText.replace(" at 2 p.m. ET", "");
  await runPrimeResurgenceSync({ rootDir: directory, inputs: dateOnly, now: "2026-08-20T18:01:00.000Z" });
  const candidate = (await candidateSnapshot(directory)).candidates[0];
  assert.equal(candidate.status, "announced");
  assert.equal(candidate.effectiveAt, null);
  assert.equal(candidate.effectiveDate, "2026-09-03");

  const noCandidateDirectory = await temporaryRepositoryWithoutPreparedCandidate();
  const singlePrime = await announcementOnlyInputs();
  singlePrime.announcementText = singlePrime.announcementText.replace("Banshee Prime and Mirage Prime return", "Banshee Prime returns");
  const before = await candidateSnapshot(noCandidateDirectory);
  await assert.rejects(
    runPrimeResurgenceSync({ rootDir: noCandidateDirectory, inputs: singlePrime, now: "2026-08-20T18:01:00.000Z" }),
    /No deterministic Prime Resurgence announcement was found/
  );
  assert.deepEqual(await candidateSnapshot(noCandidateDirectory), before);
});

test("同一 Prime pair 的 date-only 公告会被同日精确时间原地精化且保持幂等", async () => {
  const directory = await temporaryRepositoryWithoutPreparedCandidate();
  const dateOnly = await announcementOnlyInputs();
  dateOnly.announcementText = dateOnly.announcementText.replace(" at 2 p.m. ET", "");
  await runPrimeResurgenceSync({ rootDir: directory, inputs: dateOnly, now: "2026-08-20T18:01:00.000Z" });
  const initial = (await candidateSnapshot(directory)).candidates[0];
  assert.equal(initial.effectiveAt, null);
  assert.equal(initial.id, "banshee-mirage-2026-09");

  const timed = await announcementOnlyInputs();
  const refined = await runPrimeResurgenceSync({ rootDir: directory, inputs: timed, now: "2026-08-21T18:01:00.000Z" });
  const afterRefinement = await candidateSnapshot(directory);
  assert.equal(afterRefinement.candidates.length, 1);
  assert.equal(afterRefinement.candidates[0].id, initial.id);
  assert.equal(afterRefinement.candidates[0].effectiveAt, "2026-09-03T18:00:00Z");
  assert.deepEqual(afterRefinement.candidates[0].statusHistory, initial.statusHistory);
  assert.equal(afterRefinement.candidates[0].source.url, initial.source.url);
  assert.equal(afterRefinement.candidates[0].source.relatedAnnouncements.length, 1);
  assert.deepEqual(refined.changedFiles, ["data/prime-resurgence-candidates.json"]);

  const repeated = await runPrimeResurgenceSync({ rootDir: directory, inputs: timed, now: "2026-08-22T18:01:00.000Z" });
  assert.deepEqual(repeated.changedFiles, []);
  assert.deepEqual(await candidateSnapshot(directory), afterRefinement);

  const dateOnlyLater = await announcementOnlyInputs();
  dateOnlyLater.announcementText = dateOnlyLater.announcementText.replace(" at 2 p.m. ET", "");
  await runPrimeResurgenceSync({ rootDir: directory, inputs: dateOnlyLater, now: "2026-08-23T18:01:00.000Z" });
  const afterLessPreciseEvidence = await candidateSnapshot(directory);
  assert.equal(afterLessPreciseEvidence.candidates.length, 1);
  assert.equal(afterLessPreciseEvidence.candidates[0].id, initial.id);
  assert.equal(afterLessPreciseEvidence.candidates[0].effectiveAt, "2026-09-03T18:00:00Z");
});

test("不同官方日期或 Prime pair 不会被静默合并为同一 candidate", async () => {
  const directory = await repositoryWithAnnouncedCandidate();
  const differentDate = await announcementOnlyInputs();
  differentDate.announcementText = differentDate.announcementText.replace("September 3", "October 3");
  await runPrimeResurgenceSync({ rootDir: directory, inputs: differentDate, now: "2026-08-21T18:01:00.000Z" });
  const afterDate = await candidateSnapshot(directory);
  assert.equal(afterDate.candidates.length, 2);
  assert.deepEqual(afterDate.candidates.map((candidate) => candidate.id), ["banshee-mirage-2026-09", "banshee-mirage-2026-10"]);

  const differentPair = await announcementOnlyInputs();
  differentPair.announcementText = differentPair.announcementText.replace("Banshee Prime and Mirage Prime", "Ember Prime and Frost Prime");
  await runPrimeResurgenceSync({ rootDir: directory, inputs: differentPair, now: "2026-08-22T18:01:00.000Z" });
  const afterPair = await candidateSnapshot(directory);
  assert.equal(afterPair.candidates.length, 3);
  assert.ok(afterPair.candidates.some((candidate) => candidate.id === "ember-frost-2026-09"));
  assert.equal(validateAnnouncementCandidates(afterPair), true);
});

test("非 Digital Extremes 官方身份不能进入 trusted announcement pipeline", async () => {
  const payload = JSON.parse(await fixture("prime-resurgence-announcements.json"));
  payload.feed[0].post.author.did = "did:plc:untrusted";
  assert.throws(() => parseOfficialAnnouncements(payload), /DID changed; human review is required/);
});

test("announcement-only candidate 幂等、保留 provenance，且不修改正式 rotation", async () => {
  const directory = await temporaryRepositoryWithoutPreparedCandidate();
  const inputs = await announcementOnlyInputs();
  const beforeProduction = (await dataSnapshot(directory)).slice(0, 3);
  const now = "2026-08-20T18:01:00.000Z";
  const first = await runPrimeResurgenceSync({ rootDir: directory, inputs, now });
  const firstCandidateData = await candidateSnapshot(directory);
  const candidate = firstCandidateData.candidates[0];
  assert.equal(first.candidateStage, "announced");
  assert.deepEqual(first.changedFiles, ["data/prime-resurgence-candidates.json"]);
  assert.equal(candidate.id, "banshee-mirage-2026-09");
  assert.equal(candidate.status, "announced");
  assert.deepEqual(candidate.primeWarframes, ["Banshee Prime", "Mirage Prime"]);
  assert.equal(candidate.effectiveAt, "2026-09-03T18:00:00Z");
  assert.equal(candidate.relicDataStatus, "pending");
  assert.equal(candidate.verified, false);
  assert.equal(candidate.source.discoveredAt, now);
  assert.deepEqual(candidate.statusHistory, [{ status: "announced", at: now }]);
  assert.match(first.summary, /Officially announced Prime Warframes: Banshee Prime & Mirage Prime/);
  assert.match(first.summary, /Relic data: pending pair-specific Vault export or official rotation inventory/);
  assert.deepEqual((await dataSnapshot(directory)).slice(0, 3), beforeProduction);
  assert.equal(validateAnnouncementCandidates(firstCandidateData, JSON.parse(beforeProduction[0])), true);

  const second = await runPrimeResurgenceSync({ rootDir: directory, inputs, now: "2026-08-21T18:01:00.000Z" });
  assert.deepEqual(second.changedFiles, []);
  assert.deepEqual(await candidateSnapshot(directory), firstCandidateData);
});

test("公告阶段在官网切换前读取并校验原始目录，保持候选未验证", async () => {
  const directory = await temporaryRepositoryWithoutPreparedCandidate();
  const inputs = await announcementOnlyInputs();
  const requested = [];
  const result = await runPrimeResurgenceSync({ rootDir: directory, fetchImpl: officialFetchFixture(inputs, requested), decompress: fixtureIndexDecompress, now: "2026-08-20T18:01:00.000Z" });
  assert.equal(result.candidateStage, "announced");
  assert.equal(result.catalogPreparation.itemCount, 2);
  assert.equal(result.catalogPreparation.totalRequiredParts, 8);
  assert.ok(requested.includes(OFFICIAL_SOURCES.dropTables));
  assert.ok(requested.includes(inputs.recipeUrl));
  assert.equal((await candidateSnapshot(directory)).candidates[0].verified, false);
});

test("announced candidate 在正式页面与 official data 到位后升级同一 identity 并 ready-for-review", async () => {
  const directory = await temporaryRepositoryWithoutPreparedCandidate();
  const now = "2026-08-20T18:01:00.000Z";
  await runPrimeResurgenceSync({ rootDir: directory, inputs: await announcementOnlyInputs(), now });
  const beforeUpgrade = await candidateSnapshot(directory);
  const firstId = beforeUpgrade.candidates[0].id;

  const upgraded = await runPrimeResurgenceSync({ rootDir: directory, inputs: await fixtureInputs(), now: "2026-09-03T18:01:00.000Z" });
  const candidateData = await candidateSnapshot(directory);
  const candidate = candidateData.candidates[0];
  assert.equal(upgraded.candidateId, firstId);
  assert.equal(candidate.id, firstId);
  assert.equal(candidate.status, "ready-for-review");
  assert.equal(candidate.relicDataStatus, "validated");
  assert.equal(candidate.verified, true);
  assert.equal(candidate.rotationId, firstId);
  assert.equal(candidate.source.discoveredAt, now);
  assert.deepEqual(candidate.statusHistory.map((entry) => entry.status), ["announced", "official-data-available", "validated", "ready-for-review"]);
  assert.equal(candidate.source.officialData.worldState.url, OFFICIAL_SOURCES.worldState);
  assert.equal(validateAnnouncementCandidates(candidateData, JSON.parse(await readFile(path.join(directory, "data/rotation.json"), "utf8"))), true);
});

test("公告与实际售卖阵容不一致时记录 conflict、保留双方来源且不升级正式 rotation", async () => {
  const directory = await temporaryRepositoryWithoutPreparedCandidate();
  const now = "2026-08-20T18:01:00.000Z";
  await runPrimeResurgenceSync({ rootDir: directory, inputs: await announcementOnlyInputs(), now });
  const beforeProduction = (await dataSnapshot(directory)).slice(0, 3);
  const originalInputs = await fixtureInputs();
  const conflictInputs = JSON.parse(JSON.stringify(originalInputs).replaceAll("Mirage", "X"));
  conflictInputs.announcementText = originalInputs.announcementText;
  const conflict = await runPrimeResurgenceSync({ rootDir: directory, inputs: conflictInputs, now: "2026-09-03T18:01:00.000Z" });
  const candidate = (await candidateSnapshot(directory)).candidates[0];
  assert.equal(conflict.candidateStage, "conflict");
  assert.deepEqual(conflict.changedFiles, ["data/prime-resurgence-candidates.json"]);
  assert.equal(candidate.status, "conflict");
  assert.equal(candidate.relicDataStatus, "conflict");
  assert.equal(candidate.verified, false);
  assert.equal(candidate.source.url, "https://bsky.app/profile/warframe.com/post/3mtjt7pmvpr2o");
  assert.deepEqual(candidate.source.conflict.worldState.rawPrimeWarframes, ["Banshee Prime", "X Prime"]);
  assert.match(candidate.reviewReason, /Automatic upgrade stopped/);
  assert.deepEqual((await dataSnapshot(directory)).slice(0, 3), beforeProduction);
});

test("near-rotation watcher 的 UTC 窗口包含精确边界且不受 DST 偏移影响", () => {
  const candidateData = {
    schemaVersion: 1,
    candidates: [{ id: "banshee-mirage-2026-09", status: "announced", effectiveAt: "2026-09-03T18:00:00Z" }]
  };
  const window = nearRotationWatchWindow("2026-09-03T18:00:00Z");
  assert.deepEqual(window, {
    effectiveAt: "2026-09-03T18:00:00Z",
    startsAt: "2026-09-03T16:00:00.000Z",
    endsAt: "2026-09-04T06:00:00.000Z"
  });
  assert.equal(selectNearRotationCandidate(candidateData, "2026-09-03T15:59:59.999Z").eligible, false);
  assert.equal(selectNearRotationCandidate(candidateData, "2026-09-03T16:00:00.000Z").eligible, true);
  assert.equal(selectNearRotationCandidate(candidateData, "2026-09-03T18:00:00.000Z").eligible, true);
  assert.equal(selectNearRotationCandidate(candidateData, "2026-09-04T06:00:00.000Z").eligible, true);
  assert.equal(selectNearRotationCandidate(candidateData, "2026-09-04T06:00:00.001Z").eligible, false);
  assert.equal(nearRotationWatchWindow("2026-12-03T19:00:00Z").startsAt, "2026-12-03T17:00:00.000Z");

  const multiple = {
    schemaVersion: 1,
    candidates: [
      { id: "future-candidate", status: "announced", effectiveAt: "2026-09-20T18:00:00Z" },
      { id: "active-candidate", status: "announced", effectiveAt: "2026-09-03T18:00:00Z" }
    ]
  };
  assert.equal(selectNearRotationCandidate(multiple, "2026-09-03T18:00:00.000Z").candidate.id, "active-candidate");
});

test("near-rotation watcher 在窗口外、缺失 effectiveAt 与终态时均零网络请求", async () => {
  const outsideDirectory = await repositoryWithAnnouncedCandidate();
  const outsideRequests = [];
  const outside = await runNearRotationWatcher({
    rootDir: outsideDirectory,
    now: "2026-09-03T15:59:59.000Z",
    fetchImpl: async (url) => { outsideRequests.push(url); throw new Error("network must not run"); }
  });
  assert.equal(outside.status, "NO_OP");
  assert.equal(outside.watcher.reason, "outside-watch-window");
  assert.equal(outside.watcher.externalRequests, 0);
  assert.deepEqual(outsideRequests, []);

  const pendingDirectory = await repositoryWithAnnouncedCandidate();
  const pendingData = await candidateSnapshot(pendingDirectory);
  pendingData.candidates[0].effectiveAt = null;
  pendingData.candidates[0].effectiveDate = "2026-09-03";
  await writeFile(path.join(pendingDirectory, "data/prime-resurgence-candidates.json"), `${JSON.stringify(pendingData, null, 2)}\n`, "utf8");
  const pendingRequests = [];
  const pending = await runNearRotationWatcher({
    rootDir: pendingDirectory,
    now: "2026-09-03T18:00:00.000Z",
    fetchImpl: async (url) => { pendingRequests.push(url); throw new Error("network must not run"); }
  });
  assert.equal(pending.watcher.reason, "missing-effective-at");
  assert.equal(pending.watcher.externalRequests, 0);
  assert.deepEqual(pendingRequests, []);

  const terminalDirectory = await repositoryWithAnnouncedCandidate();
  const terminalData = await candidateSnapshot(terminalDirectory);
  const terminal = terminalData.candidates[0];
  terminal.status = "conflict";
  terminal.relicDataStatus = "conflict";
  terminal.statusHistory.push({ status: "conflict", at: "2026-09-03T18:00:00.000Z" });
  terminal.source.conflict = {
    officialRotationPage: {
      type: "digital-extremes-official-rotation-page",
      url: OFFICIAL_SOURCES.rotationEn,
      discoveredAt: "2026-09-03T18:00:00.000Z",
      rawPrimeWarframes: ["Banshee Prime", "X Prime"]
    }
  };
  await writeFile(path.join(terminalDirectory, "data/prime-resurgence-candidates.json"), `${JSON.stringify(terminalData, null, 2)}\n`, "utf8");
  const terminalRequests = [];
  const terminalResult = await runNearRotationWatcher({
    rootDir: terminalDirectory,
    now: "2026-09-03T18:00:00.000Z",
    fetchImpl: async (url) => { terminalRequests.push(url); throw new Error("network must not run"); }
  });
  assert.equal(terminalResult.watcher.reason, "no-announced-candidate");
  assert.equal(terminalResult.watcher.externalRequests, 0);
  assert.deepEqual(terminalRequests, []);
});

test("near-rotation watcher 旧售卖清单只请求 World State，不读取完整目录", async () => {
  const directory = await repositoryWithAnnouncedCandidate();
  const inputs = await announcementOnlyInputs();
  const requests = [];
  const fetchImpl = officialFetchFixture(inputs, requests);
  const before = await dataSnapshot(directory);
  const result = await runNearRotationWatcher({
    rootDir: directory,
    now: "2026-09-03T18:00:00.000Z",
    fetchImpl,
    decompress: fixtureIndexDecompress
  });
  assert.equal(result.status, "NO_OP");
  assert.equal(result.watcher.eligible, true);
  assert.equal(result.watcher.officialRotationChanged, false);
  assert.equal(result.watcher.externalRequests, 1);
  assert.deepEqual(requests, [OFFICIAL_SOURCES.worldState]);
  assert.deepEqual(await dataSnapshot(directory), before);
});

test("near-rotation watcher 匹配实际清单后复用 announced record 完整验证并进入 ready-for-review", async () => {
  const directory = await repositoryWithAnnouncedCandidate();
  const beforeCandidate = (await candidateSnapshot(directory)).candidates[0];
  const inputs = await fixtureInputs();
  const requests = [];
  const result = await runNearRotationWatcher({
    rootDir: directory,
    now: "2026-09-03T19:00:00.000Z",
    fetchImpl: officialFetchFixture(inputs, requests),
    decompress: fixtureIndexDecompress,
    minimumRelics: 1,
    minimumRecipes: 1
  });
  const afterCandidate = (await candidateSnapshot(directory)).candidates[0];
  assert.equal(result.candidateId, beforeCandidate.id);
  assert.equal(afterCandidate.id, beforeCandidate.id);
  assert.deepEqual(afterCandidate.source.type, beforeCandidate.source.type);
  assert.equal(afterCandidate.source.url, beforeCandidate.source.url);
  assert.deepEqual(afterCandidate.statusHistory.map((entry) => entry.status), ["announced", "official-data-available", "validated", "ready-for-review"]);
  assert.equal(afterCandidate.status, "ready-for-review");
  assert.equal(result.watcher.externalRequests, 14);
  assert.deepEqual(new Set(requests), new Set([
    OFFICIAL_SOURCES.rotationEn,
    OFFICIAL_SOURCES.rotationZh,
    OFFICIAL_SOURCES.dropTables,
    OFFICIAL_SOURCES.publicExportIndex,
    OFFICIAL_SOURCES.worldState,
    "https://content.warframe.com/PublicExport/index_zh.txt.lzma",
    ...Object.values(inputs.exportUrls)
  ]));

  const terminalRequests = [];
  const terminal = await runNearRotationWatcher({
    rootDir: directory,
    now: "2026-09-03T20:00:00.000Z",
    fetchImpl: async (url) => { terminalRequests.push(url); throw new Error("ready candidate must not watch"); }
  });
  assert.equal(terminal.watcher.externalRequests, 0);
  assert.deepEqual(terminalRequests, []);
});

test("near-rotation watcher 冲突后保留 evidence，后续 watcher 与 announcement mode 都不会覆盖或请求正式数据", async () => {
  const directory = await repositoryWithAnnouncedCandidate();
  const inputs = JSON.parse(JSON.stringify(await fixtureInputs()).replaceAll("Mirage", "X"));
  const conflictRequests = [];
  const conflict = await runNearRotationWatcher({
    rootDir: directory,
    now: "2026-09-03T19:00:00.000Z",
    fetchImpl: officialFetchFixture(inputs, conflictRequests),
    decompress: fixtureIndexDecompress
  });
  assert.equal(conflict.status, "CONFLICT");
  assert.ok(conflictRequests.includes(OFFICIAL_SOURCES.worldState));
  const evidence = await candidateSnapshot(directory);

  const rerunRequests = [];
  const rerun = await runNearRotationWatcher({
    rootDir: directory,
    now: "2026-09-03T20:00:00.000Z",
    fetchImpl: async (url) => { rerunRequests.push(url); throw new Error("conflict must not watch"); }
  });
  assert.equal(rerun.watcher.externalRequests, 0);
  assert.deepEqual(rerunRequests, []);
  assert.deepEqual(await candidateSnapshot(directory), evidence);

  const daily = await runPrimeResurgenceSync({
    rootDir: directory,
    inputs: await announcementOnlyInputs(),
    now: "2026-09-04T18:00:00.000Z"
  });
  assert.equal(daily.candidateStage, "terminal");
  assert.deepEqual(await candidateSnapshot(directory), evidence);
});

test("多个同时 eligible 的 announced candidates fail closed，不按数组顺序选择", async () => {
  const directory = await repositoryWithAnnouncedCandidate();
  const candidateData = await candidateSnapshot(directory);
  const duplicate = structuredClone(candidateData.candidates[0]);
  duplicate.id = "ember-frost-2026-09";
  duplicate.primeWarframes = ["Ember Prime", "Frost Prime"];
  duplicate.source.url = "https://bsky.app/profile/warframe.com/post/3anotherfixture";
  duplicate.source.rawPrimeWarframes = ["Ember Prime", "Frost Prime"];
  candidateData.candidates.push(duplicate);
  await writeFile(path.join(directory, "data/prime-resurgence-candidates.json"), `${JSON.stringify(candidateData, null, 2)}\n`, "utf8");
  const requests = [];
  const result = await runNearRotationWatcher({
    rootDir: directory,
    now: "2026-09-03T18:00:00.000Z",
    fetchImpl: async (url) => { requests.push(url); throw new Error("ambiguous candidates must not fetch"); }
  });
  assert.equal(result.watcher.reason, "overlapping-eligible-candidates");
  assert.equal(result.watcher.externalRequests, 0);
  assert.deepEqual(requests, []);
});

test("页面卡片顺序不影响 canonical candidate ID", () => {
  const startsAt = "2026-09-03T18:00:00Z";
  const first = { warframes: [{ name: "Banshee Prime" }, { name: "Mirage Prime" }] };
  const reversed = { warframes: [...first.warframes].reverse() };
  assert.equal(candidateIdFor(first, startsAt), "banshee-mirage-2026-09");
  assert.equal(candidateIdFor(reversed, startsAt), "banshee-mirage-2026-09");
});

test("candidate schema 强制 canonical ID，Prime 顺序不影响有效 identity", async () => {
  const directory = await repositoryWithAnnouncedCandidate();
  const canonical = await candidateSnapshot(directory);
  assert.equal(validateAnnouncementCandidates(canonical), true);

  const wrongId = structuredClone(canonical);
  wrongId.candidates[0].id = "zzz-wrong-1999-01";
  assert.throws(() => validateAnnouncementCandidates(wrongId), /Non-canonical announcement candidate id/);

  const reversed = structuredClone(canonical);
  reversed.candidates[0].primeWarframes.reverse();
  assert.equal(validateAnnouncementCandidates(reversed), true);
});

test("candidate statusHistory 必须从 discoveredAt 开始且时间不倒退；相等时间允许批量状态转换", async () => {
  const directory = await repositoryWithAnnouncedCandidate();
  await runPrimeResurgenceSync({ rootDir: directory, inputs: await fixtureInputs(), now: "2026-09-03T18:01:00.000Z" });
  const rotationData = JSON.parse(await readFile(path.join(directory, "data/rotation.json"), "utf8"));
  const ready = await candidateSnapshot(directory);
  assert.equal(validateAnnouncementCandidates(ready, rotationData), true);
  assert.equal(ready.candidates[0].statusHistory[1].at, ready.candidates[0].statusHistory[2].at);

  const backward = structuredClone(ready);
  backward.candidates[0].statusHistory[1].at = "2026-08-20T18:00:59.000Z";
  assert.throws(() => validateAnnouncementCandidates(backward, rotationData), /not chronological/);

  const invalid = structuredClone(ready);
  invalid.candidates[0].statusHistory[0].at = "invalid-timestamp";
  assert.throws(() => validateAnnouncementCandidates(invalid, rotationData), /Invalid announcement candidate status history/);

  const inconsistent = structuredClone(ready);
  inconsistent.candidates[0].statusHistory[0].at = "2030-01-01T00:00:00.000Z";
  assert.throws(() => validateAnnouncementCandidates(inconsistent, rotationData), /history must begin at discovery/);
});

test("中文商品名称必须唯一", async () => {
  const inputs = await fixtureInputs();
  const duplicateChinese = inputs.chineseHtml.replace(">悦音 Prime<p", ">螺钉双枪 Prime<p");
  assert.throws(() => parsePrimeResurgencePages(inputs.englishHtml, duplicateChinese), /Duplicate official Chinese Prime item name/);
});

test("未知 Prime ingredient 被拒绝，普通资源仍可忽略", async () => {
  const inputs = await fixtureInputs();
  const lineup = parsePrimeResurgencePages(inputs.englishHtml, inputs.chineseHtml);
  const selection = selectRelicSet(parseDropTables(inputs.dropTablesHtml), lineup.items, inventoryNames);
  const recipes = parseRecipes(inputs.recipesText);
  const exceptions = await fixtureRecipeExceptions();
  const banshee = recipes.find((recipe) => recipe.uniqueName.endsWith("BansheePrimeBlueprint"));
  banshee.ingredients.push({
    ItemType: "/Lotus/Types/Recipes/WarframeRecipes/MiragePrimeSystemsComponent",
    ItemCount: 999
  });
  assert.throws(
    () => resolveRecipeRequirements(recipes, lineup.items, selection.expectedByItem, {
      recipeExceptions: exceptions,
      recipeUrl: inputs.recipeUrl
    }),
    /Unrecognized Prime recipe ingredient for Banshee Prime/
  );
  const valid = await fixtureRequirements(inputs, lineup, selection);
  assert.equal(valid.get("helios-prime").quantities.get("systems"), 1);
});

test("未知中文部件名不会 fallback 为英文", async () => {
  const inputs = await fixtureInputs();
  const directory = await temporaryRepositoryWithoutPreparedCandidate();
  const recipes = parseRecipes(inputs.recipesText);
  const euphona = recipes.find((recipe) => recipe.uniqueName.endsWith("Prime1HShotgunBlueprint"));
  euphona.ingredients[0].ItemType = "/Lotus/Types/Recipes/Weapons/WeaponParts/Prime1HShotgunGrip";
  await assert.rejects(
    runPrimeResurgenceSync({
      rootDir: directory,
      dryRun: true,
      inputs: {
        ...inputs,
        dropTablesHtml: inputs.dropTablesHtml.replace("Euphona Prime Barrel", "Euphona Prime Grip"),
        relicExport: JSON.parse(JSON.stringify(inputs.relicExport).replaceAll("Prime1HShotgunBarrel", "Prime1HShotgunGrip")),
        recipesText: JSON.stringify({ ExportRecipes: recipes })
      }
    }),
    /No curated Chinese part name exists for euphona-prime\/grip/
  );
});

test("recipe quantity 必须是 Uint16 可表示的 safe integer", async () => {
  const inputs = await fixtureInputs();
  const lineup = parsePrimeResurgencePages(inputs.englishHtml, inputs.chineseHtml);
  const selection = selectRelicSet(parseDropTables(inputs.dropTablesHtml), lineup.items, inventoryNames);
  const exceptions = await fixtureRecipeExceptions();
  const resolveWith = (quantity) => {
    const recipes = parseRecipes(inputs.recipesText);
    const ingredient = recipes.find((recipe) => recipe.uniqueName.endsWith("AkboltoPrimeBlueprint")).ingredients[0];
    ingredient.ItemCount = quantity;
    return resolveRecipeRequirements(recipes, lineup.items, selection.expectedByItem, { recipeExceptions: exceptions, recipeUrl: inputs.recipeUrl });
  };
  assert.equal(resolveWith(65_535).get("akbolto-prime").quantities.get("barrel"), 65_535);
  assert.throws(() => resolveWith(65_536), /Unsafe recipe quantity/);
  assert.throws(() => resolveWith(Number.MAX_SAFE_INTEGER + 1), /Unsafe recipe quantity/);
  assert.throws(() => resolveWith(1.5), /Unsafe recipe quantity/);
});

test("rotation item/relic 必须由引用它的 rotation 自身拥有", async () => {
  const rotationData = JSON.parse(await readFile(path.join(repositoryRoot, "data/rotation.json"), "utf8"));
  const primeData = JSON.parse(await readFile(path.join(repositoryRoot, "data/primes.json"), "utf8"));
  const relicData = JSON.parse(await readFile(path.join(repositoryRoot, "data/relics.json"), "utf8"));
  const published = rotationData.rotations.find((rotation) => rotation.publicationStatus === "published");
  const provisional = rotationData.rotations.find((rotation) => rotation.id === "banshee-mirage-2026-09");
  published.items.push(...provisional.items);
  published.relics.push(...provisional.relics);
  assert.throws(() => validateRotationData(rotationData, primeData, relicData), /Rotation item ownership mismatch/);
});

test("candidate 不得复用 published-owned catalog item", async () => {
  const inputs = await fixtureInputs();
  const directory = await temporaryRepository();
  const replaceBanshee = (value) => value.replaceAll("Banshee", "Revenant").replaceAll("banshee", "revenant");
  await assert.rejects(
    runPrimeResurgenceSync({
      rootDir: directory,
      dryRun: true,
      inputs: JSON.parse(replaceBanshee(JSON.stringify(inputs)))
    }),
    /Candidate cannot reuse catalog item revenant-prime owned by published rotation/
  );
});

test("network body size 在 streaming 读取期间受限", async () => {
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.enqueue(new Uint8Array([4, 5, 6]));
      controller.close();
    }
  }), { status: 200 });
  await assert.rejects(
    fetchResource(async () => response, "https://www.warframe.com/test", {
      binary: true,
      finalHosts: ["www.warframe.com"],
      maximumBytes: 5
    }),
    /more than 5 bytes/
  );
});

test("多文件写入失败时 checked rollback 恢复已替换文件", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "varzia-write-rollback-"));
  const first = path.join(directory, "first.json");
  const invalidTarget = path.join(directory, "directory-target");
  await writeFile(first, "before\n", "utf8");
  await chmod(first, 0o600);
  await mkdir(invalidTarget);
  await assert.rejects(
    writeAtomically([
      { path: first, label: "first", original: "before\n", text: "after\n" },
      { path: invalidTarget, label: "directory-target", original: "", text: "invalid\n" }
    ]),
    /Candidate file write failed:.*Rollback and cleanup completed/
  );
  assert.equal(await readFile(first, "utf8"), "before\n");
  assert.equal((await stat(first)).mode & 0o777, 0o600);
  const entries = await (await import("node:fs/promises")).readdir(directory);
  assert.deepEqual(entries.filter((entry) => entry.includes("prime-resurgence-sync")), []);
});

test("dry-run 生成候选摘要但不修改任何数据文件", async () => {
  const directory = await temporaryRepositoryWithoutPreparedCandidate();
  const before = await dataSnapshot(directory);
  const result = await runPrimeResurgenceSync({
    rootDir: directory,
    dryRun: true,
    inputs: await fixtureInputs()
  });
  assert.equal(result.candidateId, "banshee-mirage-2026-09");
  assert.deepEqual(result.changedFiles, ["data/rotation.json", "data/primes.json", "data/relics.json", "data/prime-resurgence-candidates.json"]);
  assert.match(result.summary, /Public Export recipe coverage: 6\/6 items/);
  assert.match(result.summary, /Curated\/manual recipe exceptions: none/);
  assert.match(result.summary, /Rarity audit warnings:/);
  assert.deepEqual(await dataSnapshot(directory), before);
});

test("生成 candidate 的 reward mapping 与官方 source fixture 逐 relic 完全一致", async () => {
  const directory = await temporaryRepository();
  const inputs = await fixtureInputs();
  const beforeRotation = JSON.parse(await readFile(path.join(directory, "data/rotation.json"), "utf8"));
  const beforePrimes = JSON.parse(await readFile(path.join(directory, "data/primes.json"), "utf8"));
  const beforeRelics = JSON.parse(await readFile(path.join(directory, "data/relics.json"), "utf8"));
  const lineup = parsePrimeResurgencePages(inputs.englishHtml, inputs.chineseHtml);
  const selection = selectRelicSet(parseDropTables(inputs.dropTablesHtml), lineup.items, inventoryNames);

  await runPrimeResurgenceSync({ rootDir: directory, inputs });
  const afterRotation = JSON.parse(await readFile(path.join(directory, "data/rotation.json"), "utf8"));
  const afterPrimes = JSON.parse(await readFile(path.join(directory, "data/primes.json"), "utf8"));
  const afterRelics = JSON.parse(await readFile(path.join(directory, "data/relics.json"), "utf8"));

  for (const sourceRelic of selection.relics) {
    const generated = afterRelics.relics.find((relic) => relic.nameEn === sourceRelic.name);
    const expected = sourceRelic.targetRewards
      .map(({ itemId, partId, rarity }) => ({ itemId, partId, rarity }))
      .sort((left, right) => `${left.itemId}:${left.partId}`.localeCompare(`${right.itemId}:${right.partId}`));
    const actual = generated.rewards
      .map(({ itemId, partId, rarity }) => ({ itemId, partId, rarity }))
      .sort((left, right) => `${left.itemId}:${left.partId}`.localeCompare(`${right.itemId}:${right.partId}`));
    assert.deepEqual(actual, expected, sourceRelic.name);
  }
  const mesoE5 = afterRelics.relics.find((relic) => relic.id === "meso-e5");
  assert.ok(mesoE5.rewards.some((reward) => reward.itemId === "banshee-prime" && reward.partId === "blueprint"));
  assert.ok(!mesoE5.rewards.some((reward) => reward.itemId === "banshee-prime" && reward.partId === "chassis"));

  const publishedId = beforeRotation.rotations.find((rotation) => rotation.publicationStatus === "published").id;
  assert.deepEqual(
    afterRotation.rotations.filter((rotation) => rotation.publicationStatus === "published"),
    beforeRotation.rotations.filter((rotation) => rotation.publicationStatus === "published")
  );
  assert.deepEqual(afterPrimes.primeItems.filter((item) => item.rotation === publishedId), beforePrimes.primeItems.filter((item) => item.rotation === publishedId));
  assert.deepEqual(afterRelics.relics.filter((relic) => relic.rotation === publishedId), beforeRelics.relics.filter((relic) => relic.rotation === publishedId));
});

test("连续写入两次时第二次无变化，provisional 永不进入 published schedule", async () => {
  const directory = await temporaryRepositoryWithoutPreparedCandidate();
  const inputs = await fixtureInputs();
  for (const name of ["rotation.json", "primes.json", "relics.json"]) await chmod(path.join(directory, "data", name), 0o600);
  const first = await runPrimeResurgenceSync({
    rootDir: directory,
    inputs
  });
  const afterFirst = await dataSnapshot(directory);
  const second = await runPrimeResurgenceSync({
    rootDir: directory,
    inputs
  });
  assert.deepEqual(first.changedFiles, ["data/rotation.json", "data/primes.json", "data/relics.json", "data/prime-resurgence-candidates.json"]);
  assert.deepEqual(second.changedFiles, []);
  assert.deepEqual(await dataSnapshot(directory), afterFirst);
  for (const name of ["rotation.json", "primes.json", "relics.json"]) assert.equal((await stat(path.join(directory, "data", name))).mode & 0o777, 0o600);

  const schedule = JSON.parse(afterFirst[0]);
  const candidate = schedule.rotations.find((rotation) => rotation.id === "banshee-mirage-2026-09");
  assert.equal(candidate.publicationStatus, "provisional");
  assert.equal(candidate.defaults?.ayaBudget, undefined);
  assert.equal(schedule.lastVerified, "2026-09-04");
  const production = publishedRotations(schedule.rotations);
  assert.ok(!production.some((rotation) => rotation.id === candidate.id));
  assert.equal(resolveRotationState(production, Date.parse(candidate.startsAt) + 1).activeRotation.id, "revenant-baruuk-2026-08");

  const primes = JSON.parse(afterFirst[1]);
  const relics = JSON.parse(afterFirst[2]);
  assert.equal(primes.updatedAt, "2026-09-04");
  assert.equal(relics.updatedAt, "2026-09-04");
  const requiredTotal = candidate.items
    .map((itemId) => primes.primeItems.find((item) => item.id === itemId))
    .flatMap((item) => item.parts)
    .reduce((sum, part) => sum + part.required, 0);
  assert.equal(requiredTotal, 26);
});

test("GitHub Actions 隔离 read/write 权限并保护 bot branch 与 Draft PR", async () => {
  const workflow = await readFile(path.join(repositoryRoot, ".github/workflows/prime-resurgence-sync.yml"), "utf8");
  assert.match(workflow, /cron: "17 9 \* \* \*"/);
  assert.match(workflow, /cron: "43 \* \* \* \*"/);
  assert.match(workflow, /group: prime-resurgence-data-sync/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /SYNC_MODE: \$\{\{ github\.event\.schedule == '43 \* \* \* \*' && 'near-rotation' \|\| 'announcement' \}\}/);
  assert.match(workflow, /--mode "\$SYNC_MODE"/);
  assert.deepEqual(SYNC_MUTABLE_DATA_PATHS, [
    "data/rotation.json",
    "data/primes.json",
    "data/relics.json",
    "data/prime-resurgence-candidates.json"
  ]);
  assert.match(workflow, /--print-managed-paths/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, /publish:[\s\S]*?permissions:\n      contents: write\n      pull-requests: write/);
  assert.equal((workflow.match(/persist-credentials: false/g) || []).length, 2);
  assert.match(workflow, /automation\/prime-resurgence-sync/);
  assert.match(workflow, /Default branch advanced after validation/);
  assert.match(workflow, /Automation branch contains a non-data change/);
  assert.match(workflow, /git add -- "\$\{managed_paths\[@\]\}"/);
  assert.match(workflow, /git rev-list --count/);
  assert.match(workflow, /--force-with-lease="refs\/heads\/\$AUTOMATION_BRANCH:\$remote_branch_sha"/);
  assert.match(workflow, /Multiple open automation PRs found/);
  assert.match(workflow, /\.\[0\]\.isDraft/);
  assert.match(workflow, /chore: prepare Prime Resurgence data update/);
  assert.match(workflow, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.ok(workflow.indexOf("Run repository tests") < workflow.indexOf("GH_TOKEN: ${{ github.token }}"));
  assert.doesNotMatch(workflow, /BASE_BRANCH="\$\{\{/);
  assert.doesNotMatch(workflow, /\|\| true/);
  assert.doesNotMatch(workflow, /secrets\./);
  assert.deepEqual(
    [...workflow.matchAll(/uses: ([^\s]+)/g)].map((match) => match[1]),
    [
      "actions/checkout@v4",
      "actions/setup-node@v4",
      "actions/upload-artifact@v4",
      "actions/checkout@v4",
      "actions/download-artifact@v4"
    ]
  );
});
