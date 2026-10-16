# syntax=docker/dockerfile:1

# ── build: Vite gera a PWA estática a partir do monorepo pnpm ──────────────────
FROM node:22-alpine AS builder
WORKDIR /src
RUN corepack enable

# Manifests primeiro: a camada de dependências só reconstrói quando eles mudam.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile

COPY packages/ packages/
# `build` = typecheck + vite build. Os ícones da PWA são versionados (gerados por
# `pnpm --filter @ondas/web icons` quando o logo muda), então sharp não entra aqui.
RUN pnpm --filter @ondas/web build

# ── runtime: nginx servindo o estático, non-root (padrão do homelab) ───────────
FROM nginx:stable-alpine
COPY packages/web/nginx.conf /etc/nginx/nginx.conf
COPY --from=builder --chown=nginx:nginx /src/packages/web/dist /usr/share/nginx/html
RUN mkdir -p /var/cache/nginx /var/run \
 && chown -R nginx:nginx /var/cache/nginx /var/run /usr/share/nginx/html \
 && touch /var/run/nginx.pid && chown nginx:nginx /var/run/nginx.pid
USER nginx
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["nginx", "-g", "daemon off;"]
