# Dependencies stage
FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci

# Build stage
FROM node:20-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*
ENV SKIP_ENV_VALIDATION=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

# Runtime stage
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
      ca-certificates && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/src ./src
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/next.config.ts ./next.config.ts

EXPOSE 3000

CMD ["sh", "-c", "npm run prisma:migrate:deploy && (npm run schedule &) && npm run start"]
