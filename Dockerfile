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
# reachable from the host (where Caddy proxies it).
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0

# Backups (§11). borg writes the archives, pg_dump produces what goes into
# them, and ssh-keygen/ssh are how the app reaches the storage box — the key it
# connects with is generated in the container, from the settings screen.
#
# pg_dump refuses to dump a server newer than itself, so the client major has
# to keep up with the db image in docker-compose.yml (postgres:17). The
# fallback is for a base image whose Alpine release doesn't carry that exact
# major: an unversioned client still dumps, and src/lib/borgError.ts recognises
# the version-mismatch failure if it turns out to be too old.
RUN apk add --no-cache borgbackup openssh-client \
    && (apk add --no-cache postgresql17-client || apk add --no-cache postgresql-client)

RUN addgroup -S nodejs && adduser -S nextjs -G nodejs

# The SSH key and borg's cache. Both are mounted from a named volume in
# docker-compose.yml, which inherits this ownership when it's first created:
# the key because the storage box has been told to trust it, and the cache
# because without it borg re-reads the whole repository every night to work out
# what's already there.
RUN mkdir -p /var/lib/mealplanner/ssh /var/lib/mealplanner/borg \
    && chown -R nextjs:nodejs /var/lib/mealplanner \
    && chmod 700 /var/lib/mealplanner/ssh /var/lib/mealplanner/borg

# Carry the full dependency set so the Prisma CLI (a devDependency) is available
# for `migrate deploy` at start, alongside the build output and schema.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.mjs ./next.config.mjs
COPY --from=builder /app/prisma ./prisma
# The vendored Tesseract language model for receipt OCR (§7). Shipped in the
# image so the app never fetches it at runtime.
COPY --from=builder /app/tessdata ./tessdata

USER nextjs
EXPOSE 3000

# Apply pending migrations, then start the server (next start binds 0.0.0.0).
CMD ["sh", "-c", "npx prisma migrate deploy && npm run start"]
