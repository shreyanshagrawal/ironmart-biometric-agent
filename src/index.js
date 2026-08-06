// @ts-nocheck
// Standalone agent: receives attendance pushes from the ESSL K30 biometric
// device via the ADMS HTTP protocol and forwards them to the IronMart HRMS
// backend; also pulls pending "enroll/remove this employee" jobs from the
// backend and applies them to the device via ZK TCP (the write direction).
//
// Punch sync uses ADMS push (device calls us) rather than ZK TCP pull (us
// polling the device) — the device's firmware reliably implements the former
// and timed out on the latter regardless of timeout duration. ZK TCP is kept
// only for the write direction (setUser / deleteUser), where it works fine.

import os from "os";
import ZKLib from "zkteco-js";
import { loadState, saveState } from "./state.js";
import { logger, describeError } from "./logger.js";
import { runUserSyncCycle } from "./userSync.js";
import { startAdmsServer } from "./admsServer.js";
import {
  startHeartbeat,
  agentStats,
  recordDeviceContact,
  recordPunchesPushed,
  recordError,
  clearError,
} from "./heartbeat.js";

// --- Process-level safety net for a confirmed real bug in zkteco-js ---
// `readWithBuffer` in zkteco-js's ztcp.js calls `reject(err)` on a device
// timeout but is missing a `return` afterward, so it falls through into
// `decodeTCPHeader(reply.subarray(...))` with `reply` still null. That
// throw happens inside an unawaited async Promise executor — completely
// separate from the promise our code actually awaits (which is already
// correctly handled by our own try/catch). These handlers stop Node from
// killing the process over that orphaned rejection; they do not change how
// our own error handling behaves. Still needed because ZK TCP is used for
// the write direction (setUser / deleteUser).
process.on("unhandledRejection", (reason) => {
  logger.error(
    `Unhandled promise rejection (likely the known zkteco-js readWithBuffer bug — see README "Known limitations") — agent continues running: ${describeError(reason)}`
  );
});
process.on("uncaughtException", (err) => {
  logger.error(`Uncaught exception — agent continues running: ${describeError(err)}`);
});

// ── Config ─────────────────────────────────────────────────────────────────
const ESSL_DEVICE_IP   = process.env.ESSL_DEVICE_IP   || "192.168.1.201";
const ESSL_DEVICE_PORT = parseInt(process.env.ESSL_DEVICE_PORT || "4370", 10);
// Timeout for ZK TCP commands (setUser / deleteUser only — punch sync no
// longer uses ZK TCP at all, so this no longer affects punch reliability).
const ESSL_DEVICE_TIMEOUT_MS = parseInt(process.env.ESSL_DEVICE_TIMEOUT_MS || "60000", 10);
// Port this agent's ADMS HTTP server listens on. Must match what is entered
// in the device's Cloud Server Settings → Server Address field.
const ADMS_PORT = parseInt(process.env.ADMS_PORT || "7788", 10);
const VPS_INGEST_URL     = process.env.VPS_INGEST_URL;
const DEVICE_AGENT_TOKEN = process.env.DEVICE_AGENT_TOKEN;
// How often to poll for pending device-user enrollment jobs. Punch sync is
// now event-driven (device pushes to us), so this interval only controls
// how often the enrollment queue is checked.
const POLL_INTERVAL_MINUTES = parseFloat(process.env.POLL_INTERVAL_MINUTES || "5");
// Liveness ping to the backend so agent health is visible on the Developer
// Dashboard without needing shell access to this machine.
const HEARTBEAT_INTERVAL_MINUTES = parseFloat(process.env.HEARTBEAT_INTERVAL_MINUTES || "2");
// Stable identity for this install. Defaults to the machine hostname so a
// second agent (another office/site) never overwrites this one's status row.
const AGENT_ID = process.env.AGENT_ID || `agent-${os.hostname()}`;
// After this many consecutive failed user-sync polls, log a single escalated
// warning (not on every failure — that's just noise).
const CONSECUTIVE_FAILURE_WARNING_THRESHOLD = 3;

if (!VPS_INGEST_URL) {
  logger.error("VPS_INGEST_URL is required (e.g. https://hrms.example.com/api/v1/attendance/device-logs/ingest)");
  process.exit(1);
}
if (!DEVICE_AGENT_TOKEN) {
  logger.error("DEVICE_AGENT_TOKEN is required — must match the backend's DEVICE_AGENT_TOKEN env var");
  process.exit(1);
}

// Derive the base attendance URL from the ingest URL so user-sync endpoints
// can be built without a second config variable.
const VPS_BASE_URL = VPS_INGEST_URL.replace(/\/attendance\/device-logs\/ingest\/?$/, "/attendance");

// ── Backend push ────────────────────────────────────────────────────────────
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

// ── ADMS punch handler ──────────────────────────────────────────────────────
// Called by admsServer.js whenever the device pushes a batch of ATTLOG
// records. Filters records already covered by the watermark (belt-and-
// suspenders on top of the ATTLOGStamp the handshake already set on the
// device side), pushes new ones to the backend, and advances the watermark.
// The watermark only moves after a confirmed successful backend push — same
// guarantee as the old poll model, nothing is ever silently dropped.
async function onPunchBatch(records, sn) {
  const state = loadState();
  const lastSyncedTimestamp = state.lastSyncedTimestamp ? new Date(state.lastSyncedTimestamp) : null;

  const newRecords = lastSyncedTimestamp
    ? records.filter((r) => new Date(r.dateTime) > lastSyncedTimestamp)
    : records;

  if (newRecords.length === 0) {
    logger.info(`SN=${sn}: all ${records.length} pushed record(s) already synced — skipping.`);
    return;
  }

  const payload = newRecords.map((r) => ({
    employeeId:     r.pin,
    deviceId:       ESSL_DEVICE_IP,
    punchTimestamp: r.dateTime,
    punchType:      "Check-In",
    source:         "eSSL",
    rawDeviceData:  r,
  }));

  const result = await pushLogs(payload);
  recordPunchesPushed(payload.length);
  const unmatched = result?.data?.unmatchedCount ?? 0;
  logger.info(
    `SN=${sn}: pushed ${payload.length} new punch(es) — ` +
    `inserted: ${result?.data?.insertedCount ?? "?"}, unmatched: ${unmatched}`
  );
  // An unmatched punch means the device PIN has no employee with that
  // biometricDeviceCode in HRMS — the punch IS stored (visible under
  // Attendance → Exceptions) but isn't attributed to anyone yet. Surface it
  // in the heartbeat so this is visible remotely rather than only in a log
  // file on a machine nobody can reach.
  if (unmatched > 0) {
    recordError(
      `${unmatched} of ${payload.length} punch(es) had no matching employee ` +
        `(set that employee's Biometric Device Code in HRMS to the device PIN).`
    );
  }

  // Advance watermark to the latest record in this batch.
  const maxTimestamp = newRecords.reduce(
    (max, r) => (new Date(r.dateTime) > max ? new Date(r.dateTime) : max),
    lastSyncedTimestamp || new Date(0)
  );
  saveState({ ...state, lastSyncedTimestamp: maxTimestamp.toISOString() });
}

// Returns the last-synced timestamp as Unix seconds for the ADMS ATTLOGStamp
// handshake — tells the device to only send records strictly newer than this,
// so we never receive the full accumulated log on every connection.
function getLastSyncedUnixSec() {
  const state = loadState();
  if (!state.lastSyncedTimestamp) return 0;
  return Math.floor(new Date(state.lastSyncedTimestamp).getTime() / 1000);
}

// ── Device user sync (ZK TCP write direction) ───────────────────────────────
// Punch sync no longer touches ZK TCP. This is the only remaining use of
// zkteco-js — for setUser / deleteUser (short commands that work reliably).
async function syncDeviceUsers() {
  const result = await runUserSyncCycle({
    ZKLib,
    esslIp:           ESSL_DEVICE_IP,
    esslPort:         ESSL_DEVICE_PORT,
    vpsBaseUrl:       VPS_BASE_URL,
    deviceAgentToken: DEVICE_AGENT_TOKEN,
    esslTimeoutMs:    ESSL_DEVICE_TIMEOUT_MS,
  });
  if (result.processed > 0) {
    logger.info(`Device user sync: ${result.succeeded ?? 0} succeeded, ${result.failed ?? 0} failed.`);
  }
}

let consecutiveFailures = 0;

async function runUserSyncOnce() {
  try {
    await syncDeviceUsers();
    if (consecutiveFailures > 0) {
      logger.info(`Device user sync recovered after ${consecutiveFailures} consecutive failure(s).`);
    }
    consecutiveFailures = 0;
    agentStats.consecutiveUserSyncFailures = 0;
    clearError();
  } catch (err) {
    consecutiveFailures++;
    agentStats.consecutiveUserSyncFailures = consecutiveFailures;
    recordError(describeError(err));
    logger.error(`User sync failed (${consecutiveFailures} consecutive): ${describeError(err)}`);
    if (consecutiveFailures === CONSECUTIVE_FAILURE_WARNING_THRESHOLD) {
      logger.warn(
        `Device or network has failed ${consecutiveFailures} user-sync polls in a row. ` +
        `Pending enrollment jobs are NOT lost — they remain Pending on the backend and will ` +
        `be retried on the next successful cycle. Check the device/network if it doesn't self-recover.`
      );
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  logger.info(
    `Biometric agent starting. Device: ${ESSL_DEVICE_IP}:${ESSL_DEVICE_PORT}, ` +
    `ADMS port: ${ADMS_PORT}, user-sync interval: ${POLL_INTERVAL_MINUTES}min, ` +
    `target: ${VPS_INGEST_URL}`
  );

  // Punch sync — ADMS push server (device calls us; no polling needed)
  startAdmsServer({
    port:                ADMS_PORT,
    onPunchBatch,
    getLastSyncedUnixSec,
  });

  // Liveness reporting — makes agent health visible on the Developer
  // Dashboard without needing shell access to this machine.
  startHeartbeat({
    vpsBaseUrl:       VPS_BASE_URL,
    deviceAgentToken: DEVICE_AGENT_TOKEN,
    agentId:          AGENT_ID,
    deviceIp:         ESSL_DEVICE_IP,
    admsPort:         ADMS_PORT,
    intervalMinutes:  HEARTBEAT_INTERVAL_MINUTES,
  });

  // User enrollment sync — ZK TCP poll on a regular interval (write only)
  const intervalMs = POLL_INTERVAL_MINUTES * 60 * 1000;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runUserSyncOnce();
    } finally {
      running = false;
    }
  };

  await tick();
  setInterval(tick, intervalMs);
}

main();
