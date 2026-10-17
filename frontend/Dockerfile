# syntax=docker/dockerfile:1

# The base is pinned to a Debian-slim (glibc) image rather than Alpine on
# purpose. sharp is a transitive dependency of Next.js and ships a *different*
# native binary per libc -- @img/sharp-linux-x64 versus
# @img/sharp-linuxmusl-x64. Both this stage and the runner must resolve the same
# one, so the same tag is used in every stage rather than mixing slim and alpine.
ARG NODE_VERSION=22

# --- dependencies -----------------------------------------------------------
# Isolated so `npm ci` is cached independently of the source tree. It must run
# inside the image: sharp's native binary is chosen for the *build* platform, so
# a node_modules copied in from Windows would drag along sharp-win32-x64 and the
# server would fail to load it on Linux.
FROM node:${NODE_VERSION}-slim AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci


# --- build ------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# API_ORIGIN is a BUILD argument, not just a runtime one, and that is the single
# most important line in this file. next.config.ts resolves the /api/:path*
# rewrite during `next build` and freezes the result into
# .next/routes-manifest.json as a literal string. Passing it only to `docker run`
# would update src/lib/dal.ts but leave the rewrite pointing wherever the image
# was built -- i.e. at 127.0.0.1:8000 *inside this container*, where nothing
# listens. The browser would then get a hard failure on every API call while the
# server-side session check in dal.ts still worked, which is a genuinely
# confusing split. Give it the same value at build and run time.
ARG API_ORIGIN=http://backend:8000
ENV API_ORIGIN=$API_ORIGIN

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build


# --- runtime ----------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Default matches the build ARG above. Override both together via --build-arg and
# -e if the backend address ever changes.
ENV API_ORIGIN=http://backend:8000

# next.config.ts is read at build time, but dal.ts resolves this one at runtime,
# so the value must still be present in the running container.
RUN chown -R node:node /app

COPY --from=builder --chown=node:node /app/.next/standalone ./
# server.js does not carry these two; without them the HTML loads and then 404s
# on every chunk and stylesheet, which looks like a styling bug rather than a
# missing copy step.
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

# The `node` user (uid 1000) ships with the base image. Writable because Next
# keeps its on-disk cache under .next even though this app never calls
# next/image, and a read-only .next turns that into a 500 instead of a warning.
RUN mkdir -p .next/cache && chown -R node:node /app/.next

USER node
EXPOSE 3000

# /icon.png is a prerendered static route, so this proves the Node server is up
# and serving without depending on the backend. Do not point this at / or
# /login: both run requireSession server-side, so the frontend would be reported
# unhealthy whenever the API is down, which is the wrong container's fault to
# report. The backend has its own /api/health for that.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/icon.png').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# server.js is the standalone entrypoint. node_modules/next is already inside
# ./ from the standalone copy, so nothing else needs to be installed.
CMD ["node", "server.js"]
