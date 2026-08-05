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

/**
 * Parse the tab-delimited ATTLOG body the device pushes.
 * Each non-empty line:  PIN\tVerified\tDateTime\tStatus\tWorkCode\tReserved
 * e.g.  1001\t1\t2026-08-05 08:30:00\t0\t0\t0
 *
 * Returns an array of parsed record objects.
 */
function parseAttLog(body) {
  const records = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\t");
    // Need at least PIN + Verified + DateTime
    if (parts.length < 3) continue;
    const [pin, verified, dateTime, status, workCode] = parts;
    const dt = dateTime?.trim();
    if (!dt || !pin?.trim()) continue;
    records.push({
      pin:      pin.trim(),
      verified: parseInt(verified ?? "0", 10),
      dateTime: dt,                           // "YYYY-MM-DD HH:MM:SS" (device local time)
      status:   parseInt(status ?? "0", 10),  // 0=in, 1=out, 4=overtime-in, etc.
      workCode: workCode?.trim() ?? "0",
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
function buildHandshakeBody(sn, lastTimestampUnixSec) {
  const stamp = lastTimestampUnixSec ?? 0;
  return [
    `GET OPTION FROM:${sn}`,
    `ATTLOGStamp=${stamp}`,
    `OPERLOGStamp=9999`,     // not syncing operator logs
    `ATTPHOTOStamp=None`,    // not syncing photos
    `ErrorDelay=30`,
    `Delay=10`,
    `TransTimes=00:00;14:05`,
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
 */
export function startAdmsServer({ port, onPunchBatch, getLastSyncedUnixSec }) {
  const server = createServer((req, res) => {
    const rawUrl = req.url ?? "/";
    const url = new URL(rawUrl, "http://localhost");
    // Some eSSL firmware variants append .aspx to every path
    // (e.g. /iclock/cdata.aspx). Strip it so one set of handlers covers both.
    const pathname = url.pathname.replace(/\.aspx$/i, "");
    const sn    = url.searchParams.get("SN")    ?? "unknown";
    const table = url.searchParams.get("table") ?? "";

    // ── Device heartbeat / handshake ──────────────────────────────────────
    if (req.method === "GET" && pathname === "/iclock/cdata") {
      const stamp = getLastSyncedUnixSec();
      const body  = buildHandshakeBody(sn, stamp);
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(body);
      logger.info(`ADMS handshake  SN=${sn}  ATTLOGStamp=${stamp}`);
      return;
    }

    // ── Attendance record push ────────────────────────────────────────────
    if (req.method === "POST" && pathname === "/iclock/cdata" && table.toUpperCase() === "ATTLOG") {
      let rawBody = "";
      req.on("data", (chunk) => { rawBody += chunk.toString(); });
      req.on("end", async () => {
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
    logger.warn(`ADMS: unrecognised ${req.method} ${pathname} from SN=${sn}`);
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
