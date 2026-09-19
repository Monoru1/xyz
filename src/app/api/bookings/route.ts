import { NextResponse } from "next/server";
import { z } from "zod";
import { createBookingHold } from "@/lib/booking";
import { db } from "@/lib/db";
import { sendConfirmationTemplate, toE164 } from "@/lib/whatsapp";

export const runtime = "nodejs";

const schema = z.object({
  salonId: z.string().min(1), serviceId: z.string().min(1), startsAt: z.coerce.date().refine((d) => d > new Date(), "Date passée"),
  customerName: z.string().min(2).max(100), customerEmail: z.string().email().max(150), customerPhone: z.string().min(6).max(30),
});

/** Réponses publiques: jamais de détail interne, jamais de trace d'exécution. */
const FAILURES: Record<string, { status: number; error: string }> = {
  SLOT_UNAVAILABLE: { status: 409, error: "Ce créneau vient d’être réservé" },
  SERVICE_NOT_FOUND: { status: 404, error: "Prestation introuvable" },
  RATE_LIMITED: { status: 429, error: "Trop de demandes pour ce contact. Réessayez plus tard." },
};

/**
 * Crée la réservation puis envoie le lien de confirmation par WhatsApp.
 * Aucun paiement n'est initié ici: l'application ne contacte jamais FedaPay.
 */
export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Données invalides" }, { status: 400 });
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) return NextResponse.json({ error: "Données invalides", details: parsed.error.flatten() }, { status: 400 });

  // Le numéro est canonisé avant écriture: un numéro injoignable est refusé tout
  // de suite plutôt que de produire une réservation qui ne sera jamais notifiée,
  // et la forme canonique rend le quota anti-spam infalsifiable par reformatage.
  let customerPhone: string;
  try {
    customerPhone = toE164(parsed.data.customerPhone);
  } catch {
    return NextResponse.json({ error: "Numéro WhatsApp invalide" }, { status: 400 });
  }

  let hold;
  try {
    hold = await createBookingHold({ ...parsed.data, customerPhone });
  } catch (error) {
    const failure = FAILURES[error instanceof Error ? error.message : ""];
    if (!failure) console.error("[bookings] création de la réservation en échec", { salonId: parsed.data.salonId });
    return NextResponse.json(
      failure ?? { error: "Réservation impossible" },
      { status: failure?.status ?? 500 },
    );
  }

  const { booking, confirmationToken } = hold;

  // Un échec de notification n'invalide pas une réservation déjà acceptée:
  // il est tracé sur la réservation pour permettre un renvoi par le salon.
  let notified = false;
  try {
    await sendConfirmationTemplate({
      to: customerPhone,
      customerName: booking.customerName,
      confirmationSuffix: confirmationToken,
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
