import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MAX_SIMULATION_BUDGET,
  RARITIES,
  REFINEMENTS,
  buildBudgetCurve,
  buildPartRelicIndex,
  rankRelicsForMissing,
  simulateCurrentRotation,
  simulateRotationTrial,
  squadChance,
  validateSimulationBudget
} from "../js/simulator.js";
import { createTranslator } from "../js/i18n.js";
import {
  assertValidBudgetCurve,
  formatBudgetMarker,
  formatProbability,
  formatProbabilityPrecise,
  zeroProbabilityGuidance
} from "../js/presentation.js";

const enMessages = JSON.parse(readFileSync(new URL("../data/locales/en.json", import.meta.url), "utf8"));
const zhMessages = JSON.parse(readFileSync(new URL("../data/locales/zh-cn.json", import.meta.url), "utf8"));

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
  assert.equal(result.budgetCurve[0].finishProbability, 1);
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
  assert.equal(formatBudgetMarker(42, 80), "42 个");
  assert.equal(formatBudgetMarker(null, 80), ">80 个");
});

test("160 Aya 仍可运行，161 Aya 在进入 Worker 前被拒绝且保留原值", () => {
  const primeItems = [primeItem("weapon", "primary")];
  const relics = [relic("weapon-relic", [{ itemId: "weapon", partId: "piece", rarity: "common" }])];
  const supported = validateSimulationBudget(160);
  const rejected = validateSimulationBudget(161);
  assert.equal(MAX_SIMULATION_BUDGET, 160);
  assert.deepEqual(supported, { valid: true, budget: 160 });
  assert.deepEqual(rejected, { valid: false, budget: 161 });

  const result = simulateCurrentRotation({
    primeItems,
    relics,
    budget: supported.budget,
    squad: 1,
    strategy: "intact",
    trials: 1000,
    analysisCap: 120
  });
  assert.equal(result.summary.budget, 160);
  assert.equal(result.analysisCap, 160);
  assert.equal(result.budgetCurve.at(-1).budget, 160);
  assert.equal(result.finishProbability, result.budgetCurve[160].finishProbability);

  const en = createTranslator(enMessages, enMessages);
  const zh = createTranslator(zhMessages, zhMessages);
  assert.equal(en("budget.outOfRange", { max: MAX_SIMULATION_BUDGET }), "Enter 160 Aya or less to run this simulation.");
  assert.equal(zh("budget.outOfRange", { max: MAX_SIMULATION_BUDGET }), "请输入不超过 160 个的阿耶精华预算，才能运行本次模拟。");
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
  assert.equal(formatProbabilityPrecise(0.5908), "59.08%");
});

test("预算曲线与主结果使用同一批样本", () => {
  const primeItems = [primeItem("weapon", "primary")];
  const relics = [relic("weapon-relic", [{ itemId: "weapon", partId: "piece", rarity: "common" }])];
  const result = simulateCurrentRotation({ primeItems, relics, budget: 2, squad: 1, strategy: "intact", trials: 5000, analysisCap: 24 });
  assert.deepEqual(result.trialCounts, { shared: 5000 });
  assert.equal(result.budgetCurve[2].finishProbability, result.finishProbability);
});

test("CDF 节点严格递增、概率单调不减且始终位于有效范围", () => {
  const primeItems = [primeItem("weapon", "primary")];
  const relics = [relic("weapon-relic", [{ itemId: "weapon", partId: "piece", rarity: "rare" }])];
  const result = simulateCurrentRotation({ primeItems, relics, budget: 12, squad: 4, strategy: "radiant", trials: 4000, analysisCap: 40 });
  assert.equal(assertValidBudgetCurve(result.budgetCurve), true);
  for (let index = 1; index < result.budgetCurve.length; index += 1) {
    assert.ok(result.budgetCurve[index].budget > result.budgetCurve[index - 1].budget);
    assert.ok(result.budgetCurve[index].finishProbability >= result.budgetCurve[index - 1].finishProbability);
    assert.ok(result.budgetCurve[index].finishProbability >= 0 && result.budgetCurve[index].finishProbability <= 1);
  }
});

test("P50、P90、P95、P99 都是 CDF 首次达到阈值的预算", () => {
  const primeItems = [primeItem("weapon", "primary")];
  const relics = [relic("weapon-relic", [{ itemId: "weapon", partId: "piece", rarity: "rare" }])];
  const result = simulateCurrentRotation({ primeItems, relics, budget: 10, squad: 4, strategy: "radiant", trials: 5000, analysisCap: 40 });
  for (const [field, threshold] of [["p50", 0.50], ["p90", 0.90], ["p95", 0.95], ["p99", 0.99]]) {
    const expected = result.budgetCurve.find((point) => point.finishProbability >= threshold)?.budget ?? null;
    assert.equal(result[field], expected);
  }
});

test("零预算节点与主结果保持完全一致", () => {
  const primeItems = [primeItem("weapon", "primary")];
  const relics = [relic("weapon-relic", [{ itemId: "weapon", partId: "piece", rarity: "common" }])];
  const result = simulateCurrentRotation({ primeItems, relics, budget: 0, squad: 4, strategy: "intact", trials: 2000, analysisCap: 24 });
  assert.equal(result.finishProbability, 0);
  assert.equal(result.budgetCurve[0].finishProbability, result.finishProbability);
});

test("P99 超出分析上限时保留 null 而不伪造预算", () => {
  const primeItems = [primeItem("weapon", "primary")];
  const relics = [relic("weapon-relic", [{ itemId: "weapon", partId: "piece", rarity: "rare" }])];
  const result = simulateCurrentRotation({ primeItems, relics, budget: 0, squad: 1, strategy: "intact", trials: 3000, analysisCap: 24 });
  assert.equal(result.analysisCap, 24);
  assert.equal(result.p99, null);
  assert.ok(result.budgetCurve.at(-1).finishProbability < 0.99);
});

test("同样输入的 CDF、百分位和当前概率完全确定", () => {
  const options = {
    primeItems: [primeItem("weapon", "primary")],
    relics: [relic("weapon-relic", [{ itemId: "weapon", partId: "piece", rarity: "uncommon" }])],
    budget: 7,
    squad: 3,
    strategy: "finish",
    trials: 3000,
    analysisCap: 30
  };
  const first = simulateCurrentRotation(options);
  const second = simulateCurrentRotation(options);
  assert.equal(first.finishProbability, second.finishProbability);
  assert.deepEqual(first.budgetCurve, second.budgetCurve);
  assert.deepEqual([first.p50, first.p90, first.p95, first.p99], [second.p50, second.p90, second.p95, second.p99]);
});

test("同一分析范围内改变当前预算不会生成第二套 CDF", () => {
  const base = {
    primeItems: [primeItem("weapon", "primary")],
    relics: [relic("weapon-relic", [{ itemId: "weapon", partId: "piece", rarity: "rare" }])],
    squad: 4,
    strategy: "radiant",
    trials: 2000,
    analysisCap: 40
  };
  const lowerBudget = simulateCurrentRotation({ ...base, budget: 8 });
  const higherBudget = simulateCurrentRotation({ ...base, budget: 16 });
  assert.deepEqual(lowerBudget.budgetCurve, higherBudget.budgetCurve);
  assert.equal(lowerBudget.finishProbability, lowerBudget.budgetCurve[8].finishProbability);
  assert.equal(higherBudget.finishProbability, higherBudget.budgetCurve[16].finishProbability);
});

test("CDF 聚合直接由真实完成成本计数累加", () => {
  assert.deepEqual(buildBudgetCurve(Uint32Array.from([0, 1, 2, 1]), 4), [
    { budget: 0, finishProbability: 0 },
    { budget: 1, finishProbability: 0.25 },
    { budget: 2, finishProbability: 0.75 },
    { budget: 3, finishProbability: 1 }
  ]);
});

test("presentation 层拒绝乱序、下降或越界的预算曲线", () => {
  assert.throws(() => assertValidBudgetCurve([{ budget: 1, finishProbability: 0.5 }, { budget: 1, finishProbability: 0.6 }]), /严格递增/);
  assert.throws(() => assertValidBudgetCurve([{ budget: 0, finishProbability: 0.7 }, { budget: 1, finishProbability: 0.6 }]), /单调不减/);
  assert.throws(() => assertValidBudgetCurve([{ budget: 0, finishProbability: 1.1 }]), /0 到 1/);
});

test("非一 Aya 遗物不会被错误套用单批 CDF 等价", () => {
  const primeItems = [primeItem("weapon", "primary")];
  const expensiveRelic = { ...relic("weapon-relic", [{ itemId: "weapon", partId: "piece", rarity: "common" }]), costAya: 2 };
  assert.throws(
    () => simulateCurrentRotation({ primeItems, relics: [expensiveRelic], budget: 2, trials: 1000, analysisCap: 24 }),
    /恰好消耗 1 个阿耶精华/
  );
});
