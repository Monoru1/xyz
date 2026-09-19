-- =====================================================================
-- GENK — Verrouillage de l'accès public au schéma PostgreSQL (Supabase)
-- =====================================================================
--
-- CE FICHIER N'EST PAS UNE MIGRATION PRISMA.
-- Ne jamais le déplacer dans prisma/migrations. Il s'exécute manuellement,
-- une fois, depuis le SQL Editor du projet Supabase.
--
-- ---------------------------------------------------------------------
-- POURQUOI
-- ---------------------------------------------------------------------
-- GENK n'utilise QUE le chemin : navigateur -> Next.js -> Prisma -> PostgreSQL.
-- Aucune dépendance @supabase/supabase-js n'est installée, le navigateur ne
-- parle jamais à la Data API (PostgREST).
--
-- Mais Supabase expose par défaut le schéma "public" via PostgREST, et accorde
-- aux rôles "anon" / "authenticated" des privilèges par défaut sur les tables
-- qui y sont créées. Les tables posées par les migrations Prisma n'ont aucune
-- politique RLS. Si la Data API est active sur le projet, la clé anonyme — qui
-- est publique par nature — suffit alors à lire et écrire :
--
--   * "User"    -> e-mails et hachages de mots de passe des propriétaires ;
--   * "Booking" -> identité, téléphone, e-mail des clients ;
--   * "Booking"."status" -> confirmation d'une réservation sans aucun paiement ;
--   * "Payment" -> historique des règlements.
--
-- Ce script retire cet accès. Prisma se connecte avec le rôle "postgres"
-- (BYPASSRLS + propriétaire des tables) : il n'est donc pas affecté.
--
-- ---------------------------------------------------------------------
-- PRÉ-REQUIS
-- ---------------------------------------------------------------------
-- Vérifier d'abord que DATABASE_URL utilise bien le rôle postgres :
--   select current_user, rolbypassrls
--     from pg_roles where rolname = current_user;
-- Le résultat doit indiquer rolbypassrls = true. Sinon, NE PAS exécuter la
-- section 2 : l'application perdrait l'accès à ses propres tables.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Retirer les privilèges des rôles exposés par la Data API
-- ---------------------------------------------------------------------
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
revoke usage on schema public from anon, authenticated;

-- Les tables créées par les futures migrations Prisma ne doivent pas hériter
-- à nouveau de ces privilèges.
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;


-- ---------------------------------------------------------------------
-- 2. RLS en défense en profondeur (aucune politique = aucun accès)
-- ---------------------------------------------------------------------
-- Sans politique, toute requête d'un rôle non-BYPASSRLS renvoie zéro ligne.
-- Prisma (rôle postgres) continue de fonctionner normalement.
alter table "User"             enable row level security;
alter table "Salon"            enable row level security;
alter table "Service"          enable row level security;
alter table "AvailabilityRule" enable row level security;
alter table "Booking"          enable row level security;
alter table "Payment"          enable row level security;
alter table "WebhookEvent"     enable row level security;


-- ---------------------------------------------------------------------
-- 3. Vérifications
-- ---------------------------------------------------------------------
-- 3a. Toutes les tables doivent afficher rowsecurity = true.
-- select tablename, rowsecurity
--   from pg_tables where schemaname = 'public' order by tablename;

-- 3b. Aucune ligne ne doit subsister pour anon / authenticated.
-- select grantee, table_name, privilege_type
--   from information_schema.role_table_grants
--  where table_schema = 'public' and grantee in ('anon', 'authenticated');

-- 3c. La contrainte anti-double-réservation doit rester en place.
-- select conname, contype from pg_constraint where conname = 'Booking_no_overlap';
--   -> attendu : ('Booking_no_overlap', 'x')

-- 3d. Depuis le poste de développement, Prisma doit toujours répondre :
--   npx prisma migrate status   -> "Database schema is up to date!"
