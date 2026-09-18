-- Phase 2 : remplacement de Stripe par un modèle générique de fournisseur de paiement
-- (FedaPay) et ajout du lien de confirmation WhatsApp.
--
-- Migration volontairement NON DESTRUCTIVE :
--   * aucune table n'est supprimée ni recréée ;
--   * les colonnes Stripe sont RENOMMÉES vers le modèle générique, jamais supprimées,
--     afin de conserver les identifiants historiques ;
--   * la contrainte d'exclusion "Booking_no_overlap" posée par 20260916162000_init
--     n'est pas touchée et reste l'ultime garde anti-double réservation.

CREATE TYPE "PaymentProvider" AS ENUM ('FEDAPAY');

-- Booking : l'identifiant de session Stripe devient l'identifiant de transaction du fournisseur.
ALTER TABLE "Booking" RENAME COLUMN "stripeSessionId" TO "providerTransactionId";
ALTER INDEX "Booking_stripeSessionId_key" RENAME TO "Booking_providerTransactionId_key";

-- Booking : lien de confirmation unique envoyé par WhatsApp et suivi de la notification.
ALTER TABLE "Booking" ADD COLUMN "confirmationToken" TEXT;
ALTER TABLE "Booking" ADD COLUMN "confirmationExpiresAt" TIMESTAMP(3);
ALTER TABLE "Booking" ADD COLUMN "notifiedAt" TIMESTAMP(3);
ALTER TABLE "Booking" ADD COLUMN "notificationError" TEXT;
CREATE UNIQUE INDEX "Booking_confirmationToken_key" ON "Booking"("confirmationToken");

-- Payment : modèle générique de fournisseur.
ALTER TABLE "Payment" RENAME COLUMN "stripePaymentId" TO "providerTransactionId";
ALTER INDEX "Payment_stripePaymentId_key" RENAME TO "Payment_providerTransactionId_key";
ALTER TABLE "Payment" ADD COLUMN "provider" "PaymentProvider" NOT NULL DEFAULT 'FEDAPAY';
ALTER TABLE "Payment" ADD COLUMN "providerReference" TEXT;

-- Payment : la devise de référence devient le franc CFA (XOF).
-- Les lignes existantes conservent leur devise historique, seul le défaut change.
ALTER TABLE "Payment" ALTER COLUMN "currency" SET DEFAULT 'XOF';
