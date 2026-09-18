/**
 * Accès centralisé aux secrets serveur. Rien n'est lu au moment du build :
 * chaque helper échoue à l'appel si la variable manque, ce qui permet de
 * construire l'application sans credentials.
 */

export class MissingEnvError extends Error {
  constructor(public readonly variable: string) {
    super(`Variable d'environnement manquante: ${variable}`);
    this.name = "MissingEnvError";
  }
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new MissingEnvError(name);
  return value;
}

export function optionalEnv(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export function appUrl(): string {
  return requireEnv("NEXT_PUBLIC_APP_URL").replace(/\/+$/, "");
}

/** URL publique ouverte hors de l'application pour déclencher le paiement. */
export function confirmationUrl(token: string): string {
  return `${appUrl()}/confirmation/${encodeURIComponent(token)}`;
}
