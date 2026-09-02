-- ============================================================================
-- Paso 8 · Quitarle a `anon` la lectura del esquema public
-- ============================================================================
-- Solo despues del paso 5 (los tres Server Components / route handlers ya no
-- usan el cliente browser, asi que ninguna pagina lee como `anon`).
--
-- Con RLS encendido `anon` ya veia 0 filas en las 9 tablas. Esto es la segunda
-- reja: sin GRANT ni siquiera llega a evaluarse una politica, y cubre tambien
-- cualquier tabla de public que no tenga RLS.
-- ============================================================================

REVOKE SELECT ON ALL TABLES IN SCHEMA public FROM anon;

-- Y que las tablas FUTURAS nazcan sin permisos para anon.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;


-- ---------------------------------------------------------------------------
-- LO QUE ESTO **NO** ARREGLA — leelo antes de crear una tabla nueva
-- ---------------------------------------------------------------------------
-- El ALTER DEFAULT PRIVILEGES de arriba solo alcanza a las tablas que cree el
-- rol `postgres`. Supabase tiene ADEMAS default privileges a nombre de
-- `supabase_admin` que siguen concediendo permisos a `anon` en tablas NUEVAS,
-- y `postgres` no los puede revocar: no es dueno de esa entrada y no es
-- superusuario (rolsuper = false).
--
-- O sea: una tabla creada desde el editor de tablas del panel de Supabase
-- puede volver a nacer legible por `anon`. Eso no se arregla con SQL.
--
-- La regla que si lo arregla, y es de proceso, no de codigo:
--   1. Toda tabla nueva se crea POR MIGRACION, nunca desde el panel.
--   2. En la MISMA migracion: ALTER TABLE ... ENABLE ROW LEVEL SECURITY.
--   3. En la MISMA migracion: sus politicas.
--
-- Para comprobar que no se colo ninguna:
--   SELECT c.relname, c.relrowsecurity
--     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity;
-- ---------------------------------------------------------------------------
