/**
 * Loader for the recorded sensor dataset used by the "recorded" scenario.
 *
 * The file in ../data is produced by scripts/build-hydraulic-dataset.mjs from
 * the UCI "Condition monitoring of hydraulic systems" dataset (ZeMA test rig).
 * If the file is missing the dashboard simply falls back to synthetic signals.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let cached;

export function loadRecordedDataset() {
  if (cached !== undefined) return cached;

  const path = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "hydraulic-rig.json");
  try {
    if (!existsSync(path)) {
      cached = null;
      return cached;
    }
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const ok =
      Array.isArray(parsed.cycles) &&
      parsed.cycles.length > 0 &&
      Number.isInteger(parsed.pointsPerCycle) &&
      parsed.pointsPerCycle > 0;

    if (!ok) {
      console.warn("recorded dataset is present but malformed; falling back to synthetic signals");
      cached = null;
      return cached;
    }

    cached = parsed;
    return cached;
  } catch (err) {
    console.warn("could not load recorded dataset:", err?.message ?? err);
    cached = null;
    return cached;
  }
}
