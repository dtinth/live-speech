FROM oven/bun:1.4.3-slim
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

# The web UI, REST API and sender WebSocket all share this port.
EXPOSE 3000

# Rooms database and recorded audio. Persist this.
VOLUME /data

# Stop gracefully on SIGTERM so in-flight chunks are written and acked.
STOPSIGNAL SIGTERM
CMD ["bun", "src/server/main.ts"]
