import qrcode from "./vendor/qrcode.mjs";

/** A locally generated, high-contrast QR with a four-module quiet zone. */
export function renderPlanQr(url) {
  const code = qrcode(0, "M");
  code.addData(url, "Byte");
  code.make();
  const count = code.getModuleCount();
  const scale = Math.floor(290 / (count + 8));
  if (scale < 2) throw new RangeError("Plan link is too large for this card; copy the link instead");
  const size = (count + 8) * scale;
  const left = 1080 - size;
  let path = "";
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (code.isDark(row, col)) path += `M${left + (col + 4) * scale},${1100 + (row + 4) * scale}h${scale}v${scale}h-${scale}z`;
    }
  }
  return `<g shape-rendering="crispEdges"><rect x="${left}" y="1100" width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></g>`;
}
