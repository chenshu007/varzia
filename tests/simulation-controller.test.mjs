import test from "node:test";
import assert from "node:assert/strict";
import { createSimulationController } from "../js/simulation-controller.js";
import { createSimulationWorkerClient } from "../js/simulation-worker-client.js";

function harness({ realClient = false, createWorker } = {}) {
  const calls = [];
  const requests = [];
  const timers = new Map();
  const workers = [];
  let nextTimer = 0;
  let callbacks;
  let rotationId = "rotation-a";
  let input = { trials: 1000, options: { primeItems: [{ id: "ember" }], budget: 40 } };
  const hooks = Object.fromEntries([
    "updating", "started", "completed", "failed", "empty", "progress", "cancelled", "stale", "pending"
  ].map((name) => [name, (...args) => calls.push({ name, args })]));
  const controller = createSimulationController({
    getRotationId: () => rotationId,
    prepareRequest: () => input,
    hooks,
    createClient: (options) => {
      callbacks = options;
      if (realClient) return createSimulationWorkerClient(options);
      return {
        start: (request) => requests.push(request),
        cancel: (request) => calls.push({ name: "clientCancel", args: [request] })
      };
    },
    createWorker: createWorker || (() => {
      const listeners = new Map();
      const worker = {
        messages: [],
        terminated: false,
        addEventListener: (name, callback) => listeners.set(name, callback),
        postMessage: (message) => worker.messages.push(message),
        terminate: () => { worker.terminated = true; },
        emit: (name, data) => listeners.get(name)?.({ data })
      };
      workers.push(worker);
      return worker;
    }),
    scheduleFrame: (callback) => callback(),
    setTimer: (callback, delay) => {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimer: (id) => timers.delete(id)
  });
  return {
    controller, calls, requests, timers, workers,
    setInput: (next) => { input = next; },
    setRotation: (next) => { rotationId = next; },
    result: (request, result = { ok: true }) => callbacks.onResult(result, request),
    progress: (request, progress) => callbacks.onProgress(progress, request),
    fail: (request, kind = "runtime") => callbacks.onFailure(request, kind),
    fireTimer: () => {
      assert.equal(timers.size, 1);
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      timer.callback();
    }
  };
}

const callsNamed = (h, name) => h.calls.filter((call) => call.name === name);

test("simulation completes with its original input after updating progress", () => {
  const h = harness();
  h.controller.init();
  h.controller.init();
  h.controller.run();
  const request = h.requests[0];
  assert.equal(h.controller.running, true);
  assert.equal(request.requestId, 1);
  assert.equal(request.rotationId, "rotation-a");
  h.progress(request, { completedTrials: 50, totalTrials: 1000 });
  assert.equal(h.controller.running, true);
  const result = { successProbability: 0.42 };
  h.result(request, result);
  assert.equal(h.controller.running, false);
  assert.equal(h.controller.activeSimulation, null);
  assert.deepEqual(h.calls.map((call) => call.name), ["updating", "started", "progress", "completed"]);
  assert.deepEqual(callsNamed(h, "completed")[0].args, [result, 1000, request]);
});

test("rapid input changes debounce once and read only the latest input", () => {
  const h = harness();
  for (const budget of [10, 20, 30]) {
    h.setInput({ trials: 500, options: { primeItems: [{ id: "ember" }], budget } });
    h.controller.schedule();
  }
  assert.equal(h.timers.size, 1);
  assert.equal([...h.timers.values()][0].delay, 80);
  assert.equal(h.requests.length, 0);
  h.fireTimer();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].options.budget, 30);
});

test("a run requested while busy discards the first result and reruns latest input once", () => {
  const h = harness();
  h.controller.run();
  const first = h.requests[0];
  for (const budget of [50, 60, 70]) {
    h.setInput({ trials: 2000, options: { primeItems: [{ id: "ember" }], budget } });
    h.controller.run();
  }
  assert.equal(h.controller.pendingRun, true);
  assert.equal(h.requests.length, 1);
  h.result(first);
  assert.equal(callsNamed(h, "completed").length, 0);
  assert.equal(h.controller.running, false);
  assert.equal(h.controller.pendingRun, false);
  h.fireTimer();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].requestId, 2);
  assert.equal(h.requests[1].options.budget, 70);
  h.result(h.requests[1]);
  assert.equal(callsNamed(h, "completed").length, 1);
});

test("stale result, failure, and progress cannot replace a newer request", () => {
  const h = harness();
  h.controller.run();
  const first = h.requests[0];
  h.controller.cancel();
  h.controller.run();
  const second = h.requests[1];
  assert.equal(second.requestId, 3);
  h.result(first);
  h.fail(first);
  h.progress(first, { completedTrials: 1000 });
  assert.equal(h.controller.activeSimulation, second);
  assert.equal(h.controller.running, true);
  assert.equal(callsNamed(h, "completed").length, 0);
  assert.equal(callsNamed(h, "failed").length, 0);
  assert.equal(callsNamed(h, "progress").length, 0);
  assert.equal(callsNamed(h, "stale").length, 3);
  h.result(second);
  assert.equal(callsNamed(h, "completed").length, 1);
});

test("rotation identity guards callbacks even before the caller cancels the old run", () => {
  const h = harness();
  h.controller.run();
  const request = h.requests[0];
  h.setRotation("rotation-b");
  h.result(request);
  h.progress(request, { completedTrials: 1000 });
  h.fail(request);
  assert.equal(callsNamed(h, "completed").length, 0);
  assert.equal(callsNamed(h, "progress").length, 0);
  assert.equal(callsNamed(h, "failed").length, 0);
  h.controller.cancel();
  h.controller.run();
  assert.equal(h.requests[1].rotationId, "rotation-b");
});

test("cancel clears scheduled and pending runs and ignores late completion", () => {
  const h = harness();
  h.controller.schedule();
  h.controller.cancel();
  assert.equal(h.timers.size, 0);
  assert.equal(h.requests.length, 0);
  h.controller.run();
  const request = h.requests[0];
  h.controller.run();
  h.controller.schedule();
  h.controller.cancel();
  assert.equal(h.timers.size, 0);
  assert.equal(h.controller.running, false);
  assert.equal(h.controller.pendingRun, false);
  assert.equal(h.controller.activeSimulation, null);
  assert.equal(callsNamed(h, "clientCancel")[0].args[0], request);
  h.result(request);
  assert.equal(callsNamed(h, "completed").length, 0);
});

test("worker failure restores idle state and only schedules a user-requested rerun", () => {
  const h = harness();
  h.controller.run();
  h.fail(h.requests[0], "timeout");
  assert.equal(h.controller.running, false);
  assert.equal(h.timers.size, 0);
  assert.equal(callsNamed(h, "failed")[0].args[0], "timeout");
  h.controller.run();
  h.controller.run();
  h.fail(h.requests[1], "runtime");
  assert.equal(h.controller.pendingRun, false);
  assert.deepEqual(h.calls.slice(-2).map((call) => call.name), ["failed", "updating"]);
  h.fireTimer();
  h.result(h.requests[2]);
  assert.equal(callsNamed(h, "completed").length, 1);
});

test("the real worker client recovers from a crash for the queued latest request", () => {
  const h = harness({ realClient: true });
  h.controller.run();
  h.controller.run();
  h.workers[0].emit("error");
  assert.equal(h.workers[0].terminated, true);
  assert.equal(h.controller.running, false);
  assert.equal(callsNamed(h, "failed")[0].args[0], "runtime");
  h.fireTimer();
  assert.equal(h.workers.length, 2);
  const request = h.controller.activeSimulation;
  h.workers[1].emit("message", { requestId: request.requestId, rotationId: request.rotationId, result: { ok: true } });
  assert.equal(h.controller.running, false);
  assert.equal(h.timers.size, 0);
  assert.equal(callsNamed(h, "completed").length, 1);
});

test("unavailable workers fail synchronously without leaving the controller running", () => {
  const h = harness({ realClient: true, createWorker: () => { throw new Error("unavailable"); } });
  h.controller.run();
  assert.equal(h.controller.running, false);
  assert.equal(h.controller.activeSimulation, null);
  assert.equal(h.timers.size, 0);
  assert.equal(callsNamed(h, "failed")[0].args[0], "unavailable");
});

test("invalid input and an empty target list never start a worker request", () => {
  const h = harness();
  h.setInput(null);
  h.controller.run();
  assert.equal(h.controller.running, false);
  assert.equal(callsNamed(h, "empty").length, 0);
  h.setInput({ trials: 1000, options: { primeItems: [] } });
  h.controller.run();
  assert.equal(h.controller.running, false);
  assert.equal(h.requests.length, 0);
  assert.equal(callsNamed(h, "empty").length, 1);
});
