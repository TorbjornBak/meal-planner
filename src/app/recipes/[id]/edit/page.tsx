"use client";

import { use, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { estimateTotalMinutes } from "@/lib/durations";
import { MAX_IMAGE_BYTES } from "@/lib/recipeImage";

// Full recipe editor (§2). Edit name, source, servings, ingredients (add/remove
// rows), the method, and the photo. Backed by PATCH /api/recipes/[id] and
// /api/recipes/[id]/image.

interface Ingredient {
  name: string;
  quantity: number | null;
  unit: string | null;
}
/**
 * The typed total time, cleaned into what the API accepts: whole positive
 * minutes, or null for "nobody has said". A blank box, a zero and a stray
 * decimal all mean the same thing here — no claim — and clearing the field is
 * a legitimate edit, not an error to swallow.
 */
function minutesFromInput(value: string): number | null {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? n : null;
}

interface RecipeForm {
  name: string;
  source: string | null;
  instructions: string | null;
  statedServings: number;
  /** Minutes, or null when nobody has said (§2). */
  totalTimeMinutes: number | null;
  /** Whether that number is our sum of the step timers rather than a stated
   *  time. Carried through the form so saving an untouched recipe doesn't
   *  quietly promote an estimate into a fact. */
  totalTimeIsEstimate: boolean;
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
          totalTimeMinutes: r.totalTimeMinutes,
          totalTimeIsEstimate: r.totalTimeIsEstimate,
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

  /**
   * Fill the time in from the step timers in the method (§2), flagged as the
   * estimate it is. Recomputed from the textarea as you edit it, so rewriting
   * the method offers you an updated number instead of leaving a stale one.
   */
  function useMethodEstimate() {
    if (!form || methodEstimate == null) return;
    setForm({ ...form, totalTimeMinutes: methodEstimate, totalTimeIsEstimate: true });
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

  const methodEstimate = estimateTotalMinutes(form.instructions);

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
          <label>
            Total time{" "}
            <input
              type="number"
              min={1}
              value={form.totalTimeMinutes ?? ""}
              onChange={(e) =>
                setForm({
                  ...form,
                  totalTimeMinutes: minutesFromInput(e.target.value),
                  // A time somebody typed is a time somebody meant: a hand
                  // edit promotes the value out of "estimate", so the recipe
                  // page stops hedging it with "about" (§1 — review and
                  // correct beats whatever we parsed).
                  totalTimeIsEstimate: false,
                })
              }
              style={{ width: 72 }}
            />{" "}
            min
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
        {/*
          Where the number came from, said out loud, plus a way to get one for
          the recipes that arrived without one (anything pasted as text, and
          any page that declared no time). The sum is offered rather than
          applied here: on the edit page you are the one deciding, and an
          estimate you asked for is easier to trust than one that appeared.
        */}
        {form.totalTimeIsEstimate && form.totalTimeMinutes != null && (
          <p className="muted" style={{ marginTop: 8 }}>
            Shown as “about {form.totalTimeMinutes} min” — our sum of the times in
            the method, which usually runs long because steps overlap. Type a
            time to state it outright.
          </p>
        )}
        {methodEstimate != null && methodEstimate !== form.totalTimeMinutes && (
          <p className="muted" style={{ marginTop: 8 }}>
            <button className="muted" onClick={useMethodEstimate}>
              Estimate from the method (~{methodEstimate} min)
            </button>
          </p>
        )}
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
