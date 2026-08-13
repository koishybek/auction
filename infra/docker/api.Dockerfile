# syntax=docker/dockerfile:1
#
# Образ API. Собирается в CI (T-003) и разворачивается Helm-чартом (T-009).
# Локально Docker в проекте не используется — см. docs/dev-setup.md.

# ─── Зависимости ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
RUN corepack enable
WORKDIR /app

# Сначала только манифесты: слой с node_modules переиспользуется, пока не
# менялись зависимости. Копировать сразу весь исходник — значит пересобирать
# установку на каждую правку кода.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile

# ─── Сборка ──────────────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /app
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
# prisma generate + tsc: клиент Prisma генерируется внутрь src и компилируется.
RUN pnpm --filter @auction/shared build && pnpm --filter @auction/api build

# Отдельный набор зависимостей без dev: тащить в рантайм eslint и vitest незачем.
#
# --legacy обязателен: начиная с pnpm 10 обычный deploy требует, чтобы в
# воркспейсе был включён inject-workspace-packages. Включать его глобально ради
# сборки образа не хочется — в разработке это меняет связь с @auction/shared с
# симлинка на копию, и правка общего пакета перестаёт подхватываться без
# переустановки. Флаг оставляет разработку как есть, а образу даёт то же
# дерево зависимостей, что и раньше.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @auction/api --prod --legacy deploy /runtime

# ─── Рантайм ─────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
# Своего пользователя не заводим: в образе node уже есть непривилегированный
# `node` с UID и GID 1000 — ровно теми, что просит securityContext в чарте
# (runAsUser: 1000, fsGroup: 1000). Попытка создать рядом ещё одного с тем же
# gid валит сборку («gid in use»).
RUN corepack enable
WORKDIR /app

ENV NODE_ENV=production

COPY --from=build --chown=node:node /runtime/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/api/dist ./dist
COPY --from=build --chown=node:node /app/apps/api/package.json ./package.json
# Миграции нужны образу: их накатывает Job из Helm-чарта этим же образом.
COPY --from=build --chown=node:node /app/apps/api/prisma ./prisma
COPY --from=build --chown=node:node /app/apps/api/prisma.config.ts ./prisma.config.ts

USER node
EXPOSE 3100

# Проба живости в самом образе — на случай запуска вне Kubernetes.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.API_PORT||3100)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/main.js"]
