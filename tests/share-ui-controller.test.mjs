import test from "node:test";
import assert from "node:assert/strict";
import { createShareUiController } from "../js/share-ui-controller.js";
import { decodePlan } from "../js/plan-share.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(overrides = {}) {
  const items = [{ id: "nova-prime", parts: [{ id: "blueprint", required: 1, ownedCount: 0 }] }];
  const state = {
    shareReady: true, resultsUpdating: false, running: false,
    rotation: { id: "rotation-a", publicationStatus: "published", items: ["nova-prime"] },
    locale: "en", mode: "budget", goal: "0.95", lastTrials: 5000, currentRecap: null,
    lastResult: { finishProbability: 0.5, p50: 20, p90: 40, p95: 60, p99: 80, summary: { itemCount: 1 } },
    lastResultOptions: { budget: 20, squad: 4, strategy: "finish", trials: 5000, primeItems: items }
  };
  const elements = new Map();
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, { hidden: true, disabled: false, textContent: "", value: "",
      focus() { this.focused = true; }, select() { this.selected = true; } });
    return elements.get(id);
  };
  const created = [];
  const revoked = [];
  const copied = [];
  const shared = [];
  const qrUrls = [];
  const warnings = [];
  const browser = {
    location: { origin: "https://varzia.example" },
    navigator: { clipboard: { async writeText(value) { copied.push(value); } }, async share(value) { shared.push(value); } },
    URL: {
      createObjectURL(blob) { created.push(blob); return `blob:card-${created.length}`; },
      revokeObjectURL(url) { revoked.push(url); }
    },
    File: class { constructor(parts, name, options) { Object.assign(this, { parts, name, ...options }); } },
    console: { warn(...args) { warnings.push(args); } }
  };
  const controller = createShareUiController({
    getSnapshot: () => ({ ...state }), $, message: (key) => key, browser,
    loadQr: async () => ({ renderPlanQr(url) { qrUrls.push(url); return "<g/>"; } }),
    toPng: async (svg) => ({ svg }),
    ...overrides
  });
  return { controller, state, $, browser, items, created, revoked, copied, shared, qrUrls, warnings };
}

test("share cards use completed results and replace or clear their Blob URL", async () => {
  const h = harness();
  await h.controller.generateShareCard();
  assert.equal(h.controller.hasCard, true);
  assert.equal(h.$("sharePreview").hidden, false);
  assert.equal(h.$("shareDownloadLink").href, "blob:card-1");
  assert.equal(h.$("shareDownloadLink").download, "varzia-en-rotation-a-result.png");
  assert.equal(h.$("shareResultButton").disabled, false);
  assert.match(h.created[0].svg, /VARZIA/);
  await h.controller.generateShareCard();
  assert.deepEqual(h.revoked, ["blob:card-1"]);
  assert.equal(h.$("sharePreviewImage").src, "blob:card-2");
  h.controller.clearCard();
  h.controller.clearCard();
  assert.equal(h.controller.hasCard, false);
  assert.deepEqual(h.revoked, ["blob:card-1", "blob:card-2"]);
});

test("an older card generation cannot overwrite a newer completed generation", async () => {
  const pending = [deferred(), deferred()];
  let index = 0;
  const h = harness({ toPng: () => pending[index++].promise });
  const first = h.controller.generateShareCard();
  const second = h.controller.generateShareCard();
  await Promise.resolve();
  pending[1].resolve({ card: "new" });
  await second;
  pending[0].resolve({ card: "old" });
  await first;
  assert.deepEqual(h.created, [{ card: "new" }]);
  assert.equal(h.$("shareStatus").textContent, "share.success");
  assert.equal(h.$("shareResultButton").disabled, false);
});

test("invalidated or stale in-flight cards never allocate a Blob URL or restore old UI", async (t) => {
  for (const change of [
    (h) => h.controller.invalidate(),
    (h) => { h.state.lastResult = { ...h.state.lastResult }; },
    (h) => { h.state.resultsUpdating = true; },
    (h) => { h.state.running = true; }
  ]) {
    await t.test(change.toString(), async () => {
      const pending = deferred();
      const h = harness({ toPng: () => pending.promise });
      const generation = h.controller.generateShareCard();
      await Promise.resolve();
      change(h);
      h.$("shareStatus").textContent = "updated by caller";
      pending.resolve({ card: "old" });
      await generation;
      assert.deepEqual(h.created, []);
      assert.equal(h.controller.hasCard, false);
      assert.equal(h.$("shareStatus").textContent, "updated by caller");
    });
  }
});

test("plan links and generated QR follow current completed options and locale", async () => {
  const h = harness();
  const firstUrl = h.controller.currentShareUrl();
  const first = decodePlan(new URL(firstUrl).hash, { rotations: [h.state.rotation], primeItems: h.items });
  assert.equal(first.status, "ok");
  assert.equal(first.plan.budget, 20);
  h.state.locale = "zh";
  h.state.mode = "goal";
  h.state.goal = "0.9";
  h.state.lastResultOptions = { ...h.state.lastResultOptions, budget: 40 };
  const secondUrl = h.controller.currentShareUrl();
  assert.equal(new URL(secondUrl).pathname, "/zh/");
  const second = decodePlan(new URL(secondUrl).hash, { rotations: [h.state.rotation], primeItems: h.items });
  assert.equal(second.plan.budget, 40);
  assert.equal(second.plan.goal, "0.9");
  await h.controller.generateShareCard();
  await h.controller.shareGeneratedCard();
  assert.deepEqual(h.qrUrls, [secondUrl]);
  assert.equal(h.shared[0].url, secondUrl);
  assert.equal(h.shared[0].files[0].name, "varzia-zh-rotation-a-result.png");
  assert.equal(h.shared[0].files[0].parts[0], h.created[0]);
});

test("unpublished or updating results cannot generate or copy a plan", async (t) => {
  for (const changes of [
    { shareReady: false }, { lastResult: null }, { resultsUpdating: true }, { running: true },
    { rotation: { id: "candidate", publicationStatus: "candidate" } }
  ]) {
    await t.test(JSON.stringify(changes), async () => {
      const h = harness();
      Object.assign(h.state, changes);
      assert.equal(h.controller.currentShareUrl(), null);
      await h.controller.copyPlanLink();
      await h.controller.generateShareCard();
      assert.deepEqual(h.copied, []);
      assert.deepEqual(h.created, []);
      assert.equal(h.$("shareStatus").textContent, "share.needsResult");
    });
  }
});

test("clipboard success and unavailable clipboard preserve the visible link fallback", async () => {
  const h = harness();
  await h.controller.copyPlanLink();
  assert.deepEqual(h.copied, [h.controller.currentShareUrl()]);
  assert.equal(h.$("shareLinkFallback").hidden, false);
  assert.equal(h.$("shareStatus").textContent, "share.linkCopied");
  delete h.browser.navigator.clipboard;
  await h.controller.copyPlanLink();
  assert.equal(h.$("sharePlanLink").value, h.controller.currentShareUrl());
  assert.equal(h.$("sharePlanLink").focused, true);
  assert.equal(h.$("sharePlanLink").selected, true);
  assert.equal(h.$("shareStatus").textContent, "share.copyManually");
});

test("invalidation suppresses delayed clipboard and system-share status updates", async () => {
  const h = harness();
  const clipboard = deferred();
  h.browser.navigator.clipboard.writeText = () => clipboard.promise;
  const copy = h.controller.copyPlanLink();
  h.controller.invalidate();
  h.$("shareStatus").textContent = "updated by caller";
  clipboard.reject(new Error("unavailable"));
  await copy;
  assert.equal(h.$("shareStatus").textContent, "updated by caller");
  assert.equal(h.$("sharePlanLink").focused, undefined);

  await h.controller.generateShareCard();
  const share = deferred();
  h.browser.navigator.share = () => share.promise;
  const sharing = h.controller.shareGeneratedCard();
  h.controller.invalidate();
  h.$("shareStatus").textContent = "new result";
  share.reject(new Error("unavailable"));
  await sharing;
  assert.equal(h.$("shareStatus").textContent, "new result");
});

test("card generation failures and system share fallbacks retain existing UI behavior", async () => {
  const failed = harness({ toPng: async () => { throw new Error("canvas unavailable"); } });
  await failed.controller.generateShareCard();
  assert.equal(failed.$("shareStatus").textContent, "share.failed");
  assert.equal(failed.$("shareResultButton").disabled, false);
  assert.equal(failed.warnings.length, 1);
  assert.equal(failed.controller.hasCard, false);

  const h = harness();
  h.browser.navigator.canShare = () => false;
  await h.controller.generateShareCard();
  await h.controller.shareGeneratedCard();
  assert.equal(Object.hasOwn(h.shared[0], "files"), false);
  h.browser.navigator.share = async () => { throw Object.assign(new Error("canceled"), { name: "AbortError" }); };
  await h.controller.shareGeneratedCard();
  assert.equal(h.$("shareStatus").textContent, "share.canceled");
  delete h.browser.navigator.share;
  await h.controller.generateShareCard();
  assert.equal(h.$("shareSystemButton").hidden, true);
});
