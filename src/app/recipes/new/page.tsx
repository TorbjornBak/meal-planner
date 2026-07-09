"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface ParsedIngredient {
  name: string;
  quantity: number | null;
  unit: string | null;
}
interface ParsedRecipe {
  name: string;
  statedServings: number;
  ingredients: ParsedIngredient[];
}

// Paste-and-parse with the MANDATORY review-and-edit step (§1). Flow:
//   1. paste text → POST /api/parse → get structured draft
//   2. eyeball & correct the parsed ingredients (bad parse = wrong list)
//   3. save → POST /api/recipes
export default function NewRecipePage() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [draft, setDraft] = useState<ParsedRecipe | null>(null);
  const [busy, setBusy] = useState(false);

  async function parse() {
    setBusy(true);
    try {
      const res = await fetch("/api/parse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      setDraft(await res.json());
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
            Copy the recipe text from anywhere and paste it below. No scraping —
            you fetch it as a normal reader.
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
            Serves{" "}
            <input
              type="number"
              value={draft.statedServings}
              onChange={(e) =>
                setDraft({ ...draft, statedServings: Number(e.target.value) })
              }
              style={{ width: 64 }}
            />
          </label>

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

          <button onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save to library"}
          </button>
          {/* TODO: add/remove ingredient rows. */}
        </div>
      )}
    </>
  );
}
