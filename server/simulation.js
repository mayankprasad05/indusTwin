/**
 * Simulation engine for a single machine / production line.
 *
 * It produces a stream of "frames" containing:
 *  - machine metadata and state
 *  - multivariate sensor readings
 *  - derived analytics hints (used by the dashboard analytics layer)
 *  - control actions the system decided to take
 *
 * Everything is synthetic, so the project needs no real devices.
 */

import { loadRecordedDataset } from "./recorded-dataset.js";

const DEFAULT_RANGES = {
  temperature: { min: 40, max: 95, unit: "°C", nominal: 62 },
  vibration: { min: 0.4, max: 6.5, unit: "mm/s", nominal: 1.2 },
  pressure: { min: 1.2, max: 6.0, unit: "bar", nominal: 3.4 },
  power: { min: 18, max: 95, unit: "%", nominal: 42 },
  cycleTime: { min: 3.2, max: 7.5, unit: "s", nominal: 4.6 },
  airflow: { min: 70, max: 165, unit: "CFM", nominal: 120 },
};

const STATES = {
  IDLE: "idle",
  STARTING: "starting",
  RUNNING: "running",
  WARNING: "warning",
  FAULT: "fault",
  SHUTDOWN: "shutdown",
};

// Scenario presets map to Module 5 (impact across industries).
const SCENARIOS = {
  cnc_machining: {
    name: "CNC Machining Center",
    description:
      "Spindle-based machining station. Temperature and vibration are the key health signals; tool wear shows up as rising vibration and power.",
    ranges: {
      temperature: { min: 35, max: 105, unit: "°C", nominal: 68 },
      vibration: { min: 0.3, max: 7.5, unit: "mm/s", nominal: 1.0 },
      pressure: { min: 2.0, max: 8.0, unit: "bar", nominal: 5.2 },
      power: { min: 25, max: 110, unit: "%", nominal: 55 },
      cycleTime: { min: 4.0, max: 9.0, unit: "s", nominal: 5.8 },
      airflow: { min: 60, max: 150, unit: "CFM", nominal: 110 },
    },
    keySignals: ["temperature", "vibration", "power"],
  },
  packaging_line: {
    name: "Packaging Line Station",
    description:
      "Filling and sealing station on a consumer-goods line. Pressure and cycle time matter most; faults often appear as pressure dips and cycle-time drift.",
    ranges: {
      temperature: { min: 30, max: 78, unit: "°C", nominal: 55 },
      vibration: { min: 0.2, max: 3.5, unit: "mm/s", nominal: 0.8 },
      pressure: { min: 0.8, max: 4.5, unit: "bar", nominal: 2.6 },
      power: { min: 12, max: 70, unit: "%", nominal: 30 },
      cycleTime: { min: 1.6, max: 4.2, unit: "s", nominal: 2.4 },
      airflow: { min: 80, max: 200, unit: "CFM", nominal: 140 },
    },
    keySignals: ["pressure", "cycleTime", "power"],
  },
  robotic_welding: {
    name: "Robotic Welding Cell",
    description:
      "Collaborative-style welding cell. Heat buildup, power draw, and gas pressure are the primary indicators; arc instability appears as vibration and power spikes.",
    ranges: {
      temperature: { min: 45, max: 120, unit: "°C", nominal: 80 },
      vibration: { min: 0.4, max: 8.5, unit: "mm/s", nominal: 1.4 },
      pressure: { min: 1.0, max: 5.5, unit: "bar", nominal: 3.0 },
      power: { min: 30, max: 130, unit: "%", nominal: 68 },
      cycleTime: { min: 5.0, max: 11.0, unit: "s", nominal: 7.2 },
      airflow: { min: 50, max: 130, unit: "CFM", nominal: 95 },
    },
    keySignals: ["temperature", "power", "pressure"],
  },
};

/** Scenario keys that are available right now (the recorded one needs data). */
export function listScenarios() {
  const keys = [];
  if (loadRecordedDataset()) keys.push("hydraulic_rig");
  keys.push("cnc_machining", "packaging_line", "robotic_welding");
  return keys;
}

/**
 * Scenario backed by real measurements instead of a random generator.
 * Ranges, units and nominal values all come from the recorded dataset so the
 * gauges are scaled to the rig's actual operating envelope.
 */
function createRecordedScenario(dataset) {
  const ranges = {};
  for (const [signal, s] of Object.entries(dataset.signals)) {
    ranges[signal] = {
      min: s.min,
      max: s.max,
      unit: s.unit,
      nominal: s.nominal,
    };
  }
  // Cycle time is not measured by the rig, so it keeps its synthetic model.
  ranges.cycleTime = DEFAULT_RANGES.cycleTime;

  return {
    name: "Hydraulic Test Rig (recorded)",
    key: "hydraulic_rig",
    description:
      "Real 60-second load cycles from the ZeMA hydraulic test rig (UCI). Pressure, motor power, flow, temperature and vibration are replayed from the recording.",
    ranges: { ...DEFAULT_RANGES, ...ranges },
    keySignals: ["pressure", "vibration", "power"],
    recorded: true,
    dataset,
    pointsPerCycle: dataset.pointsPerCycle,
  };
}

export function createScenario(key) {
  if (key === "hydraulic_rig") {
    const dataset = loadRecordedDataset();
    if (dataset) return createRecordedScenario(dataset);
  }
  const resolved = SCENARIOS[key] ? key : "cnc_machining";
  const base = SCENARIOS[resolved];
  return {
    ...base,
    key: resolved,
    ranges: { ...DEFAULT_RANGES, ...base.ranges },
    keySignals: base.keySignals.slice(),
  };
}

export function createSimulator({ scenario = "cnc_machining", tickMs = 800, seedLog = null } = {}) {
  const cfg = createScenario(scenario);
  // Expose tickMs on config so the server loop and clients can read it.
  cfg.tickMs = tickMs;

  // Internal state
  const state = {
    machineId: "M-01",
    scenario: cfg,
    state: STATES.IDLE,
    tickMs,
    time: 0,
    cycleCount: 0,
    uptimeSeconds: 0,
    faultCount: 0,
    warnings: 0,
    controlLog: Array.isArray(seedLog) ? seedLog.slice() : [],

    // Autonomy mode (Module 7): whether the twin may act on its own, and the
    // level of that autonomy. Purely a supervisory setting in this model.
    autonomy: { on: false, level: "monitoring" },

    // Track the last tick that was processed for debugging / viz hooks.
    // (Not part of the public frame; internal only.)
    history: [],
    // Anomaly injection plan
    anomaly: null, // { atTime, duration, signal?, severity? }
    scheduledEvents: [],
  };

  return {
    config: cfg,

    /** Reset to initial state (useful for replay/demo resets). */
    reset() {
      state.state = STATES.IDLE;
      state.time = 0;
      state.cycleCount = 0;
      state.uptimeSeconds = 0;
      state.faultCount = 0;
      state.warnings = 0;
      state.controlLog = [];
      state.history = [];
      state.anomaly = null;
      state.scheduledEvents = [];
      // Drop the cached frame so live reads reflect the reset counters.
      state._lastFrame = null;
      state.controlLog.push({
        t: state.time,
        type: "control",
        action: "reset",
        reason: "Operator reset request",
        source: "manual",
      });
    },

    /** Inject a planned anomaly at a specific time. */
    scheduleAnomaly({
      atTime,
      duration,
      signal = "vibration",
      severity = 1,
    } = {}) {
      state.scheduledEvents.push({ atTime, duration, signal, severity });
    },

    /** Start the simulated machine. */
    start() {
      if (state.state === STATES.RUNNING || state.state === STATES.STARTING) {
        return;
      }
      state.state = STATES.STARTING;
      state.controlLog.push({
        t: state.time,
        type: "control",
        action: "start",
        reason: "Operator start request",
        source: "manual",
      });
    },

    /** Emergency stop. Always honoured unless the machine is already down. */
    emergencyStop() {
      if (state.state === STATES.SHUTDOWN) {
        return;
      }
      const prev = state.state;
      state.state = STATES.SHUTDOWN;
      state.controlLog.push({
        t: state.time,
        type: "control",
        action: "e_stop",
        reason: "Emergency stop requested",
        source: "manual",
        previousState: prev,
      });
    },

    /** Set autonomous operation mode. */
    setAutonomous(on, level = "monitoring") {
      const nextLevel = on ? level : "manual";
      state.autonomy = { on: Boolean(on), level: nextLevel };
      state.controlLog.push({
        t: state.time,
        type: "mode",
        action: on ? "autonomous_on" : "autonomous_off",
        mode: nextLevel,
        reason: `Autonomy ${on ? "enabled" : "disabled"} by operator`,
        source: "manual",
      });
    },

    // The main step function. Called on a timer in the server.
    step() {
      state.time += 1;

      // Uptime accumulates while the machine is active (starting or running).
      // It does not accumulate during idle, shutdown, or fault states.
      const active = state.state === STATES.RUNNING || state.state === STATES.STARTING;
      if (active) {
        state.uptimeSeconds += state.tickMs / 1000;
      }

      // Process scheduled anomalies/events
      if (state.scheduledEvents.length > 0) {
        const next = state.scheduledEvents.shift();
        if (next.atTime <= state.time) {
          const remaining = next.duration;
          state.anomaly = {
            signal: next.signal,
            severity: next.severity,
            until: state.time + remaining,
            // Keep the duration: the sensor model needs it to decay the spike.
            duration: remaining,
            type: "injected_spike",
          };
          state.controlLog.push({
            t: state.time,
            type: "event",
            action: "anomaly_injected",
            signal: next.signal,
            severity: next.severity,
            source: "simulator",
          });
        } else {
          state.scheduledEvents.unshift(next);
        }
      }

      // Clear anomaly when its duration expires
      if (state.anomaly && state.time >= state.anomaly.until) {
        state.anomaly = null;
      }

      // State transitions
      applyStateLogic(state);

      // Generate sensor readings (recorded replay or synthetic model)
      const sample = cfg.recorded ? recordedSample(state, cfg) : null;
      const sensors = generateSensors(state, cfg.ranges, cfg.keySignals, sample?.values ?? null);

      // Cycle counting: in recorded mode a "cycle" is one real 60 s rig cycle,
      // otherwise it tracks the synthetic production cycle.
      if (cfg.recorded) {
        if (state.time % cfg.pointsPerCycle === 0) state.cycleCount += 1;
      } else if (state.state === STATES.RUNNING) {
        state.cycleCount += 1;
      }

      const stats = computeStats(state, cfg.keySignals);
      const frame = {
        t: state.time,
        time: state.time,
        machineId: state.machineId,
        scenario: cfg.name,
        state: state.state,
        sensors,
        controlLog: state.controlLog,
        stats,
        anomalyScore: stats.anomalyScore,
        trends: stats.trends,
        anomaly: state.anomaly,
        cycleCount: state.cycleCount,
        uptimeSeconds: state.uptimeSeconds,
        faultCount: state.faultCount,
        warnings: state.warnings,
        autonomy: { ...state.autonomy },
        dataSource: describeDataSource(cfg, sample),
      };

      // Keep a bounded history for analytics/windowed views
      state.history.push(frame);
      if (state.history.length > 600) {
        state.history.splice(0, state.history.length - 600);
      }

      state._lastFrame = frame;
      return frame;
    },

    /** Read-only snapshot for clients. Includes latest sensors/stats so every
        message has a consistent shape (frame-like). We emit both `t` and `time`
        so clients that expect a broadcast frame shape still work on snapshots. */
    /**
     * Return the most recent live frame the simulator produced, so clients
     * that missed the broadcast interval still have a current reading.
     *
     * The cached tick frame is overlaid with the *current* machine state and
     * counters: a command (start/stop/reset) happens between ticks, so the
     * cached frame would otherwise still report the previous state.
     */
    liveFrame() {
      if (!state._lastFrame) return this.snapshot();
      return {
        ...state._lastFrame,
        time: state.time,
        state: state.state,
        cycleCount: state.cycleCount,
        uptimeSeconds: state.uptimeSeconds,
        faultCount: state.faultCount,
        warnings: state.warnings,
        autonomy: { ...state.autonomy },
        controlLog: state.controlLog.slice(-200),
        anomaly: state.anomaly,
      };
    },

    snapshot() {
      const sample = cfg.recorded ? recordedSample(state, cfg) : null;
      const sensors = generateSensors(state, cfg.ranges, cfg.keySignals, sample?.values ?? null);
      const stats = computeStats(state, cfg.keySignals);
      const out = {
        t: state.time,
        time: state.time,
        state: state.state,
        machineId: state.machineId,
        scenario: cfg.name,
        cycleCount: state.cycleCount,
        uptimeSeconds: state.uptimeSeconds,
        faultCount: state.faultCount,
        warnings: state.warnings,
        autonomy: { ...state.autonomy },
        dataSource: describeDataSource(cfg, sample),
        sensors,
        controlLog: state.controlLog.slice(-200),
        history: state.history.slice(-120),
        stats,
        anomalyScore: stats.anomalyScore,
        trends: stats.trends,
        anomaly: state.anomaly,
      };
      return out;
    },
  };
}

/** Describe where the current readings come from, for the dashboard footer. */
function describeDataSource(cfg, sample) {
  if (!cfg.recorded) {
    return { kind: "synthetic", name: cfg.name };
  }
  const source = cfg.dataset.source;
  return {
    kind: "recorded",
    name: source.name,
    citation: source.citation,
    doi: source.doi,
    license: source.license,
    rig: source.rig,
    cycleNumber: sample ? sample.cycleNumber : null,
    cyclesTotal: sample ? sample.cyclesTotal : cfg.dataset.cycles.length,
    block: sample ? sample.cycle.block : null,
    labels: sample ? sample.cycle.labels : null,
  };
}

function applyStateLogic(state) {
  // State machine rules
  if (state.state === STATES.STARTING) {
    // After a few ticks, move to running unless an anomaly already triggered
    if (state.time > 4) {
      state.state = STATES.RUNNING;
    }
    return;
  }

  if (state.state === STATES.SHUTDOWN) {
    // Stay down until explicitly started again
    return;
  }

  if (state.state === STATES.FAULT) {
    // In this simple model, faults stay until manually reset/started
    return;
  }

  if (state.state === STATES.RUNNING) {
    // A severe anomaly can push us into fault directly
    if (
      state.anomaly &&
      state.anomaly.severity >= 2.5 &&
      state.anomaly.signal !== undefined
    ) {
      state.state = STATES.FAULT;
      state.faultCount += 1;
      state.controlLog.push({
        t: state.time,
        type: "state",
        action: "fault_reached",
        signal: state.anomaly.signal,
        source: "simulator",
      });
      state.anomaly = null;
    }
    return;
  }

  // IDLE stays idle until started
}

/**
 * Generate one sensor reading vector.
 * Normal readings wander around nominal; anomalies perturb a chosen signal.
 */
/**
 * Pick the recorded readings for the current tick.
 *
 * The recording is a series of 60 s cycles; playback walks through them in
 * order and loops, so the dashboard replays a real test campaign.
 */
function recordedSample(state, cfg) {
  const dataset = cfg.dataset;
  const pointsPerCycle = cfg.pointsPerCycle;
  const total = dataset.cycles.length;
  const index = state.time % (total * pointsPerCycle);
  const cycleIndex = Math.floor(index / pointsPerCycle);
  const pointIndex = index % pointsPerCycle;
  const cycle = dataset.cycles[cycleIndex];

  const values = {};
  for (const name of Object.keys(cfg.ranges)) {
    const series = cycle[name];
    if (Array.isArray(series)) values[name] = series[pointIndex];
  }

  return {
    values,
    cycleIndex,
    cycleNumber: cycleIndex + 1,
    cyclesTotal: total,
    pointIndex,
    cycle,
  };
}

function generateSensors(state, ranges, keySignals, recordedValues = null) {
  const sensors = {};

  for (const [name, r] of Object.entries(ranges)) {
    const base = r.nominal ?? (r.min + r.max) / 2;

    // Slow deterministic drift + small noise
    const cycle = Math.sin((state.time * 0.15 + name.length) * 1.2) * 0.08;
    const noise =
      (Math.random() - 0.5) * (r.max - r.min) * 0.06;

    const recorded = recordedValues ? recordedValues[name] : undefined;
    let value = Number.isFinite(recorded) ? recorded : base * (1 + cycle) + noise;

    // Inject anomaly perturbation if active for this signal. The spike ramps
    // down over the anomaly's duration; guard against a missing duration so a
    // malformed event can never turn the reading into NaN.
    if (state.anomaly && state.anomaly.signal === name) {
      const a = state.anomaly;
      const duration = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : 1;
      const elapsed = state.time - (a.until - duration);
      const decay = Math.max(0, Math.min(1, 1 - elapsed / duration));
      const direction = Math.sin(state.time * 0.6 + a.signal.length) > 0 ? 1 : -1;
      const spike = (Number(a.severity) || 1) * (r.max - r.min) * 0.18 * decay;
      value += direction * Math.abs(spike);
    }

    // Clamp into plausible range with occasional mild overshoot when anomalous
    const lo = r.min * 0.7;
    const hi = r.max * 1.35;
    if (!Number.isFinite(value)) value = base;
    value = Math.max(lo, Math.min(hi, value));

    sensors[name] = {
      value: Math.round(value * 1000) / 1000,
      nominal: r.nominal,
      unit: r.unit,
      min: r.min,
      max: r.max,
    };
  }

  return sensors;
}

/**
 * Lightweight stats over the recent window of key signals.
 * This is the "make sense of data" layer for Module 2/3.
 */
function computeStats(state, keySignals) {
  const windowSize = 30;
  const recent = state.history.slice(-windowSize);

  if (recent.length < 5) {
    return {
      windowSize: recent.length,
      trend: "unknown",
      anomalyScore: 0,
    };
  }

  const trends = {};
  for (const sig of keySignals) {
    const values = recent.map((f) => f.sensors[sig]?.value ?? 0).filter((v) =>
      Number.isFinite(v)
    );
    if (values.length < 3) {
      trends[sig] = { trend: "unknown", slope: 0, mean: 0, variance: 0 };
      continue;
    }
    const n = values.length;
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const variance =
      values.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1);

    // Simple linear slope over the window
    const xs = values.map((_, i) => i);
    const xMean = (n - 1) / 2;
    let num = 0,
      den = 0;
    for (let i = 0; i < n; i++) {
      num += (i - xMean) * (values[i] - mean);
      den += (i - xMean) ** 2;
    }
    const slope = den > 0 ? num / den : 0;

    const last = values[values.length - 1];
    const trend =
      slope > 0.001 * mean
        ? "rising"
        : slope < -0.001 * mean
          ? "falling"
          : "stable";

    trends[sig] = { trend, slope, mean, variance };
  }

  // A crude composite anomaly score from recent variance + recent slope on key signals
  let score = 0;
  for (const sig of keySignals) {
    const t = trends[sig];
    if (!t || t.trend === "unknown") continue;
    score += Math.abs(t.slope) / (Math.abs(t.mean || 1) + 1e-6);
    score += Math.sqrt(t.variance) / (Math.abs(t.mean || 1) + 1e-6);
  }
  score = Math.min(1, score / Math.max(1, keySignals.length));

  return {
    windowSize: recent.length,
    trends,
    anomalyScore: Math.round(score * 1000) / 1000,
  };
}
