/**
 * Writing down what a platform admin did (§9c).
 *
 * One function, called at the point of the act rather than by a wrapper
 * somewhere above it, because the sentence worth recording — "removed sam@…
 * from Fynbos, which had two admins" — can only be written where the
 * surrounding facts are still in scope. A generic middleware that logged the
 * method and the path would produce a table nobody could read.
 *
 * Recording never fails an operation. If the audit insert throws, the act it
 * describes has already happened, and refusing to acknowledge it would leave
 * the caller believing it hadn't — the worst of both. The failure goes to the
 * console, where the same eyes that watch the backups will find it.
 */

import type { AuditAction } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export interface AuditEntry {
  action: AuditAction;
  /** The platform admin responsible; omitted for something a script did. */
  actor?: { id: string; email: string } | null;
  household?: { id: string; name: string } | null;
  /** Who it was done to, where that is a person. */
  subjectEmail?: string | null;
  /** One sentence, in the past tense, readable on its own. */
  detail: string;
}

export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await prisma.auditEvent.create({
      data: {
        action: entry.action,
        actorId: entry.actor?.id ?? null,
        actorEmail: entry.actor?.email ?? null,
        householdId: entry.household?.id ?? null,
        householdName: entry.household?.name ?? null,
        subjectEmail: entry.subjectEmail ?? null,
        detail: entry.detail,
      },
    });
  } catch (error) {
    console.error("audit write failed", entry.action, error);
  }
}

/** The most recent interventions, newest first — what the admin screen shows. */
export async function recentAudit(limit = 50) {
  return prisma.auditEvent.findMany({
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 200),
    select: {
      id: true,
      action: true,
      actorEmail: true,
      householdName: true,
      subjectEmail: true,
      detail: true,
      createdAt: true,
    },
  });
}
