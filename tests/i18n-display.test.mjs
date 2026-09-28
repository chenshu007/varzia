import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { localizeDisplayData } from "../js/i18n.js";
import { simulateCurrentRotation } from "../js/simulator.js";

function readJson(path) {
  return JSON.parse(fs.readFileSync(new URL(path, import.meta.url)));
}

// The official-data sync appends every official lineup item of a new Vault to
// data/primes.json and data/relics.json, so the catalog grows without notice.
// Display assertions therefore resolve records by their stable id instead of
// comparing whole arrays against a historical snapshot of the dataset.
const KNOWN_PRIME_ENGLISH_NAMES = Object.freeze({
  "revenant-prime": "Revenant Prime",
  "baruuk-prime": "Baruuk Prime",
  "phantasma-prime": "Phantasma Prime",
  "tatsu-prime": "Tatsu Prime",
  "afuris-prime": "Afuris Prime",
  "cobra-crane-prime": "Cobra & Crane Prime",
  "banshee-prime": "Banshee Prime",
  "mirage-prime": "Mirage Prime",
  "helios-prime": "Helios Prime",
  "akbolto-prime": "Akbolto Prime",
  "kogake-prime": "Kogake Prime",
  "euphona-prime": "Euphona Prime"
});

const KNOWN_RELIC_ENGLISH_NAMES = Object.freeze({
  "lith-a9": "Lith A9",
  "lith-t13": "Lith T13",
  "meso-r6": "Meso R6",
  "neo-p8": "Neo P8",
  "axi-b9": "Axi B9",
  "axi-c9": "Axi C9",
  "lith-k5": "Lith K5",
  "lith-m7": "Lith M7",
  "meso-e5": "Meso E5",
  "neo-b6": "Neo B6",
  "axi-a12": "Axi A12",
  "axi-h5": "Axi H5"
});

const CJK = /[\u3400-\u9fff]/;

// Curated Chinese part labels and the official drop-table part labels the
// official-data automation pairs them with (scripts/lib/prime-resurgence-sync.mjs).
const AUTOMATION_PART_LABELS = Object.freeze({
  blueprint: ["蓝图", "Blueprint"],
  chassis: ["机体", "Chassis"],
  neuroptics: ["神经光元", "Neuroptics"],
  systems: ["系统", "Systems"],
  cerebrum: ["头部", "Cerebrum"],
  carapace: ["外壳", "Carapace"],
  barrel: ["枪管", "Barrel"],
  receiver: ["枪机", "Receiver"],
  stock: ["枪托", "Stock"],
  link: ["连接器", "Link"],
  blade: ["刀刃", "Blade"],
  hilt: ["握柄", "Hilt"],
  guard: ["护手", "Guard"]
});

// Curated Chinese era label and the official English relic era label.
const AUTOMATION_ERA_ZH = "古纪";
const AUTOMATION_ERA_EN = "Lith";

function indexById(items) {
  return new Map(items.map((item) => [item.id, item]));
}

function englishNamesFor(items, expectedById) {
  const itemMap = indexById(items);
  return Object.fromEntries(Object.keys(expectedById).map((id) => {
    const item = itemMap.get(id);
    assert.ok(item, `Missing catalog record: ${id}`);
    return [id, item.name];
  }));
}

// Invariants that hold for every record, known or newly introduced by the sync.
function assertOfficialEnglishDisplayData(localized, canonical) {
  for (const [label, source, display] of [
    ["rotations", canonical.rotations, localized.rotations],
    ["primeItems", canonical.primeItems, localized.primeItems],
    ["relics", canonical.relics, localized.relics]
  ]) {
    assert.equal(display.length, source.length, `Localized ${label} count changed.`);
    const displayIds = display.map((record) => record.id);
    assert.equal(new Set(displayIds).size, displayIds.length, `Duplicate localized ${label} id.`);
    assert.deepEqual([...displayIds].sort(), source.map((record) => record.id).sort(), `Localized ${label} ids differ from the canonical source.`);
    for (const record of display) {
      assert.equal(record.displayName ?? record.name, record.displayNameEn ?? record.nameEn, `English display field does not come from the official bilingual field: ${label} / ${record.id}`);
      assert.doesNotMatch(record.displayName ?? record.name, CJK, `English display field still contains Chinese text: ${label} / ${record.id}`);
    }
  }

  for (const item of localized.primeItems) {
    for (const part of item.parts || []) {
      assert.equal(part.name, part.nameEn, `Localized part name does not come from the official bilingual field: ${item.id} / ${part.id}`);
      assert.doesNotMatch(part.name, CJK, `Localized part name still contains Chinese text: ${item.id} / ${part.id}`);
    }
  }
  for (const relic of localized.relics) {
    assert.equal(relic.era, relic.eraEn, `Localized relic era does not come from the official bilingual field: ${relic.id}`);
  }
}

test("English display fields use official names without mutating Chinese canonical data", () => {
  const rotationData = readJson("../data/rotation.json");
  const primesData = readJson("../data/primes.json");
  const relicsData = readJson("../data/relics.json");
  const canonicalSnapshot = JSON.stringify({ rotationData, primesData, relicsData });
  const canonical = {
    rotations: rotationData.rotations,
    primeItems: primesData.primeItems,
    relics: relicsData.relics
  };

  const localized = localizeDisplayData(canonical, "en");

  assert.equal(
    localized.rotations.find((rotation) => rotation.id === "revenant-baruuk-2026-08").displayName,
    "Revenant Prime & Baruuk Prime"
  );
  assert.deepEqual(englishNamesFor(localized.primeItems, KNOWN_PRIME_ENGLISH_NAMES), KNOWN_PRIME_ENGLISH_NAMES);
  assert.deepEqual(englishNamesFor(localized.relics, KNOWN_RELIC_ENGLISH_NAMES), KNOWN_RELIC_ENGLISH_NAMES);
  assert.deepEqual(
    localized.primeItems.find((item) => item.id === "revenant-prime").parts.map((part) => part.name),
    ["Blueprint", "Chassis", "Neuroptics", "Systems"]
  );
  assert.deepEqual(
    localized.primeItems.find((item) => item.id === "cobra-crane-prime").parts.map((part) => part.name),
    ["Blueprint", "Blade", "Hilt", "Guard"]
  );
  assertOfficialEnglishDisplayData(localized, canonical);
  assert.equal(JSON.stringify({ rotationData, primesData, relicsData }), canonicalSnapshot);
});

test("a newly generated provisional candidate adds Prime records without invalidating English display data", () => {
  const rotationData = readJson("../data/rotation.json");
  const primesData = readJson("../data/primes.json");
  const relicsData = readJson("../data/relics.json");
  const canonicalSnapshot = JSON.stringify({ rotationData, primesData, relicsData });

  // Mirrors the catalog the official-data automation appends when it prepares a
  // new provisional rotation: Chinese canonical names paired with the official
  // English equipment names from the Public Export and the official part labels
  // from the drop tables. The historical assertions above must keep holding
  // while records the test has never seen are added alongside them.
  const candidateRelicIds = ["lith-f1", "meso-f1"];
  const candidateRotationId = "future-vesture-carapace-2026-11";
  const candidateItemSpecs = [
    ["future-vesture-prime", "未来外衣 Prime", "Future Vesture Prime", "warframe", ["blueprint", "chassis", "neuroptics", "systems"]],
    ["future-carapace-prime", "未来甲壳 Prime", "Future Carapace Prime", "warframe", ["blueprint", "chassis", "neuroptics", "systems"]],
    ["future-repeater-prime", "未来连射 Prime", "Future Repeater Prime", "primary", ["blueprint", "barrel", "receiver", "stock"]],
    ["future-scout-prime", "未来斥候 Prime", "Future Scout Prime", "secondary", ["blueprint", "barrel", "receiver", "link"]],
    ["future-staff-prime", "未来法杖 Prime", "Future Staff Prime", "melee", ["blueprint", "blade", "hilt", "guard"]],
    ["future-companion-prime", "未来伙伴 Prime", "Future Companion Prime", "companion", ["blueprint", "cerebrum", "carapace", "systems"]]
  ];
  const candidateItems = candidateItemSpecs.map(([id, name, nameEn, type, partIds]) => ({
    id,
    name,
    nameEn,
    type,
    rotation: candidateRotationId,
    relics: candidateRelicIds,
    parts: partIds.map((partId) => ({
      id: partId,
      name: AUTOMATION_PART_LABELS[partId][0],
      nameEn: AUTOMATION_PART_LABELS[partId][1],
      required: 1,
      rarity: "common",
      relics: candidateRelicIds
    }))
  }));
  const candidateRelics = candidateRelicIds.map((id, index) => ({
    id,
    name: `${AUTOMATION_ERA_ZH} F${index + 1}`,
    nameEn: `${AUTOMATION_ERA_EN} F${index + 1}`,
    era: AUTOMATION_ERA_ZH,
    eraEn: AUTOMATION_ERA_EN,
    costAya: 1,
    rotation: candidateRotationId,
    rewards: candidateItems.map((item) => ({ itemId: item.id, partId: item.parts[0].id, rarity: "common" }))
  }));
  const candidateRotation = {
    id: candidateRotationId,
    publicationStatus: "provisional",
    displayName: "未来外衣 Prime 与 未来甲壳 Prime",
    displayNameEn: "Future Vesture Prime & Future Carapace Prime",
    startsAt: "2026-11-01T18:00:00Z",
    items: candidateItems.map((item) => item.id),
    relics: candidateRelicIds
  };
  const extended = {
    rotations: [...rotationData.rotations, candidateRotation],
    primeItems: [...primesData.primeItems, ...candidateItems],
    relics: [...relicsData.relics, ...candidateRelics]
  };

  const localized = localizeDisplayData(extended, "en");

  // The candidate grew the catalog; nothing in the display data is dropped.
  assert.equal(localized.primeItems.length, primesData.primeItems.length + candidateItems.length);
  assert.equal(localized.relics.length, relicsData.relics.length + candidateRelics.length);
  assert.equal(localized.rotations.length, rotationData.rotations.length + 1);

  // Historical records keep their official English names.
  assert.deepEqual(englishNamesFor(localized.primeItems, KNOWN_PRIME_ENGLISH_NAMES), KNOWN_PRIME_ENGLISH_NAMES);
  assert.deepEqual(englishNamesFor(localized.relics, KNOWN_RELIC_ENGLISH_NAMES), KNOWN_RELIC_ENGLISH_NAMES);
  assert.equal(
    localized.rotations.find((rotation) => rotation.id === "revenant-baruuk-2026-08").displayName,
    "Revenant Prime & Baruuk Prime"
  );

  // Newly introduced records localize from their own official bilingual fields.
  assert.deepEqual(
    englishNamesFor(localized.primeItems, Object.fromEntries(candidateItems.map((item) => [item.id, item.nameEn]))),
    Object.fromEntries(candidateItems.map((item) => [item.id, item.nameEn]))
  );
  assert.deepEqual(
    englishNamesFor(localized.relics, Object.fromEntries(candidateRelics.map((relic) => [relic.id, relic.nameEn]))),
    Object.fromEntries(candidateRelics.map((relic) => [relic.id, relic.nameEn]))
  );
  assert.equal(
    localized.rotations.find((rotation) => rotation.id === candidateRotation.id).displayName,
    "Future Vesture Prime & Future Carapace Prime"
  );
  assert.deepEqual(
    localized.primeItems.filter((item) => item.id === "future-vesture-prime")[0].parts.map((part) => part.name),
    ["Blueprint", "Chassis", "Neuroptics", "Systems"]
  );

  assertOfficialEnglishDisplayData(localized, extended);
  assert.equal(JSON.stringify({ rotationData, primesData, relicsData }), canonicalSnapshot);
});

test("Chinese display data remains the canonical source objects", () => {
  const rotationData = readJson("../data/rotation.json");
  const primesData = readJson("../data/primes.json");
  const relicsData = readJson("../data/relics.json");
  const localized = localizeDisplayData({
    rotations: rotationData.rotations,
    primeItems: primesData.primeItems,
    relics: relicsData.relics
  }, "zh");

  assert.equal(localized.rotations, rotationData.rotations);
  assert.equal(localized.primeItems, primesData.primeItems);
  assert.equal(localized.relics, relicsData.relics);
  assert.equal(localized.rotations[0].displayName, "Revenant Prime 与 Baruuk Prime");
  assert.equal(localized.primeItems.find((item) => item.id === "phantasma-prime").name, "幻离子 Prime");
  assert.equal(localized.relics[0].name, "古纪 A9");
});

test("automation-generated bilingual fields localize future provisional data without a code overlay", () => {
  const localized = localizeDisplayData({
    rotations: [{ id: "future", displayName: "未来轮换", displayNameEn: "Future Rotation" }],
    primeItems: [{
      id: "future-prime",
      name: "未来 Prime",
      nameEn: "Future Prime",
      parts: [{ id: "blueprint", name: "蓝图", nameEn: "Blueprint" }]
    }],
    relics: [{ id: "lith-f1", name: "古纪 F1", nameEn: "Lith F1", era: "古纪", eraEn: "Lith" }]
  }, "en");

  assert.equal(localized.rotations[0].displayName, "Future Rotation");
  assert.equal(localized.primeItems[0].name, "Future Prime");
  assert.equal(localized.primeItems[0].parts[0].name, "Blueprint");
  assert.equal(localized.relics[0].name, "Lith F1");
  assert.equal(localized.relics[0].era, "Lith");
});

test("English display names do not change simulation results", () => {
  const rotationData = readJson("../data/rotation.json");
  const primesData = readJson("../data/primes.json");
  const relicsData = readJson("../data/relics.json");
  const rotation = rotationData.rotations[0];
  const canonicalInput = {
    primeItems: primesData.primeItems.filter((item) => rotation.items.includes(item.id)),
    relics: relicsData.relics.filter((relic) => rotation.relics.includes(relic.id))
  };
  const localizedInput = localizeDisplayData(canonicalInput, "en");
  const options = { budget: 33, squad: 4, strategy: "finish", trials: 5000, analysisCap: 80 };
  const canonical = simulateCurrentRotation({ ...canonicalInput, ...options });
  const localized = simulateCurrentRotation({ ...localizedInput, ...options });

  assert.equal(localized.finishProbability, canonical.finishProbability);
  assert.deepEqual([localized.p50, localized.p90, localized.p95, localized.p99], [canonical.p50, canonical.p90, canonical.p95, canonical.p99]);
  assert.deepEqual(localized.budgetCurve, canonical.budgetCurve);
  assert.deepEqual(localized.summary, canonical.summary);
});

test("English UI copy removes the approved literal translations", () => {
  const messages = readJson("../data/locales/en.json");
  const renderedCopy = Object.values(messages).join("\n");

  assert.doesNotMatch(renderedCopy, /graduation|face-black|give reality to probability/i);
  assert.equal(messages["goal.label"], "Target probability");
  assert.equal(messages["goal.p90"], "P90 · 90% chance");
  assert.equal(messages["goal.p95"], "P95 · 95% chance");
  assert.equal(messages["goal.p99"], "P99 · 99% chance");
  assert.equal(messages["results.subline"], "Let thousands of possible timelines play out before you do.");
});
