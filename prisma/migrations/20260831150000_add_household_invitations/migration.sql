-- Invitations become records of their own, and the weekly-digest opt-in moves
-- from the account to the membership.
--
-- Until now an invitation was an AuthToken pointed at warmer copy, and the
-- membership it promised was created the moment the link was sent. That made a
-- person who had never answered indistinguishable from a member who had simply
-- never logged in: already inside a private household's roster, and impossible
-- to withdraw. An Invitation row is the offer; the membership is what accepting
-- it creates.

-- CreateEnum
CREATE TYPE "InvitationKind" AS ENUM ('HOUSEHOLD', 'PLATFORM');

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "invitedName" TEXT,
    "kind" "InvitationKind" NOT NULL,
    "householdId" TEXT,
    "householdName" TEXT,
    "invitedById" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "acceptedById" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");
CREATE INDEX "Invitation_email_idx" ON "Invitation"("email");
CREATE INDEX "Invitation_householdId_idx" ON "Invitation"("householdId");
CREATE INDEX "Invitation_expiresAt_idx" ON "Invitation"("expiresAt");

-- A household invitation names the household it joins. A platform invitation
-- cannot, because the household it will create does not exist yet — and then
-- does, so once the row is spent it records which one it created. Stated here
-- as well as in the application so a caller that forgets cannot write a row
-- nothing knows how to accept.
ALTER TABLE "Invitation"
ADD CONSTRAINT "Invitation_household_target_matches_kind"
CHECK (
    ("kind" = 'HOUSEHOLD' AND "householdId" IS NOT NULL)
    OR ("kind" = 'PLATFORM' AND ("householdId" IS NULL OR "acceptedAt" IS NOT NULL))
);

-- AddForeignKey
ALTER TABLE "Invitation"
ADD CONSTRAINT "Invitation_householdId_fkey"
FOREIGN KEY ("householdId") REFERENCES "Household"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- The record of who invited whom outlives the inviter's account, so removing
-- an admin nulls the reference rather than deleting the history.
ALTER TABLE "Invitation"
ADD CONSTRAINT "Invitation_invitedById_fkey"
FOREIGN KEY ("invitedById") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Invitation"
ADD CONSTRAINT "Invitation_acceptedById_fkey"
FOREIGN KEY ("acceptedById") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- The weekly digest is per household (§9b), so the opt-in has to be too.
-- Somebody cooking in two households gets two mails about two different weeks,
-- and the one-click unsubscribe in a footer must silence the household whose
-- footer it was, not both of them.
ALTER TABLE "HouseholdMembership" ADD COLUMN "newsletterOptIn" BOOLEAN NOT NULL DEFAULT true;

UPDATE "HouseholdMembership" AS m
SET "newsletterOptIn" = u."newsletterOptIn"
FROM "User" AS u
WHERE u."id" = m."userId";

ALTER TABLE "User" DROP COLUMN "newsletterOptIn";

-- Deliberately not migrated: accounts invited under the old scheme, which
-- already hold a membership and a live INVITE AuthToken. Their raw token exists
-- only in their inbox, so no Invitation row could be reconstructed for them,
-- and revoking the memberships would lock out people who are mid-signup. They
-- finish through /reset as before; nothing new arrives that way.
