import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { currentHouseholdContext } from "@/lib/currentUser";
import { receiptPhotoProblem } from "@/lib/receiptPhoto";

// Spend ledger (§7). A trip is date + store + typed total + a receipt photo
// stored in the DB. No OCR, no line items. Loosely coupled to the shopping list.

// GET /api/trips — recent trips (most recent first), with whether each has a
// receipt photo attached (the bytes are served separately).
export async function GET() {
  const context = await currentHouseholdContext();
  if (!context) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const trips = await prisma.shoppingTrip.findMany({
    where: { householdId: context.household.id },
    orderBy: { date: "desc" },
    take: 100,
    include: { receipt: { select: { id: true } } },
  });
  return NextResponse.json(trips);
}

// POST /api/trips — multipart form: date, store, total, photo (file).
export async function POST(req: Request) {
  const context = await currentHouseholdContext();
  if (!context) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
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
      householdId: context.household.id,
      date: new Date(date),
      store,
      total, // Prisma coerces the string into the Money column
    },
  });

  // Attach the receipt photo if one was uploaded.
  if (photo && photo instanceof File && photo.size > 0) {
    // Checked before the bytes are read, and before anything is stored. The
    // type matters as much as the size here: these bytes are served back from
    // this app's own origin under the type recorded with them (§7), so an
    // unchecked type is a stored-XSS hole rather than a tidiness question.
    // See src/lib/receiptPhoto.ts.
    const problem = receiptPhotoProblem(photo);
    if (problem) {
      return NextResponse.json({ error: problem }, { status: 413 });
    }
    const bytes = Buffer.from(await photo.arrayBuffer());
    await prisma.receipt.create({
      data: { tripId: trip.id, photo: bytes, mimeType: photo.type },
    });
  }

  return NextResponse.json(trip, { status: 201 });
}
