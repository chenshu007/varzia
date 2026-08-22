export const RARITIES = {
  common: { label: "常见", rank: 1, rates: { intact: 0.2533, exceptional: 0.2333, flawless: 0.20, radiant: 0.1667 } },
  uncommon: { label: "罕见", rank: 2, rates: { intact: 0.11, exceptional: 0.13, flawless: 0.17, radiant: 0.20 } },
  rare: { label: "稀有", rank: 3, rates: { intact: 0.02, exceptional: 0.04, flawless: 0.06, radiant: 0.10 } }
};

export const REFINEMENTS = {
  intact: { label: "完整", traces: 0 },
  exceptional: { label: "优良", traces: 25 },
  flawless: { label: "无暇", traces: 50 },
  radiant: { label: "光辉", traces: 100 }
};

export const MAX_SIMULATION_BUDGET = 160;

export function validateSimulationBudget(value) {
  const budget = Number(value);
  return {
    valid: Number.isFinite(budget) && budget >= 0 && budget <= MAX_SIMULATION_BUDGET,
    budget
  };
}

const STRATEGY_NOTES = {
  finish: "毕业优先（启发式）：每次根据整期剩余缺件重新选择遗物；有稀有或罕见目标时使用光辉，只有常见目标时保持完整。",
  efficient: "节省虚空光体：稀有用光辉、罕见用无暇、常见用完整；遗物仍按整期剩余缺件动态选择。",
  intact: "全部完整：不消耗虚空光体，但稀有奖励会明显拉长整期毕业时间。",
  radiant: "全部光辉：每枚遗物消耗 100 个虚空光体，所有目标共享同一份阿耶精华预算。"
};

const TYPE_LABELS = {
  warframe: "战甲",
  primary: "主要武器",
  secondary: "次要武器",
  melee: "近战武器",
  companion: "伙伴",
  other: "其他"
};

export function strategyNote(strategy) {
  return STRATEGY_NOTES[strategy] || STRATEGY_NOTES.finish;
}

export function typeLabel(type) {
  return TYPE_LABELS[type] || TYPE_LABELS.other;
}

export function refinementFor(rarity, strategy) {
  if (strategy === "intact") return "intact";
  if (strategy === "radiant") return "radiant";
  if (strategy === "efficient") {
    if (rarity === "common") return "intact";
    if (rarity === "uncommon") return "flawless";
    return "radiant";
  }
  if (rarity === "common") return "intact";
  return "radiant";
}

export function squadChance(singleChance, squadSize) {
  return 1 - Math.pow(1 - singleChance, squadSize);
}

export function primePartKey(itemId, partId) {
  return `${itemId}:${partId}`;
}

function safeTrials(value, fallback = 20000, minimum = 1000) {
  return Math.max(minimum, Math.min(100000, Number(value) || fallback));
}

function safeSquad(value) {
  return Math.max(1, Math.min(4, Number(value) || 1));
}

function safeBudget(value) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

function requiredCount(part) {
  return Math.max(1, Math.floor(Number(part.required || part.quantity || 1)));
}

function startingOwnedCount(part, required) {
  if (Number.isFinite(Number(part.ownedCount))) {
    return Math.max(0, Math.min(required, Math.floor(Number(part.ownedCount))));
  }
  return part.owned ? required : 0;
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q));
  return sorted[index];
}

function hashText(value) {
  let hash = 2166136261;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildPartRelicIndex(relics) {
  const index = {};
  for (const relic of relics || []) {
    const seenInRelic = new Set();
    for (const reward of relic.rewards || []) {
      if (!reward.itemId || !reward.partId) continue;
      const key = primePartKey(reward.itemId, reward.partId);
      if (seenInRelic.has(key)) continue;
      seenInRelic.add(key);
      if (!index[key]) index[key] = [];
      index[key].push(relic.id);
    }
  }
  return index;
}

function createSimulationModel(primeItems, relics) {
  const parts = [];
  const partIndexByKey = new Map();
  const items = (primeItems || []).map((item, itemIndex) => {
    const partIndices = (item.parts || []).map((part) => {
      const required = requiredCount(part);
      const owned = startingOwnedCount(part, required);
      const index = parts.length;
      const key = primePartKey(item.id, part.id);
      parts.push({
        index,
        key,
        itemIndex,
        itemId: item.id,
        itemName: item.name,
        partId: part.id,
        partName: part.name,
        required,
        owned
      });
      partIndexByKey.set(key, index);
      return index;
    });
    return { ...item, itemIndex, partIndices };
  });

  const normalizedRelics = (relics || []).map((relic, relicIndex) => ({
    ...relic,
    relicIndex,
    costAya: Math.max(1, Math.floor(Number(relic.costAya || 1))),
    rewards: (relic.rewards || []).map((reward) => ({
      ...reward,
      partIndex: partIndexByKey.get(primePartKey(reward.itemId, reward.partId))
    })).filter((reward) => Number.isInteger(reward.partIndex) && RARITIES[reward.rarity])
  })).filter((relic) => relic.rewards.length);

  const routeCounts = new Uint16Array(parts.length);
  for (const relic of normalizedRelics) {
    const seen = new Set();
    for (const reward of relic.rewards) {
      if (seen.has(reward.partIndex)) continue;
      seen.add(reward.partIndex);
      routeCounts[reward.partIndex] += 1;
    }
  }

  const initialOwned = Uint16Array.from(parts.map((part) => part.owned));
  const initialRemaining = Uint16Array.from(parts.map((part) => part.required - part.owned));
  const initialItemRemaining = Uint16Array.from(items.map((item) => (
    item.partIndices.reduce((sum, partIndex) => sum + initialRemaining[partIndex], 0)
  )));
  const initialRemainingTotal = initialRemaining.reduce((sum, count) => sum + count, 0);
  const initialCompletedItems = initialItemRemaining.reduce((sum, count) => sum + (count === 0 ? 1 : 0), 0);

  return {
    primeItems: items,
    parts,
    relics: normalizedRelics,
    routeCounts,
    initialOwned,
    initialRemaining,
    initialItemRemaining,
    initialRemainingTotal,
    initialCompletedItems
  };
}

function refinementForRelic(relic, remainingParts, strategy) {
  let highestRank = 0;
  for (const reward of relic.rewards) {
    if (!remainingParts[reward.partIndex]) continue;
    highestRank = Math.max(highestRank, RARITIES[reward.rarity].rank);
  }
  const rarity = highestRank === 3 ? "rare" : highestRank === 2 ? "uncommon" : "common";
  return refinementFor(rarity, strategy);
}

function drawReward(relic, refinement, random) {
  let roll = random();
  for (const reward of relic.rewards) {
    const chance = RARITIES[reward.rarity]?.rates[refinement] || 0;
    if (roll < chance) return reward;
    roll -= chance;
  }
  return null;
}

function rewardPriority(reward, model, itemRemaining) {
  const rarityRank = RARITIES[reward.rarity]?.rank || 0;
  const alternatives = Math.max(1, model.routeCounts[reward.partIndex]);
  const part = model.parts[reward.partIndex];
  const completesItem = itemRemaining[part.itemIndex] === 1 ? 1 : 0;
  return { rarityRank, alternatives, completesItem, key: part.key };
}

export function chooseBestReward(offeredRewards, remainingParts, itemRemaining, model) {
  let best = null;
  let bestPriority = null;
  for (const reward of offeredRewards) {
    if (!reward || !remainingParts[reward.partIndex]) continue;
    const priority = rewardPriority(reward, model, itemRemaining);
    if (!bestPriority
      || priority.rarityRank > bestPriority.rarityRank
      || (priority.rarityRank === bestPriority.rarityRank && priority.alternatives < bestPriority.alternatives)
      || (priority.rarityRank === bestPriority.rarityRank && priority.alternatives === bestPriority.alternatives && priority.completesItem > bestPriority.completesItem)
      || (priority.rarityRank === bestPriority.rarityRank && priority.alternatives === bestPriority.alternatives && priority.completesItem === bestPriority.completesItem && priority.key < bestPriority.key)) {
      best = reward;
      bestPriority = priority;
    }
  }
  return best;
}

function scoreRelic(relic, model, remainingParts, itemRemaining, squad, strategy) {
  const refinement = refinementForRelic(relic, remainingParts, strategy);
  let coverage = 0;
  let itemCoverage = 0;
  let itemMask = 0;
  let overflowItems = null;
  let expectedProgress = 0;

  for (const reward of relic.rewards) {
    if (!remainingParts[reward.partIndex]) continue;
    const part = model.parts[reward.partIndex];
    const singleChance = RARITIES[reward.rarity].rates[refinement];
    const hitChance = squadChance(singleChance, squad);
    const alternatives = Math.max(1, model.routeCounts[reward.partIndex]);
    const scarcity = 1 + (1 / alternatives);
    const finishBonus = itemRemaining[part.itemIndex] === 1 ? 1.35 : 1;
    const duplicatePressure = 1 + Math.min(0.25, (remainingParts[reward.partIndex] - 1) * 0.08);
    expectedProgress += hitChance * scarcity * finishBonus * duplicatePressure;
    coverage += 1;
    if (part.itemIndex < 31) {
      const itemBit = 1 << part.itemIndex;
      if (!(itemMask & itemBit)) {
        itemMask |= itemBit;
        itemCoverage += 1;
      }
    } else {
      // A Prime Resurgence rotation is far smaller than 31 items in practice.
      // Keep future oversized datasets valid without slowing the normal path.
      overflowItems ||= new Set();
      if (!overflowItems.has(part.itemIndex)) {
        overflowItems.add(part.itemIndex);
        itemCoverage += 1;
      }
    }
  }

  if (!coverage) {
    return { score: -Infinity, coverage: 0, itemCoverage: 0, refinement };
  }
  const coverageBonus = coverage * 0.08;
  const itemCoverageBonus = itemCoverage * 0.05;
  return {
    score: (expectedProgress + coverageBonus + itemCoverageBonus) / relic.costAya,
    coverage,
    itemCoverage,
    refinement
  };
}

function rankRelicsForState(model, remainingParts, itemRemaining, squad, strategy, availableAya = Infinity) {
  return model.relics
    .filter((relic) => relic.costAya <= availableAya)
    .map((relic) => ({ relic, ...scoreRelic(relic, model, remainingParts, itemRemaining, squad, strategy) }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => right.score - left.score || left.relic.id.localeCompare(right.relic.id));
}

function bestRelicForState(model, remainingParts, itemRemaining, squad, strategy, availableAya) {
  let best = null;
  for (const relic of model.relics) {
    if (relic.costAya > availableAya) continue;
    const scored = scoreRelic(relic, model, remainingParts, itemRemaining, squad, strategy);
    if (!Number.isFinite(scored.score)) continue;
    if (!best
      || scored.score > best.score
      || (scored.score === best.score && relic.id < best.relic.id)) {
      best = { relic, ...scored };
    }
  }
  return best;
}

export function rankRelicsForMissing({ primeItems, relics, squad = 4, strategy = "finish", availableAya = Infinity }) {
  const model = createSimulationModel(primeItems, relics);
  return rankRelicsForState(
    model,
    Uint16Array.from(model.initialRemaining),
    Uint16Array.from(model.initialItemRemaining),
    safeSquad(squad),
    strategy,
    safeBudget(availableAya)
  ).map(({ relic, score, coverage, itemCoverage, refinement }) => ({
    id: relic.id,
    name: relic.name,
    score,
    coverage,
    itemCoverage,
    refinement
  }));
}

function trialSnapshot({
  finished,
  itemRemaining,
  purchasedRelics,
  remainingPartCount,
  usedAya,
  voidTraces
}) {
  return {
    finished,
    itemRemaining: Uint16Array.from(itemRemaining),
    purchasedRelics: Uint16Array.from(purchasedRelics),
    remainingPartCount,
    usedAya,
    voidTraces
  };
}

function runRotationTrial(model, { budget, squad, strategy, random, snapshotBudget = null }) {
  const ownedParts = Uint16Array.from(model.initialOwned);
  const remainingParts = Uint16Array.from(model.initialRemaining);
  const itemRemaining = Uint16Array.from(model.initialItemRemaining);
  const remainingTargets = new Set(model.parts.filter((part) => remainingParts[part.index] > 0).map((part) => part.index));
  const relicInventory = new Uint16Array(model.relics.length);
  const purchasedRelics = new Uint16Array(model.relics.length);
  const collectedParts = new Uint16Array(model.parts.length);
  let availableAya = safeBudget(budget);
  let remainingPartCount = model.initialRemainingTotal;
  let voidTraces = 0;
  let runs = 0;
  let claimedRewards = 0;
  const requestedSnapshotBudget = Number.isFinite(snapshotBudget) ? safeBudget(snapshotBudget) : null;
  let budgetSnapshot = requestedSnapshotBudget === 0
    ? trialSnapshot({
      finished: remainingPartCount === 0,
      itemRemaining,
      purchasedRelics,
      remainingPartCount,
      usedAya: 0,
      voidTraces
    })
    : null;

  while (availableAya > 0 && remainingPartCount > 0) {
    const choice = bestRelicForState(model, remainingParts, itemRemaining, squad, strategy, availableAya);
    if (!choice) break;

    const relic = choice.relic;
    availableAya -= relic.costAya;
    relicInventory[relic.relicIndex] += 1;
    purchasedRelics[relic.relicIndex] += 1;

    const refinement = choice.refinement;
    voidTraces += REFINEMENTS[refinement].traces;
    const offeredRewards = [];
    for (let player = 0; player < squad; player += 1) {
      offeredRewards.push(drawReward(relic, refinement, random));
    }

    // A fissure run offers several squad rewards, but the player may claim one.
    const selectedReward = chooseBestReward(offeredRewards, remainingParts, itemRemaining, model);
    if (selectedReward) {
      const partIndex = selectedReward.partIndex;
      const itemIndex = model.parts[partIndex].itemIndex;
      ownedParts[partIndex] += 1;
      collectedParts[partIndex] += 1;
      remainingParts[partIndex] -= 1;
      itemRemaining[itemIndex] -= 1;
      remainingPartCount -= 1;
      claimedRewards += 1;
      if (remainingParts[partIndex] === 0) remainingTargets.delete(partIndex);
    }

    relicInventory[relic.relicIndex] -= 1;
    runs += 1;

    const usedAya = safeBudget(budget) - availableAya;
    if (!budgetSnapshot && requestedSnapshotBudget !== null && usedAya >= requestedSnapshotBudget) {
      budgetSnapshot = trialSnapshot({
        finished: remainingPartCount === 0,
        itemRemaining,
        purchasedRelics,
        remainingPartCount,
        usedAya,
        voidTraces
      });
    }
  }

  const completedItems = Uint8Array.from(itemRemaining, (count) => count === 0 ? 1 : 0);
  if (!budgetSnapshot && requestedSnapshotBudget !== null) {
    budgetSnapshot = trialSnapshot({
      finished: remainingPartCount === 0,
      itemRemaining,
      purchasedRelics,
      remainingPartCount,
      usedAya: safeBudget(budget) - availableAya,
      voidTraces
    });
  }
  return {
    finished: remainingPartCount === 0,
    ownedParts,
    remainingTargets,
    availableAya,
    relicInventory,
    voidTraces,
    purchasedRelics,
    collectedParts,
    completedItems,
    itemRemaining,
    remainingPartCount,
    usedAya: safeBudget(budget) - availableAya,
    runs,
    claimedRewards,
    budgetSnapshot
  };
}

export function simulateRotationTrial({ primeItems, relics, budget = 0, squad = 4, strategy = "finish", seed = 1, random }) {
  const model = createSimulationModel(primeItems, relics);
  const safeSquadSize = safeSquad(squad);
  const randomSource = typeof random === "function"
    ? random
    : seededRandom(hashText({ seed, budget: safeBudget(budget), squad: safeSquadSize, strategy }));
  const trial = runRotationTrial(model, {
    budget: safeBudget(budget),
    squad: safeSquadSize,
    strategy,
    random: randomSource
  });
  return {
    ...trial,
    purchasedRelics: Object.fromEntries(model.relics.map((relic) => [relic.id, trial.purchasedRelics[relic.relicIndex]]).filter(([, count]) => count > 0)),
    collectedParts: Object.fromEntries(model.parts.map((part) => [part.key, trial.collectedParts[part.index]]).filter(([, count]) => count > 0)),
    completedItemIds: model.primeItems.filter((item) => trial.completedItems[item.itemIndex]).map((item) => item.id)
  };
}

export function buildBudgetCurve(finishCounts, trialCount) {
  let completedByBudget = 0;
  const points = [];
  for (let lineBudget = 0; lineBudget < finishCounts.length; lineBudget += 1) {
    completedByBudget += finishCounts[lineBudget];
    points.push({ budget: lineBudget, finishProbability: completedByBudget / trialCount });
  }
  return points;
}

function simulateBudgetDistribution(model, { budget, cap, squad, strategy, trials }) {
  const trialCount = safeTrials(trials, 100000);
  const finishCounts = new Uint32Array(cap + 1);
  const completedCounts = new Uint32Array(model.primeItems.length);
  const purchaseTotals = new Float64Array(model.relics.length);
  const ayaSamples = new Uint16Array(trialCount);
  const traceSamples = new Uint32Array(trialCount);
  const random = seededRandom(hashText({
    seed: "curve",
    cap,
    squad,
    strategy,
    parts: model.initialRemainingTotal
  }));
  let finishedTrials = 0;
  let collectedTotal = 0;

  // Prime Resurgence relics all cost exactly one Aya. The optimizer therefore
  // sees the same available choices at every step until the wallet reaches 0.
  // One cap-length timeline is consequently both the exact completion-cost
  // sample for the CDF and the exact current-budget timeline prefix.
  if (model.relics.some((relic) => relic.costAya !== 1)) {
    throw new Error("预算分布要求每枚 Prime 重生遗物恰好消耗 1 个阿耶精华");
  }

  for (let trialIndex = 0; trialIndex < trialCount; trialIndex += 1) {
    const trial = runRotationTrial(model, {
      budget: cap,
      snapshotBudget: budget,
      squad,
      strategy,
      random
    });
    const snapshot = trial.budgetSnapshot;
    if (snapshot.finished) finishedTrials += 1;
    for (let itemIndex = 0; itemIndex < snapshot.itemRemaining.length; itemIndex += 1) {
      completedCounts[itemIndex] += snapshot.itemRemaining[itemIndex] === 0 ? 1 : 0;
    }
    for (let relicIndex = 0; relicIndex < snapshot.purchasedRelics.length; relicIndex += 1) {
      purchaseTotals[relicIndex] += snapshot.purchasedRelics[relicIndex];
    }
    ayaSamples[trialIndex] = snapshot.usedAya;
    traceSamples[trialIndex] = snapshot.voidTraces;
    collectedTotal += model.initialRemainingTotal - snapshot.remainingPartCount;
    if (trial.finished && trial.usedAya <= cap) finishCounts[trial.usedAya] += 1;
  }

  const budgetCurve = buildBudgetCurve(finishCounts, trialCount);
  const currentCurvePoint = budgetCurve[budget];
  if (!currentCurvePoint || currentCurvePoint.finishProbability !== finishedTrials / trialCount) {
    throw new Error("当前预算毕业概率与预算分布不一致");
  }

  const sortedTraces = Array.from(traceSamples).sort((left, right) => left - right);
  return {
    finishProbability: finishedTrials / trialCount,
    itemProbabilities: model.primeItems.map((item) => ({
      id: item.id,
      name: item.name,
      type: item.type,
      probability: completedCounts[item.itemIndex] / trialCount
    })),
    averageAya: average(Array.from(ayaSamples)),
    medianTraces: quantile(sortedTraces, 0.5),
    averageCollected: collectedTotal / trialCount,
    purchaseAverages: model.relics.map((relic) => ({ id: relic.id, average: purchaseTotals[relic.relicIndex] / trialCount })),
    budgetCurve,
    timelines: {
      total: trialCount,
      success: finishedTrials,
      failed: trialCount - finishedTrials
    }
  };
}

function budgetAtProbability(curve, probability) {
  return curve.find((entry) => entry.finishProbability >= probability)?.budget ?? null;
}

function representativeRecommendation(model, purchaseAverages, budget) {
  const raw = purchaseAverages
    .map((entry) => ({ ...entry, relic: model.relics.find((relic) => relic.id === entry.id) }))
    .filter((entry) => entry.relic && entry.average > 0.001);
  const desiredTotal = Math.min(safeBudget(budget), Math.max(0, Math.round(raw.reduce((sum, entry) => sum + entry.average, 0))));
  const counts = raw.map((entry) => ({ ...entry, count: Math.floor(entry.average), fraction: entry.average % 1 }));
  let assigned = counts.reduce((sum, entry) => sum + entry.count, 0);
  counts.sort((left, right) => right.fraction - left.fraction || right.average - left.average || left.id.localeCompare(right.id));
  for (const entry of counts) {
    if (assigned >= desiredTotal) break;
    entry.count += 1;
    assigned += 1;
  }

  const items = counts.filter((entry) => entry.count > 0).map((entry) => {
    const partIndices = new Set();
    const itemIndices = new Set();
    for (const reward of entry.relic.rewards) {
      if (!model.initialRemaining[reward.partIndex]) continue;
      partIndices.add(reward.partIndex);
      itemIndices.add(model.parts[reward.partIndex].itemIndex);
    }
    return {
      id: entry.id,
      name: entry.relic.name,
      count: entry.count,
      averageCount: entry.average,
      rewardCount: partIndices.size,
      itemCount: itemIndices.size
    };
  }).sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, "zh-CN"));

  return {
    plan: Object.fromEntries(items.map((item) => [item.id, item.count])),
    totalAya: items.reduce((sum, item) => sum + item.count, 0),
    adaptive: true,
    items
  };
}

/**
 * Jointly simulate every selected Prime item in the current rotation.
 * Each trial owns one shared Aya budget and adaptively chooses the next relic
 * after every claimed reward. Per-item probabilities are observations from the
 * same trials; the joint finish rate is never derived by multiplying them.
 */
export function simulateCurrentRotation({
  primeItems,
  relics,
  budget = 24,
  squad = 4,
  strategy = "finish",
  trials = 100000,
  analysisCap = 80
}) {
  const model = createSimulationModel(primeItems, relics);
  const safeBudgetValue = safeBudget(budget);
  const safeSquadSize = safeSquad(squad);
  const safeTrialCount = safeTrials(trials, 100000);
  const summary = {
    itemCount: model.primeItems.length,
    completedItems: model.initialCompletedItems,
    remainingParts: model.initialRemainingTotal,
    budget: safeBudgetValue
  };
  const cap = Math.max(24, Math.min(MAX_SIMULATION_BUDGET, Math.max(safeBudgetValue, Number(analysisCap) || 80)));

  if (!model.initialRemainingTotal) {
    const budgetCurve = Array.from({ length: cap + 1 }, (_, curveBudget) => ({
      budget: curveBudget,
      finishProbability: 1
    }));
    return {
      empty: true,
      finishProbability: 1,
      averageAya: 0,
      p50: 0,
      p90: 0,
      p95: 0,
      p99: 0,
      medianTraces: 0,
      averageCollected: 0,
      itemProbabilities: model.primeItems.map((item) => ({ id: item.id, name: item.name, type: item.type, probability: 1 })),
      recommendation: { plan: {}, totalAya: 0, adaptive: true, items: [] },
      budgetCurve,
      analysisCap: cap,
      timelines: { total: safeTrialCount, success: safeTrialCount, failed: 0 },
      trialCounts: { shared: safeTrialCount },
      summary
    };
  }

  const distribution = simulateBudgetDistribution(model, {
    budget: safeBudgetValue,
    cap,
    squad: safeSquadSize,
    strategy,
    trials: safeTrialCount
  });

  return {
    empty: false,
    finishProbability: distribution.finishProbability,
    averageAya: distribution.averageAya,
    medianTraces: distribution.medianTraces,
    averageCollected: distribution.averageCollected,
    p50: budgetAtProbability(distribution.budgetCurve, 0.50),
    p90: budgetAtProbability(distribution.budgetCurve, 0.90),
    p95: budgetAtProbability(distribution.budgetCurve, 0.95),
    p99: budgetAtProbability(distribution.budgetCurve, 0.99),
    itemProbabilities: distribution.itemProbabilities,
    recommendation: representativeRecommendation(model, distribution.purchaseAverages, safeBudgetValue),
    budgetCurve: distribution.budgetCurve,
    analysisCap: cap,
    timelines: distribution.timelines,
    trialCounts: { shared: safeTrialCount },
    summary
  };
}
