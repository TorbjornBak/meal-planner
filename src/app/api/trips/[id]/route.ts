import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Edit / delete a logged shopping trip (§7). PATCH takes the same multipart form
// as POST /api/trips so the client can reuse it: any of date / store / total,
// plus an optional new receipt photo (replaces the old one) or removePhoto flag.

// PATCH /api/trips/[id]
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const form = await req.formData();

  const data: { date?: Date; store?: string; total?: string } = {};

  if (form.has("date")) {
    const d = new Date(String(form.get("date")));
    if (Number.isNaN(d.getTime())) {
      return NextResponse.json({ error: "invalid date" }, { status: 400 });
    }
    data.date = d;
  }
  if (form.has("store")) {
    const store = String(form.get("store")).trim();
    if (!store) {
      return NextResponse.json({ error: "store cannot be empty" }, { status: 400 });
    }
    data.store = store;
  }
  if (form.has("total")) {
    const total = String(form.get("total"));
    if (!Number.isFinite(Number(total))) {
      return NextResponse.json({ error: "invalid total" }, { status: 400 });
    }
    data.total = total; // Prisma coerces the string into the Money column
  }

  const exists = await prisma.shoppingTrip.findUnique({ where: { id } });
  if (!exists) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  await prisma.shoppingTrip.update({ where: { id }, data });

  // Receipt photo: remove, replace/add, or leave untouched.
  const photo = form.get("photo");
  if (String(form.get("removePhoto")) === "1") {
    await prisma.receipt.deleteMany({ where: { tripId: id } });
  } else if (photo instanceof File && photo.size > 0) {
    const bytes = Buffer.from(await photo.arrayBuffer());
    const mimeType = photo.type || "application/octet-stream";
    await prisma.receipt.upsert({
      where: { tripId: id },
      create: { tripId: id, photo: bytes, mimeType },
      update: { photo: bytes, mimeType },
    });
  }

  const trip = await prisma.shoppingTrip.findUnique({
    where: { id },
    include: { receipt: { select: { id: true } } },
  });
  return NextResponse.json(trip);
}

// DELETE /api/trips/[id] — removes the trip (its receipt cascades).
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  await prisma.shoppingTrip.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
