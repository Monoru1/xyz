import { createHash, randomBytes } from "node:crypto";
import { addMinutes, subMinutes } from "date-fns";
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

function positiveIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Anti-abus. `POST /api/bookings` déclenche un message WhatsApp facturé vers un
 * numéro choisi par l'appelant : sans quota, l'endpoint est une passerelle de
 * spam qui dégrade aussi la note qualité du numéro émetteur Meta.
 *
 * Le compteur s'appuie sur la table Booking en PostgreSQL : il reste donc exact
 * même avec plusieurs instances serverless, contrairement à un compteur mémoire.
 * Il borne le nombre de messages reçus par un destinataire donné, qui est
 * exactement la ressource à protéger. Un plafond par IP relève du WAF/CDN de
 * l'hébergeur (cf. README, section « Rate limiting »).
 */
export function bookingQuota(): { window: number; maxPerPhone: number; maxPerEmail: number } {
  return {
    window: positiveIntEnv("BOOKING_RATE_WINDOW_MINUTES", 60),
    maxPerPhone: positiveIntEnv("BOOKING_RATE_MAX_PER_PHONE", 3),
    maxPerEmail: positiveIntEnv("BOOKING_RATE_MAX_PER_EMAIL", 5),
  };
}

/** Token opaque, URL-safe, porté par le lien de confirmation WhatsApp. 256 bits d'entropie CSPRNG. */
export function generateConfirmationToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Seule l'empreinte du token est persistée. Le token clair ne vit que le temps
 * de l'envoi WhatsApp : une lecture de la base (dump, Data API mal verrouillée,
 * sauvegarde) ne permet plus de rejouer un lien de confirmation.
 *
 * SHA-256 nu suffit et reste indexable : la valeur est déjà un aléa de 256 bits,
 * donc hors de portée d'une attaque par dictionnaire — contrairement à un mot de
 * passe, aucun KDF lent n'est nécessaire.
 */
export function hashConfirmationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

export type HoldResult = {
  booking: Prisma.BookingGetPayload<{ include: { service: true; salon: true } }>;
  /** Token en clair, à usage unique et immédiat : jamais relu depuis la base. */
  confirmationToken: string;
};

export async function createBookingHold(input: HoldInput): Promise<HoldResult> {
  const now = new Date();
  const expiresAt = addMinutes(now, holdDurationMinutes());
  const confirmationToken = generateConfirmationToken();
  const quota = bookingQuota();
  const since = subMinutes(now, quota.window);
  const customerEmail = input.customerEmail.toLowerCase();

  const booking = await db.$transaction(async (tx) => {
    const service = await tx.service.findFirst({ where: { id: input.serviceId, salonId: input.salonId, active: true } });
    if (!service) throw new Error("SERVICE_NOT_FOUND");
    const endsAt = addMinutes(input.startsAt, service.durationMinutes);

    // Requêtes séquentielles: une transaction interactive Prisma tient une seule
    // connexion, les paralléliser n'apporte rien et brouille l'ordre des verrous.
    const phoneCount = await tx.booking.count({ where: { customerPhone: input.customerPhone, createdAt: { gte: since } } });
    if (phoneCount >= quota.maxPerPhone) throw new Error("RATE_LIMITED");
    const emailCount = await tx.booking.count({ where: { customerEmail, createdAt: { gte: since } } });
    if (emailCount >= quota.maxPerEmail) throw new Error("RATE_LIMITED");

    await tx.booking.updateMany({ where: { salonId: input.salonId, status: "HOLD", holdExpiresAt: { lt: now } }, data: { status: "EXPIRED" } });
    const overlap = await tx.booking.findFirst({ where: { salonId: input.salonId, status: { in: ["HOLD", "PENDING_PAYMENT", "CONFIRMED"] }, startsAt: { lt: endsAt }, endsAt: { gt: input.startsAt } } });
    if (overlap) throw new Error("SLOT_UNAVAILABLE");
    try {
      return await tx.booking.create({
        data: {
          ...input,
          customerEmail,
          endsAt,
          holdExpiresAt: expiresAt,
          status: "HOLD",
          confirmationToken: hashConfirmationToken(confirmationToken),
          confirmationExpiresAt: expiresAt,
        },
        include: { service: true, salon: true },
      });
    } catch (error) {
      if (isSlotConflict(error)) throw new Error("SLOT_UNAVAILABLE");
      throw error;
    }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  return { booking, confirmationToken };
}

/**
 * Dernier rempart anti-double-réservation : la contrainte d'exclusion
 * PostgreSQL `Booking_no_overlap` (SQLSTATE 23P01) et l'échec de sérialisation
 * (40001) déclenchés par deux requêtes concurrentes doivent se traduire par un
 * « créneau indisponible », pas par une erreur serveur.
 */
export function isSlotConflict(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002" || error.code === "P2004" || error.code === "P2034") return true;
    const sqlState = error.meta?.code;
    return sqlState === "23P01" || sqlState === "40001";
  }
  if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    return /\b(23P01|40001)\b/.test(error.message);
  }
  return false;
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
