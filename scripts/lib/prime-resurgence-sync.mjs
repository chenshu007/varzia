import { lineupFromVaultExport, vaultGroupsFor } from "./prime-vault-preview.mjs";
import { WORLD_STATE_URL, parsePrimeVaultTrader, lineupFromInventory } from "./prime-vault-inventory.mjs";
import { spawn } from "node:child_process";
import { open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { validateAnnouncementCandidates, validateRotationData } from "../../js/data-validation.js";
import { candidateIdFor as canonicalCandidateIdFor, normalizeOfficialTimestamp } from "../../js/prime-resurgence-candidate.js";
import { publishedRotations, resolveRotationState } from "../../js/rotation-schedule.js";

export const OFFICIAL_SOURCES = Object.freeze({
  worldState: WORLD_STATE_URL,
  rotationEn: "https://www.warframe.com/en/prime-resurgence",
  rotationZh: "https://www.warframe.com/zh-hans/prime-resurgence",
  announcementFeed: "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=warframe.com&limit=100&filter=posts_no_replies",
  dropTables: "https://www.warframe.com/droptables",
  publicExportIndex: "https://content.warframe.com/PublicExport/index_en.txt.lzma"
});

export const SYNC_DATA_PATHS = Object.freeze({
  rotation: "data/rotation.json",
  primes: "data/primes.json",
  relics: "data/relics.json",
  candidates: "data/prime-resurgence-candidates.json",
  recipeExceptions: "data/prime-resurgence-recipe-exceptions.json"
});

export const SYNC_MUTABLE_DATA_PATHS = Object.freeze([
  SYNC_DATA_PATHS.rotation,
  SYNC_DATA_PATHS.primes,
  SYNC_DATA_PATHS.relics,
  SYNC_DATA_PATHS.candidates
]);

const OFFICIAL_WARFRAME_DID = "did:plc:24m2xjetjmjfdbgo752skciu";
const VALID_RARITIES = new Set(["common", "uncommon", "rare"]);
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const ERA_ORDER = new Map([["Lith", 0], ["Meso", 1], ["Neo", 2], ["Axi", 3]]);
const ERA_ZH = Object.freeze({ Lith: "古纪", Meso: "前纪", Neo: "中纪", Axi: "后纪" });
const ITEM_TYPE_BY_OFFICIAL_LABEL = new Map([
  ["Warframe", "warframe"],
  ["Primary Weapon", "primary"],
  ["Secondary Weapon", "secondary"],
  ["Melee Weapon", "melee"],
  ["Companion", "companion"],
  ["Sentinel", "companion"]
]);
const PART_ZH = Object.freeze({
  blueprint: "蓝图",
  chassis: "机体",
  neuroptics: "神经光元",
  systems: "系统",
  barrel: "枪管",
  receiver: "枪机",
  stock: "枪托",
  blade: "刀刃",
  handle: "握柄",
  hilt: "握柄",
  guard: "护手",
  link: "连接器",
  boot: "靴子",
  gauntlet: "拳套",
  cerebrum: "头部",
  carapace: "外壳"
});
const INTERNAL_ITEM_ALIASES = Object.freeze({
  "euphona-prime": ["prime1hshotgun"],
  "helios-prime": ["primeheliossentinel", "primehelios"]
});
const MAX_REQUIRED_QUANTITY = 65_535;
const RECIPE_EXCEPTION_SCHEMA = 1;
export const NEAR_ROTATION_WATCH_BEFORE_MS = 2 * 60 * 60 * 1_000;
export const NEAR_ROTATION_WATCH_AFTER_MS = 12 * 60 * 60 * 1_000;
const MONTH_INDEX = new Map([
  ["January", 0], ["February", 1], ["March", 2], ["April", 3],
  ["May", 4], ["June", 5], ["July", 6], ["August", 7],
  ["September", 8], ["October", 9], ["November", 10], ["December", 11]
]);

export class PrimeResurgenceSyncError extends Error {
  constructor(message) {
    super(message);
    this.name = "PrimeResurgenceSyncError";
  }
}

function invariant(condition, message) {
  if (!condition) throw new PrimeResurgenceSyncError(message);
}

function unique(values, label) {
  const seen = new Set();
  for (const value of values) {
    invariant(value && !seen.has(value), `${label}: ${value || "missing"}`);
    seen.add(value);
  }
}

function clone(value) {
  return structuredClone(value);
}

function sameSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === left.length
    && rightSet.size === right.length
    && [...leftSet].every((value) => rightSet.has(value));
}

function normalizedText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function decodeHtml(value) {
  const named = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: "\"" };
  const decoded = String(value || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, key) => {
    if (key[0] === "#") {
      const radix = key[1]?.toLowerCase() === "x" ? 16 : 10;
      const digits = radix === 16 ? key.slice(2) : key.slice(1);
      const codePoint = Number.parseInt(digits, radix);
      return Number.isInteger(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }
    return named[key.toLowerCase()] ?? entity;
  });
  invariant(!/&(?:#x[0-9a-f]+|#\d+|[a-z]+);/i.test(decoded), `Unsupported HTML entity: ${decoded.match(/&[^;]+;/)?.[0]}`);
  return decoded;
}

function parseAttributes(openTag) {
  const attributes = {};
  const source = String(openTag).replace(/^<[^\s>]+|\/?\s*>$/g, "");
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    attributes[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function classNames(openTag) {
  return new Set(normalizedText(parseAttributes(openTag).class).split(" ").filter(Boolean));
}

function extractBalancedElement(source, start, tagName) {
  const tokens = /<\/?([a-z0-9-]+)\b[^>]*>/gi;
  tokens.lastIndex = start;
  let depth = 0;
  let first = null;
  for (let match = tokens.exec(source); match; match = tokens.exec(source)) {
    if (match.index < start || match[1].toLowerCase() !== tagName.toLowerCase()) continue;
    const closing = /^<\//.test(match[0]);
    const selfClosing = /\/\s*>$/.test(match[0]) || VOID_TAGS.has(match[1].toLowerCase());
    if (!first) {
      invariant(match.index === start && !closing, `Malformed <${tagName}> element.`);
      first = match;
    }
    if (closing) depth -= 1;
    else if (!selfClosing) depth += 1;
    if (depth === 0) {
      const end = tokens.lastIndex;
      return {
        start,
        end,
        openTag: first[0],
        inner: source.slice(first.index + first[0].length, match.index),
        outer: source.slice(start, end)
      };
    }
  }
  throw new PrimeResurgenceSyncError(`Unclosed <${tagName}> element.`);
}

function findElements(source, tagName, predicate = () => true) {
  const opening = new RegExp(`<${tagName}\\b[^>]*>`, "gi");
  const elements = [];
  for (let match = opening.exec(source); match; match = opening.exec(source)) {
    if (!predicate(match[0])) continue;
    const element = VOID_TAGS.has(tagName.toLowerCase())
      ? { start: match.index, end: opening.lastIndex, openTag: match[0], inner: "", outer: match[0] }
      : extractBalancedElement(source, match.index, tagName);
    elements.push(element);
    opening.lastIndex = element.end;
  }
  return elements;
}

function findSingleElement(source, tagName, predicate, label) {
  const matches = findElements(source, tagName, predicate);
  invariant(matches.length === 1, `Expected exactly one ${label}; found ${matches.length}.`);
  return matches[0];
}

function hasClass(openTag, className) {
  return classNames(openTag).has(className);
}

function htmlText(source) {
  return normalizedText(decodeHtml(String(source || "").replace(/<[^>]+>/g, " ")));
}

function imageKey(src) {
  const url = new URL(src);
  invariant(url.protocol === "https:", `Non-HTTPS Prime item image: ${src}`);
  return `${url.hostname}${url.pathname}`;
}

function parsePrimePage(html, { english }) {
  invariant(typeof html === "string" && html.length > 1_000, "Prime Resurgence HTML is unexpectedly small.");
  const current = findSingleElement(
    html,
    "section",
    (tag) => parseAttributes(tag).id === "current",
    "Prime Resurgence #current section"
  );
  const desktop = findSingleElement(
    current.inner,
    "div",
    (tag) => hasClass(tag, "ContentSection-content") && hasClass(tag, "desktopOnly"),
    "desktop current rotation grid"
  );
  const title = htmlText(findSingleElement(
    current.inner.slice(0, desktop.start),
    "div",
    (tag) => hasClass(tag, "SectionTitle"),
    "current rotation title"
  ).inner);
  const cards = [];
  for (const cell of findElements(desktop.inner, "div", (tag) => hasClass(tag, "CurrentGridCell"))) {
    const titleNode = findSingleElement(cell.inner, "div", (tag) => hasClass(tag, "CurrentGridCell-title"), "Prime item title");
    const typeNode = findSingleElement(titleNode.inner, "p", () => true, "Prime item type");
    const name = htmlText(titleNode.inner.slice(0, titleNode.inner.indexOf(typeNode.outer)));
    const officialType = htmlText(typeNode.inner);
    const image = findSingleElement(cell.inner, "img", (tag) => hasClass(tag, "CurrentGridCell-image"), "Prime item image");
    const src = parseAttributes(image.openTag).src;
    invariant(name && officialType && src, "Prime item card is missing name, type, or image.");
    cards.push({ name, officialType, imageKey: imageKey(src) });
  }
  unique(cards.map((card) => card.imageKey), "Duplicate Prime item image in desktop grid");

  if (!english) return { title, cards };
  const craftable = cards
    .filter((card) => ITEM_TYPE_BY_OFFICIAL_LABEL.has(card.officialType))
    .map((card) => ({ ...card, type: ITEM_TYPE_BY_OFFICIAL_LABEL.get(card.officialType) }));
  invariant(craftable.length >= 2, `Expected craftable Prime items; found ${craftable.length}.`);
  invariant(craftable.filter((item) => item.type === "warframe").length === 2, "Expected exactly two Prime Warframes.");
  const titleNames = title.split(/\s*(?:&|and)\s*/i).map(normalizedText);
  const warframeNames = craftable.filter((item) => item.type === "warframe").map((item) => item.name);
  invariant(titleNames.length === 2 && sameSet(titleNames, warframeNames), "Rotation title and Prime Warframe cards disagree.");
  return { title, cards, craftable };
}

export function parsePrimeResurgencePages(englishHtml, chineseHtml) {
  const english = parsePrimePage(englishHtml, { english: true });
  const chinese = parsePrimePage(chineseHtml, { english: false });
  const chineseByImage = new Map(chinese.cards.map((card) => [card.imageKey, card]));
  const items = english.craftable.map((item) => {
    const localized = chineseByImage.get(item.imageKey);
    invariant(localized?.name, `Chinese Prime item card is missing for ${item.name}.`);
    return { ...item, chineseName: localized.name };
  });
  unique(items.map((item) => item.name), "Duplicate official Prime item name");
  unique(items.map((item) => slugify(item.name)), "Duplicate normalized Prime item id");
  unique(items.map((item) => item.chineseName), "Duplicate official Chinese Prime item name");
  return {
    title: english.title,
    items,
    warframes: items.filter((item) => item.type === "warframe")
  };
}

function rarityFromIntactProbability(probability) {
  if (Math.abs(probability - 25.33) < 0.001) return "common";
  if (Math.abs(probability - 11) < 0.001) return "uncommon";
  if (Math.abs(probability - 2) < 0.001) return "rare";
  throw new PrimeResurgenceSyncError(`Unsupported Intact relic probability: ${probability}%`);
}

function normalizedRarityLabel(value) {
  const rarity = String(value || "").toLowerCase();
  invariant(VALID_RARITIES.has(rarity), `Unsupported official rarity label: ${value || "missing"}`);
  return rarity;
}

export function parseDropTables(html, { minimumRelics = 1 } = {}) {
  invariant(typeof html === "string" && html.includes('id="relicRewards"'), "Drop Tables relic section is missing.");
  const relics = [];
  let current = null;
  const finish = () => {
    if (!current) return;
    invariant(current.rewards.length === 6, `${current.name} must contain exactly six Intact rewards; found ${current.rewards.length}.`);
    const total = current.rewards.reduce((sum, reward) => sum + reward.probability, 0);
    invariant(Math.abs(total - 100) < 0.03, `${current.name} Intact probabilities do not sum to 100%.`);
    relics.push(current);
    current = null;
  };

  for (const row of findElements(html, "tr")) {
    const headers = findElements(row.inner, "th");
    const cells = findElements(row.inner, "td");
    if (headers.length) {
      finish();
      const heading = htmlText(headers[0].inner);
      const match = heading.match(/^((?:Lith|Meso|Neo|Axi) [A-Z]\d+) Relic \(Intact\)$/);
      if (match) current = { name: match[1], rewards: [] };
      continue;
    }
    if (!current) continue;
    if (hasClass(row.openTag, "blank-row")) {
      finish();
      continue;
    }
    invariant(cells.length === 2, `Malformed reward row in ${current.name}.`);
    const rewardName = htmlText(cells[0].inner);
    const rarityText = htmlText(cells[1].inner);
    const rarityMatch = rarityText.match(/^(Common|Uncommon|Rare) \((\d+(?:\.\d+)?)%\)$/);
    invariant(rarityMatch, `Malformed rarity in ${current.name}: ${rarityText}`);
    const probability = Number(rarityMatch[2]);
    const rarity = rarityFromIntactProbability(probability);
    const sourceRarity = normalizedRarityLabel(rarityMatch[1]);
    current.rewards.push({
      name: rewardName,
      probability,
      rarity,
      sourceRarity,
      rarityDisagreement: sourceRarity !== rarity
    });
  }
  finish();
  invariant(relics.length >= minimumRelics, `Expected at least ${minimumRelics} Intact relics; found ${relics.length}.`);
  unique(relics.map((relic) => relic.name), "Duplicate Intact relic");
  return relics;
}

function partsFromEtDate(date) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  return Object.fromEntries(formatter.formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}

function etLocalToIso(year, monthIndex, day, hour, minute) {
  const localAsUtc = Date.UTC(year, monthIndex, day, hour, minute, 0);
  const matches = [4, 5]
    .map((offsetHours) => new Date(localAsUtc + offsetHours * 60 * 60 * 1_000))
    .filter((date) => {
      const parts = partsFromEtDate(date);
      return parts.year === year && parts.month === monthIndex + 1 && parts.day === day
        && parts.hour === hour && parts.minute === minute && parts.second === 0;
    });
  invariant(matches.length === 1, matches.length
    ? "Official announcement time is ambiguous in America/New_York."
    : "Official announcement time is not valid in America/New_York.");
  return matches[0].toISOString().replace(".000Z", "Z");
}

export function parseAnnouncementText(text, createdAt) {
  const primeName = "[A-Z][A-Za-z0-9'.-]*(?: (?:&|[A-Z][A-Za-z0-9'.-]*)){0,3} Prime";
  const rotationPredicate = "(?:return|arrive) with the next Prime Resurgence rotation";
  const directPredicate = "enter Prime Resurgence";
  const predicate = `(?:${rotationPredicate}|${directPredicate})`;
  const pattern = new RegExp(`(${primeName})\\s+(?:and|&)\\s+(${primeName}) ${predicate} on (January|February|March|April|May|June|July|August|September|October|November|December) (\\d{1,2})(?: at (\\d{1,2})(?::(\\d{2}))? ([ap])\\.m\\. ET)?\\.`, "g");
  const matches = [...normalizedText(text).matchAll(pattern)];
  if (!matches.length) return null;
  invariant(matches.length === 1, `Expected one Prime Resurgence announcement in a post; found ${matches.length}.`);
  const match = matches[0];
  invariant(match[1] !== match[2], "Official announcement repeats the same Prime Warframe.");
  const created = new Date(createdAt);
  invariant(Number.isFinite(created.getTime()), "Official announcement has an invalid createdAt timestamp.");
  const monthIndex = MONTH_INDEX.get(match[3]);
  const day = Number(match[4]);
  const hasExplicitTime = Boolean(match[5]);
  if (hasExplicitTime) {
    const sourceHour = Number(match[5]);
    invariant(sourceHour >= 1 && sourceHour <= 12, `Official announcement hour is invalid: ${match[5]}`);
    let hour = sourceHour % 12;
    if (match[7] === "p") hour += 12;
    const minute = Number(match[6] || 0);
    invariant(minute >= 0 && minute <= 59, `Official announcement minute is invalid: ${match[6]}`);
    const candidates = [created.getUTCFullYear(), created.getUTCFullYear() + 1]
      .map((year) => etLocalToIso(year, monthIndex, day, hour, minute))
      .filter((value) => {
        const delta = Date.parse(value) - created.getTime();
        return delta > 0 && delta <= 120 * 24 * 60 * 60 * 1_000;
      });
    invariant(candidates.length === 1, "Official announcement date is ambiguous relative to createdAt.");
    return {
      warframes: [match[1], match[2]],
      startsAt: candidates[0],
      effectiveDate: candidates[0].slice(0, 10),
      rawEffectiveText: `${match[3]} ${match[4]} at ${match[5]}${match[6] ? `:${match[6]}` : ""} ${match[7]}.m. ET`
    };
  }

  const dates = [created.getUTCFullYear(), created.getUTCFullYear() + 1]
    .map((year) => `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`)
    .filter((value) => {
      const delta = Date.parse(`${value}T00:00:00Z`) - created.getTime();
      return delta >= -24 * 60 * 60 * 1_000 && delta <= 120 * 24 * 60 * 60 * 1_000;
    });
  invariant(dates.length === 1, "Official announcement date is ambiguous relative to createdAt.");
  return {
    warframes: [match[1], match[2]],
    startsAt: null,
    effectiveDate: dates[0],
    rawEffectiveText: `${match[3]} ${match[4]}`
  };
}

export function parseOfficialAnnouncements(payload) {
  invariant(payload && Array.isArray(payload.feed), "Official announcement feed is malformed.");
  const announcements = [];
  const seenPostUris = new Set();
  for (const entry of payload.feed) {
    // getAuthorFeed returns repost wrappers alongside original posts. A wrapper
    // is transport metadata, not an additional official announcement.
    if (entry?.reason) continue;
    const post = entry?.post;
    const parsed = parseAnnouncementText(post?.record?.text, post?.record?.createdAt);
    if (!parsed) continue;
    invariant(post?.author?.handle === "warframe.com", "Announcement author handle is not warframe.com.");
    invariant(post?.author?.did === OFFICIAL_WARFRAME_DID, "Announcement author DID changed; human review is required.");
    const uriMatch = String(post.uri || "").match(new RegExp(`^at://${OFFICIAL_WARFRAME_DID}/app\\.bsky\\.feed\\.post/([a-z0-9]+)$`));
    invariant(uriMatch, "Official announcement URI is malformed.");
    if (seenPostUris.has(post.uri)) continue;
    const createdAt = normalizeOfficialTimestamp(post.record.createdAt);
    invariant(createdAt, "Official announcement has an invalid createdAt timestamp.");
    seenPostUris.add(post.uri);
    announcements.push({
      ...parsed,
      createdAt,
      rawCreatedAt: post.record.createdAt,
      url: `https://bsky.app/profile/warframe.com/post/${uriMatch[1]}`
    });
  }
  invariant(announcements.length > 0, "No deterministic Prime Resurgence announcement was found in the official warframe.com feed.");
  unique(announcements.map((announcement) => announcement.url), "Duplicate official announcement URL");
  return announcements.sort((left, right) => String(left.startsAt || left.effectiveDate).localeCompare(String(right.startsAt || right.effectiveDate)));
}

export function slugify(value) {
  return normalizedText(value)
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function targetReward(reward, items) {
  const matches = items
    .filter((item) => reward.name.startsWith(`${item.name} `))
    .sort((left, right) => right.name.length - left.name.length);
  if (!matches.length) return null;
  invariant(matches.length === 1, `Reward item name is ambiguous: ${reward.name}`);
  let partName = reward.name.slice(matches[0].name.length + 1);
  if (partName !== "Blueprint" && partName.endsWith(" Blueprint")) partName = partName.slice(0, -" Blueprint".length);
  const partId = slugify(partName);
  invariant(partId, `Reward part name is malformed: ${reward.name}`);
  return {
    itemName: matches[0].name,
    itemId: slugify(matches[0].name),
    partName,
    partId,
    rarity: reward.rarity,
    sourceRarity: reward.sourceRarity,
    probability: reward.probability,
    rarityDisagreement: reward.rarityDisagreement
  };
}

function relicSort(left, right) {
  const [leftEra, leftCode] = left.name.split(" ");
  const [rightEra, rightCode] = right.name.split(" ");
  return (ERA_ORDER.get(leftEra) - ERA_ORDER.get(rightEra)) || leftCode.localeCompare(rightCode, "en", { numeric: true });
}

export function selectRelicSet(dropRelics, lineupItems, inventoryRelicNames, { requireCompleteItems = true } = {}) {
  invariant(Array.isArray(inventoryRelicNames) && inventoryRelicNames.length > 0, "An explicit official relic selection is required.");
  unique(inventoryRelicNames, "Duplicate inventory relic name");
  unique(dropRelics.map(relic => relic.name), "Duplicate Intact relic");
  const relics = inventoryRelicNames.map(name => {
    const relic = dropRelics.find(entry => entry.name === name);
    invariant(relic, `Inventory relic is missing from official Drop Tables: ${name}.`);
    const targetRewards = relic.rewards.map(reward => targetReward(reward, lineupItems)).filter(Boolean);
    unique(targetRewards.map(reward => `${reward.itemId}:${reward.partId}`), `Duplicate target reward in ${relic.name}`);
    invariant(targetRewards.length > 0, `Inventory relic has no lineup rewards: ${name}.`);
    return { ...relic, targetRewards };
  });
  const expectedByItem = new Map();
  for (const reward of relics.flatMap(relic => relic.targetRewards)) {
    const parts = expectedByItem.get(reward.itemId) || new Map();
    invariant(!parts.has(reward.partId) || parts.get(reward.partId) === reward.partName, `Conflicting part names for ${reward.itemId}/${reward.partId}.`);
    parts.set(reward.partId, reward.partName);
    expectedByItem.set(reward.itemId, parts);
  }
  if (requireCompleteItems) for (const item of lineupItems) {
    const parts = expectedByItem.get(slugify(item.name));
    invariant(parts && parts.has("blueprint") && parts.size >= 3 && parts.size <= 5, `Incomplete Prime part catalog for ${item.name}.`);
  }
  return { relics: [...relics].sort(relicSort), expectedByItem };
}

function normalizedInternal(value) {
  return String(value || "").split("/").at(-1).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function itemInternalPrefixes(itemName) {
  const itemId = slugify(itemName);
  return [...new Set([
    itemName.toLowerCase().replace(/[^a-z0-9]/g, ""),
    itemName.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, ""),
    ...(INTERNAL_ITEM_ALIASES[itemId] || [])
  ])].sort((left, right) => right.length - left.length);
}

function internalPartId(itemName, itemType) {
  const tail = normalizedInternal(itemType);
  const prefix = itemInternalPrefixes(itemName).find((candidate) => tail.startsWith(candidate));
  if (!prefix) return null;
  let part = tail.slice(prefix.length).replace(/component$/, "").replace(/part$/, "");
  if (part === "helmet") part = "neuroptics";
  return part || null;
}

function validateInventoryRewards(selection, lineup, relicExport) {
  for (const relic of selection.relics) {
    const inventory = lineup.inventoryRelics.find(entry => entry.name === relic.name);
    const exported = relicExport.find(entry => entry.uniqueName === inventory.itemType.replace(/^\/Lotus\/StoreItems\//, "/Lotus/"));
    const exportedTargets = [];
    for (const reward of exported.relicRewards) {
      for (const item of lineup.items) {
        const tail = normalizedInternal(reward.rewardName);
        const mainBlueprint = itemInternalPrefixes(item.name).some(prefix => tail === `${prefix}blueprint`);
        let partId = mainBlueprint ? "blueprint" : internalPartId(item.name, reward.rewardName.replace(/Blueprint$/, ""));
        if (!partId) continue;
        if (partId === "handle" && selection.expectedByItem.get(slugify(item.name))?.has("hilt")) partId = "hilt";
        invariant(reward.itemCount === 1, `Unsupported target reward quantity in ${relic.name}.`);
        exportedTargets.push(`${slugify(item.name)}:${partId}:${reward.rarity.toLowerCase()}`);
      }
    }
    const tableTargets = relic.targetRewards.map(reward => `${reward.itemId}:${reward.partId}:${reward.rarity}`);
    invariant(sameSet(exportedTargets, tableTargets), `Public Export rewards disagree with official Drop Tables for ${relic.name}; human review is required.`);
  }
}

export function parseRecipes(payload, { minimumRecipes = 1 } = {}) {
  const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
  invariant(parsed && Array.isArray(parsed.ExportRecipes), "Public Export recipes payload is malformed.");
  invariant(parsed.ExportRecipes.length >= minimumRecipes, `Expected at least ${minimumRecipes} Public Export recipes; found ${parsed.ExportRecipes.length}.`);
  return parsed.ExportRecipes;
}

export function parseRecipeExceptions(payload) {
  const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
  invariant(parsed?.schemaVersion === RECIPE_EXCEPTION_SCHEMA, `Unsupported recipe exception schemaVersion: ${parsed?.schemaVersion ?? "missing"}.`);
  invariant(Array.isArray(parsed.exceptions), "Recipe exceptions array is missing.");
  unique(parsed.exceptions.map((exception) => exception?.itemId), "Duplicate recipe exception itemId");
  for (const exception of parsed.exceptions) {
    invariant(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(exception?.itemId || ""), `Invalid recipe exception itemId: ${exception?.itemId || "missing"}.`);
    invariant(exception.status === "curated-manual", `Recipe exception ${exception.itemId} must be curated-manual.`);
    invariant(exception.sourceUrl === null, `Recipe exception ${exception.itemId} sourceUrl must be null.`);
    invariant(typeof exception.reason === "string" && exception.reason.length > 0, `Recipe exception ${exception.itemId} is missing a reason.`);
    invariant(exception.publicExportEvidence?.status === "missing", `Recipe exception ${exception.itemId} must record missing Public Export status.`);
    invariant(/^\d{4}-\d{2}-\d{2}$/.test(exception.publicExportEvidence?.checkedAt || ""), `Recipe exception ${exception.itemId} has an invalid checkedAt.`);
    invariant(typeof exception.publicExportEvidence?.manifestUrl === "string" && exception.publicExportEvidence.manifestUrl.startsWith("https://content.warframe.com/PublicExport/Manifest/ExportRecipes_en.json!"), `Recipe exception ${exception.itemId} has an invalid checked manifest URL.`);
    invariant(exception.quantities && typeof exception.quantities === "object" && !Array.isArray(exception.quantities), `Recipe exception ${exception.itemId} quantities are malformed.`);
  }
  return parsed.exceptions;
}

function safeRequiredQuantity(value, label) {
  invariant(Number.isSafeInteger(value) && value > 0 && value <= MAX_REQUIRED_QUANTITY, `Unsafe recipe quantity for ${label}: ${value}.`);
  return value;
}

function manualRequirement(exception, item, expectedParts, recipeUrl) {
  const quantityEntries = Object.entries(exception.quantities);
  const expectedPartIds = [...expectedParts.keys()];
  invariant(sameSet(quantityEntries.map(([partId]) => partId), expectedPartIds), `Curated recipe exception parts differ from Official Drop Tables for ${item.name}.`);
  const quantities = new Map();
  for (const [partId, count] of quantityEntries) quantities.set(partId, safeRequiredQuantity(count, `${item.name}/${partId}`));
  return {
    quantities,
    order: quantityEntries.map(([partId]) => partId),
    recipeUniqueName: null,
    provenance: {
      itemId: exception.itemId,
      status: "curated-manual",
      sourceUrl: null,
      publicExportStatus: "missing",
      publicExportCheckedUrl: recipeUrl,
      reason: exception.reason
    }
  };
}

export function resolveRecipeRequirements(recipes, lineupItems, expectedByItem, { recipeExceptions = [], recipeUrl = null } = {}) {
  const requirements = new Map();
  const exceptionMap = new Map(recipeExceptions.map((exception) => [exception.itemId, exception]));
  for (const item of lineupItems) {
    const itemId = slugify(item.name);
    const expectedParts = expectedByItem.get(itemId);
    invariant(expectedParts, `No expected parts for ${item.name}.`);
    const expectedNonBlueprint = [...expectedParts.keys()].filter((partId) => partId !== "blueprint");
    const prefixes = itemInternalPrefixes(item.name);
    const mainRecipes = recipes.filter((recipe) => {
      const tail = normalizedInternal(recipe?.uniqueName);
      return prefixes.some((prefix) => tail === `${prefix}blueprint`);
    });
    invariant(mainRecipes.length <= 1, `Expected at most one main Public Export recipe for ${item.name}; found ${mainRecipes.length}.`);
    if (!mainRecipes.length) {
      const exception = exceptionMap.get(itemId);
      invariant(exception, `Expected one main Public Export recipe for ${item.name}; found 0, and no curated exception exists.`);
      requirements.set(itemId, manualRequirement(exception, item, expectedParts, recipeUrl));
      continue;
    }
    const recipe = mainRecipes[0];
    invariant(recipe.consumeOnUse === true && recipe.num === 1 && Array.isArray(recipe.ingredients), `Main recipe is malformed for ${item.name}.`);
    const quantities = new Map([["blueprint", 1]]);
    const order = ["blueprint"];
    for (const ingredient of recipe.ingredients) {
      const internalId = internalPartId(item.name, ingredient?.ItemType);
      if (!internalId) {
        const ingredientTail = normalizedInternal(ingredient?.ItemType);
        invariant(!ingredientTail.includes("prime"), `Unrecognized Prime recipe ingredient for ${item.name}: ${ingredient?.ItemType || "missing"}`);
        continue;
      }
      const partId = internalId === "handle" && !expectedNonBlueprint.includes("handle") && expectedNonBlueprint.includes("hilt")
        ? "hilt"
        : internalId;
      invariant(expectedNonBlueprint.includes(partId), `Unexpected item ingredient for ${item.name}: ${ingredient.ItemType}`);
      invariant(!quantities.has(partId), `Duplicate recipe ingredient for ${item.name}/${partId}.`);
      quantities.set(partId, safeRequiredQuantity(ingredient.ItemCount, `${item.name}/${partId}`));
      order.push(partId);
    }
    invariant(expectedNonBlueprint.every((partId) => quantities.has(partId)), `Public Export recipe is missing a Prime part for ${item.name}.`);
    requirements.set(itemId, {
      quantities,
      order,
      recipeUniqueName: recipe.uniqueName,
      provenance: {
        itemId,
        status: "public-export",
        sourceUrl: recipeUrl,
        recipeUniqueName: recipe.uniqueName
      }
    });
  }
  return requirements;
}

// Cross-check every reward, including incidental evergreen items, before the
// featured subset is converted into planner targets.
export function validateVaultRewardCatalog(lineup, dropRelics, official) {
  invariant(lineup?.previewEvidence && Array.isArray(lineup.rewardItems), "Vault reward catalog is missing.");
  const raw = selectRelicSet(dropRelics, lineup.rewardItems, lineup.inventoryRelics.map(relic => relic.name), { requireCompleteItems: false });
  validateInventoryRewards(raw, { ...lineup, items: lineup.rewardItems }, official.relicExport);
  const recipes = parseRecipes(official.recipesText);
  for (const item of lineup.rewardItems) {
    const prefixes = itemInternalPrefixes(item.name);
    const mainRecipes = recipes.filter(recipe => prefixes.some(prefix => normalizedInternal(recipe?.uniqueName) === `${prefix}blueprint`));
    invariant(mainRecipes.length <= 1, `Expected at most one main Public Export recipe for ${item.name}; found ${mainRecipes.length}.`);
    if (!mainRecipes.length) continue; // Featured items still require a recipe or an explicit curated exception.
    const recipe = mainRecipes[0];
    invariant(recipe.consumeOnUse === true && recipe.num === 1 && Array.isArray(recipe.ingredients), `Main recipe is malformed for ${item.name}.`);
    const selectedParts = raw.expectedByItem.get(slugify(item.name));
    const recipeParts = new Set();
    for (const ingredient of recipe.ingredients) {
      let partId = internalPartId(item.name, ingredient?.ItemType);
      if (!partId) {
        invariant(!normalizedInternal(ingredient?.ItemType).includes("prime"), `Unrecognized Prime recipe ingredient for ${item.name}: ${ingredient?.ItemType || "missing"}`);
        continue;
      }
      if (partId === "handle" && selectedParts?.has("hilt") && !selectedParts.has("handle")) partId = "hilt";
      invariant(!recipeParts.has(partId), `Duplicate recipe ingredient for ${item.name}/${partId}.`);
      safeRequiredQuantity(ingredient.ItemCount, `${item.name}/${partId}`);
      invariant(dropRelics.some(relic => relic.rewards.some(reward => targetReward(reward, [item])?.partId === partId)),
        `Recipe ingredient for ${item.name}/${partId} is absent from official Drop Tables.`);
      recipeParts.add(partId);
    }
    for (const partId of selectedParts?.keys() || []) {
      if (partId !== "blueprint") invariant(recipeParts.has(partId), `Unexpected selected relic part for ${item.name}: ${partId}.`);
    }
  }
  return lineup;
}

export function parsePublicExportIndex(text) {
  const matches = String(text || "").split(/\r?\n/).filter((line) => /^ExportRecipes_en\.json![A-Za-z0-9_+-]+$/.test(line));
  invariant(matches.length === 1, `Expected one ExportRecipes_en.json manifest entry; found ${matches.length}.`);
  return `https://content.warframe.com/PublicExport/Manifest/${matches[0]}`;
}

export async function decompressLzma(buffer, { timeoutMs = 10_000, maximumBytes = 2_000_000 } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn("xz", ["--format=lzma", "--decompress", "--stdout"], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let size = 0;
    let terminalError = null;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    const timeout = setTimeout(() => {
      terminalError = new PrimeResurgenceSyncError(`Public Export index decompression exceeded ${timeoutMs}ms.`);
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > maximumBytes) {
        terminalError = new PrimeResurgenceSyncError(`Public Export index decompressed size exceeds ${maximumBytes} bytes.`);
        child.kill("SIGKILL");
      }
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => finish(reject, new PrimeResurgenceSyncError(`Unable to run xz: ${error.message}`)));
    child.on("close", (code) => {
      if (terminalError) finish(reject, terminalError);
      else if (code !== 0) finish(reject, new PrimeResurgenceSyncError(`Public Export index decompression failed: ${Buffer.concat(stderr).toString("utf8").trim() || `xz exit ${code}`}`));
      else finish(resolve, Buffer.concat(stdout).toString("utf8"));
    });
    child.stdin.on("error", (error) => {
      if (!terminalError) terminalError = new PrimeResurgenceSyncError(`Unable to stream Public Export index to xz: ${error.message}`);
    });
    child.stdin.end(buffer);
  });
}

function announcementForLineup(lineup, announcements, rotationData) {
  const pageWarframes = lineup.warframes.map((item) => item.name);
  const latestPublished = publishedRotations(rotationData.rotations).at(-1);
  invariant(latestPublished, "No published rotation exists.");
  const pageItemIds = lineup.items.map((item) => slugify(item.name));
  const matchingPublished = publishedRotations(rotationData.rotations).find(rotation => rotation.startsAt === lineup.startsAt && sameSet(rotation.items, pageItemIds));
  if (matchingPublished) {
    const exact = announcements.filter(announcement => announcement.startsAt === matchingPublished.startsAt && sameSet(announcement.warframes, pageWarframes));
    invariant(exact.length === 1, "Published rotation does not have one matching official announcement.");
    return { announcement: exact[0], published: matchingPublished };
  }
  const existingPreviews = rotationData.rotations.filter((rotation) => rotation.publicationStatus === "provisional" && sameSet(rotation.items, pageItemIds));
  invariant(existingPreviews.length <= 1, `Multiple provisional rotations own the same official lineup: ${existingPreviews.map((rotation) => rotation.id).join(", ")}.`);
  const existingPreview = existingPreviews[0];
  const matches = announcements.filter((announcement) => (
    sameSet(announcement.warframes, pageWarframes)
      && Date.parse(announcement.startsAt) > Date.parse(latestPublished.startsAt)
      && (!existingPreview || announcement.startsAt === existingPreview.startsAt)
  ));
  invariant(matches.length === 1, `Expected one official announcement for the page lineup; found ${matches.length}.`);
  return { announcement: matches[0], published: null };
}

function relicId(name) {
  return slugify(name);
}

function routeMapForItems(selectedRelics) {
  const byItem = new Map();
  for (const relic of selectedRelics) {
    for (const reward of relic.targetRewards) {
      const parts = byItem.get(reward.itemId) || new Map();
      const routes = parts.get(reward.partId) || [];
      routes.push({ relicId: relicId(relic.name), rarity: reward.rarity, partName: reward.partName });
      parts.set(reward.partId, routes);
      byItem.set(reward.itemId, parts);
    }
  }
  return byItem;
}

function warframeNames(value) {
  const entries = Array.isArray(value?.warframes) ? value.warframes : value;
  invariant(Array.isArray(entries) && entries.length === 2, "Candidate identity requires exactly two Prime Warframes.");
  return entries.map((entry) => typeof entry === "string" ? entry : entry?.name);
}

export function candidateIdFor(lineupOrWarframes, startsAt = null, effectiveDate = null) {
  try {
    return canonicalCandidateIdFor(lineupOrWarframes, startsAt, effectiveDate);
  } catch (error) {
    throw new PrimeResurgenceSyncError(error instanceof Error ? error.message : String(error));
  }
}

function candidateIdentity(announcement) {
  return `${announcementPairIdentity(announcement.warframes)}::${announcement.startsAt || announcement.effectiveDate || "time-pending"}`;
}

function candidateIdentityForRecord(candidate) {
  return `${announcementPairIdentity(candidate?.primeWarframes || [])}::${candidate?.effectiveAt || candidate?.effectiveDate || "time-pending"}`;
}

function announcementPairIdentity(warframes) {
  return [...warframes].sort().join("|");
}

function announcementCalendarDate(announcement) {
  return announcement.effectiveDate || announcement.startsAt?.slice(0, 10) || null;
}

function candidateCalendarDate(candidate) {
  return candidate.effectiveDate || candidate.effectiveAt?.slice(0, 10) || null;
}

function announcementEvidence(announcement, discoveredAt) {
  return {
    url: announcement.url,
    publishedAt: announcement.createdAt,
    rawPublishedAt: announcement.rawCreatedAt,
    discoveredAt,
    rawPrimeWarframes: [...announcement.warframes],
    rawEffectiveText: announcement.rawEffectiveText
  };
}

function sameAnnouncementEvidence(left, right) {
  return left?.url === right?.url
    && left?.publishedAt === right?.publishedAt
    && left?.rawEffectiveText === right?.rawEffectiveText;
}

function withRelatedAnnouncementEvidence(source, announcement, discoveredAt) {
  const evidence = announcementEvidence(announcement, discoveredAt);
  if (sameAnnouncementEvidence(source, evidence)) return source;
  const related = Array.isArray(source.relatedAnnouncements) ? source.relatedAnnouncements.map(clone) : [];
  if (related.some((entry) => sameAnnouncementEvidence(entry, evidence))) return source;
  return { ...clone(source), relatedAnnouncements: [...related, evidence] };
}

export function nearRotationWatchWindow(effectiveAt) {
  invariant(typeof effectiveAt === "string" && Number.isFinite(Date.parse(effectiveAt)), "Near-rotation watcher requires a valid effectiveAt.");
  const effectiveAtMs = Date.parse(effectiveAt);
  return {
    effectiveAt,
    startsAt: new Date(effectiveAtMs - NEAR_ROTATION_WATCH_BEFORE_MS).toISOString(),
    endsAt: new Date(effectiveAtMs + NEAR_ROTATION_WATCH_AFTER_MS).toISOString()
  };
}

export function selectNearRotationCandidate(candidateData, now = new Date()) {
  const currentMs = new Date(now).getTime();
  invariant(Number.isFinite(currentMs), "Near-rotation watcher current time is invalid.");
  const announced = (candidateData?.candidates || [])
    .filter((candidate) => candidate?.status === "announced")
    .sort((left, right) => String(left.effectiveAt || "9999-12-31").localeCompare(String(right.effectiveAt || "9999-12-31")) || left.id.localeCompare(right.id));
  if (!announced.length) return { eligible: false, reason: "no-announced-candidate", candidate: null, current: new Date(currentMs).toISOString() };

  const timed = announced.filter((candidate) => candidate.effectiveAt);
  if (!timed.length) return { eligible: false, reason: "missing-effective-at", candidate: announced[0], current: new Date(currentMs).toISOString() };

  const eligible = timed.map((candidate) => ({ candidate, window: nearRotationWatchWindow(candidate.effectiveAt) }))
    .filter(({ window }) => currentMs >= Date.parse(window.startsAt) && currentMs <= Date.parse(window.endsAt));
  if (eligible.length > 1) {
    return {
      eligible: false,
      reason: "overlapping-eligible-candidates",
      candidate: null,
      candidates: eligible.map(({ candidate }) => candidate.id),
      current: new Date(currentMs).toISOString()
    };
  }
  if (eligible.length === 1) return { eligible: true, reason: null, ...eligible[0], current: new Date(currentMs).toISOString() };

  const nearest = timed.map((candidate) => ({ candidate, window: nearRotationWatchWindow(candidate.effectiveAt) }))
    .sort((left, right) => (
      Math.abs(Date.parse(left.candidate.effectiveAt) - currentMs) - Math.abs(Date.parse(right.candidate.effectiveAt) - currentMs)
        || left.candidate.id.localeCompare(right.candidate.id)
    ))[0];
  return { eligible: false, reason: "outside-watch-window", ...nearest, current: new Date(currentMs).toISOString() };
}

function announcementCandidate(announcement, discoveredAt) {
  return {
    id: candidateIdFor(announcement.warframes, announcement.startsAt, announcement.effectiveDate),
    status: "announced",
    primeWarframes: [...announcement.warframes],
    effectiveAt: announcement.startsAt,
    effectiveDate: announcement.effectiveDate || null,
    source: {
      type: "digital-extremes-official-announcement",
      url: announcement.url,
      publishedAt: announcement.createdAt,
      rawPublishedAt: announcement.rawCreatedAt,
      discoveredAt,
      rawPrimeWarframes: [...announcement.warframes],
      rawEffectiveText: announcement.rawEffectiveText
    },
    relicDataStatus: "pending",
    verified: false,
    statusHistory: [{ status: "announced", at: discoveredAt }],
    reviewReason: "Officially announced by Digital Extremes; awaiting official relic and reward data."
  };
}

function withStatusTransition(candidate, status, at) {
  const history = Array.isArray(candidate.statusHistory) && candidate.statusHistory.length
    ? candidate.statusHistory.map(clone)
    : [{ status: "announced", at: candidate.source?.discoveredAt || at }];
  if (history.at(-1).status !== status) history.push({ status, at });
  return history;
}

function withStatusTransitions(candidate, statuses, at) {
  let next = { ...candidate };
  for (const status of statuses) {
    if ((next.statusHistory || []).some((entry) => entry.status === status)) continue;
    next = { ...next, statusHistory: withStatusTransition(next, status, at) };
  }
  return next.statusHistory;
}

function upsertAnnouncementCandidates(candidateData, announcements, rotationData, discoveredAt) {
  const candidates = candidateData.candidates.map(clone);
  const latestPublished = publishedRotations(rotationData.rotations).at(-1);
  invariant(latestPublished, "No published rotation exists.");
  const announced = announcements.filter((announcement) => (
    announcement.startsAt === null || Date.parse(announcement.startsAt) > Date.parse(latestPublished.startsAt)
  ));

  for (const announcement of announced) {
    const identity = candidateIdentity(announcement);
    const calendarDate = announcementCalendarDate(announcement);
    const exact = candidates.find((candidate) => candidateIdentityForRecord(candidate) === identity);
    const sameDay = candidates.filter((candidate) => (
      announcementPairIdentity(candidate.primeWarframes) === announcementPairIdentity(announcement.warframes)
        && candidateCalendarDate(candidate) === calendarDate
    ));
    invariant(sameDay.length <= 1, `Multiple announcement candidates share ${announcementPairIdentity(announcement.warframes)} on ${calendarDate || "an unknown date"}.`);
    const existing = exact || sameDay[0];
    if (!existing) {
      const id = candidateIdFor(announcement.warframes, announcement.startsAt, announcement.effectiveDate);
      invariant(!candidates.some((candidate) => candidate.id === id), `Announcement candidate ID ${id} conflicts with a different official calendar date; human review is required.`);
      candidates.push(announcementCandidate(announcement, discoveredAt));
      continue;
    }
    invariant(existing.id === candidateIdFor(announcement.warframes, announcement.startsAt, announcement.effectiveDate), `Announcement candidate identity changed for ${existing.id}.`);
    invariant(sameSet(existing.primeWarframes, announcement.warframes), `Announcement candidate Prime names changed for ${existing.id}.`);
    if (existing.effectiveAt && announcement.startsAt) {
      invariant(existing.effectiveAt === announcement.startsAt, `Announcement candidate ${existing.id} has a conflicting official start time; human review is required.`);
    }
    const refined = !existing.effectiveAt && announcement.startsAt;
    const source = withRelatedAnnouncementEvidence(existing.source, announcement, discoveredAt);
    const next = {
      ...clone(existing),
      ...(refined ? { effectiveAt: announcement.startsAt, effectiveDate: announcementCalendarDate(announcement) } : {}),
      source
    };
    const changed = JSON.stringify(next) !== JSON.stringify(existing);
    if (changed) {
      const index = candidates.findIndex((candidate) => candidate.id === existing.id);
      invariant(index >= 0, `Announcement candidate ${existing.id} disappeared during refinement.`);
      candidates[index] = next;
    }
  }
  candidates.sort((left, right) => (
    String(left.effectiveAt || left.effectiveDate || "9999-12-31").localeCompare(String(right.effectiveAt || right.effectiveDate || "9999-12-31"))
      || left.id.localeCompare(right.id)
  ));
  return { ...clone(candidateData), candidates };
}

function officialRotationEvidence(lineup, discoveredAt) {
  const evidence = lineup.inventoryEvidence || lineup.previewEvidence;
  invariant(evidence, "Official rotation selection evidence is required.");
  return { ...evidence, discoveredAt, rawPrimeWarframes: lineup.warframes.map(item => item.name) };
}

function sameWarframePair(left, right) {
  return sameSet(warframeNames(left), warframeNames(right));
}

function pageMatchesPublishedLineup(lineup, rotationData, primeData) {
  const itemMap = new Map((primeData.primeItems || []).map(item => [item.id, item]));
  return publishedRotations(rotationData.rotations).some(rotation => {
    const names = rotation.items.map(id => itemMap.get(id)).filter(item => item?.type === "warframe").map(item => item.nameEn || item.name);
    return names.length === 2 && sameSet(names, lineup.warframes.map(item => item.name));
  });
}

function candidateForLineup(candidateData, lineup) {
  const matches = candidateData.candidates.filter((candidate) => (
    candidate.status !== "conflict" && sameWarframePair(candidate.primeWarframes, lineup.warframes)
  ));
  const announced = matches.filter((candidate) => candidate.status === "announced");
  invariant(announced.length <= 1, `Multiple announced candidates match the official inventory lineup: ${announced.map((candidate) => candidate.id).join(", ")}.`);
  if (announced.length) return announced[0];
  invariant(matches.length <= 1, `Multiple announcement candidates match the official inventory lineup: ${matches.map((candidate) => candidate.id).join(", ")}.`);
  return matches[0] || null;
}

function officialDataEvidence(lineup, recipeUrl, discoveredAt) {
  return {
    [lineup.previewEvidence ? "vaultExport" : "worldState"]: officialRotationEvidence(lineup, discoveredAt),
    dropTable: {
      type: "digital-extremes-official-drop-table",
      url: OFFICIAL_SOURCES.dropTables,
      discoveredAt
    },
    recipeExport: {
      type: "digital-extremes-public-export",
      url: recipeUrl,
      discoveredAt
    },
    rawPrimeWarframes: lineup.warframes.map((item) => item.name)
  };
}

function upgradeAnnouncementCandidate(candidateData, { announcement, lineup, recipeUrl, discoveredAt, rotationId }) {
  invariant(announcement.startsAt, "Official data cannot upgrade an announcement without an explicit official start time.");
  const identity = candidateIdentity(announcement);
  const existing = candidateData.candidates.find((candidate) => candidateIdentityForRecord(candidate) === identity);
  const baseline = existing ? clone(existing) : announcementCandidate(announcement, discoveredAt);
  invariant(baseline.status !== "conflict", `Candidate ${baseline.id} is conflicted and cannot be upgraded automatically.`);
  invariant(sameSet(baseline.primeWarframes, lineup.warframes.map((item) => item.name)), `Announcement candidate ${baseline.id} conflicts with the official inventory.`);
  const nextOfficialData = officialDataEvidence(lineup, recipeUrl, discoveredAt);
  const existingOfficialData = baseline.source?.officialData;
  const evidenceKey = lineup.previewEvidence ? "vaultExport" : "worldState";
  const officialData = existingOfficialData
    && JSON.stringify({
      rotation: existingOfficialData[evidenceKey] && { ...existingOfficialData[evidenceKey], discoveredAt: null },
      dropTable: existingOfficialData.dropTable?.url,
      recipeExport: existingOfficialData.recipeExport?.url,
      rawPrimeWarframes: existingOfficialData.rawPrimeWarframes
    }) === JSON.stringify({
      rotation: { ...nextOfficialData[evidenceKey], discoveredAt: null },
      dropTable: nextOfficialData.dropTable.url,
      recipeExport: nextOfficialData.recipeExport.url,
      rawPrimeWarframes: nextOfficialData.rawPrimeWarframes
    })
    ? existingOfficialData
    : nextOfficialData;
  const source = {
    ...baseline.source,
    officialData
  };
  const upgraded = {
    ...baseline,
    status: "ready-for-review",
    effectiveAt: announcement.startsAt,
    effectiveDate: announcement.effectiveDate || announcement.startsAt.slice(0, 10),
    source,
    relicDataStatus: "validated",
    verified: true,
    rotationId,
    statusHistory: withStatusTransitions(baseline, ["official-data-available", "validated", "ready-for-review"], discoveredAt),
    reviewReason: lineup.previewEvidence
      ? "Announced pair-specific Vault export, drop table, and recipes passed validation before activation; sale inventory and price remain unobserved. Ready for human review."
      : "Official World State inventory, drop table, and Public Export data passed validation; ready for human review."
  };
  const candidates = candidateData.candidates.filter((candidate) => candidate.id !== upgraded.id);
  candidates.push(upgraded);
  candidates.sort((left, right) => String(left.effectiveAt || left.effectiveDate || "9999-12-31").localeCompare(String(right.effectiveAt || right.effectiveDate || "9999-12-31")) || left.id.localeCompare(right.id));
  return { ...clone(candidateData), candidates };
}

function recordAnnouncementConflict(candidateData, candidate, lineup, discoveredAt) {
  const conflict = {
    ...clone(candidate),
    status: "conflict",
    source: {
      ...clone(candidate.source),
      conflict: {
        worldState: officialRotationEvidence(lineup, discoveredAt)
      }
    },
    relicDataStatus: "conflict",
    verified: false,
    statusHistory: withStatusTransition(candidate, "conflict", discoveredAt),
    reviewReason: `Official World State inventory lists ${lineup.warframes.map((item) => item.name).join(" & ")}, which conflicts with the announced ${candidate.primeWarframes.join(" & ")}. Automatic upgrade stopped.`,
  };
  delete conflict.rotationId;
  const candidates = candidateData.candidates.map((entry) => entry.id === candidate.id ? conflict : clone(entry));
  return { ...clone(candidateData), candidates };
}

function recipeExceptionProvenance(requirements) {
  return [...requirements.values()]
    .map((requirement) => requirement.provenance)
    .filter((provenance) => provenance?.status === "curated-manual")
    .map((provenance) => clone(provenance))
    .sort((left, right) => left.itemId.localeCompare(right.itemId));
}

function rarityWarningsFor(selectedRelics) {
  return selectedRelics.flatMap((relic) => relic.targetRewards
    .filter((reward) => reward.rarityDisagreement)
    .map((reward) => `${relic.name} / ${reward.itemName} ${reward.partName}: official label ${reward.sourceRarity}, intact probability ${reward.probability}% maps to ${reward.rarity}`));
}

function sourceRecords({ announcement, recipeUrl, preparedAt, recipeExceptions, rarityWarnings, lineup }) {
  const common = {
    status: "provisional",
    rotationUrl: lineup.previewEvidence?.url || OFFICIAL_SOURCES.worldState,
    ...(lineup.previewEvidence ? { vaultExport: lineup.previewEvidence } : { inventory: lineup.inventoryEvidence }),
    announcementUrl: announcement.url,
    dropTableUrl: OFFICIAL_SOURCES.dropTables,
    recipeExportUrl: recipeUrl,
    preparedAt,
    ...(recipeExceptions.length ? { recipeExceptions } : {}),
    ...(rarityWarnings.length ? { rarityWarnings } : {})
  };
  return {
    rotation: {
      ...common,
      note: lineup.previewEvidence
        ? "公告与 Public Export 的战甲组合专属 Vault 遗物组对应；奖励、概率和配方经官方原始数据交叉校验。实际商店与价格尚未观测；costAya=1 与 ayaBudget 为规划器预设。候选可提前审核，published 后仍按 startsAt 生效。"
        : "官方 World State Manifest 确认售卖阵容和遗物清单；warframe.com 官方公告确认生效时间；官方掉落表的数值概率决定规划器 rarity。制造数量优先来自 Public Export；若官方 export 确认缺失，只允许使用显式 curated-manual exception。ayaBudget 仍只是 Varzia 产品预设。此候选不会自动发布。"
    },
    primes: {
      ...common,
      note: lineup.previewEvidence
        ? "装备与部件从公告组合专属 Vault 遗物组、官方掉落表和 Public Export 关联；尚未声明实际商店库存。"
        : "装备和部件映射来自官方 World State、Public Export 与掉落表；制造数量的 Public Export 与 curated-manual evidence 分开记录，候选只供人工 Review。"
    },
    relics: {
      status: common.status,
      rotationUrl: common.rotationUrl,
      ...(lineup.previewEvidence ? { vaultExport: common.vaultExport } : { inventory: common.inventory }),
      announcementUrl: common.announcementUrl,
      dropTableUrl: common.dropTableUrl,
      preparedAt,
      ...(rarityWarnings.length ? { rarityWarnings } : {}),
      note: "遗物奖励和 route-specific rarity 来自官方 Drop Tables；Forma 等非目标奖励继续按现有规划器规则忽略。"
    }
  };
}

function totalRequired(requirements) {
  return [...requirements.values()].reduce((total, requirement) => (
    total + [...requirement.quantities.values()].reduce((sum, count) => sum + count, 0)
  ), 0);
}

function comparePublishedFacts({ rotation, primeData, relicData, lineup, selectedRelics, requirements, announcement }) {
  invariant(rotation.publicationStatus === "published", `Rotation ${rotation.id} is not published.`);
  invariant(rotation.startsAt === announcement.startsAt, `Published startsAt differs from official announcement for ${rotation.id}.`);
  const itemIds = lineup.items.map((item) => slugify(item.name));
  invariant(sameSet(rotation.items, itemIds), `Published item lineup differs from the official inventory for ${rotation.id}.`);
  const selectedRelicIds = selectedRelics.map((relic) => relicId(relic.name));
  invariant(sameSet(rotation.relics, selectedRelicIds), `Published relic set differs from official Drop Tables for ${rotation.id}.`);
  const itemMap = new Map(primeData.primeItems.map((item) => [item.id, item]));
  const relicMap = new Map(relicData.relics.map((relic) => [relic.id, relic]));
  const routes = routeMapForItems(selectedRelics);
  for (const itemId of itemIds) {
    const item = itemMap.get(itemId);
    invariant(item, `Published catalog is missing ${itemId}.`);
    const requirement = requirements.get(itemId);
    const expectedParts = routes.get(itemId);
    invariant(item.parts.length === expectedParts.size, `Published part count differs for ${itemId}.`);
    for (const part of item.parts) {
      invariant(requirement.quantities.get(part.id) === part.required, `Published recipe quantity differs for ${itemId}/${part.id}.`);
      const expectedRoutes = expectedParts.get(part.id) || [];
      const actualRoutes = part.relics.filter((id) => selectedRelicIds.includes(id));
      invariant(sameSet(actualRoutes, expectedRoutes.map((route) => route.relicId)), `Published relic routes differ for ${itemId}/${part.id}.`);
      for (const route of expectedRoutes) {
        const reward = relicMap.get(route.relicId)?.rewards.find((entry) => entry.itemId === itemId && entry.partId === part.id);
        invariant(reward?.rarity === route.rarity, `Published rarity differs for ${route.relicId}/${itemId}/${part.id}.`);
      }
    }
  }
}

function mergeCandidate({ rotationData, primeData, relicData, lineup, selectedRelics, requirements, announcement, recipeUrl }) {
  const candidateId = candidateIdFor(lineup, announcement.startsAt);
  const oldCandidate = rotationData.rotations.find((rotation) => rotation.id === candidateId);
  invariant(!oldCandidate || oldCandidate.publicationStatus === "provisional", `Automation refuses to modify published rotation ${candidateId}.`);
  const oldRelicIds = new Set(oldCandidate?.relics || []);
  const originalItems = new Map(primeData.primeItems.map((item) => [item.id, clone(item)]));
  const selectedItemIds = new Set(lineup.items.map((item) => slugify(item.name)));
  const routes = routeMapForItems(selectedRelics);
  const selectedRelicIds = selectedRelics.map((relic) => relicId(relic.name));
  const preparedAt = oldCandidate?.source?.preparedAt
    || primeData.provisionalSources?.[candidateId]?.preparedAt
    || new Date(announcement.createdAt).toISOString().slice(0, 10);
  const recipeExceptions = recipeExceptionProvenance(requirements);
  const rarityWarnings = rarityWarningsFor(selectedRelics);
  const sources = sourceRecords({ announcement, recipeUrl, preparedAt, recipeExceptions, rarityWarnings, lineup });

  const rebuiltItems = new Map();
  for (const pageItem of lineup.items) {
    const itemId = slugify(pageItem.name);
    const existing = originalItems.get(itemId);
    invariant(!existing || existing.type === pageItem.type, `Official item type changed for ${itemId}.`);
    const originStatus = existing && rotationData.rotations.find((rotation) => rotation.id === existing.rotation)?.publicationStatus;
    invariant(!existing || existing.rotation === candidateId, `Candidate cannot reuse catalog item ${itemId} owned by ${originStatus || "unknown"} rotation ${existing?.rotation || "missing"}.`);
    const requirement = requirements.get(itemId);
    const expectedRoutes = routes.get(itemId);
    const existingPartMap = new Map((existing?.parts || []).map((part) => [part.id, part]));
    const expectedPartIds = [...expectedRoutes.keys()];
    const orderedPartIds = existing && sameSet(existing.parts.map((part) => part.id), expectedPartIds)
      ? existing.parts.map((part) => part.id)
      : requirement.order;
    const parts = orderedPartIds.map((partId) => {
      const existingPart = existingPartMap.get(partId);
      const newRoutes = expectedRoutes.get(partId) || [];
      invariant(newRoutes.length > 0, `Candidate has no relic route for ${itemId}/${partId}.`);
      const required = requirement.quantities.get(partId);
      const chinesePartName = existingPart?.name || PART_ZH[partId];
      invariant(chinesePartName, `No curated Chinese part name exists for ${itemId}/${partId}; human review is required.`);
      const historicalRoutes = (existingPart?.relics || []).filter((id) => !oldRelicIds.has(id));
      return {
        ...(existingPart || {}),
        id: partId,
        name: chinesePartName,
        nameEn: newRoutes[0].partName,
        required,
        rarity: newRoutes[0].rarity,
        relics: [...new Set([...historicalRoutes, ...newRoutes.map((route) => route.relicId)])]
      };
    });
    const historicalItemRelics = (existing?.relics || []).filter((id) => !oldRelicIds.has(id));
    rebuiltItems.set(itemId, {
      ...(existing || {}),
      id: itemId,
      name: existing?.name || pageItem.chineseName,
      nameEn: pageItem.name,
      type: pageItem.type,
      rotation: candidateId,
      relics: [...new Set([...historicalItemRelics, ...selectedRelicIds.filter((id) => parts.some((part) => part.relics.includes(id)))])],
      parts
    });
  }

  const primeItems = [];
  for (const item of primeData.primeItems) {
    if (item.rotation === candidateId && !selectedItemIds.has(item.id)) continue;
    primeItems.push(rebuiltItems.get(item.id) || clone(item));
    rebuiltItems.delete(item.id);
  }
  for (const pageItem of lineup.items) {
    const item = rebuiltItems.get(slugify(pageItem.name));
    if (item) primeItems.push(item);
  }

  const existingRelicMap = new Map(relicData.relics.map((relic) => [relic.id, relic]));
  const newRelics = selectedRelics.map((sourceRelic) => {
    const id = relicId(sourceRelic.name);
    const existing = existingRelicMap.get(id);
    invariant(!existing || existing.rotation === candidateId, `Relic ${id} already belongs to another rotation; human schema review is required.`);
    const [era, code] = sourceRelic.name.split(" ");
    invariant(ERA_ZH[era] && code, `Unsupported relic name: ${sourceRelic.name}`);
    return {
      ...(existing || {}),
      id,
      name: existing?.name || `${ERA_ZH[era]} ${code}`,
      nameEn: sourceRelic.name,
      era: existing?.era || ERA_ZH[era],
      eraEn: era,
      costAya: existing?.costAya ?? 1,
      rotation: candidateId,
      rewards: sourceRelic.targetRewards.map((reward) => ({ itemId: reward.itemId, partId: reward.partId, rarity: reward.rarity }))
    };
  });
  const relics = relicData.relics.filter((relic) => relic.rotation !== candidateId);
  relics.push(...newRelics);

  const defaults = oldCandidate?.defaults ? clone(oldCandidate.defaults) : undefined;
  const candidate = {
    id: candidateId,
    publicationStatus: "provisional",
    source: sources.rotation,
    displayName: lineup.warframes.map((item) => item.chineseName).join(" 与 "),
    displayNameEn: lineup.warframes.map((item) => item.name).join(" & "),
    startsAt: announcement.startsAt,
    items: lineup.items.map((item) => slugify(item.name)),
    relics: selectedRelicIds,
    ...(defaults ? { defaults } : {})
  };
  const rotations = rotationData.rotations.filter((rotation) => rotation.id !== candidateId);
  rotations.push(candidate);
  rotations.sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt));

  const provisionalSourcesForPrimes = { ...(primeData.provisionalSources || {}), [candidateId]: sources.primes };
  const provisionalSourcesForRelics = { ...(relicData.provisionalSources || {}), [candidateId]: sources.relics };
  return {
    candidate,
    rotationData: { ...clone(rotationData), rotations },
    primeData: { ...clone(primeData), provisionalSources: provisionalSourcesForPrimes, primeItems },
    relicData: { ...clone(relicData), provisionalSources: provisionalSourcesForRelics, relics },
    totalRequiredParts: totalRequired(requirements)
  };
}

function productionProjection(rotationData, primeData, relicData) {
  const itemMap = new Map(primeData.primeItems.map((item) => [item.id, item]));
  const relicMap = new Map(relicData.relics.map((relic) => [relic.id, relic]));
  return publishedRotations(rotationData.rotations).map((rotation) => {
    const rotationRelics = new Set(rotation.relics);
    return {
      rotation,
      items: rotation.items.map((itemId) => {
        const item = clone(itemMap.get(itemId));
        item.relics = item.relics.filter((id) => rotationRelics.has(id));
        item.parts = item.parts.map((part) => ({ ...part, relics: part.relics.filter((id) => rotationRelics.has(id)) }));
        return item;
      }),
      relics: rotation.relics.map((id) => relicMap.get(id))
    };
  });
}

function validateIsolation(before, after, candidate, requirements) {
  validateRotationData(after.rotationData, after.primeData, after.relicData);
  invariant(candidate.publicationStatus === "provisional", "Generated candidate is not provisional.");
  invariant(candidate.source?.status === "provisional", "Generated candidate provenance is not provisional.");
  invariant(after.rotationData.lastVerified === before.rotationData.lastVerified, "Automation changed lastVerified.");
  invariant(after.primeData.updatedAt === before.primeData.updatedAt, "Automation changed primes updatedAt.");
  invariant(after.relicData.updatedAt === before.relicData.updatedAt, "Automation changed relics updatedAt.");
  const beforePublished = publishedRotations(before.rotationData.rotations);
  const afterPublished = publishedRotations(after.rotationData.rotations);
  invariant(JSON.stringify(beforePublished) === JSON.stringify(afterPublished), "Published rotation entries changed during candidate generation.");
  invariant(
    JSON.stringify(productionProjection(before.rotationData, before.primeData, before.relicData))
      === JSON.stringify(productionProjection(after.rotationData, after.primeData, after.relicData)),
    "Published rotation data view changed during candidate generation."
  );
  const resolved = resolveRotationState(afterPublished, Date.parse(candidate.startsAt) + 1);
  invariant(resolved.activeRotation?.id !== candidate.id, "Provisional candidate entered the published schedule.");
  const itemMap = new Map(after.primeData.primeItems.map((item) => [item.id, item]));
  const expectedExceptionIds = [...requirements.values()]
    .filter((requirement) => requirement.provenance?.status === "curated-manual")
    .map((requirement) => requirement.provenance.itemId)
    .sort();
  const recordedExceptionIds = (candidate.source?.recipeExceptions || []).map((exception) => exception.itemId).sort();
  invariant(JSON.stringify(recordedExceptionIds) === JSON.stringify(expectedExceptionIds), "Candidate recipe exception provenance does not match computed requirements.");
  for (const itemId of candidate.items) {
    const item = itemMap.get(itemId);
    const expected = requirements.get(itemId)?.quantities;
    invariant(item && expected, `Candidate recipe evidence is missing for ${itemId}.`);
    for (const part of item.parts) invariant(expected.get(part.id) === part.required, `Candidate required quantity is not recipe-derived: ${itemId}/${part.id}.`);
  }
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function unlinkIfPresent(filePath) {
  try {
    await unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function syncParentDirectory(filePath) {
  let handle;
  try {
    handle = await open(path.dirname(filePath), "r");
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR"].includes(error?.code)) throw error;
  } finally {
    await handle?.close();
  }
}

async function writeSyncedFile(filePath, text, mode) {
  const handle = await open(filePath, "wx", mode);
  try {
    await handle.chmod(mode);
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeAtomically(files) {
  const prepared = [];
  const committed = [];
  try {
    for (const [index, file] of files.entries()) {
      const mode = (await stat(file.path)).mode & 0o777;
      const temporary = `${file.path}.prime-resurgence-sync-${process.pid}-${index}.tmp`;
      const preparedFile = { ...file, temporary, mode, index };
      prepared.push(preparedFile);
      await writeSyncedFile(temporary, file.text, mode);
    }
    for (const file of prepared) {
      await rename(file.temporary, file.path);
      committed.push(file);
      await syncParentDirectory(file.path);
    }
  } catch (error) {
    const recoveryErrors = [];
    for (const file of [...committed].reverse()) {
      const restorePath = `${file.path}.prime-resurgence-sync-${process.pid}-${file.index}.restore.tmp`;
      try {
        await unlinkIfPresent(restorePath);
        await writeSyncedFile(restorePath, file.original, file.mode);
        await rename(restorePath, file.path);
        await syncParentDirectory(file.path);
      } catch (recoveryError) {
        recoveryErrors.push(`rollback ${file.label || file.path}: ${recoveryError.message}`);
      } finally {
        try {
          await unlinkIfPresent(restorePath);
        } catch (cleanupError) {
          recoveryErrors.push(`cleanup ${restorePath}: ${cleanupError.message}`);
        }
      }
    }
    for (const file of prepared) {
      try {
        await unlinkIfPresent(file.temporary);
      } catch (cleanupError) {
        recoveryErrors.push(`cleanup ${file.temporary}: ${cleanupError.message}`);
      }
    }
    const recoverySuffix = recoveryErrors.length ? ` Recovery errors: ${recoveryErrors.join("; ")}` : " Rollback and cleanup completed.";
    throw new PrimeResurgenceSyncError(`Candidate file write failed: ${error.message}.${recoverySuffix}`);
  }
}

export async function fetchResource(fetchImpl, url, { binary = false, finalHosts, maximumBytes }) {
  const response = await fetchImpl(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
    headers: { Accept: binary ? "application/octet-stream,*/*;q=0.8" : "text/html,application/json;q=0.9,*/*;q=0.8", "User-Agent": "Varzia-Prime-Resurgence-Sync/1.0" }
  });
  invariant(response.ok, `Official source returned HTTP ${response.status}: ${url}`);
  const finalUrl = new URL(response.url || url);
  invariant(finalUrl.protocol === "https:" && finalHosts.includes(finalUrl.hostname), `Official source redirected to an unapproved host: ${finalUrl.hostname}`);
  const declaredLength = Number(response.headers?.get?.("content-length"));
  invariant(!Number.isFinite(declaredLength) || declaredLength <= maximumBytes, `Official source declared an unsafe size: ${url} (${declaredLength} bytes).`);
  const chunks = [];
  let size = 0;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        invariant(size <= maximumBytes, `Official source size is unsafe: ${url} (more than ${maximumBytes} bytes).`);
        chunks.push(Buffer.from(value));
      }
    } catch (error) {
      await reader.cancel(error).catch(() => {});
      throw error;
    }
  } else {
    const fallback = Buffer.from(await response.arrayBuffer());
    size = fallback.length;
    chunks.push(fallback);
  }
  const buffer = Buffer.concat(chunks, size);
  invariant(buffer.length > 0 && buffer.length <= maximumBytes, `Official source size is unsafe: ${url} (${buffer.length} bytes).`);
  return binary ? buffer : buffer.toString("utf8");
}

export async function fetchOfficialRotationPages({ fetchImpl = globalThis.fetch } = {}) {
  const [englishHtml, chineseHtml] = await Promise.all([
    fetchResource(fetchImpl, OFFICIAL_SOURCES.rotationEn, { finalHosts: ["www.warframe.com"], maximumBytes: 1_000_000 }),
    fetchResource(fetchImpl, OFFICIAL_SOURCES.rotationZh, { finalHosts: ["www.warframe.com"], maximumBytes: 1_000_000 })
  ]);
  return { englishHtml, chineseHtml };
}

export async function fetchOfficialRotationData({ fetchImpl = globalThis.fetch, decompress = decompressLzma } = {}) {
  const content = (url, options = {}) => fetchResource(fetchImpl, url, { finalHosts: ["content.warframe.com"], maximumBytes: 20_000_000, ...options });
  const [dropTablesHtml, ...indexes] = await Promise.all([
    fetchResource(fetchImpl, OFFICIAL_SOURCES.dropTables, {
      finalHosts: ["www.warframe.com", "warframe-web-assets.nyc3.cdn.digitaloceanspaces.com"], maximumBytes: 10_000_000
    }),
    ...["en", "zh"].map(async locale => decompress(await content(`https://content.warframe.com/PublicExport/index_${locale}.txt.lzma`, { binary: true, maximumBytes: 1_000_000 })))
  ]);
  const exportUrls = {};
  const readExport = async (type, locale) => {
    const prefix = `Export${type}_${locale}.json!`;
    const matches = indexes[locale === "en" ? 0 : 1].split(/\r?\n/).filter(line => line.startsWith(prefix));
    invariant(matches.length === 1 && /^[A-Za-z0-9_.!+-]+$/.test(matches[0]), `Missing or ambiguous Public Export manifest: ${prefix}`);
    const url = `https://content.warframe.com/PublicExport/Manifest/${matches[0]}`;
    exportUrls[`${type}_${locale}`] = url;
    const text = await content(url);
    const records = JSON.parse(text)[`Export${type}`];
    invariant(Array.isArray(records) && records.length > 0, `Malformed Public Export: ${url}`);
    return { text, records };
  };
  const [recipes, relics, en, zh] = await Promise.all([
    readExport("Recipes", "en"), readExport("RelicArcane", "en"),
    Promise.all(["Warframes", "Weapons", "Sentinels"].map(type => readExport(type, "en"))),
    Promise.all(["Warframes", "Weapons", "Sentinels"].map(type => readExport(type, "zh")))
  ]);
  return { dropTablesHtml, recipesText: recipes.text, recipeUrl: exportUrls.Recipes_en,
    relicExport: relics.records, equipmentEn: en.flatMap(item => item.records), equipmentZh: zh.flatMap(item => item.records), exportUrls };
}

async function fetchWorldState(fetchImpl) {
  return fetchResource(fetchImpl, OFFICIAL_SOURCES.worldState, { finalHosts: ["api.warframe.com"], maximumBytes: 10_000_000 });
}

async function fetchInventoryInputs({ fetchImpl = globalThis.fetch, decompress = decompressLzma, worldStateText } = {}) {
  const [world, data, pages] = await Promise.all([
    Promise.resolve(worldStateText ?? fetchWorldState(fetchImpl))
      .then(worldStateText => ({ worldStateText }))
      .catch(error => ({ worldStateWarning: `World State unavailable: ${safeErrorMessage(error)}` })),
    fetchOfficialRotationData({ fetchImpl, decompress }),
    fetchOfficialRotationPages({ fetchImpl }).catch(error => ({ pageWarning: `Auxiliary page unavailable: ${safeErrorMessage(error)}` }))
  ]);
  return { ...data, ...pages, ...world };
}

export async function fetchOfficialAnnouncementInputs({ fetchImpl = globalThis.fetch, decompress = decompressLzma } = {}) {
  const [inventoryInputs, announcementText] = await Promise.all([
    fetchInventoryInputs({ fetchImpl, decompress }),
    fetchResource(fetchImpl, OFFICIAL_SOURCES.announcementFeed, { finalHosts: ["public.api.bsky.app"], maximumBytes: 5_000_000 })
  ]);
  return { ...inventoryInputs, announcementText };
}

export async function fetchOfficialInputs(options = {}) {
  return fetchOfficialAnnouncementInputs(options);
}

function inventoryLineup(official, now) {
  invariant(official.worldStateText, official.worldStateWarning || "World State inventory is missing.");
  const trader = parsePrimeVaultTrader(JSON.parse(official.worldStateText), now);
  invariant(trader.active, "World State inventory is expired or not active yet; refusing to prepare a rotation.");
  return lineupFromInventory(trader, official);
}

function prepareAnnouncementCatalog(candidate, official) {
  const items = candidate.primeWarframes.map(name => {
    const matches = official.equipmentEn.filter(item => item.name === name && item.productCategory === "Suits");
    invariant(matches.length <= 1, `Ambiguous Public Export Warframe: ${name}.`);
    return matches.length ? { name, type: "warframe" } : null;
  });
  if (items.some(item => !item)) return { status: "pending equipment export", itemCount: items.filter(Boolean).length };
  const relics = parseDropTables(official.dropTablesHtml);
  const matching = relics.filter(relic => relic.rewards.some(reward => items.some(item => reward.name.startsWith(`${item.name} `))));
  const selection = selectRelicSet(relics, items, matching.map(relic => relic.name));
  const requirements = resolveRecipeRequirements(parseRecipes(official.recipesText), items, selection.expectedByItem, { recipeUrl: official.recipeUrl });
  return { status: "catalog validated; pair-specific Vault export or sale inventory still pending", itemCount: items.length, totalRequiredParts: totalRequired(requirements), matchingHistoricalRelics: matching.length, expectedVaultGroups: vaultGroupsFor(candidate.primeWarframes), recipeUrl: official.recipeUrl };
}

function checkAuxiliaryPage(official, lineup, rotationData, primeData) {
  if (official.pageWarning) return official.pageWarning;
  let page;
  try { page = parsePrimeResurgencePages(official.englishHtml, official.chineseHtml); }
  catch (error) { return `Auxiliary page could not be parsed: ${safeErrorMessage(error)}`; }
  if (sameSet(page.items.map(item => item.name), lineup.items.map(item => item.name))) return null;
  if (pageMatchesPublishedLineup(page, rotationData, primeData)) return lineup.previewEvidence
    ? "Auxiliary page still shows the previous published rotation; the pair-specific Vault export supports prelaunch preparation."
    : "Auxiliary page still shows the previous published rotation; World State inventory is authoritative.";
  invariant(false, "Auxiliary official page conflicts with the selected official lineup and known published rotations; human review is required.");
}

function upcomingAnnouncement(announcements, currentAnnouncement) {
  if (!currentAnnouncement?.startsAt) return null;
  return announcements.find((announcement) => announcement.startsAt && Date.parse(announcement.startsAt) > Date.parse(currentAnnouncement.startsAt)) || null;
}

export function escapeMarkdownInline(value) {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/([\\`*_\[\]{}<>#+!|])/g, "\\$1");
}

function markdownSummary(result) {
  const inline = escapeMarkdownInline;
  const lines = ["## Prime Resurgence sync", ""];
  if (result.publishedVerification) lines.push(`- Published preview verified against live inventory: ${inline(result.publishedVerification)}`);
  if (result.watcher) {
    const watcher = result.watcher;
    lines.push("### Prime Resurgence near-rotation watcher", "");
    lines.push(`- Candidate: ${inline(watcher.candidateId || "none")}`);
    lines.push(`- Effective: ${inline(watcher.effectiveAt || "pending")}`);
    if (watcher.window) {
      lines.push(`- Watch window: ${inline(watcher.window.startsAt)} through ${inline(watcher.window.endsAt)}`);
    }
    lines.push(`- Current: ${inline(watcher.current)}`);
    lines.push(`- Eligible: ${watcher.eligible ? "yes" : "no"}`);
    if (watcher.reason) lines.push(`- Reason: ${inline(watcher.reason)}`);
    lines.push(`- Official rotation changed: ${watcher.officialRotationChanged === null ? "not checked" : watcher.officialRotationChanged ? "yes" : "no"}`);
    lines.push(`- External requests: ${watcher.externalRequests}`);
    lines.push(`- Result: ${inline(result.status)}`);
    if (result.status === "NO_OP") return `${lines.join("\n")}\n`;
    lines.push("");
  }
  if (result.candidateStage === "terminal") {
    lines.push(`- Result: NO_OP (${inline(result.candidate.status)} is terminal)`);
    lines.push(`- Candidate ID: ${inline(result.candidate.id)}`);
    lines.push(result.officialDataChecked
      ? "- Official relic data checked; terminal candidate remains unchanged."
      : "- Official relic data request: skipped");
    lines.push("- Candidate diff: empty");
    return `${lines.join("\n")}\n`;
  }
  if (result.candidateStage === "announced") {
    lines.push(`- Result: ${inline(result.status)}`);
    lines.push(`- Candidate ID: ${inline(result.candidate.id)}`);
    lines.push(`- Officially announced Prime Warframes: ${inline(result.candidate.primeWarframes.join(" & "))}`);
    lines.push(`- Effective at: ${inline(result.candidate.effectiveAt || "pending (official announcement supplied no time)")}`);
    lines.push(`- Official announcement: ${inline(result.candidate.source.url)}`);
    lines.push(`- Announcement published: ${inline(result.candidate.source.publishedAt)}`);
    lines.push(`- Discovered: ${inline(result.candidate.source.discoveredAt)}`);
    lines.push("- Relic data: pending pair-specific Vault export or official rotation inventory");
    if (result.catalogPreparation) {
      const prepared = result.catalogPreparation;
      lines.push(`- Early catalog preparation: ${inline(prepared.status)}`);
      lines.push(`- Prepared Warframes: ${prepared.itemCount}; required parts: ${prepared.totalRequiredParts ?? "pending"}; historical relics: ${prepared.matchingHistoricalRelics ?? "pending"}`);
      if (prepared.recipeUrl) lines.push(`- Prepared recipe source: ${inline(prepared.recipeUrl)}`);
      lines.push("- Historical reward routes are not treated as this rotation’s sale inventory.");
      if (prepared.expectedVaultGroups) lines.push(`- Missing exact Vault group: ${inline(prepared.expectedVaultGroups.join(" or "))}`);
    }
    lines.push("- Verified: false");
    if (result.changedFiles.length) lines.push(`- Candidate diff: ${result.changedFiles.join(", ")}`);
    else lines.push("- Candidate diff: empty");
    lines.push("", "Candidate state flow: announced → official-data-available → validated → ready-for-review.");
    lines.push("This announcement candidate does not modify production rotation data or generate relic mappings.");
    return `${lines.join("\n")}\n`;
  }
  if (result.candidateStage === "conflict") {
    lines.push("- Result: CONFLICT / review required");
    lines.push(`- Candidate ID: ${inline(result.candidate.id)}`);
    lines.push(`- Announced Prime Warframes: ${inline(result.candidate.primeWarframes.join(" & "))}`);
    const evidence = result.candidate.source.conflict.worldState || result.candidate.source.conflict.officialRotationPage;
    lines.push(`- Official inventory Prime Warframes: ${inline(evidence.rawPrimeWarframes.join(" & "))}`);
    lines.push(`- Review reason: ${inline(result.candidate.reviewReason)}`);
    lines.push(`- Announcement source: ${inline(result.candidate.source.url)}`);
    lines.push(`- Official inventory source: ${inline(evidence.url)}`);
    if (result.changedFiles.length) lines.push(`- Candidate diff: ${result.changedFiles.join(", ")}`);
    else lines.push("- Candidate diff: empty");
    lines.push("", "Automatic candidate upgrade stopped. Production rotation data modification: none.");
    return `${lines.join("\n")}\n`;
  }
  lines.push(`- Result: ${inline(result.status)}`);
  lines.push(`- Official ${result.vaultExport ? "Vault export" : "inventory"} rotation: ${inline(result.rotationName)}`);
  lines.push(`- Effective at: ${inline(result.startsAt)}`);
  lines.push(`- Prime/item count: ${inline(result.itemCount)}`);
  lines.push(`- Relic count: ${inline(result.relicCount)}`);
  lines.push(`- Computed required parts: ${inline(result.totalRequiredParts)}`);
  lines.push(`- Publication status: ${inline(result.publicationStatus)}`);
  lines.push(`- Public Export recipe coverage: ${inline(result.publicExportRecipeItems)}/${inline(result.itemCount)} items`);
  if (result.vaultExport?.incidentalItemNames?.length) {
    lines.push(`- Incidental Prime rewards outside the featured lineup: ${inline(result.vaultExport.incidentalItemNames.join(", "))}`);
  }
  if (result.recipeExceptions.length) {
    lines.push(`- Curated/manual recipe exceptions: ${inline(result.recipeExceptions.map((entry) => `${entry.itemId} (sourceUrl: null; Public Export status: missing)`).join(", "))}`);
  } else {
    lines.push("- Curated/manual recipe exceptions: none");
  }
  if (result.rarityWarnings.length) {
    lines.push("- Rarity audit warnings:");
    for (const warning of result.rarityWarnings) lines.push(`  - ${inline(warning)}`);
  } else {
    lines.push("- Rarity audit warnings: none");
  }
  if (result.candidate) lines.push(`- Candidate state: ${inline(result.candidate.status)} (${inline(result.candidate.relicDataStatus)}; verified: ${inline(result.candidate.verified)})`);
  if (result.upcoming) lines.push(`- Next official announcement observed: ${inline(result.upcoming.warframes.join(" & "))} at ${inline(result.upcoming.startsAt || "pending official time")}; Prime Resurgence page confirmation is still pending.`);
  if (result.changedFiles.length) lines.push(`- Candidate diff: ${result.changedFiles.join(", ")}`);
  else lines.push("- Candidate diff: empty");
  lines.push("", "Official source mapping:");
  lines.push(`- Rotation selection source: ${result.vaultExport?.url || OFFICIAL_SOURCES.worldState}`);
  lines.push(`- Announcement: ${result.announcementUrl}`);
  lines.push(`- Relic rewards and rarity: ${OFFICIAL_SOURCES.dropTables}`);
  lines.push(`- Public Export recipe evidence: ${result.recipeUrl}`);
  lines.push("- A curated/manual exception is never described as Public Export verification.");
  lines.push("- ayaBudget: Varzia planner preset only; not verified by an official source.");
  lines.push(result.vaultExport
    ? "- costAya: planner preset of 1 Aya; actual sale price has not been observed."
    : "- costAya: checked against the World State inventory price (1 Aya).");
  if (result.vaultExport) {
    lines.push(`- Pair-specific Vault group: ${inline(result.vaultExport.group)}`);
    lines.push(`- Prepared relics: ${inline(result.vaultExport.relics.map(relic => relic.name).join(", "))}`);
    lines.push("- Complete data may be reviewed and published before startsAt; the scheduler activates it only at startsAt.");
  }
  if (result.worldStateWarning) lines.push(`- World State warning: ${inline(result.worldStateWarning)}`);
  if (result.inventory) {
    lines.push(`- Inventory valid from ${inline(result.inventory.startsAt)} through ${inline(result.inventory.endsAt)} (exclusive)`);
    lines.push(`- Inventory relics: ${inline(result.inventory.relics.map(relic => `${relic.name} (${relic.costAya} Aya)`).join(", "))}`);
    lines.push(`- Relic ID export: ${inline(result.inventory.exportUrls.RelicArcane_en)}`);
  }
  if (result.pageWarning) lines.push(`- Auxiliary page warning: ${inline(result.pageWarning)}`);
  lines.push("", "This PR does not publish the rotation automatically.");
  lines.push("Human review is required before changing it to published.");
  return `${lines.join("\n")}\n`;
}

export function failureSummary(error) {
  return [
    "## Prime Resurgence sync",
    "",
    "- Result: FAILED",
    `- Reason: ${escapeMarkdownInline(safeErrorMessage(error))}`,
    "- Production data modification: none",
    "- Pull request: not created or updated",
    "",
    "FAIL / NO PRODUCTION DATA MODIFICATION / NO PR WITH PARTIAL DATA",
    ""
  ].join("\n");
}

function safeErrorMessage(error) {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "The original failure could not be converted to text safely.";
  }
}

function announcementFromCandidate(candidate) {
  invariant(candidate?.status === "announced", "Near-rotation watcher can only consume an announced candidate.");
  invariant(candidate.effectiveAt, `Announcement candidate ${candidate.id} has no effectiveAt.`);
  return {
    warframes: [...candidate.primeWarframes],
    startsAt: candidate.effectiveAt,
    effectiveDate: candidate.effectiveDate || candidate.effectiveAt.slice(0, 10),
    rawEffectiveText: candidate.source.rawEffectiveText,
    url: candidate.source.url,
    createdAt: candidate.source.publishedAt
  };
}

async function completeOfficialCandidate({
  paths,
  rotationText,
  primesText,
  relicsText,
  candidatesText,
  rotationData,
  primeData,
  relicData,
  candidateData,
  recipeExceptions,
  lineup,
  announcement,
  published,
  upcoming = null,
  official,
  fetchImpl,
  decompress,
  dryRun,
  discoveredAt,
  minimumRelics,
  minimumRecipes,
  expectedCandidateId = null
}) {
  const officialData = official.dropTablesHtml
    ? official
    : { ...official, ...await fetchOfficialRotationData({ fetchImpl, decompress }) };
  const dropRelics = parseDropTables(officialData.dropTablesHtml, { minimumRelics });
  const selection = selectRelicSet(dropRelics, lineup.items, lineup.inventoryRelics.map(relic => relic.name));
  validateInventoryRewards(selection, lineup, officialData.relicExport);
  const recipes = parseRecipes(officialData.recipesText, { minimumRecipes });
  const requirements = resolveRecipeRequirements(recipes, lineup.items, selection.expectedByItem, {
    recipeExceptions,
    recipeUrl: officialData.recipeUrl
  });
  invariant(lineup.startsAt === announcement.startsAt, "Rotation activation differs from the official announcement; human review is required.");
  const usedRecipeExceptions = recipeExceptionProvenance(requirements);
  const rarityWarnings = rarityWarningsFor(selection.relics);
  const commonResult = {
    rotationName: lineup.warframes.map((item) => item.name).join(" & "),
    startsAt: announcement.startsAt,
    itemCount: lineup.items.length,
    relicCount: selection.relics.length,
    totalRequiredParts: totalRequired(requirements),
    announcementUrl: announcement.url,
    recipeUrl: officialData.recipeUrl,
    publicExportRecipeItems: lineup.items.length - usedRecipeExceptions.length,
    recipeExceptions: usedRecipeExceptions,
    rarityWarnings,
    upcoming,
    inventory: lineup.inventoryEvidence,
    vaultExport: lineup.previewEvidence,
    worldStateWarning: official.worldStateWarning || null,
    publishedVerification: official.publishedVerification || null,
    pageWarning: official.pageWarning || null,
    changedFiles: []
  };

  if (published) {
    comparePublishedFacts({ rotation: published, primeData, relicData, lineup, selectedRelics: selection.relics, requirements, announcement });
    const result = { ...commonResult, status: "no-change (official inventory matches the published rotation)", publicationStatus: "published", candidate: null };
    result.summary = markdownSummary(result);
    return result;
  }

  const merged = mergeCandidate({
    rotationData, primeData, relicData, lineup, selectedRelics: selection.relics,
    requirements, announcement, recipeUrl: officialData.recipeUrl
  });
  invariant(!expectedCandidateId || merged.candidate.id === expectedCandidateId, `Official data would change announcement candidate identity from ${expectedCandidateId} to ${merged.candidate.id}.`);
  validateIsolation({ rotationData, primeData, relicData }, merged, merged.candidate, requirements);
  const upgradedCandidates = upgradeAnnouncementCandidate(candidateData, {
    announcement,
    lineup,
    recipeUrl: officialData.recipeUrl,
    discoveredAt,
    rotationId: merged.candidate.id
  });
  validateAnnouncementCandidates(upgradedCandidates, merged.rotationData);
  const outputFiles = [
    { path: paths.rotation, label: SYNC_DATA_PATHS.rotation, original: rotationText, text: jsonText(merged.rotationData) },
    { path: paths.primes, label: SYNC_DATA_PATHS.primes, original: primesText, text: jsonText(merged.primeData) },
    { path: paths.relics, label: SYNC_DATA_PATHS.relics, original: relicsText, text: jsonText(merged.relicData) },
    { path: paths.candidates, label: SYNC_DATA_PATHS.candidates, original: candidatesText, text: jsonText(upgradedCandidates) }
  ];
  const changed = outputFiles.filter((file) => file.original !== file.text);
  if (!dryRun && changed.length) await writeAtomically(changed);
  const result = {
    ...commonResult,
    status: changed.length ? (dryRun ? "dry-run candidate changes detected" : "candidate updated") : "no-change (candidate is already current)",
    publicationStatus: merged.candidate.publicationStatus,
    changedFiles: changed.map((file) => file.label),
    candidateId: merged.candidate.id,
    candidate: upgradedCandidates.candidates.find((candidate) => candidate.id === merged.candidate.id)
  };
  result.summary = markdownSummary(result);
  return result;
}

function syncDataPaths(rootDir) {
  return Object.fromEntries(Object.entries(SYNC_DATA_PATHS).map(([key, relativePath]) => [key, path.join(rootDir, relativePath)]));
}

function nearWatcherResult(selection, {
  status = "NO_OP",
  officialRotationChanged = null,
  externalRequests = 0,
  candidate = selection.candidate || null
} = {}) {
  const watcher = {
    candidateId: candidate?.id || null,
    effectiveAt: candidate?.effectiveAt || null,
    window: selection.window || null,
    current: selection.current,
    eligible: selection.eligible,
    reason: selection.reason,
    officialRotationChanged,
    externalRequests
  };
  const result = { status, candidateStage: candidate?.status || null, candidate, changedFiles: [], watcher };
  result.summary = markdownSummary(result);
  return result;
}

export async function runNearRotationWatcher({
  rootDir,
  dryRun = false,
  fetchImpl = globalThis.fetch,
  decompress = decompressLzma,
  now = new Date(),
  minimumRelics = 100,
  minimumRecipes = 1_000
}) {
  invariant(rootDir, "Repository root is required.");
  const paths = syncDataPaths(rootDir);

  // This is intentionally the only repository read before eligibility is known:
  // hourly invocations must not initialize the formal data pipeline for a no-op.
  const candidatesText = await readFile(paths.candidates, "utf8");
  const candidateData = JSON.parse(candidatesText);
  validateAnnouncementCandidates(candidateData);
  const selection = selectNearRotationCandidate(candidateData, now);
  if (!selection.eligible) return nearWatcherResult(selection);

  const [rotationText, primesText, relicsText, recipeExceptionsText] = await Promise.all([
    readFile(paths.rotation, "utf8"),
    readFile(paths.primes, "utf8"),
    readFile(paths.relics, "utf8"),
    readFile(paths.recipeExceptions, "utf8")
  ]);
  const rotationData = JSON.parse(rotationText);
  const primeData = JSON.parse(primesText);
  const relicData = JSON.parse(relicsText);
  const recipeExceptions = parseRecipeExceptions(recipeExceptionsText);
  validateRotationData(rotationData, primeData, relicData);
  validateAnnouncementCandidates(candidateData, rotationData);
  const candidate = candidateData.candidates.find((entry) => entry.id === selection.candidate.id);
  invariant(candidate?.status === "announced", `Near-rotation candidate ${selection.candidate.id} changed before official inventory evaluation.`);

  const discoveredAt = new Date(now).toISOString();
  const requested = [];
  const trackedFetch = (url, options) => { requested.push(url); return fetchImpl(url, options); };
  const worldStateText = await fetchWorldState(trackedFetch);
  const trader = parsePrimeVaultTrader(JSON.parse(worldStateText), discoveredAt);
  if (!trader.active || Date.parse(trader.startsAt) < Date.parse(candidate.effectiveAt)) {
    return nearWatcherResult({ ...selection, reason: "rotation-inventory-pending" }, { officialRotationChanged: false, externalRequests: requested.length });
  }
  const pageInputs = await fetchInventoryInputs({ fetchImpl: trackedFetch, decompress, worldStateText });
  const lineup = inventoryLineup(pageInputs, discoveredAt);
  pageInputs.pageWarning = checkAuxiliaryPage(pageInputs, lineup, rotationData, primeData);

  if (pageMatchesPublishedLineup(lineup, rotationData, primeData)) {
    return nearWatcherResult(selection, {
      status: "NO_OP",
      officialRotationChanged: false,
      externalRequests: requested.length,
      candidate
    });
  }

  if (!sameWarframePair(candidate.primeWarframes, lineup.warframes)) {
    const conflictedCandidates = recordAnnouncementConflict(candidateData, candidate, lineup, discoveredAt);
    validateAnnouncementCandidates(conflictedCandidates, rotationData);
    const candidateText = jsonText(conflictedCandidates);
    const changed = candidateText === candidatesText
      ? []
      : [{ path: paths.candidates, label: SYNC_DATA_PATHS.candidates, original: candidatesText, text: candidateText }];
    if (!dryRun && changed.length) await writeAtomically(changed);
    const conflicted = conflictedCandidates.candidates.find((entry) => entry.id === candidate.id);
    const result = nearWatcherResult(selection, {
      status: "CONFLICT",
      officialRotationChanged: true,
      externalRequests: requested.length,
      candidate: conflicted
    });
    result.candidateStage = "conflict";
    result.officialPageWarframes = lineup.warframes.map((item) => item.name);
    result.changedFiles = changed.map((file) => file.label);
    result.summary = markdownSummary(result);
    return result;
  }

  const result = await completeOfficialCandidate({
    paths,
    rotationText,
    primesText,
    relicsText,
    candidatesText,
    rotationData,
    primeData,
    relicData,
    candidateData,
    recipeExceptions,
    lineup,
    announcement: announcementFromCandidate(candidate),
    published: null,
    official: pageInputs,
    fetchImpl,
    decompress,
    dryRun,
    discoveredAt,
    minimumRelics,
    minimumRecipes,
    expectedCandidateId: candidate.id
  });
  result.watcher = {
    candidateId: candidate.id,
    effectiveAt: candidate.effectiveAt,
    window: selection.window,
    current: selection.current,
    eligible: true,
    reason: null,
    officialRotationChanged: true,
    externalRequests: requested.length
  };
  result.summary = markdownSummary(result);
  return result;
}

export async function runPrimeResurgenceSync({
  rootDir,
  dryRun = false,
  fetchImpl = globalThis.fetch,
  decompress = decompressLzma,
  inputs = null,
  now = new Date()
}) {
  invariant(rootDir, "Repository root is required.");
  const paths = syncDataPaths(rootDir);
  const [rotationText, primesText, relicsText, candidatesText, recipeExceptionsText] = await Promise.all([
    readFile(paths.rotation, "utf8"), readFile(paths.primes, "utf8"), readFile(paths.relics, "utf8"), readFile(paths.candidates, "utf8"), readFile(paths.recipeExceptions, "utf8")
  ]);
  const rotationData = JSON.parse(rotationText);
  const primeData = JSON.parse(primesText);
  const relicData = JSON.parse(relicsText);
  const candidateData = JSON.parse(candidatesText);
  const recipeExceptions = parseRecipeExceptions(recipeExceptionsText);
  validateRotationData(rotationData, primeData, relicData);
  validateAnnouncementCandidates(candidateData, rotationData);

  const discoveredAt = new Date(now).toISOString();
  invariant(Number.isFinite(Date.parse(discoveredAt)), "Candidate discovery time is invalid.");

  const writeCandidateFiles = async (nextCandidateData, result) => {
    validateAnnouncementCandidates(nextCandidateData, rotationData);
    const candidateText = jsonText(nextCandidateData);
    const changed = candidateText === candidatesText
      ? []
      : [{ path: paths.candidates, label: SYNC_DATA_PATHS.candidates, original: candidatesText, text: candidateText }];
    if (!dryRun && changed.length) await writeAtomically(changed);
    result.changedFiles = changed.map((file) => file.label);
    result.publishedVerification = official?.publishedVerification || null;
    result.summary = markdownSummary(result);
    return result;
  };

  let official = inputs || { announcementText: await fetchResource(fetchImpl, OFFICIAL_SOURCES.announcementFeed, { finalHosts: ["public.api.bsky.app"], maximumBytes: 5_000_000 }) };
  const announcements = parseOfficialAnnouncements(JSON.parse(official.announcementText));
  const announcedCandidates = upsertAnnouncementCandidates(candidateData, announcements, rotationData, discoveredAt);
  const activeAnnouncements = announcedCandidates.candidates.filter((candidate) => candidate.status === "announced");
  const activePublished = resolveRotationState(publishedRotations(rotationData.rotations), Date.parse(discoveredAt)).activeRotation;
  const verifyPublishedPreview = Boolean(activePublished?.source?.vaultExport);
  const terminal = !activeAnnouncements.length && (announcedCandidates.candidates.find(candidate => candidate.status === "conflict")
    || announcedCandidates.candidates.find(candidate => candidate.status === "ready-for-review"));
  if (terminal && !verifyPublishedPreview) {
    return await writeCandidateFiles(announcedCandidates, {
      candidateStage: "terminal",
      status: "NO_OP",
      candidate: terminal,
      changedFiles: []
    });
  }
  if (!inputs) official = { ...official, ...await fetchInventoryInputs({ fetchImpl, decompress }) };
  if (verifyPublishedPreview) {
    const actual = inventoryLineup(official, discoveredAt);
    // Once a later, unreviewed rotation is live, continue normal discovery.
    // Until then, compare every published fact even if another preview is pending.
    if (Date.parse(actual.startsAt) <= Date.parse(activePublished.startsAt)) {
      await completeOfficialCandidate({
        paths, rotationText, primesText, relicsText, candidatesText,
        rotationData, primeData, relicData, candidateData: announcedCandidates,
        recipeExceptions, lineup: actual,
        announcement: { startsAt: activePublished.startsAt, url: activePublished.source.announcementUrl },
        published: activePublished, official, fetchImpl, decompress, dryRun, discoveredAt,
        minimumRelics: inputs ? 1 : 100, minimumRecipes: inputs ? 1 : 1_000
      });
      official.publishedVerification = activePublished.id;
    }
  }
  if (terminal) return await writeCandidateFiles(announcedCandidates, {
    candidateStage: "terminal", status: "NO_OP", candidate: terminal,
    officialDataChecked: true, changedFiles: []
  });
  // A future, announced rotation can be fully prepared from its exact Vault
  // group. The current trader/page may still show the previous rotation.
  const futureCandidate = activeAnnouncements.find(candidate => candidate.effectiveAt && Date.parse(candidate.effectiveAt) > Date.parse(discoveredAt));
  if (futureCandidate) {
    const dropRelics = parseDropTables(official.dropTablesHtml);
    const rawPreview = lineupFromVaultExport(futureCandidate, official, dropRelics);
    const preview = rawPreview && validateVaultRewardCatalog(rawPreview, dropRelics, official);
    if (preview) {
      official.pageWarning = checkAuxiliaryPage(official, preview, rotationData, primeData);
      return await completeOfficialCandidate({
        paths, rotationText, primesText, relicsText, candidatesText,
        rotationData, primeData, relicData, candidateData: announcedCandidates,
        recipeExceptions, lineup: preview, announcement: announcementFromCandidate(futureCandidate),
        published: null, official, fetchImpl, decompress, dryRun, discoveredAt,
        minimumRelics: inputs ? 1 : 100, minimumRecipes: inputs ? 1 : 1_000,
        expectedCandidateId: futureCandidate.id
      });
    }
  }
  const lineup = inventoryLineup(official, discoveredAt);
  const pageWarning = checkAuxiliaryPage(official, lineup, rotationData, primeData);
  const officialPageMatchesPublished = pageMatchesPublishedLineup(lineup, rotationData, primeData);
  const matchedCandidate = candidateForLineup(announcedCandidates, lineup);

  if (matchedCandidate?.status === "announced" && !matchedCandidate.effectiveAt) {
    return await writeCandidateFiles(announcedCandidates, {
      candidateStage: "announced",
      status: "announcement candidate is pending an explicit official start time",
      candidate: matchedCandidate,
      changedFiles: []
    });
  }

  if (officialPageMatchesPublished && matchedCandidate?.status === "announced") {
    return await writeCandidateFiles(announcedCandidates, {
      candidateStage: "announced",
      status: "announcement candidate recorded; pair-specific Vault export or sale inventory is pending",
      catalogPreparation: prepareAnnouncementCatalog(matchedCandidate, official),
      candidate: matchedCandidate,
      changedFiles: []
    });
  }

  if (officialPageMatchesPublished && !matchedCandidate && announcedCandidates.candidates.some((candidate) => candidate.status === "announced")) {
    const candidate = announcedCandidates.candidates.find((entry) => entry.status === "announced");
    return await writeCandidateFiles(announcedCandidates, {
      candidateStage: "announced",
      status: "announcement candidate recorded; pair-specific Vault export or sale inventory is pending",
      catalogPreparation: prepareAnnouncementCatalog(candidate, official),
      candidate,
      changedFiles: []
    });
  }

  if (!officialPageMatchesPublished && !matchedCandidate) {
    const pending = announcedCandidates.candidates.filter((candidate) => candidate.status === "announced" && candidate.effectiveAt);
    if (pending.length) {
      invariant(pending.length === 1, `Official inventory differs while ${pending.length} announced candidates are pending; refusing to choose a conflict target.`);
      const conflictedCandidates = recordAnnouncementConflict(announcedCandidates, pending[0], lineup, discoveredAt);
      const candidate = conflictedCandidates.candidates.find((entry) => entry.id === pending[0].id);
      return await writeCandidateFiles(conflictedCandidates, {
        candidateStage: "conflict",
        candidate,
        officialPageWarframes: lineup.warframes.map((item) => item.name),
        changedFiles: []
      });
    }
  }

  official.pageWarning = pageWarning;
  const { announcement, published } = announcementForLineup(lineup, announcements, rotationData);
  const upcoming = upcomingAnnouncement(announcements, announcement);
  return await completeOfficialCandidate({
    paths,
    rotationText,
    primesText,
    relicsText,
    candidatesText,
    rotationData,
    primeData,
    relicData,
    candidateData: announcedCandidates,
    recipeExceptions,
    lineup,
    announcement,
    published,
    upcoming,
    official,
    fetchImpl,
    decompress,
    dryRun,
    discoveredAt,
    minimumRelics: inputs ? 1 : 100,
    minimumRecipes: inputs ? 1 : 1_000
  });
}
