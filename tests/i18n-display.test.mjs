import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { localizeDisplayData } from "../js/i18n.js";
import { simulateCurrentRotation } from "../js/simulator.js";

function readJson(path) {
  return JSON.parse(fs.readFileSync(new URL(path, import.meta.url)));
}

test("English display overlay uses official names without mutating Chinese canonical data", () => {
  const rotationData = readJson("../data/rotation.json");
  const primesData = readJson("../data/primes.json");
  const relicsData = readJson("../data/relics.json");
  const canonicalSnapshot = JSON.stringify({ rotationData, primesData, relicsData });

  const localized = localizeDisplayData({
    rotations: rotationData.rotations,
    primeItems: primesData.primeItems,
    relics: relicsData.relics
  }, "en");

  assert.equal(localized.rotations[0].displayName, "Revenant Prime & Baruuk Prime");
  assert.deepEqual(localized.primeItems.map((item) => item.name), [
    "Revenant Prime",
    "Baruuk Prime",
    "Phantasma Prime",
    "Tatsu Prime",
    "Afuris Prime",
    "Cobra & Crane Prime"
  ]);
  assert.deepEqual(localized.relics.map((relic) => relic.name), [
    "Lith A9",
    "Lith T13",
    "Meso R6",
    "Neo P8",
    "Axi B9",
    "Axi C9"
  ]);
  assert.deepEqual(
    localized.primeItems.find((item) => item.id === "revenant-prime").parts.map((part) => part.name),
    ["Blueprint", "Chassis", "Neuroptics", "Systems"]
  );
  assert.deepEqual(
    localized.primeItems.find((item) => item.id === "cobra-crane-prime").parts.map((part) => part.name),
    ["Blueprint", "Blade", "Hilt", "Guard"]
  );
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
