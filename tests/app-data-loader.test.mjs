import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadAppData, FALLBACK_SCHEDULE } from "../js/app-data-loader.js";
import { localizeDisplayData } from "../js/i18n.js";

const requiredPaths = ["/data/rotation.json", "/data/primes.json", "/data/relics.json"];
const candidatePath = "/data/prime-resurgence-candidates.json";
const documents = Object.fromEntries(await Promise.all([...requiredPaths, candidatePath].map(async (path) => [
  path, JSON.parse(await readFile(new URL(`..${path}`, import.meta.url), "utf8"))
])));

function harness({ data = structuredClone(documents), failPath, failure } = {}) {
  const calls = [];
  const warnings = [];
  return {
    calls, warnings, data,
    async load(locale = "en") {
      return loadAppData({
        locale,
        warn: (...args) => warnings.push(args),
        fetchImpl: async (path, options) => {
          calls.push({ path, options });
          assert.ok(Object.hasOwn(data, path), `Unexpected request: ${path}`);
          if (path === failPath) {
            if (failure === "network") throw new TypeError("fetch failed");
            if (failure === "http") return { ok: false, status: 503 };
            if (failure === "json") return { ok: true, json: async () => { throw new SyntaxError("Invalid JSON"); } };
          }
          return { ok: true, json: async () => data[path] };
        }
      });
    }
  };
}

function assertUsableSnapshot(result, data, locale = "en") {
  const expected = localizeDisplayData({
    rotations: data[requiredPaths[0]].rotations,
    primeItems: data[requiredPaths[1]].primeItems,
    relics: data[requiredPaths[2]].relics
  }, locale);
  assert.deepEqual(result.dataLoadErrors, []);
  assert.equal(result.scheduleData, data[requiredPaths[0]]);
  assert.deepEqual(result.rotations, expected.rotations);
  assert.deepEqual(result.allPrimeItems, expected.primeItems);
  assert.deepEqual(result.allRelics, expected.relics);
  assert.deepEqual(result.publishedRotations, expected.rotations.filter(({ publicationStatus }) => publicationStatus === "published"));
  assert.ok(result.publishedRotations.length > 0);
}

function assertUnavailableSnapshot(result) {
  assert.equal(result.scheduleData, FALLBACK_SCHEDULE);
  for (const key of ["rotations", "publishedRotations", "allPrimeItems", "allRelics", "announcementCandidates"]) {
    assert.deepEqual(result[key], [], key);
  }
}

for (const locale of ["en", "zh"]) {
  test(`startup returns the existing validated catalog and optional announcements in ${locale}`, async () => {
    const h = harness();
    const result = await h.load(locale);
    assertUsableSnapshot(result, h.data, locale);
    assert.deepEqual(result.announcementCandidates, h.data[candidatePath].candidates);
    assert.ok(result.announcementCandidates.length > 0);
    assert.deepEqual(h.warnings, []);
    assert.deepEqual(h.calls, [...requiredPaths, candidatePath].map((path) => ({ path, options: { cache: "no-store" } })));
  });
}

for (const failPath of requiredPaths) {
  for (const failure of ["http", "network", "json"]) {
    test(`${failure} failure of ${failPath} makes the whole catalog unavailable without fetching announcements or retrying`, async () => {
      const h = harness({ failPath, failure });
      const result = await h.load();
      assertUnavailableSnapshot(result);
      assert.ok(result.dataLoadErrors.includes(failPath));
      assert.deepEqual(h.calls.map(({ path }) => path), requiredPaths);
    });
  }
}

test("cross-document validation failure rejects the entire bundle and retains the warning", async () => {
  const h = harness();
  h.data[requiredPaths[1]].primeItems[0].parts[0].relics.push("missing-relic");
  const result = await h.load();
  assertUnavailableSnapshot(result);
  assert.deepEqual(result.dataLoadErrors, ["data-validation"]);
  assert.deepEqual(h.calls.map(({ path }) => path), requiredPaths);
  assert.equal(h.warnings.length, 1);
  assert.equal(h.warnings[0][0], "Varzia rotation data validation failed");
  assert.match(h.warnings[0][1].message, /missing-relic/);
});

for (const failure of ["http", "network", "json", "schema"]) {
  test(`optional announcement ${failure} failure preserves the usable published catalog`, async () => {
    const h = harness({ failPath: candidatePath, failure });
    if (failure === "schema") h.data[candidatePath].schemaVersion = 999;
    const result = await h.load();
    assertUsableSnapshot(result, h.data);
    assert.deepEqual(result.announcementCandidates, []);
    assert.equal(h.warnings.length, 1);
    assert.equal(h.warnings[0][0], "Varzia announcement candidate preview is unavailable");
    assert.deepEqual(h.calls.map(({ path }) => path), [...requiredPaths, candidatePath]);
  });
}

test("the update label retains the newest raw document date even when the bundle fails validation", async () => {
  const h = harness();
  h.data[requiredPaths[0]].lastVerified = "2026-08-20";
  h.data[requiredPaths[1]].updatedAt = "2026-09-21";
  h.data[requiredPaths[2]].updatedAt = "2026-09-11";
  assert.equal((await h.load()).dataUpdatedAt, "2026-09-21");
  h.data[requiredPaths[1]].primeItems[0].parts[0].relics.push("missing-relic");
  const invalid = await h.load();
  assertUnavailableSnapshot(invalid);
  assert.equal(invalid.dataUpdatedAt, "2026-09-21");
});

test("a failed request contributes its original fallback date rather than the unavailable document date", async () => {
  const h = harness({ failPath: requiredPaths[0], failure: "http" });
  h.data[requiredPaths[0]].lastVerified = "2099-01-01";
  h.data[requiredPaths[1]].updatedAt = "2026-07-01";
  h.data[requiredPaths[2]].updatedAt = "2026-07-02";
  const result = await h.load();
  assertUnavailableSnapshot(result);
  assert.equal(result.dataUpdatedAt, FALLBACK_SCHEDULE.lastVerified);
});

test("loading and localizing leave all source documents unchanged", async () => {
  function freezeTree(value) {
    if (value && typeof value === "object") {
      Object.values(value).forEach(freezeTree);
      Object.freeze(value);
    }
    return value;
  }
  const data = freezeTree(structuredClone(documents));
  const h = harness({ data });
  assertUsableSnapshot(await h.load("en"), data);
  assertUsableSnapshot(await h.load("zh"), data, "zh");
  assert.deepEqual(data, documents);
});

test("independent concurrent loads keep failures local to their own snapshot", async () => {
  const valid = harness();
  const invalid = harness({ failPath: requiredPaths[2], failure: "network" });
  const [validResult, invalidResult] = await Promise.all([valid.load(), invalid.load()]);
  assertUsableSnapshot(validResult, valid.data);
  assertUnavailableSnapshot(invalidResult);
  assert.ok(invalidResult.dataLoadErrors.includes(requiredPaths[2]));
});
