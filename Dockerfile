# syntax=docker/dockerfile:1

# ---- deps ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# ---- builder ----
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Generate the Prisma client and build.
RUN npx prisma generate && npm run build

# ---- runner ----
FROM node:22-alpine AS runner
WORKDIR /app
# HOSTNAME=0.0.0.0 so the server binds all interfaces and the published port is
# reachable from the host (where `tailscale serve` proxies it).
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0

RUN addgroup -S nodejs && adduser -S nextjs -G nodejs

# Carry the full dependency set so the Prisma CLI (a devDependency) is available
# for `migrate deploy` at start, alongside the build output and schema.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.mjs ./next.config.mjs
COPY --from=builder /app/prisma ./prisma

USER nextjs
EXPOSE 3000

# Apply pending migrations, then start the server (next start binds 0.0.0.0).
CMD ["sh", "-c", "npx prisma migrate deploy && npm run start"]
