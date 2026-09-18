import { NextResponse } from "next/server";
import { z } from "zod";
import { createBookingHold } from "@/lib/booking";
import { db } from "@/lib/db";
import { sendConfirmationTemplate } from "@/lib/whatsapp";

export const runtime = "nodejs";

const schema = z.object({
  salonId: z.string().min(1), serviceId: z.string().min(1), startsAt: z.coerce.date().refine((d) => d > new Date(), "Date passée"),
  customerName: z.string().min(2).max(100), customerEmail: z.string().email(), customerPhone: z.string().min(6).max(30),
});

/**
 * Crée la réservation puis envoie le lien de confirmation par WhatsApp.
 * Aucun paiement n'est initié ici: l'application ne contacte jamais FedaPay.
 */
export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: "Données invalides", details: parsed.error.flatten() }, { status: 400 });

  let booking;
  try {
    booking = await createBookingHold(parsed.data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN";
    const status = message === "SLOT_UNAVAILABLE" ? 409 : message === "SERVICE_NOT_FOUND" ? 404 : 500;
    return NextResponse.json({ error: status === 409 ? "Ce créneau vient d’être réservé" : "Réservation impossible" }, { status });
  }

  // Un échec de notification n'invalide pas une réservation déjà acceptée:
  // il est tracé sur la réservation pour permettre un renvoi par le salon.
  let notified = false;
  try {
    await sendConfirmationTemplate({
      to: parsed.data.customerPhone,
      customerName: booking.customerName,
      confirmationSuffix: booking.confirmationToken!,
    });
    await db.booking.update({ where: { id: booking.id }, data: { notifiedAt: new Date(), notificationError: null } });
    notified = true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Envoi WhatsApp impossible";
    console.error("[whatsapp] envoi du lien de confirmation en échec", { bookingId: booking.id, reason });
    await db.booking.update({ where: { id: booking.id }, data: { notificationError: reason.slice(0, 500) } });
  }

  return NextResponse.json({ bookingId: booking.id, status: booking.status, notified }, { status: 201 });
}

/** Suivi d'une réservation depuis l'application, sans jamais exposer le token. */
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Paramètre manquant" }, { status: 400 });
  const booking = await db.booking.findUnique({
    where: { id },
    select: {
      id: true, status: true, startsAt: true, endsAt: true, notifiedAt: true,
      service: { select: { name: true, priceCents: true } },
      salon: { select: { name: true, slug: true } },
    },
  });
  if (!booking) return NextResponse.json({ error: "Réservation introuvable" }, { status: 404 });
  return NextResponse.json({ booking });
}
