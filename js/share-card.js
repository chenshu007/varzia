import { formatProbabilityPrecise } from "./presentation.js";

export const SHARE_CARD_WIDTH = 1200;
export const SHARE_CARD_HEIGHT = 1500;

function escapeSvg(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function formatNumber(value, locale) {
  return Number(value || 0).toLocaleString(locale === "zh" ? "zh-CN" : "en-US");
}

function formatLine(value, analysisCap, labels, locale) {
  return value !== null && value !== undefined && Number.isFinite(Number(value))
    ? formatNumber(value, locale)
    : `${labels.overCap} ${formatNumber(analysisCap, locale)}`;
}

function wrapText(value, maxCharacters = 26) {
  const text = String(value ?? "");
  if (text.length <= maxCharacters) return [text];
  return [text.slice(0, maxCharacters), `${text.slice(maxCharacters, maxCharacters * 2)}${text.length > maxCharacters * 2 ? "…" : ""}`];
}

export function buildShareCardModel({
  locale = "en",
  rotationName = "",
  itemCount = 0,
  currentBudget = 0,
  finishProbability = 0,
  percentiles = {},
  analysisCap = 80,
  squad = 1,
  trials = 0,
  recap = null,
  labels = {}
} = {}) {
  const normalizedLocale = locale === "zh" ? "zh" : "en";
  return {
    locale: normalizedLocale,
    rotationName: String(rotationName || "—"),
    itemCount: Number(itemCount) || 0,
    currentBudget: Math.max(0, Math.floor(Number(currentBudget) || 0)),
    finishProbability: Number(finishProbability) || 0,
    probabilityText: formatProbabilityPrecise(finishProbability),
    percentiles: {
      p50: formatLine(percentiles.p50, analysisCap, labels, normalizedLocale),
      p90: formatLine(percentiles.p90, analysisCap, labels, normalizedLocale),
      p95: formatLine(percentiles.p95, analysisCap, labels, normalizedLocale),
      p99: formatLine(percentiles.p99, analysisCap, labels, normalizedLocale)
    },
    squad: Math.max(1, Math.min(4, Math.floor(Number(squad) || 1))),
    trials: Math.max(0, Math.floor(Number(trials) || 0)),
    recap: recap?.status === "ok"
      ? {
        faceBlackIndex: Number(recap.faceBlackIndex),
        beatPercentage: Number(recap.beatPercentage)
      }
      : null,
    labels: {
      brand: labels.brand || "VARZIA",
      subtitle: labels.subtitle || "",
      rotation: labels.rotation || "",
      targets: labels.targets || "",
      targetUnit: labels.targetUnit || "",
      currentAya: labels.currentAya || "",
      probability: labels.probability || "",
      percentile: labels.percentile || "",
      squad: labels.squad || "",
      simulations: labels.simulations || "",
      recap: labels.recap || "",
      faceBlack: labels.faceBlack || "",
      beat: labels.beat || "",
      overCap: labels.overCap || ">current limit"
    }
  };
}

export function renderShareCardSvg(model) {
  const { labels } = model;
  const lineLabels = ["P50", "P90", "P95", "P99"];
  const lineValues = [model.percentiles.p50, model.percentiles.p90, model.percentiles.p95, model.percentiles.p99];
  const rotationLines = wrapText(model.rotationName, model.locale === "zh" ? 20 : 31);
  const lineMarkup = lineLabels.map((label, index) => {
    const y = 730 + index * 104;
    return `<g><text x="130" y="${y}" class="eyebrow">${label}</text><text x="1070" y="${y + 7}" text-anchor="end" class="line-value">${escapeSvg(lineValues[index])}</text><line x1="130" y1="${y + 27}" x2="1070" y2="${y + 27}" class="rule" /></g>`;
  }).join("");
  const recapMarkup = model.recap
    ? `<g><rect x="100" y="1192" width="1000" height="142" rx="20" class="recap-box" /><text x="136" y="1233" class="eyebrow">${escapeSvg(labels.recap)}</text><text x="136" y="1285" class="recap-value">${escapeSvg(labels.faceBlack)} ${model.recap.faceBlackIndex.toFixed(1)}</text><text x="1064" y="1285" text-anchor="end" class="recap-value">${escapeSvg(labels.beat)} ${model.recap.beatPercentage.toFixed(1)}%</text></g>`
    : "";
  const rotationMarkup = rotationLines.map((line, index) => `<tspan x="130" dy="${index ? 44 : 0}">${escapeSvg(line)}</tspan>`).join("");
  const squadText = `${labels.squad} ${model.squad}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SHARE_CARD_WIDTH}" height="${SHARE_CARD_HEIGHT}" viewBox="0 0 ${SHARE_CARD_WIDTH} ${SHARE_CARD_HEIGHT}">
    <defs>
      <linearGradient id="card-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#07141e"/><stop offset="1" stop-color="#173744"/></linearGradient>
      <linearGradient id="card-accent" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#d9b878"/><stop offset="1" stop-color="#f3dca6"/></linearGradient>
    </defs>
    <rect width="1200" height="1500" fill="url(#card-bg)" />
    <circle cx="1080" cy="120" r="210" fill="#d9b878" opacity=".08" />
    <circle cx="120" cy="1430" r="260" fill="#77aeb1" opacity=".08" />
    <rect x="82" y="82" width="1036" height="1336" rx="30" fill="none" stroke="#d8e5e2" stroke-opacity=".16" />
    <text x="130" y="164" class="brand">${escapeSvg(labels.brand)}</text>
    <text x="130" y="204" class="subtitle">${escapeSvg(labels.subtitle)}</text>
    <rect x="130" y="248" width="116" height="4" rx="2" fill="url(#card-accent)" />
    <text x="130" y="320" class="eyebrow">${escapeSvg(labels.rotation)}</text>
    <text x="130" y="378" class="rotation">${rotationMarkup}</text>
    <text x="130" y="504" class="label">${escapeSvg(labels.targets)}</text>
    <text x="130" y="558" class="big-number">${escapeSvg(formatNumber(model.itemCount, model.locale))}</text>
    <text x="330" y="558" class="unit">${escapeSvg(labels.targetUnit)}</text>
    <text x="130" y="638" class="label">${escapeSvg(labels.currentAya)}</text>
    <text x="510" y="638" class="label">${escapeSvg(labels.probability)}</text>
    <text x="130" y="700" class="big-number small">${escapeSvg(formatNumber(model.currentBudget, model.locale))}</text>
    <text x="510" y="700" class="big-number small accent">${escapeSvg(model.probabilityText)}</text>
    <text x="130" y="728" class="unit">Aya</text>
    ${lineMarkup}
    <text x="130" y="1165" class="label">${escapeSvg(squadText)} · ${escapeSvg(labels.simulations)} ${escapeSvg(formatNumber(model.trials, model.locale))}</text>
    ${recapMarkup}
    <text x="130" y="1394" class="site">varzia.starport1116.com</text>
    <style>
      .brand{fill:#f3dca6;font:800 44px Inter,Arial,sans-serif;letter-spacing:10px}.subtitle{fill:#9eb4b6;font:400 19px Inter,Arial,sans-serif;letter-spacing:2px}.eyebrow{fill:#9eb4b6;font:800 17px Inter,Arial,sans-serif;letter-spacing:4px}.rotation{fill:#f1eee5;font:600 34px Inter,Arial,sans-serif}.label{fill:#9eb4b6;font:600 18px Inter,Arial,sans-serif;letter-spacing:1px}.big-number{fill:#f3dca6;font:500 62px Georgia,serif}.big-number.small{font-size:50px}.big-number.accent{fill:#dff0e8}.unit{fill:#9eb4b6;font:400 18px Inter,Arial,sans-serif}.line-value{fill:#f1eee5;font:600 32px Inter,Arial,sans-serif}.rule{stroke:#d8e5e2;stroke-opacity:.16}.recap-box{fill:#d9b878;fill-opacity:.08;stroke:#d9b878;stroke-opacity:.34}.recap-value{fill:#f3dca6;font:600 28px Inter,Arial,sans-serif}.site{fill:#9eb4b6;font:600 17px Inter,Arial,sans-serif;letter-spacing:2px}
    </style>
  </svg>`;
}

export function svgToPngBlob(svgMarkup, width = SHARE_CARD_WIDTH, height = SHARE_CARD_HEIGHT) {
  return new Promise((resolve, reject) => {
    if (typeof Image === "undefined" || typeof document === "undefined") {
      reject(new Error("PNG generation requires a browser"));
      return;
    }
    const blob = new Blob([svgMarkup], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0, width, height);
      URL.revokeObjectURL(url);
      canvas.toBlob((png) => png ? resolve(png) : reject(new Error("PNG encoding failed")), "image/png");
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("SVG preview failed"));
    };
    image.src = url;
  });
}

export function downloadBlob(blob, filename = "varzia-result.png") {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
