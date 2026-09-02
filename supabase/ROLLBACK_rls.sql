-- ============================================================================
-- ROLLBACK_rls.sql  ·  SALIDA DE EMERGENCIA
-- ============================================================================
-- Creado 2026-09-02 junto con el encendido de RLS (prompt 2, pasos 6-8).
--
-- NO BORRAR ESTE ARCHIVO. Es el plan de reversa.
--
-- Uso: si al probar en caliente algo deja de cargar o de guardarse, pega la
-- PARTE A en el SQL Editor de Supabase y ejecutala. Son ~10 segundos y deja la
-- base como estaba antes del prompt 2 en lo que respecta a visibilidad.
--
-- Las partes son incrementales: A casi siempre basta. B solo si ademas se
-- corrio el paso 8. C es la reversa total.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- PARTE A · Apagar RLS en las 9 tablas.  <<< ESTA ES LA SALIDA RAPIDA >>>
-- Las politicas se quedan escritas pero dejan de aplicarse.
-- ---------------------------------------------------------------------------
ALTER TABLE public.entidades             DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.cuentas_financieras   DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalogo_productos    DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.listas_precios        DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.recetas_produccion    DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.transacciones_tickets DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_detalles       DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.finanzas_ledger       DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventario_ledger     DISABLE ROW LEVEL SECURITY;


-- ---------------------------------------------------------------------------
-- PARTE B · Devolver la lectura anonima (solo si se corrio el paso 8).
--
-- OJO: esto reabre el agujero que cerro el paso 8 — cualquiera con la anon key
-- vuelve a poder leer TODA la base. Corre esta parte unicamente si con la
-- PARTE A no basta, y avisa de inmediato. Es deuda, no una solucion.
-- ---------------------------------------------------------------------------
-- GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;
-- ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon;


-- ---------------------------------------------------------------------------
-- PARTE C · Reversa total: borrar politicas y funciones auxiliares.
-- Solo si se decide abandonar el diseno entero.
-- ---------------------------------------------------------------------------
-- DO $$
-- DECLARE p record;
-- BEGIN
--   FOR p IN SELECT schemaname, tablename, policyname FROM pg_policies WHERE schemaname='public'
--   LOOP
--     EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', p.policyname, p.schemaname, p.tablename);
--   END LOOP;
-- END $$;
--
-- DROP FUNCTION IF EXISTS public.mis_entidades();
-- DROP FUNCTION IF EXISTS public.mi_rol();
-- DROP FUNCTION IF EXISTS public.mi_entidad_id();


-- ---------------------------------------------------------------------------
-- Comprobacion despues de correr cualquier parte:
-- ---------------------------------------------------------------------------
-- SELECT c.relname, c.relrowsecurity AS rls_encendido,
--        (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.relname) AS politicas
-- FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
-- WHERE n.nspname='public' AND c.relkind='r' ORDER BY 1;
