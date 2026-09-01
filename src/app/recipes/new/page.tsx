"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  DEFAULT_RECIPE_KIND,
  RECIPE_KINDS,
  kindLabel,
  yieldNoun,
  type RecipeKind,
} from "@/lib/recipeKind";
import {
  RECIPE_CATEGORIES,
  UNCATEGORISED_LABEL,
  categoryHint,
  categoryLabel,
  type RecipeCategory,
} from "@/lib/recipeCategory";

interface ParsedIngredient {
  name: string;
  quantity: number | null;
  unit: string | null;
}
interface ParsedRecipe {
  name: string;
  /**
   * Dinner or drink (§2c). The parser never says — nothing in a recipe page's
   * markup distinguishes a cortado from a casserole — so it is a choice made
   * here, in the review step that already exists for everything the parser
   * can't be trusted on.
   */
  kind: RecipeKind;
  /**
   * What it's made of (§2d), or null for "nobody has said". Null is the
   * default and stays the default: the parser can't tell a vegetarian lasagne
   * from a meat one, and this is the review step (§1), where the human
   * corrects what we couldn't know — not one where we guess first.
   */
  category: RecipeCategory | null;
  source: string | null;
  instructions: string | null;
  statedServings: number;
  ingredients: ParsedIngredient[];
}

// Add a recipe (§1). Two ways in, both ending in the MANDATORY review step:
//   - Fast path: paste a URL → POST /api/import (server fetches + parses) →
//     land on the edit page to review the saved draft.
//   - Fallback: paste text → POST /api/parse → review inline → POST /api/recipes.
// A bad parse means a wrong shopping list, so nothing skips the review.
export default function NewRecipePage() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [draft, setDraft] = useState<ParsedRecipe | null>(null);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  // Fast path: paste a URL, let the server fetch and parse the page, then land
  // on the edit page for the mandatory review-and-edit step. On failure (bot
  // wall, JS-only, paywall) it tells you to use the bookmarklet, which always
  // works because it's your real browser.
  async function importUrl() {
    setImporting(true);
    setImportError(null);
    try {
      const res = await fetch("/api/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setImportError(data.error ?? "Import failed.");
        return;
      }
      // `?new=1`: the import is saved but unreviewed, so the editor offers to
      // throw it away rather than only to go back. Fetching the wrong page
      // shouldn't leave a recipe behind.
      router.push(`/recipes/${data.id}/edit?new=1`);
    } catch {
      setImportError("Import failed — check the URL and try again.");
    } finally {
      setImporting(false);
    }
  }

  async function parse() {
    setBusy(true);
    try {
      const res = await fetch("/api/parse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      // The parser returns no kind, and defaulting it here rather than
      // server-side keeps /api/parse about reading text.
      setDraft({ kind: DEFAULT_RECIPE_KIND, category: null, ...(await res.json()) });
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    try {
      await fetch("/api/recipes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      router.push("/recipes");
    } finally {
      setBusy(false);
    }
  }

  function editIngredient(i: number, patch: Partial<ParsedIngredient>) {
    if (!draft) return;
    const ingredients = draft.ingredients.map((ing, idx) =>
      idx === i ? { ...ing, ...patch } : ing,
    );
    setDraft({ ...draft, ingredients });
  }

  return (
    <>
      <h1>Add a recipe</h1>

      {!draft && (
        <div className="card">
          <p className="muted">
            Paste a recipe page URL and we&apos;ll try to fetch it for you.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…"
              style={{ flex: 1, minWidth: 240 }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && url.trim() && !importing) importUrl();
              }}
            />
            <button onClick={importUrl} disabled={importing || !url.trim()}>
              {importing ? "Fetching…" : "Fetch from URL"}
            </button>
          </div>
          {importError && (
            <p className="muted" style={{ color: "var(--danger, #c00)", marginTop: 8 }}>
              {importError}
            </p>
          )}

          <p className="muted" style={{ marginTop: 16 }}>
            Or copy the recipe text and paste it below — if a site blocks the
            fetch above, this and the bookmarklet always work.
          </p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={12}
            style={{ width: "100%" }}
            placeholder="Paste recipe or plan text…"
          />
          <button onClick={parse} disabled={busy || !text.trim()}>
            {busy ? "Parsing…" : "Parse"}
          </button>
        </div>
      )}

      {draft && (
        <div className="card">
          <h2>Review &amp; edit</h2>
          <p className="muted">
            Correct anything the parser got wrong before saving — a bad parse
            means a wrong shopping list.
          </p>

          <label>
            Name{" "}
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <br />
          <label>
            This is a{" "}
            <select
              value={draft.kind}
              onChange={(e) =>
                setDraft({ ...draft, kind: e.target.value as RecipeKind })
              }
            >
              {RECIPE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {kindLabel(k).toLowerCase()}
                </option>
              ))}
            </select>
          </label>
          <br />
          <label>
            {/* Optional, and left unset unless somebody says. An answer we
                invented here would follow the recipe around every filter it
                ever appears in (§2d). */}
            Made of{" "}
            <select
              value={draft.category ?? ""}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  category: (e.target.value || null) as RecipeCategory | null,
                })
              }
            >
              <option value="">{UNCATEGORISED_LABEL.toLowerCase()}</option>
              {RECIPE_CATEGORIES.map((c) => (
                <option key={c} value={c} title={categoryHint(c)}>
                  {categoryLabel(c).toLowerCase()}
                </option>
              ))}
            </select>
          </label>
          <br />
          <label>
            {yieldNoun(draft.kind)}{" "}
            <input
              type="number"
              value={draft.statedServings}
              onChange={(e) =>
                setDraft({ ...draft, statedServings: Number(e.target.value) })
              }
              style={{ width: 64 }}
            />
          </label>
          <br />
          <label>
            Source link (optional){" "}
            <input
              value={draft.source ?? ""}
              onChange={(e) => setDraft({ ...draft, source: e.target.value || null })}
              placeholder="https://…"
              style={{ width: 320 }}
            />
          </label>

          <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", marginTop: 12 }}>
            <thead>
              <tr>
                <th align="left">Ingredient</th>
                <th align="left">Qty</th>
                <th align="left">Unit</th>
              </tr>
            </thead>
            <tbody>
              {draft.ingredients.map((ing, i) => (
                <tr key={i}>
                  <td>
                    <input
                      value={ing.name}
                      onChange={(e) => editIngredient(i, { name: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      value={ing.quantity ?? ""}
                      onChange={(e) =>
                        editIngredient(i, {
                          quantity: e.target.value === "" ? null : Number(e.target.value),
                        })
                      }
                      style={{ width: 64 }}
                    />
                  </td>
                  <td>
                    <input
                      value={ing.unit ?? ""}
                      onChange={(e) =>
                        editIngredient(i, { unit: e.target.value || null })
                      }
                      style={{ width: 80 }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>

          <label style={{ display: "block", marginTop: 12 }}>
            Instructions
            <textarea
              value={draft.instructions ?? ""}
              onChange={(e) =>
                setDraft({ ...draft, instructions: e.target.value || null })
              }
              rows={10}
              style={{ width: "100%", marginTop: 4 }}
              placeholder="Method / steps…"
            />
          </label>

          <button onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save to library"}
          </button>
          {/* TODO: add/remove ingredient rows. */}
        </div>
      )}
    </>
  );
}
