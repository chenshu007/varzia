import test from "node:test";
import assert from "node:assert/strict";
import {
  RARITIES,
  REFINEMENTS,
  buildPartRelicIndex,
  rankRelicsForMissing,
  simulateCurrentRotation,
  simulateRotationTrial,
  squadChance
} from "../js/simulator.js";
import { formatBudgetLine, formatBudgetMarker, formatProbability, zeroProbabilityGuidance } from "../js/presentation.js";

function primeItem(id, type = "warframe", parts = [{ id: "piece", name: "部件", required: 1 }]) {
  return { id, name: id, type, parts };
}

function relic(id, rewards) {
  return { id, name: id, costAya: 1, rewards };
}

test("光辉遗物与四人同遗物概率保持正确", () => {
  assert.equal(RARITIES.rare.rates.radiant, 0.1);
  assert.equal(REFINEMENTS.radiant.traces, 100);
  assert.ok(Math.abs(squadChance(0.1, 4) - 0.3439) < 1e-12);
});

test("战甲与武器进入同一次整期联合模拟", () => {
  const primeItems = [
    primeItem("frame", "warframe"),
    primeItem("weapon", "primary")
  ];
  const relics = [
    relic("frame-relic", [{ itemId: "frame", partId: "piece", rarity: "common" }]),
    relic("weapon-relic", [{ itemId: "weapon", partId: "piece", rarity: "common" }])
  ];
  const result = simulateCurrentRotation({ primeItems, relics, budget: 2, squad: 1, strategy: "intact", trials: 2000, analysisCap: 24 });
  assert.equal(result.summary.itemCount, 2);
  assert.equal(result.itemProbabilities.length, 2);
  assert.deepEqual(new Set(result.itemProbabilities.map((item) => item.id)), new Set(["frame", "weapon"]));
  assert.ok(result.finishProbability > 0);
  assert.ok(result.finishProbability <= Math.min(...result.itemProbabilities.map((item) => item.probability)));
});

test("覆盖战甲和武器的共享遗物获得更高选择价值且一次只消耗一个 Aya", () => {
  const primeItems = [primeItem("frame", "warframe"), primeItem("weapon", "melee")];
  const relics = [
    relic("shared", [
      { itemId: "frame", partId: "piece", rarity: "common" },
      { itemId: "weapon", partId: "piece", rarity: "common" }
    ]),
    relic("frame-only", [{ itemId: "frame", partId: "piece", rarity: "common" }]),
    relic("weapon-only", [{ itemId: "weapon", partId: "piece", rarity: "common" }])
  ];
  const ranking = rankRelicsForMissing({ primeItems, relics, squad: 1, strategy: "intact" });
  assert.equal(ranking[0].id, "shared");
  assert.equal(ranking[0].coverage, 2);

  const trial = simulateRotationTrial({ primeItems, relics, budget: 1, squad: 1, strategy: "intact", random: () => 0 });
  assert.equal(trial.usedAya, 1);
  assert.equal(trial.runs, 1);
  assert.equal(trial.purchasedRelics.shared, 1);
});

test("四人同遗物同时出现两个缺件时最终只领取一个奖励", () => {
  const primeItems = [primeItem("frame", "warframe"), primeItem("weapon", "secondary")];
  const relics = [relic("shared", [
    { itemId: "frame", partId: "piece", rarity: "rare" },
    { itemId: "weapon", partId: "piece", rarity: "uncommon" }
  ])];
  const rolls = [0.05, 0.15, 0.99, 0.99];
  const trial = simulateRotationTrial({
    primeItems,
    relics,
    budget: 1,
    squad: 4,
    strategy: "radiant",
    random: () => rolls.shift() ?? 0.99
  });
  assert.equal(trial.claimedRewards, 1);
  assert.equal(Object.values(trial.collectedParts).reduce((sum, count) => sum + count, 0), 1);
  assert.equal(trial.remainingPartCount, 1);
  assert.equal(trial.finished, false);
  assert.equal(trial.collectedParts["frame:piece"], 1, "毕业优先先领取稀有件");
});

test("武器已完成后不再消耗预算，模拟只追踪未完成战甲", () => {
  const primeItems = [
    primeItem("frame", "warframe"),
    primeItem("weapon", "primary", [{ id: "piece", name: "部件", required: 1, ownedCount: 1 }])
  ];
  const relics = [
    relic("frame-relic", [{ itemId: "frame", partId: "piece", rarity: "common" }]),
    relic("weapon-relic", [{ itemId: "weapon", partId: "piece", rarity: "common" }])
  ];
  const trial = simulateRotationTrial({ primeItems, relics, budget: 1, squad: 1, strategy: "intact", random: () => 0 });
  assert.equal(trial.finished, true);
  assert.deepEqual(trial.purchasedRelics, { "frame-relic": 1 });
});

test("战甲已完成后继续模拟直到武器完成", () => {
  const primeItems = [
    primeItem("frame", "warframe", [{ id: "piece", name: "部件", required: 1, ownedCount: 1 }]),
    primeItem("weapon", "melee")
  ];
  const relics = [
    relic("frame-relic", [{ itemId: "frame", partId: "piece", rarity: "common" }]),
    relic("weapon-relic", [{ itemId: "weapon", partId: "piece", rarity: "common" }])
  ];
  const trial = simulateRotationTrial({ primeItems, relics, budget: 1, squad: 1, strategy: "intact", random: () => 0 });
  assert.equal(trial.finished, true);
  assert.deepEqual(trial.purchasedRelics, { "weapon-relic": 1 });
});

test("全部装备已经完成时整期概率为 100% 且额外 Aya 为 0", () => {
  const primeItems = [
    primeItem("frame", "warframe", [{ id: "piece", name: "部件", required: 1, ownedCount: 1 }]),
    primeItem("weapon", "secondary", [{ id: "piece", name: "部件", required: 1, ownedCount: 1 }])
  ];
  const result = simulateCurrentRotation({ primeItems, relics: [], budget: 0, trials: 1000 });
  assert.equal(result.empty, true);
  assert.equal(result.finishProbability, 1);
  assert.equal(result.averageAya, 0);
  assert.equal(result.p50, 0);
  assert.equal(result.p99, 0);
  assert.equal(result.summary.completedItems, 2);
});

test("预算不足时整期联合毕业概率为 0，不会给每件装备重复分配同一 Aya", () => {
  const primeItems = [primeItem("frame", "warframe"), primeItem("weapon", "primary")];
  const relics = [
    relic("frame-relic", [{ itemId: "frame", partId: "piece", rarity: "common" }]),
    relic("weapon-relic", [{ itemId: "weapon", partId: "piece", rarity: "common" }])
  ];
  const result = simulateCurrentRotation({ primeItems, relics, budget: 1, squad: 4, strategy: "intact", trials: 1000, analysisCap: 24 });
  assert.equal(result.finishProbability, 0);
  assert.ok(result.p50 > 1);
  assert.ok(result.itemProbabilities.some((item) => item.probability > 0));
  const guidance = zeroProbabilityGuidance({ budget: 1, trials: 1000, p50: result.p50, p90: result.p90, p95: result.p95 });
  assert.equal(guidance.status, "尚未进入毕业区间");
  assert.match(guidance.sentence, /没有一条完成本期全部目标/);
  assert.match(guidance.message, /距 P50 还差.*个阿耶精华/);
});

test("预算线超出分析范围时明确显示上限", () => {
  assert.equal(formatBudgetLine(42, 80), "42 个");
  assert.equal(formatBudgetLine(null, 80), "超过分析上限（80 个）");
  assert.equal(formatBudgetMarker(null, 80), ">80 个");
});

test("同一部件支持多个有效遗物，优化器会比较所有路线", () => {
  const primeItems = [primeItem("weapon", "primary")];
  const relics = [
    relic("rare-route", [{ itemId: "weapon", partId: "piece", rarity: "rare" }]),
    relic("common-route", [{ itemId: "weapon", partId: "piece", rarity: "common" }])
  ];
  const index = buildPartRelicIndex(relics);
  assert.deepEqual(index["weapon:piece"], ["rare-route", "common-route"]);
  const ranking = rankRelicsForMissing({ primeItems, relics, squad: 4, strategy: "finish" });
  assert.deepEqual(new Set(ranking.map((entry) => entry.id)), new Set(["rare-route", "common-route"]));
  assert.equal(ranking[0].id, "common-route");
});

test("需要两份的武器部件会真实消耗两次掉落", () => {
  const primeItems = [primeItem("weapon", "secondary", [{ id: "barrel", name: "枪管", required: 2 }])];
  const relics = [relic("barrel-relic", [{ itemId: "weapon", partId: "barrel", rarity: "common" }])];
  const oneAya = simulateRotationTrial({ primeItems, relics, budget: 1, squad: 1, strategy: "intact", random: () => 0 });
  const twoAya = simulateRotationTrial({ primeItems, relics, budget: 2, squad: 1, strategy: "intact", random: () => 0 });
  assert.equal(oneAya.finished, false);
  assert.equal(oneAya.remainingPartCount, 1);
  assert.equal(twoAya.finished, true);
  assert.equal(twoAya.collectedParts["weapon:barrel"], 2);
  const miss = simulateRotationTrial({ primeItems, relics, budget: 1, squad: 1, strategy: "intact", random: () => 0.3 });
  assert.equal(miss.collectedParts["weapon:barrel"] || 0, 0, "required=2 不会把单次奖励概率翻倍");
});

test("极低非零概率不会显示为 0.0%", () => {
  assert.equal(formatProbability(0), "0%");
  assert.equal(formatProbability(0.0004), "<0.1%");
  assert.equal(formatProbability(0.004), "0.40%");
  assert.equal(formatProbability(0.1234), "12.3%");
});

test("预算曲线使用与主联合模拟相同的样本量", () => {
  const primeItems = [primeItem("weapon", "primary")];
  const relics = [relic("weapon-relic", [{ itemId: "weapon", partId: "piece", rarity: "common" }])];
  const result = simulateCurrentRotation({ primeItems, relics, budget: 2, squad: 1, strategy: "intact", trials: 5000, analysisCap: 24 });
  assert.deepEqual(result.trialCounts, { main: 5000, curve: 5000 });
});
