import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  SIMULATION_WORKER_TIMEOUT_MS,
  SIMULATION_WORKER_VERSION,
  createSimulationWorkerClient,
  schedulePendingRunAfterFailure,
  simulationWorkerUrl
} from "../js/simulation-worker-client.js";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");

class FakeWorker {
  constructor() {
    this.listeners = new Map();
    this.messages = [];
    this.terminated = false;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  postMessage(message) {
    this.messages.push(message);
  }

  terminate() {
    this.terminated = true;
  }

  emit(type, data) {
    this.listeners.get(type)?.({ data });
  }
}

function request(requestId, rotationId = "rotation-a") {
  return { requestId, rotationId, trials: 100_000, options: { trials: 100_000 } };
}

function harness({ createWorker } = {}) {
  const workers = [];
  const results = [];
  const failures = [];
  let timer = null;
  const client = createSimulationWorkerClient({
    createWorker: createWorker || (() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    }),
    workerUrl: simulationWorkerUrl("https://example.test/js/client.js"),
    onResult: (result, completedRequest) => results.push({ result, completedRequest }),
    onFailure: (failedRequest, kind) => failures.push({ failedRequest, kind }),
    scheduleFrame: (callback) => callback(),
    setTimer: (callback) => {
      timer = callback;
      return 1;
    },
    clearTimer: () => { timer = null; }
  });
  return { client, workers, results, failures, fireTimer: () => timer?.() };
}

test("browser app never falls back to synchronous Monte Carlo work", () => {
  const app = read("../js/app.js");
  const worker = read("../js/simulation-worker.js");
  assert.doesNotMatch(app, /simulateCurrentRotation|runOnMainThread/);
  assert.match(worker, /simulateCurrentRotation/);
  assert.match(read("../js/simulation-worker-client.js"), /scheduleFrame[\s\S]*postMessage/);
});

test("worker URL is stable within a release and explicitly versioned", () => {
  const first = simulationWorkerUrl("https://example.test/js/client.js");
  const second = simulationWorkerUrl("https://example.test/js/client.js");
  assert.equal(first.href, second.href);
  assert.equal(first.searchParams.get("v"), SIMULATION_WORKER_VERSION);
});

test("worker construction failure reaches the recoverable failure path", () => {
  const { client, failures } = harness({ createWorker: () => { throw new Error("unsupported"); } });
  assert.equal(client.start(request(1)), false);
  assert.deepEqual(failures.map(({ kind }) => kind), ["unavailable"]);
});

test("worker runtime and message errors terminate the worker and permit a healthy next run", () => {
  const { client, workers, failures, results } = harness();
  client.start(request(1));
  workers[0].emit("error");
  assert.equal(workers[0].terminated, true);
  assert.deepEqual(failures.map(({ kind }) => kind), ["runtime"]);

  client.start(request(2));
  assert.equal(workers.length, 2);
  workers[1].emit("message", { requestId: 2, rotationId: "rotation-a", result: { ok: true } });
  assert.equal(results.length, 1);

  client.start(request(3));
  workers[1].emit("messageerror");
  assert.equal(workers[1].terminated, true);
  assert.deepEqual(failures.map(({ kind }) => kind), ["runtime", "runtime"]);
});

test("watchdog timeout terminates a hung worker and permits a healthy next run", () => {
  const { client, workers, failures, fireTimer } = harness();
  client.start(request(1));
  fireTimer();
  assert.equal(workers[0].terminated, true);
  assert.deepEqual(failures.map(({ kind }) => kind), ["timeout"]);
  client.start(request(2));
  assert.equal(workers.length, 2);
  assert.equal(SIMULATION_WORKER_TIMEOUT_MS, 60_000);
});

test("repeated runs reuse a healthy worker", () => {
  const { client, workers, results } = harness();
  for (const requestId of [1, 2, 3]) {
    client.start(request(requestId));
    workers[0].emit("message", { requestId, rotationId: "rotation-a", result: { requestId } });
  }
  assert.equal(workers.length, 1);
  assert.deepEqual(results.map(({ result }) => result.requestId), [1, 2, 3]);
});

test("a stale response cannot overwrite a newer run", () => {
  const { client, workers, results } = harness();
  const first = request(1);
  client.start(first);
  client.cancel(first);
  client.start(request(2));
  workers[0].emit("message", { requestId: 1, rotationId: "rotation-a", result: { stale: true } });
  assert.equal(results.length, 0);
  workers[0].emit("message", { requestId: 2, rotationId: "rotation-a", result: { current: true } });
  assert.deepEqual(results.map(({ result }) => result), [{ current: true }]);
});

test("only a user-requested pending run is scheduled after failure", () => {
  let scheduled = 0;
  assert.equal(schedulePendingRunAfterFailure(false, () => { scheduled += 1; }), false);
  assert.equal(schedulePendingRunAfterFailure(true, () => { scheduled += 1; }), true);
  assert.equal(scheduled, 1);
});

test("rotation reservation remains stable for populated and error content", () => {
  const css = read("../styles.css");
  assert.match(css, /--rotation-featured-reserve:\s*16\.25rem/);
  assert.match(css, /\.rotation-featured\s*\{[^}]*min-block-size:\s*var\(--rotation-featured-reserve\)/);
  assert.doesNotMatch(css, /\.rotation-featured:empty/);
  for (const route of ["../en/index.html", "../zh/index.html"]) {
    assert.doesNotMatch(read(route), /position:fixed;inset:0/);
  }
});
