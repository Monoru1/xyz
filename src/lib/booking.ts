import { randomBytes } from "node:crypto";
import { addMinutes } from "date-fns";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export type HoldInput = {
  salonId: string; serviceId: string; startsAt: Date;
  customerName: string; customerEmail: string; customerPhone: string;
};

/** Durée pendant laquelle le créneau reste bloqué en attendant la confirmation. */
export function holdDurationMinutes(): number {
  const parsed = Number.parseInt(process.env.BOOKING_HOLD_MINUTES ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
}

/** Token opaque, URL-safe, porté par le lien de confirmation WhatsApp. */
export function generateConfirmationToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function createBookingHold(input: HoldInput) {
  const expiresAt = addMinutes(new Date(), holdDurationMinutes());
  return db.$transaction(async (tx) => {
    const service = await tx.service.findFirst({ where: { id: input.serviceId, salonId: input.salonId, active: true } });
    if (!service) throw new Error("SERVICE_NOT_FOUND");
    const endsAt = addMinutes(input.startsAt, service.durationMinutes);
    await tx.booking.updateMany({ where: { salonId: input.salonId, status: "HOLD", holdExpiresAt: { lt: new Date() } }, data: { status: "EXPIRED" } });
    const overlap = await tx.booking.findFirst({ where: { salonId: input.salonId, status: { in: ["HOLD", "PENDING_PAYMENT", "CONFIRMED"] }, startsAt: { lt: endsAt }, endsAt: { gt: input.startsAt } } });
    if (overlap) throw new Error("SLOT_UNAVAILABLE");
    try {
      return await tx.booking.create({
        data: {
          ...input,
          customerEmail: input.customerEmail.toLowerCase(),
          endsAt,
          holdExpiresAt: expiresAt,
          status: "HOLD",
          confirmationToken: generateConfirmationToken(),
          confirmationExpiresAt: expiresAt,
        },
        include: { service: true, salon: true },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" || error.code === "P2004")) throw new Error("SLOT_UNAVAILABLE");
      throw error;
    }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export type TokenRejection = "NOT_FOUND" | "EXPIRED" | "ALREADY_CONFIRMED" | "CANCELLED";

/**
 * Valide un token de confirmation, sans effet de bord.
 * Le token seul ne suffit pas: le hold doit être encore valide et la
 * réservation ne doit être ni déjà réglée ni annulée.
 */
export function evaluateConfirmationToken(
  booking: { status: string; confirmationExpiresAt: Date | null } | null,
  now = new Date(),
): TokenRejection | null {
  if (!booking) return "NOT_FOUND";
  if (booking.status === "CONFIRMED") return "ALREADY_CONFIRMED";
  if (booking.status === "CANCELLED" || booking.status === "EXPIRED") return "CANCELLED";
  if (!booking.confirmationExpiresAt || booking.confirmationExpiresAt <= now) return "EXPIRED";
  return null;
}

/** Découpe le nom saisi en prénom/nom pour l'objet customer de FedaPay. */
export function splitCustomerName(fullName: string): { firstname: string; lastname: string } {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return { firstname: parts[0], lastname: parts[0] };
  return { firstname: parts[0], lastname: parts.slice(1).join(" ") };
}
