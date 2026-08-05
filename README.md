# IronMart Biometric Agent

Standalone agent that runs on the office LAN (same network as the ESSL K30
biometric device) and bridges it to the IronMart HRMS backend over HTTPS:

1. **Punch sync** — polls the device for attendance logs and pushes new
   punches to the HRMS backend.
2. **Device user enrollment sync** — pulls a queue of "enroll / update /
   remove this employee" jobs from the HRMS backend and applies them to the
   device directly, so an HR admin never has to touch the device by hand
   after setting an employee's Biometric Device Code in the app.

**This does not run on the VPS.** The VPS's Docker Compose stack has no
route to the device's private LAN address (e.g. `192.168.1.201`) — the
whole point of this agent is to run on a machine that's actually on that
LAN (a spare PC, a small always-on box, a Raspberry Pi) and talk to the
backend outbound, never the other way around.

This repo was split out of the main `ironmart` monorepo's `biometric-agent/`
directory (with history preserved via `git subtree split`) so it can be
cloned, configured, and updated independently on office hardware without
carrying the entire HRMS codebase along with it.

---

## Table of contents

- [How it works](#how-it-works)
- [Quick start (running directly with Node)](#quick-start-running-directly-with-node)
- [Running with Docker](#running-with-docker)
- [Environment variables](#environment-variables)
- [Device user enrollment sync](#device-user-enrollment-sync)
- [Linux / Raspberry Pi setup (start on boot + auto-update)](#linux--raspberry-pi-setup-start-on-boot--auto-update)
- [Windows setup (start on boot + auto-update)](#windows-setup-start-on-boot--auto-update)
- [How auto-update works](#how-auto-update-works)
- [What happens when the device is unreachable / not synced](#what-happens-when-the-device-is-unreachable--not-synced)
- [Logs & troubleshooting](#logs--troubleshooting)
- [Known limitations](#known-limitations)

---

## How it works

Every `POLL_INTERVAL_MINUTES` (default 5), the agent runs one cycle that does
two independent things against the device, back to back:

**1. Punch sync**
- Connects to the device via [`zkteco-js`](https://www.npmjs.com/package/zkteco-js) and fetches its attendance log (`getAttendances()`).
- Filters out anything already pushed, tracked via a local `state.json` watermark (`lastSyncedTimestamp`) — a restart never re-pushes old punches.
- POSTs new punches to `VPS_INGEST_URL` (`POST /api/v1/attendance/device-logs/ingest`) with a bearer token.
- Only advances the watermark after a **confirmed successful push** — a failed push retries the same window on the next poll. The backend also dedupes by `(deviceId, punchTimestamp)`, so an occasional re-push after a crash mid-request is harmless, never a duplicate attendance record.

**2. Device user enrollment sync**
- Fetches any `Pending` jobs from `GET {backend}/attendance/device-users/pending`.
- For each job, connects to the device and applies it (enroll/update via `setUser`, remove via `deleteUser`).
- Acks each job back to the backend (`Synced` or `Failed` with a real error message) so the HRMS UI's "Device User Sync" panel (Attendance → Device Sync) always reflects the true state, not a guess.

See [Device user enrollment sync](#device-user-enrollment-sync) below for the full detail, and [What happens when the device is unreachable](#what-happens-when-the-device-is-unreachable--not-synced) for exactly how failures are handled — nothing here is silent.

---

## Quick start (running directly with Node)

```bash
git clone https://github.com/shreyanshagrawal/ironmart-biometric-agent.git
cd ironmart-biometric-agent
cp .env.example .env
# edit .env: real device IP, the VPS ingest URL, and the shared token
npm install
npm start
# equivalent to: node --env-file=.env src/index.js
```

`src/index.js` reads config purely from `process.env` — it does **not** load `.env` on its own (no `dotenv`, no implicit loading). `--env-file=.env` (Node 20.6+) is what actually gets those variables into the process; running plain `node src/index.js` will fail immediately with `VPS_INGEST_URL is required` / `DEVICE_AGENT_TOKEN is required` even with a correctly-filled-in `.env` sitting right next to it — `npm start` already has the flag baked in via `package.json`, so prefer it over calling `node` directly unless you have a reason not to.

This runs in the foreground — fine for testing, but you'll want it running
as a real service that survives a reboot. See the platform-specific setup
sections below.

## Running with Docker

```bash
cp .env.example .env
docker build -t ironmart-biometric-agent .
docker run -d --name ironmart-biometric-agent \
  --restart unless-stopped \
  --env-file .env \
  -v "$(pwd)/data:/app/data" \
  ironmart-biometric-agent
```

The `-v ./data:/app/data` mount is what makes `state.json` survive a
container restart — without it, a restart just re-syncs the device's
current full punch log once (harmless, but noisier than necessary).

**Note:** the git-based auto-update mechanism described below (`scripts/update.sh`/`.ps1`) is built for a direct Node.js install (it does a `git pull` inside the running checkout) and is **not** wired up for the Docker path — a container image needs a registry + something like [Watchtower](https://containrrr.dev/watchtower/) to auto-update, which wasn't part of what this pass built. If you want auto-updating Docker deployment, that's a real, separate follow-up — flagging it here rather than pretending Docker gets it for free.

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `ESSL_DEVICE_IP` | No (default `192.168.1.201`) | The device's LAN IP |
| `ESSL_DEVICE_PORT` | No (default `4370`) | The device's port |
| `ESSL_DEVICE_TIMEOUT_MS` | No (default `20000`) | How long to wait for the device to respond before timing out a request — raise this if you see `TIMEOUT_IN_RECEIVING_RESPONSE_AFTER_REQUESTING_DATA` in the logs |
| `VPS_INGEST_URL` | **Yes** | Full URL to the backend's punch-log ingest endpoint, e.g. `https://hrms.example.com/api/v1/attendance/device-logs/ingest` |
| `DEVICE_AGENT_TOKEN` | **Yes** | Shared secret — must match the backend's `DEVICE_AGENT_TOKEN` env var exactly |
| `POLL_INTERVAL_MINUTES` | No (default `5`) | How often to run a full sync cycle |
| `LOG_DIR` | No (default `./logs`) | Where `agent.log` is written |
| `STATE_FILE_PATH` | No (default `./state.json`) | Where the punch-sync watermark is persisted |

The device-user-sync endpoints are derived automatically from `VPS_INGEST_URL` (stripping the trailing `/attendance/device-logs/ingest`) — no separate URL to configure.

---

## Device user enrollment sync

**Why this exists**: before this, enrolling a new employee on the physical device meant someone walking up to it and typing their details in on its own keypad/screen — a real, easy-to-forget manual step disconnected from the actual HR system of record. Now, setting (or changing, or clearing) an employee's **Biometric Device Code** field in the HRMS app is enough — the agent picks up the change and applies it to the device automatically, next time it polls.

**Flow**:
1. In HRMS, HR sets/changes/clears an employee's `biometricDeviceCode` (Employee create/edit, or the "Sync to Device" action on Attendance → Device Sync). The backend enqueues a `device_user_sync_jobs` row (`Create`/`Update`/`Disable`, status `Pending`).
2. On its next poll, this agent fetches all `Pending` jobs (`GET /attendance/device-users/pending`).
3. For each job:
   - **Create/Update**: connects to the device, calls `getUsers()` to check whether that `biometricDeviceCode` is already enrolled at some internal device slot (`uid`) — if so, reuses that slot (an update); if not, allocates the lowest free slot in the device's valid `1–3000` range (a new enrollment). Calls `setUser(uid, userid, name, ...)`.
   - **Disable**: calls `deleteUser(uid)` for that employee's slot, if one exists. If the employee was never actually enrolled on the device, this is an honest no-op — nothing to remove.
4. Acks the job back to the backend as `Synced`, or `Failed` with the real error message if anything went wrong (device unreachable, an out-of-range uid, etc.) — visible on the HRMS "Device User Sync" panel, not silently swallowed.

**Why a queue, not a direct call**: the backend (on the VPS) has no network route to the device's office-LAN address, so it can never call the device directly — only this agent, which is actually on that LAN, can. The queue is what lets HR's action in the app ("save this employee") and the agent's next poll (whenever that is) stay decoupled and eventually consistent, instead of the HR save itself blocking on network reachability to a device it can't even see.

**Caveat, stated plainly**: the underlying `zkteco-js` library's `setUser`/`deleteUser` implementation has been code-reviewed (its wire format matches the ZKTeco protocol documentation and the shape the older, read-only `node-zklib` library already used successfully for `getAttendances()`), and the pure job-processing logic around it (uid allocation/reuse, ack handling, failure handling) has been verified with a fully mocked test device — but **it has not yet been exercised against a real, physical K30**. The first real enrollment/removal on live hardware is worth watching closely (check the HRMS Device User Sync panel and this agent's logs) rather than assumed correct on faith.

---

## Linux / Raspberry Pi setup (start on boot + auto-update)

This is the recommended setup for an always-on office box (including a
Raspberry Pi) — two `systemd` units: one runs the agent itself, the other
checks for updates on a timer and restarts the first one if it finds any.

```bash
# 1. Clone somewhere permanent and install a Node.js LTS if you don't have one
sudo mkdir -p /opt/ironmart-biometric-agent
sudo chown "$USER" /opt/ironmart-biometric-agent
git clone https://github.com/shreyanshagrawal/ironmart-biometric-agent.git /opt/ironmart-biometric-agent
cd /opt/ironmart-biometric-agent
cp .env.example .env
nano .env   # fill in the real device IP, VPS URL, and shared token
npm install

# 2. Create a dedicated, unprivileged service user (don't run this as root)
sudo useradd --system --home /opt/ironmart-biometric-agent --shell /usr/sbin/nologin ironmart
sudo chown -R ironmart:ironmart /opt/ironmart-biometric-agent

# 3. Install the systemd units
sudo cp deploy/systemd/ironmart-biometric-agent.service /etc/systemd/system/
sudo cp deploy/systemd/ironmart-biometric-agent-updater.service /etc/systemd/system/
sudo cp deploy/systemd/ironmart-biometric-agent-updater.timer /etc/systemd/system/

# 4. Grant the "ironmart" user permission to restart just its own service
#    (needed by the updater — see the comment inside the sudoers file)
sudo cp deploy/systemd/ironmart-agent-sudoers /etc/sudoers.d/ironmart-agent
sudo chmod 440 /etc/sudoers.d/ironmart-agent

# 5. Enable + start everything
sudo systemctl daemon-reload
sudo systemctl enable --now ironmart-biometric-agent.service
sudo systemctl enable --now ironmart-biometric-agent-updater.timer

# 6. Verify
sudo systemctl status ironmart-biometric-agent.service
sudo journalctl -u ironmart-biometric-agent -f       # live logs
sudo systemctl list-timers ironmart-biometric-agent-updater.timer
```

That's it — the agent now:
- **Starts automatically on boot** (`WantedBy=multi-user.target`, no login required — works headless, e.g. on a Pi with no monitor attached).
- **Restarts automatically if it crashes** (`Restart=on-failure`, capped at 5 restarts per 5 minutes so a genuinely broken config doesn't spin forever).
- **Auto-updates**: the updater timer fires 2 minutes after boot and then every 15 minutes, runs `scripts/update.sh` (see [How auto-update works](#how-auto-update-works)), and restarts the main service only if a new commit was actually pulled.

**If your device IP or one of the other env vars changes later**: edit `/opt/ironmart-biometric-agent/.env` directly, then `sudo systemctl restart ironmart-biometric-agent.service` — no reinstall needed.

---

## Windows setup (start on boot + auto-update)

Two options — pick one for how the agent itself runs. Either way, the
updater is a Scheduled Task, since Windows Services can't easily `git pull`
and restart themselves.

### Option A — Task Scheduler only (no extra download, simplest)

```powershell
git clone https://github.com/shreyanshagrawal/ironmart-biometric-agent.git C:\ironmart-biometric-agent
cd C:\ironmart-biometric-agent
copy .env.example .env
notepad .env   # fill in the real device IP, VPS URL, and shared token
npm install

# From an elevated ("Run as Administrator") PowerShell prompt:
powershell -ExecutionPolicy Bypass -File deploy\windows\install-tasks.ps1
```

This registers **both** the agent and its updater as Scheduled Tasks that
trigger `AtStartup`, running as `SYSTEM` (so it starts with no user logged
in). The agent task is configured to restart itself automatically if it
exits (`RestartCount 999`, retried every minute).

### Option B — a real Windows Service via NSSM (more robust)

Use this if you want the agent to behave like a true Windows Service —
starts before any user session exists, restarts the instant it crashes
rather than waiting for Task Scheduler's own retry cadence.

```powershell
# Download nssm.exe (win64 build) from https://nssm.cc/download and place
# it in the repo root (C:\ironmart-biometric-agent\nssm.exe), then:
powershell -ExecutionPolicy Bypass -File deploy\windows\install-nssm-service.ps1

# Still need the updater task separately — it works with either setup:
powershell -ExecutionPolicy Bypass -File deploy\windows\install-updater-task.ps1
```

### Verifying either option

```powershell
Get-ScheduledTask -TaskName IronMartBiometricAgent | Get-ScheduledTaskInfo
# or, for the NSSM path:
Get-Service IronMartBiometricAgent

Get-Content C:\ironmart-biometric-agent\logs\agent.log -Tail 20 -Wait
```

---

## How auto-update works

Both this repo's own machine (LAN-bound, no inbound reachability) and the
HRMS VPS need to "auto-update as soon as code is pushed to git," but they
use **different mechanisms** because they have different network positions:

- **The VPS** is reachable from GitHub's runners, so it uses a real
  push-triggered **GitHub Actions workflow** (in the main `ironmart` repo:
  `.github/workflows/deploy.yml`) that SSHes in and runs `git pull` +
  `docker compose up -d --build` the moment `main` is pushed. Genuinely
  event-driven, near-instant.
- **This agent** runs on an office LAN machine with no public IP and no
  inbound port forwarding — GitHub has no way to reach it, so a webhook
  can't work here. Instead, `scripts/update.sh` (Linux) / `scripts/update.ps1`
  (Windows) run **on a timer** (every 15 minutes, via the systemd timer or
  Scheduled Task set up above): `git fetch`, compare the local commit
  against `origin/main`, and if they differ:
  1. Refuse to proceed if the local working tree has uncommitted changes (never silently discard someone's manual edit on the box).
  2. `git pull --ff-only`.
  3. `npm install`, but **only** if `package.json`/`package-lock.json` actually changed in the new commit(s) — otherwise skipped, so most update checks are fast and don't depend on npm's registry being reachable.
  4. Restart the agent (via `systemctl restart` on Linux, or `Restart-Service`/`Stop+Start-ScheduledTask` on Windows, whichever the box is actually running).

This means a push to this repo's `main` branch takes up to 15 minutes to
reach a given office machine — a deliberate, honest tradeoff for a device
with no inbound reachability, not a bug. If you need it faster, lower
`OnUnitActiveSec`/`RepetitionInterval` in the timer/task — there's no
technical floor, just more frequent `git fetch` calls.

---

## What happens when the device is unreachable / not synced

This section exists because "what happens when the biometric device is
offline" is exactly the kind of question that's easy to leave undocumented
and then discover the hard way during an actual outage. Here's precisely
what happens, for both halves of what this agent does:

### Punch sync

- A failed poll (device off, network down, wrong IP, etc.) throws inside `syncPunchLogs()`. The watermark (`state.json`'s `lastSyncedTimestamp`) is **only ever advanced after a confirmed successful push** — so a failed poll changes nothing on disk, and the *next* successful poll automatically picks up everything since the last real success. **No punches are ever lost from a temporary outage** — the device itself keeps recording them internally regardless of whether this agent can reach it right now; this agent is just a periodic courier, not the system of record.
- `consecutiveFailures` increments on every failed poll (regardless of which half — punch sync or user sync — failed) and resets to 0 on the next fully successful one.
- After **3 consecutive failed polls**, a single escalated `WARN`-level log line fires (not on every failure — that would just be noise): it explicitly states punches are *not* lost and explains why, then flags that it's worth physically checking the device/network if it doesn't self-recover. It does **not** re-fire on every subsequent failure — only once per outage, when it crosses that threshold; a fresh success resets the counter so a *later* outage gets its own warning.
- A successful poll after 1+ failures logs a plain "Device reachable again after N failed poll(s)" info line, so the log has a clear recovery marker too, not just the failure side.

### Device user enrollment sync

- If the agent can't even **connect** to the device this cycle, every job that was fetched as `Pending` for that cycle is acked back to the backend as `Failed` with a clear reason (e.g. `"Device connection failed: ..."`) — visible immediately on the HRMS "Device User Sync" panel, not left silently stuck in `Pending` with no explanation.
- Because the backend only ever marks a job `Synced` on a real, confirmed ack, a `Failed` job is **not** lost — HR can just click "Sync to Device" again from the HRMS UI once the device is back, which re-enqueues a fresh `Pending` job the agent will pick up on its next successful cycle. (There's currently no automatic retry-forever on a `Failed` job — a deliberate choice, since an indefinitely-retrying job for, say, a bad/duplicate device code would otherwise fail silently forever with no human ever told to fix the underlying data.)
- If the device connects fine but one *specific* job fails (e.g. an invalid uid, a malformed employee code), only that job is acked `Failed` with its own real error — the rest of the batch still proceeds normally.

### In short

Nothing about a device outage or a desync is silent: every failure either shows up as a clearly-labeled `Failed` job in the HRMS UI, or as an escalated warning in this agent's own log after 3 consecutive misses — and nothing is ever lost, only delayed, since both the device's own internal punch log and the backend's job queue are the real sources of truth, not this agent's in-memory state.

---

## Logs & troubleshooting

- **Log file**: `logs/agent.log` inside the repo (or `$LOG_DIR` if overridden) — every poll's punch-sync and device-user-sync summary, plus every failure with its real error message.
- **Linux**: `sudo journalctl -u ironmart-biometric-agent -f` for live output (the same lines, also mirrored to the systemd journal); `sudo journalctl -u ironmart-biometric-agent-updater` to see the update-check history.
- **Windows**: `Get-Content logs\agent.log -Tail 50 -Wait`; for the NSSM path, also `logs\service-stdout.log`/`service-stderr.log`.
- **In the HRMS app**: Attendance → Device Sync shows both the punch-sync history (Sync Execution Log) and the device-user-sync job queue (Device User Sync), including any `Failed` job's real error message — check there first before diving into raw log files.
- **"Nothing is syncing at all"**: check `DEVICE_AGENT_TOKEN` matches the backend's exactly (a mismatch 401s every request, which shows as a connection-shaped failure in this agent's logs even though the device itself is fine) — this is the most common misconfiguration.

---

## Known limitations

- The device-user-sync feature (enroll/update/remove on the physical device) has been verified via code review and a fully mocked test, but **not yet against real ESSL K30 hardware** — see the caveat in [Device user enrollment sync](#device-user-enrollment-sync).
- Punch sync (`getAttendances()`) has been running in production against real hardware since before this repo was split out — only the newer enrollment-sync half carries the caveat above.
- Docker deployment has no wired auto-update mechanism (see the note under [Running with Docker](#running-with-docker)).
- Auto-update polls on a fixed interval (default 15 min), not instantly on push — an accepted tradeoff for a device with no inbound network reachability, not a bug.
- **Confirmed real bug in the upstream `zkteco-js` library** (found against real hardware, not theoretical): `readWithBuffer` in its `src/ztcp.js` calls `reject(err)` on a device timeout but is missing a `return` statement afterward, so it falls through into `decodeTCPHeader(reply.subarray(...))` with `reply` still `null`. That throw happens inside an unawaited async Promise executor, which Node treats as an unhandled rejection and — by default — kills the whole process over, regardless of the fact that this agent's own code already correctly receives and handles the *real* rejection via the normal `try/catch` in `runOnce()`. **Mitigated here**: `src/index.js` installs `process.on("unhandledRejection", ...)`/`process.on("uncaughtException", ...)` handlers specifically so this one well-understood, externally-caused failure mode can't take the whole agent down — it's logged and the agent keeps polling normally, exactly as if it had been a clean rejection. If you see `TIMEOUT_IN_RECEIVING_RESPONSE_AFTER_REQUESTING_DATA` in the logs immediately followed by "Unhandled promise rejection... agent continues running," that's this — the underlying timeout itself is usually a device/network issue (see `ESSL_DEVICE_TIMEOUT_MS` below), not something this agent did wrong.
- `ESSL_DEVICE_TIMEOUT_MS` (default `20000`, was a hardcoded `10000` before real-hardware testing showed it too tight for some networks/device log sizes) — raise it further if timeouts persist on a slow LAN link.
