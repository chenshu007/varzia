import { simulateCurrentRotation } from "./simulator.js";

self.addEventListener("message", (event) => {
  const { requestId, options } = event.data || {};
  try {
    const result = simulateCurrentRotation(options || {});
    self.postMessage({ requestId, result });
  } catch (error) {
    self.postMessage({
      requestId,
      error: error instanceof Error ? error.message : "模拟暂时无法完成"
    });
  }
});
