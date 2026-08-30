import { createSimulationTask } from "./simulator.js";

const TRIALS_PER_CHUNK = 500;
let activeJob = null;

function isActive(job) {
  return activeJob === job && !job.cancelled;
}

function postError(job, error) {
  if (!isActive(job)) return;
  activeJob = null;
  self.postMessage({
    requestId: job.requestId,
    rotationId: job.rotationId,
    error: error instanceof Error ? error.message : "模拟暂时无法完成"
  });
}

function runNextChunk(job) {
  if (!isActive(job)) return;
  try {
    const progress = job.task.runChunk(TRIALS_PER_CHUNK);
    if (!isActive(job)) return;
    self.postMessage({ requestId: job.requestId, rotationId: job.rotationId, progress });
    if (!progress.complete) {
      self.setTimeout(() => runNextChunk(job), 0);
      return;
    }
    const result = job.task.result();
    activeJob = null;
    self.postMessage({ requestId: job.requestId, rotationId: job.rotationId, result });
  } catch (error) {
    postError(job, error);
  }
}

self.addEventListener("message", (event) => {
  const payload = event.data || {};
  if (payload.type === "cancel") {
    if (activeJob && activeJob.requestId === payload.requestId && activeJob.rotationId === payload.rotationId) {
      activeJob.cancelled = true;
      activeJob = null;
    }
    return;
  }

  if (activeJob) activeJob.cancelled = true;
  const job = {
    requestId: payload.requestId,
    rotationId: payload.rotationId,
    cancelled: false,
    task: null
  };
  activeJob = job;
  try {
    job.task = createSimulationTask(payload.options || {});
    runNextChunk(job);
  } catch (error) {
    postError(job, error);
  }
});
