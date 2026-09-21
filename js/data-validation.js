import { candidateIdFor, normalizeOfficialTimestamp } from "./prime-resurgence-candidate.js";
import { RELIC_RARITIES, RELIC_RARITY_SLOTS } from "./relic-probabilities.js";

const VALID_RARITIES = new Set(Object.keys(RELIC_RARITIES));
const VALID_PUBLICATION_STATUSES = new Set(["published", "provisional"]);
const VALID_CANDIDATE_STATUSES = new Set(["announced", "official-data-available", "validated", "ready-for-review", "conflict"]);
const VALID_CANDIDATE_RELIC_STATUSES = new Set(["pending", "available", "validated", "conflict"]);
const SUPPORTED_ROTATION_SCHEMA = 2;
const SUPPORTED_ANNOUNCEMENT_CANDIDATE_SCHEMA = 1;
const ISO_UTC_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const ISO_CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_REQUIRED_QUANTITY = 65_535;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function requireUnique(values, label) {
  const seen = new Set();
  for (const value of values) {
    requireValue(!seen.has(value), `${label}: ${value}`);
    seen.add(value);
  }
}

function validateTargetRewardComposition(relic) {
  const counts = { common: 0, uncommon: 0, rare: 0 };
  for (const reward of relic.rewards || []) {
    requireValue(VALID_RARITIES.has(reward?.rarity), `Invalid reward rarity: ${relic.id}`);
    counts[reward.rarity] += 1;
  }
  for (const [rarity, slots] of Object.entries(RELIC_RARITY_SLOTS)) {
    requireValue(counts[rarity] <= slots, `Too many ${rarity} target rewards: ${relic.id}`);
  }
  for (const refinement of Object.keys(RELIC_RARITIES.common.rates)) {
    const probabilityMass = Object.entries(counts).reduce((sum, [rarity, count]) => sum + count * RELIC_RARITIES[rarity].rates[refinement], 0);
    requireValue(probabilityMass <= 1 + 1e-9, `Target reward probability exceeds 100% at ${refinement}: ${relic.id}`);
  }
}

function requireProvisionalSource(source, label, { recipe = false } = {}) {
  requireValue(source?.status === "provisional", `Missing provisional source status: ${label}`);
  const fields = ["rotationUrl", "announcementUrl", "dropTableUrl", ...(recipe ? ["recipeExportUrl"] : [])];
  for (const field of fields) {
    requireValue(Object.prototype.hasOwnProperty.call(source, field), `Missing provisional source field: ${label} / ${field}`);
    requireValue(source[field] === null || (typeof source[field] === "string" && source[field].length > 0), `Invalid provisional source field: ${label} / ${field}`);
  }
  if (source.inventory !== undefined) requireInventoryEvidence(source.inventory, label);
  if (source.vaultExport !== undefined) requireVaultExportEvidence(source.vaultExport, label);
  if (source.recipeExceptions !== undefined) {
    requireValue(Array.isArray(source.recipeExceptions), `Invalid recipeExceptions: ${label}`);
    requireUnique(source.recipeExceptions.map((exception) => exception?.itemId), `Duplicate recipe exception: ${label}`);
    for (const exception of source.recipeExceptions) {
      requireValue(exception?.status === "curated-manual", `Invalid recipe exception status: ${label} / ${exception?.itemId ?? "missing"}`);
      requireValue(exception?.sourceUrl === null, `Curated recipe exception sourceUrl must be null: ${label} / ${exception?.itemId ?? "missing"}`);
      requireValue(exception?.publicExportStatus === "missing", `Invalid Public Export exception status: ${label} / ${exception?.itemId ?? "missing"}`);
      requireValue(typeof exception?.publicExportCheckedUrl === "string" && exception.publicExportCheckedUrl.startsWith("https://content.warframe.com/PublicExport/Manifest/ExportRecipes_en.json!"), `Invalid Public Export exception URL: ${label} / ${exception?.itemId ?? "missing"}`);
    }
  }
  if (source.rarityWarnings !== undefined) {
    requireValue(Array.isArray(source.rarityWarnings) && source.rarityWarnings.every((warning) => typeof warning === "string" && warning.length > 0), `Invalid rarityWarnings: ${label}`);
  }
}

function isExactUtcTimestamp(value) {
  if (typeof value !== "string" || !ISO_UTC_SECONDS.test(value)) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  return new Date(timestamp).toISOString() === value.replace(/Z$/, ".000Z");
}

function isIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function requireInventoryEvidence(record, label) {
  requireValue(record?.type === "digital-extremes-world-state" && record.url === "https://api.warframe.com/cdn/worldState.php", `Invalid World State evidence: ${label}`);
  requireValue(isExactUtcTimestamp(record.startsAt) && isExactUtcTimestamp(record.endsAt) && Date.parse(record.startsAt) < Date.parse(record.endsAt), `Invalid inventory interval: ${label}`);
  requireValue(Array.isArray(record.relics) && record.relics.length > 0, `Missing inventory relics: ${label}`);
  requireUnique(record.relics.map(relic => relic.itemType), `Duplicate inventory item: ${label}`);
  requireUnique(record.relics.map(relic => relic.name), `Duplicate inventory relic: ${label}`);
  for (const relic of record.relics) {
    requireValue(typeof relic.itemType === "string" && /^\/Lotus\/StoreItems\/Types\/Game\/Projections\/[A-Za-z0-9]+Bronze$/.test(relic.itemType), `Invalid inventory relic item: ${label}`);
    requireValue(/^(Lith|Meso|Neo|Axi) [A-Z]\d+$/.test(relic.name) && relic.costAya === 1, `Invalid inventory relic name or price: ${label}`);
  }
  requireValue(record.exportUrls && typeof record.exportUrls === "object", `Missing inventory export URLs: ${label}`);
  for (const key of ["Recipes_en", "RelicArcane_en", "Warframes_en", "Weapons_en", "Sentinels_en", "Warframes_zh", "Weapons_zh", "Sentinels_zh"]) {
    requireValue(typeof record.exportUrls[key] === "string" && record.exportUrls[key].startsWith(`https://content.warframe.com/PublicExport/Manifest/Export${key}.json!`), `Invalid inventory export URL: ${label} / ${key}`);
  }
}

function requireVaultExportEvidence(record, label) {
  requireValue(record?.type === "digital-extremes-public-export-vault-group", `Invalid Vault export evidence: ${label}`);
  requireValue(isExactUtcTimestamp(record.startsAt), `Invalid Vault export start time: ${label}`);
  requireValue(record.selectionBasis === "announced-pair-specific-vault-group" && record.priceBasis === "planner-preset", `Invalid Vault export evidence basis: ${label}`);
  requireValue(Array.isArray(record.rawPrimeWarframes) && record.rawPrimeWarframes.length === 2
    && record.rawPrimeWarframes.every(name => typeof name === "string" && /^[A-Za-z0-9 ]+ Prime$/.test(name)), `Invalid Vault export Prime names: ${label}`);
  requireUnique(record.rawPrimeWarframes, `Duplicate Vault export Prime name: ${label}`);
  const names = record.rawPrimeWarframes.map(name => name.replace(/ Prime$/, "").replaceAll(" ", ""));
  requireValue([`${names[0]}${names[1]}Vault`, `${names[1]}${names[0]}Vault`].includes(record.group), `Vault export group disagrees with announcement: ${label}`);
  requireValue(Array.isArray(record.relics) && record.relics.length > 0, `Missing Vault export relics: ${label}`);
  requireUnique(record.relics.map(relic => relic.itemType), `Duplicate Vault export relic ID: ${label}`);
  requireUnique(record.relics.map(relic => relic.name), `Duplicate Vault export relic name: ${label}`);
  for (const relic of record.relics) {
    const match = /^\/Lotus\/StoreItems\/Types\/Game\/Projections\/T([1-4])VoidProjection([A-Za-z0-9]+Vault)[A-Z]+Bronze$/.exec(relic.itemType);
    requireValue(match && match[2] === record.group, `Wrong Vault export relic group: ${label}`);
    requireValue(/^(Lith|Meso|Neo|Axi) [A-Z]\d+$/.test(relic.name) && relic.name.split(" ")[0] === ["Lith", "Meso", "Neo", "Axi"][Number(match[1]) - 1]
      && relic.costAya === 1, `Invalid Vault export relic name or price preset: ${label}`);
  }
  for (const key of ["Recipes_en", "RelicArcane_en", "Warframes_en", "Weapons_en", "Sentinels_en", "Warframes_zh", "Weapons_zh", "Sentinels_zh"]) {
    requireValue(typeof record.exportUrls?.[key] === "string" && record.exportUrls[key].startsWith(`https://content.warframe.com/PublicExport/Manifest/Export${key}.json!`), `Invalid Vault export URL: ${label} / ${key}`);
  }
  requireValue(record.url === record.exportUrls.RelicArcane_en, `Wrong Vault relic export URL: ${label}`);
}

function requireAnnouncementEvidence(evidence, label) {
  requireValue(typeof evidence?.url === "string" && /^https:\/\/bsky\.app\/profile\/warframe\.com\/post\/[a-z0-9]+$/.test(evidence.url), `Invalid announcement source URL: ${label}`);
  requireValue(isIsoTimestamp(evidence.publishedAt), `Invalid announcement publishedAt: ${label}`);
  requireValue(isIsoTimestamp(evidence.discoveredAt), `Invalid announcement discoveredAt: ${label}`);
  if (evidence.rawPublishedAt !== undefined) {
    requireValue(typeof evidence.rawPublishedAt === "string" && normalizeOfficialTimestamp(evidence.rawPublishedAt) === evidence.publishedAt, `Invalid raw announcement publishedAt: ${label}`);
  }
  requireValue(Array.isArray(evidence.rawPrimeWarframes) && evidence.rawPrimeWarframes.length === 2, `Invalid raw announcement Prime names: ${label}`);
  requireUnique(evidence.rawPrimeWarframes, `Duplicate raw announcement Prime name: ${label}`);
  requireValue(evidence.rawPrimeWarframes.every((name) => typeof name === "string" && name.endsWith(" Prime")), `Invalid raw announcement Prime name: ${label}`);
  requireValue(typeof evidence.rawEffectiveText === "string" && evidence.rawEffectiveText.length > 0, `Missing raw announcement effective time: ${label}`);
}

function requireAnnouncementCandidateSource(source, label) {
  requireValue(source?.type === "digital-extremes-official-announcement", `Invalid announcement source type: ${label}`);
  requireAnnouncementEvidence(source, label);
  if (source.relatedAnnouncements !== undefined) {
    requireValue(Array.isArray(source.relatedAnnouncements), `Invalid related announcement evidence: ${label}`);
    requireUnique(source.relatedAnnouncements.map((entry) => `${entry?.url || ""}::${entry?.publishedAt || ""}::${entry?.rawEffectiveText || ""}`), `Duplicate related announcement evidence: ${label}`);
    for (const evidence of source.relatedAnnouncements) requireAnnouncementEvidence(evidence, `${label} / related`);
  }

  if (source.officialData !== undefined) {
    const officialData = source.officialData;
    requireValue(officialData && typeof officialData === "object", `Invalid official data evidence: ${label}`);
    requireValue([officialData.worldState, officialData.vaultExport, officialData.rotationPage].filter(Boolean).length === 1, `Ambiguous rotation evidence: ${label}`);
    for (const [field, expectedUrl] of [
      ...(officialData.worldState ? [["worldState", "https://api.warframe.com/cdn/worldState.php"]]
        : officialData.vaultExport ? [["vaultExport", "https://content.warframe.com/PublicExport/Manifest/ExportRelicArcane_en.json!"]]
          : [["rotationPage", "https://www.warframe.com/en/prime-resurgence"]]),
      ["dropTable", "https://www.warframe.com/droptables"],
      ["recipeExport", "https://content.warframe.com/PublicExport/Manifest/"]
    ]) {
      const record = officialData[field];
      requireValue(record && typeof record === "object", `Missing official data evidence: ${label} / ${field}`);
      requireValue(typeof record.url === "string" && record.url.startsWith(expectedUrl), `Invalid official data URL: ${label} / ${field}`);
      requireValue(isIsoTimestamp(record.discoveredAt), `Invalid official data discoveredAt: ${label} / ${field}`);
    }
    if (officialData.worldState) requireInventoryEvidence(officialData.worldState, label);
    if (officialData.vaultExport) requireVaultExportEvidence(officialData.vaultExport, label);
    requireValue(Array.isArray(officialData.rawPrimeWarframes) && officialData.rawPrimeWarframes.length === 2, `Invalid official data Prime names: ${label}`);
    requireUnique(officialData.rawPrimeWarframes, `Duplicate official data Prime name: ${label}`);
  }

  if (source.conflict !== undefined) {
    const conflict = source.conflict;
    requireValue(conflict && typeof conflict === "object", `Invalid announcement conflict evidence: ${label}`);
    if (conflict.worldState) {
      requireInventoryEvidence(conflict.worldState, label);
      requireValue(isIsoTimestamp(conflict.worldState.discoveredAt), `Invalid conflict discoveredAt: ${label}`);
      requireValue(Array.isArray(conflict.worldState.rawPrimeWarframes) && conflict.worldState.rawPrimeWarframes.length === 2, `Invalid conflict Prime names: ${label}`);
      return;
    }
    requireValue(conflict.officialRotationPage?.type === "digital-extremes-official-rotation-page", `Invalid conflict source type: ${label}`);
    requireValue(conflict.officialRotationPage?.url === "https://www.warframe.com/en/prime-resurgence", `Invalid conflict source URL: ${label}`);
    requireValue(isIsoTimestamp(conflict.officialRotationPage?.discoveredAt), `Invalid conflict discoveredAt: ${label}`);
    requireValue(Array.isArray(conflict.officialRotationPage?.rawPrimeWarframes) && conflict.officialRotationPage.rawPrimeWarframes.length === 2, `Invalid conflict Prime names: ${label}`);
  }
}

export function validateAnnouncementCandidates(candidateData, rotationData = null) {
  requireValue(candidateData?.schemaVersion === SUPPORTED_ANNOUNCEMENT_CANDIDATE_SCHEMA, `Unsupported announcement candidate schemaVersion: ${candidateData?.schemaVersion ?? "missing"}`);
  requireValue(Array.isArray(candidateData.candidates), "Missing announcement candidates array");
  requireUnique(candidateData.candidates.map((candidate) => candidate?.id), "Duplicate announcement candidate id");

  const rotationMap = new Map((rotationData?.rotations || []).map((rotation) => [rotation.id, rotation]));
  for (const candidate of candidateData.candidates) {
    const label = candidate?.id || "missing";
    requireValue(typeof candidate?.id === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate.id), `Invalid announcement candidate id: ${label}`);
    requireValue(VALID_CANDIDATE_STATUSES.has(candidate.status), `Invalid announcement candidate status: ${label}`);
    requireValue(Array.isArray(candidate.primeWarframes) && candidate.primeWarframes.length === 2, `Announcement candidate must contain exactly two Prime Warframes: ${label}`);
    requireUnique(candidate.primeWarframes, `Duplicate announcement candidate Prime Warframe: ${label}`);
    requireValue(candidate.primeWarframes.every((name) => typeof name === "string" && name.endsWith(" Prime")), `Invalid announcement candidate Prime Warframe: ${label}`);
    requireValue(candidate.effectiveAt === null || isExactUtcTimestamp(candidate.effectiveAt), `Invalid announcement candidate effectiveAt: ${label}`);
    requireValue(candidate.effectiveDate === null || ISO_CALENDAR_DATE.test(candidate.effectiveDate), `Invalid announcement candidate effectiveDate: ${label}`);
    if (candidate.effectiveAt !== null) requireValue(candidate.effectiveDate === candidate.effectiveAt.slice(0, 10), `Announcement candidate effectiveDate disagrees with effectiveAt: ${label}`);
    requireValue(candidate.id === candidateIdFor(candidate.primeWarframes, candidate.effectiveAt, candidate.effectiveDate), `Non-canonical announcement candidate id: ${label}`);
    requireValue(VALID_CANDIDATE_RELIC_STATUSES.has(candidate.relicDataStatus), `Invalid announcement relic data status: ${label}`);
    requireValue(typeof candidate.verified === "boolean", `Invalid announcement verified flag: ${label}`);
    requireValue(typeof candidate.reviewReason === "string" && candidate.reviewReason.length > 0, `Missing announcement review reason: ${label}`);
    requireValue(Array.isArray(candidate.statusHistory) && candidate.statusHistory.length > 0, `Missing announcement candidate status history: ${label}`);
    requireUnique(candidate.statusHistory.map((entry) => entry?.status), `Duplicate announcement candidate status history: ${label}`);
    requireValue(candidate.statusHistory[0]?.status === "announced", `Announcement candidate history must start announced: ${label}`);
    requireValue(candidate.statusHistory.every((entry) => VALID_CANDIDATE_STATUSES.has(entry?.status) && isIsoTimestamp(entry.at)), `Invalid announcement candidate status history: ${label}`);
    requireValue(candidate.statusHistory.at(-1)?.status === candidate.status, `Announcement candidate status history does not match status: ${label}`);
    const historyOrder = candidate.statusHistory.map((entry) => entry.status);
    const expectedHistory = candidate.status === "announced"
      ? ["announced"]
      : candidate.status === "official-data-available"
        ? ["announced", "official-data-available"]
        : candidate.status === "validated"
          ? ["announced", "official-data-available", "validated"]
          : candidate.status === "ready-for-review"
            ? ["announced", "official-data-available", "validated", "ready-for-review"]
            : ["announced", "conflict"];
    requireValue(JSON.stringify(historyOrder) === JSON.stringify(expectedHistory), `Invalid announcement candidate status transition: ${label}`);
    requireAnnouncementCandidateSource(candidate.source, label);
    requireValue(candidate.statusHistory[0].at === candidate.source.discoveredAt, `Announcement candidate history must begin at discovery: ${label}`);
    for (let index = 1; index < candidate.statusHistory.length; index += 1) {
      requireValue(Date.parse(candidate.statusHistory[index].at) >= Date.parse(candidate.statusHistory[index - 1].at), `Announcement candidate status history is not chronological: ${label}`);
    }

    if (candidate.status === "announced") {
      requireValue(candidate.relicDataStatus === "pending" && candidate.verified === false, `Announced candidate cannot verify relic data: ${label}`);
      requireValue(candidate.rotationId === undefined, `Announced candidate cannot reference a rotation: ${label}`);
      requireValue(candidate.source.officialData === undefined, `Announced candidate cannot contain official relic data: ${label}`);
    }
    if (candidate.status === "official-data-available") {
      requireValue(candidate.relicDataStatus === "available" && candidate.verified === false, `Official-data candidate verification state is invalid: ${label}`);
      requireValue(candidate.source.officialData !== undefined, `Official-data candidate is missing official evidence: ${label}`);
    }
    if (candidate.status === "validated" || candidate.status === "ready-for-review") {
      requireValue(candidate.relicDataStatus === "validated" && candidate.verified === true, `Validated candidate verification state is invalid: ${label}`);
      requireValue(candidate.source.officialData !== undefined, `Validated candidate is missing official evidence: ${label}`);
    }
    if (candidate.status === "ready-for-review") {
      requireValue(typeof candidate.rotationId === "string" && candidate.rotationId.length > 0, `Ready candidate is missing rotationId: ${label}`);
      if (rotationData) {
        const rotation = rotationMap.get(candidate.rotationId);
        requireValue(rotation?.publicationStatus === "provisional", `Ready candidate does not reference a provisional rotation: ${label}`);
      }
    }
    if (candidate.source.officialData?.worldState || candidate.source.officialData?.vaultExport) {
      const evidence = candidate.source.officialData.worldState || candidate.source.officialData.vaultExport;
      requireValue(evidence.startsAt === candidate.effectiveAt, `Inventory activation disagrees with announcement: ${label}`);
      requireValue(JSON.stringify([...evidence.rawPrimeWarframes].sort()) === JSON.stringify([...candidate.primeWarframes].sort()), `Rotation evidence Prime names disagree with announcement: ${label}`);
      requireValue(JSON.stringify([...candidate.source.officialData.rawPrimeWarframes].sort()) === JSON.stringify([...candidate.primeWarframes].sort()), `Inventory Prime names disagree with announcement: ${label}`);
    }
    if (candidate.status === "conflict") {
      requireValue(candidate.relicDataStatus === "conflict" && candidate.verified === false, `Conflict candidate verification state is invalid: ${label}`);
      requireValue(candidate.source.conflict !== undefined, `Conflict candidate is missing both sources: ${label}`);
      requireValue(candidate.rotationId === undefined, `Conflict candidate cannot reference a rotation: ${label}`);
    }
  }
  return true;
}

export function validateRotationData(rotationData, primeData, relicData) {
  const rotations = rotationData?.rotations;
  const primeItems = primeData?.primeItems;
  const relics = relicData?.relics;

  requireValue(rotationData?.schemaVersion === SUPPORTED_ROTATION_SCHEMA, `Unsupported rotation schemaVersion: ${rotationData?.schemaVersion ?? "missing"}`);
  requireValue(Array.isArray(rotations), "Missing rotations array");
  requireValue(Array.isArray(primeItems), "Missing primeItems array");
  requireValue(Array.isArray(relics), "Missing relics array");
  requireUnique(rotations.map((rotation) => rotation?.id), "Duplicate rotation id");
  requireUnique(rotations.map((rotation) => rotation?.startsAt), "Duplicate rotation startsAt");
  requireUnique(primeItems.map((item) => item?.id), "Duplicate prime itemId");
  requireUnique(relics.map((relic) => relic?.id), "Duplicate relic id");

  let previousStartsAt = -Infinity;
  for (const rotation of rotations) {
    requireValue(typeof rotation?.id === "string" && rotation.id.length > 0, "Missing rotation id");
    requireValue(VALID_PUBLICATION_STATUSES.has(rotation.publicationStatus), `Invalid publicationStatus: ${rotation.id}`);
    if (rotation.publicationStatus === "provisional") {
      requireProvisionalSource(rotation.source, rotation.id, { recipe: true });
      requireProvisionalSource(primeData?.provisionalSources?.[rotation.id], `primes / ${rotation.id}`, { recipe: true });
      requireProvisionalSource(relicData?.provisionalSources?.[rotation.id], `relics / ${rotation.id}`);
    }
    requireValue(isExactUtcTimestamp(rotation.startsAt), `Invalid rotation startsAt: ${rotation?.startsAt ?? "missing"}`);
    const startsAt = Date.parse(rotation.startsAt);
    requireValue(startsAt > previousStartsAt, `Rotations must be strictly chronological: ${rotation.id}`);
    previousStartsAt = startsAt;
    requireValue(Array.isArray(rotation.items), `Missing rotation items: ${rotation.id}`);
    requireValue(Array.isArray(rotation.relics), `Missing rotation relics: ${rotation.id}`);
    requireValue(rotation.items.length > 0, `Rotation ${rotation.id} must contain at least one item.`);
    requireValue(rotation.relics.length > 0, `Rotation ${rotation.id} must contain at least one relic.`);
    requireUnique(rotation.items, `Duplicate rotation item: ${rotation.id}`);
    requireUnique(rotation.relics, `Duplicate rotation relic: ${rotation.id}`);
    if (rotation.source?.inventory) {
      const inventory = rotation.source.inventory;
      requireInventoryEvidence(inventory, rotation.id);
      requireValue(inventory.startsAt === rotation.startsAt, `Inventory activation disagrees with rotation: ${rotation.id}`);
      requireValue(JSON.stringify(inventory.relics.map(relic => relic.name.toLowerCase().replaceAll(" ", "-")).sort()) === JSON.stringify([...rotation.relics].sort()), `Rotation relics disagree with sale inventory: ${rotation.id}`);
    }
    if (rotation.source?.vaultExport) {
      const evidence = rotation.source.vaultExport;
      requireValue(!rotation.source.inventory, `Ambiguous rotation source: ${rotation.id}`);
      requireVaultExportEvidence(evidence, rotation.id);
      requireValue(evidence.startsAt === rotation.startsAt, `Vault export start disagrees with rotation: ${rotation.id}`);
      requireValue(JSON.stringify(evidence.relics.map(relic => relic.name.toLowerCase().replaceAll(" ", "-")).sort()) === JSON.stringify([...rotation.relics].sort()), `Rotation relics disagree with Vault export: ${rotation.id}`);
      const frames = primeItems.filter(item => rotation.items.includes(item.id) && item.type === "warframe").map(item => item.nameEn || item.name).sort();
      requireValue(JSON.stringify(frames) === JSON.stringify([...evidence.rawPrimeWarframes].sort()), `Rotation Prime names disagree with Vault export: ${rotation.id}`);
    }
    if (rotation.defaults?.ayaBudget !== undefined) {
      requireValue(
        Number.isInteger(rotation.defaults.ayaBudget) && rotation.defaults.ayaBudget >= 0,
        `Invalid default ayaBudget: ${rotation.id}`
      );
    }
  }

  const itemMap = new Map(primeItems.map((item) => [item.id, item]));
  const relicMap = new Map(relics.map((relic) => [relic.id, relic]));
  const rotationMap = new Map(rotations.map((rotation) => [rotation.id, rotation]));

  // The runtime model intentionally stores only rotation target rewards; Forma
  // and other non-target rewards remain implicit. Validate the standard 3/2/1
  // relic capacity without requiring all six physical reward slots to be here.
  for (const relic of relics) validateTargetRewardComposition(relic);

  for (const item of primeItems) {
    requireValue(typeof item?.id === "string" && item.id.length > 0, "Missing prime item id");
    const itemRotation = rotationMap.get(item.rotation);
    requireValue(itemRotation, `Unknown item rotation: ${item.id} / ${item?.rotation ?? "missing"}`);
    requireValue(itemRotation.items.includes(item.id), `Item is not listed by rotation: ${item.id} / ${item.rotation}`);
    requireValue(Array.isArray(item.parts) && item.parts.length > 0, `Missing parts: ${item.id}`);
    requireValue(Array.isArray(item.relics), `Missing item relics: ${item.id}`);
    requireUnique(item.parts.map((part) => part?.id), `Duplicate partId in ${item.id}`);

    for (const part of item.parts) {
      const required = Number(part.required ?? part.quantity ?? 1);
      requireValue(Number.isSafeInteger(required) && required > 0 && required <= MAX_REQUIRED_QUANTITY, `Invalid required quantity: ${item.id} / ${part.id}`);
      requireValue(VALID_RARITIES.has(part.rarity), `Invalid part rarity: ${item.id} / ${part.id}`);
      requireValue(Array.isArray(part.relics) && part.relics.length > 0, `Missing relic source: ${item.id} / ${part.id}`);
      requireUnique(part.relics, `Duplicate part relic route: ${item.id} / ${part.id}`);
      const routeRarities = new Set();

      for (const relicId of part.relics) {
        const relic = relicMap.get(relicId);
        requireValue(relic, `Missing relic: ${relicId} for ${item.id} / ${part.id}`);
        requireValue(item.relics.includes(relicId), `Item relic list mismatch: ${item.id} / ${relicId}`);
        const reward = relic.rewards?.find((entry) => entry.itemId === item.id && entry.partId === part.id);
        requireValue(reward, `Missing reverse reward mapping: ${relicId} / ${item.id} / ${part.id}`);
        requireValue(VALID_RARITIES.has(reward.rarity), `Invalid reward rarity: ${relicId} / ${item.id} / ${part.id}`);
        routeRarities.add(reward.rarity);
      }
      requireValue(routeRarities.has(part.rarity), `Part rarity has no matching route: ${item.id} / ${part.id}`);
    }
  }

  for (const relic of relics) {
    requireValue(typeof relic?.id === "string" && relic.id.length > 0, "Missing relic id");
    requireValue(Number.isSafeInteger(relic.costAya) && relic.costAya === 1, `Invalid relic costAya: ${relic.id}`);
    const relicRotation = rotationMap.get(relic.rotation);
    requireValue(relicRotation, `Unknown relic rotation: ${relic.id} / ${relic?.rotation ?? "missing"}`);
    requireValue(relicRotation.relics.includes(relic.id), `Relic is not listed by rotation: ${relic.id} / ${relic.rotation}`);
    requireValue(Array.isArray(relic.rewards), `Missing relic rewards: ${relic.id}`);
    const seenRewards = new Set();
    for (const reward of relic.rewards) {
      const rewardKey = `${reward.itemId}:${reward.partId}`;
      requireValue(!seenRewards.has(rewardKey), `Duplicate relic reward:\n${relic.name || relic.id}\n${reward.itemId} / ${reward.partId}`);
      seenRewards.add(rewardKey);
      const item = itemMap.get(reward.itemId);
      requireValue(item, `Unknown relic reward item: ${relic.id} / ${reward.itemId}`);
      const part = item.parts.find((entry) => entry.id === reward.partId);
      requireValue(part, `Unknown relic reward: ${relic.id} / ${reward.itemId} / ${reward.partId}`);
      requireValue(VALID_RARITIES.has(reward.rarity), `Invalid reward rarity: ${relic.id} / ${reward.itemId} / ${reward.partId}`);
      requireValue(part.relics.includes(relic.id), `Missing part relic mapping: ${relic.id} / ${reward.itemId} / ${reward.partId}`);
      requireValue(item.relics.includes(relic.id), `Missing item relic mapping: ${relic.id} / ${reward.itemId}`);
    }
  }

  for (const rotation of rotations) {
    const rotationItemIds = new Set(rotation.items);
    const rotationRelicIds = new Set(rotation.relics);

    for (const itemId of rotation.items) {
      const item = itemMap.get(itemId);
      requireValue(item, `Missing rotation item: ${rotation.id} / ${itemId}`);
      requireValue(item.rotation === rotation.id, `Rotation item ownership mismatch: ${rotation.id} / ${itemId} owned by ${item.rotation}`);
      for (const part of item.parts) {
        const currentRoutes = part.relics.filter((relicId) => rotationRelicIds.has(relicId));
        requireValue(currentRoutes.length > 0, `Missing rotation relic source: ${rotation.id} / ${itemId} / ${part.id}`);
      }
    }

    for (const relicId of rotation.relics) {
      const relic = relicMap.get(relicId);
      requireValue(relic, `Missing rotation relic: ${rotation.id} / ${relicId}`);
      requireValue(relic.rotation === rotation.id, `Rotation relic ownership mismatch: ${rotation.id} / ${relicId} owned by ${relic.rotation}`);
      for (const reward of relic.rewards) {
        requireValue(rotationItemIds.has(reward.itemId), `Reward item is not in rotation: ${rotation.id} / ${relic.id} / ${reward.itemId}`);
      }
    }
  }

  return true;
}
