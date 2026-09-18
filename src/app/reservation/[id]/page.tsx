import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { fr } from "date-fns/locale";
import { db } from "@/lib/db";
import { formatAmount } from "@/lib/format";

export const dynamic = "force-dynamic";

const STATUS_LABELS: Record<string, { title: string; body: string }> = {
  HOLD: {
    title: "Réservation envoyée — en attente de confirmation",
    body: "Un lien de confirmation vient de vous être envoyé sur WhatsApp. Ouvrez-le pour finaliser votre rendez-vous.",
  },
  PENDING_PAYMENT: {
    title: "Confirmation en cours",
    body: "Votre paiement est en cours de traitement. Cette page se mettra à jour une fois le règlement validé.",
  },
  CONFIRMED: {
    title: "Rendez-vous confirmé",
    body: "Votre paiement a été validé. Le salon vous attend au créneau réservé.",
  },
  CANCELLED: { title: "Réservation annulée", body: "Cette réservation n’est plus active." },
  EXPIRED: { title: "Réservation expirée", body: "Le créneau a été libéré faute de confirmation à temps." },
};

/** Suivi de la réservation. Aucun lien vers le prestataire de paiement n'est exposé ici. */
export default async function BookingStatusPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const booking = await db.booking.findUnique({
    where: { id },
    include: { service: true, salon: true, payment: true },
  });
  if (!booking) notFound();

  const label = STATUS_LABELS[booking.status] ?? STATUS_LABELS.HOLD;

  return (
    <main className="container">
      <section className="card">
        <p className="eyebrow">RÉSERVATION</p>
        <h1>{label.title}</h1>
        <p>{label.body}</p>
        <p>
          <b>{booking.service.name}</b> — {booking.salon.name}
        </p>
        <p>{format(booking.startsAt, "EEEE d MMMM yyyy 'à' HH:mm", { locale: fr })}</p>
        <p className="price">{formatAmount(booking.service.priceCents, booking.payment?.currency)}</p>
        <Link className="button" href={`/salons/${booking.salon.slug}`}>Retour au salon</Link>
      </section>
    </main>
  );
}
