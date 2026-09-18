/**
 * Les montants sont stockés en unité mineure de la devise. Le franc CFA (XOF)
 * n'a pas de sous-unité: le montant stocké est donc directement le montant dû.
 */
const ZERO_DECIMAL_CURRENCIES = new Set(["XOF", "XAF", "JPY", "KRW"]);

export function currencyCode(): string {
  return process.env.NEXT_PUBLIC_CURRENCY || "XOF";
}

export function toMajorUnit(minorAmount: number, currency = currencyCode()): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? minorAmount : minorAmount / 100;
}

export function formatAmount(minorAmount: number, currency = currencyCode()): string {
  const code = currency.toUpperCase();
  const value = toMajorUnit(minorAmount, code);
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: code,
    maximumFractionDigits: ZERO_DECIMAL_CURRENCIES.has(code) ? 0 : 2,
  }).format(value);
}
