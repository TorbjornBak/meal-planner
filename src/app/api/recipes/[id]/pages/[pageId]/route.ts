import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { currentHouseholdContext } from "@/lib/currentUser";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; pageId: string }> }) {
  const context = await currentHouseholdContext();
  if (!context) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id, pageId } = await params;
  const page = await prisma.recipeSourcePage.findFirst({
    where: { id: pageId, recipeId: id, recipe: { householdId: context.household.id } },
    select: { photo: true, mime: true },
  });
  if (!page) return NextResponse.json({ error: "not found" }, { status: 404 });
  return new Response(new Uint8Array(page.photo), { headers: { "Content-Type": page.mime, "Cache-Control": "private, no-store" } });
}
