import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { currentHouseholdContext } from "@/lib/currentUser";
import { safeReceiptContentType } from "@/lib/receiptPhoto";

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
  // The stored type is re-checked rather than echoed. Uploads are validated
  // now, but rows written before Phase 6 carry whatever their uploader's
  // browser claimed, and this response hands bytes back on the app's own
  // origin — so an unrecognised type degrades to a download instead of
  // becoming a document (see src/lib/receiptPhoto.ts). `nosniff` stops a
  // browser second-guessing that decision by peering at the bytes, and the
  // one-line CSP means that even a type that slipped through the allowlist
  // renders nothing and reaches nowhere.
  return new NextResponse(new Uint8Array(receipt.photo), {
    headers: {
      "content-type": safeReceiptContentType(receipt.mimeType),
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, max-age=86400",
    },
  });
}
