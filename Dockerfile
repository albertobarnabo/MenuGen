# syntax=docker/dockerfile:1

# ── 1. Install dependencies ────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ── 2. Build ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ── 3. Runtime image (standalone output, non-root user) ───────────────────────
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    MENUGEN_DATA_DIR=/data
RUN addgroup -S menugen && adduser -S menugen -G menugen \
    && mkdir -p /data && chown menugen:menugen /data
COPY --from=build --chown=menugen:menugen /app/.next/standalone ./
COPY --from=build --chown=menugen:menugen /app/.next/static ./.next/static
COPY --from=build --chown=menugen:menugen /app/public ./public
USER menugen
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "server.js"]
