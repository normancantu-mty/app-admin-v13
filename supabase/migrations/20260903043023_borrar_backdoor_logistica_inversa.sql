-- ============================================================================
-- Borrar `registrar_logistica_inversa`: una puerta trasera que ya no cerraba
-- ============================================================================
-- QUE ES. Una funcion `SECURITY DEFINER` que ESCRIBE en `inventario_ledger` y
-- en `finanzas_ledger`. Al ser SECURITY DEFINER corre como su dueno (`postgres`,
-- que tiene BYPASSRLS): **ignora el RLS por completo**. Y `authenticated` tenia
-- EXECUTE sobre ella.
--
-- POR QUE ES UN AGUJERO. PostgREST publica toda funcion ejecutable en
-- `/rest/v1/rpc/<nombre>`. Cualquier DST con su token valido podia llamarla con
-- `p_distribuidor_id` y `p_monto_abono` arbitrarios y **acreditarse un
-- ABONO_DEUDA a nombre de quien quisiera**, sin pasar por ninguna politica.
-- El 2026-09-02 se le revoco EXECUTE a `anon` (20260902000944) y luego a
-- PUBLIC (20260902001110), pero el GRANT explicito a `authenticated` seguia
-- vivo: revocar de PUBLIC no quita un GRANT nominal.
--
-- POR QUE SE BORRA EN VEZ DE REVOCAR. Es codigo muerto y ademas roto:
--   * `grep -rn "registrar_logistica_inversa" app/ lib/ components/` -> 0 hits
--     (verificado 2026-09-02). Lo unico que la mencionaba en el repo era su
--     tipo huerfano en `types/database.ts`, que esta migracion deja sin sentido
--     y se quita en el mismo commit.
--   * Su cuerpo inserta en `inventario_ledger (id_entidad_relacionada)` y esa
--     columna NO EXISTE en el esquema de hoy: la funcion habria reventado en
--     su primera linea util. Nadie la llamaba desde hace tiempo.
-- Una funcion que no se usa no se endurece: se borra. Lo que no existe no se
-- puede llamar por RPC.
--
-- NO CAMBIA NINGUNA CIFRA. No lee ni escribe datos: solo quita una funcion que
-- nadie invoca. 84 activas / 468 / 61 / $386,201 quedan intactas.
--
-- ─── ROLLBACK ───────────────────────────────────────────────────────────────
-- El cuerpo completo esta en `supabase/_respaldos/2026-09-02_schema.sql:95`
-- (bloque `CREATE OR REPLACE FUNCTION "public"."registrar_logistica_inversa"`).
-- Para revivirla: copiar ese bloque tal cual y volver a conceder
--   GRANT EXECUTE ON FUNCTION public.registrar_logistica_inversa(
--     uuid, numeric, text, uuid, uuid, numeric, text) TO authenticated;
-- Antes de hacerlo, arreglar la columna inexistente `id_entidad_relacionada`.
-- ============================================================================

DROP FUNCTION IF EXISTS public.registrar_logistica_inversa(
  uuid,     -- p_producto_id
  numeric,  -- p_cantidad
  text,     -- p_tipo_movimiento
  uuid,     -- p_usuario_id
  uuid,     -- p_distribuidor_id
  numeric,  -- p_monto_abono
  text      -- p_usuario_creador
);
