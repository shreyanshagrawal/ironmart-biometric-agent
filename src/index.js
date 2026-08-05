// @ts-nocheck
// Standalone agent: polls the ESSL K30 biometric device on the office LAN,
// pushes new punch logs to the IronMart HRMS backend, and pulls pending
// "enroll/remove this employee" jobs from the backend to apply to the
// device — the only two directions that work, since the backend (on the
// VPS) has no network route to this device's private LAN address.
import ZKLib from "zkteco-js";
import { loadState, saveState } from "./state.js";
import { logger, describeError } from "./logger.js";
import { runUserSyncCycle } from "./userSync.js";

// --- Process-level safety net for a confirmed real bug in zkteco-js ---
// `readWithBuffer` in zkteco-js's ztcp.js calls `reject(err)` on a device
// timeout but is missing a `return` afterward, so it falls through into
// `decodeTCPHeader(reply.subarray(...))` with `reply` still null. That
// throw happens inside an unawaited async Promise executor — a completely
// separate, orphaned promise from the one our own code actually awaits
// (which is already correctly rejected by the earlier `reject(err)` call
// and handled normally by runOnce()'s try/catch below). Node's default
// behavior is to kill the whole process on ANY unhandled rejection,
// regardless of whether some other, unrelated promise chain is handling a
// similarly-shaped error correctly — which would silently defeat this
// agent's entire "log it, retry next poll" design on the very first device
// timeout. These handlers just stop Node from doing that; they don't
// change or suppress how runOnce()'s own error handling behaves.
process.on("unhandledRejection", (reason) => {
  logger.error(
    `Unhandled promise rejection (likely the known zkteco-js readWithBuffer bug — see README "Known limitations") — agent continues running: ${describeError(reason)}`
  );
});
process.on("uncaughtException", (err) => {
  logger.error(`Uncaught exception — agent continues running: ${describeError(err)}`);
});

const ESSL_DEVICE_IP = process.env.ESSL_DEVICE_IP || "192.168.1.201";
const ESSL_DEVICE_PORT = parseInt(process.env.ESSL_DEVICE_PORT || "4370", 10);
// How long to wait for the device to respond before zkteco-js times out a
// request. 10s (the old hardcoded default) proved too tight against real
// hardware — a device with a large attendance log or a weaker LAN link can
// genuinely take longer than that to respond. Configurable so this can be
// tuned per-site without a code change.
const ESSL_DEVICE_TIMEOUT_MS = parseInt(process.env.ESSL_DEVICE_TIMEOUT_MS || "20000", 10);
const VPS_INGEST_URL = process.env.VPS_INGEST_URL; // e.g. https://hrms.example.com/api/v1/attendance/device-logs/ingest
const DEVICE_AGENT_TOKEN = process.env.DEVICE_AGENT_TOKEN;
const POLL_INTERVAL_MINUTES = parseFloat(process.env.POLL_INTERVAL_MINUTES || "5");
// After this many consecutive failed polls, log a single escalated warning
// (not on every failure — that would just be noise) so "the device has
// actually been down for a while" is visible in the log file, not just
// buried among ordinary transient blips.
const CONSECUTIVE_FAILURE_WARNING_THRESHOLD = 3;

if (!VPS_INGEST_URL) {
  logger.error("VPS_INGEST_URL is required (e.g. https://hrms.example.com/api/v1/attendance/device-logs/ingest)");
  process.exit(1);
}
if (!DEVICE_AGENT_TOKEN) {
  logger.error("DEVICE_AGENT_TOKEN is required — must match the backend's DEVICE_AGENT_TOKEN env var");
  process.exit(1);
}

// Derive the plain API base (VPS_INGEST_URL already points at the specific
// ingest route) so the user-sync endpoints under the same /attendance
// prefix can be built without a second config variable.
const VPS_BASE_URL = VPS_INGEST_URL.replace(/\/attendance\/device-logs\/ingest\/?$/, "/attendance");

async function fetchLogsFromDevice() {
  const zk = new ZKLib(ESSL_DEVICE_IP, ESSL_DEVICE_PORT, ESSL_DEVICE_TIMEOUT_MS, 4000);
  try {
    await zk.createSocket();

    // Diagnostic probe: CMD_GET_FREE_SIZES (50) sent directly via the
    // library's internal executeCmd, bypassing zkteco-js's own getInfo()
    // wrapper — that wrapper crashed with a real RangeError trying to parse
    // this device's actual reply as if it were the 76+ byte payload it
    // expects (userCounts at offset 24, logCounts at 40, logCapacity at
    // 72), but this device's reply is only 8 bytes. That's a genuine
    // firmware/protocol difference from what the library assumes, not a
    // timeout — the device replied fine, just with a shorter payload. This
    // logs the RAW bytes so we can see exactly what this device actually
    // sends, instead of continuing to guess. Safe to remove once diagnosed.
    try {
      const rawReply = await zk.ztcp.executeCmd(50 /* CMD_GET_FREE_SIZES */, "");
      logger.info(
        `Diagnostic CMD_GET_FREE_SIZES raw reply: length=${rawReply?.length ?? "null"} hex=${rawReply ? rawReply.toString("hex") : "null"}`
      );
    } catch (err) {
      logger.warn(`Diagnostic CMD_GET_FREE_SIZES FAILED (device isn't responding to even a lightweight command): ${describeError(err)}`);
    }

    // Disable the device before pulling the log and re-enable it right
    // after — a real, standard ZK protocol pattern this library's own
    // getAttendances() doesn't do on its own. Without it, some firmware
    // stays "live" (still able to accept a punch / run a fingerprint scan)
    // mid-transfer, and can simply never get around to replying to the
    // data request within any timeout — indistinguishable from a network
    // problem in the logs, but actually a device-busy issue. Best-effort:
    // if disable itself fails, still attempt the read rather than aborting
    // the whole poll over it.
    await zk.disableDevice().catch((err) => {
      logger.warn(`Could not disable device before read (continuing anyway): ${describeError(err)}`);
    });
    try {
      const result = await zk.getAttendances();
      return result?.data || [];
    } finally {
      // Always try to re-enable, even if the read itself failed — a device
      // left disabled would silently stop accepting real punches until the
      // next successful poll, which is worse than the original bug.
      await zk.enableDevice().catch((err) => {
        logger.warn(`Could not re-enable device after read: ${describeError(err)}`);
      });
    }
  } finally {
    await zk.disconnect().catch(() => {});
  }
}

function toIngestPayload(rawLogs) {
  return rawLogs.map((log) => ({
    employeeId: log.user_id,
    deviceId: ESSL_DEVICE_IP,
    punchTimestamp: log.record_time,
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

async function syncPunchLogs() {
  const state = loadState();
  const lastSyncedTimestamp = state.lastSyncedTimestamp ? new Date(state.lastSyncedTimestamp) : null;

  logger.info(`Polling ${ESSL_DEVICE_IP}:${ESSL_DEVICE_PORT} for punch logs...`);
  const rawLogs = await fetchLogsFromDevice();

  const newLogs = lastSyncedTimestamp
    ? rawLogs.filter((log) => new Date(log.record_time) > lastSyncedTimestamp)
    : rawLogs;

  if (newLogs.length === 0) {
    logger.info("No new punches since last sync.");
    return;
  }

  const payload = toIngestPayload(newLogs);
  const result = await pushLogs(payload);
  logger.info(
    `Pushed ${payload.length} punch(es) — inserted: ${result?.data?.insertedCount ?? "?"}, unmatched: ${result?.data?.unmatchedCount ?? "?"}`
  );

  // Only advance the watermark after a confirmed successful push, so a
  // failed push retries the same window next poll instead of silently
  // dropping punches.
  const maxTimestamp = newLogs.reduce(
    (max, log) => (new Date(log.record_time) > max ? new Date(log.record_time) : max),
    lastSyncedTimestamp || new Date(0)
  );
  saveState({ ...state, lastSyncedTimestamp: maxTimestamp.toISOString() });
}

async function syncDeviceUsers() {
  const result = await runUserSyncCycle({
    ZKLib,
    esslIp: ESSL_DEVICE_IP,
    esslPort: ESSL_DEVICE_PORT,
    vpsBaseUrl: VPS_BASE_URL,
    deviceAgentToken: DEVICE_AGENT_TOKEN,
    esslTimeoutMs: ESSL_DEVICE_TIMEOUT_MS,
  });
  if (result.processed > 0) {
    logger.info(`Device user sync: ${result.succeeded ?? 0} succeeded, ${result.failed ?? 0} failed.`);
  }
}

let consecutiveFailures = 0;

async function runOnce() {
  try {
    await syncPunchLogs();
    await syncDeviceUsers();
    if (consecutiveFailures > 0) {
      logger.info(`Device reachable again after ${consecutiveFailures} failed poll(s).`);
    }
    consecutiveFailures = 0;
  } catch (err) {
    consecutiveFailures++;
    logger.error(`Poll failed (${consecutiveFailures} consecutive): ${describeError(err)}`);
    if (consecutiveFailures === CONSECUTIVE_FAILURE_WARNING_THRESHOLD) {
      const downForMinutes = consecutiveFailures * POLL_INTERVAL_MINUTES;
      logger.warn(
        `Device or network has failed ${consecutiveFailures} polls in a row (~${downForMinutes} min). ` +
          `Punches since the last successful sync are NOT lost — the device itself is still recording them, ` +
          `and this agent's watermark only advances on a confirmed successful push, so the next successful ` +
          `poll will catch everything up. This warning just flags that it's worth checking the device/network ` +
          `if it doesn't self-recover soon.`
      );
    }
  }
}

async function main() {
  logger.info(
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
    } finally {
      running = false;
    }
  };

  await tick();
  setInterval(tick, intervalMs);
}

main();
