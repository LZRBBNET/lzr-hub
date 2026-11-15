FROM node:24-bookworm-slim@sha256:0e2646ab57e77b7a384a0cb59b6815b182c77e1f9c3ba36bd8435bd9c4e6680e AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY app ./app
COPY components ./components
COPY lib ./lib
COPY db ./db
COPY types ./types
COPY public ./public
COPY drizzle ./drizzle
COPY services/queue-runtime/src/promise-hold.mjs ./services/queue-runtime/src/promise-hold.mjs
COPY scripts/synthetic-web.mjs scripts/prepare-synthetic-initialization.mjs ./scripts/
COPY scripts/ephemeral ./scripts/ephemeral
COPY proxy.ts tsconfig.json next.config.ts ./
RUN node --experimental-strip-types scripts/ephemeral/build.mjs
FROM postgres@sha256:99d1a998c76487d3abb48b141505bda5dcf8089c0c4cd7be40f75de314fa32f0
RUN groupadd --gid 10001 lzrapp && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin lzrapp
COPY --from=builder /usr/local/bin/node /usr/local/bin/node
COPY --from=builder /app /app
RUN chmod -R a+rX /app
ENV PGDATA=""
WORKDIR /app
ENTRYPOINT ["/bin/sh","/app/scripts/ephemeral/entrypoint.sh"]
