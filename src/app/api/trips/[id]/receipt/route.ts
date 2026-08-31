import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { currentHouseholdContext } from "@/lib/currentUser";

// GET /api/trips/[id]/receipt — serve the receipt photo stored in the DB (§7).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const context = await currentHouseholdContext();
  if (!context) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const receipt = await prisma.receipt.findFirst({
    where: { tripId: id, trip: { householdId: context.household.id } },
  });
  if (!receipt) {
    return NextResponse.json({ error: "no receipt" }, { status: 404 });
  }
  return new NextResponse(new Uint8Array(receipt.photo), {
    headers: {
      "content-type": receipt.mimeType,
      "cache-control": "private, max-age=86400",
    },
  });
}
