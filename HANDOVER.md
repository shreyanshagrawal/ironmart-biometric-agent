# Handover runbook — do this before losing access to the office machine

Written 2026-08-06. Everything below is a one-time setup task on the office
Windows box (`C:\Users\Admin\ironmart-biometric-agent`) plus the VPS. Once
these are done, the agent keeps itself updated and reports its own health
remotely, so nobody needs to log into that machine again under normal
operation.

Work through the steps in order. Step 4 is the one that makes the rest
survivable — don't skip it.

---

## Status as of writing

**Working:** the device pushes punches to the agent over ADMS, and the agent
forwards them to the HRMS backend. Confirmed in real logs:

```
[INFO] ADMS ATTLOG  SN=EUF7261000955  1 record(s) received.
[INFO] SN=EUF7261000955: pushed 1 new punch(es) — inserted: 1, unmatched: 1
```

`unmatched: 1` means the punch was stored but not attributed to an employee —
see step 5.

**Not yet done:** steps 1–6 below.

---

## 1. Deploy the backend to the VPS

The agent's heartbeat endpoint (`POST /api/v1/attendance/agent-heartbeat`) and
its `device_agent_status` table only exist in code that hasn't reached the VPS
yet. Until this is deployed, the Developer Dashboard's agent tile will show
"No agent has ever reported in" no matter how healthy the agent actually is.

SSH into the VPS and run:

```bash
cd /path/to/ironmart          # wherever the repo is checked out on the VPS
git pull origin main
docker compose up -d --build  # the `migrate` job runs automatically and
                              # applies migration 0066 before the backend starts
docker compose ps             # confirm backend + migrate are healthy/completed
```

Verify the new endpoint exists:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST https://ironmart.co.in/api/v1/attendance/agent-heartbeat \
  -H "Authorization: Bearer WRONG_TOKEN" -H "Content-Type: application/json" -d '{}'
# Expect 401 (route exists, auth correctly rejects). A 404 means the deploy
# didn't land.
```

## 2. Turn on automatic VPS deploys (optional but recommended)

So future pushes to `main` deploy themselves instead of needing manual SSH.
Add these 5 secrets at
`https://github.com/shreyanshagrawal/ironmart/settings/secrets/actions`:

| Secret | Value |
|---|---|
| `VPS_HOST` | VPS IP or hostname |
| `VPS_USERNAME` | SSH user |
| `VPS_SSH_KEY` | that user's private key, **no passphrase** (Actions can't type one) |
| `VPS_PORT` | `22`, or your custom SSH port |
| `VPS_DEPLOY_PATH` | absolute path to the repo on the VPS, e.g. `/opt/ironmart` |

The workflow (`.github/workflows/deploy.yml`) is already written and waiting
on these. Until they exist, every push shows a failed "Deploy to VPS" run —
harmless, but it never actually reaches the server.

## 3. Confirm the agent is on the latest code

On the office machine:

```cmd
cd C:\Users\Admin\ironmart-biometric-agent
git pull
npm install
npm start
```

Expected in the log — no 401, no repeating OPERLOG warnings:

```
[INFO] ADMS push server listening on :7788 ...
[INFO] Heartbeat started (every 2min, agentId=agent-<HOSTNAME>, version=<commit>).
[INFO] ADMS <TABLE>  SN=...  acknowledged (not stored — only ATTLOG is used).
```

If `User sync failed: ... 401` still appears **after** step 1 is deployed,
the `DEVICE_AGENT_TOKEN` in this machine's `.env` genuinely doesn't match the
backend's. The error message now prints the exact URL it called, which
distinguishes a token mismatch from a wrong URL.

## 4. Make it start on boot and self-update — THE IMPORTANT ONE

Without this, a reboot or power cut silently ends attendance collection and
nobody finds out until someone checks. From an **elevated** ("Run as
Administrator") PowerShell prompt:

```powershell
cd C:\Users\Admin\ironmart-biometric-agent
powershell -ExecutionPolicy Bypass -File deploy\windows\install-tasks.ps1
```

This registers two Scheduled Tasks running as `SYSTEM`:
- **IronMartBiometricAgent** — starts at boot (no login needed), auto-restarts if it exits.
- **IronMartBiometricAgentUpdater** — every 15 min: `git fetch`, and if `main` moved, pull, `npm install` (only if dependencies changed), and restart the agent.

Confirm both registered:

```powershell
Get-ScheduledTask -TaskName IronMartBiometricAgent | Get-ScheduledTaskInfo
Get-ScheduledTask -TaskName IronMartBiometricAgentUpdater | Get-ScheduledTaskInfo
Get-Content logs\agent.log -Tail 20
```

`LastTaskResult` of `0` means it ran fine.

**Then actually test the reboot** — restart the machine and confirm punches
resume with nobody logged in. This is the single most valuable five minutes
you can spend before handing the machine over; everything else is recoverable
remotely, this isn't.

## 5. Map employees to their device PINs

`unmatched: 1` in the log means the device sent PIN `X` and no employee in
HRMS has `X` as their **Biometric Device Code**. The punch is stored (visible
under **Attendance → Exceptions**) but isn't attributed to anyone.

The device only knows people by PIN — to know which PIN is which real
employee, the plan was to run `node scripts/list-device-users.mjs` on the
office machine. **On this specific device that does not work** — confirmed
live: it hits the same ZK-TCP-bulk-read timeout documented below in Known
Limitations. Use the device's own physical menu instead (**Menu → User
Mgmt → All Users** shows each enrolled ID + name on its own screen) or
whatever software was originally used to enroll everyone with names. Once
you know a PIN → name pairing: HRMS → **Employees** → edit → set
**Biometric Device Code** to their PIN. Once set:
- HRMS pushes the enrollment back to the device via the user-sync queue
  (**Attendance → Device Sync**), same as before.
- **Any punches that already arrived from that PIN before you set the
  mapping are automatically backfilled** into real attendance records the
  moment you save — you do not need a separate re-sync step, and nothing
  from before the mapping was lost. (A device typically has real people
  punching for days before every PIN gets mapped in HRMS — this is what
  keeps that backlog from being silently dropped.)

## 6. Confirm remote monitoring actually works

This is what you rely on after losing machine access. HRMS → **Developer
Dashboard** → **Biometric Agent** tile (topmost). It should show:

- **Healthy** — heartbeat within the last 10 min, no errors
- **Last heartbeat** — "just now" / "N min ago"
- **Device reachable** — yes/no, tracked separately from agent health, so
  "device unplugged" is distinguishable from "agent process died"
- **Punches forwarded**, **Agent version** (the running git commit — this is
  how you confirm remotely that an auto-update actually landed)

**Test the alarm before trusting it:** stop the agent
(`Stop-ScheduledTask -TaskName IronMartBiometricAgent`), wait ~10 minutes,
and confirm the tile flips to **Down** with "No heartbeat for N minutes".
Then start it again. An untested alarm is not an alarm.

---

## What happens when things break, after you're gone

| Symptom on the dashboard | What it means | What to do |
|---|---|---|
| Agent **Down**, no heartbeat for N min | Agent process or its machine is off | Someone on-site restarts the machine; the boot task starts the agent automatically. **No punches are lost** — the device stores them internally and forwards them once the agent returns. |
| Agent **Healthy**, device reachable **no** | Agent is fine; the device is off/unplugged/off-network | Check the physical device and its network cable. |
| Agent **Degraded** with a "no matching employee" error | Punches arriving for a PIN not mapped to any employee | Set that employee's Biometric Device Code (step 5). No data lost — punches are in Attendance → Exceptions. |
| Agent **Degraded**, user-sync failures | Enrollment jobs can't reach the device or backend | Jobs stay `Pending` and retry automatically; they are never dropped. |

The recurring guarantee: **nothing is ever lost, only delayed.** The device's
own internal log is the source of truth for punches, and the backend's job
queue is the source of truth for enrollments. The agent is a courier — when
it's down, delivery pauses; it doesn't destroy the mail.

---

## Known limitations (stated plainly)

- **Device user enrollment (HRMS → device) is CONFIRMED NOT WORKING against
  this device's firmware — upgraded from "untested" after real evidence.**
  `zk.getUsers()` (zkteco-js's ZK TCP user-list read) times out against the
  real device (`TIMEOUT_IN_RECEIVING_RESPONSE_AFTER_REQUESTING_DATA`, the
  same failure mode already documented below for bulk reads generally).
  Both directions of the device-user-sync feature depend on this call —
  `resolveDeviceUid()` (enroll/update) calls it first to find a free/existing
  slot, and the Disable path calls it directly to find the user to remove —
  so **neither direction currently works on this hardware**, not just an
  unverified caveat. Jobs will sit in the queue retrying and failing forever
  (harmless — see the table above — but they will never actually succeed).
  `scripts/list-device-users.mjs` hits the identical failure for the same
  reason (it's the same `getUsers()` call) — **it will not produce output on
  this device**, only confirm the same timeout. To get a real PIN → name
  cross-reference on this hardware, use the device's own physical menu
  (**Menu → User Mgmt → All Users**, shows each enrolled ID + name on the
  device's own screen) or whatever enrollment software was originally used to
  type names in (the same "eSSL"-branded comm software referenced in step 1's
  comm-password setup, if still installed) — not this repo's tooling.
- **ZK TCP bulk reads do not work on this device's firmware.** Confirmed with
  a raw-protocol probe (`scripts/diagnose-protocol.mjs`): the device replies
  to `CMD_CONNECT` with command ID `6001` and to `CMD_GET_FREE_SIZES` with
  `2032` — neither is a standard ACK code, and no data payload follows. This
  is why punch sync uses ADMS push instead. `getUsers()`'s real, reproduced
  timeout (above) confirms this same incompatibility extends to every ZK TCP
  bulk-read command, not just the punch log — a genuine firmware limitation
  on this specific device, not a bug in this codebase's own request-building.
- **Auto-update polls every 15 min**, not instantly — the office machine has
  no inbound reachability for a webhook. Lower the interval in the Scheduled
  Task if you need it faster.
- **Docker deployment of the agent has no auto-update path** — the updater is
  built for the direct Node install described here.
