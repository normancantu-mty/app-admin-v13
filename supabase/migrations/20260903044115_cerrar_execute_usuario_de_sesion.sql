-- ============================================================================
-- RECUPERADA DEL SERVIDOR EL 2026-09-12 — no tenia archivo en el repo.
-- ============================================================================
-- Aplicada en produccion el 2026-09-03; su SQL solo vivia dentro de
-- `supabase_migrations.schema_migrations`. **Es una migracion de seguridad**, y
-- era de las que mas caro salia perder. Se reconstruye literal. Ver ERP-73.
-- ============================================================================

-- `usuario_de_sesion()` solo la llama `tg_bitacora`, que es SECURITY DEFINER y
-- corre como `postgres`: no necesita el GRANT a `authenticated`. Dejarlo abierto
-- la publicaba como /rest/v1/rpc/usuario_de_sesion sin motivo (advisor 0029).
-- ROLLBACK: GRANT EXECUTE ON FUNCTION public.usuario_de_sesion() TO authenticated;
REVOKE EXECUTE ON FUNCTION public.usuario_de_sesion() FROM authenticated;
