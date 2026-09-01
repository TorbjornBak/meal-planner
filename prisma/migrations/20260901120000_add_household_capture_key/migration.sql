-- The bookmarklet capture token was a pure function of AUTH_SECRET and the
-- household id, so it could never be revoked without rotating AUTH_SECRET,
-- which signs every account on the installation out. This gives each
-- household its own salt that participates in the HMAC and can be rotated on
-- its own — see src/lib/auth.ts captureToken/rotateCaptureKey (§1).
--
-- Backfilled with gen_random_uuid() rather than Prisma's cuid(): cuid() is
-- generated client-side by Prisma Client and has no SQL equivalent to hand a
-- DEFAULT clause, and the backfilled value only ever needs to be
-- unpredictable enough to sit inside an AUTH_SECRET-keyed HMAC — it is a salt,
-- not a secret standing on its own, so a UUID serves exactly as well as a
-- cuid would have. New rows get Prisma's own cuid() default from here on;
-- gen_random_uuid() is built into Postgres 13+ (this app runs 17), so no
-- extension is required.
ALTER TABLE "Household" ADD COLUMN "captureKey" TEXT;

UPDATE "Household" SET "captureKey" = gen_random_uuid()::text WHERE "captureKey" IS NULL;

-- SET NOT NULL is itself the backfill guard: it fails the migration outright
-- if any row is still unbackfilled, rather than needing a separate check.
ALTER TABLE "Household" ALTER COLUMN "captureKey" SET NOT NULL;
