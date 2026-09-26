import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createCollectionView } from "../js/collection-view.js";
import { createResultsView } from "../js/results-view.js";
import { createTranslator, typeLabelKey, rarityKey, refinementKey } from "../js/i18n.js";

const messages = JSON.parse(fs.readFileSync(new URL("../data/locales/en.json", import.meta.url), "utf8"));

// Capture the view's DOM writes. Only progress meters need a DOM query; this
// deliberately does not simulate browser HTML parsing or event dispatch.
class ViewElement {
  constructor() {
    this.value = "";
    this.style = {};
    this.hidden = true;
    this.disabled = false;
    this.html = "";
    this.text = "";
    this.meters = [];
  }

  set innerHTML(value) {
    this.html = value;
    this.text = "";
    this.meters = [...value.matchAll(/<span data-completion="([^"]*)"><\/span>/g)]
      .map(([, completion]) => ({ dataset: { completion }, style: {} }));
  }
  get innerHTML() { return this.html; }
  set textContent(value) { this.text = value; this.html = ""; this.meters = []; }
  get textContent() { return this.text; }
  querySelectorAll(selector) {
    assert.equal(selector, "[data-completion]");
    return this.meters;
  }
}

function harness(overrides = {}) {
  const ids = [
    "rotationName", "rotationIndex", "targetRotationTitle", "rotationFeatured", "targetOptions",
    "collectionList", "targetCount", "goalLine", "strategy", "trialBadge", "primaryResultLabel",
    "finishProbability", "finishDetail", "probabilityBar", "meanAya", "traceTotal", "runCaption",
    "summaryTargets", "summaryCompleted", "summaryRemaining", "summaryBudget", "verdict",
    "resultStatus", "resultSentence", "timelineHeadline", "timelineDetail", "timelineSuccess",
    "breakdownBody", "targetResultList", "recommendationAya", "recommendationList", "targetDeltaList",
    "sharePanel", "recapPanel", "observedAya", "recapResult"
  ];
  const nodes = new Map(ids.map((id) => [id, new ViewElement()]));
  const $ = (id) => {
    assert.ok(nodes.has(id), `unexpected DOM lookup: ${id}`);
    return nodes.get(id);
  };
  const message = createTranslator({ ...messages, ...overrides });
  const format = (value) => Number(value || 0).toLocaleString("en-US");
  const common = { $, message, format,
    localizedTypeLabel: (type) => message(typeLabelKey(type)),
    localizedRarityLabel: (rarity) => message(rarityKey(rarity)) };
  const charts = [];
  const budgetMarkers = [];
  const collection = createCollectionView(common);
  const results = createResultsView({ ...common,
    unit: (key) => message(`unit.${key}`),
    localizedRefinementLabel: (refinement) => message(refinementKey(refinement)),
    localizedBudgetMarker: (value, cap) => {
      budgetMarkers.push([value, cap]);
      return `budget(${value}, ${cap})`;
    },
    renderBudgetDistribution: (...args) => charts.push(args)
  });
  $("goalLine").value = "0.9";
  $("strategy").value = "finish";
  return { $, collection, results, charts, budgetMarkers, message };
}

function collectionModel(patch = {}) {
  return {
    rotation: { id: "rotation-a", displayName: "Frame and Weapon Prime" }, previewMode: false,
    // Source order differs from the intended Warframes / weapons display order.
    primeItems: [
      { id: "weapon", name: "Weapon Prime", type: "primary", parts: [
        { id: "blueprint", name: "Blueprint", rarity: "common" },
        { id: "barrel", name: "Barrel", rarity: "rare", required: 2 }
      ] },
      { id: "frame", name: "Frame Prime", type: "warframe", parts: [
        { id: "systems", name: "Systems", rarity: "uncommon" }
      ] }
    ],
    selectedItemIds: ["weapon"], owned: { weapon: new Map([["blueprint", 1], ["barrel", 1]]) },
    relics: [
      { id: "lith-a1", name: "Lith A1", rewards: [{ itemId: "weapon", partId: "barrel", rarity: "rare" }] },
      { id: "neo-b2", name: "Neo B2", rewards: [{ itemId: "weapon", partId: "barrel", rarity: "uncommon" }] }
    ], activeSession: null, ...patch
  };
}

function resultModel(patch = {}) {
  return { mode: "budget", locale: "en", primeItems: [], selectedItemIds: [], relics: [], squad: 4, ...patch };
}

function result(patch = {}) {
  return {
    empty: false, finishProbability: 0.8, averageAya: 12.4, medianTraces: 30,
    p50: 8, p90: 15, p95: 20, p99: null, analysisCap: 60,
    summary: { itemCount: 2, completedItems: 1, remainingParts: 1, budget: 10 },
    timelines: { success: 800, failed: 200 }, itemProbabilities: [{ name: "Weapon Prime", probability: 0.8 }],
    recommendation: { totalAya: 10, items: [{ name: "Lith A1", count: 10, rewardCount: 2, itemCount: 1 }] },
    budgetCurve: [{ budget: 0, finishProbability: 0 }, { budget: 8, finishProbability: 0.5 }, { budget: 20, finishProbability: 0.95 }],
    ...patch
  };
}

const options = { budget: 10, analysisCap: 40 };
const tags = (html, tag) => [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>`, "g"))].map(([opening]) => opening);

test("collection views preserve grouped targets, selected items, partial quantities and CSP-safe progress", () => {
  const ui = harness();
  const model = collectionModel();
  ui.collection.renderRotation(model);
  ui.collection.renderItemOptions(model);
  ui.collection.renderCollections(model);
  assert.equal(ui.$("rotationName").textContent, model.rotation.displayName);
  assert.equal(ui.$("rotationIndex").textContent, "rotation-a");
  assert.equal(ui.$("targetRotationTitle").textContent, "Current Prime Resurgence");
  const featured = ui.$("rotationFeatured").innerHTML;
  assert.ok(featured.indexOf("Frame Prime") < featured.indexOf("Weapon Prime"));
  const choices = ui.$("targetOptions").innerHTML;
  const inputs = tags(choices, "input");
  assert.equal(inputs.length, 2);
  assert.doesNotMatch(inputs[0], /checked|disabled/);
  assert.match(inputs[1], /data-item-id="weapon" checked/);
  assert.match(choices, /target-option-progress">2 \/ 3</);
  assert.match(choices, /<strong>1 missing<\/strong>/); // Intentional trusted locale markup.
  assert.deepEqual(ui.$("targetOptions").meters.map(({ style }) => style.width), ["0%", "67%"]);
  assert.doesNotMatch(choices, /\sstyle=/);
  const owned = ui.$("collectionList").innerHTML;
  assert.match(owned, /data-part-id="blueprint" checked/);
  assert.doesNotMatch(tags(owned, "input").find((tag) => tag.includes('data-part-id="barrel"')), /checked/);
  assert.match(owned, />Barrel ×2<\/label>/);
  assert.match(owned, /<span>1 \/ 2<\/span>/);
  assert.equal(tags(owned, "button").filter((tag) => tag.includes("data-part-delta=")).length, 2);
  assert.ok(owned.indexOf("rarity-uncommon") < owned.indexOf("rarity-rare"));
  assert.match(owned, /Void Relic options: 2/);
  assert.equal(ui.$("targetCount").textContent, "1 targets · 2 / 3 owned");
});

test("collection views cap surplus ownership and lock every editing control during a session", () => {
  const ui = harness();
  const model = collectionModel({ activeSession: { id: "session-a" } });
  ui.collection.renderItemOptions(model);
  ui.collection.renderCollections(model);
  for (const html of [ui.$("targetOptions").innerHTML, ui.$("collectionList").innerHTML]) {
    for (const tag of [...tags(html, "input"), ...tags(html, "button")]) assert.match(tag, /\sdisabled(?:\s|>)/);
  }
  model.owned.weapon.set("barrel", 99);
  ui.collection.renderItemOptions(model);
  ui.collection.renderCollections(model);
  assert.deepEqual(ui.$("targetOptions").meters.map(({ style }) => style.width), ["0%", "100%"]);
  assert.match(ui.$("targetOptions").innerHTML, /<strong>Complete<\/strong>/);
  assert.match(ui.$("collectionList").innerHTML, /collection-card is-complete/);
  assert.doesNotMatch(ui.$("collectionList").innerHTML, /data-complete-item=/);
  assert.match(ui.$("collectionList").innerHTML, /<span>2 \/ 2<\/span>/);
  assert.equal(ui.$("targetCount").textContent, "1 targets · 3 / 3 owned");
});

test("collection views render preview titles and clear previous cards for empty data or selection", () => {
  const ui = harness();
  ui.collection.renderRotation(collectionModel({ previewMode: true }));
  assert.equal(ui.$("targetRotationTitle").textContent, "Preview Prime Resurgence");
  const empty = collectionModel({ rotation: null, primeItems: [], selectedItemIds: [] });
  ui.collection.renderRotation(empty);
  ui.collection.renderItemOptions(empty);
  ui.collection.renderCollections(empty);
  assert.match(ui.$("rotationFeatured").innerHTML, /rotation-empty/);
  assert.match(ui.$("targetOptions").innerHTML, /No target data is available\./);
  assert.match(ui.$("collectionList").innerHTML, /Select one or more Prime targets/);
  assert.deepEqual(ui.$("targetOptions").meters, []);
  assert.equal(ui.$("targetCount").textContent, "No targets selected");
});

test("collection catalog names and identifiers are escaped in text, data attributes and accessible labels", () => {
  const ui = harness();
  const payload = `<img src=x onerror="alert('x')">&`;
  const escaped = "&lt;img src=x onerror=&quot;alert(&#039;x&#039;)&quot;&gt;&amp;";
  const itemId = `item-${payload}`;
  const partId = `part-${payload}`;
  const model = collectionModel({
    rotation: { id: payload, displayName: payload },
    primeItems: [{ id: itemId, name: payload, type: "primary", parts: [{ id: partId, name: payload, required: 2, rarity: "rare" }] }],
    selectedItemIds: [itemId], owned: {}, relics: []
  });
  ui.collection.renderRotation(model);
  ui.collection.renderItemOptions(model);
  ui.collection.renderCollections(model);
  assert.equal(ui.$("rotationName").textContent, payload);
  assert.equal(ui.$("rotationIndex").textContent, payload);
  for (const id of ["rotationFeatured", "targetOptions", "collectionList"]) {
    assert.ok(ui.$(id).innerHTML.includes(escaped));
    assert.ok(!ui.$(id).innerHTML.includes(payload));
    assert.doesNotMatch(ui.$(id).innerHTML, /<img\b/);
  }
  const html = ui.$("collectionList").innerHTML;
  for (const attribute of [`data-item-id="item-${escaped}"`, `data-part-id="part-${escaped}"`,
    `data-complete-item="item-${escaped}"`, `id="owned-item-${escaped}-part-${escaped}"`,
    `for="owned-item-${escaped}-part-${escaped}"`, `aria-label="Decrease ${escaped} by one"`]) {
    assert.ok(html.includes(attribute), attribute);
  }
});

test("results view displays a completed run, routes the accepted result to the chart, and limits decorative tokens", () => {
  const ui = harness();
  const accepted = result();
  ui.results.renderResult(accepted, 1000, options, resultModel());
  assert.equal(ui.$("finishProbability").textContent, "80.00%");
  assert.equal(ui.$("probabilityBar").style.width, "80%");
  assert.equal(ui.$("meanAya").textContent, "13");
  assert.equal(ui.$("summaryCompleted").textContent, "1 / 2");
  assert.equal(ui.$("resultStatus").textContent, "Advantage");
  assert.match(ui.$("verdict").innerHTML, /10 Aya short of P95/);
  assert.match(ui.$("targetResultList").innerHTML, /80\.0% complete/);
  assert.equal(ui.$("recommendationAya").textContent, "10 Aya total");
  assert.equal(tags(ui.$("recommendationList").innerHTML, "i").length, 8);
  assert.match(ui.$("recommendationList").innerHTML, /× 10/);
  assert.match(ui.$("targetDeltaList").innerHTML, /\+5 Aya → P90/);
  assert.match(ui.$("targetDeltaList").innerHTML, /P99 exceeds the current analysis limit/);
  assert.equal(ui.charts.length, 1);
  assert.equal(ui.charts[0][0], accepted);
  assert.deepEqual(ui.charts[0].slice(1), [10, 60]);
  assert.equal(ui.$("sharePanel").hidden, false);
  assert.equal(ui.$("recapPanel").hidden, false);
});

test("zero observed completions use finite safety-line gaps without inventing capped thresholds", () => {
  const ui = harness();
  const zero = result({ finishProbability: 0, p50: 12, p90: null, p95: 20, analysisCap: undefined });
  ui.results.renderResult(zero, 1000, options, resultModel());
  assert.equal(ui.$("finishProbability").textContent, "0.00%");
  assert.equal(ui.$("probabilityBar").style.width, "0%");
  assert.equal(ui.$("resultStatus").textContent, "No completions observed");
  assert.match(ui.$("verdict").innerHTML, /2 Aya short of P50; 10 Aya short of P95/);
  assert.doesNotMatch(ui.$("verdict").innerHTML, /short of P90/);
  assert.equal(ui.$("timelineHeadline").textContent, "None of the 1,000 timelines completed all targets.");
  assert.deepEqual(ui.charts[0].slice(1), [10, 40]);
  ui.results.renderResult(result({ finishProbability: 0, p50: null, p90: null, p95: null }), 1000, options, resultModel());
  assert.match(ui.$("verdict").innerHTML, /No stable completion threshold/);
});

test("already-owned targets clear recommendation output and show completion without simulated spend", () => {
  const ui = harness();
  ui.results.renderResult(result(), 1000, options, resultModel());
  const completed = result({ empty: true, finishProbability: 1, averageAya: 0, p50: 0, p90: 0, p95: 0, p99: 0,
    summary: { itemCount: 1, completedItems: 1, remainingParts: 0, budget: 10 },
    itemProbabilities: [], recommendation: { items: [], totalAya: 0 } });
  ui.results.renderResult(completed, 1000, options, resultModel());
  assert.equal(ui.$("trialBadge").textContent, "Complete");
  assert.equal(ui.$("finishProbability").textContent, "100.00%");
  assert.equal(ui.$("meanAya").textContent, "0");
  assert.equal(ui.$("runCaption").textContent, ui.message("run.completed"));
  assert.equal(ui.$("timelineSuccess").textContent, "100%");
  assert.match(ui.$("verdict").innerHTML, /Save the Aya for the next rotation/);
  assert.match(ui.$("breakdownBody").innerHTML, /No missing parts\./);
  assert.match(ui.$("targetResultList").innerHTML, /Choose targets to see each Prime/);
  assert.equal(ui.$("recommendationAya").textContent, "No recommendation");
  assert.doesNotMatch(ui.$("recommendationList").innerHTML, /recommendation-row/);
  assert.equal((ui.$("targetDeltaList").innerHTML.match(/is-reached/g) || []).length, 3);
});

test("goal display passes a missing percentile and the analysis cap to the budget formatter", () => {
  const ui = harness();
  ui.$("goalLine").value = "0.99";
  ui.results.renderResult(result(), 1000, options, resultModel({ mode: "goal" }));
  assert.deepEqual(ui.budgetMarkers[0], [null, 40]);
  assert.equal(ui.$("finishProbability").textContent, "budget(null, 40)");
  assert.equal(ui.$("primaryResultLabel").textContent, "Aya needed for a 99% chance");
  assert.equal(ui.$("finishDetail").textContent, "Current analysis limit: budget(40, null)");
});

test("results escape catalog names in breakdowns, per-item probabilities and relic recommendations", () => {
  const ui = harness();
  const payload = `<img src=x onerror="alert('x')">&`;
  const escaped = "&lt;img src=x onerror=&quot;alert(&#039;x&#039;)&quot;&gt;&amp;";
  const model = resultModel({
    selectedItemIds: ["weapon", "frame"],
    primeItems: [{ id: "weapon", name: payload, parts: [{ id: "barrel", name: payload, required: 2, ownedCount: 0, rarity: "rare" }] }],
    relics: [{ name: payload, rewards: [{ itemId: "weapon", partId: "barrel", rarity: "rare" }] }]
  });
  const accepted = result({ itemProbabilities: [{ name: payload, probability: 0.0001 }],
    recommendation: { totalAya: 1, items: [{ name: payload, count: 1, rewardCount: 1, itemCount: 1 }] } });
  ui.results.renderResult(accepted, 1000, options, model);
  for (const id of ["breakdownBody", "targetResultList", "recommendationList"]) {
    const html = ui.$(id).innerHTML;
    assert.ok(html.includes(escaped));
    assert.ok(!html.includes(payload));
    assert.doesNotMatch(html, /<img\b/);
  }
  assert.ok(ui.$("breakdownBody").innerHTML.includes(`${escaped} · ${escaped} ×2`));
  assert.ok(ui.$("breakdownBody").innerHTML.includes(`<small class="table-route">${escaped}</small>`));
  assert.match(ui.$("targetResultList").innerHTML, /&lt;0\.1% complete/);
});

test("verdict label and body retain their existing text escaping at the rendering boundary", () => {
  const ui = harness({ "verdict.lucky": '<b>Label & "quote"</b>', "verdict.luckyMessage": "<em>Body</em>" });
  ui.results.renderResult(result({ finishProbability: 0.96 }), 1000, options, resultModel());
  assert.equal(ui.$("resultStatus").textContent, '<b>Label & "quote"</b>');
  assert.match(ui.$("verdict").innerHTML, /&lt;b&gt;Label &amp; &quot;quote&quot;&lt;\/b&gt;/);
  assert.match(ui.$("verdict").innerHTML, /&lt;em&gt;Body&lt;\/em&gt;/);
  assert.doesNotMatch(ui.$("verdict").innerHTML, /<b>|<em>/);
});

test("recap uses the accepted discrete curve and observed input, refusing interpolation or missing results", () => {
  const ui = harness();
  assert.equal(ui.results.renderGraduationRecap(null), null);
  assert.equal(ui.$("observedAya").disabled, true);
  const accepted = result();
  assert.equal(ui.results.renderGraduationRecap(accepted), null);
  assert.equal(ui.$("observedAya").disabled, false);
  ui.$("observedAya").value = " 8 ";
  assert.deepEqual(ui.results.renderGraduationRecap(accepted), {
    status: "ok", observedAya: 8, percentile: 0.5, faceBlackIndex: 50, beatPercentage: 50, band: "middle"
  });
  assert.match(ui.$("recapResult").innerHTML, /Middle pack/);
  assert.match(ui.$("recapResult").innerHTML, /Aya spend percentile 50\.0/);
  ui.$("observedAya").value = "9";
  assert.equal(ui.results.renderGraduationRecap(accepted).status, "outside");
  assert.match(ui.$("recapResult").innerHTML, /Outside the current analysis range/);
  assert.doesNotMatch(ui.$("recapResult").innerHTML, /Middle pack/);
  ui.$("observedAya").value = "0";
  assert.equal(ui.results.renderGraduationRecap(accepted).band, "lucky");
  assert.match(ui.$("recapResult").innerHTML, /You used only 0 Aya/);
  ui.$("observedAya").value = "";
  assert.equal(ui.results.renderGraduationRecap(accepted), null);
  assert.equal(ui.$("recapResult").textContent, ui.message("recap.waiting"));
  assert.equal(ui.charts.length, 0);
});
