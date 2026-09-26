import { buildShareCardModel, renderShareCardSvg, svgToPngBlob } from "./share-card.js";
import { encodePlan, planUrl } from "./plan-share.js";

/** Owns generated card resources; simulation and route state remain with the caller. */
export function createShareUiController({
  getSnapshot,
  $,
  message,
  browser = globalThis,
  buildModel = buildShareCardModel,
  renderSvg = renderShareCardSvg,
  toPng = svgToPngBlob,
  loadQr = () => import("./plan-qr.js")
}) {
  let shareCardBlob = null;
  let shareCardUrl = "";
  let shareCardPlanUrl = "";
  let shareGeneration = 0;

  function currentShareUrl() {
    const state = getSnapshot();
    if (!state.shareReady || !state.lastResult || state.resultsUpdating || state.running || state.rotation?.publicationStatus !== "published") return null;
    return planUrl(encodePlan({ rotationId: state.rotation.id, options: state.lastResultOptions,
      mode: state.mode, goal: state.goal }), state.locale, browser.location.origin);
  }

  async function copyPlanLink() {
    const url = currentShareUrl();
    if (!url) return;
    const generation = shareGeneration;
    const input = $("sharePlanLink");
    input.value = url;
    $("shareLinkFallback").hidden = false;
    try {
      await browser.navigator.clipboard.writeText(url);
      if (generation !== shareGeneration) return;
      $("shareStatus").textContent = message("share.linkCopied");
    } catch {
      if (generation !== shareGeneration) return;
      input.focus();
      input.select();
      $("shareStatus").textContent = message("share.copyManually");
    }
  }

  function shareCardLabels() {
    return {
      brand: "VARZIA",
      subtitle: message("share.cardSubtitle"),
      rotation: message("share.cardRotation"),
      targets: message("share.cardTargets"),
      targetUnit: message("share.cardTargetUnit"),
      currentAya: message("share.cardCurrentAya"),
      probability: message("share.cardProbability"),
      percentile: message("share.cardPercentile"),
      squad: message("share.cardSquad"),
      simulations: message("share.cardSimulations"),
      recap: message("share.cardRecap"),
      faceBlack: message("share.cardFaceBlack"),
      beat: message("share.cardBeat"),
      overCap: message("share.cardOverCap")
    };
  }

  function shareFilename() {
    const state = getSnapshot();
    const id = state.rotation?.id || "rotation";
    return `varzia-${state.locale}-${id}-result.png`;
  }

  async function generateShareCard() {
    const sharedUrl = currentShareUrl();
    if (!sharedUrl) {
      $("shareStatus").textContent = message("share.needsResult");
      return;
    }
    const button = $("shareResultButton");
    const status = $("shareStatus");
    const generation = ++shareGeneration;
    button.disabled = true;
    status.textContent = message("share.generating");
    try {
      const state = getSnapshot();
      const result = state.lastResult;
      const model = buildModel({
        locale: state.locale,
        rotationName: state.rotation?.displayName || state.rotation?.id,
        itemCount: result.summary?.itemCount,
        currentBudget: state.lastResultOptions?.budget,
        finishProbability: result.finishProbability,
        percentiles: result,
        analysisCap: result.analysisCap || state.lastResultOptions?.analysisCap,
        squad: state.lastResultOptions.squad,
        trials: state.lastTrials,
        recap: state.currentRecap,
        labels: shareCardLabels()
      });
      const { renderPlanQr } = await loadQr();
      const svg = renderSvg(model, renderPlanQr(sharedUrl));
      const png = await toPng(svg);
      // A user may edit inputs while PNG encoding is in flight.
      const current = getSnapshot();
      if (generation !== shareGeneration || current.lastResult !== result || current.resultsUpdating || current.running) return;
      shareCardBlob = png;
      shareCardPlanUrl = sharedUrl;
      if (shareCardUrl) browser.URL.revokeObjectURL(shareCardUrl);
      shareCardUrl = browser.URL.createObjectURL(png);
      const preview = $("sharePreview");
      const image = $("sharePreviewImage");
      const link = $("shareDownloadLink");
      image.src = shareCardUrl;
      link.href = shareCardUrl;
      link.download = shareFilename();
      preview.hidden = false;
      status.textContent = message("share.success");
      $("shareSystemButton").hidden = typeof browser.navigator.share !== "function";
    } catch (error) {
      (browser.console || console).warn("Varzia share card generation failed", error);
      if (generation === shareGeneration) status.textContent = message("share.failed");
    } finally {
      if (generation === shareGeneration) {
        const state = getSnapshot();
        button.disabled = state.resultsUpdating || !state.shareReady;
      }
    }
  }

  async function shareGeneratedCard() {
    const state = getSnapshot();
    if (!state.shareReady || state.resultsUpdating || !shareCardBlob || typeof browser.navigator.share !== "function") return;
    const generation = shareGeneration;
    const sharedUrl = shareCardPlanUrl;
    const payload = { title: message("share.title"), text: `${message("share.openPlan")}\n${sharedUrl}`, url: sharedUrl };
    if (typeof browser.File === "function") {
      const files = [new browser.File([shareCardBlob], shareFilename(), { type: "image/png" })];
      if (typeof browser.navigator.canShare !== "function" || browser.navigator.canShare({ files })) payload.files = files;
    }
    try {
      // Called directly from a new click so mobile browsers retain transient user activation.
      await browser.navigator.share(payload);
    } catch (error) {
      if (generation === shareGeneration) {
        $("shareStatus").textContent = message(error?.name === "AbortError" ? "share.canceled" : "share.systemFailed");
      }
    }
  }

  function clearCard() {
    shareCardBlob = null;
    if (shareCardUrl) {
      browser.URL.revokeObjectURL(shareCardUrl);
      shareCardUrl = "";
    }
  }

  return {
    currentShareUrl,
    copyPlanLink,
    generateShareCard,
    shareGeneratedCard,
    invalidate() { shareGeneration += 1; },
    clearCard,
    get hasCard() { return Boolean(shareCardBlob); }
  };
}
