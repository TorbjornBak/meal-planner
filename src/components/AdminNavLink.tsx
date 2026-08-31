"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

/**
 * The nav's only trace of platform administration (§9c).
 *
 * Everyone else — every household member, admin included — must see the same
 * nav bar they always have; this link exists to be invisible to them, not to
 * be styled differently for them. It piggybacks on GET /api/account, which
 * every signed-in page already calls somewhere, rather than adding a second
 * route only this component would ever hit.
 *
 * Mounted from the root layout, a server component with no session of its
 * own, for the same reason as HouseholdSwitcher: a public page has no session
 * at all, and a 401 here just means "nothing to show", not an error worth
 * surfacing in the middle of the nav.
 */
export function AdminNavLink() {
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);

  useEffect(() => {
    fetch("/api/account")
      .then((r) => (r.ok ? r.json() : null))
      .then((a: { isPlatformAdmin?: boolean } | null) => {
        if (a?.isPlatformAdmin) setIsPlatformAdmin(true);
      })
      .catch(() => {});
  }, []);

  if (!isPlatformAdmin) return null;

  return <Link href="/admin">Admin</Link>;
}
