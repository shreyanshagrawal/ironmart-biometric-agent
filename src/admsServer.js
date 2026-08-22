// ADMS (Attendance Data Management System) HTTP server — receives punch
// records that the ESSL K30 pushes to us over HTTP, instead of our agent
// polling the device over ZK TCP (which reliably timed out on this firmware
// regardless of timeout duration).
//
// This is the exact protocol eSSL Lite uses to receive punches, which is
// why it works where the ZK TCP pull never did. The device's firmware fully
// implements ADMS; it only partially implements the ZKTeco bulk-read protocol.
//
// ADMS protocol flow (device-initiated):
//   1. Device boots / reconnects
//        → GET /iclock/cdata?SN=<serial>&options=all
//        ← ATTLOGStamp=<unix_sec>  (device only pushes records NEWER than this)
//   2. Device has queued punches
//        → POST /iclock/cdata?SN=<serial>&table=ATTLOG
//        ← OK: <count>
//   3. Device polls for pending commands (future: push-based enrollment)
//        → GET /iclock/getrequest
//        ← OK
//   4. Device acks a command (stub)
//        → POST /iclock/devicecmd
//        ← OK

import { createServer } from "http";
import { logger, describeError } from "./logger.js";
import { recordDeviceContact, recordHandshakeParams } from "./heartbeat.js";

/**
 * Parse the tab-delimited ATTLOG body the device pushes.
 *
 * Each non-empty line:  PIN\tDateTime\tStatus\tVerify\tWorkCode\tReserved
 * e.g.  8\t2026-08-06 14:05:23\t255\t1\t0
 *
 * CONFIRMED against a real push from this device (previous version of this
 * function had DateTime and Status swapped, i.e. assumed
 * PIN\tVerified\tDateTime\tStatus\tWorkCode). Proof: the real device's
 * second field parsed as a plausible verify-mode/status value while the
 * THIRD field's leading digits, read as an integer, equalled the current
 * year — that integer can only come from parsing a real datetime string
 * ("2026-08-06...") that had landed in the wrong slot. The corrected order
 * matches the standard, widely-documented ZKTeco/ESSL ADMS ATTLOG format.
 * The bug corrupted every stored punchTimestamp (e.g. produced year 255
 * instead of 2026) — real historical rows written before this fix need a
 * one-time manual correction/removal on the backend, not something this
 * agent can retroactively fix.
 *
 * Status is a known-unreliable field on budget ESSL/ZK firmware — some
 * devices can't distinguish check-in from check-out and send a sentinel
 * (0xFF = 255 is a common "unset byte" convention) instead of a real 0-5
 * code. Only trust it when it's one of the documented small values.
 */
function parseAttLog(body) {
  const records = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\t");
    // Need at least PIN + DateTime
    if (parts.length < 2) continue;
    const [pin, dateTime, status, verify, workCode] = parts;
    const dt = dateTime?.trim();
    if (!dt || !pin?.trim()) continue;
    const statusCode = parseInt(status ?? "", 10);
    records.push({
      pin:       pin.trim(),
      dateTime:  dt,                                   // "YYYY-MM-DD HH:MM:SS" (device local time)
      status:    Number.isNaN(statusCode) ? null : statusCode, // 0=in,1=out,2=break-out,3=break-in,4=OT-in,5=OT-out — null if not a recognized code (e.g. this device's 255 sentinel)
      verify:    parseInt(verify ?? "0", 10) || 0,      // verify mode: 0=password,1=fingerprint,2=card,15=face...
      workCode:  workCode?.trim() ?? "0",
    });
  }
  return records;
}

/**
 * Build the handshake response body.
 *
 * ATTLOGStamp (Unix seconds) tells the device "only send me records with a
 * timestamp strictly greater than this value." Setting it to the last
 * timestamp we successfully pushed means the device does the deduplication
 * for us at the protocol level — we never receive the full accumulated log
 * on every heartbeat, even when the device first reconnects after a long gap.
 *
 * \r\n line endings are required by the ADMS spec.
 */
// TransTimes controls when the device performs its SCHEDULED bulk-backlog
// transmission — a separate mechanism from Realtime=1 (which only covers
// brand-new events as they happen). The original value here, `00:00;14:05`,
// was almost certainly unreviewed boilerplate (it matches generic ADMS
// reference-implementation sample values seen elsewhere) — and it produced
// a real, confirmed symptom: after a full watermark reset (ATTLOGStamp=0,
// i.e. "send me your entire history"), the device correctly handshook but
// then sent nothing at all, because the current time wasn't one of those
// two narrow daily windows. Every hour on the hour instead of two arbitrary
// fixed times, so a full-backlog catch-up is never more than ~1h away
// regardless of when the agent's watermark gets reset. Realtime single
// punches were never affected by this — they already worked correctly
// under the old value too, since Realtime=1 is the mechanism for those.
const HOURLY_TRANS_TIMES = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}:00`).join(";");

function buildHandshakeBody(sn, lastTimestampUnixSec) {
  const stamp = lastTimestampUnixSec ?? 0;
  return [
    `GET OPTION FROM:${sn}`,
    `ATTLOGStamp=${stamp}`,
    // Operator logs: enrollments, deletions and user edits performed ON the
    // terminal, plus the USERINFO records that carry PIN -> name. This is the
    // only remote view of what the device actually holds; HRMS otherwise
    // matches punches against a hand-typed code with no way to know the device
    // disagrees, which is what made attendance appear to shift unpredictably.
    //
    // Was `9999`, which claims "already current" and suppresses them entirely.
    // 0 asks for the full history once -- deliberately, because the backlog IS
    // the evidence of who moved slots and when. Operator logs are low volume
    // next to attendance, so this is a one-off catch-up, not a flood.
    //
    // RISK, and why this is called out rather than buried: changing a stamp on
    // this device has stopped data before. A previous ATTLOGStamp reset left it
    // handshaking correctly and then sending NOTHING, because TransTimes only
    // had two narrow daily windows. That specific cause is fixed (hourly
    // TransTimes below), and OPERLOGStamp is a different channel from ATTLOG --
    // but the precedent is real. After deploying, confirm punches still arrive.
    // Reverting is a one-line change: the agent auto-updates within 15 minutes.
    `OPERLOGStamp=0`,
    `ATTPHOTOStamp=None`,    // not syncing photos
    `ErrorDelay=30`,
    `Delay=10`,
    `TransTimes=${HOURLY_TRANS_TIMES}`,
    `TransInterval=1`,
    `TransFlag=1111000000`,
    `Realtime=1`,            // push punches in real-time, don't batch
    `Encrypt=None`,
  ].join("\r\n");
}

/**
 * Create and start the ADMS HTTP server.
 *
 * @param {object} opts
 * @param {number}   opts.port                 - TCP port to listen on (e.g. 7788)
 * @param {Function} opts.onPunchBatch         - async (records, sn) => void
 *                                               called with the parsed records array
 * @param {Function} opts.getLastSyncedUnixSec - () => number
 *                                               returns the last-synced Unix timestamp in
 *                                               seconds, used for the ATTLOGStamp handshake
 * @param {Function} [opts.onDeviceEvent]      - async (tableName, rawBody, sn) => void
 *                                               called for every NON-ATTLOG table the device
 *                                               pushes (OPERLOG, USERINFO, ...). Optional:
 *                                               if omitted the payload is acked and dropped,
 *                                               exactly as before.
 */
export function startAdmsServer({ port, onPunchBatch, getLastSyncedUnixSec, onDeviceEvent }) {
  const server = createServer((req, res) => {
    const rawUrl = req.url ?? "/";
    const url = new URL(rawUrl, "http://localhost");
    // Some eSSL firmware variants append .aspx to every path
    // (e.g. /iclock/cdata.aspx). Strip it so one set of handlers covers both.
    const pathname = url.pathname.replace(/\.aspx$/i, "");
    // Case-insensitive param lookup: URLSearchParams.get() is exact-case on
    // the param NAME (not just the value), and different eSSL firmware
    // variants have already shown they don't consistently match the "usual"
    // casing (see the .aspx path quirk above) — a device sending `Table=`
    // instead of `table=` would otherwise silently fall through every route
    // match below with zero indication why.
    const getParamCI = (name) => {
      for (const [key, value] of url.searchParams) {
        if (key.toLowerCase() === name.toLowerCase()) return value;
      }
      return null;
    };
    const sn    = getParamCI("SN")    ?? "unknown";
    const table = getParamCI("table") ?? "";

    // ANY request from the device counts as proof it's alive and on the
    // network — recorded before routing so even an unhandled endpoint still
    // updates liveness. This is what distinguishes "device is unplugged"
    // from "agent is down" on the dashboard.
    recordDeviceContact(sn);

    // Capture whatever this request reveals about the device. Done for every
    // request, not just the handshake: this firmware handshakes on connect and
    // then only POSTs data, so a handshake-only capture is lost on every agent
    // restart and does not come back until the device reconnects. Merged
    // upstream, so a sparse punch POST cannot overwrite richer handshake data.
    recordHandshakeParams(Object.fromEntries(url.searchParams));

    // ── Device heartbeat / handshake ──────────────────────────────────────
    if (req.method === "GET" && pathname === "/iclock/cdata") {
      // The device announces itself most fully here — firmware version,
      // push-protocol version, capabilities. Those values are captured above,
      // for every request rather than only this one, because this firmware
      // handshakes on connect and then stops.
      const stamp = getLastSyncedUnixSec();
      const body  = buildHandshakeBody(sn, stamp);
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(body);
      logger.info(`ADMS handshake  SN=${sn}  ATTLOGStamp=${stamp}`);
      return;
    }

    // ── Data push (ATTLOG = punches; OPERLOG/others = acked, not stored) ──
    // Must accept EVERY table the device pushes, not just ATTLOG. Returning
    // 404 for OPERLOG made the device re-POST the identical operator log
    // every ~5 seconds forever (confirmed in real logs) — the firmware
    // retries until it gets a 2xx. We only parse ATTLOG; anything else is
    // acknowledged so the device clears it from its queue and moves on.
    if (req.method === "POST" && pathname === "/iclock/cdata") {
      let rawBody = "";
      req.on("data", (chunk) => { rawBody += chunk.toString(); });
      req.on("end", async () => {
        const tableName = table.toUpperCase();

        if (tableName !== "ATTLOG") {
          // OPERLOG (operator actions on the device — enrollments, deletions,
          // edits), USERINFO (its user list), ATTPHOTO, etc.
          //
          // These used to be acked and discarded. They are in fact the only
          // record of who is enrolled on the terminal and what changed, which
          // is what HRMS needs to explain PINs/slots moving under people — so
          // they are now forwarded upstream.
          //
          // The ack is UNCONDITIONAL and happens whether forwarding works or
          // not. Returning a non-2xx makes this firmware re-POST the identical
          // body every ~5 seconds forever (confirmed in real logs), so a
          // backend hiccup must never be allowed to turn into a retry storm
          // against a device whose comm stack is already fragile. Losing one
          // event row is far cheaper than that.
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("OK: 0");

          if (typeof onDeviceEvent === "function" && rawBody) {
            // Deliberately not awaited: the device already has its answer, and
            // nothing about this path should hold the socket open.
            Promise.resolve(onDeviceEvent(tableName, rawBody, sn)).catch((err) => {
              logger.warn(`Device event forward failed (${tableName}): ${describeError(err)}`);
            });
          } else {
            logger.info(`ADMS ${tableName || "(no table)"}  SN=${sn}  acknowledged (not forwarded).`);
          }
          return;
        }

        const records = parseAttLog(rawBody);

        if (records.length === 0) {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("OK: 0");
          return;
        }

        logger.info(`ADMS ATTLOG  SN=${sn}  ${records.length} record(s) received.`);

        try {
          await onPunchBatch(records, sn);
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end(`OK: ${records.length}`);
        } catch (err) {
          logger.error(`Failed to process ADMS punch batch SN=${sn}: ${describeError(err)}`);
          // Always respond OK — a non-2xx response causes some firmware
          // versions to retry the exact same batch in a tight loop. Our own
          // watermark ensures we don't double-count the records on the next
          // successful push, so responding OK here is safe.
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("OK: 0");
        }
      });
      return;
    }

    // ── Device polls for pending commands ─────────────────────────────────
    // Future: push-based user enrollment via ADMS commands. For now, user
    // sync still goes over ZK TCP (setUser / deleteUser), so we just ack
    // with no pending commands.
    if (req.method === "GET" && pathname === "/iclock/getrequest") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("OK");
      return;
    }

    // ── Device acks a command we sent ─────────────────────────────────────
    if (req.method === "POST" && pathname === "/iclock/devicecmd") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("OK");
      return;
    }

    // ── Unknown endpoint ──────────────────────────────────────────────────
    // Log the FULL raw request (path with its original query string, before
    // any parsing/assumptions) — the previous version only logged the
    // already-parsed pathname, which stayed identical whether the .aspx
    // stripping fix worked or not, and gave no visibility into *why* a
    // request that looked like a real ATTLOG push (POST /iclock/cdata)
    // still fell through here (most likely cause: this firmware sends the
    // table param under different casing, e.g. `Table=ATTLOG` — query
    // param NAMES are case-sensitive in URLSearchParams.get()).
    logger.warn(
      `ADMS: unrecognised ${req.method} ${rawUrl} from SN=${sn} — ` +
      `parsedPathname=${pathname} allParams=${JSON.stringify(Object.fromEntries(url.searchParams))}`
    );
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  server.on("error", (err) => {
    logger.error(`ADMS server error: ${describeError(err)}`);
  });

  server.listen(port, () => {
    logger.info(
      `ADMS push server listening on :${port} — ` +
      `set device Cloud Server → Server Address to this machine's LAN IP, port ${port}`
    );
  });

  return server;
}
