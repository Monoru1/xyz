import { NextResponse } from "next/server";
import { z } from "zod";
import { createBookingHold } from "@/lib/booking";
import { db } from "@/lib/db";
import { getStripe } from "@/lib/stripe";

const schema = z.object({
  salonId: z.string().min(1), serviceId: z.string().min(1), startsAt: z.coerce.date().refine((d) => d > new Date(), "Date passée"),
  customerName: z.string().min(2).max(100), customerEmail: z.string().email(), customerPhone: z.string().max(30).optional(),
});

export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: "Données invalides", details: parsed.error.flatten() }, { status: 400 });
  try {
    const booking = await createBookingHold(parsed.data);
    const stripe = getStripe();
    const origin = process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin;
    const session = await stripe.checkout.sessions.create({
      mode: "payment", customer_email: booking.customerEmail,
      line_items: [{ quantity: 1, price_data: { currency: "eur", unit_amount: booking.service.priceCents, product_data: { name: `${booking.service.name} — ${booking.salon.name}` } } }],
      success_url: `${origin}/reservation/succes?booking=${booking.id}`,
      cancel_url: `${origin}/salons/${booking.salon.slug}?cancelled=1`,
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
      metadata: { bookingId: booking.id },
    });
    await db.booking.update({ where: { id: booking.id }, data: { stripeSessionId: session.id, status: "PENDING_PAYMENT" } });
    return NextResponse.json({ bookingId: booking.id, checkoutUrl: session.url }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN";
    const status = message === "SLOT_UNAVAILABLE" ? 409 : message === "SERVICE_NOT_FOUND" ? 404 : 500;
    return NextResponse.json({ error: status === 409 ? "Ce créneau vient d’être réservé" : "Réservation impossible" }, { status });
  }
}
