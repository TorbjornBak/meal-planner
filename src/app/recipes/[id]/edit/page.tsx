"use client";

import { use, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { MAX_IMAGE_BYTES } from "@/lib/recipeImage";

// Full recipe editor (§2). Edit name, source, servings, ingredients (add/remove
// rows), the method, and the photo. Backed by PATCH /api/recipes/[id] and
// /api/recipes/[id]/image.

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

  // Photo state is separate from the form: it saves immediately rather than on
  // "Save changes", because it's a binary body, not part of the JSON PATCH.
  const [hasPhoto, setHasPhoto] = useState(false);
  const [photoBusy, setPhotoBusy] = useState<null | "upload" | "source">(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  // Bumped after every change so the browser re-requests the (cached) photo URL.
  const [photoVersion, setPhotoVersion] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch(`/api/recipes/${id}`)
      .then((r) => r.json())
      .then((r) => {
        setHasPhoto(Boolean(r.imageMime || r.imageUrl));
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
        });
      });
  }, [id]);

  async function uploadPhoto(file: File) {
    setPhotoError(null);
    if (file.size > MAX_IMAGE_BYTES) {
      setPhotoError(
        `That image is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is ${
          MAX_IMAGE_BYTES / 1024 / 1024
        } MB.`,
      );
      return;
    }
    setPhotoBusy("upload");
    try {
      const res = await fetch(`/api/recipes/${id}/image`, {
        method: "POST",
        headers: { "content-type": file.type },
        body: file,
      });
      if (!res.ok) {
        setPhotoError(
          res.status === 415
            ? "That file type isn't supported — use JPEG, PNG, WebP or GIF."
            : "Couldn't save that image.",
        );
        return;
      }
      setHasPhoto(true);
      setPhotoVersion((v) => v + 1);
    } finally {
      setPhotoBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function fetchPhotoFromSource() {
    setPhotoError(null);
    setPhotoBusy("source");
    try {
      const res = await fetch(`/api/recipes/${id}/image`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!res.ok) {
        setPhotoError(
          "Couldn't find a photo on the source page — add one from your device instead.",
        );
        return;
      }
      setHasPhoto(true);
      setPhotoVersion((v) => v + 1);
    } finally {
      setPhotoBusy(null);
    }
  }

  async function removePhoto() {
    setPhotoError(null);
    setHasPhoto(false);
    setPhotoVersion((v) => v + 1);
    await fetch(`/api/recipes/${id}/image`, { method: "DELETE" });
  }

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
        <h2>Photo</h2>
        {hasPhoto ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/recipes/${id}/image?v=${photoVersion}`}
            alt=""
            className="recipe-hero"
          />
        ) : (
          <p className="muted">
            No photo yet. Captured recipes pick one up from the source page
            automatically.
          </p>
        )}

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) uploadPhoto(file);
            }}
            disabled={photoBusy !== null}
            style={{ maxWidth: "100%" }}
          />
          <button
            onClick={fetchPhotoFromSource}
            disabled={photoBusy !== null || !form.source}
            title={
              form.source
                ? "Download the photo the source page uses"
                : "Add a source link first"
            }
          >
            {photoBusy === "source" ? "Fetching…" : "Fetch from source"}
          </button>
          {hasPhoto && (
            <button className="muted" onClick={removePhoto} disabled={photoBusy !== null}>
              Remove photo
            </button>
          )}
        </div>
        {photoBusy === "upload" && <p className="muted">Uploading…</p>}
        {photoError && (
          <p className="muted" style={{ color: "var(--accent)" }}>
            {photoError}
          </p>
        )}
      </div>

      <div className="card">
        <h2>Ingredients</h2>
        <div style={{ overflowX: "auto" }}>
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
        </div>
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
