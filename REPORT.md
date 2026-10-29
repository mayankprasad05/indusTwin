# IndusTwin — Project Report

**A digital-twin dashboard for condition monitoring of an industrial hydraulic machine.**

Industry 4.0 / Smart Manufacturing course project.

---

## 1. Summary

IndusTwin is a web application that presents an industrial machine as a **digital twin**: a live virtual representation fed by a continuous stream of sensor readings, on top of which it computes machine state, health and anomaly indicators, and whose operator actions and declared autonomy level it records in an auditable log.

The sensor readings are **not invented**. The default operating mode replays real measurements recorded on a hydraulic test rig at Saarland University, published as the UCI "Condition monitoring of hydraulic systems" dataset. The dashboard derives machine behaviour from that stream in real time, and its fault-detection capability has been measured against the dataset's own ground-truth labels rather than asserted.

Stack: Node.js HTTP + WebSocket server, no framework, no database, no external services. One dependency (`ws`). Runs entirely on localhost.

---

## 2. Where the readings come from

This section is deliberately explicit, because "the model" is three different things and mixing them up is the most common source of confusion.

### 2.1 The one real data source

Every physical measurement currently displayed comes from a single published dataset:

| | |
|---|---|
| **Dataset** | Condition monitoring of hydraulic systems |
| **Authors** | N. Helwig, E. Pignanelli, A. Schütze (2015) |
| **Publisher** | UCI Machine Learning Repository |
| **DOI** | [10.24432/C5CW21](https://doi.org/10.24432/C5CW21) |
| **Physical origin** | Hydraulic test rig, **ZeMA — Centre for Mechatronics and Automation, Saarland University**, Germany |
| **Licence** | CC BY 4.0 |
| **Content** | 2,205 load cycles × 60 s each, 17 sensors, plus a per-cycle condition profile |

The rig runs a hydraulic circuit — pump, accumulator, valves, cooler — and was instrumented to record degradation of four components under controlled conditions. That is what makes it useful here: it is a real machine, with real sensors, and real faults.

### 2.2 The chain from the raw download to the dashboard

```
UCI download (74 MB zipped / 530 MB extracted, 2,205 cycles × 17 channels)
        │
        │  scripts/build-hydraulic-dataset.mjs   (run once, offline)
        │  · downsample every channel to 1 Hz (60 points per 60 s cycle)
        │  · pick 24 cycles across 6 condition blocks
        │  · copy the dataset's own min / max / mean per channel
        ▼
data/hydraulic-rig.json   (56 KB, committed to the repo)
        │
        │  server/recorded-dataset.js   (load + validate, cached)
        ▼
server/simulation.js → createRecordedScenario()   (gauge ranges, units, nominals
        │                                          all taken from the dataset)
        │  recordedSample(state): index = time % 1440
        │                          cycle = ⌊index / 60⌋, point = index % 60
        ▼
frame { sensors, state, anomalyScore, cycleCount, dataSource, … }
        │  WebSocket, 800 ms tick + 250 ms refresh
        ▼
Browser dashboard (gauges, chart, twin panel, control log)
```

### 2.3 Which rig channel becomes which dashboard signal

| Dashboard signal | Dataset channel | Meaning | Unit |
| --- | --- | --- | --- |
| Temperature | `TS1` | Oil temperature | °C |
| Vibration | `VS1` | Pump vibration | mm/s |
| Pressure | `PS1` | System pressure | bar |
| Power draw | `EPS1` | Motor power | W |
| Airflow | `FS1` | Volume flow (in the frame, no gauge) | l/min |

The gauge scale, the nominal marker and the unit shown on screen are computed from the recorded data itself — e.g. pressure is scaled over the recorded range 141.4–191.5 bar with a nominal of 160.4 bar — so the display cannot drift away from what the rig actually did.

### 2.4 What is replayed

24 cycles, in order, looping. They cover six real operating blocks, each with the dataset's own labels:

| Block | Cycles (source rows) | Condition |
| --- | --- | --- |
| Nominal | 1673, 1674, 1757, 1788 | cooler 100 %, valve 100 %, no pump leakage, 130 bar |
| Pump leakage (weak) | 1749–1752 | pump leakage = 1 |
| Pump leakage (severe) | 1708–1711 | pump leakage = 2 |
| Valve degradation | 1771–1774 | valve switching 80 % |
| Cooler failure | 109–112 | cooler efficiency 3 % |
| Multiple faults | 215–218 | cooler 3 %, valve 73 %, pump leakage 2 |

Playback timing: one tick = one recorded second, ticks fire every 800 ms, so replay runs at **1.25× real time**. A 60-second cycle takes 48 s and the 24-cycle recording loops every **19.2 minutes**.

### 2.5 What is *not* from the dataset

Being explicit about this matters in a technical report:

- **Cycle time.** The rig does not record a per-part cycle time, so that one signal remains modelled. It is not displayed on a gauge.
- **The three synthetic scenarios** (`CNC Machining Center`, `Packaging Line Station`, `Robotic Welding Cell`) are generated by a model: nominal value ± slow sinusoidal drift ± noise. The dashboard labels these *"Synthetic simulation"* so a recorded reading is never mistaken for a generated one.
- **Fault injection.** The two "inject anomaly" buttons add a decaying synthetic perturbation *on top of* the recorded values. The underlying reading is real; the perturbation is not.
- **Machine uptime, cycle counters, fault counters, health index** are all computed by the application, not measured.

No live machine, PLC, OPC UA server, MQTT broker or web API is connected. There is no network dependency beyond localhost.

---

## 3. How it works

### 3.1 Components

| Layer | File | Role |
| --- | --- | --- |
| Data | `data/hydraulic-rig.json` | 24 real cycles, 5 signals, 60 points each |
| Data | `server/recorded-dataset.js` | Loads, validates, caches; `null` if absent |
| Model | `server/simulation.js` | Scenario config, state machine, replay indexing, sensor model, analytics |
| Transport | `server/index.js` | HTTP static server + API routes + WebSocket broadcast |
| View | `public/index.html` | Single-page dashboard (vanilla JS, canvas chart) |
| Offline | `scripts/build-hydraulic-dataset.mjs` | Raw dataset → replay file |
| Offline | `scripts/evaluate-fault-classifier.mjs` | Features → classification → `data/model-eval.json` |

### 3.2 The machine model

A finite state machine, stepped once per tick:

```
IDLE ──start──► STARTING ──(t > 4)──► RUNNING ──emergencyStop──► SHUTDOWN
                  │                     │                            │
                  │                     └──severe anomaly (sev ≥ 2.5)──► FAULT
                  └──────────────────────────────────────────────────► SHUTDOWN
```

Rules that the code enforces, and that are worth stating because they are visible on screen:

- **Telemetry only advances while `STARTING` or `RUNNING`.** The simulation loop is started and stopped by the machine state, so an idle or shut-down machine holds its last reading instead of drifting.
- **Uptime accumulates only in `STARTING` / `RUNNING`.**
- **`SHUTDOWN` and `FAULT` are latching** — they stay until an explicit reset or start.
- In recorded mode, `Cycles` counts **real rig cycles** (one per 60 s recording), not ticks.

### 3.3 The analytics layer

Every frame, the server keeps a rolling window of the last 30 frames and computes, for each key signal (`pressure`, `vibration`, `power` in the recorded scenario):

- mean and variance,
- a least-squares slope, classified as `rising` / `falling` / `stable`,
- a composite **anomaly score** in [0, 1]:

```
score = mean over key signals of ( |slope| / |mean|  +  stdev / |mean| )
        clipped to 1
```

This is an unsupervised drift measure: it rises when a signal becomes unstable or starts moving. It answers *"is something off?"*, not *"what is off?"* — a distinction made concrete by the measured results in §4.

The **health index** shown on the dashboard is derived in the browser from that score and the machine state:

```
health = 1 − 0.8 × anomalyScore      (then overridden by state:
                                      fault 0.25, warning 0.6, shutdown 0.4)
```

### 3.4 Transport and control

- `GET /` → static dashboard.
- `GET /api/scenarios` → available scenarios and the active one.
- `GET /api/model-eval` → the measured classification results (§4).
- `POST /api/switchScenario` → switch scenario (also rebuilds the replay index).
- `WS /ws` → server pushes a frame on every tick (800 ms) and a refresh (250 ms); the client sends commands `start`, `stop`, `reset`, `setAutonomous`, `injectAnomaly`.

Each frame is self-describing — `sensors[signal] = { value, nominal, unit, min, max }`, plus `state`, counters, `anomalyScore`, `autonomy` and a `dataSource` block that carries the dataset name, DOI, licence, current cycle number and the cycle's condition labels. That `dataSource` block is what the UI prints under the telemetry panel, which is why provenance is visible at all times rather than buried in code.

### 3.5 Autonomy (Module 7)

A supervisory mode with four selectable levels (`monitoring`, `advisory`, `closed-loop`, `supervisory`) plus an on/off switch. In this version the mode is a stated intent, recorded by the twin but not yet wired to automatic actuator decisions — the honest description is "declared autonomy level with a human override", not closed-loop control. Every mode change and every anomaly injection is written to an append-only **control log** with a timestamp and a source (`manual`, `simulator`, `autonomy`), so the twin's decisions are auditable rather than opaque.

---

## 4. Measured results

The anomaly score was, until recently, unfalsifiable: it went up, and nothing said whether that was correct. The dataset's per-cycle labels fix that. `scripts/evaluate-fault-classifier.mjs` trains a classifier on 207 features per cycle (9 statistics per channel across all 17 channels, plus 8-band spectral power and dominant frequency for the pressure, flow and power channels — computed from the **raw** high-rate signals, not the 1 Hz replay) and scores it on cycles it never saw.

| Task | Classes | Accuracy | Macro-F1 | Chance | Shuffled-split accuracy |
| --- | --- | --- | --- | --- | --- |
| Cooler condition | 3 % / 20 % / 100 % | **100.0 %** | 1.000 | 33 % | 99.8 % |
| Valve condition | 73 / 80 / 90 / 100 % | **88.6 %** | 0.836 | 25 % | 93.4 % |
| Pump leakage | none / weak / severe | **97.6 %** | 0.957 | 33 % | 99.1 % |
| Accumulator pressure | 90 / 100 / 115 / 130 bar | **26.3 %** | 0.104 | 25 % | 89.4 % |

The headline number for the *live* dashboard is different and worth stating on its own: the unsupervised drift score reaches **AUC 0.904** against a binary "any condition degraded" label. It reliably notices that the machine's behaviour has changed; it cannot say which component changed. Supervised classification closes that gap for three of four components.

### Why the split matters

The rig recorded each condition as a contiguous block, so neighbouring cycles are near-duplicates. A stratified **random** split — the protocol behind most published near-100 % results on this dataset — leaks information across train and test. The evaluation therefore uses a **blocked** split: whole contiguous recording runs are held out per class, so no test cycle is a near-duplicate of a training cycle.

The accumulator row is the evidence for that decision: 89.4 % shuffled versus 26.3 % blocked. The label is recovering recording-run identity, not physics that generalises. It is reported as a negative result rather than quietly dropped.

---

## 5. What the project is used for

**Course demonstration (primary use).** It covers the module chain end to end: sensors and connected systems (M2) → data analysis and control (M3) → digital twin (M4) → industry scenarios (M5) → machine learning on real data (M6) → autonomous operation with human override (M7).

**Teaching digital twins concretely.** The "Physical vs Virtual" panel makes the abstraction tangible: the same machine rendered twice, one layer live, one layer computed, joined by a stated link (WebSocket, latency).

**Condition-monitoring and predictive-maintenance concepts.** Real degradation walks across the screen: cooler-failure cycles average 53.5 °C against 35.9 °C nominal, and pressure discharges from ~191 bar to ~147 bar within each 60 s cycle as the accumulator empties and recharges. Those are observable physical behaviours, not decorative animation.

A useful honest caveat that falls out of the same numbers: the pump-leakage blocks look almost identical to nominal in the five displayed channels (35.7 °C / 0.5 mm/s / 160.4 bar versus 35.9 / 0.6 / 161.1). The leakage signal lives in the high-rate pressure and flow waveforms that the classifier uses, not in 1 Hz cycle statistics — which is exactly why the classification work reads the raw channels and why a dashboard gauge alone cannot diagnose a pump.

**A benchmark for anomaly detection.** The classification panel is a worked example of evaluating a fault detector properly — blocked split, chance level, confusion matrix, and a comparison between an unsupervised score and a supervised diagnosis.

**A template for a real retrofit.** The dashboard consumes one narrow contract (the frame). Replacing the replay with a live source — OPC UA, Modbus, MQTT, or retrofitted sensors — requires no change to the UI or the analytics. See §7.

**Something explicitly *not* claimed:** this is not a control system, not a safety system, and not a validated diagnostic tool. It reads; it does not command machinery.

---

## 6. Limitations and threats to validity

Stated plainly, because a report that only lists strengths is not useful:

1. **The labels describe conditions the experimenter set**, not failures observed in service. Accuracy on this rig is a lab benchmark, not a transfer guarantee.
2. **Accumulator pressure does not generalise** under a time-aware split (§4). Any claim that the approach diagnoses all four components would be false.
3. **Cycle time is modelled, not measured.**
4. **Fault injection is synthetic** and overlaid on real data; it demonstrates the UI's response, not a physical fault.
5. **The synthetic scenarios are a model** with no physical basis beyond plausible ranges.
6. **A real machine produces noisier, non-stationary data** than a lab rig; the anomaly threshold would need re-tuning.
7. **If the machine's own sensors were retrofitted by hand**, those are the author's measurements, not the machine's — a distinction that matters when reporting results.
8. **No persistence.** State lives in memory; restarting the server resets everything. There is no database and no historical storage beyond a 600-frame ring buffer.

---

## 7. Reproducing it

```bash
cd indusTwin
npm install
npm start                     # http://localhost:3000
```

Optional, offline:

```bash
# rebuild the 56 KB replay file from the raw UCI download
node scripts/build-hydraulic-dataset.mjs <path-to-extracted-dataset>

# regenerate the measured classification results (~70 s)
npm run evaluate -- <path-to-extracted-dataset>
```

If `data/hydraulic-rig.json` is missing, the app falls back to synthetic telemetry rather than failing — but the dashboard then says "Synthetic simulation", so the substitution is never silent.

### Path to a live machine

The frame contract is the only coupling. A live deployment would add one producer:

```
real machine → protocol adapter → normalisation → frame → WebSocket → UI
```

Concretely: OPC UA for a modern PLC, Modbus TCP for older equipment, MQTT/Sparkplug if the line already publishes, or a sensor retrofit (accelerometer, PT100, CT clamp, 4–20 mA transducer → ESP32) where no data interface exists. Two rules would change: state should come **from the machine** rather than from the Start button, and the operation must be **read-only**. Baselines for `nominal`, `min` and `max` would then have to come from datasheets and a commissioning run instead of the dataset.

---

## 8. References

1. Helwig, N., Pignanelli, E. & Schütze, A. (2015). *Condition monitoring of hydraulic systems.* UCI Machine Learning Repository. <https://doi.org/10.24432/C5CW21> — CC BY 4.0.
2. ZeMA — Centre for Mechatronics and Automation, Saarland University (rig provenance).
3. Node.js `ws` WebSocket library — <https://github.com/websockets/ws>.

All readings on the dashboard are derivative works of reference 1 and are attributed on screen at all times.
