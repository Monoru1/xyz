import { Webhook } from "fedapay";
import { requireEnv, optionalEnv } from "@/lib/env";

/**
 * Abstraction serveur de FedaPay (collecte XOF).
 *
 * Références:
 *  - https://docs.fedapay.com/integration-api/en/collects-management-en
 *  - https://docs.fedapay.com/api-reference/transactions/create
 *  - https://docs.fedapay.com/integration-api/en/webhooks-en
 *
 * Les appels REST passent par `fetch` ; la vérification de signature utilise le
 * helper officiel du SDK `fedapay` afin de ne dépendre d'aucune réimplémentation
 * du schéma de signature.
 */

const SANDBOX_BASE = "https://sandbox-api.fedapay.com";
const LIVE_BASE = "https://api.fedapay.com";

export function fedapayBaseUrl(): string {
  const environment = optionalEnv("FEDAPAY_ENVIRONMENT", "sandbox");
  return environment === "live" || environment === "production" ? LIVE_BASE : SANDBOX_BASE;
}

function apiUrl(path: string): string {
  return `${fedapayBaseUrl()}/${optionalEnv("FEDAPAY_API_VERSION", "v1")}${path}`;
}

export class FedaPayError extends Error {
  constructor(message: string, readonly httpStatus: number) {
    super(message);
    this.name = "FedaPayError";
  }
}

/** Statuts renvoyés par FedaPay (cycle de vie d'une transaction). */
export type FedaPayStatus =
  | "pending"
  | "approved"
  | "declined"
  | "canceled"
  | "refunded"
  | "transferred"
  | "expired"
  | "approved_partially_refunded"
  | "transferred_partially_refunded";

export type FedaPayTransaction = {
  id: number;
  reference?: string;
  status: FedaPayStatus;
  amount: number;
  /** L'API renvoie la devise sous forme d'objet (`{ iso: "XOF" }`). */
  currency?: { iso?: string | null } | null;
  merchant_reference?: string | null;
  custom_metadata?: Record<string, unknown> | null;
};

/** Devise attendue pour toute transaction GENK. */
export function expectedCurrency(): string {
  return optionalEnv("FEDAPAY_CURRENCY", "XOF").toUpperCase();
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const response = await fetch(apiUrl(path), {
    method,
    headers: {
      Authorization: `Bearer ${requireEnv("FEDAPAY_SECRET_KEY")}`,
      "Content-Type": "application/json",
      "X-Source": "GENK",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      (payload && typeof payload === "object" && "message" in payload && String(payload.message)) ||
      `Appel FedaPay ${method} ${path} en échec`;
    throw new FedaPayError(message, response.status);
  }
  return payload as T;
}

/**
 * Les réponses de l'API sont enveloppées sous une clé versionnée
 * (`{"v1/transaction": {...}}`), comme le confirme `Resource._create` du SDK.
 */
function unwrap<T>(payload: unknown, resource: string): T {
  if (!payload || typeof payload !== "object") throw new FedaPayError("Réponse FedaPay illisible", 502);
  const record = payload as Record<string, unknown>;
  const value = record[`${optionalEnv("FEDAPAY_API_VERSION", "v1")}/${resource}`] ?? record[resource];
  if (!value) throw new FedaPayError(`Réponse FedaPay sans ${resource}`, 502);
  return value as T;
}

export type CreateTransactionInput = {
  /** Référence marchand unique: l'identifiant du Booking. */
  merchantReference: string;
  description: string;
  amount: number;
  callbackUrl: string;
  customer: { firstname: string; lastname: string; email: string; phoneNumber?: { number: string; country: string } };
};

export async function createTransaction(input: CreateTransactionInput): Promise<FedaPayTransaction> {
  const payload = await request<unknown>("POST", "/transactions", {
    description: input.description,
    amount: input.amount,
    currency: { iso: optionalEnv("FEDAPAY_CURRENCY", "XOF") },
    callback_url: input.callbackUrl,
    merchant_reference: input.merchantReference,
    custom_metadata: { bookingId: input.merchantReference },
    customer: {
      firstname: input.customer.firstname,
      lastname: input.customer.lastname,
      email: input.customer.email,
      ...(input.customer.phoneNumber ? { phone_number: input.customer.phoneNumber } : {}),
    },
  });
  return unwrap<FedaPayTransaction>(payload, "transaction");
}

/** Génère le lien de paiement hébergé par FedaPay. */
export async function generatePaymentUrl(transactionId: number): Promise<{ token: string; url: string }> {
  return request<{ token: string; url: string }>("POST", `/transactions/${transactionId}/token`);
}

/** Relecture serveur-à-serveur: seule source de vérité sur l'état du paiement. */
export async function retrieveTransaction(transactionId: number): Promise<FedaPayTransaction> {
  const payload = await request<unknown>("GET", `/transactions/${transactionId}`);
  return unwrap<FedaPayTransaction>(payload, "transaction");
}

export type WebhookEventPayload = {
  id?: string | number;
  name: string;
  entity?: Record<string, unknown>;
  object?: Record<string, unknown>;
};

/**
 * Vérifie l'en-tête `X-FEDAPAY-SIGNATURE` via le helper officiel du SDK.
 * Le corps doit être la chaîne brute reçue, non reparsée.
 */
export function verifyWebhookEvent(rawBody: string, signatureHeader: string | null): WebhookEventPayload {
  if (!signatureHeader) throw new FedaPayError("Signature FedaPay absente", 400);
  return Webhook.constructEvent(rawBody, signatureHeader, requireEnv("FEDAPAY_WEBHOOK_SECRET")) as WebhookEventPayload;
}

/** Extrait la transaction portée par un événement webhook. */
export function extractTransaction(event: WebhookEventPayload): FedaPayTransaction | null {
  const entity = (event.entity ?? event.object) as FedaPayTransaction | undefined;
  if (!entity || typeof entity.id !== "number") return null;
  return entity;
}

/**
 * Clé d'idempotence. FedaPay ne garantit pas d'identifiant d'événement dans le
 * payload: on retombe alors sur le triplet événement/transaction/statut, qui
 * reste stable entre deux livraisons du même événement.
 */
export function idempotencyKey(event: WebhookEventPayload, transaction: FedaPayTransaction | null): string {
  if (event.id !== undefined && event.id !== null) return `fedapay:${event.id}`;
  return `fedapay:${event.name}:${transaction?.id ?? "unknown"}:${transaction?.status ?? "unknown"}`;
}

/**
 * Refuse toute association ambiguë entre une transaction et une réservation.
 * La référence marchande, la métadonnée, l'identifiant technique, le montant et
 * la devise doivent tous correspondre aux valeurs créées par GENK.
 *
 * Sans le contrôle de devise, un même montant nominal réglé dans une devise
 * moins valorisée confirmerait la réservation à vil prix.
 */
export function transactionMatchesBooking(
  transaction: FedaPayTransaction,
  booking: { id: string; providerTransactionId: string | null; expectedAmount: number },
  currency = expectedCurrency(),
): boolean {
  const metadataBookingId = transaction.custom_metadata?.bookingId;
  return (
    transaction.merchant_reference === booking.id &&
    metadataBookingId === booking.id &&
    String(transaction.id) === booking.providerTransactionId &&
    transaction.amount === booking.expectedAmount &&
    (transaction.currency?.iso ?? "").toUpperCase() === currency
  );
}

export type SettlementOutcome = {
  payment: "PENDING" | "SUCCEEDED" | "FAILED" | "REFUNDED";
  booking: "HOLD" | "PENDING_PAYMENT" | "CONFIRMED" | "CANCELLED" | "EXPIRED" | null;
};

/**
 * Traduit un statut FedaPay en états métier GENK.
 * `booking: null` signifie « ne rien changer » — `declined` et `canceled` ne sont
 * pas des statuts finaux chez FedaPay, une nouvelle tentative reste possible.
 */
export function settlementFor(status: FedaPayStatus): SettlementOutcome {
  switch (status) {
    case "approved":
    case "transferred":
      return { payment: "SUCCEEDED", booking: "CONFIRMED" };
    case "refunded":
    case "approved_partially_refunded":
    case "transferred_partially_refunded":
      return { payment: "REFUNDED", booking: "CANCELLED" };
    case "declined":
    case "canceled":
      return { payment: "FAILED", booking: null };
    case "expired":
      return { payment: "FAILED", booking: "EXPIRED" };
    case "pending":
    default:
      return { payment: "PENDING", booking: null };
  }
}
