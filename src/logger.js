// Minimal structured logger — writes to both stdout (so `journalctl`/Task
// Scheduler's own log capture still works) and a real log file (so history
// survives past whatever ring buffer the OS's service manager keeps, and so
// there's something to look at on a machine where nobody's watching the
// console — this agent is meant to run unattended on an office-LAN box).
import { appendFileSync, mkdirSync } from "fs";
import path from "path";

const LOG_DIR = process.env.LOG_DIR || path.resolve(process.cwd(), "logs");
const LOG_FILE = path.join(LOG_DIR, "agent.log");

try {
  mkdirSync(LOG_DIR, { recursive: true });
} catch {
  // Directory already exists or isn't creatable — fall through to
  // console-only logging rather than crashing the agent over a log dir.
}

function write(level, message) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}`;
  // eslint-disable-next-line no-console
  (level === "ERROR" ? console.error : console.log)(line);
  try {
    appendFileSync(LOG_FILE, line + "\n");
  } catch {
    // Disk full / permissions issue — the console line above is still real,
    // don't let a logging failure take down the actual sync work.
  }
}

export const logger = {
  info: (msg) => write("INFO", msg),
  warn: (msg) => write("WARN", msg),
  error: (msg) => write("ERROR", msg),
};

// zkteco-js throws a non-standard error shape in several places (its own
// `ZkError`/`Errors` class in src/exceptions/handler.js does NOT extend the
// native Error class — it's a plain {err, ip, command} object with no
// `.message` of its own, the real message lives at `.err.message`).
// `err.message` on one of these is always undefined, which silently
// produced "Poll failed: undefined" instead of a real reason. This pulls a
// real message out of whatever shape the error actually is.
export function describeError(err) {
  if (!err) return "Unknown error";
  if (typeof err === "string") return err;
  if (err.err?.message) return err.err.message; // zkteco-js's ZkError shape
  if (err.message) return err.message; // a real Error instance
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
