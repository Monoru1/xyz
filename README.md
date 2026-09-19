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
2. `POST /api/bookings` normalise le numéro en E.164, applique les quotas anti-spam, puis crée la réservation en `HOLD` avec un token de confirmation opaque (32 octets CSPRNG) et une date d’expiration. Seule l’empreinte SHA-256 du token est persistée : la valeur en clair ne vit que le temps de l’envoi WhatsApp. L’interface affiche immédiatement « Réservation envoyée — en attente de confirmation ».
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

## Variables d’environnement

| Variable | Classification | Rôle |
| --- | --- | --- |
| `DATABASE_URL` | SERVER_SECRET | Connexion PostgreSQL/Supabase. Contient le mot de passe du rôle. |
| `AUTH_SECRET` | SERVER_SECRET | Signature des JWT de session Auth.js. |
| `AUTH_URL` | SERVER_CONFIG | URL canonique des callbacks Auth.js. À définir en production pour ne pas dépendre de l’en-tête `Host`. |
| `AUTH_TRUST_HOST` | SERVER_CONFIG | `true` derrière le proxy HTTPS Vercel ; autorise Auth.js à utiliser les en-têtes transmis par l’hébergeur. |
| `NEXT_PUBLIC_APP_URL` | PUBLIC | Base HTTPS des liens de confirmation. Publique par construction : le lien est ouvert hors de l’application. |
| `NEXT_PUBLIC_CURRENCY` | PUBLIC | Devise affichée. Doit rester alignée sur `FEDAPAY_CURRENCY`. |
| `BOOKING_HOLD_MINUTES` | SERVER_CONFIG | Durée du hold et validité du lien de confirmation. |
| `BOOKING_RATE_WINDOW_MINUTES` | SERVER_CONFIG | Fenêtre du quota anti-spam. |
| `BOOKING_RATE_MAX_PER_PHONE` | SERVER_CONFIG | Messages WhatsApp maximum par numéro et par fenêtre. |
| `BOOKING_RATE_MAX_PER_EMAIL` | SERVER_CONFIG | Réservations maximum par e-mail et par fenêtre. |
| `TZ` | SERVER_CONFIG | Fuseau du processus. **Obligatoire en production** (voir « Limites connues »). |
| `WHATSAPP_ACCESS_TOKEN` | SERVER_SECRET | Token System User Meta. Ne doit jamais atteindre le client. |
| `WHATSAPP_PHONE_NUMBER_ID` | SERVER_CONFIG | Numéro émetteur. |
| `WHATSAPP_TEMPLATE_NAME` | SERVER_CONFIG | Template approuvé porteur du bouton URL. |
| `WHATSAPP_TEMPLATE_LANGUAGE` | SERVER_CONFIG | Langue du template (`fr` par défaut). |
| `WHATSAPP_API_VERSION` | SERVER_CONFIG | Version de la Graph API (`v25.0` par défaut). |
| `WHATSAPP_DEFAULT_COUNTRY_CODE` | SERVER_CONFIG | Indicatif appliqué aux numéros saisis sans `+`. Sans lui, ces saisies sont rejetées en 400. |
| `FEDAPAY_SECRET_KEY` | SERVER_SECRET | Clé API FedaPay. |
| `FEDAPAY_WEBHOOK_SECRET` | SERVER_SECRET | Secret de vérification de signature du webhook. |
| `FEDAPAY_ENVIRONMENT` | SERVER_CONFIG | `sandbox` ou `live`. |
| `FEDAPAY_API_VERSION` | SERVER_CONFIG | Version de l’API (`v1`). |
| `FEDAPAY_CURRENCY` | SERVER_CONFIG | Devise exigée à la vérification du webhook. |
| `FEDAPAY_CUSTOMER_COUNTRY` | SERVER_CONFIG | Pays du numéro client transmis à FedaPay. |
| `CAPACITOR_SERVER_URL` | BUILD_SECRET | URL HTTPS chargée par la WebView. Figée dans l’APK au build. |
| `ANDROID_KEYSTORE_PATH` / `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD` | BUILD_SECRET / LOCAL_ONLY | Signature de la release Android. Poste de build uniquement, jamais en production serveur. |

Seules deux variables sont exposées au navigateur : `NEXT_PUBLIC_APP_URL` et `NEXT_PUBLIC_CURRENCY`. Aucun secret ne transite par un préfixe `NEXT_PUBLIC_*`.

### Checklist de saisie

- **Vercel → Project Settings → Environment Variables (Production)** : saisir toutes les variables `PUBLIC`, `SERVER_CONFIG` et `SERVER_SECRET` du tableau. Les secrets à saisir manuellement sont `DATABASE_URL`, `AUTH_SECRET`, `WHATSAPP_ACCESS_TOKEN`, `FEDAPAY_SECRET_KEY` et `FEDAPAY_WEBHOOK_SECRET`; ne jamais les copier dans Git ou Paperclip. Définir `FEDAPAY_ENVIRONMENT=sandbox`, `AUTH_TRUST_HOST=true`, `AUTH_URL=https://DOMAIN` et `NEXT_PUBLIC_APP_URL=https://DOMAIN`.
- **Poste/CI de build Android uniquement** : saisir `CAPACITOR_SERVER_URL=https://DOMAIN` et, pour une release signée, les quatre variables `ANDROID_*`. Elles ne sont pas nécessaires au runtime Vercel.
- **Supabase → Connect** : copier l’URL du Session Pooler dans `DATABASE_URL` côté Vercel. Ne lancer ni SQL de lockdown ni migration depuis le déploiement.
- **Meta WhatsApp Manager** : garder le token hors du dépôt, sélectionner le numéro test, approuver le template et son bouton dynamique `https://DOMAIN/confirmation/{{1}}`. Les destinataires sont normalisés en E.164 ; le corps reçoit le nom du client et le bouton reçoit le token comme paramètres dynamiques.
- **FedaPay Sandbox → Webhooks** : enregistrer exactement `https://DOMAIN/api/fedapay/webhook`, puis saisir le secret généré dans Vercel.

## Sécurité

### Frontière d’accès aux données

GENK utilise exclusivement `navigateur → Next.js → Prisma → PostgreSQL`. Aucune dépendance `@supabase/supabase-js` n’est installée et le navigateur n’appelle jamais la Data API Supabase. Cette frontière est structurante : la clé anonyme Supabase n’a aucun rôle dans l’application et ne doit jamais être distribuée au client.

Conséquence : les tables créées par Prisma dans le schéma `public` n’ont **aucune politique RLS**. Si la Data API du projet Supabase est active, la clé anonyme — publique par nature — suffit à lire `User.passwordHash`, les coordonnées clients et à forcer un `Booking.status`. `supabase/production-lockdown.sql` retire cet accès (REVOKE + RLS sans politique) sans affecter Prisma, qui se connecte avec un rôle `BYPASSRLS`. **Ce script doit être exécuté avant toute mise en ligne.**

### Rate limiting

`POST /api/bookings` déclenche un message WhatsApp facturé vers un numéro choisi par l’appelant. Le quota est tenu en base PostgreSQL (comptage sur `Booking.createdAt` par numéro canonisé et par e-mail) : il reste donc exact avec plusieurs instances serverless, contrairement à un compteur en mémoire, et borne directement la ressource à protéger — le nombre de messages reçus par un destinataire.

Ce quota ne couvre pas un flood distribué sur des numéros différents. Cette protection-là relève du WAF/CDN de l’hébergeur et **reste à activer manuellement** : limitation par IP sur `POST /api/bookings` et `/confirmation/*` (Vercel WAF, Cloudflare Rate Limiting ou équivalent). Le webhook FedaPay est protégé par la vérification de signature et la table `WebhookEvent` ; `/api/auth/*` doit être limité par IP au même niveau.

### Garanties du webhook FedaPay

Un webhook reçu ne confirme jamais seul une réservation. Trois contrôles s’enchaînent : signature `X-FEDAPAY-SIGNATURE` vérifiée par le SDK officiel, relecture serveur-à-serveur de la transaction, puis correspondance exacte entre la transaction et la réservation (`merchant_reference`, `custom_metadata.bookingId`, identifiant technique, montant **et devise**). L’idempotence est garantie par `WebhookEvent`, y compris en cas de rejeu.

## Déploiement HTTPS

Prérequis : hébergeur compatible Next.js 16 App Router avec runtime Node.js. Le webhook et les liens de confirmation exigent une URL publique en HTTPS.

1. **Supabase** — le lockdown et les migrations sont déjà appliqués. Ne réexécuter ni SQL de lockdown, ni `migrate dev`, ni `db push` depuis le déploiement.
2. **Connexion** — fournir à Prisma l’URL du Session Pooler Supabase via `DATABASE_URL`; ne jamais la hardcoder.
3. **Variables** — renseigner le tableau ci-dessus dans l’hébergeur. `NEXT_PUBLIC_APP_URL`, `AUTH_URL` et `CAPACITOR_SERVER_URL` portent la **même** URL HTTPS publique.
4. **Build** — `npm run build`. **Runtime** — `npm start` (Node.js, pas d’export statique : les routes API et les pages dynamiques en dépendent).
5. **FedaPay** — déclarer le webhook sur `https://<domaine>/api/fedapay/webhook`, reporter son secret dans `FEDAPAY_WEBHOOK_SECRET`.
6. **Meta/WhatsApp** — le bouton URL dynamique du template doit avoir pour base `https://<domaine>/confirmation/`, et le domaine doit être ajouté aux domaines autorisés de l’app Meta.
7. **WAF** — activer la limitation par IP décrite plus haut.
8. **Android** — reconstruire l’APK/AAB après fixation de `CAPACITOR_SERVER_URL` : l’URL est figée au build.
9. **Health check** — vérifier `GET https://<domaine>/api/health` : la réponse attendue est uniquement `{ "status": "ok" }`.

### Recette réelle

Les tests automatisés n’appellent ni FedaPay ni WhatsApp ni PostgreSQL : ils valident les décisions prises à partir de données fournies. Le parcours `navigateur → GENK → Supabase → WhatsApp réel → FedaPay Sandbox → webhook → CONFIRMED` n’est validé que par une recette manuelle sur l’environnement déployé, avec un numéro WhatsApp réel et un compte FedaPay Sandbox.

## Limites connues

- **Fuseau horaire** — `/api/slots` calcule les créneaux dans le fuseau du processus Node.js, pas dans `Salon.timezone`. Sur un hébergeur en UTC, les horaires proposés sont décalés. Définir `TZ` sur le fuseau du salon jusqu’à la prise en charge multi-fuseaux.
- **Empreintes de token** — le passage au stockage haché invalide les liens de confirmation émis avant ce changement. Les réservations concernées doivent être renotifiées.
- **`npm audit`** — vulnérabilités résiduelles toutes transitives et cantonnées à l’outillage : `axios` 0.28 via `fedapay` (seul `Webhook.constructEvent` est utilisé, aucun appel HTTP ne passe par axios — les appels REST utilisent `fetch`), `deepmerge-ts` via la CLI Prisma (build), `uuid`/`xcode` via `@capacitor/cli` (build Android), `@vitest/mocker` (exploitable seulement si le serveur Vitest UI écoute, jamais lancé). Les correctifs proposés sont des rétrogradations majeures de `prisma` et `@capacitor/cli` : non appliquées.

## Vérification

`npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npx prisma validate`.
