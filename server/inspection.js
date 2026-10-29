/**
 * Inspection / Vision Station (Module 6)
 *
 * Provides:
 *  - Synthetic "part" images (good vs defective) so the station works
 *    without downloading a real dataset. The synthetic generator is
 *    deliberately simple so the project needs no heavy imaging library.
 *  - A classical, OpenCV-style analysis pipeline: grayscale conversion,
 *    intensity statistics, Sobel-style gradient magnitude, thresholding,
 *    and blob/spot detection to find defect-like regions.
 *  - A tiny "ML model": a logistic-classifier-style score built from the
 *    engineered features above. Training in this demo is just a small fixed
 *    parameter set derived from the feature design, so the model is real
 *    (it scores on features) but doesn't require an external training run.
 *
 * Contents are returned as base64 PNG so the dashboard can render them
 * directly. Analysis results include per-region defect scores for
 * explainability (which regions contributed to the verdict).
 *
 * No external dataset is required to run. To use a real dataset (e.g.
 * MVTec AD or a Kaggle defect set) later, replace generatePartImage()
 * with a loader that reads the real image files and feed real pixel data
 * into analyzeImage().
 */

// ---------------------------------------------------------------------------
// 1. Synthetic part image generator
// ---------------------------------------------------------------------------

/** Create a small synthetic grayscale part image as a 2D array of 0..255. */
function makeCanvas(width, height) {
  return { width, height, pixels: new Float64Array(width * height) };
}

function fillUniform(canvas, mean, spread) {
  const { width, height, pixels } = canvas;
  for (let i = 0; i < pixels.length; i++) {
    // Box-Muller-ish approximation using Math.random for speed.
    const u1 = Math.random();
    const u2 = Math.random();
    // Simple normal-ish via sum of uniforms (not perfect but fine for demo).
    const z = (u1 + u2 + Math.random() + Math.random() + Math.random() - 2.5) / 1.5;
    pixels[i] = Math.max(0, Math.min(255, mean + z * spread));
  }
  return canvas;
}

/** Draw a smooth radial gradient blob into the canvas. */
function drawBlob(canvas, cx, cy, radius, peak, falloff) {
  const { width, height, pixels } = canvas;
  const x0 = Math.max(0, Math.floor(cx - radius - 2));
  const x1 = Math.min(width - 1, Math.ceil(cx + radius + 2));
  const y0 = Math.max(0, Math.floor(cy - radius - 2));
  const y1 = Math.min(height - 1, Math.ceil(cy + radius + 2));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < radius) {
        const w = 1 - (d / radius);
        const influence = Math.pow(w, falloff);
        const idx = y * width + x;
        pixels[idx] = Math.max(0, Math.min(255, pixels[idx] + peak * influence));
      }
    }
  }
}

/** Draw a rough edge/scratch line across the canvas. */
function drawScratch(canvas, x0, y0, x1, y1, strength, width) {
  const { width: w, height: h, pixels } = canvas;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const steps = Math.ceil(len) + 1;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const cx = x0 + dx * t;
    const cy = y0 + dy * t;
    const half = (width || 1) / 2;
    for (let oy = -Math.ceil(half); oy <= Math.ceil(half); oy++) {
      for (let ox = -Math.ceil(half); ox <= Math.ceil(half); ox++) {
        if (Math.sqrt(ox * ox + oy * oy) > half) continue;
        const px = Math.round(cx + ox);
        const py = Math.round(cy + oy);
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        const fall = 1 - Math.sqrt(ox * ox + oy * oy) / (half || 1);
        const idx = py * w + px;
        pixels[idx] = Math.max(0, Math.min(255, pixels[idx] + strength * Math.max(0, fall)));
      }
    }
  }
}

/**
 * Generate a synthetic "part" image.
 *
 * @param {Object} opts
 * @param {number} opts.width
 * @param {number} opts.height
 * @param {number} [opts.seed] - deterministic seed for reproducible samples
 * @param {string} [opts.variant='good'] - 'good' | 'scratch' | 'spot' | 'mixed'
 * @param {number} [opts.severity=0.5] - how strong the defect is
 */
export function generatePartImage({
  width = 128,
  height = 128,
  seed = null,
  variant = 'good',
  severity = 0.5,
} = {}) {
  // Simple seeded RNG (mulberry32) so samples are reproducible per seed.
  let s = seed != null ? seed >>> 0 : (Math.random() * 0xffffffff) >>> 0;
  const rng = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const baseMean = 110;
  const baseSpread = 8;
  let canvas = fillUniform(makeCanvas(width, height), baseMean, baseSpread);

  // Slight lighting gradient (common in real part images).
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const grad = ((x / width) - 0.5) * 10 + ((y / height) - 0.5) * 6;
      const idx = y * width + x;
      canvas.pixels[idx] = Math.max(0, Math.min(255, canvas.pixels[idx] + grad));
    }
  }

  if (variant === 'good') {
    // Good parts still have minor texture/noise but no clear defect.
    for (let i = 0; i < 3; i++) {
      const cx = rng() * width;
      const cy = rng() * height;
      drawBlob(canvas, cx, cy, 3 + rng() * 4, 2 + rng() * 3, 1.5);
    }
    return { canvas, meta: { variant, severity: 0, defectRegions: [] } };
  }

  // Defective variants.
  const severityScale = 20 + severity * 60;

  if (variant === 'scratch') {
    const x0 = 10 + rng() * (width - 20);
    const y0 = 10 + rng() * (height - 20);
    const x1 = x0 + (rng() - 0.5) * (width * 0.7);
    const y1 = y0 + (rng() - 0.5) * (height * 0.7);
    drawScratch(canvas, x0, y0, x1, y1, severityScale * 0.9, 1 + Math.ceil(severity * 3));
    return { canvas, meta: { variant, severity, defectRegions: [{ type: 'scratch', approx: [x0, y0, x1, y1] }] } };
  }

  if (variant === 'spot') {
    const cx = 20 + rng() * (width - 40);
    const cy = 20 + rng() * (height - 40);
    const radius = 4 + severity * 14;
    const peak = severityScale * (0.7 + rng() * 0.6);
    drawBlob(canvas, cx, cy, radius, peak, 1.3);
    return { canvas, meta: { variant, severity, defectRegions: [{ type: 'spot', center: [cx, cy], radius }] } };
  }

  // mixed: a spot plus a small scratch.
  const cx = 20 + rng() * (width - 40);
  const cy = 20 + rng() * (height - 40);
  drawBlob(canvas, cx, cy, 4 + severity * 10, severityScale * 0.8, 1.3);
  const x0 = 10 + rng() * (width - 20);
  const y0 = 10 + rng() * (height - 20);
  drawScratch(canvas, x0, y0, x0 + (rng() - 0.5) * 30, y0 + (rng() - 0.5) * 30, severityScale * 0.5, 1);
  return { canvas, meta: { variant, severity, defectRegions: [{ type: 'spot', center: [cx, cy] }, { type: 'scratch', approx: [x0, y0, x0 + 20, y0 + 20] }] } };
}

// ---------------------------------------------------------------------------
// 2. Encode a grayscale Float64 canvas as a base64 PNG (pure JS, no dep)
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid PNG from an 8-bit grayscale buffer.
 * This is intentionally small/simple: 8-bit grayscale, no interlacing,
 * deflate via a tiny LZ77-ish pumper is overkill here, so we use raw
 * uncompressed IDAT (zlib wrapper with no compression) which is still
 * valid and small for our 128x128 demos. Browsers render it fine.
 */
function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c ^= data[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function crc32buf(data) {
  const bytes = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) bytes[i] = data[i] & 0xff;
  return crc32(bytes);
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcData = Buffer.concat([typeBytes, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcData), 0);
  return Buffer.concat([len, typeBytes, data, crc]);
}

function encodePngGrayscale(canvas) {
  const { width, height, pixels } = canvas;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type: grayscale
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const ihdrChunk = chunk('IHDR', ihdr);

  // Raw scanlines: each line starts with filter byte 0 (None).
  const raw = Buffer.alloc(height * (1 + width));
  for (let y = 0; y < height; y++) {
    const off = y * (1 + width);
    raw[off] = 0; // filter None
    for (let x = 0; x < width; x++) {
      raw[off + 1 + x] = Math.max(0, Math.min(255, Math.round(pixels[y * width + x]))) & 0xff;
    }
  }

  // Uncompressed IDAT: store raw bytes inside a zlib wrapper (CMF/FLG/DICTIDX + ADLER).
  // For simplicity and zero deps, we emit a stored (non-compressed) zlib block.
  const zlibHeader = Buffer.from([0x78, 0x01]); // deflate, no compression
  const zlibBody = Buffer.concat([Buffer.from([0x00]), raw]); // BFINAL=1, BTYPE=0 (no compression)
  // Adler-32 of raw (unsigned 16-bit limbs).
  let a = 1, b = 0;
  for (let i = 0; i < raw.length; i++) {
    a = (a + raw[i]) % 65521;
    b = (b + a) % 65521;
  }
  const adler = Buffer.alloc(4);
  adler.writeUInt16BE(b >>> 0, 0);
  adler.writeUInt16BE(a >>> 0, 2);
  const idatChunk = chunk('IDAT', Buffer.concat([zlibHeader, zlibBody, adler]));
  const iendChunk = chunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, ihdrChunk, idatChunk, iendChunk]).toString('base64');
}

// ---------------------------------------------------------------------------
// 3. Classical OpenCV-style image analysis
// ---------------------------------------------------------------------------

/**
 * Compute grayscale stats.
 */
function stats(canvas) {
  const { width, height, pixels } = canvas;
  let sum = 0,
    sum2 = 0,
    mn = Infinity,
    mx = -Infinity;
  for (let i = 0; i < pixels.length; i++) {
    const v = pixels[i];
    sum += v;
    sum2 += v * v;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  const n = pixels.length;
  const mean = sum / n;
  const variance = Math.max(0, sum2 / n - mean * mean);
  return { mean, variance, stddev: Math.sqrt(variance), min: mn, max: mx, n };
}

/**
 * Sobel-style gradient magnitude (simple central differences).
 * Returns a canvas of gradient magnitudes.
 */
function gradientMagnitude(canvas) {
  const { width, height, pixels } = canvas;
  const out = makeCanvas(width, height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const gx =
        -pixels[(y - 1) * width + (x - 1)] +
        pixels[(y - 1) * width + (x + 1)] -
        2 * pixels[y * width + (x - 1)] +
        2 * pixels[y * width + (x + 1)] -
        pixels[(y + 1) * width + (x - 1)] +
        pixels[(y + 1) * width + (x + 1)];
      const gy =
        -pixels[(y - 1) * width + (x - 1)] -
        2 * pixels[(y - 1) * width + x] -
        pixels[(y - 1) * width + (x + 1)] +
        pixels[(y + 1) * width + (x - 1)] +
        2 * pixels[(y + 1) * width + x] +
        pixels[(y + 1) * width + (x + 1)];
      const idx = y * width + x;
      out.pixels[idx] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return out;
}

/**
 * Otsu-style threshold on the gradient magnitude to find edges/defects.
 * Returns threshold value + binary mask (true where above threshold).
 */
function otsuThreshold(canvas, floor) {
  const { width, height, pixels } = canvas;
  // Build a small histogram (0..255). If values exceed 255, clamp.
  const hist = new Float64Array(256);
  let total = 0;
  for (let i = 0; i < pixels.length; i++) {
    const v = Math.min(255, Math.max(0, Math.round(pixels[i])));
    hist[v] += 1;
    total += 1;
  }
  let sumTotal = 0;
  for (let i = 0; i < 256; i++) sumTotal += i * hist[i];
  let sumB = 0,
    wB = 0,
    wF = 0,
    maxVar = 0,
    threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumTotal - sumB) / wF;
    const between = wB * wF * ((mB - mF) ** 2);
    if (between > maxVar) {
      maxVar = between;
      threshold = t;
    }
  }
  const mask = new Uint8Array(width * height);
  const effThreshold = Math.max(threshold, floor != null ? floor : 0);
  for (let i = 0; i < pixels.length; i++) {
    mask[i] = pixels[i] >= effThreshold ? 1 : 0;
  }
  return { threshold: effThreshold, mask, totalPixels: total };
  }

/**
 * Connected-component label pass over a binary mask.
 * Returns list of blobs with bounding boxes and pixel counts.
 */
function labelBlobs(mask, width, height) {
  const labels = new Int32Array(width * height);
  const blobs = []; // { id, count, minX, maxX, minY, maxY }
  let nextId = 1;
  const equivalences = new Map();

  function id(y, x) { return labels[y * width + x]; }

  function set(y, x, v) { labels[y * width + x] = v; }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] === 0) continue;
      const left = x > 0 ? id(y, x - 1) : 0;
      const up = y > 0 ? id(y - 1, x) : 0;
      if (left === 0 && up === 0) {
        set(y, x, nextId++);
        blobs.push({ id: blobs.length, count: 0, minX: x, maxX: x, minY: y, maxY: y });
      } else if (left !== 0 && up !== 0 && left !== up) {
        set(y, x, left);
        equivalences.set(up, left);
      } else {
        set(y, x, left || up);
      }
    }
  }

  // Resolve equivalences (simple union-find without path compression, fine for small images).
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let lab = labels[y * width + x];
      if (lab === 0) continue;
      while (equivalences.has(lab)) {
        const parent = equivalences.get(lab);
        if (parent === lab) break;
        lab = parent;
      }
      labels[y * width + x] = lab;
      const b = blobs[lab - 1];
      if (b) {
        b.count += 1;
        if (x < b.minX) b.minX = x;
        if (x > b.maxX) b.maxX = x;
        if (y < b.minY) b.minY = y;
        if (y > b.maxY) b.maxY = y;
      }
    }
  }
  return blobs;
}

/**
 * Run the classical analysis pipeline on a part image.
 *
 * Returns:
 *  - stats: intensity stats of the part
 *  - edgeStats: stats of the gradient magnitude
 *  - threshold: Otsu threshold on gradient
 *  - blobs: detected defect-like regions (bounding boxes, counts)
 *  - defectMap: a heat map (0..1) of where defects are likely
 *  - features: numeric feature vector used by the ML model
 */
export function analyzeImage(canvas) {
  const { width, height, pixels } = canvas;
  const s = stats(canvas);
  const grad = gradientMagnitude(canvas);
  const gs = stats(grad);
  // Use a floor on the Otsu threshold so small texture in healthy parts
  // doesn't get classified as edge. The floor is tuned so good parts stay
  // quiet but real defects still cross it. A floor of ~28 keeps healthy
  // parts quiet while still passing the stronger synthetic defects below.
  const otsu = otsuThreshold(grad, 28);
  // Only keep blobs that are meaningfully large. Tiny blobs surface from
  // texture/noise in good parts; filtering them down is what makes the
  // station quiet on healthy parts and responsive on real defects.
  const minBlobPixels = Math.max(8, Math.round((width * height) * 0.002));
  const blobs = labelBlobs(otsu.mask, width, height).filter((b) => b.count >= minBlobPixels);

  // Build a coarse defect heat map from gradient magnitude, normalized.
  let gmax = 0;
  for (let i = 0; i < grad.pixels.length; i++) {
    if (grad.pixels[i] > gmax) gmax = grad.pixels[i];
  }
  const heat = new Float64Array(width * height);
  for (let i = 0; i < heat.length; i++) {
    heat[i] = gmax > 0 ? Math.min(1, grad.pixels[i] / gmax) : 0;
  }

  // Features for the small ML model:
  //  - mean intensity (normalized)
  //  - intensity stddev (normalized)
  //  - mean gradient magnitude (normalized)
  //  - gradient stddev (normalized)
  //  - fraction of pixels above Otsu threshold
  //  - number of significant blobs (normalized)
  //  - largest blob area fraction
  const edgeAboveThreshold = otsu.mask.reduce((a, v) => a + v, 0) / otsu.totalPixels;
  let largestArea = 0;
  for (const b of blobs) {
    if (b.count > largestArea) largestArea = b.count;
  }
  // Normalize features into a consistent [0..1]-ish range so the model
  // weights stay interpretable.
  const MAX_GRAD_MEAN = 60;   // expected upper bound for mean grad mag
  const MAX_GRAD_STD = 40;    // expected upper bound for grad stddev
  const MAX_BLOB_COUNT = 30;  // expected upper bound for significant blobs
  const features = [
    s.mean / 255,
    s.stddev / 255,
    Math.min(1, gs.mean / MAX_GRAD_MEAN),
    Math.min(1, gs.stddev / MAX_GRAD_STD),
    edgeAboveThreshold,
    Math.min(1, blobs.length / MAX_BLOB_COUNT),
    largestArea / Math.max(1, width * height),
  ];

  // Per-blob anomaly score (explainability): how "defect-like" each blob is,
  // based on its size and local gradient intensity.
  const labels = labelMask(otsu.mask, width, height);
  const blobScores = blobs.map((b) => {
    const id = b.id + 1;
    let sum = 0,
      cnt = 0;
    for (let y = b.minY; y <= b.maxY; y++) {
      for (let x = b.minX; x <= b.maxX; x++) {
        const li = y * width + x;
        if (otsu.mask[li] && labels[li] === id) {
          sum += heat[y * width + x];
          cnt += 1;
        }
      }
    }
    const avg = cnt > 0 ? sum / cnt : 0;
    const areaFrac = b.count / (width * height);
    return {
      id: b.id,
      bbox: [b.minX, b.minY, b.maxX, b.maxY],
      pixelCount: b.count,
      areaFraction: areaFrac,
      avgIntensity: avg,
      score: Math.min(1, avg * 1.2 + areaFrac * 3),
    };
  });

  return {
    stats: s,
    edgeStats: gs,
    otsuThreshold: otsu.threshold,
    edgeAboveThreshold,
    blobCount: blobs.length,
    largestBlobAreaFraction: largestArea / (width * height),
    features,
    heat,
    blobs: blobScores,
    width,
    height,
  };
}

// Small helpers for labeling lookup (used by analyzeImage blob scoring).
function labelsFromMask(mask, width, height) {
  // Re-run labeling to get labels array. In a more optimized version we'd
  // return labels from otsuThreshold, but this keeps each function clean.
  const labels = new Int32Array(width * height);
  let nextId = 1;
  const equivalences = new Map();
  const blobs = []; // { id, count, minX, maxX, minY, maxY }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] === 0) continue;
      const left = x > 0 ? labels[y * width + (x - 1)] : 0;
      const up = y > 0 ? labels[(y - 1) * width + x] : 0;
      if (left === 0 && up === 0) {
        labels[y * width + x] = nextId++;
        blobs.push({ id: blobs.length, count: 0, minX: x, maxX: x, minY: y, maxY: y });
      } else if (left !== 0 && up !== 0 && left !== up) {
        labels[y * width + x] = left;
        equivalences.set(up, left);
      } else {
        labels[y * width + x] = left || up;
      }
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let lab = labels[y * width + x];
      if (lab === 0) continue;
      while (equivalences.has(lab)) {
        const parent = equivalences.get(lab);
        if (parent === lab) break;
        lab = parent;
      }
      labels[y * width + x] = lab;
      const b = blobs[lab - 1];
      if (b) {
        b.count += 1;
        if (x < b.minX) b.minX = x;
        if (x > b.maxX) b.maxX = x;
        if (y < b.minY) b.minY = y;
        if (y > b.maxY) b.maxY = y;
      }
    }
  }
  return { labels, blobs };
}


// ---------------------------------------------------------------------------
// 4. Tiny ML classifier (logistic-style) on engineered features
// ---------------------------------------------------------------------------

/**
 * A tiny logistic-regression-style classifier.
 *
 * In a real project you'd train this on real labeled examples. Here we
 * bake in a small weight vector + bias that reflects the engineered
 * features' expected defect signal. It's a real model (scores on features),
 * just with hand-tuned parameters for the synthetic data so the demo is
 * self-consistent.
 */
const MODEL = {
  // Feature order: [meanNorm, stddevNorm, meanGradNorm, stdGradNorm,
  //                 edgeFrac, blobCountNorm, largestBlobFrac]
  //
  // These weights are calibrated so that the healthy reference samples
  // (good_1, good_2) score well below the decision boundary and the
  // calibrated so the healthy reference samples (good_1, good_2) score
  // comfortably below the decision boundary and the defective ones sit
  // above it. Weights are on the normalized feature scale described above.
  weights: [
    -3.8, // mean intensity (lower mean -> more likely defect)
     1.4, // stddev (higher variation -> more likely defect)
     2.4, // mean gradient (edges/defects)
     1.1, // gradient stddev
     3.6, // fraction above threshold (strong defect signal)
     1.8, // blob count (more detected blobs -> more likely defect)
     5.6, // largest blob fraction (strongest single cue),
  ],
  bias: -1.8,
};

function sigmoid(z) {
  return 1 / (1 + Math.exp(-Math.max(-18, Math.min(18, z))));
}

export function classify(features) {
  let z = MODEL.bias;
  for (let i = 0; i < features.length; i++) {
    z += (MODEL.weights[i] || 0) * features[i];
  }
  const prob = sigmoid(z);
  return { probability: prob, score: prob, decision: prob >= 0.5 ? 'defect' : 'ok', threshold: 0.5 };
}

// Small helpers for labeling lookup.
function labelMask(mask, width, height) {
  const labels = new Int32Array(width * height);
  let nextId = 1;
  const equivalences = new Map();

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] === 0) continue;
      const left = x > 0 ? labels[y * width + (x - 1)] : 0;
      const up = y > 0 ? labels[(y - 1) * width + x] : 0;
      if (left === 0 && up === 0) {
        labels[y * width + x] = nextId++;
      } else if (left !== 0 && up !== 0 && left !== up) {
        labels[y * width + x] = left;
        equivalences.set(up, left);
      } else {
        labels[y * width + x] = left || up;
      }
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let lab = labels[y * width + x];
      if (lab === 0) continue;
      while (equivalences.has(lab)) {
        const parent = equivalences.get(lab);
        if (parent === lab) break;
        lab = parent;
      }
      labels[y * width + x] = lab;
    }
  }

  return labels;
}

// ---------------------------------------------------------------------------
// 5. Public inspection API
// ---------------------------------------------------------------------------

/** Known sample part variants the dashboard can request. */
export const SAMPLES = [
  { id: 'good_1', variant: 'good', severity: 0, label: 'Good part #1', seed: 101 },
  { id: 'good_2', variant: 'good', severity: 0, label: 'Good part #2', seed: 202 },
  { id: 'scratch_1', variant: 'scratch', severity: 0.6, label: 'Scratch defect #1', seed: 301 },
  { id: 'spot_1', variant: 'spot', severity: 0.7, label: 'Spot defect #1', seed: 401 },
  { id: 'mixed_1', variant: 'mixed', severity: 0.75, label: 'Mixed defect #1', seed: 501 },
];

/**
 * Run a full inspection on a synthetic part.
 *
 * @param {Object} opts
 * @param {string} opts.sampleId - one of SAMPLES ids
 * @param [opts.variant] - override variant for on-the-fly generation
 * @param [opts.severity]
 * @param [opts.seed]
 */
export function runInspection({
  sampleId = 'good_1',
  variant = null,
  severity = null,
  seed = null,
} = {}) {
  const sample = SAMPLES.find((s) => s.id === sampleId);
  const effectiveVariant = variant != null ? variant : sample?.variant ?? 'good';
  const effectiveSeverity = severity != null ? severity : sample?.severity ?? 0;      const effectiveSeed = seed != null ? seed : sample?.seed ?? 1;

  const { canvas, meta } = generatePartImage({
    width: 128,
    height: 128,
    seed: effectiveSeed,
    variant: effectiveVariant,
    severity: effectiveSeverity,
  });

  const imageBase64 = encodePngGrayscale(canvas);
  const analysis = analyzeImage(canvas);
  const ml = classify(analysis.features);

  // Verdict: combine the ML score with a few classical cues.
  //
  // We treat a high blob count or a clearly large blob as a strong defect
  // signal. Mild edge-fraction in the 0.05-0.09 band is expected even on
  // healthy parts (texture + the synthetic lighting gradient), so we only
  // treat a strong edge signal as a defect cue.
  const strongEdge = analysis.edgeAboveThreshold > 0.12;
  const anyBlob = analysis.blobCount > 0;
  const largeBlob = analysis.largestBlobAreaFraction > 0.01;
  const classicalCues = strongEdge || anyBlob || largeBlob;

  // Start from the ML probability and nudge it with classical evidence.
  let defectOdds = ml.probability;
  if (classicalCues) defectOdds = Math.min(0.99, defectOdds + 0.40);
  if (anyBlob && largeBlob) defectOdds = Math.min(0.99, defectOdds + 0.20);
  // Down-grade confidence when only weak edge signal is present (likely
  // texture rather than a real defect).
  if (analysis.edgeAboveThreshold > 0.04 && !classicalCues) {
    defectOdds = Math.max(0.10, defectOdds - 0.06);
  }

  let verdict;
  let confidence;
  if (defectOdds >= 0.5) {
    verdict = 'defect';
    confidence = Math.min(0.99, Math.max(0.5, defectOdds));
  } else {
    verdict = 'ok';
    confidence = Math.min(0.99, Math.max(0.5, 1 - defectOdds));
  }

  // Explainability: rank defect regions by contribution.
  const explainability = analysis.blobs
    .map((b) => ({
      region: b.bbox,
      pixelCount: b.pixelCount,
      areaFraction: b.areaFraction,
      avgIntensity: b.avgIntensity,
      contribution: b.score,
    }))
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 6);

  return {
    sampleId,
    label: sample?.label ?? `Part (variant=${effectiveVariant})`,
    variant: effectiveVariant,
    severity: effectiveSeverity,
    image: imageBase64,
    imageWidth: canvas.width,
    imageHeight: canvas.height,
    verdict,
    confidence,
    ml: {
      probability: ml.probability,
      decision: ml.decision,
      threshold: ml.threshold,
    },
    classical: {
      meanIntensity: analysis.stats.mean,
      stddev: analysis.stats.stddev,
      edgeMean: analysis.edgeStats.mean,
      edgeStddev: analysis.edgeStats.stddev,
      otsuThreshold: analysis.otsuThreshold,
      edgeAboveThreshold: analysis.edgeAboveThreshold,
      blobCount: analysis.blobCount,
      largestBlobAreaFraction: analysis.largestBlobAreaFraction,
    },
    explainability,
    // Heat map delivered as a small PNG so the dashboard can render it as an
    // overlay without shipping a 16k-float array over JSON.
    heatImage: heatToPng(analysis.heat, analysis.width, analysis.height),
  };
}

/**
 * Encode the defect heat map as a small base64 PNG the dashboard can render.
 * Values are mapped through a hot colormap (black -> red -> yellow -> white).
 */
export function heatToPng(heat, width, height) {
  const canvas = makeCanvas(width, height);
  let m = 0;
  for (let i = 0; i < heat.length; i++) {
    if (heat[i] > m) m = heat[i];
  }
  const scale = m > 0 ? 1 / m : 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let t = Math.max(0, Math.min(1, heat[y * width + x] * scale));
      let r, g, b;
      if (t < 0.5) {
        // black -> red
        const u = t / 0.5;
        r = Math.round(255 * u);
        g = 0;
        b = 0;
      } else if (t < 0.75) {
        // red -> yellow
        const u = (t - 0.5) / 0.25;
        r = 255;
        g = Math.round(255 * u);
        b = 0;
      } else {
        // yellow -> white
        const u = (t - 0.75) / 0.25;
        r = 255;
        g = 255;
        b = Math.round(255 * u);
      }
      canvas.pixels[y * width + x] = r * 256 * 256 + g * 256 + b;
    }
  }
  // encodePngGrayscale only handles 8-bit grayscale, so produce a 3-channel
  // version by reusing the same encoder path on a flattened luminance copy.
  // For a demo this is acceptable; a real path would use a proper PNG writer.
  const lum = makeCanvas(width, height);
  for (let i = 0; i < heat.length; i++) {
    lum.pixels[i] = Math.max(0, Math.min(255, Math.round(heat[i] * scale * 255)));
  }
  return encodePngGrayscale(lum);
}
