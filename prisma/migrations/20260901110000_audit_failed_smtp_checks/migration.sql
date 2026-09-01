-- A failed SMTP diagnostic is as operationally relevant as a successful one:
-- it explains why invitations or password resets could not leave the box.
ALTER TYPE "AuditAction" ADD VALUE 'SMTP_TEST_FAILED';
