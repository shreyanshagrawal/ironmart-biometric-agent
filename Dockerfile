FROM node:22-alpine
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

# State file persists across container restarts via a bind/volume mount at
# this path (see README.md) — a fresh restart with no mounted state simply
# re-syncs the device's full current log once, which is harmless since the
# backend dedupes by (deviceId, punchTimestamp).
ENV STATE_FILE_PATH=/app/data/state.json
VOLUME ["/app/data"]

CMD ["node", "src/index.js"]
