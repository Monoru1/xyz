import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
const schema = z.object({ name: z.string().min(2), description: z.string().optional(), durationMinutes: z.number().int().min(15).max(480), priceCents: z.number().int().min(0) });
export async function POST(request: Request) {
  const session = await auth(); if (session?.user.role !== "OWNER") return NextResponse.json({ error: "Non autorisé" }, { status: 401 });
  const parsed = schema.safeParse(await request.json()); if (!parsed.success) return NextResponse.json({ error: "Données invalides" }, { status: 400 });
  const salon = await db.salon.findUnique({ where: { ownerId: session.user.id } }); if (!salon) return NextResponse.json({ error: "Salon introuvable" }, { status: 404 });
  return NextResponse.json(await db.service.create({ data: { ...parsed.data, salonId: salon.id } }), { status: 201 });
}
