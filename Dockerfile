# Build stage — full deps (esbuild) to build the content-hashed web bundles
# (scripts/build.js writes into public/ + dist/), then prune to the production
# deps (qrcode) for the runtime image.
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY scripts/ ./scripts/
COPY server/ ./server/
COPY public/ ./public/
COPY partyplug/ ./partyplug/
COPY vendor/ ./vendor/
RUN node scripts/build.js && npm prune --omit=dev

# Production stage
FROM node:20-alpine
RUN addgroup -g 1001 nodejs && adduser -u 1001 -G nodejs -s /bin/sh -D nodejs
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY --from=builder /app/server ./server/
# public/ now carries the hashed bundles; dist/ the manifest the server reads.
COPY --from=builder /app/public ./public/
COPY --from=builder /app/dist ./dist/
# partyplug (transport kit) and vendor (Three.js) live OUTSIDE public/ and are
# served via the /partyplug/ and /vendor/ route remaps in server/index.js. The
# bundles inline them, but the gallery + source-mode pages still reach them.
COPY --from=builder /app/partyplug ./partyplug/
COPY --from=builder /app/vendor ./vendor/
USER nodejs
EXPOSE 4000
ENV NODE_ENV=production PORT=4000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget --no-verbose --tries=1 --spider http://localhost:4000/health || exit 1
CMD ["node", "server/index.js"]
