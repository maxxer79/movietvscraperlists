# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1 — build the web app and compile the server
# ---------------------------------------------------------------------------
FROM node:20-bookworm AS builder
WORKDIR /app

# Install deps using the lockfile (scripts skipped: no browser download needed here)
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci --ignore-scripts

# Build everything
COPY . .
RUN npm run build:web && npm run build:server

# ---------------------------------------------------------------------------
# Stage 2 — runtime on the official Playwright image (Chromium + deps baked in)
# IMPORTANT: this tag MUST match the "playwright" version in server/package.json
# ---------------------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.61.1-jammy AS runtime
ENV NODE_ENV=production \
    PORT=8088 \
    DATA_DIR=/data \
    HEADLESS=true
WORKDIR /app

# Only production deps for the server (browsers already in the base image)
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
RUN npm ci --omit=dev --ignore-scripts --workspace server

# Copy build artifacts
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/web/dist ./web/dist
COPY version.json ./version.json

RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8088

CMD ["node", "server/dist/index.js"]
