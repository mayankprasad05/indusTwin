import { createServer } from "node:http";
import { readFileSync, statSync, existsSync } from "node:fs";
import { join, extname, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { createSimulator, createScenario, listScenarios } from "./simulation.js";
import { SAMPLES, runInspection } from "./inspection.js";

const PORT = (() => {
  const raw = process.env.PORT;
  if (!raw || raw === "0") return 3000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 3000;
})();
const PUBLIC_DIR = resolve(process.cwd(), "public");

// Default to the recorded rig when its dataset is present, otherwise fall back
// to the synthetic CNC model.
const DEFAULT_SCENARIO = listScenarios()[0] ?? "cnc_machining";
const simulator = createSimulator({ scenario: DEFAULT_SCENARIO, tickMs: 800 });

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  // API routes first
  if (url.pathname === "/api/scenarios" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        scenarios: listScenarios().map((key) => ({
          key,
          name: createScenario(key).name,
        })),
        current: readConfig().name,
        currentKey: readConfig().key,
        recorded: Boolean(readConfig().recorded),
      })
    );
    return;
  }

  // Offline fault-classification results (scripts/evaluate-fault-classifier.mjs).
  if (url.pathname === "/api/model-eval" && req.method === "GET") {
    const evalPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "data",
      "model-eval.json"
    );
    try {
      if (!existsSync(evalPath)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "model-eval.json not generated yet" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(readFileSync(evalPath, "utf8"));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    }
    return;
  }

  // Module 6: synthetic vision inspection station.
  if (url.pathname === "/api/inspection/samples" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        samples: SAMPLES.map((s) => ({
          id: s.id,
          label: s.label,
          variant: s.variant,
          severity: s.severity,
        })),
      })
    );
    return;
  }
  if (url.pathname === "/api/inspection" && req.method === "GET") {
    const sampleId = url.searchParams.get("sample") || "good_1";
    if (!SAMPLES.some((s) => s.id === sampleId)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Unknown sample: ${sampleId}` }));
      return;
    }
    try {
      const result = runInspection({ sampleId });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    }
    return;
  }
  if (url.pathname === "/api/switchScenario" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }
      if (!payload.scenario) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "scenario required" }));
        return;
      }
      const valid = listScenarios();
      if (!valid.includes(payload.scenario)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: `Unknown scenario: ${payload.scenario}` }));
        return;
      }
      switchScenario(payload.scenario);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, scenario: payload.scenario, name: readConfig().name }));
    });
    return;
  }

  // Static files
  let path = url.pathname;

  // Serve index.html for /
  if (path === "/" || path === "/index.html") {
    path = "/index.html";
  }

  const filePath = join(PUBLIC_DIR, path);

  // Security: do not allow escaping the public dir
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    if (existsSync(filePath) && statSync(filePath).isDirectory()) {
      // Try index.html inside the directory
      const candidate = join(filePath, "index.html");
      if (existsSync(candidate)) {
        try {
          res.writeHead(200, { "Content-Type": mime[extname(candidate)] ?? "text/html; charset=utf-8" });
          res.end(readFileSync(candidate));
        } catch {
          res.writeHead(500);
          res.end("Internal Server Error");
        }
        return;
      }
    }
    res.writeHead(404);
    res.end("Not Found");
    return;
  }

  const type = mime[extname(filePath)] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": type });
  res.end(readFileSync(filePath));
});

const wss = new WebSocketServer({ server, path: "/ws" });

// Keep track of connected clients so we can broadcast simulation frames.
const clients = new Set();

function broadcastFrame(frame, type = "frame") {
  const msg = { ...frame, _msgId: ++messageId, _type: type };
  const bytes = JSON.stringify(msg);
  for (const client of clients) {
    if (client.readyState === 1) {
      client.send(bytes);
    }
  }
  const f = frame;
  if (type === "error") console.error("WS error", f);
}

let messageId = 0;

wss.on("connection", (ws, req) => {
  console.log("Client connected from", req.socket.remoteAddress);

  clients.add(ws);

  // Send an initial snapshot immediately
  try {
    ws.send(JSON.stringify({ ...readSnapshot(), _msgId: ++messageId, _type: "snapshot" }));
  } catch {
    // ignore
  }

  ws.on("message", (data) => {
    let cmd;
    try {
      cmd = JSON.parse(data.toString());
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid message" }));
      return;
    }

    switch (cmd.type) {
      case "start":
        liveSimulator.start();
        break;
      case "stop":
        liveSimulator.emergencyStop();
        break;
      case "reset":
        liveSimulator.reset();
        break;
      case "setScenario":
        // Reserved for future in-band scenario switching; currently use HTTP API.
        ws.send(JSON.stringify({ type: "error", message: "Use POST /api/switchScenario" }));
        return;
      case "setAutonomous":
        liveSimulator.setAutonomous(Boolean(cmd.on), cmd.level ?? "monitoring");
        break;
      case "injectAnomaly": {
        // An anomaly is only observable while the twin is producing frames, so
        // tell the operator instead of silently queueing something invisible.
        const st = readSnapshot().state;
        if (st !== "running" && st !== "starting") {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Start the machine before injecting an anomaly.",
            })
          );
          return;
        }
        liveSimulator.scheduleAnomaly({
          atTime: readSnapshot().time + 1,
          duration: cmd.duration ?? 6,
          signal: cmd.signal ?? "vibration",
          severity: cmd.severity ?? 1,
        });
        break;
      }
      case "scheduleAnomaly": {
        liveSimulator.scheduleAnomaly({
          atTime: cmd.atTime ?? readSnapshot().time + 1,
          duration: cmd.duration ?? 6,
          signal: cmd.signal ?? "vibration",
          severity: cmd.severity ?? 1,
        });
        break;
      }
      default:
        ws.send(JSON.stringify({ type: "error", message: `Unknown command: ${cmd.type}` }));
        return;
    }

    // If the command changed the machine state, resync the simulation loop
    // so telemetry only runs while the machine is actually running.
    if (STATE_CHANGE_EVENTS.has(cmd.type)) {
      syncSimLoopToState();
    }

    // After any command, send back a snapshot so the client can refresh state
    try {
      broadcastFrame(readSnapshot(), "snapshot");
    } catch {
      // ignore
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    console.log("Client disconnected");
  });

  ws.on("error", () => {
    // ignore per-connection errors; the server keeps running.
  });
});

// Restart with a new scenario is handled by recreating the simulator on demand.
// We expose a helper for the dashboard to switch scenarios cleanly.
// NOTE: the live simulator is swapped via `liveSimulator`; the initial value
// is the module `simulator` so the rest of this file can still refer to it.
let liveSimulator = simulator;
function switchScenario(scenarioKey) {
  const oldLog = liveSimulator.snapshot().controlLog.slice();
  const fresh = createSimulator({
    scenario: scenarioKey,
    tickMs: liveSimulator.config.tickMs,
    seedLog: oldLog,
  });
  liveSimulator = fresh;
  // Resync the loop to the new simulator's state.
  syncSimLoopToState();
}

// Helpers used by HTTP API and WebSocket handlers.
function readSnapshot() {
  return liveSimulator.snapshot();
}
function readLiveFrame() {
  return liveSimulator.liveFrame();
}
function readConfig() {
  return liveSimulator.config;
}

// Simulation loop: step the live simulator and broadcast the frame.
const SIM_TICK_MS = liveSimulator.config.tickMs;

let simInterval = null;
let simTickCount = 0;

function startSimLoop() {
  if (simInterval) clearInterval(simInterval);
  simInterval = setInterval(() => {
    simTickCount++;
    try {
      const frame = liveSimulator.step();
      broadcastFrame(frame, "frame");
    } catch (err) {
      console.error("simulation step error:", err);
    }
  }, SIM_TICK_MS);
}

function stopSimLoop() {
  if (simInterval) {
    clearInterval(simInterval);
    simInterval = null;
    console.log("[SIM] loop stopped");
  }
}

// Start ticking only when the machine is running; stop when it is not.
// This keeps the telemetry loop aligned with the machine state.
function syncSimLoopToState() {
  const st = liveSimulator.snapshot().state;
  const running = st === "running" || st === "starting";
  console.log("[SIM] syncSimLoopToState - state:", st, "- running:", running);
  if (running) {
    startSimLoop();
  } else {
    stopSimLoop();
  }
}

const STATE_CHANGE_EVENTS = new Set(["start", "stop", "reset"]);

// Single refresh loop shared by all clients. Runs faster than the simulation
// tick so panels (uptime, state) stay accurate between ticks.
const refreshTimer = setInterval(() => {
  if (!clients.size) return;
  try {
    const f = readLiveFrame();
    if (f) broadcastFrame(f, "frame");
  } catch {
    // ignore
  }
}, 250);

server.listen(PORT, () => {
  console.log(`IndusTwin dashboard: http://localhost:${PORT}`);
  console.log(`WebSocket: ws://localhost:${PORT}/ws`);
  // Begin in sync with the initial machine state.
  syncSimLoopToState();
});
