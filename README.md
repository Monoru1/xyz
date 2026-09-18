# GENK

GENK est un SaaS de réservation beauté mobile-first. Il fournit un parcours client, un dashboard propriétaire, des disponibilités, des holds temporaires, une confirmation par WhatsApp et un encaissement FedaPay en XOF, plus une application Android Capacitor.

## Architecture

- Next.js App Router, React, TypeScript et Tailwind CSS.
- PostgreSQL via Prisma. Une contrainte d’exclusion PostgreSQL `tstzrange` empêche en dernier recours deux réservations actives de se chevaucher.
- Auth.js Credentials pour les propriétaires.
- Capacitor emballe l’URL du SaaS déployé; le web reste l’application principale.

## Parcours de réservation

L’application ne déclenche **jamais** de paiement. Le paiement vit entièrement hors de l’application.

1. Le client choisit salon, service, créneau et saisit ses coordonnées dont son numéro WhatsApp.
2. `POST /api/bookings` crée la réservation en `HOLD` avec un token de confirmation opaque (32 octets aléatoires) et une date d’expiration. L’interface affiche immédiatement « Réservation envoyée — en attente de confirmation ».
3. Le serveur envoie au client, via WhatsApp Cloud API, un template dont le bouton URL pointe vers `/confirmation/{token}`.
4. À l’ouverture de ce lien — hors de l’application — le serveur crée la transaction FedaPay (XOF, `merchant_reference` = identifiant du Booking), passe la réservation en `PENDING_PAYMENT` et redirige vers la page de paiement hébergée par FedaPay.
5. `POST /api/fedapay/webhook` vérifie la signature officielle, relit la transaction auprès de FedaPay, met à jour `Payment` et ne passe la réservation en `CONFIRMED` qu’après paiement effectif. Le traitement est idempotent via la table `WebhookEvent`.

Un échec d’envoi WhatsApp n’annule pas la réservation : il est tracé dans `Booking.notificationError` pour permettre un renvoi par le salon.

## Démarrage

1. Copier `.env.example` vers `.env` et renseigner PostgreSQL, Auth.js, WhatsApp et FedaPay.
2. `npm install`
3. `npm run db:generate && npm run db:migrate && npm run db:seed`
4. `npm run dev`

Compte de démonstration seedé: `owner@genk.local` / `DemoGenk123!` (à changer hors développement). Salon public: `/salons/demo`.

## Configuration WhatsApp Cloud API

Le premier message vers un client qui n’a pas écrit dans les 24 h doit passer par un template approuvé. Créer dans WhatsApp Manager un template avec :

- un corps contenant un paramètre texte (le nom du client) ;
- un bouton **URL dynamique** dont la base est `https://<NEXT_PUBLIC_APP_URL>/confirmation/` et dont le suffixe est le paramètre variable.

Renseigner ensuite `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN` (System User permanent), `WHATSAPP_TEMPLATE_NAME` et `WHATSAPP_DEFAULT_COUNTRY_CODE`.

## Configuration FedaPay

Environnement Sandbox et devise XOF par défaut. Renseigner `FEDAPAY_SECRET_KEY` et déclarer dans le dashboard FedaPay un webhook pointant sur `https://<NEXT_PUBLIC_APP_URL>/api/fedapay/webhook`, puis reporter son secret dans `FEDAPAY_WEBHOOK_SECRET`. Les clés restent exclusivement côté serveur : aucune n’est exposée via `NEXT_PUBLIC_*`.

## Android

Définir `CAPACITOR_SERVER_URL` sur une URL HTTPS de GENK, puis `npm run android:build`. L’APK debug est produit sous `android/app/build/outputs/apk/debug/app-debug.apk`. Sans URL, l’APK affiche une page de configuration embarquée; il reste compilable et installable.

### Release Android (.aab)

La signature est pilotée par l’environnement; aucun keystore n’est versionné. Définir avant le build :

```
ANDROID_KEYSTORE_PATH=/chemin/absolu/genk-release.jks
ANDROID_KEYSTORE_PASSWORD=…
ANDROID_KEY_ALIAS=…
ANDROID_KEY_PASSWORD=…
```

Puis `npm run android:release`. Le bundle est produit sous `android/app/build/outputs/bundle/release/app-release.aab`. Sans ces variables, le build release reste non signé et seul le build debug est exploitable.

## Vérification

`npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npx prisma validate`.
