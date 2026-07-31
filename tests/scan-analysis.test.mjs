import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeScan,
  DEFAULT_SCAN_CONFIG,
} from "../app/scan-analysis.ts";

function syntheticScan() {
  const readings = [];
  const holes = [
    { x: 25, y: 22.5, radius: 0.5 },
    { x: 75, y: 47.5, radius: 0.5 },
  ];
  const sampleInterval = 16;
  const lineDuration = (DEFAULT_SCAN_CONFIG.width / DEFAULT_SCAN_CONFIG.frameSpeed) * 1000;
  let time = 0;

  for (let row = 0; row < 376; row += 1) {
    const y = row * DEFAULT_SCAN_CONFIG.pitch;
    const count = Math.ceil(lineDuration / sampleInterval);
    for (let sample = 0; sample < count; sample += 1) {
      const x = (sample / (count - 1)) * DEFAULT_SCAN_CONFIG.width;
      const outsideBoard =
        y < DEFAULT_SCAN_CONFIG.boardOffsetY ||
        y > DEFAULT_SCAN_CONFIG.boardOffsetY + DEFAULT_SCAN_CONFIG.boardHeight ||
        x < DEFAULT_SCAN_CONFIG.boardOffsetX ||
        x > DEFAULT_SCAN_CONFIG.boardOffsetX + DEFAULT_SCAN_CONFIG.boardWidth;
      const throughHole = holes.some(
        (hole) => Math.hypot(x - hole.x, y - hole.y) <= hole.radius,
      );
      const raw = (outsideBoard || throughHole ? 100 : 10) + Math.sin(readings.length * 0.7) * 0.35;
      readings.push({ value: raw / 1.2, raw, time, capturedAt: time });
      time += sampleInterval;
    }
  }
  return readings;
}

test("consolidates adjacent row spikes into absolute hole centers", () => {
  const result = analyzeScan(syntheticScan(), {
    ...DEFAULT_SCAN_CONFIG,
    originX: 40,
    originY: 30,
  });

  assert.equal(result.status, "ready");
  assert.equal(result.anchoredRows, 350);
  assert.equal(result.holes.length, 2);
  assert.ok(Math.abs(result.holes[0].x - 65) < 0.3);
  assert.ok(Math.abs(result.holes[0].y - 52.5) < 0.3);
  assert.ok(Math.abs(result.holes[1].x - 115) < 0.3);
  assert.ok(Math.abs(result.holes[1].y - 77.5) < 0.3);
  assert.ok(result.holes.every((hole) => hole.rowCount >= 3));
});

test("fails closed when contrast is inadequate", () => {
  const readings = Array.from({ length: 500 }, (_, index) => ({
    value: 8,
    raw: 10 + Math.sin(index) * 0.1,
    time: index * 16,
    capturedAt: index * 16,
  }));
  const result = analyzeScan(readings, DEFAULT_SCAN_CONFIG);
  assert.equal(result.status, "insufficient-signal");
  assert.equal(result.holes.length, 0);
});
