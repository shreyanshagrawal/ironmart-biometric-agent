// @ts-nocheck
// Standalone agent: receives attendance pushes from the ESSL K30 biometric
// device via the ADMS HTTP protocol and forwards them to the IronMart HRMS
// backend. That is the agent's ENTIRE job — it reads punches and sends them
// on. It never writes anything back to the device.
//
// Punch sync uses ADMS push (device calls us) rather than ZK TCP pull (us
// polling the device) — the device's firmware reliably implements the former
// and timed out on the latter regardless of timeout duration.
//
// ── Why there is no device-write path here anymore (2026-08-10) ────────────
// This agent used to also poll the backend for "enroll/remove this employee
// on the device" jobs and apply them over ZK TCP (setUser/deleteUser). That
// has been removed entirely, for two independent reasons — both real, not
// theoretical:
//
//   1. It was a confirmed hazard to the thing that actually matters. This
//      device's ZK TCP stack is known-broken (documented in HANDOVER.md:
//      getUsers() times out with TIMEOUT_IN_RECEIVING_RESPONSE_AFTER_
//      REQUESTING_DATA, and CMD_CONNECT answers with a non-standard 6001).
//      The agent only ever opened a ZK TCP socket when a job was pending —
//      and a job was created by exactly one event: HR setting an employee's
//      Biometric Device Code in HRMS. So "someone was fed into HRMS" was the
//      precise trigger for the agent to start hammering a broken socket on
//      the device for up to 60s at a time, on a repeating 5-minute cycle. On
//      ESSL/ZK firmware a wedged comm session is a well-known cause of the
//      device halting its ADMS cloud push — i.e. punches stopping entirely.
//      Reported symptom matched exactly: feed a person in, punches stop.
//
//   2. Even on the success path it was destructive. setUser(uid, ...)
//      overwrites the device's whole user record at that slot; on this class
//      of device that can drop the enrolled fingerprint template, leaving a
//      real person physically unable to punch — silently, and only for them.
//
// Enrollment is therefore done ON THE DEVICE by a human (Menu -> User Mgmt),
// and HRMS is read/match-only: you type that person's device PIN into their
// Biometric Device Code field and the backend attributes their punches (and
// backfills any that already arrived before the mapping existed). The device
// remains the source of truth for who is enrolled. Do not re-add a write
// path here without real hardware to verify it against.

import os from "os";
import { loadState, saveState } from "./state.js";
import { logger, describeError } from "./logger.js";
import { startAdmsServer } from "./admsServer.js";
import {
  startHeartbeat,
  agentStats,
  recordPunchesPushed,
  recordError,
  clearError,
} from "./heartbeat.js";

// --- Process-level safety net ---------------------------------------------
// This process is unattended on a machine nobody may be able to log into, so
// an unhandled rejection killing it would silently end attendance collection
// until someone noticed. Log and keep running instead.
process.on("unhandledRejection", (reason) => {
  logger.error(`Unhandled promise rejection — agent continues running: ${describeError(reason)}`);
});
process.on("uncaughtException", (err) => {
  logger.error(`Uncaught exception — agent continues running: ${describeError(err)}`);
});

// ── Config ─────────────────────────────────────────────────────────────────
// Identifies the device in the punch payload and on the health dashboard.
// No TCP connection is ever made to it — the device connects to us.
const ESSL_DEVICE_IP = process.env.ESSL_DEVICE_IP || "192.168.1.201";
// Port this agent's ADMS HTTP server listens on. Must match what is entered
// in the device's Cloud Server Settings → Server Address field.
const ADMS_PORT = parseInt(process.env.ADMS_PORT || "7788", 10);
const VPS_INGEST_URL = process.env.VPS_INGEST_URL;
const DEVICE_AGENT_TOKEN = process.env.DEVICE_AGENT_TOKEN;
// Liveness ping to the backend so agent health is visible on the Developer
// Dashboard without needing shell access to this machine.
const HEARTBEAT_INTERVAL_MINUTES = parseFloat(process.env.HEARTBEAT_INTERVAL_MINUTES || "2");
// Stable identity for this install. Defaults to the machine hostname so a
// second agent (another office/site) never overwrites this one's status row.
const AGENT_ID = process.env.AGENT_ID || `agent-${os.hostname()}`;

if (!VPS_INGEST_URL) {
  logger.error("VPS_INGEST_URL is required (e.g. https://hrms.example.com/api/v1/attendance/device-logs/ingest)");
  process.exit(1);
}
if (!DEVICE_AGENT_TOKEN) {
  logger.error("DEVICE_AGENT_TOKEN is required — must match the backend's DEVICE_AGENT_TOKEN env var");
  process.exit(1);
}

// Derive the base attendance URL from the ingest URL so the heartbeat
// endpoint can be built without a second config variable.
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
// The watermark only moves after a confirmed successful backend push — if the
// push throws, it stays put and the same records are retried, so nothing is
// ever silently dropped, only delayed.
// HRMS's punch_type enum is Check-In | Check-Out | Break-Start | Break-End —
// no generic "unknown". Only the 4 documented ZKTeco ADMS status codes with
// a real match get mapped explicitly; anything else (including this
// device's own confirmed 255 sentinel) falls back to Check-In. Note this
// mislabelling does NOT corrupt computed attendance hours: the backend
// derives first-check-in/last-check-out by timestamp ordering, not by this
// label. See README.
const STATUS_TO_PUNCH_TYPE = {
  0: "Check-In",
  1: "Check-Out",
  2: "Break-Start", // device convention: "break out" = leaving for a break
  3: "Break-End",   // "break in" = returning from a break
  4: "Check-In",    // overtime-in — closest real analog in HRMS's enum
  5: "Check-Out",   // overtime-out
};
function mapPunchType(status) {
  return STATUS_TO_PUNCH_TYPE[status] ?? "Check-In";
}

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
    punchType:      mapPunchType(r.status),
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
  } else {
    clearError();
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

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  logger.info(
    `Biometric agent starting. Device: ${ESSL_DEVICE_IP} (push-only, no outbound device connection), ` +
    `ADMS port: ${ADMS_PORT}, target: ${VPS_INGEST_URL}`
  );

  // Punch sync — ADMS push server (device calls us; no polling needed)
  startAdmsServer({
    port: ADMS_PORT,
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

  // Nothing else to schedule: punches arrive by device push, health goes out
  // on the heartbeat timer. The process just stays up serving the ADMS port.
  agentStats.consecutiveUserSyncFailures = 0;
}

main();
