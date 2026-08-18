const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function timestampOf(rotation) {
  return Date.parse(rotation?.startsAt || "");
}

function normalizeNow(now) {
  const value = now instanceof Date ? now.getTime() : Number(now);
  return Number.isFinite(value) ? value : Date.now();
}

function orderedRotations(rotations) {
  return (Array.isArray(rotations) ? rotations : [])
    .map((rotation) => ({ rotation, timestamp: timestampOf(rotation) }))
    .filter((entry) => Number.isFinite(entry.timestamp))
    .sort((left, right) => left.timestamp - right.timestamp || String(left.rotation.id).localeCompare(String(right.rotation.id)));
}

export function resolveRotationState(rotations, now) {
  const nowTimestamp = normalizeNow(now);
  const schedule = orderedRotations(rotations);
  let activeIndex = -1;

  for (let index = 0; index < schedule.length; index += 1) {
    if (schedule[index].timestamp > nowTimestamp) break;
    activeIndex = index;
  }

  return {
    activeRotation: activeIndex >= 0 ? schedule[activeIndex].rotation : null,
    nextRotation: schedule[activeIndex + 1]?.rotation || null,
    previousRotation: activeIndex > 0 ? schedule[activeIndex - 1].rotation : null
  };
}

export function resolveRotationView(rotations, now, previewId = "") {
  const resolved = resolveRotationState(rotations, now);
  const requestedPreviewId = String(previewId || "").trim();
  const previewRotation = requestedPreviewId
    ? (Array.isArray(rotations) ? rotations : []).find((rotation) => rotation?.id === requestedPreviewId) || null
    : null;

  return {
    ...resolved,
    displayRotation: previewRotation || resolved.activeRotation,
    previewRotation,
    isPreview: Boolean(previewRotation),
    invalidPreviewId: requestedPreviewId && !previewRotation ? requestedPreviewId : null
  };
}

export function getTimeUntilRotation(rotation, now) {
  const target = timestampOf(rotation);
  if (!Number.isFinite(target)) return 0;
  return Math.max(0, target - normalizeNow(now));
}

function pad2(value) {
  return String(Math.max(0, Math.floor(value))).padStart(2, "0");
}

export function formatRotationCountdown(remainingMs) {
  const numericRemaining = Number(remainingMs);
  if (!Number.isFinite(numericRemaining)) return "—";
  const remaining = Math.max(0, numericRemaining);
  const totalSeconds = Math.ceil(remaining / SECOND_MS);
  const days = Math.floor(totalSeconds / (24 * 60 * 60));
  const hours = Math.floor((totalSeconds % (24 * 60 * 60)) / (60 * 60));
  const minutes = Math.floor((totalSeconds % (60 * 60)) / 60);
  const seconds = totalSeconds % 60;

  if (remaining > 7 * DAY_MS) {
    return hours ? `${days} 天 ${hours} 小时` : `${days} 天`;
  }
  if (remaining >= DAY_MS) {
    return `${days} 天 ${pad2(hours)}:${pad2(minutes)}`;
  }
  return `${pad2(Math.floor(totalSeconds / (60 * 60)))}:${pad2(minutes)}:${pad2(seconds)}`;
}

export function countdownUpdateDelay(remainingMs) {
  const remaining = Math.max(0, Number(remainingMs) || 0);
  if (remaining <= 0) return 0;
  return Math.min(remaining <= DAY_MS ? SECOND_MS : MINUTE_MS, remaining);
}

export function formatRotationLocalTime(startsAt, locale = "zh-CN") {
  const timestamp = Date.parse(startsAt || "");
  if (!Number.isFinite(timestamp)) return "—";
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short"
  }).format(timestamp);
}

export function isSimulationResponseCurrent(activeSimulation, response, rotationId) {
  if (!activeSimulation || !response) return false;
  return response.requestId === activeSimulation.requestId
    && response.rotationId === activeSimulation.rotationId
    && response.rotationId === rotationId;
}

export const ROTATION_TIME = Object.freeze({ SECOND_MS, MINUTE_MS, HOUR_MS, DAY_MS });
