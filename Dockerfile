# Multi-stage build for ChainSettle NestJS API
# Build:  docker build -t chainsettle-backend .
# Run:    docker run --env-file .env -p 3000:3000 chainsettle-backend

# ── Build stage ──────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma ./prisma/

RUN npm ci

COPY . .

RUN npx prisma generate
RUN npm run build

# ── Runtime stage ────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

RUN apk add --no-cache wget \
  && addgroup -S app && adduser -S app -G app

COPY package.json package-lock.json ./
COPY prisma ./prisma/

RUN npm ci --omit=dev && npx prisma generate && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Nest copies Handlebars templates into dist via nest-cli assets
USER app

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/v1/health/live || exit 1

CMD ["node", "dist/main"]
