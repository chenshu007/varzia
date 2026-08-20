export const SUPPORTED_LOCALES = Object.freeze(["zh", "en"]);
export const DEFAULT_LOCALE = "en";
export const LOCALE_STORAGE_KEY = "varzia.locale";

const ENGLISH_DISPLAY_OVERLAY = Object.freeze({
  rotations: {
    "revenant-baruuk-2026-08": { displayName: "Revenant Prime & Baruuk Prime" }
  },
  items: {
    "revenant-prime": {
      name: "Revenant Prime",
      parts: { blueprint: "Blueprint", chassis: "Chassis", neuroptics: "Neuroptics", systems: "Systems" }
    },
    "baruuk-prime": {
      name: "Baruuk Prime",
      parts: { blueprint: "Blueprint", chassis: "Chassis", neuroptics: "Neuroptics", systems: "Systems" }
    },
    "phantasma-prime": {
      name: "Phantasma Prime",
      parts: { blueprint: "Blueprint", barrel: "Barrel", receiver: "Receiver", stock: "Stock" }
    },
    "tatsu-prime": {
      name: "Tatsu Prime",
      parts: { blueprint: "Blueprint", blade: "Blade", handle: "Handle" }
    },
    "afuris-prime": {
      name: "Afuris Prime",
      parts: { blueprint: "Blueprint", barrel: "Barrel", receiver: "Receiver", link: "Link" }
    },
    "cobra-crane-prime": {
      name: "Cobra & Crane Prime",
      parts: { blueprint: "Blueprint", blade: "Blade", hilt: "Hilt", guard: "Guard" }
    }
  },
  relics: {
    "lith-a9": { name: "Lith A9", era: "Lith" },
    "lith-t13": { name: "Lith T13", era: "Lith" },
    "meso-r6": { name: "Meso R6", era: "Meso" },
    "neo-p8": { name: "Neo P8", era: "Neo" },
    "axi-b9": { name: "Axi B9", era: "Axi" },
    "axi-c9": { name: "Axi C9", era: "Axi" }
  }
});

let activeLocale = DEFAULT_LOCALE;
let activeMessages = {};
let fallbackMessages = {};

export function normalizeLocale(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "zh" || normalized.startsWith("zh-") || normalized === "zh-hans") return "zh";
  if (normalized === "en" || normalized.startsWith("en-")) return "en";
  return null;
}

export function localeFromPathname(pathname = "") {
  const segment = String(pathname || "").split("/").filter(Boolean)[0] || "";
  return SUPPORTED_LOCALES.includes(segment) ? segment : null;
}

export function localeTag(locale = activeLocale) {
  return normalizeLocale(locale) === "zh" ? "zh-CN" : "en";
}

export function browserLocale(locale = activeLocale) {
  return normalizeLocale(locale) === "zh" ? "zh-CN" : "en-US";
}

export function resolveLocale({ savedLocale, navigatorLanguage, defaultLocale = DEFAULT_LOCALE } = {}) {
  return normalizeLocale(savedLocale)
    || normalizeLocale(navigatorLanguage)
    || normalizeLocale(defaultLocale)
    || DEFAULT_LOCALE;
}

export function readStoredLocale(storage) {
  try {
    return normalizeLocale(storage?.getItem?.(LOCALE_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function writeStoredLocale(storage, locale) {
  const normalized = normalizeLocale(locale);
  if (!normalized) return false;
  try {
    storage?.setItem?.(LOCALE_STORAGE_KEY, normalized);
    return true;
  } catch {
    return false;
  }
}

export function localePath(locale, locationLike = {}) {
  const normalized = normalizeLocale(locale) || DEFAULT_LOCALE;
  const search = String(locationLike.search || "");
  const hash = String(locationLike.hash || "");
  return `/${normalized}/${search}${hash}`;
}

export function interpolate(template, variables = {}) {
  return String(template ?? "").replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(variables, key) ? String(variables[key]) : match
  ));
}

export function createTranslator(messages = {}, fallback = {}) {
  return (key, variables = {}) => {
    const template = messages[key] ?? fallback[key] ?? key;
    return interpolate(template, variables);
  };
}

export function setLocaleMessages(locale, messages, fallback = {}) {
  activeLocale = normalizeLocale(locale) || DEFAULT_LOCALE;
  activeMessages = messages && typeof messages === "object" ? messages : {};
  fallbackMessages = fallback && typeof fallback === "object" ? fallback : {};
  return activeLocale;
}

export function getLocale() {
  return activeLocale;
}

export function t(key, variables = {}) {
  return createTranslator(activeMessages, fallbackMessages)(key, variables);
}

export async function loadLocaleMessages(locale, fetchImpl = globalThis.fetch) {
  const normalized = normalizeLocale(locale) || DEFAULT_LOCALE;
  const filename = normalized === "zh" ? "zh-cn" : "en";
  const response = await fetchImpl(`/data/locales/${filename}.json`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Locale HTTP ${response.status}`);
  const messages = await response.json();
  if (!messages || typeof messages !== "object" || Array.isArray(messages)) {
    throw new TypeError("Locale messages must be an object");
  }
  return messages;
}

export function localizeDisplayData({ rotations = [], primeItems = [], relics = [] } = {}, locale = activeLocale) {
  if (normalizeLocale(locale) !== "en") return { rotations, primeItems, relics };

  return {
    rotations: rotations.map((rotation) => {
      const overlay = ENGLISH_DISPLAY_OVERLAY.rotations[rotation?.id];
      return overlay ? { ...rotation, ...overlay } : rotation;
    }),
    primeItems: primeItems.map((item) => {
      const overlay = ENGLISH_DISPLAY_OVERLAY.items[item?.id];
      if (!overlay) return item;
      return {
        ...item,
        name: overlay.name,
        parts: (item.parts || []).map((part) => ({
          ...part,
          name: overlay.parts[part.id] || part.name
        }))
      };
    }),
    relics: relics.map((relic) => {
      const overlay = ENGLISH_DISPLAY_OVERLAY.relics[relic?.id];
      return overlay ? { ...relic, ...overlay } : relic;
    })
  };
}

export function typeLabelKey(type) {
  if (type === "warframe") return "type.warframe";
  if (["primary", "secondary", "melee"].includes(type)) return "type.weapon";
  return "type.other";
}

export function refinementKey(refinement) {
  return `refinement.${refinement}`;
}

export function rarityKey(rarity) {
  return `rarity.${rarity}`;
}
