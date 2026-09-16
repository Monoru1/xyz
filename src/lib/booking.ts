import { addMinutes } from "date-fns";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export type HoldInput = {
  salonId: string; serviceId: string; startsAt: Date;
  customerName: string; customerEmail: string; customerPhone?: string;
};

export async function createBookingHold(input: HoldInput) {
  return db.$transaction(async (tx) => {
    const service = await tx.service.findFirst({ where: { id: input.serviceId, salonId: input.salonId, active: true } });
    if (!service) throw new Error("SERVICE_NOT_FOUND");
    const endsAt = addMinutes(input.startsAt, service.durationMinutes);
    await tx.booking.updateMany({ where: { salonId: input.salonId, status: "HOLD", holdExpiresAt: { lt: new Date() } }, data: { status: "EXPIRED" } });
    const overlap = await tx.booking.findFirst({ where: { salonId: input.salonId, status: { in: ["HOLD", "PENDING_PAYMENT", "CONFIRMED"] }, startsAt: { lt: endsAt }, endsAt: { gt: input.startsAt } } });
    if (overlap) throw new Error("SLOT_UNAVAILABLE");
    try {
      return await tx.booking.create({ data: { ...input, customerEmail: input.customerEmail.toLowerCase(), endsAt, holdExpiresAt: addMinutes(new Date(), 15), status: "HOLD" }, include: { service: true, salon: true } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" || error.code === "P2004")) throw new Error("SLOT_UNAVAILABLE");
      throw error;
    }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
