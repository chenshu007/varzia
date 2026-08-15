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

function budgetGap(line, budget) {
  return Number.isFinite(line) ? Math.max(0, line - budget) : null;
}

export function zeroProbabilityGuidance({ budget, trials, p50, p90, p95 }) {
  const gaps = [
    ["P50", budgetGap(p50, budget)],
    ["P90", budgetGap(p90, budget)],
    ["P95", budgetGap(p95, budget)]
  ].filter(([, gap]) => gap !== null).map(([label, gap]) => `距 ${label} 还差 ${formatNumber(gap)} 个`);

  return {
    status: "尚未进入毕业区间",
    sentence: `当前 ${formatNumber(budget)} 个阿耶精华在 ${formatNumber(trials)} 条模拟时间线中没有完成本期全部目标。`,
    message: gaps.length ? `${gaps.join("；")}。` : "当前搜索范围内尚未找到稳定的毕业预算线。",
    tail: "当前预算更适合优先完成部分 Prime"
  };
}
