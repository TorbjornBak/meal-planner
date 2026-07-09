import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Spend ledger (§7). A trip is date + store + typed total + a receipt photo
// stored in the DB. No OCR, no line items. Loosely coupled to the shopping list.

// GET /api/trips — recent trips (most recent first).
export async function GET() {
  const trips = await prisma.shoppingTrip.findMany({
    orderBy: { date: "desc" },
    take: 100,
  });
  return NextResponse.json(trips);
}

// POST /api/trips — multipart form: date, store, total, photo (file).
export async function POST(req: Request) {
  const form = await req.formData();
  const date = String(form.get("date") ?? "");
  const store = String(form.get("store") ?? "");
  const total = String(form.get("total") ?? "");
  const photo = form.get("photo");

  if (!date || !store || !total) {
    return NextResponse.json(
      { error: "date, store, total are required" },
      { status: 400 },
    );
  }

  const trip = await prisma.shoppingTrip.create({
    data: {
      date: new Date(date),
      store,
      total, // Prisma coerces the string into the Money column
    },
  });

  // Attach the receipt photo if one was uploaded.
  if (photo && photo instanceof File && photo.size > 0) {
    const bytes = Buffer.from(await photo.arrayBuffer());
    await prisma.receipt.create({
      data: {
        tripId: trip.id,
        photo: bytes,
        mimeType: photo.type || "application/octet-stream",
      },
    });
  }

  return NextResponse.json(trip, { status: 201 });
}
