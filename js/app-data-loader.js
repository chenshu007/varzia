import { validateRotationData } from "./data-validation.js";
import { loadAnnouncementCandidates } from "./announcement-candidate-preview.js";
import { localizeDisplayData } from "./i18n.js";
import { publishedRotations } from "./rotation-schedule.js";

export const FALLBACK_SCHEDULE = {
  schemaVersion: 2,
  lastVerified: "2026-08-14",
  source: { name: "Warframe 官方简体中文 Prime 重生页面", url: "https://www.warframe.com/zh-hans/prime-resurgence" },
  rotations: []
};

// Required catalogs form one validated snapshot. Optional announcements cannot
// make that snapshot unavailable, and are never loaded for an invalid catalog.
export async function loadAppData({ locale, fetchImpl = globalThis.fetch, warn = console.warn } = {}) {
  const dataLoadErrors = [];
  async function readJson(path, fallback) {
    try {
      const response = await fetchImpl(path, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch {
      dataLoadErrors.push(path);
      return fallback;
    }
  }

  const [scheduleData, primes, relicData] = await Promise.all([
    readJson("/data/rotation.json", FALLBACK_SCHEDULE),
    readJson("/data/primes.json", { primeItems: [] }),
    readJson("/data/relics.json", { relics: [] })
  ]);
  try {
    validateRotationData(scheduleData, primes, relicData);
  } catch (error) {
    warn("Varzia rotation data validation failed", error);
    dataLoadErrors.push("data-validation");
  }

  const usableSchedule = dataLoadErrors.length ? FALLBACK_SCHEDULE : scheduleData;
  const displayData = localizeDisplayData({
    rotations: usableSchedule.rotations || [],
    primeItems: dataLoadErrors.length ? [] : (primes?.primeItems || []),
    relics: dataLoadErrors.length ? [] : (relicData?.relics || [])
  }, locale);
  const announcementCandidates = dataLoadErrors.length
    ? []
    : await loadAnnouncementCandidates({ fetchImpl, rotationData: scheduleData, warn });

  return {
    scheduleData: usableSchedule,
    rotations: displayData.rotations,
    publishedRotations: publishedRotations(displayData.rotations),
    allPrimeItems: displayData.primeItems,
    allRelics: displayData.relics,
    announcementCandidates,
    dataLoadErrors,
    dataUpdatedAt: [scheduleData?.lastVerified, primes?.updatedAt, relicData?.updatedAt]
      .filter(Boolean).sort().at(-1)
  };
}
