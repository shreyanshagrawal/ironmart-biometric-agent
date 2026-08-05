# IronMart Biometric Agent

Standalone agent that runs on the office LAN (same network as the ESSL K30
biometric device) and bridges it to the IronMart HRMS backend over HTTPS:

1. **Punch sync** — the device pushes attendance logs to this agent over HTTP
   (ADMS push protocol); the agent forwards new punches to the HRMS backend.
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
- [Device configuration (one-time)](#device-configuration-one-time)
- [Device user enrollment sync](#device-user-enrollment-sync)
- [Linux / Raspberry Pi setup (start on boot + auto-update)](#linux--raspberry-pi-setup-start-on-boot--auto-update)
- [Windows setup (start on boot + auto-update)](#windows-setup-start-on-boot--auto-update)
- [How auto-update works](#how-auto-update-works)
- [What happens when the device is unreachable / not synced](#what-happens-when-the-device-is-unreachable--not-synced)
- [Logs & troubleshooting](#logs--troubleshooting)
- [Known limitations](#known-limitations)

---

## How it works

### Punch sync (ADMS push — device calls us)

The ESSL K30 uses the **ADMS push protocol** for punch sync. The device
initiates the connection to this agent's HTTP server — not the other way
around. This is the same protocol eSSL Lite uses, which is why it works
where a ZK TCP pull would time out.

Flow every time the device has a new punch (or reconnects):
1. Device sends `GET /iclock/cdata` — agent responds with `ATTLOGStamp`
   (the Unix timestamp of the last record we already have). The device
   will only push records **newer** than that stamp, so we never receive
   the full accumulated log again after the first sync.
2. Device sends `POST /iclock/cdata?table=ATTLOG` with tab-delimited
   punch lines. Agent parses them, filters any already-synced records
   (belt-and-suspenders on top of the ATTLOGStamp), POSTs new ones to
   `VPS_INGEST_URL`, and advances the watermark only after a confirmed
   successful push.
3. Agent responds `OK: <count>` — device marks those records as delivered.

### Device user enrollment sync (ZK TCP write — agent calls device)

- Fetches any `Pending` jobs from `GET {backend}/attendance/device-users/pending`.
- For each job, connects to the device over ZK TCP and applies it
  (`setUser` for Create/Update, `deleteUser` for Disable).
- Acks each job back to the backend (`Synced` or `Failed` with a real
  error message) so the HRMS UI's "Device User Sync" panel reflects the
  true state, not a guess.

See [Device user enrollment sync](#device-user-enrollment-sync) for full detail.

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

`src/index.js` reads config purely from `process.env` — it does **not** load
`.env` on its own (no `dotenv`, no implicit loading). `--env-file=.env`
(Node 20.6+) is what actually gets those variables into the process; running
plain `node src/index.js` will fail immediately with `VPS_INGEST_URL is
required` / `DEVICE_AGENT_TOKEN is required` even with a correctly-filled-in
`.env` sitting right next to it — `npm start` already has the flag baked in
via `package.json`, so prefer it over calling `node` directly unless you have
a reason not to.

This runs in the foreground — fine for testing, but you'll want it running as
a real service that survives a reboot. See the platform-specific setup sections
below.

After starting the agent, complete the **one-time device configuration** below
so the device knows where to push punches.

## Running with Docker

```bash
cp .env.example .env
docker build -t ironmart-biometric-agent .
docker run -d --name ironmart-biometric-agent \
  --restart unless-stopped \
  --env-file .env \
  -v "$(pwd)/data:/app/data" \
  -p 7788:7788 \
  ironmart-biometric-agent
```

The `-v ./data:/app/data` mount is what makes `state.json` survive a
container restart — without it, a restart just re-syncs the device's
current punch log once (harmless, but noisier than necessary).

The `-p 7788:7788` (or whatever `ADMS_PORT` is) exposes the ADMS server
so the device can reach it.

**Note:** the git-based auto-update mechanism described below
(`scripts/update.sh`/`.ps1`) is built for a direct Node.js install (it
does a `git pull` inside the running checkout) and is **not** wired up for
the Docker path — a container image needs a registry + something like
[Watchtower](https://containrrr.dev/watchtower/) to auto-update. If you
want auto-updating Docker deployment, that's a real, separate follow-up.

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `ESSL_DEVICE_IP` | No (default `192.168.1.201`) | The device's LAN IP — used only for ZK TCP user enrollment writes |
| `ESSL_DEVICE_PORT` | No (default `4370`) | The device's ZK TCP port — used only for user enrollment writes |
| `ESSL_DEVICE_TIMEOUT_MS` | No (default `60000`) | ZK TCP command timeout — only affects `setUser`/`deleteUser`, not punch sync |
| `ADMS_PORT` | No (default `7788`) | Port this agent's ADMS HTTP server listens on — must match the device's Cloud Server port setting |
| `VPS_INGEST_URL` | **Yes** | Full URL to the backend's punch-log ingest endpoint, e.g. `https://hrms.example.com/api/v1/attendance/device-logs/ingest` |
| `DEVICE_AGENT_TOKEN` | **Yes** | Shared secret — must match the backend's `DEVICE_AGENT_TOKEN` env var exactly |
| `POLL_INTERVAL_MINUTES` | No (default `5`) | How often to check for pending device-user enrollment jobs — punch sync is event-driven and ignores this |
| `LOG_DIR` | No (default `./logs`) | Where `agent.log` is written |
| `STATE_FILE_PATH` | No (default `./state.json`) | Where the punch-sync watermark is persisted |

The device-user-sync endpoints are derived automatically from `VPS_INGEST_URL`
(stripping the trailing `/attendance/device-logs/ingest`) — no separate URL
to configure.

---

## Device configuration (one-time)

This is a **one-time manual step** on the physical device. After this, punches
flow automatically without any further device-side changes.

On the K30, go to:
**Menu → Comm. → Cloud Server Settings**

Set the following:

| Field | Value |
|---|---|
| Server Mode | `ADMS` |
| Enable Domain Name | `OFF` |
| Server Address | `<LAN IP of the agent machine>` e.g. `192.168.1.50` |
| Server Port | `7788` (or whatever `ADMS_PORT` is set to) |
| Enable Proxy Server | `OFF` |

Save and exit. The device will connect to the agent immediately and push
any queued punches. You should see `ADMS handshake SN=...` in the agent log
within a few seconds.

**Firewall note (Windows):** the agent machine's Windows Firewall must allow
inbound TCP on the ADMS port. From an elevated PowerShell prompt:

```powershell
New-NetFirewallRule -DisplayName "IronMart Biometric ADMS" `
  -Direction Inbound -Protocol TCP -LocalPort 7788 -Action Allow
```

---

## Device user enrollment sync

**Why this exists**: before this, enrolling a new employee on the physical
device meant someone walking up to it and typing their details in on its own
keypad/screen — a real, easy-to-forget manual step disconnected from the
actual HR system of record. Now, setting (or changing, or clearing) an
employee's **Biometric Device Code** field in the HRMS app is enough — the
agent picks up the change and applies it to the device automatically, next
time it polls.

**Flow**:
1. In HRMS, HR sets/changes/clears an employee's `biometricDeviceCode`
   (Employee create/edit, or the "Sync to Device" action on Attendance →
   Device Sync). The backend enqueues a `device_user_sync_jobs` row
   (`Create`/`Update`/`Disable`, status `Pending`).
2. On its next poll, this agent fetches all `Pending` jobs
   (`GET /attendance/device-users/pending`).
3. For each job:
   - **Create/Update**: connects to the device, calls `getUsers()` to check
     whether that `biometricDeviceCode` is already enrolled at some internal
     device slot (`uid`) — if so, reuses that slot (an update); if not,
     allocates the lowest free slot in the device's valid `1–3000` range (a
     new enrollment). Calls `setUser(uid, userid, name, ...)`.
   - **Disable**: calls `deleteUser(uid)` for that employee's slot, if one
     exists. If the employee was never actually enrolled on the device, this
     is an honest no-op — nothing to remove.
4. Acks the job back to the backend as `Synced`, or `Failed` with the real
   error message if anything went wrong — visible on the HRMS "Device User
   Sync" panel, not silently swallowed.

**Why a queue, not a direct call**: the backend (on the VPS) has no network
route to the device's office-LAN address, so it can never call the device
directly — only this agent, which is actually on that LAN, can. The queue is
what lets HR's action in the app and the agent's next poll stay decoupled and
eventually consistent.

**Caveat**: the `setUser`/`deleteUser` implementation has been code-reviewed
and verified with a fully mocked test device — but **not yet against a real,
physical K30**. The first real enrollment/removal on live hardware is worth
watching closely (check the HRMS Device User Sync panel and this agent's logs)
rather than assumed correct on faith.

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

# 5. Open the ADMS port in the firewall (if ufw is active)
sudo ufw allow 7788/tcp

# 6. Enable + start everything
sudo systemctl daemon-reload
sudo systemctl enable --now ironmart-biometric-agent.service
sudo systemctl enable --now ironmart-biometric-agent-updater.timer

# 7. Verify
sudo systemctl status ironmart-biometric-agent.service
sudo journalctl -u ironmart-biometric-agent -f       # live logs
sudo systemctl list-timers ironmart-biometric-agent-updater.timer
```

That's it — the agent now:
- **Starts automatically on boot** (`WantedBy=multi-user.target`, no login required).
- **Restarts automatically if it crashes** (`Restart=on-failure`, capped at 5 restarts per 5 minutes).
- **Auto-updates**: the updater timer fires 2 minutes after boot and then every 15 minutes, runs `scripts/update.sh`, and restarts the main service only if a new commit was actually pulled.

**If your device IP or one of the other env vars changes later**: edit
`/opt/ironmart-biometric-agent/.env` directly, then
`sudo systemctl restart ironmart-biometric-agent.service` — no reinstall needed.

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

# Open the ADMS port in Windows Firewall (replace 7788 if ADMS_PORT differs)
New-NetFirewallRule -DisplayName "IronMart Biometric ADMS" `
  -Direction Inbound -Protocol TCP -LocalPort 7788 -Action Allow
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

# Open the ADMS port
New-NetFirewallRule -DisplayName "IronMart Biometric ADMS" `
  -Direction Inbound -Protocol TCP -LocalPort 7788 -Action Allow
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
  1. Refuse to proceed if the local working tree has uncommitted changes.
  2. `git pull --ff-only`.
  3. `npm install`, but **only** if `package.json`/`package-lock.json` actually changed.
  4. Restart the agent.

This means a push to this repo's `main` branch takes up to 15 minutes to
reach a given office machine — a deliberate, honest tradeoff for a device
with no inbound reachability, not a bug.

---

## What happens when the device is unreachable / not synced

### Punch sync

Since punch sync is now push-based (the device calls us, not the other way
around), "device unreachable" means **the device simply won't push** — it
queues punches internally and pushes them when connectivity is restored.
This agent's ADMS server is always listening; it doesn't need to know the
device is offline in advance.

When the device reconnects and pushes:
- The `ATTLOGStamp` from the handshake tells it where we left off, so it
  sends only the records accumulated during the outage.
- Our watermark only advances after a confirmed successful backend push, so
  even if the device pushes and we fail to forward to the backend, no punches
  are lost — the next ADMS push will include them again.

**No punches are ever lost from a device or network outage** — the device
itself is the source of record for punch data; this agent is a courier, not
a store.

### Device user enrollment sync

- If the agent can't connect to the device this cycle, every job that was
  fetched as `Pending` for that cycle is acked back to the backend as
  `Failed` with a clear reason — visible immediately on the HRMS "Device
  User Sync" panel, not left silently stuck in `Pending`.
- A `Failed` job is not lost — HR can click "Sync to Device" again from the
  HRMS UI once the device is back, which re-enqueues a fresh `Pending` job.
- If one specific job fails (e.g. an invalid uid), only that job is acked
  `Failed` — the rest of the batch still proceeds.

### In short

Nothing about a device outage or a desync is silent: every failure either
shows up as a clearly-labelled `Failed` job in the HRMS UI, or in this
agent's own log — and nothing is ever lost, only delayed.

---

## Logs & troubleshooting

- **Log file**: `logs/agent.log` inside the repo (or `$LOG_DIR` if overridden).
- **Linux**: `sudo journalctl -u ironmart-biometric-agent -f` for live output.
- **Windows**: `Get-Content logs\agent.log -Tail 50 -Wait`; for the NSSM
  path, also `logs\service-stdout.log`/`service-stderr.log`.
- **In the HRMS app**: Attendance → Device Sync shows both the punch-sync
  history and the device-user-sync job queue, including any `Failed` job's
  real error message — check there first before diving into raw log files.
- **"Nothing is syncing at all"**:
  1. Check that `DEVICE_AGENT_TOKEN` matches the backend's exactly (a
     mismatch 401s every request).
  2. Check that the device's Cloud Server Settings point to this machine's
     LAN IP and the correct ADMS port (see [Device configuration](#device-configuration-one-time)).
  3. Check that the Windows Firewall (or ufw on Linux) allows inbound TCP
     on the ADMS port.
  4. Look for `ADMS handshake SN=...` in the log — if it's there, the device
     is connected and pushing correctly.

---

## Known limitations

- The device-user-sync feature (enroll/update/remove on the physical device)
  has been verified via code review and a fully mocked test, but **not yet
  against real ESSL K30 hardware** — see the caveat in
  [Device user enrollment sync](#device-user-enrollment-sync).
- Punch sync (`ADMS push`) has been designed against the documented eSSL ADMS
  protocol and validated against the device photos confirming `Server Mode =
  ADMS`. The first real end-to-end push from live hardware is worth watching
  in the logs to confirm the ATTLOGStamp handshake and ATTLOG parsing work as
  expected.
- Docker deployment has no wired auto-update mechanism (see the note under
  [Running with Docker](#running-with-docker)).
- Auto-update polls on a fixed interval (default 15 min), not instantly on
  push — an accepted tradeoff for a device with no inbound network
  reachability, not a bug.
- **Confirmed real bug in the upstream `zkteco-js` library**: `readWithBuffer`
  in its `src/ztcp.js` calls `reject(err)` on a device timeout but is missing
  a `return` afterward, causing a secondary unhandled rejection from a
  `null.subarray(...)` call. **Mitigated**: `src/index.js` installs
  `process.on("unhandledRejection", ...)` handlers so this orphaned rejection
  can't kill the process. This bug only affects the ZK TCP write direction
  (user enrollment) — punch sync no longer uses ZK TCP at all, so it is
  completely unaffected by this issue.
