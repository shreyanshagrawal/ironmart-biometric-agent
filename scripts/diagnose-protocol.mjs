// Raw TCP diagnostic — bypasses zkteco-js/node-zklib entirely, so nothing
// about either library's own internal buffering, timing, or wrapper-parsing
// assumptions can muddy what we actually see. Connects directly, sends a
// CMD_CONNECT then a CMD_GET_FREE_SIZES using the exact same wire format
// zkteco-js builds (createTCPHeader), and logs every single 'data' event
// separately with its own timestamp and hex dump — no accumulation, no
// interpretation, just raw ground truth.
//
// Usage: node scripts/diagnose-protocol.mjs [ip] [port]
// Defaults to reading ESSL_DEVICE_IP/ESSL_DEVICE_PORT from .env if present.
import net from "net";
import { readFileSync, existsSync } from "fs";

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

// --- exact same wire-format builder zkteco-js/node-zklib use internally ---
const USHRT_MAX = 65535;

function createChkSum(buf) {
  let chksum = 0;
  for (let i = 0; i < buf.length; i += 2) {
    if (i === buf.length - 1) {
      chksum += buf[i];
    } else {
      chksum += buf.readUInt16LE(i);
    }
    chksum %= USHRT_MAX;
  }
  chksum = USHRT_MAX - chksum - 1;
  return chksum;
}

function createTCPHeader(command, sessionId, replyId, data) {
  const dataBuffer = Buffer.from(data);
  const buf = Buffer.alloc(8 + dataBuffer.length);
  buf.writeUInt16LE(command, 0);
  buf.writeUInt16LE(0, 2);
  buf.writeUInt16LE(sessionId, 4);
  buf.writeUInt16LE(replyId, 6);
  dataBuffer.copy(buf, 8);
  buf.writeUInt16LE(createChkSum(buf), 2);
  const prefixBuf = Buffer.from([0x50, 0x50, 0x82, 0x7d, 0x13, 0x00, 0x00, 0x00]);
  prefixBuf.writeUInt16LE(buf.length, 4);
  return Buffer.concat([prefixBuf, buf]);
}

function hexDump(label, buf) {
  console.log(`[${new Date().toISOString()}] ${label}: length=${buf.length} hex=${buf.toString("hex")}`);
}

const socket = net.createConnection({ host: IP, port: PORT, timeout: 15000 }, () => {
  console.log(`Connected to ${IP}:${PORT}. Sending CMD_CONNECT (1000)...`);
  const connectMsg = createTCPHeader(1000, 0, 0, Buffer.alloc(0));
  hexDump("SENT CMD_CONNECT", connectMsg);
  socket.write(connectMsg);
});

let step = "connect";
let sessionId = 0;
let replyId = 1;

socket.on("data", (data) => {
  hexDump(`RECEIVED (step=${step})`, data);

  if (step === "connect") {
    // Best-effort parse: if it looks like it has the expected wrapper,
    // pull sessionId out of it the way the library would; otherwise fall
    // back to whatever raw bytes we got and try to guess a session id at a
    // couple of plausible offsets, purely for constructing the next request
    // (this is diagnostic-only, not something the real agent relies on).
    let inner = data;
    if (data.length >= 8 && data.compare(Buffer.from([0x50, 0x50, 0x82, 0x7d]), 0, 4, 0, 4) === 0) {
      inner = data.subarray(8);
      console.log("  -> reply DOES have the expected 50 50 82 7d wrapper.");
    } else {
      console.log("  -> reply does NOT start with the expected 50 50 82 7d wrapper.");
    }
    if (inner.length >= 6) {
      sessionId = inner.readUInt16LE(4);
      console.log(`  -> parsed sessionId=${sessionId} (from ${data.compare(Buffer.from([0x50, 0x50, 0x82, 0x7d]), 0, 4, 0, 4) === 0 ? "unwrapped" : "raw"} bytes, offset 4)`);
    } else {
      console.log(`  -> reply too short (${inner.length} bytes) to contain a normal 8-byte packet header at all.`);
    }

    step = "get_free_sizes";
    setTimeout(() => {
      console.log("\nSending CMD_GET_FREE_SIZES (50)...");
      const msg = createTCPHeader(50, sessionId, replyId, Buffer.alloc(0));
      hexDump("SENT CMD_GET_FREE_SIZES", msg);
      socket.write(msg);
    }, 500);
  } else if (step === "get_free_sizes") {
    console.log("\nGot a second reply. Waiting 3s for any further/delayed bytes before closing...");
    step = "done";
    setTimeout(() => {
      console.log("\nDone. Closing socket.");
      socket.end();
      process.exit(0);
    }, 3000);
  } else {
    console.log("  -> (extra/late data after we considered the exchange done)");
  }
});

socket.on("timeout", () => {
  console.log(`\n[TIMEOUT] No data received within 15s (step=${step}).`);
  socket.destroy();
  process.exit(1);
});

socket.on("error", (err) => {
  console.error(`\n[SOCKET ERROR] ${err.message}`);
  process.exit(1);
});

socket.on("close", () => {
  console.log("Socket closed.");
});
