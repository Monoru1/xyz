import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { db } from "@/lib/db";
import { getStripe } from "@/lib/stripe";

export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!signature || !secret) return NextResponse.json({ error: "Webhook non configuré" }, { status: 400 });
  let event: Stripe.Event;
  try { event = getStripe().webhooks.constructEvent(await request.text(), signature, secret); }
  catch { return NextResponse.json({ error: "Signature invalide" }, { status: 400 }); }

  try {
    await db.$transaction(async (tx) => {
      if (await tx.webhookEvent.findUnique({ where: { id: event.id } })) return;
      if (event.type === "checkout.session.completed") {
        const session = event.data.object as Stripe.Checkout.Session;
        const bookingId = session.metadata?.bookingId;
        if (bookingId && session.payment_status === "paid") {
          const booking = await tx.booking.findUnique({ where: { id: bookingId }, include: { service: true } });
          if (booking) {
            await tx.booking.update({ where: { id: bookingId }, data: { status: "CONFIRMED", holdExpiresAt: null } });
            await tx.payment.upsert({ where: { bookingId }, update: { status: "SUCCEEDED", stripePaymentId: String(session.payment_intent) }, create: { bookingId, amountCents: booking.service.priceCents, status: "SUCCEEDED", stripePaymentId: String(session.payment_intent) } });
          }
        }
      }
      if (event.type === "checkout.session.expired") {
        const bookingId = (event.data.object as Stripe.Checkout.Session).metadata?.bookingId;
        if (bookingId) await tx.booking.updateMany({ where: { id: bookingId, status: { in: ["HOLD", "PENDING_PAYMENT"] } }, data: { status: "EXPIRED" } });
      }
      await tx.webhookEvent.create({ data: { id: event.id, type: event.type } });
    });
    return NextResponse.json({ received: true });
  } catch { return NextResponse.json({ error: "Traitement échoué" }, { status: 500 }); }
}
