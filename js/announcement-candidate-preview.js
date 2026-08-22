import { validateAnnouncementCandidates } from "./data-validation.js";

export const fallbackAnnouncementCandidates = Object.freeze({ schemaVersion: 1, candidates: [] });

// Candidate previews are optional UX. They must never make the published
// rotation unavailable when an artifact is missing, malformed, or newer.
export async function loadAnnouncementCandidates({
  fetchImpl = globalThis.fetch,
  rotationData,
  url = "/data/prime-resurgence-candidates.json",
  warn = console.warn
} = {}) {
  try {
    const response = await fetchImpl(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const candidateData = await response.json();
    validateAnnouncementCandidates(candidateData, rotationData);
    return candidateData.candidates;
  } catch (error) {
    warn("Varzia announcement candidate preview is unavailable", error);
    return [];
  }
}
