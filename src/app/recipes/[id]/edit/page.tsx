"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

// Full recipe editor (§2). Edit name, source, servings, ingredients (add/remove
// rows), and the method. Backed by PATCH /api/recipes/[id].

interface Ingredient {
  name: string;
  quantity: number | null;
  unit: string | null;
}
interface RecipeForm {
  name: string;
  source: string | null;
  instructions: string | null;
  statedServings: number;
  ingredients: Ingredient[];
}

export default function EditRecipePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [form, setForm] = useState<RecipeForm | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`/api/recipes/${id}`)
      .then((r) => r.json())
      .then((r) =>
        setForm({
          name: r.name,
          source: r.source,
          instructions: r.instructions,
          statedServings: r.statedServings,
          ingredients: r.ingredients.map((i: Ingredient) => ({
            name: i.name,
            quantity: i.quantity,
            unit: i.unit,
          })),
        }),
      );
  }, [id]);

  function editIngredient(i: number, patch: Partial<Ingredient>) {
    if (!form) return;
    setForm({
      ...form,
      ingredients: form.ingredients.map((ing, idx) =>
        idx === i ? { ...ing, ...patch } : ing,
      ),
    });
  }
  function addRow() {
    if (!form) return;
    setForm({ ...form, ingredients: [...form.ingredients, { name: "", quantity: null, unit: null }] });
  }
  function removeRow(i: number) {
    if (!form) return;
    setForm({ ...form, ingredients: form.ingredients.filter((_, idx) => idx !== i) });
  }

  async function save() {
    if (!form) return;
    setBusy(true);
    try {
      await fetch(`/api/recipes/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...form,
          // Drop blank ingredient rows.
          ingredients: form.ingredients.filter((ing) => ing.name.trim()),
        }),
      });
      router.push(`/recipes/${id}`);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (!form) return <p className="muted">Loading…</p>;

  return (
    <>
      <p>
        <Link href={`/recipes/${id}`}>← Cancel</Link>
      </p>
      <h1>Edit recipe</h1>

      <div className="card">
        <label>
          Name
          <br />
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            style={{ width: "100%" }}
          />
        </label>
        <div style={{ marginTop: 8, display: "flex", gap: 16, flexWrap: "wrap" }}>
          <label>
            Serves{" "}
            <input
              type="number"
              min={1}
              value={form.statedServings}
              onChange={(e) => setForm({ ...form, statedServings: Number(e.target.value) })}
              style={{ width: 64 }}
            />
          </label>
          <label style={{ flex: 1 }}>
            Source link{" "}
            <input
              value={form.source ?? ""}
              onChange={(e) => setForm({ ...form, source: e.target.value || null })}
              placeholder="https://…"
              style={{ width: "70%" }}
            />
          </label>
        </div>
      </div>

      <div className="card">
        <h2>Ingredients</h2>
        <table style={{ width: "100%" }}>
          <thead>
            <tr>
              <th align="left">Ingredient</th>
              <th align="left">Qty</th>
              <th align="left">Unit</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {form.ingredients.map((ing, i) => (
              <tr key={i}>
                <td>
                  <input
                    value={ing.name}
                    onChange={(e) => editIngredient(i, { name: e.target.value })}
                    style={{ width: "100%" }}
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
                    onChange={(e) => editIngredient(i, { unit: e.target.value || null })}
                    style={{ width: 80 }}
                  />
                </td>
                <td>
                  <button className="muted" onClick={() => removeRow(i)}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button className="muted" onClick={addRow}>
          + Add ingredient
        </button>
      </div>

      <div className="card">
        <h2>Method</h2>
        <textarea
          value={form.instructions ?? ""}
          onChange={(e) => setForm({ ...form, instructions: e.target.value || null })}
          rows={12}
          style={{ width: "100%" }}
          placeholder="Method / steps…"
        />
      </div>

      <button onClick={save} disabled={busy}>
        {busy ? "Saving…" : "Save changes"}
      </button>
    </>
  );
}
