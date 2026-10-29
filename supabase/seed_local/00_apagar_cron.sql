-- v2 LOCAL (seed, corre al final de `supabase db reset`). Escrito el 2026-10-28 por el Socio (ejecutor).
-- Las migraciones programan jobs de pg_cron que en produccion llaman a Telegram y a edge functions
-- de PRODUCCION (gnnqxtsdrbvmlkhfemjw.supabase.co). En la base local no deben correr nunca.
-- 1) Si pg_net existiera en local, se aborta el seed: seria la puerta para que un job saliera a la red.
-- 2) Se desprograman todos los jobs.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE EXCEPTION 'pg_net esta instalado en la base local: un cron podria llamar a produccion. Quitalo antes de seguir.';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('cron.job') IS NOT NULL THEN
    PERFORM cron.unschedule(jobid) FROM cron.job;
  END IF;
END $$;
