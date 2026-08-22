const UTC_RFC3339_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function normalizedText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function slugify(value) {
  return normalizedText(value)
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function candidateWarframeNames(lineupOrWarframes) {
  const entries = Array.isArray(lineupOrWarframes?.warframes) ? lineupOrWarframes.warframes : lineupOrWarframes;
  if (!Array.isArray(entries) || entries.length !== 2) throw new Error("Candidate identity requires exactly two Prime Warframes.");
  return entries.map((entry) => typeof entry === "string" ? entry : entry?.name);
}

export function candidateIdFor(lineupOrWarframes, startsAt = null, effectiveDate = null) {
  const pair = candidateWarframeNames(lineupOrWarframes)
    .map((name) => {
      if (typeof name !== "string" || !name.endsWith(" Prime")) throw new Error(`Invalid Prime Warframe candidate identity: ${name || "missing"}`);
      return slugify(name).replace(/-prime$/, "");
    })
    .sort()
    .join("-");
  const date = startsAt || effectiveDate;
  return date ? `${pair}-${date.slice(0, 7)}` : `${pair}-time-pending`;
}

export function normalizeOfficialTimestamp(value) {
  if (typeof value !== "string" || !UTC_RFC3339_TIMESTAMP.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}
