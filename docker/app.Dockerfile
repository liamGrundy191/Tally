# The API and the worker (one image; the worker runs it with MODE=worker). T4.3, D60.
# Build from the repository root: docker build -f docker/app.Dockerfile -t tally-app:<tag> .
# The workspace layout is kept (/app/apps/api, /app/packages/shared): @tally/shared is TypeScript,
# and Node strips types only outside node_modules (D47).
FROM node:22.23.3-bookworm-slim@sha256:3ed98443660ff48413b5af19ecefce3b9d50845a901a43420d47cc63a9fddbe9

# poppler: PDF pages (section 4); openssl: Prisma's migrate engine.
RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/prisma.config.ts apps/api/
COPY apps/api/prisma apps/api/prisma
# Dev dependencies stay: the prisma CLI runs the migrations on deploy (and generates the client).
RUN pnpm install --frozen-lockfile --filter @tally/api...

COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @tally/api exec tsc -p tsconfig.build.json

ENV NODE_ENV=production
USER node
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "apps/api/dist/main.js"]
