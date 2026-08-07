// Prints every user enrolled directly on the device (uid, PIN, name) — the
// real cross-reference needed to actually do the HRMS-side mapping. HRMS's
// Biometric Device Code field has to be set to a PIN, but there is no way to
// know "PIN 46 = which employee" from HRMS or from attendance_logs alone —
// that name only exists on the device itself, typed in at enrollment time.
// This is a real, complete zkteco-js capability (getUsers()), the same one
// userSync.js already relies on for re-using an existing slot on edit.
//
// Usage: node scripts/list-device-users.mjs [ip] [port]
// Defaults to reading ESSL_DEVICE_IP/ESSL_DEVICE_PORT from .env if present.
import { readFileSync, existsSync } from "fs";
import ZKLib from "zkteco-js";

function loadEnvFallback() {
  if (!existsSync(".env")) return {};
  const out = {};
  for (const line of readFileSync(".env", "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

const envFallback = loadEnvFallback();
const IP = process.argv[2] || envFallback.ESSL_DEVICE_IP || "192.168.1.201";
const PORT = parseInt(process.argv[3] || envFallback.ESSL_DEVICE_PORT || "4370", 10);
const TIMEOUT_MS = parseInt(envFallback.ESSL_DEVICE_TIMEOUT_MS || "60000", 10);

console.log(`Connecting to ${IP}:${PORT} ...`);
const zk = new ZKLib(IP, PORT, TIMEOUT_MS, 4000);

try {
  await zk.createSocket();
  console.log("Connected. Fetching enrolled users...\n");

  const { data: users } = await zk.getUsers();

  if (!users || users.length === 0) {
    console.log("No users enrolled on this device.");
  } else {
    // Padded plain-text table — easiest to eyeball and copy PIN/name pairs
    // from a terminal, no extra dependency for a fancier table renderer.
    const rows = users
      .map((u) => ({ uid: String(u.uid), pin: String(u.userId), name: u.name || "(no name set)" }))
      .sort((a, b) => Number(a.pin) - Number(b.pin));

    const pinWidth = Math.max(3, ...rows.map((r) => r.pin.length));
    const uidWidth = Math.max(3, ...rows.map((r) => r.uid.length));

    console.log(`${"PIN".padEnd(pinWidth)}  ${"UID".padEnd(uidWidth)}  NAME`);
    console.log(`${"-".repeat(pinWidth)}  ${"-".repeat(uidWidth)}  ${"-".repeat(20)}`);
    for (const r of rows) {
      console.log(`${r.pin.padEnd(pinWidth)}  ${r.uid.padEnd(uidWidth)}  ${r.name}`);
    }
    console.log(`\n${rows.length} user(s) enrolled.`);
    console.log(
      "\nFor each real employee above: HRMS -> Employees -> edit -> set Biometric Device Code to their PIN. " +
        "Any punches already sitting in Attendance -> Exceptions for that PIN are automatically backfilled " +
        "into real attendance records the moment you save — no separate re-sync step needed."
    );
  }
} catch (err) {
  console.error(`Failed: ${err?.err?.message || err?.message || err}`);
  process.exitCode = 1;
} finally {
  await zk.disconnect().catch(() => {});
}
