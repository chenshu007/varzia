import { isSimulationResponseCurrent } from "./rotation-schedule.js";
import {
  createSimulationWorkerClient,
  schedulePendingRunAfterFailure,
  simulationWorkerUrl
} from "./simulation-worker-client.js";

/**
 * Owns request identity and scheduling. Input and presentation stay with the
 * caller so a pending run always reads the latest controls and locale.
 * Completion/failure hooks finish their UI updates before a queued run starts.
 */
export function createSimulationController({
  getRotationId,
  prepareRequest,
  hooks = {},
  createClient = createSimulationWorkerClient,
  workerUrl = simulationWorkerUrl(),
  createWorker = (url) => {
    if (!("Worker" in globalThis)) throw new Error("Worker unavailable");
    return new globalThis.Worker(url, { type: "module" });
  },
  scheduleFrame = (callback) => globalThis.requestAnimationFrame(callback),
  setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimer = (timer) => globalThis.clearTimeout(timer)
}) {
  let runTimer = null;
  let running = false;
  let pendingRun = false;
  let client = null;
  let workerRequestId = 0;
  let activeSimulation = null;

  function isCurrent(request, kind) {
    if (isSimulationResponseCurrent(activeSimulation, request, getRotationId())) return true;
    hooks.stale?.(request, kind);
    return false;
  }

  function schedule() {
    clearTimer(runTimer);
    hooks.updating?.(true);
    runTimer = setTimer(run, 80);
  }

  function finish(result, request) {
    if (!isCurrent(request, "result")) return;
    running = false;
    activeSimulation = null;
    if (pendingRun) {
      pendingRun = false;
      schedule();
      return;
    }
    hooks.completed?.(result, request.trials, request);
  }

  function fail(request, kind) {
    if (request && !isCurrent(request, "failure")) return;
    const rerunRequested = pendingRun;
    running = false;
    activeSimulation = null;
    pendingRun = false;
    hooks.failed?.(kind, request);
    schedulePendingRunAfterFailure(rerunRequested, schedule);
  }

  function init() {
    if (client) return;
    client = createClient({
      workerUrl,
      createWorker,
      onResult: finish,
      onFailure: fail,
      onProgress: (progress, request) => {
        if (isCurrent(request, "progress")) hooks.progress?.(progress, request);
      },
      scheduleFrame,
      setTimer,
      clearTimer
    });
  }

  function run() {
    if (running) {
      pendingRun = true;
      hooks.pending?.();
      return;
    }
    hooks.updating?.(true);
    const request = prepareRequest();
    if (!request) return;
    if (!request.options.primeItems.length) {
      pendingRun = false;
      hooks.empty?.();
      return;
    }
    running = true;
    pendingRun = false;
    hooks.started?.();
    const requestId = ++workerRequestId;
    const rotationId = getRotationId();
    activeSimulation = { ...request, requestId, rotationId };
    init();
    client.start(activeSimulation);
  }

  function cancel() {
    clearTimer(runTimer);
    runTimer = null;
    client?.cancel(activeSimulation);
    workerRequestId += 1;
    activeSimulation = null;
    running = false;
    pendingRun = false;
    hooks.cancelled?.();
  }

  return {
    schedule,
    run,
    cancel,
    init,
    get running() { return running; },
    get pendingRun() { return pendingRun; },
    get activeSimulation() { return activeSimulation; }
  };
}
