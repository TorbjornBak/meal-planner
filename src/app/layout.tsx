import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ServiceWorkerRegistrar } from "./sw-register";
import { TopNav } from "@/components/TopNav";

/**
 * Forces every page through per-request rendering rather than Next's static
 * optimization (Phase 6). This has nothing to do with session data — every
 * component in this tree that needs the session fetches it client-side
 * precisely so this layout can stay a plain server component (see the
 * docstrings on TopNav, HouseholdSwitcher and AdminNavLink) — and everything
 * to do with src/middleware.ts's CSP nonce. That nonce is minted fresh per request
 * and is only correct if the HTML Next emits for *this* request's inline
 * bootstrap script carries *this* request's nonce; a statically-generated
 * page would bake in whichever nonce happened to be current at build (or
 * first-request-cache) time and then mismatch the CSP header on every request
 * after that one, which is a CSP that silently breaks React hydration rather
 * than one that fails to build. Losing static optimization for a
 * behind-a-session app whose pages already fetch their own data client-side
 * costs little; a nonce that's sometimes wrong costs a broken app.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "MealPlanner",
  description: "Household dinners → shopping list → grocery spend.",
  // Lets the app be added to a phone's home screen and run chrome-light.
  appleWebApp: { capable: true, title: "MealPlanner", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#faf9f7",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <ServiceWorkerRegistrar />
        <TopNav />
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
