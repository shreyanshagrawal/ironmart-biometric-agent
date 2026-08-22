// Periodic liveness/health ping to the HRMS backend.
//
// Why this exists: this agent runs on an office-LAN machine that nobody may
// be able to log into. Without a heartbeat, "the agent stopped working" is
// completely invisible remotely — punches would just silently stop arriving,
// and the only way to notice would be someone eventually asking why
// attendance looks empty. This makes agent health a real, visible thing on
// the Developer Dashboard instead.
//
// Deliberately best-effort: a failed heartbeat NEVER interrupts punch
// forwarding or user sync. Monitoring that can take down the thing it
// monitors is worse than no monitoring.
import { execSync } from "child_process";
import { logger, describeError } from "./logger.js";

/** Resolve the running git commit, so the dashboard can show whether the
 *  auto-updater actually landed a new version on this machine — remotely
 *  answerable without shell access to the box. */
function resolveAgentVersion() {
  try {
    return execSync("git rev-parse --short HEAD", {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "unknown"; // not a git checkout, or git isn't on PATH — not fatal
  }
}

const AGENT_VERSION = resolveAgentVersion();
const AGENT_STARTED_AT = new Date().toISOString();

/**
 * Mutable stats the rest of the agent updates as things happen. Kept in
 * memory only — this is a "how is it doing right now" snapshot, and the
 * backend row is the durable record.
 */
export const agentStats = {
  /**
   * The query parameters the device sent on its most recent handshake.
   *
   * Kept because nobody can read this machine's log file: the firmware version
   * and push-protocol version live here and nowhere else, and they are what
   * decide whether this unit can serve a USERINFO/roster request at all. Being
   * unable to answer that has already cost several rounds of guessing.
   */
  lastHandshakeParams: null,
  lastDeviceContactAt: null, // any ADMS request from the device
  lastPunchPushedAt: null, // last successful forward to the backend
  punchesPushedTotal: 0,
  consecutiveUserSyncFailures: 0,
  lastErrorMessage: null,
  lastErrorAt: null,
  deviceSerialNumber: null,
};

/**
 * Records the handshake's query parameters, and logs them ONLY when they change.
 *
 * The device handshakes every few seconds; logging the set every time would
 * bury everything else in the file. Logging on change means it appears once at
 * startup and again only if the device is reconfigured or replaced — which is
 * exactly when it matters.
 */
export function recordHandshakeParams(params) {
  const serialized = JSON.stringify(params);
  if (serialized === JSON.stringify(agentStats.lastHandshakeParams)) return;
  agentStats.lastHandshakeParams = params;
  logger.info(`ADMS handshake parameters (changed or first seen): ${serialized}`);
}

export function recordDeviceContact(sn) {
  agentStats.lastDeviceContactAt = new Date().toISOString();
  if (sn && sn !== "unknown") agentStats.deviceSerialNumber = sn;
}

export function recordPunchesPushed(count) {
  agentStats.lastPunchPushedAt = new Date().toISOString();
  agentStats.punchesPushedTotal += count;
}

export function recordError(message) {
  agentStats.lastErrorMessage = String(message).slice(0, 500);
  agentStats.lastErrorAt = new Date().toISOString();
}

export function clearError() {
  agentStats.lastErrorMessage = null;
  agentStats.lastErrorAt = null;
}

async function sendHeartbeat({ vpsBaseUrl, deviceAgentToken, agentId, deviceIp, admsPort }) {
  const url = `${vpsBaseUrl}/agent-heartbeat`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${deviceAgentToken}`,
    },
    body: JSON.stringify({
      agentId,
      agentVersion: AGENT_VERSION,
      agentStartedAt: AGENT_STARTED_AT,
      deviceIp,
      admsPort,
      deviceSerialNumber: agentStats.deviceSerialNumber,
      lastDeviceContactAt: agentStats.lastDeviceContactAt,
      lastPunchPushedAt: agentStats.lastPunchPushedAt,
      punchesPushedTotal: agentStats.punchesPushedTotal,
      consecutiveUserSyncFailures: agentStats.consecutiveUserSyncFailures,
      lastErrorMessage: agentStats.lastErrorMessage,
      lastErrorAt: agentStats.lastErrorAt,
      // Surfaces the device's self-reported firmware/protocol details in the
      // database, so they can be read without access to this machine.
      lastHandshakeParams: agentStats.lastHandshakeParams,
    }),
  });
  if (!res.ok) {
    throw new Error(`Heartbeat failed: ${res.status} ${res.statusText} (URL: ${url})`);
  }
}

/** Start the heartbeat loop. Fires immediately, then every intervalMinutes. */
export function startHeartbeat({
  vpsBaseUrl,
  deviceAgentToken,
  agentId,
  deviceIp,
  admsPort,
  intervalMinutes = 2,
}) {
  let failures = 0;
  const tick = async () => {
    try {
      await sendHeartbeat({ vpsBaseUrl, deviceAgentToken, agentId, deviceIp, admsPort });
      if (failures > 0) {
        logger.info(`Heartbeat restored after ${failures} failure(s).`);
        failures = 0;
      }
    } catch (err) {
      failures++;
      // Only log the first failure and then every 10th — a backend outage
      // shouldn't flood the log file on a machine nobody is watching.
      if (failures === 1 || failures % 10 === 0) {
        logger.warn(`Heartbeat failed (${failures} consecutive): ${describeError(err)}`);
      }
    }
  };

  tick();
  const timer = setInterval(tick, intervalMinutes * 60 * 1000);
  logger.info(
    `Heartbeat started (every ${intervalMinutes}min, agentId=${agentId}, version=${AGENT_VERSION}).`
  );
  return timer;
}
