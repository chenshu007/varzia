import {
  RARITIES,
  REFINEMENTS,
  refinementFor,
  simulateCurrentRotation,
  squadChance,
  strategyNote,
  typeLabel
} from "./simulator.js";
import { validateRotationData } from "./data-validation.js";
import { formatProbability, zeroProbabilityGuidance } from "./presentation.js";
import { loadCollectionState, saveCollectionState } from "./storage.js";

const fallbackRotation = {
  lastVerified: "2026-08-14",
  source: { name: "Warframe 官方简体中文 Prime 重生页面", url: "https://www.warframe.com/zh-hans/prime-resurgence" },
  rotation: { displayName: "本期 Prime 重生", itemIds: [] }
};

const state = {
  rotation: fallbackRotation,
  primeItems: [],
  relics: [],
  selectedItemIds: [],
  owned: {},
  squad: 4,
  mode: "budget",
  runTimer: null,
  running: false,
  pendingRun: false,
  simulationWorker: null,
  workerRequestId: 0,
  activeSimulation: null,
  dataLoadErrors: []
};

const $ = (id) => document.getElementById(id);
const format = (number) => Number(number || 0).toLocaleString("zh-CN");
const formatDate = (value) => String(value || "—").replaceAll("-", ".");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function readJson(path, fallback) {
  try {
    const response = await fetch(path, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch {
    state.dataLoadErrors.push(path);
    return fallback;
  }
}

function getStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function requiredCount(part) {
  return Math.max(1, Math.floor(Number(part.required || part.quantity || 1)));
}

function ownedMap(itemId) {
  if (!state.owned[itemId]) state.owned[itemId] = new Map();
  return state.owned[itemId];
}

function ownedCount(itemId, partId) {
  return Math.max(0, Number(ownedMap(itemId).get(partId)) || 0);
}

function itemById(itemId) {
  return state.primeItems.find((item) => item.id === itemId);
}

function selectedItems() {
  return state.selectedItemIds.map(itemById).filter(Boolean);
}

function relicsForPart(itemId, partId) {
  return state.relics.filter((relic) => relic.rewards.some((reward) => (
    reward.itemId === itemId && reward.partId === partId
  )));
}

function currentPrimeItems() {
  return selectedItems().map((item) => ({
    ...item,
    parts: item.parts.map((part) => ({
      ...part,
      ownedCount: Math.min(requiredCount(part), ownedCount(item.id, part.id))
    }))
  }));
}

function setStatus(text, isError = false) {
  const status = $("dataStatus");
  status.textContent = text;
  status.closest(".source-status")?.classList.toggle("is-error", isError);
}

function groupForType(type) {
  if (type === "warframe") return { id: "warframes", label: "Prime 战甲", shortLabel: "战甲" };
  if (["primary", "secondary", "melee"].includes(type)) return { id: "weapons", label: "Prime 武器", shortLabel: "武器" };
  return { id: "other", label: "其他 Prime 装备", shortLabel: "其他" };
}

function groupedPrimeItems(items) {
  const order = ["warframes", "weapons", "other"];
  const groups = new Map();
  for (const item of items) {
    const group = groupForType(item.type);
    if (!groups.has(group.id)) groups.set(group.id, { ...group, items: [] });
    groups.get(group.id).items.push(item);
  }
  return order.map((id) => groups.get(id)).filter(Boolean);
}

function renderRotation() {
  const rotation = state.rotation.rotation || fallbackRotation.rotation;
  $("rotationName").textContent = rotation.displayName || "本期 Prime 重生";
  $("rotationFeatured").innerHTML = groupedPrimeItems(state.primeItems).map((group) => `
    <section class="rotation-group" aria-label="${escapeHtml(group.label)}">
      <span class="rotation-group-label">${escapeHtml(group.label)}</span>
      <div class="rotation-group-grid">
        ${group.items.map((item) => `<span class="rotation-chip">${escapeHtml(item.name)} <em>${escapeHtml(typeLabel(item.type))}</em></span>`).join("")}
      </div>
    </section>
  `).join("");
}

function renderItemOptions() {
  $("targetOptions").innerHTML = state.primeItems.length
    ? groupedPrimeItems(state.primeItems).map((group) => `<section class="item-option-group">
      <div class="item-option-group-heading"><span>${escapeHtml(group.label)}</span><em>${group.items.length} 件</em></div>
      <div class="target-option-grid">
        ${group.items.map((item) => {
          const required = item.parts.reduce((sum, part) => sum + requiredCount(part), 0);
          const owned = item.parts.reduce((sum, part) => sum + Math.min(requiredCount(part), ownedCount(item.id, part.id)), 0);
          const selected = state.selectedItemIds.includes(item.id);
          const missing = Math.max(0, required - owned);
          const completion = Math.round((owned / Math.max(1, required)) * 100);
          return `<label class="target-option${selected ? " is-selected" : ""}">
            <input type="checkbox" data-item-id="${escapeHtml(item.id)}" ${selected ? "checked" : ""} />
            <span class="target-option-main">
              <span class="target-option-name">${escapeHtml(item.name)}</span>
              <span class="target-option-meta">${escapeHtml(typeLabel(item.type))} · ${item.parts.length} 类部件</span>
            </span>
            <span class="target-option-progress">${owned} / ${required}</span>
            <span class="target-option-status">${missing ? `还缺 <strong>${missing} 件</strong>` : "<strong>已毕业</strong>"}</span>
            <span class="target-option-meter" aria-hidden="true"><span style="width: ${completion}%"></span></span>
          </label>`;
        }).join("")}
      </div>
    </section>`).join("")
    : `<p class="field-hint">暂无可用目标数据。</p>`;
}

function renderCollections() {
  const items = selectedItems();
  $("collectionList").innerHTML = items.length
    ? items.map((item) => {
      const totalRequired = item.parts.reduce((sum, part) => sum + requiredCount(part), 0);
      const totalOwned = item.parts.reduce((sum, part) => sum + Math.min(requiredCount(part), ownedCount(item.id, part.id)), 0);
      const complete = totalOwned >= totalRequired;
      return `<section class="collection-card${complete ? " is-complete" : ""}">
        <div class="collection-card-heading">
          <div>
            <span class="collection-card-title">${escapeHtml(item.name)}</span>
            <span class="collection-card-subtitle">${escapeHtml(item.description || typeLabel(item.type))} · ${totalOwned} / ${totalRequired} 已有</span>
          </div>
          ${complete
            ? `<span class="complete-button">已毕业</span>`
            : `<button type="button" class="complete-button" data-complete-item="${escapeHtml(item.id)}">已拥有整套</button>`}
        </div>
        ${item.parts.map((part) => {
          const required = requiredCount(part);
          const count = Math.min(required, ownedCount(item.id, part.id));
          const isOwned = count >= required;
          const relicCount = relicsForPart(item.id, part.id).length;
          const checkboxId = `owned-${item.id}-${part.id}`;
          const quantityControl = required > 1 ? `<span class="part-quantity" aria-label="${escapeHtml(part.name)}已拥有数量">
            <button type="button" data-item-id="${escapeHtml(item.id)}" data-part-id="${escapeHtml(part.id)}" data-part-delta="-1" aria-label="减少一件${escapeHtml(part.name)}">−</button>
            <span>${count} / ${required}</span>
            <button type="button" data-item-id="${escapeHtml(item.id)}" data-part-id="${escapeHtml(part.id)}" data-part-delta="1" aria-label="增加一件${escapeHtml(part.name)}">+</button>
          </span>` : "";
          return `<div class="part-row${isOwned ? " is-owned" : ""}">
            <input id="${escapeHtml(checkboxId)}" type="checkbox" data-item-id="${escapeHtml(item.id)}" data-part-id="${escapeHtml(part.id)}" ${isOwned ? "checked" : ""} />
            <label class="part-name" for="${escapeHtml(checkboxId)}">${escapeHtml(part.name)}${required > 1 ? ` ×${required}` : ""}</label>
            ${quantityControl}
            <span class="rarity rarity-${escapeHtml(part.rarity)}">${escapeHtml(RARITIES[part.rarity]?.label || part.rarity)}</span>
            <span class="part-meta">${relicCount} 个遗物</span>
          </div>`;
        }).join("")}
      </section>`;
    }).join("")
    : `<p class="field-hint">先在上面选择一套或多套 Prime，下面会出现你的部件清单。</p>`;

  const selected = items.length;
  const totalParts = items.reduce((sum, item) => sum + item.parts.reduce((partSum, part) => partSum + requiredCount(part), 0), 0);
  const totalOwned = items.reduce((sum, item) => sum + item.parts.reduce((partSum, part) => (
    partSum + Math.min(requiredCount(part), ownedCount(item.id, part.id))
  ), 0), 0);
  $("targetCount").textContent = selected ? `${selected} 件目标 · ${totalOwned} / ${totalParts} 已有` : "未选择目标";
}

function persistCollection() {
  const owned = Object.fromEntries(Object.entries(state.owned).map(([itemId, parts]) => [
    itemId,
    Object.fromEntries([...parts].filter(([, count]) => count > 0))
  ]));
  const saved = saveCollectionState(getStorage(), {
    rotationId: state.rotation.rotation?.id || "",
    selectedItemIds: state.selectedItemIds,
    owned
  });
  if (saved && state.dataLoadErrors.length) setStatus("本期 Prime 重生数据暂时无法确认", true);
  else if (saved) setStatus(`数据已核对 · ${formatDate(state.rotation.lastVerified)} · 已保存在本地`);
}

function updateStrategyNote() {
  $("strategyNote").textContent = strategyNote($("strategy").value);
}

function setMode(mode) {
  state.mode = mode;
  $("modePicker").querySelectorAll("button").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
  });
  $("budgetLabel").textContent = mode === "goal" ? "最多愿意准备的阿耶精华" : "我有多少阿耶精华";
  $("goalLine").closest(".goal-line-field").hidden = mode !== "goal";
  scheduleRun();
}

function bindEvents() {
  $("budgetJump")?.addEventListener("click", () => {
    $("planner")?.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => $("budget")?.focus(), 450);
  });

  $("targetOptions").addEventListener("change", (event) => {
    const itemId = event.target.dataset.itemId;
    if (!itemId) return;
    state.selectedItemIds = event.target.checked
      ? [...new Set([...state.selectedItemIds, itemId])]
      : state.selectedItemIds.filter((id) => id !== itemId);
    persistCollection();
    renderItemOptions();
    renderCollections();
    scheduleRun();
  });

  $("collectionList").addEventListener("change", (event) => {
    const { itemId, partId } = event.target.dataset;
    if (!itemId || !partId) return;
    const item = itemById(itemId);
    const part = item?.parts.find((candidate) => candidate.id === partId);
    if (!part) return;
    ownedMap(itemId).set(partId, event.target.checked ? requiredCount(part) : 0);
    persistCollection();
    renderItemOptions();
    renderCollections();
    scheduleRun();
  });

  $("collectionList").addEventListener("click", (event) => {
    const completeItemId = event.target.dataset.completeItem;
    const delta = Number(event.target.dataset.partDelta || 0);
    const itemId = completeItemId || event.target.dataset.itemId;
    if (!itemId) return;
    const item = itemById(itemId);
    if (!item) return;

    if (completeItemId) {
      item.parts.forEach((part) => ownedMap(itemId).set(part.id, requiredCount(part)));
    } else if (delta) {
      const partId = event.target.dataset.partId;
      const part = item.parts.find((candidate) => candidate.id === partId);
      if (!part) return;
      const next = Math.max(0, Math.min(requiredCount(part), ownedCount(itemId, partId) + delta));
      ownedMap(itemId).set(partId, next);
    } else {
      return;
    }
    persistCollection();
    renderItemOptions();
    renderCollections();
    scheduleRun();
  });

  $("selectAllTargets").addEventListener("click", () => {
    state.selectedItemIds = state.primeItems.map((item) => item.id);
    persistCollection();
    renderItemOptions();
    renderCollections();
    scheduleRun();
  });

  $("clearTargets").addEventListener("click", () => {
    state.selectedItemIds = [];
    persistCollection();
    renderItemOptions();
    renderCollections();
    scheduleRun();
  });

  $("selectWarframes").addEventListener("click", () => {
    state.selectedItemIds = state.primeItems.filter((item) => item.type === "warframe").map((item) => item.id);
    persistCollection();
    renderItemOptions();
    renderCollections();
    scheduleRun();
  });

  $("selectWeapons").addEventListener("click", () => {
    state.selectedItemIds = state.primeItems.filter((item) => ["primary", "secondary", "melee"].includes(item.type)).map((item) => item.id);
    persistCollection();
    renderItemOptions();
    renderCollections();
    scheduleRun();
  });

  $("modePicker").addEventListener("click", (event) => {
    if (event.target.dataset.mode) setMode(event.target.dataset.mode);
  });
  $("budget").addEventListener("input", scheduleRun);
  $("strategy").addEventListener("change", () => { updateStrategyNote(); scheduleRun(); });
  $("trials").addEventListener("change", scheduleRun);
  $("goalLine").addEventListener("change", scheduleRun);
  $("squadPicker").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-squad]");
    if (!button) return;
    state.squad = Number(button.dataset.squad);
    $("squadPicker").querySelectorAll("button").forEach((item) => {
      item.setAttribute("aria-pressed", String(item === button));
    });
    scheduleRun();
  });
  $("runButton").addEventListener("click", run);
}

function scheduleRun() {
  window.clearTimeout(state.runTimer);
  state.runTimer = window.setTimeout(run, 80);
}

function simulationOptions() {
  const trials = Number($("trials").value) || 100000;
  const budget = Number($("budget").value) || 0;
  return {
    trials,
    options: {
      primeItems: currentPrimeItems(),
      relics: state.relics,
      budget,
      squad: state.squad,
      strategy: $("strategy").value,
      trials,
      analysisCap: Math.min(120, Math.max(80, budget))
    }
  };
}

function finishRun(result, trials) {
  renderResult(result, trials);
  state.running = false;
  state.activeSimulation = null;
  $("runButton").disabled = false;
  if (state.pendingRun) scheduleRun();
}

function runOnMainThread(request) {
  window.requestAnimationFrame(() => {
    try {
      finishRun(simulateCurrentRotation(request.options), request.trials);
    } catch {
      state.running = false;
      state.activeSimulation = null;
      $("runButton").disabled = false;
      $("runCaption").textContent = "这次模拟没有跑完，请再试一次";
      if (state.pendingRun) scheduleRun();
    }
  });
}

function initSimulationWorker() {
  if (!("Worker" in window)) return;
  try {
    const worker = new Worker(new URL("./simulation-worker.js", import.meta.url), { type: "module" });
    worker.addEventListener("message", (event) => {
      const { requestId, result, error } = event.data || {};
      if (!state.activeSimulation || requestId !== state.activeSimulation.requestId) return;
      if (error || !result) {
        worker.terminate();
        state.simulationWorker = null;
        runOnMainThread(state.activeSimulation);
        return;
      }
      finishRun(result, state.activeSimulation.trials);
    });
    worker.addEventListener("error", () => {
      if (state.simulationWorker !== worker) return;
      worker.terminate();
      state.simulationWorker = null;
      if (state.activeSimulation) runOnMainThread(state.activeSimulation);
    });
    state.simulationWorker = worker;
  } catch {
    state.simulationWorker = null;
  }
}

function run() {
  if (state.running) {
    state.pendingRun = true;
    return;
  }
  const request = simulationOptions();
  if (!request.options.primeItems.length) {
    state.pendingRun = false;
    renderNoTargets();
    return;
  }
  state.running = true;
  state.pendingRun = false;
  const button = $("runButton");
  button.disabled = true;
  $("runCaption").textContent = "正在展开平行世界……";
  const requestId = ++state.workerRequestId;
  state.activeSimulation = { ...request, requestId };
  if (state.simulationWorker) {
    state.simulationWorker.postMessage({ requestId, options: request.options });
  } else {
    runOnMainThread(state.activeSimulation);
  }
}

function renderNoTargets() {
  $("trialBadge").textContent = "等待目标";
  $("primaryResultLabel").textContent = "先选择 Prime 目标";
  $("finishProbability").textContent = "—";
  $("finishDetail").textContent = "默认会模拟本期全部 Prime";
  $("resultStatus").textContent = "—";
  $("resultSentence").textContent = "选择目标后，Varzia 会替你跑完这条时间线。";
  $("probabilityBar").style.width = "0%";
  ["meanAya", "p50Aya", "p90Aya", "p95Aya", "p99Aya"].forEach((id) => { $(id).textContent = "—"; });
  ["summaryTargets", "summaryCompleted", "summaryRemaining", "summaryBudget"].forEach((id) => { $(id).textContent = "—"; });
  $("traceTotal").textContent = "—";
  $("runCaption").textContent = "选择目标后开始模拟";
  $("verdict").innerHTML = `<span class="verdict-mark" aria-hidden="true">✦</span><span>先选一套或多套 Prime，再让瓦奇娅展开平行世界。</span>`;
  $("timelineHeadline").textContent = "还没有要毕业的目标。";
  $("timelineDetail").textContent = "选择目标后，这里会显示模拟时间线。";
  $("timelineSuccess").textContent = "—";
  renderProbabilityRace(null, Number($("budget").value) || 0);
  $("breakdownBody").innerHTML = `<tr><td class="empty-row" colspan="5">还没有选择 Prime 目标。</td></tr>`;
  renderItemResults({ itemProbabilities: [] });
  $("recommendationAya").textContent = "—";
  $("recommendationList").innerHTML = `<p class="field-hint">先选择目标，才会生成购买路线。</p>`;
  $("budgetCurve").innerHTML = "";
}

function renderProbabilityRace(result, budget = Number($("budget").value) || 0) {
  const values = [result?.p50, result?.p90, result?.p95, result?.p99, budget].filter((value) => Number.isFinite(value));
  const ceiling = Math.max(1, ...values) * 1.08;
  const position = (value) => `${Math.max(0, Math.min(100, (Number(value || 0) / ceiling) * 100))}%`;
  const markerValues = { raceP50: result?.p50, raceP90: result?.p90, raceP95: result?.p95, raceP99: result?.p99 };
  Object.entries(markerValues).forEach(([id, value]) => {
    const marker = $(id);
    if (marker) marker.style.left = value === null || value === undefined ? "100%" : position(value);
  });
  const crowded = Object.values(markerValues).some((value) => Number.isFinite(value) && Math.abs(value - budget) / ceiling < 0.11);
  const raceYou = $("raceYou");
  raceYou?.style.setProperty("left", position(budget));
  raceYou?.style.setProperty("top", crowded ? (budget / ceiling < 0.5 ? "83%" : "17%") : "50%");
  $("raceTrackFill")?.style.setProperty("width", position(budget));
  if ($("raceBudget")) $("raceBudget").textContent = `当前预算 ${format(budget)} 个`;
  if ($("raceBudgetValue")) $("raceBudgetValue").textContent = `${format(budget)} 个`;
}

function lineText(value) {
  return value === null || value === undefined ? "尚未达到" : `${format(value)} 个`;
}

function verdictFor(probability, result, budget) {
  if (probability >= 0.95) {
    return { label: "大赢特赢", message: `按当前条件，约 ${formatProbability(probability)} 的时间线可以在预算内全部毕业。` };
  }
  if (probability >= 0.90) {
    return { label: "领奖台区", message: "你已经站进领奖台区。大多数时间线都会顺利冲过终点。" };
  }
  if (probability >= 0.75) {
    return { label: "优势局", message: `大多数时间线都能毕业；如果想少一点意外，可以看 P95 保险线。` };
  }
  if (probability >= 0.45) {
    return { label: "五五开", message: `预算能覆盖一半左右的时间线，脸黑时还需要再准备一些阿耶精华。` };
  }
  const extra = result.p90 === null ? "先把预算拉高，再观察毕业曲线。" : `建议至少攒到 P90 的 ${format(result.p90)} 个阿耶精华。`;
  return { label: "阿耶精华红区", message: `这轮还比较悬。${extra}` };
}

function renderResult(result, trials) {
  const budget = Number($("budget").value) || 0;
  const goal = Number($("goalLine").value) || 0.9;
  const goalBudget = goal === 0.5 ? result.p50 : goal === 0.95 ? result.p95 : goal === 0.99 ? result.p99 : result.p90;
  const displayProbability = state.mode === "goal" ? (goalBudget === null ? "尚未达到" : lineText(goalBudget)) : formatProbability(result.finishProbability);

  $("trialBadge").textContent = result.empty ? "已毕业" : `已跑 ${format(trials)} 次`;
  $("primaryResultLabel").textContent = state.mode === "goal"
    ? `达到 ${Math.round(goal * 100)}% 全部毕业需要`
    : "本期目标全部毕业概率";
  $("finishProbability").textContent = displayProbability;
  $("finishDetail").textContent = result.empty
    ? "所有部件都在你的仓库里"
    : state.mode === "goal"
      ? `当前搜索上限 ${format(budget)} 阿耶精华`
      : `当前预算 ${format(budget)} 阿耶精华`;
  $("probabilityBar").style.width = `${Math.max(0, Math.min(100, result.finishProbability * 100))}%`;
  $("meanAya").textContent = result.empty ? "0 个" : `${format(Math.ceil(result.averageAya))} 个`;
  $("p50Aya").textContent = lineText(result.p50);
  $("p90Aya").textContent = lineText(result.p90);
  $("p95Aya").textContent = lineText(result.p95);
  $("p99Aya").textContent = lineText(result.p99);
  $("traceTotal").textContent = result.empty ? "虚空光体：0" : `中位虚空光体 · ${format(result.medianTraces)}`;
  $("runCaption").textContent = result.empty ? "这个目标已经毕业" : `已根据当前条件更新 · ${format(trials)} 次抽样`;
  $("summaryTargets").textContent = `${format(result.summary?.itemCount)} 件`;
  $("summaryCompleted").textContent = `${format(result.summary?.completedItems)} / ${format(result.summary?.itemCount)}`;
  $("summaryRemaining").textContent = `${format(result.summary?.remainingParts)} 件`;
  $("summaryBudget").textContent = `${format(result.summary?.budget)} 个`;

  const verdict = $("verdict");
  if (result.empty) {
    $("resultStatus").textContent = "已毕业";
    $("resultSentence").textContent = "本期已经毕业。瓦奇娅今天没有你的生意。";
    verdict.innerHTML = `<span class="verdict-mark" aria-hidden="true">✦</span><strong class="verdict-status">已经毕业</strong><span>建议把省下来的阿耶精华留给下一轮，或者去飞船里发呆。</span>`;
  } else if (result.finishProbability === 0) {
    const guidance = zeroProbabilityGuidance({
      budget,
      trials,
      p50: result.p50,
      p90: result.p90,
      p95: result.p95
    });
    $("resultStatus").textContent = guidance.status;
    $("resultSentence").textContent = guidance.sentence;
    verdict.innerHTML = `<span class="verdict-mark" aria-hidden="true">✦</span><strong class="verdict-status">${guidance.status}</strong><span>${guidance.message}</span><span class="verdict-tail">${guidance.tail}</span>`;
  } else {
    const outcome = verdictFor(result.finishProbability, result, budget);
    $("resultStatus").textContent = outcome.label;
    $("resultSentence").textContent = result.p95 === null
      ? `你当前拥有 ${format(budget)} 个阿耶精华；P95 尚未在当前搜索范围内出现。`
      : budget < result.p95
        ? `你当前拥有 ${format(budget)} 个阿耶精华。再准备 ${format(result.p95 - budget)} 个，可进入约 95% 的模拟区间。`
        : `你当前拥有 ${format(budget)} 个阿耶精华，已经进入 P95 保险线。`;
    const insurance = result.p95 !== null && budget < result.p95
      ? `<span class="verdict-tail">距 P95 还差 ${format(result.p95 - budget)} 个</span>`
      : `<span class="verdict-tail">已进入 P95 保险线</span>`;
    verdict.innerHTML = `<span class="verdict-mark" aria-hidden="true">✦</span><strong class="verdict-status">${outcome.label}</strong><span>${outcome.message}</span>${insurance}`;
  }

  renderProbabilityRace(result, budget);

  $("timelineHeadline").textContent = result.empty
    ? "你的所有目标都已经收集完成。"
    : result.finishProbability === 0
      ? `${format(trials)} 条时间线中没有一条完成全部目标。`
      : `我们让你刷了 ${format(trials)} 条时间线。`;
  $("timelineDetail").textContent = result.empty
    ? "这一次没有新的随机数需要面对。"
    : result.finishProbability === 0
      ? "当前预算更适合优先完成部分 Prime，而不是追求本期全部毕业。"
      : `${format(result.timelines.failed)} 条时间线没能在当前预算内毕业。`;
  $("timelineSuccess").textContent = result.empty ? "100%" : `${format(result.timelines.success)} 条毕业`;

  renderBreakdown();
  renderItemResults(result);
  renderRecommendation(result);
}

function renderBreakdown() {
  const body = $("breakdownBody");
  const missing = currentPrimeItems().flatMap((item) => item.parts
    .filter((part) => part.ownedCount < requiredCount(part))
    .map((part) => ({ ...part, item, missingCount: requiredCount(part) - part.ownedCount })));
  if (!missing.length) {
    body.innerHTML = `<tr><td class="empty-row" colspan="5">没有缺件。瓦奇娅本轮无法从你身上赚到一枚阿耶精华。</td></tr>`;
    return;
  }
  const strategy = $("strategy").value;
  const squad = state.squad;
  body.innerHTML = missing.map(({ item, missingCount, ...part }) => {
    const routes = relicsForPart(item.id, part.id).map((relic) => {
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
    const label = state.selectedItemIds.length > 1 ? `${item.name} · ${part.name}${quantityLabel}` : `${part.name}${quantityLabel}`;
    return `<tr>
      <td>${escapeHtml(label)}${routeLabel ? `<small class="table-route">${escapeHtml(routeLabel)}</small>` : ""}</td>
      <td><span class="rarity rarity-${escapeHtml(rarity)}">${escapeHtml(RARITIES[rarity]?.label || rarity)}</span></td>
      <td>${escapeHtml(REFINEMENTS[refinement]?.label || refinement)}</td>
      <td>${(chance * 100).toFixed(2)}%</td>
      <td>${chance ? (1 / chance).toFixed(2) : "—"} 个</td>
    </tr>`;
  }).join("");
}

function renderItemResults(result) {
  $("targetResultList").innerHTML = result.itemProbabilities?.length
    ? result.itemProbabilities.map((item) => `<div class="target-result-row">
      <span class="target-result-name">${escapeHtml(item.name)}</span>
      <span class="target-result-probability">${formatProbability(item.probability)} 全部毕业</span>
    </div>`).join("")
    : `<p class="field-hint">选择目标后，这里会显示每件 Prime 在同一份共享预算下的毕业概率。</p>`;
}

function renderRecommendation(result) {
  const recommendation = result.recommendation || { items: [], totalAya: 0 };
  $("recommendationAya").textContent = recommendation.items.length ? `总计 ${format(recommendation.totalAya)} 阿耶精华` : "暂无推荐";
  $("recommendationList").innerHTML = recommendation.items.length
    ? recommendation.items.map((item) => {
      const tokens = Array.from({ length: Math.min(item.count, 8) }, () => `<i class="aya-token" aria-hidden="true"></i>`).join("");
      return `<div class="recommendation-row">
        <div class="recommendation-main">
          <strong>${escapeHtml(item.name)}</strong>
          <span>覆盖 ${format(item.rewardCount)} 类缺件 · ${format(item.itemCount)} 件 Prime</span>
        </div>
        <div class="aya-stack"><span class="aya-tokens">${tokens}</span><span>× ${format(item.count)}</span></div>
      </div>`;
    }).join("")
    : `<p class="field-hint">当前没有缺件，或预算还不足以形成购买路线。</p>`;

  const lines = [
    ["P50", result.p50],
    ["P90", result.p90],
    ["P95", result.p95],
    ["P99", result.p99]
  ];
  $("budgetCurve").innerHTML = `<div class="curve-heading">反向预算线</div>${lines.map(([label, value]) => `<div class="curve-row"><span>${label} 毕业线</span><span>${lineText(value)}</span></div>`).join("")}`;
}

async function loadData() {
  state.dataLoadErrors = [];
  const [rotation, primes, relicData] = await Promise.all([
    readJson("data/rotation.json", fallbackRotation),
    readJson("data/primes.json", { primeItems: [] }),
    readJson("data/relics.json", { relics: [] })
  ]);
  try {
    validateRotationData(rotation, primes, relicData);
  } catch {
    state.dataLoadErrors.push("data-validation");
  }
  state.rotation = rotation?.rotation ? rotation : fallbackRotation;
  const allPrimeItems = primes?.primeItems || [];
  const rotationItemIds = new Set(state.rotation.rotation?.itemIds || []);
  state.primeItems = rotationItemIds.size
    ? allPrimeItems.filter((item) => rotationItemIds.has(item.id))
    : allPrimeItems;
  state.relics = state.dataLoadErrors.length ? [] : (relicData?.relics || []);
  if (state.dataLoadErrors.length) state.primeItems = [];
  const saved = loadCollectionState(getStorage(), state.primeItems, state.rotation.rotation?.id || "");
  state.selectedItemIds = saved.selectedItemIds;
  state.owned = Object.fromEntries(Object.entries(saved.owned || {}).map(([itemId, partCounts]) => [
    itemId,
    new Map(Object.entries(partCounts).map(([partId, count]) => [partId, Number(count) || 0]))
  ]));

  renderRotation();
  renderItemOptions();
  renderCollections();
  $("dataUpdatedAt").textContent = formatDate([rotation?.lastVerified, primes?.updatedAt, relicData?.updatedAt].filter(Boolean).sort().at(-1));
  if (state.dataLoadErrors.length) {
    setStatus("本期 Prime 重生数据暂时无法确认", true);
  } else {
    setStatus(`数据已核对 · ${formatDate(state.rotation.lastVerified)}`);
  }
  updateStrategyNote();
  bindEvents();
  initSimulationWorker();
  run();
}

loadData();
