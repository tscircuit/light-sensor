export type SensorReading = {
  value: number;
  raw: number;
  time: number;
  capturedAt: number;
};

export type ScanConfig = {
  originX: number;
  originY: number;
  width: number;
  height: number;
  pitch: number;
  boardWidth: number;
  boardHeight: number;
  boardOffsetX: number;
  boardOffsetY: number;
  frameSpeed: number;
  minimumRows: number;
};

export type Intersection = {
  rowIndex: number;
  x: number;
  y: number;
  xStart: number;
  xEnd: number;
  peak: number;
  weight: number;
};

export type HoleCenter = {
  id: number;
  x: number;
  y: number;
  boardX: number;
  boardY: number;
  diameter: number;
  rowCount: number;
  confidence: number;
  residual: number;
};

export type ScanAnalysis = {
  status: "empty" | "insufficient-signal" | "missing-anchors" | "ready";
  message: string;
  threshold: number;
  baseline: number;
  noise: number;
  signal: number;
  snr: number;
  sampleRate: number;
  expectedRows: number;
  anchoredRows: number;
  intersections: Intersection[];
  holes: HoleCenter[];
};

export const DEFAULT_SCAN_CONFIG: ScanConfig = Object.freeze({
  originX: 0,
  originY: 0,
  width: 110,
  height: 75,
  pitch: 0.2,
  boardWidth: 100,
  boardHeight: 70,
  boardOffsetX: 5,
  boardOffsetY: 2.5,
  frameSpeed: 10,
  minimumRows: 3,
});

type Run = { start: number; end: number; startIndex: number; endIndex: number };

const percentile = (sorted: number[], ratio: number) => {
  if (!sorted.length) return 0;
  const position = Math.max(0, Math.min(sorted.length - 1, ratio * (sorted.length - 1)));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const amount = position - lower;
  return sorted[lower] * (1 - amount) + sorted[upper] * amount;
};

const median = (values: number[]) => percentile([...values].sort((a, b) => a - b), 0.5);

function closeSingleSampleGaps(bright: boolean[]) {
  const result = [...bright];
  for (let index = 1; index < result.length - 1; index += 1) {
    if (!result[index] && result[index - 1] && result[index + 1]) result[index] = true;
  }
  return result;
}

function collectRuns(readings: SensorReading[], bright: boolean[]): Run[] {
  const runs: Run[] = [];
  let start = -1;
  for (let index = 0; index <= bright.length; index += 1) {
    if (bright[index] && start < 0) start = index;
    if ((!bright[index] || index === bright.length) && start >= 0) {
      const endIndex = index - 1;
      runs.push({
        start: readings[start].time,
        end: readings[endIndex].time,
        startIndex: start,
        endIndex,
      });
      start = -1;
    }
  }
  return runs;
}

function solve3(matrix: number[][], vector: number[]) {
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < 3; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 3; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-10) return null;
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let index = column; index < 4; index += 1) augmented[column][index] /= divisor;
    for (let row = 0; row < 3; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let index = column; index < 4; index += 1) {
        augmented[row][index] -= factor * augmented[column][index];
      }
    }
  }
  return augmented.map((row) => row[3]);
}

function fitCircle(points: Array<{ x: number; y: number }>) {
  if (points.length < 6) return null;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let sz = 0;
  let sxz = 0;
  let syz = 0;
  points.forEach(({ x, y }) => {
    const z = -(x * x + y * y);
    sx += x;
    sy += y;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
    sz += z;
    sxz += x * z;
    syz += y * z;
  });
  const solution = solve3(
    [
      [sxx, sxy, sx],
      [sxy, syy, sy],
      [sx, sy, points.length],
    ],
    [sxz, syz, sz],
  );
  if (!solution) return null;
  const [a, b, c] = solution;
  const x = -a / 2;
  const y = -b / 2;
  const radiusSquared = x * x + y * y - c;
  if (!(radiusSquared > 0)) return null;
  const radius = Math.sqrt(radiusSquared);
  const residual = Math.sqrt(
    points.reduce((total, point) => {
      const distance = Math.hypot(point.x - x, point.y - y);
      return total + (distance - radius) ** 2;
    }, 0) / points.length,
  );
  return { x, y, radius, residual };
}

function clusterIntersections(intersections: Intersection[], config: ScanConfig, snr: number) {
  const parent = intersections.map((_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const unite = (left: number, right: number) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent[b] = a;
  };

  for (let left = 0; left < intersections.length; left += 1) {
    for (let right = left + 1; right < intersections.length; right += 1) {
      const a = intersections[left];
      const b = intersections[right];
      const rowGap = b.rowIndex - a.rowIndex;
      if (rowGap > 2) break;
      if (rowGap < 1) continue;
      const overlaps = a.xStart <= b.xEnd + 0.35 && b.xStart <= a.xEnd + 0.35;
      if (overlaps && Math.abs(a.x - b.x) <= 1.5) unite(left, right);
    }
  }

  const groups = new Map<number, Intersection[]>();
  intersections.forEach((intersection, index) => {
    const root = find(index);
    groups.set(root, [...(groups.get(root) ?? []), intersection]);
  });

  return [...groups.values()]
    .filter((group) => new Set(group.map((point) => point.rowIndex)).size >= config.minimumRows)
    .map((group) => {
      const rowCount = new Set(group.map((point) => point.rowIndex)).size;
      const boundaryPoints = group.flatMap((point) => [
        { x: point.xStart, y: point.y },
        { x: point.xEnd, y: point.y },
      ]);
      const circle = fitCircle(boundaryPoints);
      const totalWeight = group.reduce((total, point) => total + point.weight, 0) || group.length;
      const fallbackX = group.reduce((total, point) => total + point.x * point.weight, 0) / totalWeight;
      const fallbackY = group.reduce((total, point) => total + point.y * point.weight, 0) / totalWeight;
      const minX = Math.min(...group.map((point) => point.xStart));
      const maxX = Math.max(...group.map((point) => point.xEnd));
      const minY = Math.min(...group.map((point) => point.y));
      const maxY = Math.max(...group.map((point) => point.y));
      const diameter = circle && circle.radius <= 5 ? circle.radius * 2 : Math.max(maxX - minX, maxY - minY + config.pitch);
      const residual = circle?.residual ?? config.pitch;
      const confidence = Math.max(
        0,
        Math.min(1, (rowCount / 5) * Math.min(1, snr / 10) * Math.max(0.2, 1 - residual / 0.5)),
      );
      return {
        x: circle && circle.radius <= 5 ? circle.x : fallbackX,
        y: circle && circle.radius <= 5 ? circle.y : fallbackY,
        diameter,
        rowCount,
        confidence,
        residual,
      };
    })
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((hole, index): HoleCenter => ({
      id: index + 1,
      ...hole,
      boardX: hole.x - (config.originX + config.boardOffsetX),
      boardY: hole.y - (config.originY + config.boardOffsetY),
    }));
}

export function analyzeScan(readings: SensorReading[], config: ScanConfig): ScanAnalysis {
  const empty: ScanAnalysis = {
    status: "empty",
    message: "Capture a complete LightBurn pass to calculate hole centers.",
    threshold: 0,
    baseline: 0,
    noise: 0,
    signal: 0,
    snr: 0,
    sampleRate: 0,
    expectedRows: 0,
    anchoredRows: 0,
    intersections: [],
    holes: [],
  };
  if (readings.length < 20) return empty;

  const ordered = [...readings].sort((a, b) => a.time - b.time);
  const values = ordered.map((reading) => reading.raw);
  const sorted = [...values].sort((a, b) => a - b);
  const baseline = percentile(sorted, 0.2);
  const lowerValues = values.filter((value) => value <= percentile(sorted, 0.5));
  const lowerMedian = median(lowerValues);
  const mad = median(lowerValues.map((value) => Math.abs(value - lowerMedian)));
  const noise = Math.max(0.5, mad * 1.4826);
  const signal = percentile(sorted, 0.95);
  const contrast = signal - baseline;
  const snr = contrast / noise;
  const threshold = baseline + Math.max(noise * 4, contrast * 0.35);
  const deltas = ordered.slice(1).map((reading, index) => reading.time - ordered[index].time).filter((value) => value > 0);
  const sampleInterval = median(deltas);
  const sampleRate = sampleInterval > 0 ? 1000 / sampleInterval : 0;

  if (snr < 6 || contrast < 3) {
    return {
      ...empty,
      status: "insufficient-signal",
      message: "Signal contrast is too low. Improve the enclosed light path before increasing UV power.",
      threshold,
      baseline,
      noise,
      signal,
      snr,
      sampleRate,
    };
  }

  const bright = closeSingleSampleGaps(values.map((value) => value >= threshold));
  const runs = collectRuns(ordered, bright);
  const minimumAnchorDuration = (config.boardOffsetX / config.frameSpeed) * 1000 * 0.6;
  const anchors = runs.filter((run) => run.end - run.start + sampleInterval >= minimumAnchorDuration);
  const firstRowIndex = Math.ceil(config.boardOffsetY / config.pitch);
  const lastRowIndex = Math.floor((config.boardOffsetY + config.boardHeight) / config.pitch);
  const expectedRows = Math.max(0, lastRowIndex - firstRowIndex + 1);
  const anchoredRows = Math.min(expectedRows, Math.max(0, anchors.length - 1));

  if (anchors.length < expectedRows + 1) {
    return {
      ...empty,
      status: "missing-anchors",
      message: `Found ${anchoredRows} of ${expectedRows} required board rows. Capture the complete pass with exposed margins.`,
      threshold,
      baseline,
      noise,
      signal,
      snr,
      sampleRate,
      expectedRows,
      anchoredRows,
    };
  }

  const intersections: Intersection[] = [];
  for (let row = 0; row < expectedRows; row += 1) {
    const boardStart = anchors[row].end + sampleInterval / 2;
    const boardEnd = anchors[row + 1].start - sampleInterval / 2;
    if (boardEnd <= boardStart) continue;
    const rowIndex = firstRowIndex + row;
    const y = config.originY + rowIndex * config.pitch;
    runs.forEach((run) => {
      if (run.end <= boardStart || run.start >= boardEnd) return;
      if (anchors.includes(run)) return;
      const start = Math.max(run.start, boardStart);
      const end = Math.min(run.end + sampleInterval, boardEnd);
      const mapX = (time: number) =>
        config.originX + config.boardOffsetX + ((time - boardStart) / (boardEnd - boardStart)) * config.boardWidth;
      const samples = ordered.slice(run.startIndex, run.endIndex + 1).filter((sample) => sample.time >= start && sample.time <= end);
      const weights = samples.map((sample) => Math.max(0, sample.raw - threshold));
      const measuredWeight = weights.reduce((total, value) => total + value, 0);
      const weight = measuredWeight || 1;
      const weightedTime = samples.length && measuredWeight > 0
        ? samples.reduce((total, sample, index) => total + sample.time * weights[index], 0) / measuredWeight
        : (start + end) / 2;
      intersections.push({
        rowIndex,
        x: mapX(weightedTime),
        y,
        xStart: mapX(start),
        xEnd: mapX(end),
        peak: Math.max(...samples.map((sample) => sample.raw), threshold),
        weight,
      });
    });
  }

  const holes = clusterIntersections(intersections.sort((a, b) => a.rowIndex - b.rowIndex || a.x - b.x), config, snr);
  return {
    status: "ready",
    message: holes.length ? `Calculated ${holes.length} hole center${holes.length === 1 ? "" : "s"}.` : "Scan calibrated, but no multi-row holes were found.",
    threshold,
    baseline,
    noise,
    signal,
    snr,
    sampleRate,
    expectedRows,
    anchoredRows,
    intersections,
    holes,
  };
}
