-- Changing the login address needed no re-authentication and left no record
-- (§9). The fix requires the current password, the same way changing it does,
-- and now writes its own audit row rather than borrowing PASSWORD_CHANGED —
-- the two are gated identically but are not the same fact: PASSWORD_CHANGED
-- says nothing about where the next "forgot password" mail goes.
--
-- Postgres will not let a value added to an enum be used in the same
-- transaction that adds it, and prisma migrate runs each file in one. Nothing
-- here writes a row, so that is fine — but it is why this file only declares.
ALTER TYPE "AuditAction" ADD VALUE 'EMAIL_CHANGED';
