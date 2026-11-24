# Multi-stage build for ChainSettle NestJS API
# Build:  docker build --build-arg GIT_SHA=$(git rev-parse HEAD) --build-arg BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ) -t chainsettle-backend .
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

# Build metadata surfaced by GET /health/version and chainsettle_build_info (#427).
#   docker build --build-arg GIT_SHA=$(git rev-parse HEAD) #                --build-arg BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ) .
# APP_VERSION defaults to package.json's version when not supplied.
ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown
ARG APP_VERSION=
ENV NODE_ENV=production     GIT_SHA=${GIT_SHA}     BUILD_TIME=${BUILD_TIME}     APP_VERSION=${APP_VERSION}

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
