# The web app's files, served by Caddy (T4.3, D60).
# Build from the repository root: docker build -f docker/web.Dockerfile -t tally-web:<tag> .
FROM node:22.23.3-bookworm-slim@sha256:3ed98443660ff48413b5af19ecefce3b9d50845a901a43420d47cc63a9fddbe9 AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @tally/web...
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @tally/web build

FROM caddy:2.11.7-alpine@sha256:e70b164da81ef698b3ad19af799ea6086ce6d9e48ed4079eb9fe26f6fbf14ee5
# Not root (D58). The caddy binary may still open ports 80 and 443 (it has cap_net_bind_service).
RUN addgroup -S caddy && adduser -S -G caddy caddy && chown -R caddy:caddy /data /config
COPY --from=build /app/apps/web/dist /srv
COPY docker/Caddyfile /etc/caddy/Caddyfile
USER caddy
