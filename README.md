# GENK

GENK est un SaaS de réservation beauté mobile-first. Il fournit un parcours client, un dashboard propriétaire, des disponibilités, des holds temporaires, un paiement Stripe et une application Android Capacitor.

## Architecture

- Next.js App Router, React, TypeScript et Tailwind CSS.
- PostgreSQL via Prisma. Une contrainte d’exclusion PostgreSQL `tstzrange` empêche en dernier recours deux réservations actives de se chevaucher.
- Auth.js Credentials pour les propriétaires.
- Stripe Checkout. Une réservation démarre en `HOLD`, passe à `PENDING_PAYMENT`, et n’est `CONFIRMED` que par le webhook signé et idempotent.
- Capacitor emballe l’URL du SaaS déployé; le web reste l’application principale.

## Démarrage

1. Copier `.env.example` vers `.env` et renseigner PostgreSQL, Auth.js et Stripe.
2. `npm install`
3. `npm run db:generate && npm run db:migrate && npm run db:seed`
4. `npm run dev`

Compte de démonstration seedé: `owner@genk.local` / `DemoGenk123!` (à changer hors développement). Salon public: `/salons/demo`.

Pour recevoir les confirmations Stripe en local: `stripe listen --forward-to localhost:3000/api/stripe/webhook`, puis copier le secret `whsec_…` dans `.env`.

## Android

Définir `CAPACITOR_SERVER_URL` sur une URL HTTPS de GENK, puis `npm run android:build`. L’APK debug est produit sous `android/app/build/outputs/apk/debug/app-debug.apk`. Sans URL, l’APK affiche une page de configuration embarquée; il reste compilable et installable.

## Vérification

`npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.
