import { assertValidBudgetCurve, formatProbabilityPrecise } from "./presentation.js";
import { escapeHtml } from "./dom-helpers.js";

export function createBudgetChartView({ $, message, format, localizedBudgetMarker, localizedProbabilityDescriptor, isRunning, browser = globalThis }) {
  let lastBudgetChart = null;
  let chartResizeObserver = null;
  let chartResizeTimer = null;

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function boxesOverlap(left, right, padding = 5) {
    return !(left.x + left.width + padding <= right.x
      || right.x + right.width + padding <= left.x
      || left.y + left.height + padding <= right.y
      || right.y + right.height + padding <= left.y);
  }

  function layoutBudgetLabels(markers, bounds) {
    const placed = [];
    const priority = { current: 0, p50: 1, p95: 2, p99: 3, p90: 4 };
    const ordered = [...markers].sort((left, right) => priority[left.id] - priority[right.id]);
    for (const marker of ordered) {
      if (!marker.showLabel) continue;
      const width = marker.id === "current" ? Math.min(138, bounds.width - 8) : marker.capped ? 76 : 64;
      const height = marker.id === "current" ? 42 : 34;
      const preferredDirection = marker.y < bounds.top + bounds.height * 0.32 ? 1 : -1;
      const verticalCandidates = [
        marker.y + preferredDirection * 49,
        marker.y - preferredDirection * 49,
        marker.y + preferredDirection * 88,
        marker.y - preferredDirection * 88
      ];
      for (let laneY = bounds.top + height / 2 + 4; laneY <= bounds.top + bounds.height - height / 2 - 4; laneY += height + 7) {
        verticalCandidates.push(laneY);
      }
      verticalCandidates.sort((left, right) => Math.abs(left - marker.y) - Math.abs(right - marker.y));
      const horizontalCandidates = [marker.x, marker.x - width * 0.7, marker.x + width * 0.7];
      let selected = null;
      for (const centerY of verticalCandidates) {
        for (const centerX of horizontalCandidates) {
          const box = {
            x: clamp(centerX - width / 2, bounds.left + 4, bounds.left + bounds.width - width - 4),
            y: clamp(centerY - height / 2, bounds.top + 4, bounds.top + bounds.height - height - 4),
            width,
            height
          };
          if (!placed.some((entry) => boxesOverlap(box, entry.box))) {
            selected = box;
            break;
          }
        }
        if (selected) break;
      }
      if (!selected) continue;
      marker.box = selected;
      placed.push({ marker, box: selected });
    }
    return markers;
  }

  function emptyBudgetChart(message) {
    const svg = $("budgetChart");
    const shell = $("budgetChartShell");
    if (!svg || !shell) return;
    const width = Math.max(260, Math.floor(shell.clientWidth || 800));
    const height = Math.max(260, Math.floor(shell.clientHeight || 330));
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("aria-label", message);
    svg.innerHTML = `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" class="budget-axis-title">${escapeHtml(message)}</text>`;
    $("budgetMarkerLegend").innerHTML = "";
    $("budgetChartTooltip").hidden = true;
  }

  function renderBudgetDistribution(result, budget = Number($("budget").value) || 0, analysisCap = result?.analysisCap) {
    const renderStartedAt = performance.now();
    const currentBudget = Math.max(0, Math.floor(Number(budget) || 0));
    $("budgetKpiCurrent").textContent = localizedBudgetMarker(currentBudget, null);
    if (!result) {
      lastBudgetChart = null;
      $("budgetKpiProbability").textContent = "—";
      $("budgetKpiProbabilityNote").textContent = message("kpi.waiting");
      ["budgetKpiP50", "budgetKpiP95", "budgetKpiP99"].forEach((id) => { $(id).textContent = "—"; });
      emptyBudgetChart(message("chart.waiting"));
      return;
    }

    lastBudgetChart = { result, budget: currentBudget, analysisCap };
    $("budgetKpiProbability").textContent = formatProbabilityPrecise(result.finishProbability);
    $("budgetKpiProbabilityNote").textContent = localizedProbabilityDescriptor(result.finishProbability);
    $("budgetKpiP50").textContent = localizedBudgetMarker(result.p50, analysisCap);
    $("budgetKpiP95").textContent = localizedBudgetMarker(result.p95, analysisCap);
    $("budgetKpiP99").textContent = localizedBudgetMarker(result.p99, analysisCap);

    try {
      assertValidBudgetCurve(result.budgetCurve);
    } catch (error) {
      console.warn("Varzia budget curve validation failed", error);
      emptyBudgetChart(message("chart.validation"));
      return;
    }

    const svg = $("budgetChart");
    const shell = $("budgetChartShell");
    const tooltip = $("budgetChartTooltip");
    const width = Math.max(260, Math.floor(shell.clientWidth || 800));
    const height = Math.max(260, Math.floor(shell.clientHeight || 390));
    const mobile = width < 520;
    const margin = { top: 18, right: 14, bottom: 47, left: mobile ? 42 : 52 };
    const plot = {
      left: margin.left,
      top: margin.top,
      width: width - margin.left - margin.right,
      height: height - margin.top - margin.bottom
    };
    const curveCap = result.budgetCurve.at(-1).budget;
    const rightAnchor = Number.isFinite(result.p99) ? Math.max(currentBudget, result.p99) : curveCap;
    const xMargin = Math.max(2, Math.ceil(rightAnchor * 0.07));
    const maxX = Math.max(1, Math.min(curveCap, rightAnchor + xMargin));
    const visibleCurve = result.budgetCurve.filter((point) => point.budget <= maxX);
    const xFor = (aya) => plot.left + (clamp(aya, 0, maxX) / maxX) * plot.width;
    const yFor = (probability) => plot.top + (1 - clamp(probability, 0, 1)) * plot.height;
    const path = visibleCurve.map((point, index) => {
      const x = xFor(point.budget);
      const y = yFor(point.finishProbability);
      if (index === 0) return `M ${x.toFixed(2)} ${y.toFixed(2)}`;
      return `H ${x.toFixed(2)} V ${y.toFixed(2)}`;
    }).join(" ");
    const firstPoint = visibleCurve[0];
    const lastPoint = visibleCurve.at(-1);
    const areaPath = `${path} L ${xFor(lastPoint.budget).toFixed(2)} ${yFor(0).toFixed(2)} L ${xFor(firstPoint.budget).toFixed(2)} ${yFor(0).toFixed(2)} Z`;
    const yTicks = mobile ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1];
    const xTicks = [...new Set(Array.from({ length: mobile ? 4 : 6 }, (_, index) => (
      Math.round((maxX * index) / (mobile ? 3 : 5))
    )))];
    const pointAtBudget = (aya) => result.budgetCurve[Math.min(curveCap, Math.max(0, aya))];
    const markerSpecs = [
      { id: "current", label: message("chart.current"), budget: currentBudget, probability: result.finishProbability, showLabel: true },
      { id: "p50", label: "P50", budget: result.p50, target: 0.50, showLabel: true },
      { id: "p90", label: "P90", budget: result.p90, target: 0.90, showLabel: !mobile },
      { id: "p95", label: "P95", budget: result.p95, target: 0.95, showLabel: true },
      { id: "p99", label: "P99", budget: result.p99, target: 0.99, showLabel: true }
    ].map((marker) => {
      const capped = !Number.isFinite(marker.budget);
      const markerBudget = capped ? curveCap : marker.budget;
      const point = pointAtBudget(markerBudget);
      return {
        ...marker,
        capped,
        markerBudget,
        probability: marker.id === "current" ? marker.probability : point.finishProbability,
        x: xFor(Math.min(markerBudget, maxX)),
        y: yFor(marker.id === "current" ? marker.probability : point.finishProbability)
      };
    });
    layoutBudgetLabels(markerSpecs, plot);

    const gridMarkup = yTicks.map((tick) => {
      const y = yFor(tick);
      return `<line class="budget-grid-line" x1="${plot.left}" y1="${y}" x2="${plot.left + plot.width}" y2="${y}"></line>
        <text class="budget-axis-label" x="${plot.left - 8}" y="${y + 3}" text-anchor="end">${Math.round(tick * 100)}%</text>`;
    }).join("");
    const xAxisMarkup = xTicks.map((tick) => {
      const x = xFor(tick);
      return `<line class="budget-axis-line" x1="${x}" y1="${plot.top + plot.height}" x2="${x}" y2="${plot.top + plot.height + 4}"></line>
        <text class="budget-axis-label" x="${x}" y="${plot.top + plot.height + 17}" text-anchor="middle">${tick}</text>`;
    }).join("");
    const markerMarkup = [...markerSpecs].sort((left, right) => (
      Number(left.id === "current") - Number(right.id === "current")
    )).map((marker) => {
      const isCurrent = marker.id === "current";
      const labelValue = isCurrent
        ? `${localizedBudgetMarker(marker.markerBudget, null)} · ${formatProbabilityPrecise(marker.probability)}`
        : localizedBudgetMarker(marker.capped ? null : marker.markerBudget, marker.capped ? marker.markerBudget : null);
      const label = marker.box ? `<line class="budget-marker-line" x1="${marker.x}" y1="${marker.y}" x2="${marker.box.x + marker.box.width / 2}" y2="${marker.box.y + marker.box.height / 2}"></line>
        <rect class="budget-label-box${isCurrent ? " is-current" : ""}" x="${marker.box.x}" y="${marker.box.y}" width="${marker.box.width}" height="${marker.box.height}" rx="7"></rect>
        <text class="budget-label-kicker${isCurrent ? " is-current" : ""}" x="${marker.box.x + 8}" y="${marker.box.y + 13}">${escapeHtml(marker.label)}</text>
        <text class="budget-label-value" x="${marker.box.x + 8}" y="${marker.box.y + marker.box.height - 9}">${escapeHtml(labelValue)}</text>` : "";
      return `${label}<circle class="budget-marker-dot${isCurrent ? " is-current" : ""}" cx="${marker.x}" cy="${marker.y}" r="${isCurrent ? 5 : 3.5}"></circle>`;
    }).join("");
    const ariaLabel = message("chart.aria", {
      budget: format(currentBudget),
      probability: formatProbabilityPrecise(result.finishProbability),
      p95: localizedBudgetMarker(result.p95, analysisCap)
    });

    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("aria-label", ariaLabel);
    svg.innerHTML = `<title>${escapeHtml(ariaLabel)}</title>
      <desc>${escapeHtml(message("chart.desc"))}</desc>
      <defs><linearGradient id="budgetAreaGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--champagne-bright)" stop-opacity=".11"></stop><stop offset="1" stop-color="var(--champagne-bright)" stop-opacity=".015"></stop></linearGradient></defs>
      ${gridMarkup}
      <line class="budget-axis-line" x1="${plot.left}" y1="${plot.top + plot.height}" x2="${plot.left + plot.width}" y2="${plot.top + plot.height}"></line>
      ${xAxisMarkup}
      <text class="budget-axis-title" x="${plot.left}" y="11">${escapeHtml(message("chart.axisProbability"))}</text>
      <text class="budget-axis-title" x="${plot.left + plot.width / 2}" y="${height - 7}" text-anchor="middle">${escapeHtml(message("chart.axisBudget"))}</text>
      <path class="budget-area" d="${areaPath}"></path>
      <path class="budget-path" d="${path}"></path>
      <line class="budget-current-line" x1="${xFor(currentBudget)}" y1="${plot.top}" x2="${xFor(currentBudget)}" y2="${plot.top + plot.height}"></line>
      ${markerMarkup}
      <g id="budgetHoverMarker" visibility="hidden"><line class="budget-hover-line" x1="0" y1="${plot.top}" x2="0" y2="${plot.top + plot.height}"></line><circle class="budget-hover-dot" cx="0" cy="0" r="4"></circle></g>
      <rect class="budget-hit-target" x="${plot.left}" y="${plot.top}" width="${plot.width}" height="${plot.height}" tabindex="0" role="application" aria-label="${escapeHtml(message("chart.keyboard"))}"></rect>`;

    $("budgetMarkerLegend").innerHTML = [
      ["P50", result.p50], ["P90", result.p90], ["P95", result.p95], ["P99", result.p99]
    ].map(([label, value]) => `<span class="${Number.isFinite(value) ? "" : "is-capped"}"${Number.isFinite(value) ? "" : ` data-cap-note="${escapeHtml(message("chart.overCap"))}"`}><b>${label}</b><strong>${escapeHtml(localizedBudgetMarker(value, analysisCap))}</strong></span>`).join("");

    const hitTarget = svg.querySelector(".budget-hit-target");
    const hoverMarker = svg.querySelector("#budgetHoverMarker");
    const hoverLine = hoverMarker.querySelector("line");
    const hoverDot = hoverMarker.querySelector("circle");
    let activeBudget = currentBudget;
    const showPoint = (aya) => {
      activeBudget = clamp(Math.round(aya), 0, maxX);
      const point = pointAtBudget(activeBudget);
      const x = xFor(activeBudget);
      const y = yFor(point.finishProbability);
      hoverMarker.setAttribute("visibility", "visible");
      hoverLine.setAttribute("x1", x);
      hoverLine.setAttribute("x2", x);
      hoverDot.setAttribute("cx", x);
      hoverDot.setAttribute("cy", y);
      tooltip.hidden = false;
      tooltip.innerHTML = `<strong>${escapeHtml(message("chart.tooltip", { budget: format(activeBudget), probability: formatProbabilityPrecise(point.finishProbability) }))}</strong>`;
      const left = clamp((x / width) * shell.clientWidth + 10, 8, Math.max(8, shell.clientWidth - 166));
      const top = clamp((y / height) * shell.clientHeight - 58, 8, Math.max(8, shell.clientHeight - 58));
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
    };
    hitTarget.addEventListener("pointermove", (event) => {
      const bounds = svg.getBoundingClientRect();
      const localX = (event.clientX - bounds.left) * (width / bounds.width);
      showPoint(((localX - plot.left) / plot.width) * maxX);
    });
    hitTarget.addEventListener("pointerdown", (event) => {
      const bounds = svg.getBoundingClientRect();
      const localX = (event.clientX - bounds.left) * (width / bounds.width);
      showPoint(((localX - plot.left) / plot.width) * maxX);
    });
    hitTarget.addEventListener("pointerleave", (event) => {
      if (event.pointerType === "mouse") {
        hoverMarker.setAttribute("visibility", "hidden");
        tooltip.hidden = true;
      }
    });
    hitTarget.addEventListener("focus", () => showPoint(currentBudget));
    hitTarget.addEventListener("blur", () => {
      hoverMarker.setAttribute("visibility", "hidden");
      tooltip.hidden = true;
    });
    hitTarget.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      if (event.key === "Home") showPoint(0);
      else if (event.key === "End") showPoint(maxX);
      else showPoint(activeBudget + (event.key === "ArrowRight" ? 1 : -1));
    });
    svg.dataset.renderMs = (performance.now() - renderStartedAt).toFixed(2);
  }

  function initBudgetChartResize() {
    if (!("ResizeObserver" in browser)) return;
    const observer = new browser.ResizeObserver(() => {
      browser.clearTimeout(chartResizeTimer);
      chartResizeTimer = browser.setTimeout(() => {
        if (lastBudgetChart && !isRunning()) {
          renderBudgetDistribution(
            lastBudgetChart.result,
            lastBudgetChart.budget,
            lastBudgetChart.analysisCap
          );
        }
      }, 50);
    });
    observer.observe($("budgetChartShell"));
    chartResizeObserver = observer;
  }
  return { renderBudgetDistribution, initBudgetChartResize };
}
