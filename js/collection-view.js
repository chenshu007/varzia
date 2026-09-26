import { RARITIES } from "./simulator.js";
import { requiredCount, ownedCountIn } from "./planner-ownership.js";
import { escapeHtml } from "./dom-helpers.js";

export function relicsForPart(relics, itemId, partId) {
  return relics.filter((relic) => relic.rewards.some((reward) => (
    reward.itemId === itemId && reward.partId === partId
  )));
}

function raritiesForPart(relics, itemId, partId, fallback) {
  const rarities = relicsForPart(relics, itemId, partId).flatMap((relic) => relic.rewards
    .filter((reward) => reward.itemId === itemId && reward.partId === partId)
    .map((reward) => reward.rarity))
    .filter((rarity) => RARITIES[rarity]);
  return [...new Set(rarities.length ? rarities : [fallback])]
    .sort((left, right) => RARITIES[left].rank - RARITIES[right].rank);
}

function groupForType(type) {
  if (type === "warframe") return { id: "warframes", labelKey: "group.warframes", shortLabelKey: "type.warframe" };
  if (["primary", "secondary", "melee"].includes(type)) return { id: "weapons", labelKey: "group.weapons", shortLabelKey: "type.weapon" };
  return { id: "other", labelKey: "group.other", shortLabelKey: "type.other" };
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

export function createCollectionView({ $, message, format, localizedTypeLabel, localizedRarityLabel }) {
  function renderRotation(model) {
    const rotation = model.rotation;
    $("rotationName").textContent = rotation?.displayName || message("rotation.empty");
    $("rotationIndex").textContent = rotation?.id || message("rotation.waiting");
    $("targetRotationTitle").textContent = model.previewMode ? message("target.previewTitle") : message("target.title");
    const featured = groupedPrimeItems(model.primeItems).map((group) => `
      <section class="rotation-group" aria-label="${escapeHtml(message(group.labelKey))}">
        <span class="rotation-group-label">${escapeHtml(message(group.labelKey))}</span>
        <div class="rotation-group-grid">
          ${group.items.map((item) => `<span class="rotation-chip">${escapeHtml(item.name)} <em>${escapeHtml(localizedTypeLabel(item.type))}</em></span>`).join("")}
        </div>
      </section>
    `).join("");
    $("rotationFeatured").innerHTML = featured || `<p class="rotation-empty">${escapeHtml(message("rotation.empty"))}</p>`;
  }

  function renderItemOptions(model) {
    const targetOptions = $("targetOptions");
    targetOptions.innerHTML = model.primeItems.length
      ? groupedPrimeItems(model.primeItems).map((group) => `<section class="item-option-group">
        <div class="item-option-group-heading"><span>${escapeHtml(message(group.labelKey))}</span><em>${escapeHtml(message("target.group.count", { count: format(group.items.length) }))}</em></div>
        <div class="target-option-grid">
          ${group.items.map((item) => {
            const required = item.parts.reduce((sum, part) => sum + requiredCount(part), 0);
            const owned = item.parts.reduce((sum, part) => sum + Math.min(requiredCount(part), ownedCountIn(model.owned, item.id, part.id)), 0);
            const selected = model.selectedItemIds.includes(item.id);
            const missing = Math.max(0, required - owned);
            const completion = Math.round((owned / Math.max(1, required)) * 100);
            return `<label class="target-option${selected ? " is-selected" : ""}">
              <input type="checkbox" data-item-id="${escapeHtml(item.id)}" ${selected ? "checked" : ""} ${model.activeSession ? "disabled" : ""} />
              <span class="target-option-main">
                <span class="target-option-name">${escapeHtml(item.name)}</span>
              <span class="target-option-meta">${escapeHtml(message("target.itemParts", { type: localizedTypeLabel(item.type), count: item.parts.length }))}</span>
              </span>
              <span class="target-option-progress">${owned} / ${required}</span>
              <span class="target-option-status">${missing ? message("target.missing", { count: missing }) : message("target.completed")}</span>
              <span class="target-option-meter" aria-hidden="true"><span data-completion="${completion}"></span></span>
            </label>`;
          }).join("")}
        </div>
      </section>`).join("")
      : `<p class="field-hint">${escapeHtml(message("target.noData"))}</p>`;
    for (const meter of targetOptions.querySelectorAll("[data-completion]")) {
      const completion = Math.max(0, Math.min(100, Number(meter.dataset.completion) || 0));
      meter.style.width = `${completion}%`;
    }
  }

  function renderCollections(model) {
    const items = model.selectedItemIds.map(id => model.primeItems.find(item => item.id === id)).filter(Boolean);
    $("collectionList").innerHTML = items.length
      ? items.map((item) => {
        const totalRequired = item.parts.reduce((sum, part) => sum + requiredCount(part), 0);
        const totalOwned = item.parts.reduce((sum, part) => sum + Math.min(requiredCount(part), ownedCountIn(model.owned, item.id, part.id)), 0);
        const complete = totalOwned >= totalRequired;
        return `<section class="collection-card${complete ? " is-complete" : ""}">
          <div class="collection-card-heading">
            <div>
              <span class="collection-card-title">${escapeHtml(item.name)}</span>
              <span class="collection-card-subtitle">${escapeHtml(message("collection.subtitle", { type: localizedTypeLabel(item.type), owned: totalOwned, total: totalRequired }))}</span>
            </div>
            ${complete
              ? `<span class="complete-button">${escapeHtml(message("collection.complete"))}</span>`
              : `<button type="button" class="complete-button" data-complete-item="${escapeHtml(item.id)}" ${model.activeSession ? "disabled" : ""}>${escapeHtml(message("collection.ownAll"))}</button>`}
          </div>
          ${item.parts.map((part) => {
            const required = requiredCount(part);
            const count = Math.min(required, ownedCountIn(model.owned, item.id, part.id));
            const isOwned = count >= required;
            const relicCount = relicsForPart(model.relics, item.id, part.id).length;
            const rarityBadges = raritiesForPart(model.relics, item.id, part.id, part.rarity)
              .map((rarity) => `<span class="rarity rarity-${escapeHtml(rarity)}">${escapeHtml(localizedRarityLabel(rarity))}</span>`)
              .join(" ");
            const checkboxId = `owned-${item.id}-${part.id}`;
            const quantityControl = required > 1 ? `<span class="part-quantity" aria-label="${escapeHtml(message("collection.partQuantity", { name: part.name }))}">
              <button type="button" data-item-id="${escapeHtml(item.id)}" data-part-id="${escapeHtml(part.id)}" data-part-delta="-1" aria-label="${escapeHtml(message("collection.decrease", { name: part.name }))}" ${model.activeSession ? "disabled" : ""}>−</button>
              <span>${count} / ${required}</span>
              <button type="button" data-item-id="${escapeHtml(item.id)}" data-part-id="${escapeHtml(part.id)}" data-part-delta="1" aria-label="${escapeHtml(message("collection.increase", { name: part.name }))}" ${model.activeSession ? "disabled" : ""}>+</button>
            </span>` : "";
            return `<div class="part-row${isOwned ? " is-owned" : ""}">
              <input id="${escapeHtml(checkboxId)}" type="checkbox" data-item-id="${escapeHtml(item.id)}" data-part-id="${escapeHtml(part.id)}" ${isOwned ? "checked" : ""} ${model.activeSession ? "disabled" : ""} />
              <label class="part-name" for="${escapeHtml(checkboxId)}">${escapeHtml(part.name)}${required > 1 ? ` ×${required}` : ""}</label>
              ${quantityControl}
              <span class="part-rarities">${rarityBadges}</span>
              <span class="part-meta">${escapeHtml(message("collection.partMeta", { count: relicCount }))}</span>
            </div>`;
          }).join("")}
        </section>`;
      }).join("")
      : `<p class="field-hint">${escapeHtml(message("target.noSelection"))}</p>`;

    const selected = items.length;
    const totalParts = items.reduce((sum, item) => sum + item.parts.reduce((partSum, part) => partSum + requiredCount(part), 0), 0);
    const totalOwned = items.reduce((sum, item) => sum + item.parts.reduce((partSum, part) => (
      partSum + Math.min(requiredCount(part), ownedCountIn(model.owned, item.id, part.id))
    ), 0), 0);
    $("targetCount").textContent = selected
      ? message("target.count", { count: selected, owned: totalOwned, total: totalParts })
      : message("target.none");
  }
  return { renderRotation, renderItemOptions, renderCollections };
}
