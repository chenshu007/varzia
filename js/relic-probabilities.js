export const RELIC_RARITIES = Object.freeze({
  common: Object.freeze({ label: "常见", rank: 1, rates: Object.freeze({ intact: 0.2533, exceptional: 0.2333, flawless: 0.20, radiant: 0.1667 }) }),
  uncommon: Object.freeze({ label: "罕见", rank: 2, rates: Object.freeze({ intact: 0.11, exceptional: 0.13, flawless: 0.17, radiant: 0.20 }) }),
  rare: Object.freeze({ label: "稀有", rank: 3, rates: Object.freeze({ intact: 0.02, exceptional: 0.04, flawless: 0.06, radiant: 0.10 }) })
});

export const RELIC_REFINEMENTS = Object.freeze({
  intact: Object.freeze({ label: "完整", traces: 0 }),
  exceptional: Object.freeze({ label: "优良", traces: 25 }),
  flawless: Object.freeze({ label: "无暇", traces: 50 }),
  radiant: Object.freeze({ label: "光辉", traces: 100 })
});

// A real relic has three common, two uncommon, and one rare reward slots.
// VARZIA stores only in-rotation targets; any remaining probability is implicit.
export const RELIC_RARITY_SLOTS = Object.freeze({ common: 3, uncommon: 2, rare: 1 });
