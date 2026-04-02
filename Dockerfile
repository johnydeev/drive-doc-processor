# ── Dependencies ─────────────────────────────────────────────────
FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci

# ── Production dependencies only ────────────────────────────────
FROM node:20-bookworm-slim AS prod-deps
WORKDIR /app
RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev

# ── Build ────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*
ENV SKIP_ENV_VALIDATION=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && \
    npm run build && \
    npm run build:jobs

# ── Runtime ──────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      openssl \
      tesseract-ocr \
      tesseract-ocr-spa \
      tesseract-ocr-eng \
      poppler-utils \
      ca-certificates && \
    rm -rf /var/lib/apt/lists/* && \
    addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Next.js standalone
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Jobs compilados (worker + scheduler)
COPY --from=builder /app/dist ./dist

# Production node_modules para los jobs
# (standalone tiene sus propios módulos embebidos para Next.js)
COPY --from=prod-deps /app/node_modules ./node_modules

# Prisma client generado
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/prisma ./prisma

USER nextjs
EXPOSE 3000

# Default: web server. Override via docker-compose command.
CMD ["node", "server.js"]
