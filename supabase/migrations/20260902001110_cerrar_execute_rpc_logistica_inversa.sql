-- Fase 0 / paso 2 (continuacion) — Cerrar de verdad la RPC SECURITY DEFINER.
--
-- Hallazgo durante la aplicacion: despues del REVOKE ... FROM anon, `anon` SEGUIA
-- teniendo EXECUTE. Motivo: Postgres concede EXECUTE a PUBLIC por defecto en cada
-- funcion, y `anon` hereda de PUBLIC. Verificado con:
--   has_function_privilege('anon', ..., 'EXECUTE') -> true
--   proacl = {=X/postgres, postgres=X/postgres, authenticated=X/postgres, service_role=X/postgres}
--             ^^^^^^^^^^ ese es PUBLIC
--
-- Revocar de PUBLIC no toca a `authenticated` ni a `service_role`: los dos tienen
-- grant EXPLICITO propio en el ACL de arriba. Y ningun archivo fuente llama a esta
-- RPC hoy (solo queda su tipo en types/database.ts y chunks viejos en .next/):
-- registrarLogisticaInversaAction hace INSERTs directos, no rpc().

REVOKE EXECUTE ON FUNCTION public.registrar_logistica_inversa(uuid, numeric, text, uuid, uuid, numeric, text) FROM PUBLIC;
