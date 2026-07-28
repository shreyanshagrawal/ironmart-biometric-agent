import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";

const STATE_FILE = process.env.STATE_FILE_PATH || path.resolve(process.cwd(), "state.json");

// Tracks the last-pushed punch timestamp so a restart never re-pushes
// already-synced logs. The backend also dedupes by (deviceId, punchTimestamp)
// so a duplicate push is harmless, but skipping known-old records keeps
// every poll cheap instead of re-uploading the device's entire log each time.
export function loadState() {
  if (!existsSync(STATE_FILE)) {
    return { lastSyncedTimestamp: null };
  }
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return { lastSyncedTimestamp: null };
  }
}

export function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
