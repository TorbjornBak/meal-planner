import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { scanReceipt } from "@/lib/ocr";
import { findReceiptTotal } from "@/lib/receiptTotal";
import { currentHouseholdContext } from "@/lib/currentUser";

// Read the total off a receipt photo (§7). Local OCR on our own box — see
// lib/ocr.ts — so this stays a suggestion the human confirms, never an
// authority: nothing here writes to the ledger.

// Tesseract is CPU-bound and a receipt takes a second or two on ordinary server hardware.
export const maxDuration = 60;

/** Generous for a phone photo, small enough that a bad upload fails fast. */
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

export interface ReceiptOcrResult {
  /** Kroner, or null when nothing on the photo looked like a total. */
  total: number | null;
  /** The line it was read from, so the human can check it at a glance. */
  line: string | null;
  basis: "keyword" | "largest" | null;
  /** Tesseract's confidence in the page, 0–100. Low means "look closer". */
  confidence: number;
}

/**
 * POST /api/receipts/ocr — multipart form with either:
 *   photo   a receipt image being uploaded, read before the trip is saved, or
 *   tripId  an already-logged trip, to re-read the receipt already stored.
 */
export async function POST(req: Request) {
  const context = await currentHouseholdContext();
  if (!context) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "expected a multipart form" }, { status: 400 });
  }

  const photo = form.get("photo");
  const tripId = form.get("tripId");

  let bytes: Buffer;

  if (photo instanceof File && photo.size > 0) {
    if (!photo.type.startsWith("image/")) {
      return NextResponse.json({ error: "not an image" }, { status: 400 });
    }
    if (photo.size > MAX_PHOTO_BYTES) {
      return NextResponse.json({ error: "photo too large" }, { status: 413 });
    }
    bytes = Buffer.from(await photo.arrayBuffer());
  } else if (tripId) {
    const receipt = await prisma.receipt.findFirst({
      where: {
        tripId: String(tripId),
        trip: { householdId: context.household.id },
      },
    });
    if (!receipt) {
      return NextResponse.json({ error: "no receipt" }, { status: 404 });
    }
    bytes = Buffer.from(receipt.photo);
  } else {
    return NextResponse.json({ error: "photo or tripId required" }, { status: 400 });
  }

  let scan;
  try {
    scan = await scanReceipt(bytes);
  } catch (err) {
    // An unreadable photo or a missing language model shouldn't look like a
    // receipt with no total on it — the client needs to tell those apart.
    console.error("receipt OCR failed:", err);
    return NextResponse.json({ error: "could not read the photo" }, { status: 422 });
  }

  const found = findReceiptTotal(scan.text);
  const result: ReceiptOcrResult = {
    total: found?.amount ?? null,
    line: found?.line ?? null,
    basis: found?.basis ?? null,
    confidence: Math.round(scan.confidence),
  };
  return NextResponse.json(result);
}
