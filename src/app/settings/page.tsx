"use client";

import { useEffect, useRef, useState } from "react";
import { bookmarkletForOrigin } from "@/lib/bookmarkImport";
import { runPhotoPass } from "@/lib/photoPass";
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
  const [bookmarkletCopyStatus, setBookmarkletCopyStatus] = useState<string | null>(null);
  const bmRef = useRef<HTMLAnchorElement>(null);
  // Recipe library transfer (§2, §11). `importBusy` guards the double-click;
  // the two message slots are kept apart because a failed import and a
  // successful one that skipped everything read very differently.
  const fileRef = useRef<HTMLInputElement>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [importErr, setImportErr] = useState<string | null>(null);
  const [photoPass, setPhotoPass] = useState<{
    done: number;
    total: number;
    found: number;
  } | null>(null);

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
    setBookmarklet(bookmarkletForOrigin(window.location.origin));
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

  async function copyBookmarklet() {
    try {
      await navigator.clipboard.writeText(bookmarklet);
      setBookmarkletCopyStatus("Bookmarklet code copied.");
    } catch {
      setBookmarkletCopyStatus("Couldn't copy it automatically. Try dragging the button instead.");
    }
  }

  async function importLibrary(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || importBusy) return;

    setImportBusy(true);
    setImportMsg(null);
    setImportErr(null);
    setPhotoPass(null);
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

      const { imported = 0, skipped = 0, skippedNames = [], photoTargets = [] } = data ?? {};
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

      const targets = Array.isArray(photoTargets)
        ? photoTargets.filter((id): id is string => typeof id === "string")
        : [];
      if (targets.length) {
        const found = await runPhotoPass(
          targets,
          async (id) => {
            const res = await fetch(`/api/recipes/${id}/image`, {
              method: "POST",
              // A non-image body tells this route to use the recipe's source.
              headers: { "content-type": "application/json" },
              body: "{}",
            });
            return res.ok;
          },
          setPhotoPass,
        );
        setPhotoPass(null);
        setImportMsg(`${parts.join(" ")} ${describePhotos(found, targets.length)}`);
      }
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
        <h2>Save recipes from the web</h2>
        <p className="muted">
          Drag this button to your bookmarks bar. On a recipe page, click it — it
          opens the link in MealPlanner, which fetches it and opens the recipe for
          review. No copy-paste needed.
        </p>
        {bookmarklet ? (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {/* href set imperatively above (React blocks javascript: hrefs) */}
            <a
              ref={bmRef}
              onClick={(e) => e.preventDefault()}
              aria-label="Save to MealPlanner bookmarklet. Drag it to the bookmarks bar."
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
            <button type="button" onClick={copyBookmarklet}>
              Copy bookmarklet code
            </button>
          </div>
        ) : (
          <p className="muted">Loading…</p>
        )}
        {bookmarkletCopyStatus && <p role="status">{bookmarkletCopyStatus}</p>}
        <p className="muted" style={{ fontSize: "0.85em" }}>
          The button points to this MealPlanner address. Drag a fresh copy if the
          app ever moves to a different domain. On a keyboard-only device, copy
          the code and paste it into a new bookmark&rsquo;s address field.
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
        {importBusy && !photoPass && <p className="muted">Importing…</p>}
        {importMsg && <p>{importMsg}</p>}
        {photoPass && (
          <p className="muted">
            Fetching photos from the source pages — {photoPass.done} of {photoPass.total} tried,
            {" "}{photoPass.found} found. The recipes are already saved; any missing photo can be
            added on the recipe itself.
          </p>
        )}
        {importErr && <p style={{ color: "var(--accent)" }}>{importErr}</p>}
        <p className="muted" style={{ fontSize: "0.85em" }}>
          Photos aren't included in the file — they're stored as raw image data (§2b), and
          packing them in would turn a file you can open in a text editor into tens of megabytes.
          Recipes with a web link as their source have their photo fetched from that page afterwards.
          Everything else travels: ingredients, method, tags, servings and cook times.
        </p>
      </div>

      <AccountCard />
      <HouseholdCard />
      <BackupCard />
    </>
  );
}

function describePhotos(found: number, tried: number): string {
  if (found === 0) {
    return `No photos could be fetched from the ${tried} source ${
      tried === 1 ? "page" : "pages"
    } — you can add pictures on each recipe.`;
  }
  if (found === tried) {
    return `Fetched ${found} ${found === 1 ? "photo" : "photos"} from the source pages.`;
  }
  return `Fetched ${found} of ${tried} photos from the source pages; the rest can be added on the recipe.`;
}
