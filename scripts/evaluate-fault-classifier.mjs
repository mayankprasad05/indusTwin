/**
 * Supervised fault classification on the UCI hydraulic rig dataset.
 *
 * This turns the dashboard's unsupervised "anomaly score" into a measured
 * result: the dataset ships per-cycle condition labels (cooler, valve, pump
 * leakage, accumulator), so we can train a classifier and report how often it
 * is actually right.
 *
 * Usage:
 *   node scripts/evaluate-fault-classifier.mjs <path-to-extracted-dataset>
 *
 * Writes data/model-eval.json, which the dashboard renders.
 *
 * Method notes (these matter more than the accuracy number):
 *  - Features are computed from the RAW high-rate channels, not from the 1 Hz
 *    replay file. Downsampling throws away exactly the high-frequency content
 *    that separates valve and pump states.
 *  - The train/test split is chronological *within each class*. A random split
 *    would leak information: the rig ran each condition as a contiguous block,
 *    so neighbouring cycles are near-duplicates and a shuffled split reports
 *    near-perfect accuracy that does not mean anything.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rawDir = process.argv[2];

if (!rawDir) {
  console.error("usage: node scripts/evaluate-fault-classifier.mjs <extracted-dataset-dir>");
  process.exit(1);
}

// ---------------------------------------------------------------- data input

/** Fast whitespace-separated number parser (avoids 80M temporary strings). */
function parseNumbers(line) {
  const out = [];
  let sign = 1;
  let value = 0;
  let inNumber = false;
  let hasDigits = false;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 45 && !inNumber) {
      sign = -1;
    } else if (c >= 48 && c <= 57) {
      value = value * 10 + (c - 48);
      inNumber = true;
      hasDigits = true;
    } else if (c === 46) {
      // decimal point: consume fractional digits
      let frac = 0.1;
      let j = i + 1;
      inNumber = true;
      while (j < line.length) {
        const d = line.charCodeAt(j);
        if (d >= 48 && d <= 57) {
          value += (d - 48) * frac;
          frac /= 10;
          j++;
        } else break;
      }
      i = j - 1;
    } else {
      if (hasDigits) {
        out.push(sign * value);
      }
      sign = 1;
      value = 0;
      inNumber = false;
      hasDigits = false;
    }
  }
  if (hasDigits) out.push(sign * value);
  return out;
}

const CHANNELS = [
  "PS1", "PS2", "PS3", "PS4", "PS5", "PS6",
  "EPS1", "FS1", "FS2",
  "TS1", "TS2", "TS3", "TS4",
  "VS1", "CE", "CP", "SE",
];

const readProfile = () =>
  readFileSync(join(rawDir, "profile.txt"), "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/).map(Number));

const profile = readProfile();
const nCycles = profile.length;

const FEATURE_NAMES = ["mean", "std", "p10", "p50", "p90", "rms", "slope", "skew", "kurt"];

/** In-place iterative radix-2 FFT; length must be a power of two. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const aRe = re[i + k];
        const aIm = im[i + k];
        const bRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const bIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + len / 2] = aRe - bRe;
        im[i + k + len / 2] = aIm - bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

const BANDS = 8;

/**
 * Spectrum features: fraction of AC power in each of 8 equal bands plus the
 * dominant non-DC frequency. Pressure and flow signals are where the valve
 * switching and pump pulsation live, and cycle statistics cannot see them.
 */
function spectrumFeatures(values, sampleRate) {
  const n = values.length;
  let size = 1;
  while (size < n) size <<= 1;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += values[i];
  mean /= n;
  for (let i = 0; i < n; i++) re[i] = values[i] - mean;
  fft(re, im);

  const half = size / 2;
  const power = new Float64Array(half);
  let total = 0;
  for (let k = 1; k < half; k++) {
    power[k] = re[k] * re[k] + im[k] * im[k];
    total += power[k];
  }
  if (total <= 0) return new Array(BANDS + 1).fill(0);

  const out = new Array(BANDS + 1).fill(0);
  let bestK = 1;
  let bestP = -1;
  for (let k = 1; k < half; k++) {
    const band = Math.min(BANDS - 1, Math.floor(((k - 1) / (half - 1)) * BANDS));
    out[band] += power[k] / total;
    if (power[k] > bestP) {
      bestP = power[k];
      bestK = k;
    }
  }
  out[BANDS] = (bestK * sampleRate) / size;
  return out;
}

/** Per-cycle statistics for one channel. */
function featuresOf(values) {
  const n = values.length;
  let sum = 0, sumSq = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    sum += v;
    sumSq += v * v;
  }
  const mean = sum / n;
  let m2 = 0, m3 = 0, m4 = 0;
  for (let i = 0; i < n; i++) {
    const d = values[i] - mean;
    const d2 = d * d;
    m2 += d2;
    m3 += d2 * d;
    m4 += d2 * d2;
  }
  const std = Math.sqrt(m2 / n);
  const rms = Math.sqrt(sumSq / n);
  const skew = std > 0 ? m3 / n / std ** 3 : 0;
  const kurt = std > 0 ? m4 / n / std ** 4 : 0;

  // Least-squares slope against sample index.
  let num = 0, den = 0;
  const xMean = (n - 1) / 2;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (values[i] - mean);
    den += (i - xMean) ** 2;
  }
  const slope = den > 0 ? num / den : 0;

  const sorted = Float64Array.from(values).sort();
  const q = (p) => sorted[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))];

  return [mean, std, q(0.1), q(0.5), q(0.9), rms, slope, skew, kurt];
}

/** Sampling rate per channel, from the dataset documentation. */
const SAMPLE_RATES = {
  PS1: 100, PS2: 100, PS3: 100, PS4: 100, PS5: 100, PS6: 100,
  EPS1: 100,
  FS1: 10, FS2: 10,
  TS1: 1, TS2: 1, TS3: 1, TS4: 1,
  VS1: 1, CE: 1, CP: 1, SE: 1,
};
/** Channels whose spectrum carries the diagnostic information. */
const SPECTRAL_CHANNELS = new Set(["PS1", "PS2", "PS3", "EPS1", "FS1", "FS2"]);

console.log(`building features from ${nCycles} cycles x ${CHANNELS.length} channels ...`);
const features = Array.from({ length: nCycles }, () => []);
const featureNames = [];

for (const channel of CHANNELS) {
  const path = join(rawDir, `${channel}.txt`);
  if (!existsSync(path)) {
    console.warn(`missing ${channel}.txt, skipping`);
    continue;
  }
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const spectral = SPECTRAL_CHANNELS.has(channel);
  const rate = SAMPLE_RATES[channel] ?? 1;
  for (const n of FEATURE_NAMES) featureNames.push(`${channel}.${n}`);
  if (spectral) {
    for (let b = 0; b < BANDS; b++) featureNames.push(`${channel}.band${b}`);
    featureNames.push(`${channel}.dominantHz`);
  }
  const statsLen = FEATURE_NAMES.length;
  const specLen = spectral ? BANDS + 1 : 0;

  for (let i = 0; i < nCycles; i++) {
    const values = parseNumbers(lines[i] ?? "");
    if (!values.length) {
      for (let k = 0; k < statsLen + specLen; k++) features[i].push(0);
      continue;
    }
    features[i].push(...featuresOf(values));
    if (spectral) features[i].push(...spectrumFeatures(values, rate));
  }
  process.stdout.write(`  ${channel} done\n`);
}

const X = features.map((f) => Float64Array.from(f, (v) => (Number.isFinite(v) ? v : 0)));
const d = X[0].length;
console.log(`feature matrix: ${X.length} x ${d}`);

// ------------------------------------------------------------- classification

const TASKS = [
  {
    key: "cooler",
    label: "Cooler condition",
    column: 0,
    format: (v) => `${v}% cooling`,
    minClass: 2,
  },
  {
    key: "valve",
    label: "Valve condition",
    column: 1,
    format: (v) => `${v}% switching`,
    minClass: 2,
  },
  {
    key: "pump",
    label: "Pump leakage",
    column: 2,
    format: (v) => ["none", "weak", "severe"][v] ?? String(v),
    minClass: 2,
  },
  {
    key: "accumulator",
    label: "Accumulator pressure",
    column: 3,
    format: (v) => `${v} bar`,
    minClass: 2,
  },
];

/**
 * Blocked per-class holdout. Each class forms one or more contiguous runs of
 * recording time; whole runs are assigned to test (every fifth run), so no test
 * cycle is a near-duplicate of a training cycle from the same run. This is the
 * honest estimate of generalising to an unseen recording period.
 */
function blockedSplit(labels, testFraction = 0.2) {
  const byClass = new Map();
  labels.forEach((y, i) => {
    if (!byClass.has(y)) byClass.set(y, []);
    byClass.get(y).push(i);
  });

  const train = [];
  const test = [];

  for (const [, idxs] of byClass) {
    // Split the class's cycles into contiguous runs.
    const runs = [];
    let run = [idxs[0]];
    for (let k = 1; k < idxs.length; k++) {
      if (idxs[k] === idxs[k - 1] + 1) run.push(idxs[k]);
      else {
        runs.push(run);
        run = [idxs[k]];
      }
    }
    runs.push(run);

    if (runs.length === 1) {
      // Only one run for this class: hold out its tail instead.
      const only = runs[0];
      if (only.length < 4) {
        train.push(...only);
        continue;
      }
      const nTest = Math.max(1, Math.round(only.length * testFraction));
      train.push(...only.slice(0, only.length - nTest));
      test.push(...only.slice(only.length - nTest));
      continue;
    }

    const stride = Math.max(2, Math.round(1 / testFraction));
    let candidates = runs.filter((_, k) => (k + 1) % stride === 0);
    if (!candidates.length) candidates = [runs[runs.length - 1]];

    for (const r of runs) {
      if (candidates.includes(r)) test.push(...r);
      else train.push(...r);
    }
  }

  train.sort((a, b) => a - b);
  test.sort((a, b) => a - b);
  return { train, test };
}

/** Stratified random holdout. Included only as a reference point: because the
 *  rig ran each condition as a contiguous block, neighbouring cycles are near
 *  duplicates, so a shuffled split leaks and reports inflated accuracy. */
function randomSplit(labels, testFraction = 0.2, seed = 42) {
  let s = seed;
  const next = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
  const byClass = new Map();
  labels.forEach((y, i) => {
    if (!byClass.has(y)) byClass.set(y, []);
    byClass.get(y).push(i);
  });
  const train = [];
  const test = [];
  for (const [, idxs] of byClass) {
    const shuffled = [...idxs];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const nTest = Math.max(1, Math.round(shuffled.length * testFraction));
    test.push(...shuffled.slice(0, nTest));
    train.push(...shuffled.slice(nTest));
  }
  train.sort((a, b) => a - b);
  test.sort((a, b) => a - b);
  return { train, test };
}

function standardise(trainIdx, all) {
  const mu = new Float64Array(d);
  const sigma = new Float64Array(d);
  for (const i of trainIdx) {
    for (let j = 0; j < d; j++) mu[j] += all[i][j];
  }
  for (let j = 0; j < d; j++) mu[j] /= trainIdx.length;
  for (const i of trainIdx) {
    for (let j = 0; j < d; j++) {
      const dv = all[i][j] - mu[j];
      sigma[j] += dv * dv;
    }
  }
  for (let j = 0; j < d; j++) {
    sigma[j] = Math.sqrt(sigma[j] / trainIdx.length) || 1;
  }
  return { mu, sigma };
}

function standardised(rows, indices, { mu, sigma }) {
  return indices.map((i) => {
    const out = new Float64Array(d);
    for (let j = 0; j < d; j++) out[j] = (rows[i][j] - mu[j]) / sigma[j];
    return out;
  });
}

/** Multinomial logistic regression (softmax) with L2 regularisation and
 *  inverse-frequency class weights, so rare conditions are not drowned out by
 *  the dominant one. */
function trainSoftmax(Xtr, ytr, K, { epochs = 600, lr = 0.5, l2 = 1e-3 } = {}) {
  const n = Xtr.length;
  const W = Array.from({ length: K }, () => new Float64Array(d));
  const b = new Float64Array(K);
  const gradW = Array.from({ length: K }, () => new Float64Array(d));
  const gradB = new Float64Array(K);
  const z = new Float64Array(K);
  const p = new Float64Array(K);

  const counts = new Array(K).fill(0);
  for (const y of ytr) counts[y] += 1;
  const weights = Float64Array.from(ytr, (y) => n / (K * (counts[y] || 1)));

  for (let epoch = 0; epoch < epochs; epoch++) {
    for (let k = 0; k < K; k++) {
      gradB[k] = 0;
      gradW[k].fill(0);
    }
    for (let i = 0; i < n; i++) {
      const row = Xtr[i];
      let maxZ = -Infinity;
      for (let k = 0; k < K; k++) {
        let s = b[k];
        const wk = W[k];
        for (let j = 0; j < d; j++) s += wk[j] * row[j];
        z[k] = s;
        if (s > maxZ) maxZ = s;
      }
      let sumExp = 0;
      for (let k = 0; k < K; k++) {
        p[k] = Math.exp(z[k] - maxZ);
        sumExp += p[k];
      }
      for (let k = 0; k < K; k++) {
        p[k] /= sumExp;
        const g = (p[k] - (ytr[i] === k ? 1 : 0)) * weights[i];
        gradB[k] += g;
        if (g !== 0) {
          const gw = gradW[k];
          for (let j = 0; j < d; j++) gw[j] += g * row[j];
        }
      }
    }
    const step = lr / (1 + epoch / 200);
    for (let k = 0; k < K; k++) {
      b[k] -= (step * gradB[k]) / n;
      for (let j = 0; j < d; j++) {
        W[k][j] -= step * (gradW[k][j] / n + l2 * W[k][j]);
      }
    }
  }

  return {
    weights: W,
    /** Strongest features (by |weight|) for each class — what the decision is
     *  actually built from, rather than a hand-written guess. */
    topFeatures(k, count = 6) {
      return Array.from(W[k])
        .map((w, j) => ({ name: featureNames[j], weight: Math.round(w * 1000) / 1000 }))
        .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
        .slice(0, count);
    },
    predict(row) {
      let best = 0;
      let bestScore = -Infinity;
      for (let k = 0; k < K; k++) {
        let s = b[k];
        const wk = W[k];
        for (let j = 0; j < d; j++) s += wk[j] * row[j];
        if (s > bestScore) {
          bestScore = s;
          best = k;
        }
      }
      return best;
    },
  };
}

/** Rank-based AUC for a binary label / continuous score. */
function auc(scores, positive) {
  const pairs = scores.map((s, i) => ({ s, y: positive[i] ? 1 : 0 }));
  pairs.sort((a, b) => a.s - b.s);
  let rankSum = 0;
  let i = 0;
  while (i < pairs.length) {
    let j = i;
    while (j + 1 < pairs.length && pairs[j + 1].s === pairs[i].s) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (pairs[k].y === 1) rankSum += avgRank;
    i = j + 1;
  }
  const nPos = positive.filter(Boolean).length;
  const nNeg = positive.length - nPos;
  if (!nPos || !nNeg) return null;
  return (rankSum - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

const round = (v, p = 4) => (v == null ? null : Math.round(v * 10 ** p) / 10 ** p);

const results = {};
const evaluated = [];

for (const task of TASKS) {
  const rawLabels = profile.map((row) => row[task.column]);
  const classes = [...new Set(rawLabels)].sort((a, b) => a - b);
  if (classes.length < task.minClass) {
    console.warn(`skipping ${task.key}: only ${classes.length} classes`);
    continue;
  }
  const labelToIdx = new Map(classes.map((c, i) => [c, i]));
  const y = rawLabels.map((v) => labelToIdx.get(v));

  const K = classes.length;

  const run = (split) => {
    const { train, test } = split;
    const scaler = standardise(train, X);
    const Xtr = standardised(X, train, scaler);
    const Xte = standardised(X, test, scaler);
    const model = trainSoftmax(Xtr, train.map((i) => y[i]), K);
    const drivers = classes.map((c, k) => ({
      class: task.format(c),
      features: model.topFeatures(k),
    }));

    const confusion = Array.from({ length: K }, () => new Array(K).fill(0));
    let correct = 0;
    for (let t = 0; t < test.length; t++) {
      const truth = y[test[t]];
      const pred = model.predict(Xte[t]);
      confusion[truth][pred] += 1;
      if (pred === truth) correct++;
    }

    const perClass = classes.map((c, k) => {
      const tp = confusion[k][k];
      const support = confusion[k].reduce((a, b) => a + b, 0);
      const predicted = confusion.reduce((acc, row) => acc + row[k], 0);
      const precision = predicted ? tp / predicted : 0;
      const recall = support ? tp / support : 0;
      const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
      return {
        label: task.format(c),
        value: c,
        precision: round(precision),
        recall: round(recall),
        f1: round(f1),
        support,
      };
    });

    return {
      accuracy: round(correct / test.length),
      macroF1: round(perClass.reduce((a, c) => a + c.f1, 0) / perClass.length),
      drivers,
      trainSize: train.length,
      testSize: test.length,
      confusion,
      perClass,
    };
  };

  const primary = run(blockedSplit(y));
  const reference = run(randomSplit(y));

  results[task.key] = {
    label: task.label,
    classes: classes.map(task.format),
    classValues: classes,
    chance: round(1 / K),
    accuracy: primary.accuracy,
    macroF1: primary.macroF1,
    trainSize: primary.trainSize,
    testSize: primary.testSize,
    confusion: primary.confusion,
    perClass: primary.perClass,
    drivers: primary.drivers,
    randomSplit: {
      accuracy: reference.accuracy,
      macroF1: reference.macroF1,
      note: "stratified random split — optimistic, because adjacent cycles from the same condition block are near-duplicates",
    },
  };
  evaluated.push(task.key);

  console.log(
    `${task.label.padEnd(22)} blocked acc ${(primary.accuracy * 100).toFixed(1)}%  F1 ${primary.macroF1.toFixed(3)}` +
      `   |  random acc ${(reference.accuracy * 100).toFixed(1)}%  F1 ${reference.macroF1.toFixed(3)}` +
      `  (chance ${((1 / K) * 100).toFixed(0)}%, test n=${primary.testSize})`
  );
}

// ----------------------------------------------------- unsupervised baseline

// Same shape as the dashboard's anomaly score: mean-normalised drift and
// spread on the key signals, with no labels involved. Included so the report
// can compare supervised diagnosis against the heuristic the app already shows.
const driftFormula = (channel) => {
  let offset = 0;
  for (const c of CHANNELS) {
    if (c === channel) break;
    offset += FEATURE_NAMES.length + (SPECTRAL_CHANNELS.has(c) ? BANDS + 1 : 0);
  }
  if (!CHANNELS.includes(channel)) return X.map(() => 0);
  const mean = X.map((row) => row[offset]);
  const std = X.map((row) => row[offset + 1]);
  const slope = X.map((row) => row[offset + 6]);
  return X.map((_, i) => {
    const m = Math.abs(mean[i]) || 1;
    return Math.abs(slope[i]) / m + std[i] / m;
  });
};

const keys = ["PS1", "VS1", "EPS1"].filter((c) => CHANNELS.includes(c));
if (keys.length) {
  const series = keys.map(driftFormula);
  const combined = X.map((_, i) => {
    let s = 0;
    for (const arr of series) s += arr[i];
    return Math.min(1, s / series.length);
  });
  const positive = profile.map((row) => row[0] < 100 || row[1] < 100 || row[2] > 0);
  const driftAuc = auc(combined, positive);
  console.log(
    `unsupervised drift score vs any-fault label: AUC ${driftAuc ? driftAuc.toFixed(3) : "n/a"}`
  );
  results.__baseline = {
    label: "Unsupervised drift score (what the dashboard shows)",
    auc: round(driftAuc),
    positives: positive.filter(Boolean).length,
    negatives: positive.length - positive.filter(Boolean).length,
    note:
      "Same form as the dashboard anomaly score (mean-normalised |slope| + spread) on PS1, VS1 and EPS1, scored against 'any condition degraded'. Threshold-free, so AUC is the fair comparison.",
  };
}

const out = {
  generatedAt: new Date().toISOString(),
  dataset: {
    name: "Condition monitoring of hydraulic systems (ZeMA test rig)",
    doi: "10.24432/C5CW21",
    cycles: nCycles,
    channels: CHANNELS,
  },
  method: {
    features: `${FEATURE_NAMES.join(", ")} per channel, plus 8-band spectral power and dominant frequency for ${[...SPECTRAL_CHANNELS].join(", ")} (${d} features per cycle), computed from the raw high-rate signals`,
    split:
      "blocked 80/20 holdout: whole contiguous recording runs are held out per class, so no test cycle is a near-duplicate of a training cycle. A stratified random split is reported alongside for reference, because it is what inflates most published numbers on this dataset.",
    model: "multinomial logistic regression (softmax), L2 regularised, inverse-frequency class weights",
    caveat:
      "Labels describe conditions set by the experimenter, not failures observed in service. The numbers show that sensor data identifies these four rig conditions; they do not prove transfer to another machine.",
  },
  order: evaluated,
  tasks: results,
};

const outPath = join(here, "..", "data", "model-eval.json");
if (!existsSync(dirname(outPath))) mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`\nwrote ${outPath}`);
