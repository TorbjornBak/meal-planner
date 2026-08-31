"use client";

import { useEffect, useState } from "react";

interface HouseholdOption {
  id: string;
  name: string;
  role: "ADMIN" | "MEMBER";
  newsletterOptIn: boolean;
  active: boolean;
}

/**
 * Which household you're acting in, when there's more than one to choose (§9).
 *
 * Renders nothing for the overwhelming majority of accounts, which belong to
 * exactly one household and have never seen an invitation to a second — the
 * empty case isn't a loading state or an error, it's the ordinary one, and
 * the nav bar should look exactly as it always has for them. It only earns
 * its place once GET /api/households reports two or more.
 *
 * Mounted from the root layout, which is a server component with no session
 * of its own; this fetches its own data instead of receiving it as a prop, so
 * a public page — where there is no session at all — gets a 401 back and
 * quietly renders nothing rather than throwing in the middle of the nav.
 */
export function HouseholdSwitcher() {
  const [households, setHouseholds] = useState<HouseholdOption[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    fetch("/api/households")
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { activeId: string; households: HouseholdOption[] } | null) => {
        if (!body) return;
        setHouseholds(body.households);
        setActiveId(body.activeId);
      })
      .catch(() => {});
  }, []);

  async function select(id: string) {
    if (id === activeId) return;
    setSwitching(true);
    // Optimistic: the select already shows the choice the person just made,
    // and a failed switch is rare enough (the household would have to have
    // just removed them) that reverting on error beats freezing the control
    // until the round trip finishes.
    const previous = activeId;
    setActiveId(id);
    try {
      const res = await fetch("/api/households/select", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ householdId: id }),
      });
      if (!res.ok) {
        setActiveId(previous);
        setSwitching(false);
        return;
      }
      // A full reload rather than router.refresh(). Nearly every screen in
      // this app is a client component that fetched its plan, its list or its
      // ledger once in a useEffect; refreshing only re-runs the server
      // components above them, so the nav would say one household while the
      // page underneath still showed another's dinners. Switching kitchens is
      // rare and deliberate, and being certainly right is worth a reload.
      window.location.reload();
    } catch {
      setActiveId(previous);
      setSwitching(false);
    }
  }

  if (!households || households.length < 2) return null;

  return (
    <select
      value={activeId ?? ""}
      onChange={(e) => select(e.target.value)}
      disabled={switching}
      aria-label="Active household"
      style={{
        marginLeft: "auto",
        alignSelf: "center",
        minHeight: "auto",
        padding: "0.3rem 0.5rem",
        fontSize: "0.9rem",
        borderRadius: 8,
        border: "1px solid var(--border)",
        background: "var(--card)",
        color: "var(--fg)",
      }}
    >
      {households.map((h) => (
        <option key={h.id} value={h.id}>
          {h.name}
        </option>
      ))}
    </select>
  );
}
