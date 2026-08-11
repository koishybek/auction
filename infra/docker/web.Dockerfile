# syntax=docker/dockerfile:1
#
# Образ web (Next.js SSR). Собирается в CI, разворачивается Helm-чартом.

FROM node:22-alpine AS deps
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile

FROM deps AS build
WORKDIR /app
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
# Шрифты Plex тянутся с Google Fonts на этапе сборки — сборочному слою нужна сеть.
RUN pnpm --filter @auction/shared build && pnpm --filter @auction/web build

FROM node:22-alpine AS runtime
RUN corepack enable && \
    addgroup -g 1000 -S app && adduser -u 1000 -S app -G app
WORKDIR /app

ENV NODE_ENV=production
ENV WEB_PORT=3101

COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/packages/shared packages/shared
COPY --from=build --chown=app:app /app/apps/web apps/web
COPY --from=build --chown=app:app /app/package.json /app/pnpm-workspace.yaml ./

USER app
WORKDIR /app/apps/web
EXPOSE 3101

HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.WEB_PORT||3101)+'/',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

CMD ["node_modules/.bin/next", "start", "-p", "3101"]
