import { requireEnv, optionalEnv } from "@/lib/env";

/**
 * Abstraction serveur de Meta WhatsApp Cloud API.
 *
 * Référence: https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages
 *
 * Un message sortant vers un client qui n'a pas écrit dans les 24 dernières
 * heures doit obligatoirement utiliser un template approuvé (sinon erreur 131047).
 * Le lien de confirmation est donc passé en paramètre d'un bouton URL dynamique,
 * dont seul le suffixe est variable côté Meta.
 */

export type WhatsAppConfig = {
  apiVersion: string;
  phoneNumberId: string;
  accessToken: string;
  templateName: string;
  templateLanguage: string;
};

export function getWhatsAppConfig(): WhatsAppConfig {
  return {
    apiVersion: optionalEnv("WHATSAPP_API_VERSION", "v25.0"),
    phoneNumberId: requireEnv("WHATSAPP_PHONE_NUMBER_ID"),
    accessToken: requireEnv("WHATSAPP_ACCESS_TOKEN"),
    templateName: requireEnv("WHATSAPP_TEMPLATE_NAME"),
    templateLanguage: optionalEnv("WHATSAPP_TEMPLATE_LANGUAGE", "fr"),
  };
}

/**
 * Le champ `to` doit être au format E.164 avec l'indicatif pays. Sans le `+`,
 * Meta préfixe l'indicatif du numéro émetteur et le message part au mauvais
 * destinataire.
 */
export function toE164(raw: string, defaultCountryCode = optionalEnv("WHATSAPP_DEFAULT_COUNTRY_CODE", "")): string {
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) throw new Error("PHONE_INVALID");
  if (hasPlus) return `+${digits}`;
  const prefix = defaultCountryCode.replace(/\D/g, "");
  if (!prefix) throw new Error("PHONE_MISSING_COUNTRY_CODE");
  return `+${prefix}${digits.replace(/^0+/, "")}`;
}

/**
 * Codes d'erreur Meta documentés comme transitoires (HTTP 429/500/503).
 * Tout le reste — numéro injoignable, template refusé, token expiré — est
 * définitif : réessayer dégrade la note qualité du numéro émetteur.
 * Référence: https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes
 */
const RETRYABLE_ERROR_CODES = new Set([4, 80007, 130429, 131000, 131016, 131048, 131049, 131056]);

export function isRetryableWhatsAppError(code: number | undefined, httpStatus: number): boolean {
  if (code !== undefined && RETRYABLE_ERROR_CODES.has(code)) return true;
  return code === undefined && httpStatus >= 500;
}

export class WhatsAppError extends Error {
  constructor(
    message: string,
    readonly code: number | undefined,
    readonly httpStatus: number,
    readonly retryable: boolean,
    readonly fbtraceId?: string,
  ) {
    super(message);
    this.name = "WhatsAppError";
  }
}

type MetaErrorBody = {
  error?: {
    message?: string;
    code?: number;
    error_data?: { details?: string };
    fbtrace_id?: string;
  };
};

export type SendResult = { messageId: string };

/**
 * Envoie le template de confirmation. `confirmationSuffix` est la partie
 * variable de l'URL du bouton (le template fige le domaine et le préfixe de
 * chemin à l'approbation).
 */
export async function sendConfirmationTemplate(
  params: { to: string; customerName: string; confirmationSuffix: string },
  config: WhatsAppConfig = getWhatsAppConfig(),
): Promise<SendResult> {
  const body = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: toE164(params.to),
    type: "template",
    template: {
      name: config.templateName,
      language: { code: config.templateLanguage },
      components: [
        {
          type: "body",
          parameters: [{ type: "text", text: params.customerName }],
        },
        {
          type: "button",
          sub_type: "url",
          index: "0",
          parameters: [{ type: "text", text: encodeURIComponent(params.confirmationSuffix) }],
        },
      ],
    },
  };

  return withRetry(async () => {
    const response = await fetch(
      `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );

    const payload = (await response.json().catch(() => ({}))) as MetaErrorBody & {
      messages?: { id: string }[];
    };

    if (!response.ok) {
      const error = payload.error;
      throw new WhatsAppError(
        error?.error_data?.details ?? error?.message ?? "Envoi WhatsApp refusé",
        error?.code,
        response.status,
        isRetryableWhatsAppError(error?.code, response.status),
        error?.fbtrace_id,
      );
    }

    const messageId = payload.messages?.[0]?.id;
    if (!messageId) throw new WhatsAppError("Réponse WhatsApp sans identifiant de message", undefined, response.status, false);
    return { messageId };
  });
}

async function withRetry<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const retryable = error instanceof WhatsAppError ? error.retryable : true;
      if (!retryable || attempt === attempts - 1) break;
      const delay = 1000 * 2 ** attempt + Math.floor(Math.random() * 250);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
