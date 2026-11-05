"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function RecipePhotoImport() {
  const router = useRouter();
  const [photos, setPhotos] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function scan() {
    setError("");
    if (photos.reduce((sum, f) => sum + f.size, 0) > 10 * 1024 * 1024) {
      setError("Photos must total less than 10 MB."); return;
    }
    setBusy(true);
    try {
      const body = new FormData();
      photos.forEach(photo => body.append("photos", photo));
      const response = await fetch("/api/recipes/scan", { method: "POST", body });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Scan failed.");
      router.push(`/recipes/${result.id}/edit?new=1`);
    } catch (error) { setError(error instanceof Error ? error.message : "Scan failed. Please try again."); }
    finally { setBusy(false); }
  }
  function add(files: FileList | null) {
    if (!files) return;
    setPhotos(previous => [...previous, ...Array.from(files)]);
    setError("");
  }
  return <div className="card">
    <h2>Scan a recipe</h2>
    <p>Photograph or upload up to six pages in reading order. Danish and English are supported. Review the result before saving; the original pages stay attached.</p>
    <label>Take a photo <input disabled={busy} type="file" accept="image/*" capture="environment" onChange={e => { add(e.target.files); e.target.value = ""; }} /></label>{" "}
    <label>Upload photos <input disabled={busy} type="file" accept="image/*" multiple onChange={e => { add(e.target.files); e.target.value = ""; }} /></label>
    <ol>{photos.map((photo, i) => <li key={i}>{photo.name}{" "}<button disabled={busy} onClick={() => setPhotos(photos.filter((_, index) => index !== i))}>Remove</button>{" "}{i > 0 && <button disabled={busy} onClick={() => setPhotos(previous => { const next = [...previous]; [next[i-1], next[i]] = [next[i], next[i-1]]; return next; })}>Move up</button>}</li>)}</ol>
    {photos.length > 6 && <p>Remove photos to keep at most six pages.</p>}
    <button disabled={busy || !photos.length || photos.length > 6} onClick={scan}>{busy ? "Scanning pages…" : "Scan & review"}</button>
    <p className="muted" role="status">{busy ? "Scanning can take a minute or more. Keep this page open." : "Up to 10 MB total. Automatically tagged “manually added”."}</p>
    {error && <p role="alert">{error}</p>}
  </div>;
}
