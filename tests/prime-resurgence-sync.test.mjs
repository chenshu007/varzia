import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  OFFICIAL_SOURCES,
  candidateIdFor,
  escapeMarkdownInline,
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
  writeAtomically
} from "../scripts/lib/prime-resurgence-sync.mjs";
import { validateAnnouncementCandidates, validateRotationData } from "../js/data-validation.js";
import { normalizeOfficialTimestamp } from "../js/prime-resurgence-candidate.js";
import { publishedRotations, resolveRotationState } from "../js/rotation-schedule.js";

const fixtureDirectory = new URL("./fixtures/", import.meta.url);
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
  for (const name of ["rotation.json", "primes.json", "relics.json", "prime-resurgence-candidates.json", "prime-resurgence-recipe-exceptions.json"]) {
    await writeFile(path.join(directory, "data", name), await readFile(path.join(repositoryRoot, "data", name), "utf8"), "utf8");
  }
  return directory;
}

async function temporaryRepositoryWithoutPreparedCandidate() {
  const directory = await temporaryRepository();
  const rotationPath = path.join(directory, "data/rotation.json");
  const primesPath = path.join(directory, "data/primes.json");
  const relicsPath = path.join(directory, "data/relics.json");
  const candidatesPath = path.join(directory, "data/prime-resurgence-candidates.json");
  const rotation = JSON.parse(await readFile(rotationPath, "utf8"));
  const candidate = rotation.rotations.find((entry) => entry.publicationStatus === "provisional");
  assert.ok(candidate, "fixture repository must contain an existing full provisional candidate");
  rotation.rotations = rotation.rotations.filter((entry) => entry.id !== candidate.id);

  const primes = JSON.parse(await readFile(primesPath, "utf8"));
  primes.primeItems = primes.primeItems.filter((item) => item.rotation !== candidate.id);
  delete primes.provisionalSources?.[candidate.id];

  const relics = JSON.parse(await readFile(relicsPath, "utf8"));
  relics.relics = relics.relics.filter((relic) => relic.rotation !== candidate.id);
  delete relics.provisionalSources?.[candidate.id];

  await Promise.all([
    writeFile(rotationPath, `${JSON.stringify(rotation, null, 2)}\n`, "utf8"),
    writeFile(primesPath, `${JSON.stringify(primes, null, 2)}\n`, "utf8"),
    writeFile(relicsPath, `${JSON.stringify(relics, null, 2)}\n`, "utf8"),
    writeFile(candidatesPath, '{\n  "schemaVersion": 1,\n  "candidates": []\n}\n', "utf8")
  ]);
  return directory;
}

async function announcementOnlyInputs() {
  const inputs = await fixtureInputs();
  return {
    ...inputs,
    englishHtml: inputs.englishHtml
      .replaceAll("Banshee", "Revenant")
      .replaceAll("Mirage", "Baruuk"),
    chineseHtml: inputs.chineseHtml
      .replaceAll("Banshee", "Revenant")
      .replaceAll("Mirage", "Baruuk")
  };
}

function officialFetchFixture(inputs, requested) {
  const payloads = new Map([
    [OFFICIAL_SOURCES.rotationEn, inputs.englishHtml],
    [OFFICIAL_SOURCES.rotationZh, inputs.chineseHtml],
    [OFFICIAL_SOURCES.dropTables, inputs.dropTablesHtml],
    [OFFICIAL_SOURCES.publicExportIndex, Buffer.from("fixture-index")],
    [inputs.recipeUrl, inputs.recipesText]
  ]);
  return async (url) => {
    requested.push(url);
    const payload = payloads.get(url);
    if (payload === undefined) throw new Error(`Unexpected official request: ${url}`);
    return new Response(payload, { status: 200 });
  };
}

function fixtureIndexDecompress() {
  return "ExportRecipes_en.json!00_fixture\n";
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
  const selection = selectRelicSet(parseDropTables(malformed), lineup.items);
  const recipes = parseRecipes(inputs.recipesText);
  assert.throws(
    () => resolveRecipeRequirements(recipes, lineup.items, selection.expectedByItem),
    /Unexpected item ingredient for Akbolto Prime|missing a Prime part for Akbolto Prime/
  );
});

test("多个同分遗物候选不能被猜测选中", async () => {
  const inputs = await fixtureInputs();
  const lineup = parsePrimeResurgencePages(inputs.englishHtml, inputs.chineseHtml);
  const relics = parseDropTables(inputs.dropTablesHtml);
  relics.push({ ...structuredClone(relics[0]), name: "Axi Z99" });
  assert.throws(() => selectRelicSet(relics, lineup.items), /Multiple equally supported relic sets/);
});

test("Public Export recipe 同时计算 ×1 与 ×2 Prime 部件", async () => {
  const inputs = await fixtureInputs();
  const lineup = parsePrimeResurgencePages(inputs.englishHtml, inputs.chineseHtml);
  const selection = selectRelicSet(parseDropTables(inputs.dropTablesHtml), lineup.items);
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
  const selection = selectRelicSet(parseDropTables(inputs.dropTablesHtml), lineup.items);
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
  assert.throws(() => selectRelicSet(parsed, lineup.items), /Duplicate target reward in Axi A12/);
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
  assert.match(first.summary, /Relic data: pending official rotation data/);
  assert.deepEqual((await dataSnapshot(directory)).slice(0, 3), beforeProduction);
  assert.equal(validateAnnouncementCandidates(firstCandidateData, JSON.parse(beforeProduction[0])), true);

  const second = await runPrimeResurgenceSync({ rootDir: directory, inputs, now: "2026-08-21T18:01:00.000Z" });
  assert.deepEqual(second.changedFiles, []);
  assert.deepEqual(await candidateSnapshot(directory), firstCandidateData);
});

test("announcement preview 发现阶段不会请求 droptable 或 Public Export", async () => {
  const directory = await temporaryRepositoryWithoutPreparedCandidate();
  const inputs = await announcementOnlyInputs();
  const requested = [];
  const payloadByUrl = new Map([
    ["https://www.warframe.com/en/prime-resurgence", inputs.englishHtml],
    ["https://www.warframe.com/zh-hans/prime-resurgence", inputs.chineseHtml],
    ["https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=warframe.com&limit=100&filter=posts_no_replies", inputs.announcementText]
  ]);
  const fetchImpl = async (url) => {
    requested.push(url);
    const body = payloadByUrl.get(url);
    if (body === undefined) throw new Error(`unexpected full-data request: ${url}`);
    return new Response(body, { status: 200 });
  };
  const result = await runPrimeResurgenceSync({
    rootDir: directory,
    fetchImpl,
    now: "2026-08-20T18:01:00.000Z"
  });
  assert.equal(result.candidateStage, "announced");
  assert.deepEqual(requested.sort(), [...payloadByUrl.keys()].sort());
});

test("announced candidate 在正式页面与 official data 到位后升级同一 identity 并 ready-for-review", async () => {
  const directory = await temporaryRepositoryWithoutPreparedCandidate();
  const now = "2026-08-20T18:01:00.000Z";
  await runPrimeResurgenceSync({ rootDir: directory, inputs: await announcementOnlyInputs(), now });
  const beforeUpgrade = await candidateSnapshot(directory);
  const firstId = beforeUpgrade.candidates[0].id;

  const upgraded = await runPrimeResurgenceSync({ rootDir: directory, inputs: await fixtureInputs(), now: "2026-08-21T18:01:00.000Z" });
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
  assert.equal(candidate.source.officialData.rotationPage.url, "https://www.warframe.com/en/prime-resurgence");
  assert.equal(validateAnnouncementCandidates(candidateData, JSON.parse(await readFile(path.join(directory, "data/rotation.json"), "utf8"))), true);
});

test("公告与后续正式页面不一致时记录 conflict、保留双方来源且不升级正式 rotation", async () => {
  const directory = await temporaryRepositoryWithoutPreparedCandidate();
  const now = "2026-08-20T18:01:00.000Z";
  await runPrimeResurgenceSync({ rootDir: directory, inputs: await announcementOnlyInputs(), now });
  const beforeProduction = (await dataSnapshot(directory)).slice(0, 3);
  const conflictInputs = await fixtureInputs();
  conflictInputs.englishHtml = conflictInputs.englishHtml.replaceAll("Mirage", "X");
  conflictInputs.chineseHtml = conflictInputs.chineseHtml.replaceAll("Mirage", "X");
  const conflict = await runPrimeResurgenceSync({ rootDir: directory, inputs: conflictInputs, now: "2026-08-22T18:01:00.000Z" });
  const candidate = (await candidateSnapshot(directory)).candidates[0];
  assert.equal(conflict.candidateStage, "conflict");
  assert.deepEqual(conflict.changedFiles, ["data/prime-resurgence-candidates.json"]);
  assert.equal(candidate.status, "conflict");
  assert.equal(candidate.relicDataStatus, "conflict");
  assert.equal(candidate.verified, false);
  assert.equal(candidate.source.url, "https://bsky.app/profile/warframe.com/post/3mtjt7pmvpr2o");
  assert.deepEqual(candidate.source.conflict.officialRotationPage.rawPrimeWarframes, ["Banshee Prime", "X Prime"]);
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

test("near-rotation watcher 仅在窗口内请求官网，旧官网阵容不会请求 drop table 或 Public Export", async () => {
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
  assert.equal(result.watcher.externalRequests, 2);
  assert.deepEqual(requests.sort(), [OFFICIAL_SOURCES.rotationEn, OFFICIAL_SOURCES.rotationZh].sort());
  assert.deepEqual(await dataSnapshot(directory), before);
});

test("near-rotation watcher 匹配官网后复用 announced record 完整验证并进入 ready-for-review", async () => {
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
  assert.equal(result.watcher.externalRequests, 5);
  assert.deepEqual(new Set(requests), new Set([
    OFFICIAL_SOURCES.rotationEn,
    OFFICIAL_SOURCES.rotationZh,
    OFFICIAL_SOURCES.dropTables,
    OFFICIAL_SOURCES.publicExportIndex,
    inputs.recipeUrl
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
  const inputs = await fixtureInputs();
  inputs.englishHtml = inputs.englishHtml.replaceAll("Mirage", "X");
  inputs.chineseHtml = inputs.chineseHtml.replaceAll("Mirage", "X");
  const conflictRequests = [];
  const conflict = await runNearRotationWatcher({
    rootDir: directory,
    now: "2026-09-03T19:00:00.000Z",
    fetchImpl: officialFetchFixture(inputs, conflictRequests),
    decompress: fixtureIndexDecompress
  });
  assert.equal(conflict.status, "CONFLICT");
  assert.deepEqual(conflictRequests.sort(), [OFFICIAL_SOURCES.rotationEn, OFFICIAL_SOURCES.rotationZh].sort());
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
  await runPrimeResurgenceSync({ rootDir: directory, inputs: await fixtureInputs(), now: "2026-08-21T18:01:00.000Z" });
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
  const selection = selectRelicSet(parseDropTables(inputs.dropTablesHtml), lineup.items);
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
        recipesText: JSON.stringify({ ExportRecipes: recipes })
      }
    }),
    /No curated Chinese part name exists for euphona-prime\/grip/
  );
});

test("recipe quantity 必须是 Uint16 可表示的 safe integer", async () => {
  const inputs = await fixtureInputs();
  const lineup = parsePrimeResurgencePages(inputs.englishHtml, inputs.chineseHtml);
  const selection = selectRelicSet(parseDropTables(inputs.dropTablesHtml), lineup.items);
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
  const provisional = rotationData.rotations.find((rotation) => rotation.publicationStatus === "provisional");
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
      inputs: {
        ...inputs,
        englishHtml: replaceBanshee(inputs.englishHtml),
        chineseHtml: replaceBanshee(inputs.chineseHtml),
        announcementText: replaceBanshee(inputs.announcementText),
        dropTablesHtml: replaceBanshee(inputs.dropTablesHtml),
        recipesText: replaceBanshee(inputs.recipesText)
      }
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
  const selection = selectRelicSet(parseDropTables(inputs.dropTablesHtml), lineup.items);

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
  assert.equal(schedule.lastVerified, "2026-08-14");
  const production = publishedRotations(schedule.rotations);
  assert.ok(!production.some((rotation) => rotation.id === candidate.id));
  assert.equal(resolveRotationState(production, Date.parse(candidate.startsAt) + 1).activeRotation.id, "revenant-baruuk-2026-08");

  const primes = JSON.parse(afterFirst[1]);
  const relics = JSON.parse(afterFirst[2]);
  assert.equal(primes.updatedAt, "2026-08-14");
  assert.equal(relics.updatedAt, "2026-08-14");
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
