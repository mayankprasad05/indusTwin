/**
 * Build a compact replay file from the UCI "Condition monitoring of hydraulic
 * systems" dataset (ZeMA test rig).
 *
 * Source: Helwig, N., Pignanelli, E. & Schütze, A. (2015).
 *   Condition monitoring of hydraulic systems. UCI Machine Learning Repository.
 *   https://doi.org/10.24432/C5CW21  (CC BY 4.0)
 *
 * The raw download is ~74 MB zipped / ~530 MB extracted, so the repository only
 * carries the small derived file. To regenerate it:
 *
 *   1. Download and extract the dataset from the UCI page above.
 *   2. node scripts/build-hydraulic-dataset.mjs <path-to-extracted-folder>
 *
 * Each raw sensor file is a matrix: one row per 60 s load cycle, columns are
 * samples within the cycle. We downsample every channel to 1 Hz (60 points per
 * cycle) and keep a handful of cycles from a range of machine conditions.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rawDir = process.argv[2];

if (!rawDir) {
  console.error("usage: node scripts/build-hydraulic-dataset.mjs <extracted-dataset-dir>");
  process.exit(1);
}

const readMatrix = (file) =>
  readFileSync(join(rawDir, file), "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/).map(Number));

const readProfile = () =>
  readFileSync(join(rawDir, "profile.txt"), "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/).map(Number));

/** Downsample one cycle row to `target` points by averaging equal buckets. */
function downsample(row, target) {
  const out = new Array(target);
  const bucket = row.length / target;
  for (let i = 0; i < target; i++) {
    const start = Math.round(i * bucket);
    const end = Math.round((i + 1) * bucket);
    let sum = 0;
    let n = 0;
    for (let j = start; j < end; j++) {
      sum += row[j];
      n++;
    }
    out[i] = n ? sum / n : row[Math.min(row.length - 1, start)];
  }
  return out;
}

// Raw channel files and the dashboard signal each one feeds.
const CHANNELS = [
  { signal: "temperature", file: "TS1.txt", unit: "°C", label: "TS1", description: "Oil temperature" },
  { signal: "vibration", file: "VS1.txt", unit: "mm/s", label: "VS1", description: "Pump vibration" },
  { signal: "pressure", file: "PS1.txt", unit: "bar", label: "PS1", description: "System pressure" },
  { signal: "power", file: "EPS1.txt", unit: "W", label: "EPS1", description: "Motor power" },
  { signal: "airflow", file: "FS1.txt", unit: "l/min", label: "FS1", description: "Volume flow" },
];

const POINTS_PER_CYCLE = 60; // 1 Hz over the 60 s cycle

// Condition blocks, replayed in order. Each block takes `count` consecutive
// cycles matching the label tuple (cooler, valve, pump_leak, accumulator).
// Playing them back to back shows the rig degrading over a test campaign.
const BLOCKS = [
  { count: 4, labels: [100, 100, 0, 130], name: "Nominal" },
  { count: 4, labels: [100, 100, 1, 130], name: "Pump leakage (weak)" },
  { count: 4, labels: [100, 100, 2, 130], name: "Pump leakage (severe)" },
  { count: 4, labels: [100, 80, 0, 130], name: "Valve degradation" },
  { count: 4, labels: [3, 100, 0, 130], name: "Cooler failure" },
  { count: 4, labels: [3, 73, 2, 130], name: "Multiple faults" },
];

const profile = readProfile();
const matrices = {};
for (const ch of CHANNELS) {
  matrices[ch.signal] = readMatrix(ch.file);
}

const selected = [];
for (const block of BLOCKS) {
  const matches = [];
  for (let i = 0; i < profile.length; i++) {
    const [cooler, valve, pump, accumulator] = profile[i];
    if (
      cooler === block.labels[0] &&
      valve === block.labels[1] &&
      pump === block.labels[2] &&
      accumulator === block.labels[3]
    ) {
      matches.push(i);
    }
  }
  if (!matches.length) {
    console.warn(`no cycles found for ${block.name} ${block.labels.join("/")}`);
    continue;
  }
  // Take a contiguous run from the middle of the matches so the block reads
  // like one burst of the same operating condition.
  const start = Math.max(0, Math.floor(matches.length / 2) - Math.floor(block.count / 2));
  for (let k = 0; k < block.count && start + k < matches.length; k++) {
    const idx = matches[start + k];
    selected.push({
      index: idx,
      block: block.name,
      labels: {
        cooler: profile[idx][0],
        valve: profile[idx][1],
        pumpLeakage: profile[idx][2],
        accumulator: profile[idx][3],
        stable: profile[idx][4],
      },
    });
  }
}

const round = (v) => Math.round(v * 1000) / 1000;

const cycles = selected.map((sel, n) => {
  const out = {
    cycleNumber: n + 1,
    sourceCycle: sel.index + 1,
    block: sel.block,
    labels: sel.labels,
  };
  for (const ch of CHANNELS) {
    out[ch.signal] = downsample(matrices[ch.signal][sel.index], POINTS_PER_CYCLE).map(round);
  }
  return out;
});

// Per-channel statistics drive the gauge scales and nominal markers.
const stats = {};
for (const ch of CHANNELS) {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let count = 0;
  for (const cycle of cycles) {
    for (const v of cycle[ch.signal]) {
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
      count++;
    }
  }
  stats[ch.signal] = {
    source: ch.label,
    description: ch.description,
    unit: ch.unit,
    min: round(min),
    max: round(max),
    nominal: round(sum / count),
  };
}

const dataset = {
  source: {
    name: "Condition monitoring of hydraulic systems (ZeMA test rig)",
    citation:
      "Helwig, N., Pignanelli, E. & Schütze, A. (2015). Condition monitoring of hydraulic systems. UCI Machine Learning Repository.",
    doi: "10.24432/C5CW21",
    url: "https://doi.org/10.24432/C5CW21",
    license: "CC BY 4.0",
    rig: "Hydraulic test rig, ZeMA – Centre for Mechatronics and Automation, Saarland University",
    cyclesAvailable: profile.length,
    cyclesIncluded: cycles.length,
    cycleDurationSeconds: 60,
    note:
      "Real measurements, downsampled to 1 Hz per 60 s load cycle. Cycle time is not recorded by the rig and stays simulated.",
  },
  signals: stats,
  pointsPerCycle: POINTS_PER_CYCLE,
  cycles,
};

const outPath = join(here, "..", "data", "hydraulic-rig.json");
if (!existsSync(dirname(outPath))) mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(dataset));

const sizeKb = (readFileSync(outPath).length / 1024).toFixed(0);
console.log(`wrote ${outPath} (${sizeKb} KB)`);
console.log(`cycles: ${cycles.length} of ${profile.length} available`);
for (const [sig, s] of Object.entries(stats)) {
  console.log(`  ${sig.padEnd(12)} ${s.unit.padEnd(6)} min=${String(s.min).padStart(9)} max=${String(s.max).padStart(9)} mean=${String(s.nominal).padStart(9)}`);
}
