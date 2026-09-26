import { readFileSync } from "node:fs";
import { EQUIPMENT_TYPE_BY_CATEGORY } from "./prime-vault-inventory.mjs";

export const FEATURED_EQUIPMENT_CATALOG_URL = new URL("../catalogs/prime-featured-equipment.json", import.meta.url);

export function requireFeaturedCatalogEvidence(condition, message) {
  if (!condition) throw new Error(`${message} Update the curated featured equipment catalog from official evidence; human review is required.`);
}

export function validateFeaturedEquipmentCatalog(catalog) {
  requireFeaturedCatalogEvidence(catalog?.schemaVersion === 1, "Unsupported featured equipment catalog schemaVersion.");
  requireFeaturedCatalogEvidence(Array.isArray(catalog.entries) && catalog.entries.length > 0, "Featured equipment catalog entries are missing.");
  const names = new Set();
  const identifiers = new Set();
  for (const entry of catalog.entries) {
    requireFeaturedCatalogEvidence(Array.isArray(entry?.items) && entry.items.length === 2, "Each featured Warframe must declare two equipment items in catalog version 1.");
    for (const item of [entry.warframe, ...entry.items]) {
      requireFeaturedCatalogEvidence(typeof item?.name === "string" && /^[A-Z][A-Za-z0-9]*(?: [A-Za-z0-9]+)* Prime$/.test(item.name), "Invalid featured equipment catalog name.");
      requireFeaturedCatalogEvidence(typeof item.uniqueName === "string" && /^\/Lotus\/(?:[A-Za-z0-9_]+\/)*[A-Za-z0-9_]+$/.test(item.uniqueName), `Invalid featured equipment identifier for ${item.name}.`);
      requireFeaturedCatalogEvidence(!names.has(item.name.toLowerCase()) && !identifiers.has(item.uniqueName.toLowerCase()), `Duplicate or ambiguous featured equipment ownership: ${item.name}.`);
      names.add(item.name.toLowerCase());
      identifiers.add(item.uniqueName.toLowerCase());
    }
    let source;
    try { source = new URL(entry.sourceUrl); } catch { /* The common invariant below reports a manual review reason. */ }
    requireFeaturedCatalogEvidence(source?.protocol === "https:" && source.hostname === "www.warframe.com"
      && !source.username && !source.password && !source.port && !source.search && !source.hash
      && /^\/[a-z]{2}(?:-[a-z]+)?\/news\/[^/]+\/?$/.test(source.pathname), `Missing or untrusted official featured equipment source for ${entry.warframe.name}.`);
  }
  return catalog;
}

export function loadFeaturedEquipmentCatalog(url = FEATURED_EQUIPMENT_CATALOG_URL) {
  let catalog;
  try { catalog = JSON.parse(readFileSync(url, "utf8")); }
  catch { requireFeaturedCatalogEvidence(false, "Featured equipment catalog could not be read as JSON."); }
  return validateFeaturedEquipmentCatalog(catalog);
}

export function featuredEquipmentFor(primeWarframes, catalog = loadFeaturedEquipmentCatalog()) {
  validateFeaturedEquipmentCatalog(catalog);
  requireFeaturedCatalogEvidence(Array.isArray(primeWarframes) && primeWarframes.length === 2
    && new Set(primeWarframes).size === 2, "Expected two distinct featured Prime Warframes.");
  return primeWarframes.map(name => {
    const entry = catalog.entries.find(record => record.warframe.name === name);
    requireFeaturedCatalogEvidence(entry, `Missing official featured equipment ownership for ${name}.`);
    return entry;
  });
}

export function validateFeaturedEquipmentExports(entries, equipmentEn) {
  requireFeaturedCatalogEvidence(Array.isArray(equipmentEn), "Official equipment export is missing.");
  for (const entry of entries) {
    for (const item of [entry.warframe, ...entry.items]) {
      const matches = equipmentEn.filter(record => record.name === item.name || record.uniqueName === item.uniqueName);
      const isWarframe = item === entry.warframe;
      requireFeaturedCatalogEvidence(matches.length === 1 && matches[0].name === item.name && matches[0].uniqueName === item.uniqueName
        && Object.hasOwn(EQUIPMENT_TYPE_BY_CATEGORY, matches[0].productCategory)
        && (isWarframe === (EQUIPMENT_TYPE_BY_CATEGORY[matches[0].productCategory] === "warframe")),
      `Featured equipment catalog disagrees with official export identity or ownership role: ${item.name}.`);
    }
  }
}
