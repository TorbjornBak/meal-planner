"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { isPublicPage } from "@/lib/publicPages";
import { AdminNavLink } from "@/components/AdminNavLink";
import { HouseholdSwitcher } from "@/components/HouseholdSwitcher";

/**
 * The app's nav bar, and the decision not to draw it.
 *
 * Every link in here goes somewhere that requires a session, so on a public
 * page the whole strip is a row of links that bounce you back to where you
 * already are. On the public internet the landing page is the first thing a
 * stranger sees,
 * and a nav bar full of Plan/Recipes/Shopping tells them this app is theirs to
 * poke at when none of it is.
 *
 * The pathname is the whole input, and it's the same predicate middleware
 * gates on (src/lib/publicPages.ts), so "no nav" and "no session needed" can
 * never come apart. usePathname resolves during the server render too, so the
 * nav is absent from the HTML rather than painted and then pulled back.
 *
 * A client component for that hook alone — this is what lets the root layout
 * stay a plain server component, the same bargain HouseholdSwitcher and
 * AdminNavLink already make.
 */
export function TopNav() {
  const pathname = usePathname();
  if (isPublicPage(pathname)) return null;

  return (
    <nav className="topnav">
      <Link href="/dashboard">Dashboard</Link>
      <Link href="/plan">Plan</Link>
      <Link href="/recipes">Recipes</Link>
      <Link href="/shopping">Shopping</Link>
      <Link href="/pantry">Pantry</Link>
      <Link href="/spending">Spending</Link>
      <Link href="/settings">Settings</Link>
      <AdminNavLink />
      <HouseholdSwitcher />
    </nav>
  );
}
