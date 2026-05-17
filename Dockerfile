# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=production \
    HOMEBOX_MCP_HOST=0.0.0.0 \
    HOMEBOX_MCP_PORT=3000 \
    HOMEBOX_MCP_PATH=/mcp \
    HOMEBOX_MCP_DATA_DIR=/data

COPY package.json package-lock.json ./
RUN mkdir -p /data && chown node:node /data && npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.HOMEBOX_MCP_PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/index.js"]
