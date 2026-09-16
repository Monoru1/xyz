import { addMinutes, format, set } from "date-fns";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET(request: Request) {
  const url = new URL(request.url); const serviceId = url.searchParams.get("serviceId"); const dateValue = url.searchParams.get("date");
  if (!serviceId || !dateValue) return NextResponse.json({ error: "Paramètres manquants" }, { status: 400 });
  const date = new Date(`${dateValue}T12:00:00`);
  const service = await db.service.findUnique({ where: { id: serviceId }, include: { salon: { include: { schedules: true } } } });
  if (!service) return NextResponse.json({ slots: [] });
  const rule = service.salon.schedules.find((r) => r.active && r.dayOfWeek === date.getDay());
  if (!rule) return NextResponse.json({ slots: [] });
  const [sh, sm] = rule.startTime.split(":").map(Number); const [eh, em] = rule.endTime.split(":").map(Number);
  let cursor = set(date, { hours: sh, minutes: sm, seconds: 0, milliseconds: 0 }); const end = set(date, { hours: eh, minutes: em, seconds: 0, milliseconds: 0 });
  const bookings = await db.booking.findMany({ where: { salonId: service.salonId, status: { in: ["HOLD", "PENDING_PAYMENT", "CONFIRMED"] }, startsAt: { lt: addMinutes(end, service.durationMinutes) }, endsAt: { gt: cursor } } });
  const slots: { value: string; label: string }[] = [];
  while (addMinutes(cursor, service.durationMinutes) <= end) { const slotEnd = addMinutes(cursor, service.durationMinutes); if (cursor > new Date() && !bookings.some((b) => b.startsAt < slotEnd && b.endsAt > cursor)) slots.push({ value: cursor.toISOString(), label: format(cursor, "HH:mm") }); cursor = addMinutes(cursor, 30); }
  return NextResponse.json({ slots });
}
