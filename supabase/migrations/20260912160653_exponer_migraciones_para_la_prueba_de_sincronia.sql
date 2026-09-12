-- ============================================================================
-- ERP-73 · Que la prueba pueda ver que migraciones estan aplicadas
-- ============================================================================
-- POR QUE EXISTE. El 2026-09-12 se encontro que **3 migraciones vivian SOLO
-- dentro de la base** —su SQL no existia en ningun archivo del repo— y que 10
-- archivos traian un timestamp distinto al registrado en el servidor. Una de
-- las tres, `cerrar_execute_usuario_de_sesion`, era de seguridad.
--
-- Se recupero todo a mano ese mismo dia. **Pero un arreglo a mano se vuelve a
-- romper**, y la unica defensa que no depende de que alguien se acuerde es una
-- prueba. La prueba no puede leer `supabase_migrations.schema_migrations`
-- directo: PostgREST solo expone `public`.
--
-- Esta funcion es la ventana minima posible: devuelve **nada mas** version y
-- nombre —nunca el SQL— y **solo a `service_role`**. Ni `anon` ni
-- `authenticated` la pueden llamar: la lista de migraciones de una base es
-- informacion de reconocimiento.
--
-- La consume `tests/salud-del-sistema.spec.ts`.
--
-- ROLLBACK: DROP FUNCTION public.migraciones_aplicadas();
--
-- COMPROBACION DESPUES DE APLICAR:
--   SELECT count(*) FROM public.migraciones_aplicadas();          -- la lista
--   SELECT has_function_privilege('anon',
--     'public.migraciones_aplicadas()', 'EXECUTE');               -- debe: false
-- ============================================================================

CREATE OR REPLACE FUNCTION public.migraciones_aplicadas()
RETURNS TABLE (version text, name text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = supabase_migrations, public
AS $fn$
  SELECT m.version, m.name
  FROM supabase_migrations.schema_migrations m
  ORDER BY m.version;
$fn$;

REVOKE ALL ON FUNCTION public.migraciones_aplicadas() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.migraciones_aplicadas() TO service_role;

COMMENT ON FUNCTION public.migraciones_aplicadas() IS
  'ERP-73. Solo service_role. Existe para que tests/salud-del-sistema.spec.ts pueda comparar los archivos del repo contra lo aplicado en la base. No devuelve el SQL, solo version y nombre.';
