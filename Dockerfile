# ZivBot server + web app. FalkorDB runs as its own service (see docker-compose.yml).
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build
ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0 ZIV_HOME=/data
VOLUME /data
EXPOSE 8787
CMD ["npx", "tsx", "server/index.ts"]
