import type { NextConfig } from "next";

const isProduction = process.env.NODE_ENV === "production";

/**
 * CSP volontairement compatible avec le runtime Next.js.
 *
 * `script-src 'unsafe-inline'` reste nécessaire : l'App Router injecte le
 * bootstrap et les flight chunks en scripts inline sans nonce dès qu'aucun
 * middleware ne génère ce nonce. `'unsafe-eval'` et `ws:` ne sont ouverts
 * qu'en développement (react-refresh / HMR).
 *
 * Aucun domaine tiers n'est autorisé : le navigateur ne parle qu'à GENK.
 * FedaPay n'est jamais embarqué, il est atteint par redirection de navigation.
 */
function contentSecurityPolicy(): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isProduction ? "" : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${isProduction ? "" : " ws: http://localhost:*"}`,
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "base-uri 'self'",
    "object-src 'none'",
    ...(isProduction ? ["upgrade-insecure-requests"] : []),
  ];
  return directives.join("; ");
}

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy() },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  // HSTS n'a de sens que derrière HTTPS : il n'est posé qu'en production.
  ...(isProduction
    ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]
    : []),
];

const nextConfig: NextConfig = {
  // N'annonce pas la version du framework.
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Pages portant une réservation nominative ou un lien de confirmation :
      // jamais mises en cache par un proxy ou un navigateur partagé.
      {
        source: "/(confirmation|reservation|dashboard)/:path*",
        headers: [{ key: "Cache-Control", value: "no-store, no-cache, must-revalidate, private" }],
      },
      {
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
    ];
  },
};

export default nextConfig;
