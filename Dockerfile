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

# Lets Dokploy (Docker Swarm) wait for a healthy new container before cutting over.
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# Stop gracefully on SIGTERM so in-flight chunks are written and acked.
STOPSIGNAL SIGTERM
CMD ["bun", "src/server/main.ts"]
