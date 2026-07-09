import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "MealPlanner",
  description: "Household dinners → shopping list → grocery spend.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
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
