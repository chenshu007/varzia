import { RARITIES, refinementFor, squadChance } from "./simulator.js";
import { formatProbability, formatProbabilityPrecise } from "./presentation.js";
import { calculateGraduationRecap, calculatePercentileDeltas, formatRecapPercent } from "./wave1.js";
import { requiredCount } from "./planner-ownership.js";
import { relicsForPart } from "./collection-view.js";
import { escapeHtml } from "./dom-helpers.js";

export function createResultsView({ $, message, format, unit, localizedBudgetMarker, localizedRarityLabel, localizedRefinementLabel, renderBudgetDistribution }) {
  function verdictFor(probability, result, budget) {
    if (probability >= 0.95) {
      return { label: message("verdict.lucky"), message: message("verdict.luckyMessage", { probability: formatProbability(probability) }) };
    }
    if (probability >= 0.90) {
      return { label: message("verdict.podium"), message: message("verdict.podiumMessage") };
    }
    if (probability >= 0.75) {
      return { label: message("verdict.advantage"), message: message("verdict.advantageMessage") };
    }
    if (probability >= 0.45) {
      return { label: message("verdict.coinflip"), message: message("verdict.coinflipMessage") };
    }
    const extra = result.p90 === null
      ? message("verdict.redExtraCap")
      : message("verdict.redExtraP90", { budget: format(result.p90) });
    return { label: message("verdict.red"), message: message("verdict.redMessage", { extra }) };
  }

  function renderResult(result, trials, options, model) {
    const budget = Number(options.budget) || 0;
    const analysisCap = Number(options.analysisCap);
    const goal = Number($("goalLine").value) || 0.9;
    const goalBudget = goal === 0.5 ? result.p50 : goal === 0.95 ? result.p95 : goal === 0.99 ? result.p99 : result.p90;
    const displayProbability = model.mode === "goal" ? localizedBudgetMarker(goalBudget, analysisCap) : formatProbabilityPrecise(result.finishProbability);


    $("trialBadge").textContent = result.empty ? message("result.graduated") : `${format(trials)} ${unit("trial")}`;
    $("primaryResultLabel").textContent = model.mode === "goal"
      ? message("result.goal", { percent: Math.round(goal * 100) })
      : message("result.primary");
    $("finishProbability").textContent = displayProbability;
    $("finishDetail").textContent = result.empty
      ? message("result.emptyDetail")
      : model.mode === "goal"
        ? message("result.analysisDetail", { budget: localizedBudgetMarker(analysisCap, null) })
        : message("result.currentDetail", { budget: localizedBudgetMarker(budget, null) });
    $("probabilityBar").style.width = `${Math.max(0, Math.min(100, result.finishProbability * 100))}%`;
    $("meanAya").textContent = format(result.empty ? 0 : Math.ceil(result.averageAya));
    $("traceTotal").textContent = result.empty ? message("trace.zero") : message("trace.median", { count: format(result.medianTraces) });
    $("runCaption").textContent = result.empty ? message("run.completed") : message("run.updated", { trials: format(trials) });
    $("summaryTargets").textContent = `${format(result.summary?.itemCount)} ${unit("item")}`;
    $("summaryCompleted").textContent = `${format(result.summary?.completedItems)} / ${format(result.summary?.itemCount)}`;
    $("summaryRemaining").textContent = `${format(result.summary?.remainingParts)} ${unit("part")}`;
    $("summaryBudget").textContent = localizedBudgetMarker(result.summary?.budget, null);

    const verdict = $("verdict");
    if (result.empty) {
      $("resultStatus").textContent = message("result.graduated");
      $("resultSentence").textContent = message("result.finishedSentence");
      verdict.innerHTML = `<span class="verdict-mark" aria-hidden="true">✦</span><strong class="verdict-status">${escapeHtml(message("result.finishedVerdict"))}</strong><span>${escapeHtml(message("result.finishedAdvice"))}</span>`;
    } else if (result.finishProbability === 0) {
      const gaps = [
        ["P50", result.p50],
        ["P90", result.p90],
        ["P95", result.p95]
      ].filter(([, line]) => Number.isFinite(line) && line >= budget)
        .map(([label, line]) => message(`verdict.gap${label}`, { gap: format(line - budget) }));
      const gapMessage = gaps.length ? gaps.join(model.locale === "zh" ? "；" : "; ") : message("verdict.noStableLine");
      const status = message("verdict.zeroStatus");
      $("resultStatus").textContent = status;
      $("resultSentence").textContent = message("verdict.zeroSentence", { budget: format(budget), trials: format(trials) });
      verdict.innerHTML = `<span class="verdict-mark" aria-hidden="true">✦</span><strong class="verdict-status">${escapeHtml(status)}</strong><span>${escapeHtml(message("verdict.zeroMessage", { gaps: gapMessage }))}</span><span class="verdict-tail">${escapeHtml(message("verdict.zeroTail"))}</span>`;
    } else {
      const outcome = verdictFor(result.finishProbability, result, budget);
      $("resultStatus").textContent = outcome.label;
      $("resultSentence").textContent = result.p95 === null
        ? message("verdict.p95Missing", { budget: format(budget) })
        : budget < result.p95
          ? message("verdict.p95Short", { budget: format(budget), gap: format(result.p95 - budget) })
          : message("verdict.p95Reached", { budget: format(budget) });
      const insurance = result.p95 !== null && budget < result.p95
        ? `<span class="verdict-tail">${escapeHtml(message("verdict.p95ShortTail", { gap: format(result.p95 - budget) }))}</span>`
        : `<span class="verdict-tail">${escapeHtml(message("verdict.p95ReachedTail"))}</span>`;
      verdict.innerHTML = `<span class="verdict-mark" aria-hidden="true">✦</span><strong class="verdict-status">${escapeHtml(outcome.label)}</strong><span>${escapeHtml(outcome.message)}</span>${insurance}`;
    }

    renderBudgetDistribution(result, budget, result.analysisCap || analysisCap);

    $("timelineHeadline").textContent = result.empty
      ? message("timeline.emptyHeadline")
      : result.finishProbability === 0
        ? message("timeline.zeroHeadline", { trials: format(trials) })
        : message("timeline.normalHeadline", { trials: format(trials) });
    $("timelineDetail").textContent = result.empty
      ? message("timeline.emptyDetail")
      : result.finishProbability === 0
        ? message("timeline.zeroDetail")
        : message("timeline.normalDetail", { failed: format(result.timelines.failed) });
    $("timelineSuccess").textContent = result.empty ? "100%" : message("timeline.success", { count: format(result.timelines.success) });

    renderBreakdown(model);
    renderItemResults(result);
    renderRecommendation(result);
    renderPercentileDeltas(result, budget);
    $("sharePanel").hidden = false;
    $("recapPanel").hidden = false;
  }

  function renderPercentileDeltas(result, currentBudget) {
    const deltas = calculatePercentileDeltas({ currentBudget, percentiles: result });
    $("targetDeltaList").innerHTML = deltas.map((entry) => {
      const body = entry.status === "capped"
        ? message("delta.exceeds", { label: entry.label })
        : entry.status === "remaining"
          ? message("delta.remaining", { delta: format(entry.delta), label: entry.label })
          : message("delta.reached", { label: entry.label });
      const tone = entry.status === "remaining" ? "is-open" : entry.status === "capped" ? "is-capped" : "is-reached";
      return `<article class="target-delta-card ${tone}"><span class="target-delta-label">${escapeHtml(entry.label)}</span><strong>${escapeHtml(body)}</strong>${entry.status === "remaining" ? `<small>${escapeHtml(localizedBudgetMarker(entry.budget, null))}</small>` : ""}</article>`;
    }).join("");
  }

  function renderGraduationRecap(lastResult) {
    const input = $("observedAya");
    const output = $("recapResult");
    if (!input || !output) return;
    if (!lastResult) {
      input.disabled = true;
      output.textContent = message("recap.waiting");
      return null;
    }
    input.disabled = false;
    const value = input.value.trim();
    if (!value) {
      output.textContent = message("recap.waiting");
      return null;
    }
    const recap = calculateGraduationRecap({ curve: lastResult.budgetCurve, observedAya: value });
    if (recap.status !== "ok") {
      output.innerHTML = `<span class="recap-result-status is-outside">${escapeHtml(message("recap.outside"))}</span>`;
      return recap;
    }
    const percentile = formatRecapPercent(recap.faceBlackIndex);
    const beat = formatRecapPercent(recap.beatPercentage);
    const band = message(`recap.band.${recap.band}`);
    const description = recap.percentile < 0.1
      ? message("recap.luckyMessage", { aya: format(recap.observedAya), value: beat })
      : message("recap.message", { value: percentile });
    output.innerHTML = `<div class="recap-result-heading"><strong>${escapeHtml(band)}</strong><span>${escapeHtml(message("recap.index", { value: percentile }))}</span><span>${escapeHtml(message("recap.beat", { value: beat }))}</span></div><p>${escapeHtml(description)}</p>`;
    return recap;
  }

  function renderBreakdown(model) {
    const body = $("breakdownBody");
    const missing = model.primeItems.flatMap((item) => item.parts
      .filter((part) => part.ownedCount < requiredCount(part))
      .map((part) => ({ ...part, item, missingCount: requiredCount(part) - part.ownedCount })));
    if (!missing.length) {
      body.innerHTML = `<tr><td class="empty-row" colspan="5">${escapeHtml(message("breakdown.noMissing"))}</td></tr>`;
      return;
    }
    const strategy = $("strategy").value;
    const squad = model.squad;
    body.innerHTML = missing.map(({ item, missingCount, ...part }) => {
      const routes = relicsForPart(model.relics, item.id, part.id).map((relic) => {
        const reward = relic.rewards.find((candidate) => candidate.itemId === item.id && candidate.partId === part.id);
        const rarity = reward?.rarity || part.rarity;
        const refinement = refinementFor(rarity, strategy);
        const chance = squadChance(RARITIES[rarity]?.rates[refinement] || 0, squad);
        return { relic, rarity, refinement, chance };
      }).sort((left, right) => right.chance - left.chance || left.relic.name.localeCompare(right.relic.name, "zh-CN"));
      const bestRoute = routes[0];
      const rarity = bestRoute?.rarity || part.rarity;
      const refinement = bestRoute?.refinement || refinementFor(rarity, strategy);
      const chance = bestRoute?.chance || 0;
      const routeLabel = routes.map((route) => route.relic.name).join(" / ");
      const quantityLabel = missingCount > 1 ? ` ×${missingCount}` : "";
      const label = model.selectedItemIds.length > 1 ? `${item.name} · ${part.name}${quantityLabel}` : `${part.name}${quantityLabel}`;
      return `<tr>
        <td data-label="${escapeHtml(message("breakdown.missing"))}">${escapeHtml(label)}${routeLabel ? `<small class="table-route">${escapeHtml(routeLabel)}</small>` : ""}</td>
        <td data-label="${escapeHtml(message("breakdown.rarity"))}"><span class="rarity rarity-${escapeHtml(rarity)}">${escapeHtml(localizedRarityLabel(rarity))}</span></td>
        <td data-label="${escapeHtml(message("breakdown.refinement"))}">${escapeHtml(localizedRefinementLabel(refinement))}</td>
        <td data-label="${escapeHtml(message("breakdown.chance"))}">${(chance * 100).toFixed(2)}%</td>
        <td data-label="${escapeHtml(message("breakdown.average"))}">${chance ? (1 / chance).toFixed(2) : "—"} ${unit("relic")}</td>
      </tr>`;
    }).join("");
  }

  function renderItemResults(result) {
    $("targetResultList").innerHTML = result.itemProbabilities?.length
      ? result.itemProbabilities.map((item) => `<div class="target-result-row">
        <span class="target-result-name">${escapeHtml(item.name)}</span>
        <span class="target-result-probability">${escapeHtml(message("targetBoard.itemProbability", { probability: formatProbability(item.probability) }))}</span>
      </div>`).join("")
      : `<p class="field-hint">${escapeHtml(message("targetBoard.empty"))}</p>`;
  }

  function renderRecommendation(result) {
    const recommendation = result.recommendation || { items: [], totalAya: 0 };
    $("recommendationAya").textContent = recommendation.items.length
      ? message("recommendation.total", { count: format(recommendation.totalAya) })
      : message("recommendation.none");
    $("recommendationList").innerHTML = recommendation.items.length
      ? recommendation.items.map((item) => {
        const tokens = Array.from({ length: Math.min(item.count, 8) }, () => `<i class="aya-token" aria-hidden="true"></i>`).join("");
        return `<div class="recommendation-row">
          <div class="recommendation-main">
            <strong>${escapeHtml(item.name)}</strong>
            <span>${escapeHtml(message("recommendation.item", { rewards: format(item.rewardCount), items: format(item.itemCount) }))}</span>
          </div>
          <div class="aya-stack"><span class="aya-tokens">${tokens}</span><span>× ${format(item.count)}</span></div>
        </div>`;
      }).join("")
      : `<p class="field-hint">${escapeHtml(message("recommendation.empty"))}</p>`;

  }
  return { renderResult, renderGraduationRecap, renderItemResults };
}
