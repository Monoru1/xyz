/**
 * Tests unitaires de la logique métier et des garde-fous de sécurité.
 *
 * Périmètre: ces tests n'appellent NI FedaPay NI WhatsApp NI PostgreSQL. Ils
 * valident les décisions prises par GENK à partir de données fournies. Ils ne
 * remplacent donc pas la recette réelle décrite dans README > « Recette réelle ».
 */
import { describe, expect, it } from "vitest";
import { addMinutes } from "date-fns";
import { Prisma } from "@prisma/client";
import {
  bookingQuota,
  evaluateConfirmationToken,
  generateConfirmationToken,
  hashConfirmationToken,
  isSlotConflict,
  splitCustomerName,
} from "@/lib/booking";
import { idempotencyKey, settlementFor, transactionMatchesBooking, type FedaPayTransaction } from "@/lib/fedapay";
import { isRetryableWhatsAppError, toE164 } from "@/lib/whatsapp";

const now = new Date("2030-01-01T10:00:00Z");
const valid = { status: "HOLD", confirmationExpiresAt: addMinutes(now, 30) };

describe("lien de confirmation", () => {
  it("accepte un token vivant sur une réservation en attente", () => {
    expect(evaluateConfirmationToken(valid, now)).toBeNull();
  });

  it("rejette un token inconnu", () => {
    expect(evaluateConfirmationToken(null, now)).toBe("NOT_FOUND");
  });

  it("rejette un token expiré", () => {
    expect(evaluateConfirmationToken({ ...valid, confirmationExpiresAt: addMinutes(now, -1) }, now)).toBe("EXPIRED");
  });

  it("rejette un token sans date d'expiration", () => {
    expect(evaluateConfirmationToken({ status: "HOLD", confirmationExpiresAt: null }, now)).toBe("EXPIRED");
  });

  it("refuse de rejouer une réservation déjà confirmée", () => {
    expect(evaluateConfirmationToken({ ...valid, status: "CONFIRMED" }, now)).toBe("ALREADY_CONFIRMED");
  });

  it("refuse une réservation annulée ou expirée", () => {
    expect(evaluateConfirmationToken({ ...valid, status: "CANCELLED" }, now)).toBe("CANCELLED");
    expect(evaluateConfirmationToken({ ...valid, status: "EXPIRED" }, now)).toBe("CANCELLED");
  });
});

describe("créneaux concurrents", () => {
  it("laisse passer deux rendez-vous adjacents", () => {
    const firstEnd = addMinutes(new Date("2030-01-01T10:00:00Z"), 60);
    expect(firstEnd <= new Date("2030-01-01T11:00:00Z")).toBe(true);
  });

  it("détecte un chevauchement réel", () => {
    const start = new Date("2030-01-01T10:30:00Z");
    const existingStart = new Date("2030-01-01T10:00:00Z");
    const existingEnd = new Date("2030-01-01T11:00:00Z");
    expect(existingStart < addMinutes(start, 60) && existingEnd > start).toBe(true);
  });
});

describe("règlement FedaPay", () => {
  it("confirme la réservation sur paiement réussi", () => {
    expect(settlementFor("approved")).toEqual({ payment: "SUCCEEDED", booking: "CONFIRMED" });
    expect(settlementFor("transferred")).toEqual({ payment: "SUCCEEDED", booking: "CONFIRMED" });
  });

  it("laisse la réservation ouverte sur paiement échoué", () => {
    // `declined` n'est pas final chez FedaPay : le client peut réessayer.
    expect(settlementFor("declined")).toEqual({ payment: "FAILED", booking: null });
    expect(settlementFor("canceled")).toEqual({ payment: "FAILED", booking: null });
  });

  it("libère le créneau quand la transaction expire", () => {
    expect(settlementFor("expired")).toEqual({ payment: "FAILED", booking: "EXPIRED" });
  });

  it("annule la réservation sur remboursement", () => {
    expect(settlementFor("refunded").booking).toBe("CANCELLED");
    expect(settlementFor("approved_partially_refunded").payment).toBe("REFUNDED");
  });

  it("ne confirme jamais sur un statut pending", () => {
    expect(settlementFor("pending")).toEqual({ payment: "PENDING", booking: null });
  });
});

describe("idempotence du webhook", () => {
  const transaction = { id: 42, status: "approved" } as FedaPayTransaction;

  it("produit la même clé pour deux livraisons du même événement", () => {
    const event = { id: "evt_1", name: "transaction.approved" };
    expect(idempotencyKey(event, transaction)).toBe(idempotencyKey(event, transaction));
  });

  it("reste stable sans identifiant d'événement", () => {
    const event = { name: "transaction.approved" };
    expect(idempotencyKey(event, transaction)).toBe("fedapay:transaction.approved:42:approved");
    expect(idempotencyKey(event, transaction)).toBe(idempotencyKey(event, transaction));
  });

  it("distingue deux transactions différentes", () => {
    const event = { name: "transaction.approved" };
    const other = { id: 43, status: "approved" } as FedaPayTransaction;
    expect(idempotencyKey(event, transaction)).not.toBe(idempotencyKey(event, other));
  });
});

describe("association transaction/réservation", () => {
  const booking = { id: "booking_1", providerTransactionId: "42", expectedAmount: 5500 };
  const transaction = {
    id: 42,
    status: "approved",
    amount: 5500,
    currency: { iso: "XOF" },
    merchant_reference: "booking_1",
    custom_metadata: { bookingId: "booking_1" },
  } as FedaPayTransaction;

  it("accepte uniquement une transaction totalement reliée au Booking", () => {
    expect(transactionMatchesBooking(transaction, booking, "XOF")).toBe(true);
  });

  it("refuse une référence marchande ou métadonnée divergente", () => {
    expect(transactionMatchesBooking({ ...transaction, merchant_reference: "booking_2" }, booking, "XOF")).toBe(false);
    expect(transactionMatchesBooking({ ...transaction, custom_metadata: { bookingId: "booking_2" } }, booking, "XOF")).toBe(false);
  });

  it("refuse un identifiant de transaction ou un montant divergent", () => {
    expect(transactionMatchesBooking({ ...transaction, id: 43 }, booking, "XOF")).toBe(false);
    expect(transactionMatchesBooking({ ...transaction, amount: 1 }, booking, "XOF")).toBe(false);
  });

  it("refuse une transaction réglée dans une autre devise", () => {
    expect(transactionMatchesBooking({ ...transaction, currency: { iso: "NGN" } }, booking, "XOF")).toBe(false);
  });

  it("refuse une transaction sans devise plutôt que de présumer XOF", () => {
    expect(transactionMatchesBooking({ ...transaction, currency: null }, booking, "XOF")).toBe(false);
    expect(transactionMatchesBooking({ ...transaction, currency: { iso: null } }, booking, "XOF")).toBe(false);
  });

  it("refuse une transaction rattachée à la réservation d'un autre client", () => {
    const autreBooking = { id: "booking_9", providerTransactionId: "99", expectedAmount: 5500 };
    expect(transactionMatchesBooking(transaction, autreBooking, "XOF")).toBe(false);
  });

  it("refuse une transaction non encore rattachée côté GENK", () => {
    expect(transactionMatchesBooking(transaction, { ...booking, providerTransactionId: null }, "XOF")).toBe(false);
  });
});

describe("token de confirmation", () => {
  it("produit un token CSPRNG url-safe de 256 bits", () => {
    const token = generateConfirmationToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
  });

  it("ne répète jamais un token", () => {
    const tokens = new Set(Array.from({ length: 500 }, generateConfirmationToken));
    expect(tokens.size).toBe(500);
  });

  it("ne persiste jamais la valeur en clair", () => {
    const token = generateConfirmationToken();
    const stored = hashConfirmationToken(token);
    expect(stored).not.toBe(token);
    expect(stored).not.toContain(token);
  });

  it("produit une empreinte déterministe, donc indexable", () => {
    const token = generateConfirmationToken();
    expect(hashConfirmationToken(token)).toBe(hashConfirmationToken(token));
  });

  it("sépare deux tokens voisins", () => {
    expect(hashConfirmationToken("a")).not.toBe(hashConfirmationToken("b"));
  });
});

describe("conflit de créneau remonté par PostgreSQL", () => {
  it("traduit la violation de la contrainte d'exclusion Booking_no_overlap", () => {
    const error = new Prisma.PrismaClientUnknownRequestError(
      'conflicting key value violates exclusion constraint "Booking_no_overlap" (SQLSTATE 23P01)',
      { clientVersion: "6.19.3" },
    );
    expect(isSlotConflict(error)).toBe(true);
  });

  it("traduit un échec de sérialisation entre deux réservations simultanées", () => {
    const error = new Prisma.PrismaClientUnknownRequestError(
      "could not serialize access due to concurrent update (SQLSTATE 40001)",
      { clientVersion: "6.19.3" },
    );
    expect(isSlotConflict(error)).toBe(true);
  });

  it("traduit une violation d'unicité Prisma", () => {
    const error = new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "6.19.3" });
    expect(isSlotConflict(error)).toBe(true);
  });

  it("laisse remonter une panne qui n'est pas un conflit de créneau", () => {
    expect(isSlotConflict(new Error("ECONNREFUSED"))).toBe(false);
    expect(
      isSlotConflict(new Prisma.PrismaClientKnownRequestError("absent", { code: "P2025", clientVersion: "6.19.3" })),
    ).toBe(false);
  });
});

describe("quota anti-spam WhatsApp", () => {
  it("applique des plafonds par défaut sans configuration", () => {
    const quota = bookingQuota();
    expect(quota.window).toBeGreaterThan(0);
    expect(quota.maxPerPhone).toBeGreaterThan(0);
    expect(quota.maxPerEmail).toBeGreaterThanOrEqual(quota.maxPerPhone);
  });

  it("ignore une configuration absurde plutôt que de désactiver le quota", () => {
    const previous = process.env.BOOKING_RATE_MAX_PER_PHONE;
    for (const value of ["0", "-5", "abc", ""]) {
      process.env.BOOKING_RATE_MAX_PER_PHONE = value;
      expect(bookingQuota().maxPerPhone).toBe(3);
    }
    if (previous === undefined) delete process.env.BOOKING_RATE_MAX_PER_PHONE;
    else process.env.BOOKING_RATE_MAX_PER_PHONE = previous;
  });
});

describe("numéro WhatsApp", () => {
  it("préserve un numéro déjà en E.164", () => {
    expect(toE164("+229 97 00 00 00")).toBe("+22997000000");
  });

  it("applique l'indicatif par défaut et retire le zéro initial", () => {
    expect(toE164("097000000", "229")).toBe("+22997000000");
  });

  it("refuse un numéro local sans indicatif connu", () => {
    expect(() => toE164("97000000", "")).toThrow("PHONE_MISSING_COUNTRY_CODE");
  });

  it("refuse une saisie sans chiffre", () => {
    expect(() => toE164("inconnu", "229")).toThrow("PHONE_INVALID");
  });
});

describe("retry WhatsApp", () => {
  it("réessaie sur limitation de débit", () => {
    expect(isRetryableWhatsAppError(130429, 429)).toBe(true);
  });

  it("ne réessaie pas sur token expiré ou template refusé", () => {
    expect(isRetryableWhatsAppError(190, 401)).toBe(false);
    expect(isRetryableWhatsAppError(132001, 400)).toBe(false);
  });

  it("réessaie sur erreur serveur sans code applicatif", () => {
    expect(isRetryableWhatsAppError(undefined, 503)).toBe(true);
    expect(isRetryableWhatsAppError(undefined, 400)).toBe(false);
  });
});

describe("client FedaPay", () => {
  it("découpe le nom saisi en prénom et nom", () => {
    expect(splitCustomerName("Awa Diallo")).toEqual({ firstname: "Awa", lastname: "Diallo" });
    expect(splitCustomerName("Awa  Sow  Diallo")).toEqual({ firstname: "Awa", lastname: "Sow Diallo" });
  });

  it("duplique un nom unique, l'API exigeant les deux champs", () => {
    expect(splitCustomerName("Awa")).toEqual({ firstname: "Awa", lastname: "Awa" });
  });
});
