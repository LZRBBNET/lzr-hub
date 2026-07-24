FROM node:22.13.1-alpine3.21

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
COPY src ./src

RUN chown -R node:node /app
USER node

EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8788/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "--experimental-strip-types", "src/server.ts"]
