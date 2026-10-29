-- ============================================================================
-- v2: paridad de permisos con produccion (esquema agente)
-- Escrito el 2026-10-28 por el Socio (ejecutor), rama v2-arranque-limpio.
-- ============================================================================
-- En produccion service_role tiene SELECT sobre las tablas de `agente`, pero ese
-- GRANT se dio a mano, fuera de las migraciones (leido con SELECT a
-- information_schema.role_table_grants el 2026-10-28). Sin el, una base armada
-- solo con migraciones no le deja al bot (service_role) leer su propio estado.
-- En produccion es un no-op.
-- ============================================================================
GRANT USAGE ON SCHEMA agente TO service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA agente TO service_role;
