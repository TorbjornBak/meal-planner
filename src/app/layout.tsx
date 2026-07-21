import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";
import { ServiceWorkerRegistrar } from "./sw-register";

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
        <nav className="topnav">
          <Link href="/">Dashboard</Link>
          <Link href="/plan">Plan</Link>
          <Link href="/recipes">Recipes</Link>
          <Link href="/shopping">Shopping</Link>
          <Link href="/spending">Spending</Link>
          <Link href="/settings">Settings</Link>
        </nav>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
