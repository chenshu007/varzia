function formatNumber(value) {
  return Number(value || 0).toLocaleString("zh-CN");
}

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

export function probabilityDescriptor(probability) {
  const value = Math.max(0, Math.min(1, Number(probability) || 0));
  if (value >= 0.99) return "几乎稳稳毕业";
  if (value >= 0.95) return "极稳毕业区间";
  if (value >= 0.90) return "大概率能毕业";
  if (value >= 0.75) return "明显占优";
  if (value >= 0.55) return "五五开以上";
  if (value >= 0.45) return "接近五五开";
  if (value >= 0.25) return "仍有不小风险";
  if (value > 0) return "小概率毕业";
  return "尚未进入毕业区间";
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

function budgetGap(line, budget) {
  return Number.isFinite(line) ? Math.max(0, line - budget) : null;
}

export function formatBudgetMarker(value, analysisCap) {
  if (Number.isFinite(value)) return `${formatNumber(value)} 个`;
  if (Number.isFinite(analysisCap)) return `>${formatNumber(analysisCap)} 个`;
  return "—";
}

export function zeroProbabilityGuidance({ budget, trials, p50, p90, p95 }) {
  const gaps = [
    ["P50", budgetGap(p50, budget)],
    ["P90", budgetGap(p90, budget)],
    ["P95", budgetGap(p95, budget)]
  ].filter(([, gap]) => gap !== null).map(([label, gap]) => `距 ${label} 还差 ${formatNumber(gap)} 个阿耶精华`);

  return {
    status: "尚未进入毕业区间",
    sentence: `阿耶精华预算为 ${formatNumber(budget)} 时，${formatNumber(trials)} 条模拟时间线里没有一条完成本期全部目标。`,
    message: gaps.length ? `${gaps.join("；")}。` : "当前搜索范围内尚未找到稳定的毕业预算线。",
    tail: "当前预算更适合优先完成部分 Prime"
  };
}
