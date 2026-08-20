import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  localeFromPathname,
  localePath,
  normalizeLocale,
  resolveLocale,
  setLocaleMessages,
  t
} from "../js/i18n.js";
import { localizedBudgetMarker } from "../js/app.js";
import {
  calculateGraduationRecap,
  calculatePercentileDeltas
} from "../js/wave1.js";
import {
  buildShareCardModel,
  renderShareCardSvg,
  SHARE_CARD_HEIGHT,
  SHARE_CARD_WIDTH
} from "../js/share-card.js";
import { simulateCurrentRotation } from "../js/simulator.js";

const zhMessages = JSON.parse(fs.readFileSync(new URL("../data/locales/zh-cn.json", import.meta.url)));
const enMessages = JSON.parse(fs.readFileSync(new URL("../data/locales/en.json", import.meta.url)));

test("zh/en locale key sets stay identical and locale resolution is deterministic", () => {
  assert.deepEqual(Object.keys(zhMessages).sort(), Object.keys(enMessages).sort());
  assert.equal(normalizeLocale("zh-Hans"), "zh");
  assert.equal(normalizeLocale("en-US"), "en");
  assert.equal(resolveLocale({ savedLocale: "zh", navigatorLanguage: "en-US" }), "zh");
  assert.equal(resolveLocale({ savedLocale: "en", navigatorLanguage: "zh-CN" }), "en");
  assert.equal(resolveLocale({ navigatorLanguage: "zh-CN" }), "zh");
  assert.equal(resolveLocale({ navigatorLanguage: "en-US" }), "en");
  assert.equal(resolveLocale({ navigatorLanguage: "fr-FR" }), DEFAULT_LOCALE);
  assert.equal(localeFromPathname("/zh/"), "zh");
  assert.equal(localeFromPathname("/en/?rotation=2026-09"), "en");
  assert.equal(localeFromPathname("/"), null);
  assert.equal(localePath("zh", { search: "?rotation=future", hash: "#planner" }), "/zh/?rotation=future#planner");
  assert.equal(LOCALE_STORAGE_KEY, "varzia.locale");
});

test("Prime Resurgence official link is localized per locale", () => {
  assert.equal(enMessages["links.primeResurgence"], "https://www.warframe.com/prime-resurgence");
  assert.equal(zhMessages["links.primeResurgence"], "https://www.warframe.com/zh-hans/prime-resurgence");
  setLocaleMessages("en", enMessages, enMessages);
  assert.equal(t("links.primeResurgence"), "https://www.warframe.com/prime-resurgence");
  setLocaleMessages("zh", zhMessages, zhMessages);
  assert.equal(t("links.primeResurgence"), "https://www.warframe.com/zh-hans/prime-resurgence");
});

test("percentile deltas only read existing percentile values", () => {
  assert.deepEqual(calculatePercentileDeltas({
    currentBudget: 33,
    percentiles: { p90: 39, p95: 42, p99: 47 }
  }), [
    { key: "p90", label: "P90", budget: 39, delta: 6, status: "remaining" },
    { key: "p95", label: "P95", budget: 42, delta: 9, status: "remaining" },
    { key: "p99", label: "P99", budget: 47, delta: 14, status: "remaining" }
  ]);
  assert.equal(calculatePercentileDeltas({ currentBudget: 42, percentiles: { p90: 39, p95: 42, p99: 47 } })[1].status, "reached");
  assert.equal(calculatePercentileDeltas({ currentBudget: 50, percentiles: { p90: 39, p95: 42, p99: 47 } })[2].delta, 0);
  assert.equal(calculatePercentileDeltas({ currentBudget: 33, percentiles: { p90: 39, p95: 42, p99: null } })[2].status, "capped");
  assert.ok(calculatePercentileDeltas({ currentBudget: 33, percentiles: { p90: 0, p95: 0, p99: 0 } }).every((entry) => entry.status === "reached"));
});

test("localized budget marker keeps null and undefined capped instead of coercing them to zero", () => {
  setLocaleMessages("en", { "unit.aya": "Aya" }, { "unit.aya": "Aya" });
  assert.equal(localizedBudgetMarker(null, 80), ">80 Aya");
  assert.equal(localizedBudgetMarker(undefined, 80), ">80 Aya");
  assert.equal(localizedBudgetMarker(0, 80), "0 Aya");
  assert.equal(localizedBudgetMarker(33, 80), "33 Aya");
  assert.equal(localizedBudgetMarker(null, null), "—");
});

test("graduation recap uses the discrete empirical CDF and refuses extrapolation", () => {
  const curve = [
    { budget: 0, finishProbability: 0 },
    { budget: 27, finishProbability: 0.1 },
    { budget: 33, finishProbability: 0.5 },
    { budget: 42, finishProbability: 0.95 }
  ];
  assert.deepEqual(calculateGraduationRecap({ curve, observedAya: 0 }), {
    status: "ok", observedAya: 0, percentile: 0, faceBlackIndex: 0, beatPercentage: 100, band: "lucky"
  });
  assert.equal(calculateGraduationRecap({ curve, observedAya: 33 }).faceBlackIndex, 50);
  assert.ok(Math.abs(calculateGraduationRecap({ curve, observedAya: 42 }).beatPercentage - 5) < 1e-9);
  assert.equal(calculateGraduationRecap({ curve, observedAya: 34 }).status, "outside");
  assert.equal(calculateGraduationRecap({ curve, observedAya: 99 }).status, "outside");
});

test("share card model and SVG use runtime results in both locales", () => {
  const labels = {
    brand: "VARZIA",
    subtitle: "Aya Planner",
    rotation: "Current rotation",
    targets: "Selected targets",
    targetUnit: "targets",
    currentAya: "Current Aya",
    probability: "Graduation probability",
    squad: "Same-relic squad",
    simulations: "simulations",
    recap: "Graduation recap",
    faceBlack: "Face-black index",
    beat: "Beat",
    overCap: ">current limit"
  };
  const model = buildShareCardModel({
    locale: "en",
    rotationName: "Runtime rotation",
    itemCount: 3,
    currentBudget: 17,
    finishProbability: 0.1234,
    percentiles: { p50: 18, p90: 29, p95: 35, p99: null },
    analysisCap: 40,
    squad: 2,
    trials: 5000,
    labels
  });
  assert.equal(model.currentBudget, 17);
  assert.equal(model.probabilityText, "12.34%");
  assert.equal(model.percentiles.p50, "18");
  assert.equal(model.percentiles.p99, ">current limit 40");
  const svg = renderShareCardSvg(model);
  assert.match(svg, /Runtime rotation/);
  assert.match(svg, /12\.34%/);
  assert.match(svg, /width="1200" height="1500"/);
  assert.equal(SHARE_CARD_WIDTH, 1200);
  assert.equal(SHARE_CARD_HEIGHT, 1500);
  const zhSvg = renderShareCardSvg(buildShareCardModel({ ...model, locale: "zh", labels: { ...labels, subtitle: "阿耶规划器", targetUnit: "件" } }));
  assert.match(zhSvg, /阿耶规划器/);
});

test("current six-target regression keeps Monte Carlo/CDF baseline", () => {
  const rotationData = JSON.parse(fs.readFileSync(new URL("../data/rotation.json", import.meta.url)));
  const primesData = JSON.parse(fs.readFileSync(new URL("../data/primes.json", import.meta.url)));
  const relicsData = JSON.parse(fs.readFileSync(new URL("../data/relics.json", import.meta.url)));
  const rotation = rotationData.rotations[0];
  const result = simulateCurrentRotation({
    primeItems: primesData.primeItems.filter((item) => rotation.items.includes(item.id)),
    relics: relicsData.relics.filter((relic) => rotation.relics.includes(relic.id)),
    budget: 33,
    squad: 4,
    strategy: "finish",
    trials: 100000,
    analysisCap: 80
  });
  assert.equal(result.summary.itemCount, 6);
  assert.equal(result.summary.remainingParts, 25);
  assert.equal(result.finishProbability, 0.59088);
  assert.deepEqual([result.p50, result.p90, result.p95, result.p99], [33, 39, 42, 47]);
  assert.equal(result.budgetCurve[33].finishProbability - result.finishProbability, 0);
});
