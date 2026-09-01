"use client";

import { useCallback, useEffect, useState } from "react";
import type { AuditAction } from "@prisma/client";
import { DiagnosisPanel, type Diagnosis } from "../settings/Diagnosis";

/**
 * Platform administration (§9, §9c) — the box, not the kitchen.
 *
 * Everything on this screen is about who can get into a household: its
 * members, their roles, the invitations that might grow the installation by
 * one more household, and a record of every time somebody outside a
 * household reached into it. None of the API routes behind this page will
 * hand back a recipe, a plan, a shopping list or a receipt — that boundary is
 * enforced server-side (src/lib/platformAdmin.ts, and the select lists in
 * the /api/admin/* routes themselves), and this page doesn't try to work
 * around it or paper over the gap with a link to somewhere that would. A
 * platform admin who wants to know what a household eats has to be invited
 * into it, the same as anyone else.
 *
 * The 403 case is rendered rather than thrown: an account that is signed in
 * but not a platform admin is not an error, it is simply the ordinary shape
 * of almost every account on the box, and finding this URL by guessing or by
 * an old bookmark shouldn't look like something broke.
 */
export default function AdminPage() {
  const [forbidden, setForbidden] = useState(false);
  const [households, setHouseholds] = useState<Household[] | null>(null);
  const [invitations, setInvitations] = useState<PendingInvitation[] | null>(null);
  const [audit, setAudit] = useState<AuditEvent[] | null>(null);

  const loadHouseholds = useCallback(async () => {
    const res = await fetch("/api/admin/households");
    if (res.status === 403) {
      setForbidden(true);
      return false;
    }
    if (res.ok) setHouseholds(await res.json());
    return res.ok;
  }, []);

  const loadInvitations = useCallback(() => {
    fetch("/api/admin/invitations")
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => body && setInvitations(body))
      .catch(() => {});
  }, []);

  const loadAudit = useCallback(() => {
    fetch("/api/admin/audit")
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => body && setAudit(body))
      .catch(() => {});
  }, []);

  useEffect(() => {
    // Households first, because its 403 is what decides whether the rest of
    // the screen is worth fetching at all — an account that can't see the
    // roster can't act on an invitation or an audit line either, and there's
    // no reason to make three round trips just to discover the same "no".
    loadHouseholds().then((ok) => {
      if (ok) {
        loadInvitations();
        loadAudit();
      }
    });
  }, [loadHouseholds, loadInvitations, loadAudit]);

  if (forbidden) {
    return (
      <>
        <h1>Admin</h1>
        <div className="card">
          <p>This is not your installation to administer.</p>
          <p className="muted">
            Platform administration is separate from running a household — it belongs to whoever
            operates this box, not to any one kitchen's admin. If you think that should be you,
            ask whoever set the installation up.
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      <h1>Admin</h1>
      <p className="muted">
        This screen shows who can get into a household — never what's in one. No recipe, plan,
        shopping list or receipt is reachable from here; that's true for every household on this
        box, including your own if you're a member of one.
      </p>

      <HouseholdsSection households={households} reload={loadHouseholds} />
      <InvitationsSection invitations={invitations} reload={loadInvitations} />
      <AuditSection events={audit} />
    </>
  );
}

// -----------------------------------------------------------------------------
// Households

interface Member {
  id: string;
  email: string;
  name: string | null;
  role: "ADMIN" | "MEMBER";
  joinedAt: string;
  lastLoginAt: string | null;
}

interface Household {
  id: string;
  name: string;
  createdAt: string;
  members: Member[];
  adminCount: number;
  strandedWithoutAdmin: boolean;
}

function HouseholdsSection({
  households,
  reload,
}: {
  households: Household[] | null;
  reload: () => void;
}) {
  // Keyed by `${householdId}:${userId}` because the same person can belong to
  // more than one household under multi-household ownership, and a mistake
  // here — flashing the wrong row's error, or disabling the wrong row's
  // buttons while a request is in flight — would be exactly the kind of
  // cross-household mix-up this screen has to be careful never to cause.
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  function label(m: Member): string {
    return m.name ? `${m.name} (${m.email})` : m.email;
  }

  async function setRole(household: Household, member: Member, role: "ADMIN" | "MEMBER") {
    if (
      !confirm(
        role === "ADMIN"
          ? `Make ${label(member)} an admin of ${household.name}?`
          : `Make ${label(member)} an ordinary member of ${household.name}? They'll lose admin rights there.`,
      )
    ) {
      return;
    }
    const key = `${household.id}:${member.id}`;
    setBusy(key);
    setErrors((e) => ({ ...e, [key]: "" }));
    try {
      const res = await fetch(`/api/admin/households/${household.id}/members`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: member.id, role }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrors((e) => ({
          ...e,
          [key]:
            body.error === "last-admin"
              ? `${label(member)} is the only admin ${household.name} has left — demoting them would leave nobody able to run it. Make someone else admin first, or remove them instead if the household is being wound down.`
              : body.error === "not-a-member"
                ? "They're no longer in this household — the list below is out of date."
                : "That didn't go through.",
        }));
        reload();
        return;
      }
      reload();
    } finally {
      setBusy(null);
    }
  }

  async function remove(household: Household, member: Member) {
    if (
      !confirm(
        `Remove ${label(member)} from ${household.name}? This only ends their membership — the household's plan, recipes and spending stay exactly as they are, and nothing about their account elsewhere on this box changes.`,
      )
    ) {
      return;
    }
    const key = `${household.id}:${member.id}`;
    setBusy(key);
    setErrors((e) => ({ ...e, [key]: "" }));
    try {
      const res = await fetch(
        `/api/admin/households/${household.id}/members?userId=${encodeURIComponent(member.id)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        setErrors((e) => ({ ...e, [key]: "That didn't go through." }));
      }
      reload();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card">
      <h2>Households</h2>
      {households === null ? (
        <p className="muted">Loading…</p>
      ) : households.length === 0 ? (
        <p className="muted">No households exist on this installation yet.</p>
      ) : (
        households.map((household) => (
          <div
            key={household.id}
            style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--border)" }}
          >
            <p style={{ margin: 0 }}>
              <strong>{household.name}</strong>{" "}
              <span className="muted" style={{ fontSize: "0.85em" }}>
                created {formatDate(household.createdAt)} ·{" "}
                {household.members.length === 1
                  ? "1 member"
                  : `${household.members.length} members`}
              </span>
            </p>

            {household.strandedWithoutAdmin && (
              <div
                style={{
                  marginTop: 8,
                  padding: "8px 10px",
                  border: "1px solid var(--border)",
                  borderLeft: "3px solid var(--accent)",
                  borderRadius: 8,
                  background: "var(--bg)",
                }}
              >
                <p style={{ margin: 0, fontWeight: 600, color: "var(--accent)" }}>
                  Nobody here can administer this household.
                </p>
                <p className="muted" style={{ margin: "4px 0 0 0", fontSize: "0.9em" }}>
                  Every member lost admin rights, or left. Make one of the members below an admin
                  to give the household a way to manage itself again.
                </p>
              </div>
            )}

            <ul style={{ listStyle: "none", padding: 0, marginTop: 10 }}>
              {household.members.map((m) => {
                const key = `${household.id}:${m.id}`;
                return (
                  <li
                    key={m.id}
                    style={{
                      padding: "6px 0",
                      borderBottom: "1px solid var(--border)",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                      <span>
                        {m.name ? `${m.name} ` : ""}
                        <span className="muted">{m.email}</span>
                      </span>
                      <span className="muted" style={{ fontSize: "0.8em" }}>
                        {m.role === "ADMIN" ? "admin" : "member"} · joined {formatDate(m.joinedAt)} ·{" "}
                        {m.lastLoginAt ? `last in ${formatDate(m.lastLoginAt)}` : "never signed in"}
                      </span>
                      <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                        <button
                          className="muted"
                          style={{ fontSize: "0.85em" }}
                          disabled={busy === key}
                          onClick={() => setRole(household, m, m.role === "ADMIN" ? "MEMBER" : "ADMIN")}
                        >
                          {m.role === "ADMIN" ? "make ordinary member" : "make admin"}
                        </button>
                        <button
                          className="muted"
                          style={{ fontSize: "0.85em" }}
                          disabled={busy === key}
                          onClick={() => remove(household, m)}
                        >
                          remove from household
                        </button>
                      </span>
                    </div>
                    {errors[key] && (
                      <p style={{ color: "var(--accent)", margin: "4px 0 0 0", fontSize: "0.85em" }}>
                        {errors[key]}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Invitations to start a household

interface PendingInvitation {
  id: string;
  email: string;
  invitedName: string | null;
  kind: "HOUSEHOLD" | "PLATFORM";
  invitedBy: string | null;
  expiresAt: string;
  createdAt: string;
}

function InvitationsSection({
  invitations,
  reload,
}: {
  invitations: PendingInvitation[] | null;
  reload: () => void;
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [householdName, setHouseholdName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
  const [undelivered, setUndelivered] = useState<{ email: string; url: string } | null>(null);
  // Same situation as `undelivered`, but the address already has an
  // account, so the server withheld the link rather than handing this
  // admin a bearer credential for it — nothing to show or copy, only why.
  const [linkWithheld, setLinkWithheld] = useState<string | null>(null);
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNote(null);
    setDiagnosis(null);
    setUndelivered(null);
    setLinkWithheld(null);
    setCopied(null);
    setBusy(true);
    try {
      const res = await fetch("/api/admin/invitations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          name: name || undefined,
          householdName: householdName || undefined,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (body.error === "mail-failed") {
          // As on the household card: the invitation was created regardless
          // of whether the mail describing it could be sent, so this is a
          // diagnosis of the mail server, not a reason to say the invite
          // failed.
          setDiagnosis({ summary: body.summary, hint: body.hint, detail: body.detail });
          reload();
          return;
        }
        setError(body.error === "invalid-email" ? "That doesn't look like an email address." : "Couldn't send that invitation.");
        return;
      }
      if (body.delivered) {
        setNote(`Invitation sent to ${body.invitation.email}.`);
      } else if (body.linkWithheld) {
        setLinkWithheld(body.invitation.email);
      } else {
        setUndelivered({ email: body.invitation.email, url: body.inviteUrl });
      }
      setEmail("");
      setName("");
      setHouseholdName("");
      reload();
    } finally {
      setBusy(false);
    }
  }

  async function withdraw(inv: PendingInvitation) {
    if (
      !confirm(`Withdraw the invitation to ${inv.email}? The link will stop working right away.`)
    ) {
      return;
    }
    const res = await fetch(`/api/admin/invitations?id=${inv.id}`, { method: "DELETE" });
    if (!res.ok) {
      // A 409 here means the invitation was already accepted or withdrawn
      // from elsewhere — the honest response is to refresh the list, not to
      // report a failure for something that's already happened.
      reload();
      return;
    }
    reload();
  }

  async function copyInvite(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied("yes");
    } catch {
      setCopied("no");
    }
  }

  return (
    <div className="card">
      <h2>Invitations to start a household</h2>
      <p className="muted">
        This is the one thing that grows the installation — a household admin can bring somebody
        into their own kitchen, but only this can hand somebody a kitchen of their own. Accepting
        makes them its first admin and gives them nothing anywhere else.
      </p>

      {invitations === null ? (
        <p className="muted">Loading…</p>
      ) : invitations.length === 0 ? (
        <p className="muted">Nothing outstanding.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {invitations.map((inv) => (
            <li
              key={inv.id}
              style={{
                padding: "6px 0",
                borderBottom: "1px solid var(--border)",
                display: "flex",
                alignItems: "baseline",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <span>
                {inv.invitedName ? `${inv.invitedName} ` : ""}
                <span className="muted">{inv.email}</span>
              </span>
              <span className="muted" style={{ fontSize: "0.8em" }}>
                invited by {inv.invitedBy ?? "someone no longer here"} · {expiryLabel(inv.expiresAt)}
              </span>
              <button
                className="muted"
                onClick={() => withdraw(inv)}
                style={{ fontSize: "0.85em", marginLeft: "auto" }}
              >
                withdraw
              </button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={invite} style={{ marginTop: 12 }}>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="their@email.example"
          required
          style={{ minWidth: 200 }}
        />{" "}
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" />{" "}
        <input
          value={householdName}
          onChange={(e) => setHouseholdName(e.target.value)}
          placeholder="Suggested household name (optional)"
          style={{ minWidth: 220 }}
        />{" "}
        <button type="submit" disabled={busy}>
          {busy ? "Sending…" : "Invite"}
        </button>
      </form>

      {note && <p className="muted">{note}</p>}
      {error && <p style={{ color: "var(--accent)" }}>{error}</p>}
      {diagnosis && <DiagnosisPanel d={diagnosis} />}

      {undelivered && (
        <div
          style={{
            marginTop: 10,
            padding: 10,
            border: "1px solid var(--border)",
            borderRadius: 6,
          }}
        >
          <p style={{ margin: "0 0 8px 0" }}>
            An invitation for {undelivered.email} was created, but email isn&apos;t set up on this
            instance, so nothing was sent — pass this link to them yourself. It lets them start a
            household, and it stops working in seven days.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input
              readOnly
              value={undelivered.url}
              onFocus={(e) => e.currentTarget.select()}
              style={{ flex: "1 1 260px", minWidth: 0 }}
            />
            <button type="button" onClick={() => copyInvite(undelivered.url)}>
              {copied === "yes" ? "Copied" : "Copy link"}
            </button>
          </div>
          {copied === "no" && (
            <p className="muted" style={{ margin: "6px 0 0 0", fontSize: "0.85em" }}>
              This browser wouldn&apos;t let the page reach the clipboard. Select the link above and
              copy it yourself.
            </p>
          )}
        </div>
      )}

      {linkWithheld && (
        <div
          style={{
            marginTop: 10,
            padding: 10,
            border: "1px solid var(--border)",
            borderRadius: 6,
          }}
        >
          <p style={{ margin: 0 }}>
            An invitation for {linkWithheld} was created, but {linkWithheld} already has a
            MealPlanner account, and email isn&apos;t set up on this instance to deliver the link
            directly to them. For their protection, the link isn&apos;t shown here — anyone who
            saw it could sign in as their existing account, with no password. Set up SMTP and
            invite them again, and the link will go straight to their inbox instead.
          </p>
        </div>
      )}
    </div>
  );
}

/** "expires in 3 days", "expires today", or "lapsed" once the clock's run out. */
function expiryLabel(expiresAt: string): string {
  const msLeft = new Date(expiresAt).getTime() - Date.now();
  if (msLeft <= 0) return "lapsed";
  const days = Math.ceil(msLeft / (24 * 60 * 60 * 1000));
  return days <= 1 ? "expires today" : `expires in ${days} days`;
}

// -----------------------------------------------------------------------------
// Recent activity

interface AuditEvent {
  id: string;
  action: AuditAction;
  actorEmail: string | null;
  householdName: string | null;
  subjectEmail: string | null;
  detail: string;
  createdAt: string;
}

function AuditSection({ events }: { events: AuditEvent[] | null }) {
  return (
    <div className="card">
      <h2>Recent activity</h2>
      <p className="muted">
        Every intervention this screen can make is written down here, newest first. This is as
        much a record for whoever administers this box as it is a guard against doing something
        by accident — nothing here happens silently.
      </p>
      {events === null ? (
        <p className="muted">Loading…</p>
      ) : events.length === 0 ? (
        <p className="muted">Nothing has happened here yet.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {events.map((event) => (
            <li key={event.id} style={{ padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
              <p style={{ margin: 0 }}>{event.detail}</p>
              <p className="muted" style={{ margin: "2px 0 0 0", fontSize: "0.8em" }}>
                {event.actorEmail ?? "system"} · {formatDateTime(event.createdAt)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
