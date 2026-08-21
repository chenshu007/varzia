import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  candidateIdFor,
  fetchResource,
  parseAnnouncementText,
  parseDropTables,
  parseOfficialAnnouncements,
  parsePrimeResurgencePages,
  parseRecipeExceptions,
  parseRecipes,
  resolveRecipeRequirements,
  runPrimeResurgenceSync,
  selectRelicSet,
  writeAtomically
} from "../scripts/lib/prime-resurgence-sync.mjs";
import { validateRotationData } from "../js/data-validation.js";
import { publishedRotations, resolveRotationState } from "../js/rotation-schedule.js";

const fixtureDirectory = new URL("./fixtures/", import.meta.url);
const repositoryRoot = path.resolve(new URL("..", import.meta.url).pathname);

async function fixture(name) {
  return await readFile(new URL(name, fixtureDirectory), "utf8");
}

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
  for (const name of ["rotation.json", "primes.json", "relics.json", "prime-resurgence-recipe-exceptions.json"]) {
    await writeFile(path.join(directory, "data", name), await readFile(path.join(repositoryRoot, "data", name), "utf8"), "utf8");
  }
  return directory;
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
  return await Promise.all(["rotation.json", "primes.json", "relics.json"].map((name) => readFile(path.join(directory, "data", name), "utf8")));
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
  assert.equal(requirements.get("euphona-prime").provenance.status, "curated-manual");
  assert.equal(requirements.get("euphona-prime").provenance.sourceUrl, null);
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

test("页面卡片顺序不影响 canonical candidate ID", () => {
  const startsAt = "2026-09-03T18:00:00Z";
  const first = { warframes: [{ name: "Banshee Prime" }, { name: "Mirage Prime" }] };
  const reversed = { warframes: [...first.warframes].reverse() };
  assert.equal(candidateIdFor(first, startsAt), "banshee-mirage-2026-09");
  assert.equal(candidateIdFor(reversed, startsAt), "banshee-mirage-2026-09");
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
  const directory = await temporaryRepository();
  const recipes = parseRecipes(inputs.recipesText);
  recipes.push({
    uniqueName: "/Lotus/Types/Recipes/Weapons/EuphonaPrimeBlueprint",
    consumeOnUse: true,
    num: 1,
    ingredients: [
      { ItemType: "/Lotus/Types/Recipes/Weapons/WeaponParts/EuphonaPrimeGrip", ItemCount: 1 },
      { ItemType: "/Lotus/Types/Recipes/Weapons/WeaponParts/EuphonaPrimeReceiver", ItemCount: 1 }
    ]
  });
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
  const directory = await temporaryRepository();
  const before = await dataSnapshot(directory);
  const result = await runPrimeResurgenceSync({
    rootDir: directory,
    dryRun: true,
    inputs: await fixtureInputs()
  });
  assert.equal(result.candidateId, "banshee-mirage-2026-09");
  assert.deepEqual(result.changedFiles, ["data/rotation.json", "data/primes.json", "data/relics.json"]);
  assert.match(result.summary, /Public Export recipe coverage: 5\/6 items/);
  assert.match(result.summary, /euphona-prime \(sourceUrl: null; Public Export status: missing\)/);
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
  const directory = await temporaryRepository();
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
  assert.deepEqual(first.changedFiles, ["data/rotation.json", "data/primes.json", "data/relics.json"]);
  assert.deepEqual(second.changedFiles, []);
  assert.deepEqual(await dataSnapshot(directory), afterFirst);
  for (const name of ["rotation.json", "primes.json", "relics.json"]) assert.equal((await stat(path.join(directory, "data", name))).mode & 0o777, 0o600);

  const schedule = JSON.parse(afterFirst[0]);
  const candidate = schedule.rotations.find((rotation) => rotation.id === "banshee-mirage-2026-09");
  assert.equal(candidate.publicationStatus, "provisional");
  assert.equal(candidate.defaults.ayaBudget, 31);
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
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, /publish:[\s\S]*?permissions:\n      contents: write\n      pull-requests: write/);
  assert.equal((workflow.match(/persist-credentials: false/g) || []).length, 2);
  assert.match(workflow, /automation\/prime-resurgence-sync/);
  assert.match(workflow, /Default branch advanced after validation/);
  assert.match(workflow, /Automation branch contains a non-data change/);
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
