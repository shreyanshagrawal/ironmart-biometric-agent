// Polls the backend for pending "enroll/remove this employee on the device"
// jobs and executes them against the real device via zkteco-js's setUser/
// deleteUser — the only direction this can flow, since the backend (on the
// VPS) has no network route to the device's office-LAN address. Mirrors the
// punch-log direction in reverse: there the agent pushes data the backend
// consumes; here the backend queues work the agent consumes.
import { logger, describeError } from "./logger.js";

const MIN_UID = 1;
const MAX_UID = 3000; // zkteco-js's own setUser/deleteUser validate this range

async function fetchPendingJobs(vpsBaseUrl, deviceAgentToken) {
  const res = await fetch(`${vpsBaseUrl}/attendance/device-users/pending`, {
    headers: { Authorization: `Bearer ${deviceAgentToken}` },
  });
  if (!res.ok) throw new Error(`Fetching pending jobs failed: ${res.status} ${res.statusText}`);
  const body = await res.json();
  return body?.data ?? [];
}

async function ackJob(vpsBaseUrl, deviceAgentToken, jobId, status, errorMessage) {
  const res = await fetch(`${vpsBaseUrl}/attendance/device-users/${jobId}/ack`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${deviceAgentToken}` },
    body: JSON.stringify({ status, errorMessage }),
  });
  if (!res.ok) {
    // The device write itself may have already succeeded or failed — losing
    // the ack just means the backend re-offers the same job next poll
    // (harmless: setUser/deleteUser are idempotent, re-running one is a
    // no-op overwrite, not a duplicate side effect).
    logger.warn(`Failed to ack job ${jobId} (${status}): ${res.status} ${res.statusText}`);
  }
}

/** Reuses the device's existing uid slot for a userId that's already
 *  enrolled (so re-syncing an edited name/card updates in place instead of
 *  creating a duplicate device user); otherwise allocates the lowest free
 *  slot in the device's real 1-3000 range. */
async function resolveDeviceUid(zk, userid) {
  const { data: existingUsers } = await zk.getUsers();
  const match = existingUsers.find((u) => u.userId === userid);
  if (match) return match.uid;

  const usedUids = new Set(existingUsers.map((u) => u.uid));
  for (let uid = MIN_UID; uid <= MAX_UID; uid++) {
    if (!usedUids.has(uid)) return uid;
  }
  throw new Error("No free device user slot (device is at its 3000-user capacity)");
}

async function applyJob(zk, job) {
  if (job.action === "Disable") {
    const { data: existingUsers } = await zk.getUsers();
    const match = existingUsers.find((u) => u.userId === job.employeeId || u.userId === job.biometricDeviceCode);
    if (!match) {
      // Already gone from the device (or never enrolled) — a real, honest
      // no-op, not an error. Disabling an employee who was never enrolled
      // is a legitimate outcome, e.g. someone hired and offboarded same-day.
      logger.info(`Disable job for ${job.employeeName}: no matching device user found, nothing to remove.`);
      return;
    }
    await zk.deleteUser(match.uid);
    return;
  }

  // Create / Update
  if (!job.biometricDeviceCode) {
    throw new Error("Create/Update job has no biometricDeviceCode to enroll");
  }
  const uid = await resolveDeviceUid(zk, job.biometricDeviceCode);
  // password left blank (fingerprint/card is the real credential on these
  // devices, not a typed PIN); role 0 = normal user; cardno 0 = none on file.
  await zk.setUser(uid, job.biometricDeviceCode, job.employeeName.slice(0, 24), "", 0, 0);
}

/** Runs one poll cycle: fetch pending jobs, connect once, apply each job in
 *  turn (one bad job doesn't block the rest), disconnect, ack every result. */
export async function runUserSyncCycle({ ZKLib, esslIp, esslPort, vpsBaseUrl, deviceAgentToken, esslTimeoutMs = 10000 }) {
  const jobs = await fetchPendingJobs(vpsBaseUrl, deviceAgentToken);
  if (jobs.length === 0) return { processed: 0 };

  logger.info(`Found ${jobs.length} pending device-user sync job(s).`);
  const zk = new ZKLib(esslIp, esslPort, esslTimeoutMs, 4000);
  let connected = false;
  try {
    await zk.createSocket();
    connected = true;
  } catch (err) {
    // Every job fails the same way if the device itself is unreachable —
    // ack each as Failed with the real reason instead of leaving them
    // silently Pending forever (which would look identical to "nobody's
    // looked at this yet" on the HR-facing Device User Sync screen).
    for (const job of jobs) {
      await ackJob(vpsBaseUrl, deviceAgentToken, job.id, "Failed", `Device unreachable: ${describeError(err)}`);
    }
    throw err;
  }

  let succeeded = 0;
  let failed = 0;
  try {
    for (const job of jobs) {
      try {
        await applyJob(zk, job);
        await ackJob(vpsBaseUrl, deviceAgentToken, job.id, "Synced");
        logger.info(`Synced: ${job.action} ${job.employeeName} (${job.biometricDeviceCode ?? "n/a"})`);
        succeeded++;
      } catch (err) {
        const message = describeError(err);
        await ackJob(vpsBaseUrl, deviceAgentToken, job.id, "Failed", message);
        logger.error(`Failed: ${job.action} ${job.employeeName} — ${message}`);
        failed++;
      }
    }
  } finally {
    if (connected) await zk.disconnect().catch(() => {});
  }

  return { processed: jobs.length, succeeded, failed };
}
