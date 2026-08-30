export function formatProbability(probability) {
  const value = Math.max(0, Math.min(1, Number(probability) || 0));
  if (value === 0) return "0%";
  const percent = value * 100;
  if (percent < 0.1) return "<0.1%";
  if (percent < 1) return `${percent.toFixed(2)}%`;
  return `${percent.toFixed(1)}%`;
}

export function formatProbabilityPrecise(probability) {
  const value = Math.max(0, Math.min(1, Number(probability) || 0));
  return `${(value * 100).toFixed(2)}%`;
}

export function assertValidBudgetCurve(curve) {
  if (!Array.isArray(curve) || !curve.length) {
    throw new TypeError("预算分布必须包含至少一个真实数据点");
  }
  let previousBudget = -Infinity;
  let previousProbability = -Infinity;
  for (const point of curve) {
    if (!Number.isFinite(point?.budget) || point.budget <= previousBudget) {
      throw new TypeError("预算分布的 Aya 节点必须严格递增");
    }
    if (!Number.isFinite(point.finishProbability) || point.finishProbability < 0 || point.finishProbability > 1) {
      throw new RangeError("预算分布概率必须位于 0 到 1 之间");
    }
    if (point.finishProbability < previousProbability) {
      throw new RangeError("预算分布概率必须单调不减");
    }
    previousBudget = point.budget;
    previousProbability = point.finishProbability;
  }
  return true;
}
