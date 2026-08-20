const PERCENTILE_KEYS = Object.freeze([
  ["p90", "P90"],
  ["p95", "P95"],
  ["p99", "P99"]
]);

function finiteInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.floor(number) : null;
}

function clampProbability(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

export function calculatePercentileDeltas({ currentBudget = 0, percentiles = {} } = {}) {
  const current = Math.max(0, finiteInteger(currentBudget) ?? 0);
  return PERCENTILE_KEYS.map(([key, label]) => {
    const rawLine = percentiles?.[key];
    const line = rawLine !== null && rawLine !== undefined && Number.isFinite(Number(rawLine))
      ? Math.floor(Number(rawLine))
      : null;
    if (line === null) return { key, label, budget: null, delta: null, status: "capped" };
    const delta = line - current;
    return {
      key,
      label,
      budget: line,
      delta: Math.max(0, delta),
      status: delta > 0 ? "remaining" : "reached"
    };
  });
}

export function findBudgetCurvePoint(curve, observedAya) {
  const budget = finiteInteger(observedAya);
  if (budget === null || budget < 0 || !Array.isArray(curve) || !curve.length) return null;
  return curve.find((point) => point?.budget === budget) || null;
}

export function graduationBand(percentile) {
  const value = clampProbability(percentile) * 100;
  if (value < 10) return "lucky";
  if (value < 40) return "smooth";
  if (value < 60) return "middle";
  if (value < 85) return "pressure";
  if (value < 95) return "red";
  if (value < 99) return "backRow";
  return "tailEnd";
}

export function calculateGraduationRecap({ curve, observedAya } = {}) {
  const normalizedAya = finiteInteger(observedAya);
  const point = findBudgetCurvePoint(curve, normalizedAya);
  if (!point) {
    return {
      status: "outside",
      observedAya: normalizedAya,
      percentile: null,
      faceBlackIndex: null,
      beatPercentage: null,
      band: null
    };
  }

  const percentile = clampProbability(point.finishProbability);
  return {
    status: "ok",
    observedAya: normalizedAya,
    percentile,
    faceBlackIndex: percentile * 100,
    beatPercentage: (1 - percentile) * 100,
    band: graduationBand(percentile)
  };
}

export function formatRecapPercent(value) {
  if (!Number.isFinite(Number(value))) return "—";
  return Number(value).toFixed(1);
}

export { PERCENTILE_KEYS };
