// Pair-specific Public Export groups can support prelaunch preparation.
// Keep this evidence distinct from an observed, priced sale inventory.
export function vaultGroupsFor(primeWarframes) {
  const names = primeWarframes.map(name => name.replace(/ Prime$/, "").replaceAll(" ", ""));
  if (names.length !== 2 || names.some(name => !/^[A-Za-z0-9]+$/.test(name))) throw new Error("Unsupported Vault group names.");
  return [`${names[0]}${names[1]}Vault`, `${names[1]}${names[0]}Vault`];
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

export function lineupFromVaultExport(candidate, official, dropRelics) {
  const groups = vaultGroupsFor(candidate.primeWarframes);
  const selected = official.relicExport.flatMap(record => {
    const match = /^\/Lotus\/Types\/Game\/Projections\/T([1-4])VoidProjection([A-Za-z0-9]+Vault)([A-Z]+)Bronze$/.exec(record.uniqueName);
    return match && groups.includes(match[2]) ? [{ record, group: match[2], era: ["Lith", "Meso", "Neo", "Axi"][Number(match[1]) - 1] }] : [];
  });
  if (!selected.length) return null;
  requireValue(new Set(selected.map(entry => entry.group)).size === 1, "Ambiguous pair-specific Vault export groups; human review is required.");
  requireValue(new Set(selected.map(entry => entry.record.uniqueName)).size === selected.length, "Duplicate pair-specific Vault relic ID.");
  const relics = [];
  const itemNames = new Set();
  for (const { record, era } of selected) {
    requireValue(new RegExp(`^${era} [A-Z]\\d+ Relic$`).test(record.name), "Invalid pair-specific Vault relic name or era.");
    requireValue(Array.isArray(record.relicRewards) && record.relicRewards.length === 6
      && JSON.stringify(record.relicRewards.map(reward => reward.rarity).sort()) === JSON.stringify(["COMMON", "COMMON", "COMMON", "RARE", "UNCOMMON", "UNCOMMON"]), "Invalid pair-specific Vault reward slots.");
    const name = record.name.replace(/ Relic$/, "");
    const matches = dropRelics.filter(relic => relic.name === name);
    requireValue(matches.length === 1, `Pair-specific relic is missing or duplicated in official Drop Tables: ${name}.`);
    for (const reward of matches[0].rewards) {
      if (/^(?:[1-9]\d*X )?Forma Blueprint$/.test(reward.name)) continue;
      const match = /^(.+ Prime) .+$/.exec(reward.name);
      requireValue(match, `Unknown pair-specific Vault reward: ${reward.name}.`);
      itemNames.add(match[1]);
    }
    relics.push({ itemType: record.uniqueName.replace(/^\/Lotus\//, "/Lotus/StoreItems/"), name, costAya: 1 });
  }
  requireValue(new Set(relics.map(relic => relic.name)).size === relics.length, "Duplicate pair-specific Vault relic name.");
  const types = { Suits: "warframe", LongGuns: "primary", Pistols: "secondary", Melee: "melee", Sentinels: "companion" };
  const items = [...itemNames].sort().map(name => {
    const matches = official.equipmentEn.filter(item => item.name === name && types[item.productCategory]);
    requireValue(matches.length === 1, `Missing or ambiguous pair-specific equipment export: ${name}.`);
    const item = matches[0];
    const localized = official.equipmentZh.filter(entry => entry.uniqueName === item.uniqueName);
    requireValue(localized.length === 1 && localized[0].name, `Missing or ambiguous pair-specific Chinese equipment: ${name}.`);
    return { name, chineseName: localized[0].name, type: types[item.productCategory], uniqueName: item.uniqueName };
  });
  const warframes = items.filter(item => item.type === "warframe");
  requireValue(JSON.stringify(warframes.map(item => item.name).sort()) === JSON.stringify([...candidate.primeWarframes].sort()), "Pair-specific Vault rewards disagree with the announced Warframes.");
  return {
    items, warframes, startsAt: candidate.effectiveAt, inventoryRelics: relics,
    previewEvidence: {
      type: "digital-extremes-public-export-vault-group",
      url: official.exportUrls.RelicArcane_en,
      group: selected[0].group,
      startsAt: candidate.effectiveAt,
      rawPrimeWarframes: [...candidate.primeWarframes],
      relics,
      exportUrls: official.exportUrls,
      selectionBasis: "announced-pair-specific-vault-group",
      priceBasis: "planner-preset"
    }
  };
}
