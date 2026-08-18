import { simulateCurrentRotation } from "./simulator.js";

self.addEventListener("message", (event) => {
  const { requestId, rotationId, options } = event.data || {};
  try {
    const result = simulateCurrentRotation(options || {});
    self.postMessage({ requestId, rotationId, result });
  } catch (error) {
    self.postMessage({
      requestId,
      rotationId,
      error: error instanceof Error ? error.message : "模拟暂时无法完成"
    });
  }
});
