export const SIMULATION_WORKER_TIMEOUT_MS = 60_000;
export const SIMULATION_WORKER_VERSION = "2026-08-21.1";

export function simulationWorkerUrl(baseUrl = import.meta.url) {
  const url = new URL("./simulation-worker.js", baseUrl);
  url.searchParams.set("v", SIMULATION_WORKER_VERSION);
  return url;
}

export function schedulePendingRunAfterFailure(pendingRun, scheduleRun) {
  if (!pendingRun) return false;
  scheduleRun();
  return true;
}

function sameRequest(left, right) {
  return Boolean(left && right
    && left.requestId === right.requestId
    && left.rotationId === right.rotationId);
}

export function createSimulationWorkerClient({
  createWorker,
  workerUrl,
  onResult,
  onFailure,
  scheduleFrame = (callback) => requestAnimationFrame(callback),
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (timer) => clearTimeout(timer),
  timeoutMs = SIMULATION_WORKER_TIMEOUT_MS
}) {
  let worker = null;
  let activeRequest = null;
  let watchdog = null;

  function clearWatchdog() {
    if (watchdog !== null) clearTimer(watchdog);
    watchdog = null;
  }

  function terminateWorker(target = worker) {
    if (!target) return;
    target.terminate();
    if (worker === target) worker = null;
  }

  function fail(kind, request = activeRequest, sourceWorker = worker) {
    if (sourceWorker && sourceWorker !== worker) return;
    const failedRequest = request;
    activeRequest = null;
    clearWatchdog();
    terminateWorker(sourceWorker);
    if (failedRequest) onFailure(failedRequest, kind);
  }

  function ensureWorker() {
    if (worker) return worker;
    try {
      const candidate = createWorker(workerUrl);
      candidate.addEventListener("message", (event) => {
        const response = event.data || {};
        if (!sameRequest(activeRequest, response)) return;
        const completedRequest = activeRequest;
        if (response.error || !response.result) {
          fail("simulation", completedRequest, candidate);
          return;
        }
        activeRequest = null;
        clearWatchdog();
        onResult(response.result, completedRequest);
      });
      const handleRuntimeFailure = () => {
        if (candidate !== worker) return;
        if (activeRequest) fail("runtime", activeRequest, candidate);
        else terminateWorker(candidate);
      };
      candidate.addEventListener("error", handleRuntimeFailure);
      candidate.addEventListener("messageerror", handleRuntimeFailure);
      worker = candidate;
      return worker;
    } catch {
      worker = null;
      return null;
    }
  }

  function start(request) {
    activeRequest = request;
    const target = ensureWorker();
    if (!target) {
      activeRequest = null;
      onFailure(request, "unavailable");
      return false;
    }
    scheduleFrame(() => {
      if (!sameRequest(activeRequest, request) || target !== worker) return;
      try {
        target.postMessage({
          requestId: request.requestId,
          rotationId: request.rotationId,
          options: request.options
        });
        clearWatchdog();
        watchdog = setTimer(() => {
          if (sameRequest(activeRequest, request)) fail("timeout", request, target);
        }, timeoutMs);
      } catch {
        fail("runtime", request, target);
      }
    });
    return true;
  }

  function cancel(request = activeRequest) {
    if (request && activeRequest && !sameRequest(activeRequest, request)) return false;
    activeRequest = null;
    clearWatchdog();
    return true;
  }

  return { start, cancel };
}
