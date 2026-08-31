"use client";

import { useEffect, useRef, useState } from "react";
import { AccountCard } from "./AccountCard";
import { BackupCard } from "./BackupCard";
import { HouseholdCard } from "./HouseholdCard";

// Settings (§4, §9, §11) — household size (scales every recipe), your own
// account, who else is in the household, and whether any of it is backed up.
// The pantry list (§5) has its own page; all that lives here is the way in.

export default function SettingsPage() {
  const [householdSize, setHouseholdSize] = useState<number | "">("");
  const [savedSize, setSavedSize] = useState<number | null>(null);
  const [pantryCount, setPantryCount] = useState<number | null>(null);
  const [bookmarklet, setBookmarklet] = useState("");
  const bmRef = useRef<HTMLAnchorElement>(null);
  // Recipe library transfer (§2, §11). `importBusy` guards the double-click;
  // the two message slots are kept apart because a failed import and a
  // successful one that skipped everything read very differently.
  const fileRef = useRef<HTMLInputElement>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [importErr, setImportErr] = useState<string | null>(null);

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
        const code = `javascript:(function(){var h=${JSON.stringify(
          d.householdId,
        )},t=${JSON.stringify(
          d.token,
        )},b=${JSON.stringify(
          origin,
        )};fetch(b+'/api/capture',{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify({householdId:h,token:t,url:location.href,html:document.documentElement.outerHTML})}).then(function(r){return r.json()}).then(function(x){if(x&&x.id){if(confirm('Saved to MealPlanner. Open to review?'))location.href=b+'/recipes/'+x.id+'/edit'}else{alert('Capture failed: '+((x&&x.error)||'unknown'))}}).catch(function(e){alert('Capture failed: '+e)})})();`;
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

  async function importLibrary(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || importBusy) return;

    setImportBusy(true);
    setImportMsg(null);
    setImportErr(null);
    try {
      // Parsed here as well as on the server so a file that was never JSON
      // fails on this side of the network, where the answer is instant.
      let body: unknown;
      try {
        body = JSON.parse(await file.text());
      } catch {
        setImportErr(
          "That file isn't valid JSON, so nothing in it could be read. If you edited it by hand, a missing comma or bracket is the usual cause.",
        );
        return;
      }

      const res = await fetch("/api/recipes/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);

      if (!res.ok) {
        // The server explains itself in a sentence; passing it through beats
        // paraphrasing it into something vaguer.
        setImportErr(
          data?.error ??
            "The import didn't go through, and the server didn't say why. Nothing was changed.",
        );
        return;
      }

      const { imported = 0, skipped = 0, skippedNames = [] } = data ?? {};
      const parts: string[] = [
        imported === 0
          ? "Nothing new to import."
          : `Imported ${imported} ${imported === 1 ? "recipe" : "recipes"}.`,
      ];
      if (skipped) {
        const names = (skippedNames as string[]).join(", ");
        parts.push(
          `${skipped} already in the library ${skipped === 1 ? "was" : "were"} skipped` +
            (names ? `: ${names}${skipped > skippedNames.length ? ", …" : ""}.` : "."),
        );
      }
      setImportMsg(parts.join(" "));
    } catch {
      setImportErr("Couldn't reach the server — nothing was imported.");
    } finally {
      setImportBusy(false);
      // Cleared so picking the *same* file again still fires a change event —
      // the obvious thing to do after fixing a rejected file is to re-pick it.
      if (fileRef.current) fileRef.current.value = "";
    }
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

      <div className="card">
        <h2>Recipe library — export and import</h2>
        <p className="muted">
          Save every recipe to a single JSON file you can read, keep, or send to
          another household. Importing adds the recipes in a file to this library;
          anything already here is skipped rather than duplicated.
        </p>
        <p>
          {/* A plain link: the route answers with Content-Disposition, so the
              browser saves it under a dated name without any script here. */}
          <a href="/api/recipes/export">Export the library →</a>
        </p>
        <p>
          <label>
            <span className="muted">Import a file: </span>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              disabled={importBusy}
              onChange={importLibrary}
            />
          </label>
        </p>
        {importBusy && <p className="muted">Importing…</p>}
        {importMsg && <p>{importMsg}</p>}
        {importErr && <p style={{ color: "var(--accent)" }}>{importErr}</p>}
        <p className="muted" style={{ fontSize: "0.85em" }}>
          Photos aren't included — they're stored as raw image data (§2b), and
          packing them in would turn a file you can open in a text editor into
          tens of megabytes. Everything else travels: ingredients, method, tags,
          servings and cook times.
        </p>
      </div>

      <AccountCard />
      <HouseholdCard />
      <BackupCard />
    </>
  );
}
