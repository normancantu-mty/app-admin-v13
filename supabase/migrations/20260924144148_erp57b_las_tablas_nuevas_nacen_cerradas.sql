-- ===========================================================================
--  ERP-57 (b) · una tabla nueva en `public` o `agente` NACE CERRADA
-- ===========================================================================
--  Escrito el 2026-09-24 por el ejecutor de la Fase 11 (encargo del Socio,
--  `DESDE_SOCIO_prompt_ejecutor_erp57_2026-09-23.md`).
--  **ESTA MIGRACION NO ESTA APLICADA.** Se aplica con `apply_migration` del MCP,
--  NUNCA con `supabase db push`, y despues el archivo se mueve a
--  `supabase/migrations/` con el nombre con que quedo sellado (ver LEEME.md).
--
--  Complementa a `erp57_las_tablas_nuevas_no_nacen_abiertas_a_anon.sql` (09-17),
--  que cierra los DEFAULT PRIVILEGES de `postgres`. No la sustituye: se pueden
--  aplicar en cualquier orden.
--
-- ---------------------------------------------------------------------------
--  1. LO MEDIDO ANTES DE ESCRIBIR (produccion, 2026-09-24, solo lectura)
-- ---------------------------------------------------------------------------
--    · `public` 24 tablas, `agente` 22; las 46 son de `postgres`.
--    · Sin RLS: solo `agente.latido`. `anon` no escribe en ninguna y no tiene
--      USAGE sobre `agente`.
--    · Event triggers: solo los 8 de la plataforma (dueno `supabase_admin`).
--    · `current_user` = postgres, `rolsuper` = false. Supabase documenta que
--      `postgres` SI puede crear event triggers gracias a `supautils`
--      (docs: database/postgres/event-triggers, y el ejemplo `ensure_rls` de
--      row-level-security#auto-enable-rls-for-new-tables).
--
-- ---------------------------------------------------------------------------
--  2. LO QUE HACE
-- ---------------------------------------------------------------------------
--  (a) Event trigger `tablas_nacen_cerradas`: al terminar un CREATE TABLE /
--      CREATE TABLE AS / SELECT INTO en `public` o `agente`, ejecuta
--      `ENABLE ROW LEVEL SECURITY` y `REVOKE ALL ... FROM anon`. **Sin
--      politicas**: la tabla nace cerrada y quien la crea abre a proposito.
--      **Falla CERRADO**: si no puede cerrar la tabla, el CREATE TABLE se
--      aborta. El ejemplo de Supabase traga el error con RAISE LOG; aqui no,
--      porque una tabla que nace abierta sin que nadie se entere es justo el
--      defecto de ERP-57.
--  (b) `agente.latido` pasa a RLS ON, sin politica. Decision y porque: la
--      unica que la escribe es `agente.latido()`, SECURITY DEFINER con dueno
--      `postgres` (BYPASSRLS), y ningun otro rol tiene grants sobre la tabla.
--      RLS no le cambia nada a quien la usa hoy, y deja de ser la unica
--      excepcion que la prueba del paso (c) tendria que tolerar por nombre.
--      Politica "solo service_role" no hace falta: `service_role` ya tiene
--      BYPASSRLS y ademas no tiene grants sobre ella.
--  (c) `public.tablas_abiertas()`: la lista de tablas de `public`/`agente` sin
--      RLS o con `anon` pudiendo escribir. La lee `tests/salud-del-sistema.spec.ts`
--      (ERP-57) con la llave de servicio. Solo `service_role` la ejecuta.
--
-- ---------------------------------------------------------------------------
--  3. LO QUE NO CUBRE, DICHO
-- ---------------------------------------------------------------------------
--  · Tablas creadas por `supabase_admin` (el rol de la plataforma, el del
--    default ACL `anon=arwdDxtm`): segun el blog de Supabase sobre event
--    triggers sin superusuario, los de `postgres` NO se disparan para roles
--    superusuario. Esa puerta la cubre la prueba de la suite (paso c), no el
--    trigger. No se pudo medir en produccion sin aplicar.
--  · Migraciones existentes: re-correrlas no rompe nada; todas sus tablas ya
--    tienen RLS salvo `agente.latido`, que esta migracion cierra. Ninguna se
--    excluye por nombre.
--  · Una migracion FUTURA del agente de WhatsApp que cree tabla y espere que
--    `authenticated` la lea sin politica: ahora vera 0 filas. Es a proposito.
--
-- ---------------------------------------------------------------------------
--  4. EL CAMBIO
-- ---------------------------------------------------------------------------

create or replace function public.tablas_nacen_cerradas()
returns event_trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  cmd record;
begin
  for cmd in
    select *
      from pg_event_trigger_ddl_commands()
     where command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
       and object_type in ('table', 'partitioned table')
       and schema_name in ('public', 'agente')
  loop
    -- Sin EXCEPTION: si no puede cerrarla, la tabla no nace.
    execute format('alter table %s enable row level security', cmd.object_identity);
    execute format('revoke all on table %s from anon', cmd.object_identity);
  end loop;
end;
$$;

revoke all on function public.tablas_nacen_cerradas() from public, anon, authenticated;

drop event trigger if exists tablas_nacen_cerradas;
create event trigger tablas_nacen_cerradas
  on ddl_command_end
  when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  execute function public.tablas_nacen_cerradas();

alter table agente.latido enable row level security;
-- En produccion `anon` no tiene grant sobre ella (medido); el REVOKE es para no
-- depender de eso. El control local lo mostro: RLS sola no la saca de la lista.
revoke all on table agente.latido from anon;

create or replace function public.tablas_abiertas()
returns table (esquema text, tabla text, rls boolean, anon_escribe boolean)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select n.nspname::text,
         c.relname::text,
         c.relrowsecurity,
         (has_table_privilege('anon', c.oid, 'INSERT')
          or has_table_privilege('anon', c.oid, 'UPDATE')
          or has_table_privilege('anon', c.oid, 'DELETE'))
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'agente')
     and c.relkind in ('r', 'p')
     and (not c.relrowsecurity
          or has_table_privilege('anon', c.oid, 'INSERT')
          or has_table_privilege('anon', c.oid, 'UPDATE')
          or has_table_privilege('anon', c.oid, 'DELETE'))
   order by 1, 2;
$$;

revoke all on function public.tablas_abiertas() from public, anon, authenticated;
grant execute on function public.tablas_abiertas() to service_role;

-- ---------------------------------------------------------------------------
--  5. COMO SE COMPRUEBA DESPUES DE APLICAR
-- ---------------------------------------------------------------------------
--  (1) select * from public.tablas_abiertas();           -> 0 filas
--  (2) select evtname, evtenabled from pg_event_trigger
--       where evtname = 'tablas_nacen_cerradas';           -> 1 fila, 'O'
--  (3) Control positivo que no deja rastro:
--        begin;
--          create table public.zz_prueba_erp57 (id int);
--          select relrowsecurity from pg_class where relname = 'zz_prueba_erp57';  -- true
--          select has_table_privilege('anon','public.zz_prueba_erp57','INSERT');   -- false
--        rollback;
--  (4) `npm run verificar`: la prueba ERP-57 de `salud-del-sistema.spec.ts`
--      deja de saltarse y pasa.
--  Control negativo corrido ANTES (Postgres 16 local, 2026-09-24): con el
--  trigger DESHABILITADO, una tabla nueva de un rol con default ACL abierto
--  aparece en `tablas_abiertas()`; habilitado, no. Detalle en
--  `Fresnillo/ERP_Fresnillo/_avance_fase11_2026-09-23.md`, bloque B.
--
-- ---------------------------------------------------------------------------
--  6. ROLLBACK
-- ---------------------------------------------------------------------------
--    drop event trigger if exists tablas_nacen_cerradas;
--    drop function if exists public.tablas_nacen_cerradas();
--    drop function if exists public.tablas_abiertas();
--    alter table agente.latido disable row level security;
--    (el REVOKE a anon sobre latido no se deshace: nunca tuvo el grant)
-- ===========================================================================
