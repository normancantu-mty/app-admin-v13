-- ============================================================================
-- v2 LOCAL: cascaron de pg_net (compatibilidad solo-local)
-- Escrito el 2026-10-28 por el Socio (ejecutor), rama v2-arranque-limpio.
-- ============================================================================
-- 20261015164937_cerebro1171 aborta si no existen net._http_response y
-- net.http_request_queue, y 20261019135306_cerebro1172 depende de ella.
-- En local NO se instala pg_net a proposito: las funciones del bot y los jobs
-- de pg_cron hacen net.http_post a api.telegram.org y a edge functions de
-- PRODUCCION (gnnqxtsdrbvmlkhfemjw.supabase.co).
-- Este cascaron crea el esquema `net` con las dos tablas y un net.http_post
-- que NO sale a la red: solo anota la llamada en net.llamadas_bloqueadas.
--
-- En una base con pg_net real (produccion) es un no-op: sale en la primera
-- linea del bloque.
-- ============================================================================
DO $cascaron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE NOTICE 'pg_net real instalado: el cascaron no se crea';
    RETURN;
  END IF;

  CREATE SCHEMA IF NOT EXISTS net;

  CREATE TABLE IF NOT EXISTS net.http_request_queue (
    id bigserial PRIMARY KEY,
    method text, url text, headers jsonb, body bytea, timeout_milliseconds integer
  );
  CREATE TABLE IF NOT EXISTS net._http_response (
    id bigint, status_code integer, content_type text, headers jsonb, content text,
    timed_out boolean, error_msg text, created timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS net.llamadas_bloqueadas (
    id bigserial PRIMARY KEY, url text, body jsonb, headers jsonb, en timestamptz NOT NULL DEFAULT now()
  );

  EXECUTE $f$
    CREATE OR REPLACE FUNCTION net.http_post(
      url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
      headers jsonb DEFAULT '{"Content-Type": "application/json"}'::jsonb,
      timeout_milliseconds integer DEFAULT 5000)
    RETURNS bigint LANGUAGE plpgsql AS $b$
    DECLARE v bigint;
    BEGIN
      -- No sale a la red: solo se anota (headers se omiten: pueden traer claves).
      INSERT INTO net.llamadas_bloqueadas(url, body) VALUES (url, body) RETURNING id INTO v;
      RETURN v;
    END $b$
  $f$;

  EXECUTE $f$
    CREATE OR REPLACE FUNCTION net.http_get(
      url text, params jsonb DEFAULT '{}'::jsonb, headers jsonb DEFAULT '{}'::jsonb,
      timeout_milliseconds integer DEFAULT 5000)
    RETURNS bigint LANGUAGE plpgsql AS $b$
    DECLARE v bigint;
    BEGIN
      INSERT INTO net.llamadas_bloqueadas(url) VALUES (url) RETURNING id INTO v;
      RETURN v;
    END $b$
  $f$;
END
$cascaron$;
