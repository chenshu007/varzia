import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { decodePlan, encodePlan, planUrl, planNavigationChanged, MAX_PLAN_LENGTH } from "../js/plan-share.js";
import { renderPlanQr } from "../js/plan-qr.js";
import { buildLocalePages, renderLocalePage } from "../scripts/build-locales.mjs";
import { injectOwnedCounts } from "../js/app.js";
import { simulateCurrentRotation } from "../js/simulator.js";
import { localePath } from "../js/i18n.js";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");
const rotations = JSON.parse(read("../data/rotation.json")).rotations;
const primeItems = JSON.parse(read("../data/primes.json")).primeItems;
const allRelics = JSON.parse(read("../data/relics.json")).relics;
const rotation = rotations.filter((entry) => entry.publicationStatus === "published").at(-1);
const selected = primeItems.filter((item) => rotation.items.includes(item.id));
const input = {
  rotationId: rotation.id,
  mode: "goal", goal: "0.95",
  options: {
    primeItems: selected.map((item) => ({ ...item, parts: item.parts.map((part, index) => ({ ...part, ownedCount: index % 2 })) })),
    budget: 37, squad: 3, strategy: "efficient", trials: 5000, analysisCap: 120
  }
};
const decode = (encoded) => decodePlan(`#plan=${encoded}`, { rotations, primeItems });
const mutate = (fn) => {
  const raw = JSON.parse(atob(encodePlan(input).replaceAll("-", "+").replaceAll("_", "/")));
  fn(raw);
  return btoa(JSON.stringify(raw)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

test("shared plan round trip preserves inputs and reproduces the same simulation", () => {
  const result = decode(encodePlan(input));
  assert.equal(result.status, "ok");
  const plan = result.plan;
  assert.equal(plan.mode, "goal");
  assert.equal(plan.goal, "0.95");
  assert.equal(plan.budget, 37);
  assert.equal(plan.squad, 3);
  assert.equal(plan.strategy, "efficient");
  assert.equal(plan.trials, 5000);
  assert.deepEqual(plan.selectedItemIds, input.options.primeItems.map((item) => item.id));
  const restoredItems = injectOwnedCounts(plan.selectedItemIds.map((id) => primeItems.find((item) => item.id === id)), plan.owned);
  const relics = allRelics.filter((relic) => rotation.relics.includes(relic.id));
  const before = simulateCurrentRotation({ ...input.options, relics });
  const after = simulateCurrentRotation({ ...input.options, ...plan, primeItems: restoredItems, relics });
  assert.equal(after.finishProbability, before.finishProbability);
  assert.deepEqual(after.budgetCurve, before.budgetCurve);
  assert.deepEqual(after.summary, before.summary);
});

test("shared plans preserve partial duplicate-part counts and budget zero", () => {
  const item = selected.find((entry) => entry.parts.some((part) => part.required > 1));
  assert.ok(item);
  const options = { ...input.options, budget: 0, primeItems: [{ ...item, parts: item.parts.map((part) => ({ ...part, ownedCount: part.required > 1 ? 1 : 0 })) }] };
  const { plan } = decode(encodePlan({ ...input, options }));
  assert.equal(plan.budget, 0);
  for (const part of item.parts.filter((part) => part.required > 1)) assert.equal(plan.owned[item.id][part.id], 1);
  const empty = decode(encodePlan({ ...input, options: { ...input.options, primeItems: [] } }));
  assert.equal(empty.status, "ok");
  assert.deepEqual(empty.plan.selectedItemIds, []);
  assert.deepEqual(empty.plan.owned, {});
});

test("links are localized and keep shared input in the fragment across language routes", () => {
  const encoded = encodePlan(input);
  const url = new URL(planUrl(encoded, "zh"));
  assert.equal(url.search, "");
  assert.equal(url.hostname, "varzia.starport1116.com");
  assert.equal(url.pathname, "/zh/");
  assert.equal(localePath("en", url), `/en/#plan=${encoded}`);
  assert.equal(decodePlan("#planner").status, "absent");
  assert.equal(planNavigationChanged(url.href, `${url.origin}/zh/#planner`), true);
  assert.equal(planNavigationChanged(`${url.origin}/zh/#planner`, url.href), true);
  assert.equal(planNavigationChanged(url.href, `${url.origin}/zh/#plan=another`), true);
  assert.equal(planNavigationChanged(url.href, url.href), false);
  assert.equal(planNavigationChanged(`${url.origin}/zh/#planner`, `${url.origin}/zh/#results`), false);
});

test("malformed, oversized, future, and out-of-catalog payloads fail closed", () => {
  for (const bad of ["#plan=", "#plan=%%%", "#plan=" + "x".repeat(MAX_PLAN_LENGTH + 1)]) {
    assert.equal(decodePlan(bad, { rotations, primeItems }).status, "invalid");
  }
  const edits = [
    (raw) => { raw[0] = 2; },
    (raw) => { raw[2] = 161; },
    (raw) => { raw[2] = "33"; },
    (raw) => { raw[3] = 5; },
    (raw) => { raw[4] = -1; },
    (raw) => { raw[5] = 99; },
    (raw) => { raw[6] = 2; },
    (raw) => { raw[7] = 0.5; },
    (raw) => { raw[8].push(raw[8][0]); },
    (raw) => { raw[8][0][0] = "__proto__"; },
    (raw) => { raw[8][0][1] = [["__proto__", 1]]; },
    (raw) => { raw[8][0][1][0][1] = 999; },
    (raw) => { raw[8][0][1][0][1] = -1; },
    (raw) => { raw[8][0][1][0][1] = 0.5; }
  ];
  for (const edit of edits) assert.equal(decode(mutate(edit)).status, "invalid");
  assert.equal(decode(mutate((raw) => { raw[1] = "missing"; })).status, "unavailable");
  assert.equal(decodePlan(`#plan=${encodePlan(input)}`, {
    rotations: [{ ...rotation, publicationStatus: "provisional" }], primeItems
  }).status, "unavailable");
  assert.equal({}.polluted, undefined);
});

test("the current catalog fits on a local QR, including every owned part", () => {
  const options = { ...input.options, primeItems: selected.map((item) => ({ ...item,
    parts: item.parts.map((part) => ({ ...part, ownedCount: Number(part.required || 1) })) })) };
  const url = planUrl(encodePlan({ ...input, options }), "zh");
  const svg = renderPlanQr(url);
  assert.match(svg, /shape-rendering="crispEdges"/);
  assert.match(svg, /fill="#fff"/);
  assert.match(svg, /<path d="M/);
  assert.doesNotMatch(svg, /https:|script|image/);
});

test("generated language pages are current and contain readable content without JavaScript", () => {
  buildLocalePages({ check: true });
  const template = read("../index.html");
  const ids = (html) => [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]).filter((id) => id !== "localeMessages").sort();
  for (const [locale, file] of [["en", "en"], ["zh", "zh-cn"]]) {
    const messages = JSON.parse(read(`../data/locales/${file}.json`));
    const page = read(`../${locale}/index.html`);
    assert.deepEqual(ids(page), ids(template));
    assert.match(page, /src="\/js\/app.js"/);
    assert.doesNotMatch(page, /route-entry\.js|class="route-loading"/);
    assert.ok(page.includes(messages["guide.title"]));
    assert.ok(page.includes(messages["guide.a1"]));
    assert.ok(page.includes(`<html lang="${locale === "zh" ? "zh-CN" : "en"}"`));
    assert.ok(page.includes(`rel="canonical" href="https://varzia.starport1116.com/${locale}/"`));
    assert.ok(page.includes(`class="brand" href="/${locale}/"`));
    const embedded = JSON.parse(page.match(/id="localeMessages">([\s\S]*?)<\/script>/)[1]);
    assert.deepEqual(embedded, messages);
  }
});

test("static translations escape hostile markup, preserve nested boundaries, and reject missing keys", () => {
  const messages = { "test": '<script>alert("x")</script>', "seo.title": "Test", "seo.description": "Test", "seo.ogDescription": "Test" };
  const page = renderLocalePage('<html><body><span data-i18n="test"><strong>Old</strong></span><p id="after">Preserved</p></body></html>', messages, "en");
  assert.match(page, /&lt;script&gt;/);
  assert.match(page, /<p id="after">Preserved<\/p>/);
  assert.doesNotMatch(page, /<script>alert/);
  assert.throws(() => renderLocalePage('<p data-i18n="missing">Old</p>', messages, "en"), /Missing/);
});
