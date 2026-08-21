import test from "node:test";
import assert from "node:assert/strict";
import {
  ROTATION_TIME,
  countdownUpdateDelay,
  formatRotationCountdown,
  getTimeUntilRotation,
  isSimulationResponseCurrent,
  publishedRotations,
  resolveRotationState,
  resolveRotationView
} from "../js/rotation-schedule.js";

const rotations = [
  { id: "A", publicationStatus: "published", startsAt: "2026-08-01T18:00:00Z" },
  { id: "B", publicationStatus: "published", startsAt: "2026-09-01T18:00:00Z" },
  { id: "C", publicationStatus: "published", startsAt: "2026-10-01T18:00:00Z" }
];
const boundary = Date.parse(rotations[1].startsAt);

test("两期之间会解析当前、下一期和上一期", () => {
  const resolved = resolveRotationState(rotations, Date.parse("2026-09-15T00:00:00Z"));
  assert.equal(resolved.activeRotation.id, "B");
  assert.equal(resolved.nextRotation.id, "C");
  assert.equal(resolved.previousRotation.id, "A");
});

test("startsAt 前 1ms 仍是旧轮换", () => {
  const resolved = resolveRotationState(rotations, boundary - 1);
  assert.equal(resolved.activeRotation.id, "A");
  assert.equal(resolved.nextRotation.id, "B");
});

test("startsAt 当毫秒立即切换为新轮换", () => {
  const resolved = resolveRotationState(rotations, boundary);
  assert.equal(resolved.activeRotation.id, "B");
  assert.equal(resolved.nextRotation.id, "C");
});

test("startsAt 后 1ms 仍是新轮换", () => {
  const resolved = resolveRotationState(rotations, boundary + 1);
  assert.equal(resolved.activeRotation.id, "B");
  assert.equal(resolved.nextRotation.id, "C");
});

test("只有一个已生效轮换时 next 为 null", () => {
  const resolved = resolveRotationState([rotations[0]], Date.parse("2026-08-02T00:00:00Z"));
  assert.equal(resolved.activeRotation.id, "A");
  assert.equal(resolved.nextRotation, null);
});

test("早于首期时 active 为 null 且 next 为首期", () => {
  const resolved = resolveRotationState(rotations, Date.parse("2026-07-01T00:00:00Z"));
  assert.equal(resolved.activeRotation, null);
  assert.equal(resolved.nextRotation.id, "A");
  assert.equal(resolved.previousRotation, null);
});

test("resolver 不依赖 JSON 数组顺序并选择最近未来轮换", () => {
  const resolved = resolveRotationState([rotations[2], rotations[0], rotations[1]], Date.parse("2026-08-15T00:00:00Z"));
  assert.equal(resolved.activeRotation.id, "A");
  assert.equal(resolved.nextRotation.id, "B");
});

test("倒计时格式按时间范围降级且永不为负", () => {
  assert.equal(formatRotationCountdown(14 * ROTATION_TIME.DAY_MS + 6 * ROTATION_TIME.HOUR_MS), "14 天 6 小时");
  assert.equal(formatRotationCountdown(3 * ROTATION_TIME.DAY_MS + 6 * ROTATION_TIME.HOUR_MS + 27 * ROTATION_TIME.MINUTE_MS), "3 天 06:27");
  assert.equal(formatRotationCountdown(18 * ROTATION_TIME.HOUR_MS + 42 * ROTATION_TIME.MINUTE_MS + 16 * ROTATION_TIME.SECOND_MS), "18:42:16");
  assert.equal(formatRotationCountdown(42 * ROTATION_TIME.MINUTE_MS + 16 * ROTATION_TIME.SECOND_MS), "00:42:16");
  assert.equal(formatRotationCountdown(-1), "00:00:00");
  assert.equal(formatRotationCountdown(0), "00:00:00");
});

test("英文倒计时使用英文单位并保留既有时间范围", () => {
  assert.equal(formatRotationCountdown(14 * ROTATION_TIME.DAY_MS + 6 * ROTATION_TIME.HOUR_MS, "en"), "14d 6h");
  assert.equal(formatRotationCountdown(3 * ROTATION_TIME.DAY_MS + 6 * ROTATION_TIME.HOUR_MS + 27 * ROTATION_TIME.MINUTE_MS, "en"), "3d 06:27");
  assert.equal(formatRotationCountdown(18 * ROTATION_TIME.HOUR_MS + 42 * ROTATION_TIME.MINUTE_MS + 16 * ROTATION_TIME.SECOND_MS, "en"), "18:42:16");
});

test("非有限倒计时输入显示安全占位符", () => {
  assert.equal(formatRotationCountdown(Infinity), "—");
  assert.equal(formatRotationCountdown(-Infinity), "—");
  assert.equal(formatRotationCountdown(NaN), "—");
});

test("长倒计时每分钟更新，最后 24 小时每秒更新并对齐边界", () => {
  assert.equal(countdownUpdateDelay(2 * ROTATION_TIME.DAY_MS), ROTATION_TIME.MINUTE_MS);
  assert.equal(countdownUpdateDelay(ROTATION_TIME.HOUR_MS), ROTATION_TIME.SECOND_MS);
  assert.equal(countdownUpdateDelay(500), 500);
  assert.equal(countdownUpdateDelay(0), 0);
  assert.equal(getTimeUntilRotation(rotations[1], boundary - 1), 1);
  assert.equal(getTimeUntilRotation(rotations[1], boundary + 1), 0);
});

test("预览参数临时选择指定轮换，无效 id 回退真实轮换", () => {
  const preview = resolveRotationView(rotations, boundary - 1, "C");
  assert.equal(preview.activeRotation.id, "A");
  assert.equal(preview.displayRotation.id, "C");
  assert.equal(preview.isPreview, true);

  const invalid = resolveRotationView(rotations, boundary - 1, "missing");
  assert.equal(invalid.displayRotation.id, "A");
  assert.equal(invalid.isPreview, false);
  assert.equal(invalid.invalidPreviewId, "missing");
});

test("provisional 轮换不进入正常排期但仍可通过显式参数预览", () => {
  const allRotations = [
    rotations[0],
    { ...rotations[1], publicationStatus: "provisional" }
  ];
  const productionSchedule = publishedRotations(allRotations);
  const normal = resolveRotationView(productionSchedule, boundary + 1);
  assert.equal(normal.activeRotation.id, "A");
  assert.equal(normal.nextRotation, null);

  const preview = resolveRotationView(productionSchedule, boundary + 1, "B", allRotations);
  assert.equal(preview.activeRotation.id, "A");
  assert.equal(preview.displayRotation.id, "B");
  assert.equal(preview.isPreview, true);
});

test("轮换改变后旧 Worker 结果会被拒绝", () => {
  const request = { requestId: 7, rotationId: "A" };
  assert.equal(isSimulationResponseCurrent(request, { requestId: 7, rotationId: "A" }, "A"), true);
  assert.equal(isSimulationResponseCurrent(request, { requestId: 7, rotationId: "A" }, "B"), false);
  assert.equal(isSimulationResponseCurrent(request, { requestId: 7, rotationId: "B" }, "B"), false);
  assert.equal(isSimulationResponseCurrent(request, { requestId: 6, rotationId: "A" }, "A"), false);
});
