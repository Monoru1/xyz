import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  extractTransaction,
  idempotencyKey,
  retrieveTransaction,
  settlementFor,
  transactionMatchesBooking,
  verifyWebhookEvent,
} from "@/lib/fedapay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Webhook FedaPay.
 *
 * Trois garanties:
 *  1. la signature `X-FEDAPAY-SIGNATURE` est vérifiée par le helper officiel du SDK;
 *  2. l'état du paiement est relu auprès de FedaPay — le payload seul ne confirme rien;
 *  3. le traitement est idempotent grâce à la table WebhookEvent.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();

  let event;
  try {
    event = verifyWebhookEvent(rawBody, request.headers.get("x-fedapay-signature"));
  } catch {
    return NextResponse.json({ error: "Signature invalide" }, { status: 400 });
  }

  const payloadTransaction = extractTransaction(event);
  if (!payloadTransaction) return NextResponse.json({ received: true, ignored: "no_transaction" });

  const eventKey = idempotencyKey(event, payloadTransaction);
  if (await db.webhookEvent.findUnique({ where: { id: eventKey } })) {
    return NextResponse.json({ received: true, duplicate: true });
  }

  // Le statut porté par le webhook n'est jamais pris pour argent comptant.
  let transaction;
  try {
    transaction = await retrieveTransaction(payloadTransaction.id);
  } catch (error) {
    console.error("[fedapay] relecture de la transaction impossible", {
      transactionId: payloadTransaction.id,
      reason: error instanceof Error ? error.message : "inconnu",
    });
    return NextResponse.json({ error: "Vérification impossible" }, { status: 502 });
  }

  const bookingId = transaction.merchant_reference ?? (transaction.custom_metadata?.bookingId as string | undefined);
  const booking = bookingId
    ? await db.booking.findUnique({ where: { id: bookingId }, include: { service: true } })
    : await db.booking.findUnique({ where: { providerTransactionId: String(transaction.id) }, include: { service: true } });

  if (!booking) {
    // Événement légitime mais hors périmètre: on l'acquitte sans le rejouer.
    await db.webhookEvent.create({ data: { id: eventKey, type: event.name } });
    return NextResponse.json({ received: true, ignored: "booking_not_found" });
  }

  if (!transactionMatchesBooking(transaction, {
    id: booking.id,
    providerTransactionId: booking.providerTransactionId,
    expectedAmount: booking.service.priceCents,
  })) {
    // Une transaction FedaPay valide mais ne correspondant pas exactement à
    // la réservation ne doit jamais pouvoir la confirmer.
    await db.webhookEvent.create({ data: { id: eventKey, type: event.name } });
    return NextResponse.json({ received: true, ignored: "transaction_mismatch" });
  }

  const outcome = settlementFor(transaction.status);

  try {
    await db.$transaction(async (tx) => {
      if (await tx.webhookEvent.findUnique({ where: { id: eventKey } })) return;

      await tx.payment.upsert({
        where: { bookingId: booking.id },
        update: {
          status: outcome.payment,
          providerTransactionId: String(transaction.id),
          providerReference: transaction.reference ?? null,
        },
        create: {
          bookingId: booking.id,
          providerTransactionId: String(transaction.id),
          providerReference: transaction.reference ?? null,
          amountCents: booking.service.priceCents,
          status: outcome.payment,
        },
      });

      if (outcome.booking) {
        await tx.booking.update({
          where: { id: booking.id },
          data: {
            status: outcome.booking,
            // La confirmation consomme définitivement le lien.
            ...(outcome.booking === "CONFIRMED"
              ? { holdExpiresAt: null, confirmationToken: null, confirmationExpiresAt: null }
              : {}),
          },
        });
      }

      await tx.webhookEvent.create({ data: { id: eventKey, type: event.name } });
    });
  } catch (error) {
    console.error("[fedapay] traitement du webhook en échec", {
      bookingId: booking.id,
      reason: error instanceof Error ? error.message : "inconnu",
    });
    return NextResponse.json({ error: "Traitement échoué" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
