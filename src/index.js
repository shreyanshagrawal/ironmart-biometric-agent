// @ts-nocheck
// Standalone agent: polls the ESSL K30 biometric device on the office LAN
// and pushes new punch logs to the IronMart HRMS backend over HTTPS.
//
// This deliberately mirrors backend/src/integrations/attendance/providers/EsslProvider.ts's
// connection + log-parsing logic (same node-zklib call shape, same field
// mapping) so the pushed payload needs no reshaping on the backend side —
// AttendanceSyncService.ingestRawLogs consumes it identically to the
// pull-based path.
import ZKLib from "node-zklib";
import { loadState, saveState } from "./state.js";

const ESSL_DEVICE_IP = process.env.ESSL_DEVICE_IP || "192.168.1.201";
const ESSL_DEVICE_PORT = parseInt(process.env.ESSL_DEVICE_PORT || "4370", 10);
const VPS_INGEST_URL = process.env.VPS_INGEST_URL; // e.g. https://hrms.example.com/api/v1/attendance/device-logs/ingest
const DEVICE_AGENT_TOKEN = process.env.DEVICE_AGENT_TOKEN;
const POLL_INTERVAL_MINUTES = parseFloat(process.env.POLL_INTERVAL_MINUTES || "5");

if (!VPS_INGEST_URL) {
  console.error("VPS_INGEST_URL is required (e.g. https://hrms.example.com/api/v1/attendance/device-logs/ingest)");
  process.exit(1);
}
if (!DEVICE_AGENT_TOKEN) {
  console.error("DEVICE_AGENT_TOKEN is required — must match the backend's DEVICE_AGENT_TOKEN env var");
  process.exit(1);
}

async function fetchLogsFromDevice() {
  const zk = new ZKLib(ESSL_DEVICE_IP, ESSL_DEVICE_PORT, 10000, 4000);
  try {
    await zk.createSocket();
    const result = await zk.getAttendances();
    return result?.data || [];
  } finally {
    await zk.disconnect().catch(() => {});
  }
}

function toIngestPayload(rawLogs) {
  return rawLogs.map((log) => ({
    employeeId: log.deviceUserId.toString(),
    deviceId: ESSL_DEVICE_IP,
    punchTimestamp: log.recordTime,
    punchType: "Check-In",
    source: "eSSL",
    rawDeviceData: log,
  }));
}

async function pushLogs(logs) {
  const res = await fetch(VPS_INGEST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DEVICE_AGENT_TOKEN}`,
    },
    body: JSON.stringify({ logs }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Ingest request failed: ${res.status} ${res.statusText} ${body}`);
  }

  return res.json();
}

async function runOnce() {
  const state = loadState();
  const lastSyncedTimestamp = state.lastSyncedTimestamp ? new Date(state.lastSyncedTimestamp) : null;

  console.log(`[${new Date().toISOString()}] Polling ${ESSL_DEVICE_IP}:${ESSL_DEVICE_PORT}...`);
  const rawLogs = await fetchLogsFromDevice();

  const newLogs = lastSyncedTimestamp
    ? rawLogs.filter((log) => new Date(log.recordTime) > lastSyncedTimestamp)
    : rawLogs;

  if (newLogs.length === 0) {
    console.log("No new punches since last sync.");
    return;
  }

  const payload = toIngestPayload(newLogs);
  const result = await pushLogs(payload);
  console.log(
    `Pushed ${payload.length} punch(es) — inserted: ${result?.data?.insertedCount ?? "?"}, unmatched: ${result?.data?.unmatchedCount ?? "?"}`
  );

  // Only advance the watermark after a confirmed successful push, so a
  // failed push retries the same window next poll instead of silently
  // dropping punches.
  const maxTimestamp = newLogs.reduce(
    (max, log) => (new Date(log.recordTime) > max ? new Date(log.recordTime) : max),
    lastSyncedTimestamp || new Date(0)
  );
  saveState({ lastSyncedTimestamp: maxTimestamp.toISOString() });
}

async function main() {
  console.log(
    `Biometric agent starting. Device: ${ESSL_DEVICE_IP}:${ESSL_DEVICE_PORT}, poll interval: ${POLL_INTERVAL_MINUTES}min, target: ${VPS_INGEST_URL}`
  );

  const intervalMs = POLL_INTERVAL_MINUTES * 60 * 1000;

  // Run immediately, then on the configured interval — never overlap two
  // polls if a device fetch runs long.
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runOnce();
    } catch (err) {
      console.error(`Poll failed: ${err.message}`);
    } finally {
      running = false;
    }
  };

  await tick();
  setInterval(tick, intervalMs);
}

main();
