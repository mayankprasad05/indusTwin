# IndusTwin — Industry 4.0 Digital Twin Dashboard

A learning project built around an Industry 4.0 / Smart Manufacturing course.

A full write-up — how it works, where the readings come from, what it is used for and what it cannot do — is in [REPORT.md](REPORT.md).

It simulates an industrial machine/production line and presents it as a **digital twin** on a live dashboard. The simulator emits multivariate sensor telemetry, runs analytics/anomaly detection, logs control decisions, and can run in a semi-autonomous closed-loop mode.

Sensor values on the dashboard are **real measurements** replayed from a public dataset recorded on an industrial hydraulic test rig (see [Data sources](#data-sources)). Three synthetic scenarios are also included for comparison. No real devices are required to run it.

## Modules this project addresses

- **Module 1 — Industry 4.0 intro:** the app is framed as an Industry 4.0 demo and includes a module-traceability matrix.
- **Module 2 — Sensors, connected systems, modeling to make sense of data:** real recorded sensor data replayed over WebSocket, plus the analytics layer that translates raw readings into machine state.
- **Module 3 — Data analysis, Big Data/analytics, control of manufacturing systems:** rolling stats, thresholds, anomaly detection, and control actions with a control log.
- **Module 4 — Digital twin:** a live virtual representation of the simulated machine.
- **Module 5 — Impact on various industries:** scenario presets for different kinds of manufacturing.
- **Module 6 — Cobots, image processing/AI/ML/DL, AR/VR:** not represented in the dashboard UI at the moment. `server/inspection.js` still exposes a working inspection API, but its panel has been removed from the page.
- **Module 7 — Towards autonomous manufacturing:** autonomous closed-loop mode with human override and an autonomy-level indicator.

## Getting started

```bash
cd indusTwin
npm install
npm start
```

Then open `http://localhost:3000` in a browser.

For live reload during development:

```bash
npm run dev
```

## Project layout

- `server/` — simulation/replay engine and WebSocket server (`simulation.js`, `recorded-dataset.js`).
- `public/` — static dashboard UI served by the server.
- `data/hydraulic-rig.json` — compact replay file derived from the public dataset.
- `data/model-eval.json` — fault-classification results shown in the dashboard.
- `scripts/build-hydraulic-dataset.mjs` — regenerates the replay file from the raw download.
- `scripts/evaluate-fault-classifier.mjs` — trains and scores the fault classifier against the dataset's labels.

## Scope and roadmap

Start with the MVP and expand:

1. MVP: simulated machine, live dashboard, analytics/anomaly layer, digital twin panel, control log.
2. Add a simulated cobot station and inspection/vision demo.
3. Add a 3D/AR-style twin view and multiple industry scenarios.
4. Add autonomous closed-loop control with human override.

## Data sources

### Sensor telemetry (in use)

The default scenario replays real measurements from the **UCI “Condition monitoring of hydraulic systems”** dataset, collected on the ZeMA hydraulic test rig:

- Helwig, N., Pignanelli, E. & Schütze, A. (2015). *Condition monitoring of hydraulic systems.* UCI Machine Learning Repository. <https://doi.org/10.24432/C5CW21>
- Licence: CC BY 4.0. 2,205 cycles of 60 s, 17 sensors.

How the rig's channels map onto this dashboard:

| Dashboard signal | Dataset channel | Unit |
| --- | --- | --- |
| Temperature | `TS1` (oil temperature) | °C |
| Vibration | `VS1` (pump vibration) | mm/s |
| Pressure | `PS1` (system pressure) | bar |
| Power | `EPS1` (motor power) | W |
| Airflow | `FS1` (volume flow) | l/min |

Notes on the replay:

- Channels are downsampled to 1 Hz (60 points per 60 s cycle) and 24 cycles are included, covering nominal operation, pump leakage, valve degradation, cooler failure and a multiple-fault case. Playback loops.
- Cycle time is **not** recorded by the rig, so that one signal remains modelled.
- Fault injection still overlays a simulated perturbation on the recorded values.

To rebuild `data/hydraulic-rig.json` from the raw download:

```bash
# download and extract the dataset from the UCI link above, then:
node scripts/build-hydraulic-dataset.mjs <path-to-extracted-folder>
```

If `data/` is absent, the app quietly falls back to synthetic telemetry.

### Fault classification (measured accuracy)

The dashboard's anomaly score is unsupervised: it says "something drifted", never whether that judgement is correct. The dataset ships per-cycle condition labels, which makes an honest evaluation possible.

```bash
npm run evaluate -- <path-to-extracted-dataset-folder>
```

This writes `data/model-eval.json`, which the server exposes at `/api/model-eval` and the dashboard renders in its **Fault Classification** panel.

| Task | Classes | Accuracy | Macro-F1 | Chance |
| --- | --- | --- | --- | --- |
| Cooler condition | 3% / 20% / 100% cooling | 100.0% | 1.000 | 33% |
| Valve condition | 73 / 80 / 90 / 100% switching | 88.6% | 0.836 | 25% |
| Pump leakage | none / weak / severe | 97.6% | 0.957 | 33% |
| Accumulator pressure | 90 / 100 / 115 / 130 bar | 26.3% | 0.104 | 25% |

The unsupervised drift score the live gauge uses reaches **AUC 0.904** against a "any condition degraded" label — it reliably notices that something is wrong, but cannot say what.

How the numbers are produced, and why they matter:

- **Features come from the raw high-rate channels**, not the 1 Hz replay file: per cycle, 9 statistics (mean, standard deviation, p10/p50/p90, RMS, slope, skew, kurtosis) for all 17 channels, plus 8-band spectral power and dominant frequency for the pressure, flow and power channels. 207 features per cycle. Cycling statistics alone cannot separate valve settings; the switching content is in the spectrum.
- **The split is blocked, not shuffled.** Each condition is recorded as a contiguous block, so neighbouring cycles are near-duplicates. A stratified *random* split gives 99.8 / 93.4 / 99.1 / 89.4% — that is the number most published results on this dataset report, and it is inflated. The panel shows the blocked figure and the shuffled one side by side.
- **Accumulator pressure is reported as a failure, not hidden.** It scores 89.4% under a shuffled split and 26.3% under a blocked one, which means the label leaks from recording-run identity rather than from physics that generalises. It is a rig setpoint that barely shifts the cycle statistics, so this is the expected result once the leak is removed.
- Model: multinomial logistic regression (softmax) with L2 regularisation and inverse-frequency class weights — chosen because it is explainable on 2,205 samples.
- Labels describe conditions *set by the experimenter on this rig*, not failures observed in service. The result is a lab benchmark, not proof of transfer to another machine.

The job takes about 70 s and is fully offline; it does not touch the live replay path.

### Other public datasets that could be added

- NASA C-MAPSS (turbofan engine degradation) for degradation modelling.
- MVTec AD for visual anomaly inspection on real part images.
- SECOM or similar for process-level analytics.
