# IronMart Biometric Push Agent

Polls the ESSL K30 biometric attendance device over the office LAN and pushes
new punch logs to the IronMart HRMS backend over HTTPS.

**This does not run on the VPS.** The VPS's Docker Compose stack has no route
to the device's private LAN address (e.g. `192.168.1.201`) — the whole point
of this agent is to run on a machine that's actually on that LAN (a spare PC,
a small always-on box, a Raspberry Pi) and push outbound to the VPS instead of
the VPS trying to reach in.

## How it works

1. Every `POLL_INTERVAL_MINUTES`, connects to the device via `node-zklib`
   (same library and field mapping the backend's own `EsslProvider` uses) and
   fetches its attendance log.
2. Filters out anything already pushed, tracked via a local `state.json`
   (`lastSyncedTimestamp`) so a restart never re-pushes old punches.
3. POSTs the new punches to `VPS_INGEST_URL`
   (`POST /api/v1/attendance/device-logs/ingest`) with a bearer token.
4. Only advances `state.json`'s watermark after a confirmed successful push —
   a failed push retries the same window on the next poll. The backend also
   dedupes by `(deviceId, punchTimestamp)`, so an occasional re-push after a
   crash mid-request is harmless, not a duplicate attendance record.

## Running directly with Node

```bash
cp .env.example .env
# edit .env with the real device IP, VPS URL, and shared token
npm install
node --env-file=.env src/index.js
```

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
container restart — without it, a restart just re-syncs the device's current
full log once (harmless, but noisier than necessary).

## Required environment variables

| Variable | Description |
|---|---|
| `ESSL_DEVICE_IP` | The device's LAN IP (default `192.168.1.201`) |
| `ESSL_DEVICE_PORT` | The device's port (default `4370`) |
| `VPS_INGEST_URL` | Full URL to the backend's ingest endpoint, e.g. `https://hrms.example.com/api/v1/attendance/device-logs/ingest` |
| `DEVICE_AGENT_TOKEN` | Shared secret — must match the backend's `DEVICE_AGENT_TOKEN` env var exactly |
| `POLL_INTERVAL_MINUTES` | How often to poll the device (default `5`) |

## Verifying it's working

- Watch the agent's logs: it prints how many punches were fetched, pushed,
  and how many the backend matched vs. left unmatched (no
  `employees.biometricDeviceCode` match) on each poll.
- In the HRMS app, check Attendance → Device Sync / Sync History — a
  successful push shows up there the same way a pull-based sync would
  (the backend's `ingestRawLogs` is shared by both paths).
- Unmatched punches show up in Attendance → Exceptions, same as the old
  pull-based sync — this agent doesn't change any matching/business logic,
  only how logs arrive.
