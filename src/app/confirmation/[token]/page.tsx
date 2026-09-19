import Link from "next/link";
import { redirect } from "next/navigation";
import { startPayment } from "@/lib/payment-flow";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MESSAGES: Record<string, { title: string; body: string }> = {
  NOT_FOUND: {
    title: "Lien de confirmation inconnu",
    body: "Ce lien n’est associé à aucune réservation. Vérifiez le message reçu ou contactez le salon.",
  },
  EXPIRED: {
    title: "Lien expiré",
    body: "Le créneau n’a pas été confirmé à temps et a été libéré. Vous pouvez réserver à nouveau.",
  },
  ALREADY_CONFIRMED: {
    title: "Réservation déjà confirmée",
    body: "Ce rendez-vous est déjà réglé. Aucun nouveau paiement n’est nécessaire.",
  },
  CANCELLED: {
    title: "Réservation annulée",
    body: "Cette réservation n’est plus active.",
  },
};

/**
 * Page ouverte depuis WhatsApp, hors de l'application GENK.
 * Elle redirige vers la page de paiement hébergée par FedaPay.
 */
export default async function ConfirmationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // Next décode déjà le segment dynamique ; un second décodage n'est là que pour
  // absorber un encodage supplémentaire côté Meta. Une séquence `%` invalide
  // levée par decodeURIComponent doit rester un lien inconnu, pas une erreur 500.
  let decoded: string;
  try {
    decoded = decodeURIComponent(token);
  } catch {
    decoded = token;
  }

  const result = await startPayment(decoded);

  if (result.kind === "redirect") redirect(result.url);

  const content =
    result.kind === "rejected"
      ? MESSAGES[result.reason]
      : {
          title: "Paiement momentanément indisponible",
          body: "Nous n’avons pas pu ouvrir la page de paiement. Réessayez dans quelques minutes.",
        };

  return (
    <main className="container">
      <section className="card">
        <p className="eyebrow">CONFIRMATION</p>
        <h1>{content.title}</h1>
        <p>{content.body}</p>
        <Link className="button" href="/">Retour à l’accueil</Link>
      </section>
    </main>
  );
}
