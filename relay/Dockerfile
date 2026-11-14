FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node . .
ENV NODE_ENV=production HOST=0.0.0.0 PORT=10000 FIXTURE_PORT=4174
USER node
EXPOSE 10000
CMD ["node", "server.mjs"]
