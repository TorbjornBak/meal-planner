"use client";

import { useEffect, useRef, useState } from "react";
import { AccountCard } from "./AccountCard";
import { HouseholdCard } from "./HouseholdCard";

// Settings (§4, §9) — household size (scales every recipe), your own account,
// and who else is in the household. The pantry list (§5) has its own page; all
// that lives here is the way in.

export default function SettingsPage() {
  const [householdSize, setHouseholdSize] = useState<number | "">("");
  const [savedSize, setSavedSize] = useState<number | null>(null);
  const [pantryCount, setPantryCount] = useState<number | null>(null);
  const [bookmarklet, setBookmarklet] = useState("");
  const bmRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s) => {
        setHouseholdSize(s.householdSize);
        setSavedSize(s.householdSize);
      });
    fetch("/api/pantry")
      .then((r) => r.json())
      .then((items) => setPantryCount(Array.isArray(items) ? items.length : null))
      .catch(() => {});
    fetch("/api/capture/info")
      .then((r) => r.json())
      .then((d) => {
        const origin = window.location.origin;
        const code = `javascript:(function(){var t=${JSON.stringify(
          d.token,
        )},b=${JSON.stringify(
          origin,
        )};fetch(b+'/api/capture',{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify({token:t,url:location.href,html:document.documentElement.outerHTML})}).then(function(r){return r.json()}).then(function(x){if(x&&x.id){if(confirm('Saved to MealPlanner. Open to review?'))location.href=b+'/recipes/'+x.id+'/edit'}else{alert('Capture failed: '+((x&&x.error)||'unknown'))}}).catch(function(e){alert('Capture failed: '+e)})})();`;
        setBookmarklet(code);
      });
  }, []);

  // React refuses to render a javascript: href, so set it imperatively.
  useEffect(() => {
    if (bmRef.current && bookmarklet) {
      bmRef.current.setAttribute("href", bookmarklet);
    }
  }, [bookmarklet]);

  async function saveSize() {
    if (householdSize === "" || householdSize < 1) return;
    const s = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ householdSize }),
    }).then((r) => r.json());
    setSavedSize(s.householdSize);
  }

  const dirty = householdSize !== "" && householdSize !== savedSize;

  return (
    <>
      <h1>Settings</h1>

      <div className="card">
        <h2>Household size</h2>
        <p className="muted">Every recipe scales from its stated servings to this.</p>
        <input
          type="number"
          min={1}
          value={householdSize}
          onChange={(e) =>
            setHouseholdSize(e.target.value === "" ? "" : Number(e.target.value))
          }
          style={{ width: 80 }}
        />{" "}
        <button onClick={saveSize} disabled={!dirty}>
          {dirty ? "Save" : "Saved"}
        </button>
      </div>

      <div className="card">
        <h2>Pantry — things we always have</h2>
        <p className="muted">
          Items matching these names get pulled out of the main shopping list into
          their own section.
        </p>
        <p>
          <a href="/pantry">
            {pantryCount === null
              ? "Open the pantry list"
              : pantryCount === 0
                ? "Add your first pantry item"
                : `${pantryCount} ${pantryCount === 1 ? "thing" : "things"} in the pantry`}{" "}
            →
          </a>
        </p>
      </div>

      <div className="card">
        <h2>Capture recipes from the web</h2>
        <p className="muted">
          Drag this button to your bookmarks bar. On a recipe page, click it — it
          sends the page to MealPlanner, which parses it and opens it for review.
          No copy-paste needed.
        </p>
        {bookmarklet ? (
          <p>
            {/* href set imperatively above (React blocks javascript: hrefs) */}
            <a
              ref={bmRef}
              onClick={(e) => e.preventDefault()}
              style={{
                display: "inline-block",
                padding: "6px 12px",
                border: "1px solid var(--border)",
                borderRadius: 8,
                background: "var(--card)",
                cursor: "grab",
              }}
            >
              📎 Save to MealPlanner
            </a>
          </p>
        ) : (
          <p className="muted">Loading…</p>
        )}
        <p className="muted" style={{ fontSize: "0.85em" }}>
          Generate this from your Tailscale <code>https://…ts.net</code> address so
          the button points at the right place and works from other sites.
        </p>
      </div>

      <AccountCard />
      <HouseholdCard />
    </>
  );
}
