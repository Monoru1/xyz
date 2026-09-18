import { db } from "@/lib/db";
import { evaluateConfirmationToken, splitCustomerName, type TokenRejection } from "@/lib/booking";
import { appUrl } from "@/lib/env";
import { createTransaction, generatePaymentUrl, retrieveTransaction } from "@/lib/fedapay";
import { optionalEnv } from "@/lib/env";

export type StartPaymentResult =
  | { kind: "redirect"; url: string }
  | { kind: "rejected"; reason: TokenRejection }
  | { kind: "error"; reason: string };

/**
 * Point d'entrée du lien de confirmation, ouvert hors de l'application.
 * Crée la transaction FedaPay au premier passage puis renvoie le lien de
 * paiement hébergé. Rejouer le lien réutilise la même transaction.
 */
export async function startPayment(token: string): Promise<StartPaymentResult> {
  const booking = await db.booking.findUnique({
    where: { confirmationToken: token },
    include: { service: true, salon: true, payment: true },
  });

  const rejection = evaluateConfirmationToken(booking, new Date());
  if (rejection) return { kind: "rejected", reason: rejection };
  if (!booking) return { kind: "rejected", reason: "NOT_FOUND" };

  try {
    // Idempotence: une transaction déjà créée est réutilisée telle quelle.
    let transactionId = booking.providerTransactionId ? Number(booking.providerTransactionId) : null;
    if (transactionId !== null && Number.isFinite(transactionId)) {
      const existing = await retrieveTransaction(transactionId);
      if (existing.status !== "pending") return { kind: "rejected", reason: "ALREADY_CONFIRMED" };
    } else {
      const { firstname, lastname } = splitCustomerName(booking.customerName);
      const created = await createTransaction({
        merchantReference: booking.id,
        description: `${booking.service.name} — ${booking.salon.name}`,
        amount: booking.service.priceCents,
        callbackUrl: `${appUrl()}/reservation/${booking.id}`,
        customer: {
          firstname,
          lastname,
          email: booking.customerEmail,
          ...(booking.customerPhone
            ? { phoneNumber: { number: booking.customerPhone, country: optionalEnv("FEDAPAY_CUSTOMER_COUNTRY", "bj") } }
            : {}),
        },
      });
      transactionId = created.id;

      await db.$transaction([
        db.booking.update({
          where: { id: booking.id },
          data: { providerTransactionId: String(created.id), status: "PENDING_PAYMENT" },
        }),
        db.payment.upsert({
          where: { bookingId: booking.id },
          update: { providerTransactionId: String(created.id), providerReference: created.reference ?? null, status: "PENDING" },
          create: {
            bookingId: booking.id,
            providerTransactionId: String(created.id),
            providerReference: created.reference ?? null,
            amountCents: booking.service.priceCents,
            currency: optionalEnv("FEDAPAY_CURRENCY", "XOF"),
            status: "PENDING",
          },
        }),
      ]);
    }

    const { url } = await generatePaymentUrl(transactionId);
    return { kind: "redirect", url };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Initialisation du paiement impossible";
    console.error("[fedapay] initialisation du paiement en échec", { bookingId: booking.id, reason });
    return { kind: "error", reason };
  }
}
