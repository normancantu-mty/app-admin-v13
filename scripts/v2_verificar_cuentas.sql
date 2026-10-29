-- v2 LOCAL: cuentas del CEO Admin despues de la carga de arranque. Escrito el 2026-10-29 por
-- el Socio (ejecutor). Solo lee; el intento de ingreso va dentro de una transaccion que se
-- deshace siempre.
--   docker exec -i supabase_db_app-admin-v2 psql -U postgres -X < scripts/v2_verificar_cuentas.sql
-- Norman, 2026-10-29: la cuenta de clase PERSONAL se llama "Cuenta Gilberto"; las reglas no
-- cambian (LIBRE, solo egresos, saldo inicial 0). No debe confundirse con la cuenta del
-- distribuidor Gilberto Franco (otra entidad).
\pset footer off
SELECT c.nombre, c.clase, c.tipo_fiscalidad, c.solo_egresos, public.saldo_cuenta(c.id) AS saldo
FROM cuentas_financieras c
WHERE c.id_entidad = 'e0000000-0000-0000-0000-000000000001'
ORDER BY c.nombre;

BEGIN;
CREATE TEMP TABLE intento (rechazado boolean, mensaje text) ON COMMIT DROP;
DO $$
BEGIN
  INSERT INTO finanzas_ledger (tipo_movimiento, monto, id_cuenta_destino, categoria, status)
  SELECT 'INGRESO_TRASPASO', 10, id, 'TRANSFERENCIA', 'ACTIVO'
  FROM cuentas_financieras
  WHERE id_entidad = 'e0000000-0000-0000-0000-000000000001' AND nombre = 'Cuenta Gilberto';
  INSERT INTO intento VALUES (false, 'el ingreso ENTRO');
EXCEPTION WHEN check_violation THEN
  INSERT INTO intento VALUES (true, SQLERRM);
END $$;

WITH cta AS (SELECT * FROM cuentas_financieras WHERE id_entidad = 'e0000000-0000-0000-0000-000000000001'),
gil AS (SELECT c.* FROM cuentas_financieras c JOIN entidades e ON e.id = c.id_entidad WHERE e.nombre = 'Gilberto Franco'),
pruebas(orden, prueba, esperado, obtenido) AS (
  VALUES
  (1, 'ADMIN: cuentas llamadas "Cuenta personal"', '0', (SELECT count(*)::text FROM cta WHERE nombre = 'Cuenta personal')),
  (2, 'ADMIN: "Cuenta Gilberto" existe y es UNA', '1', (SELECT count(*)::text FROM cta WHERE nombre = 'Cuenta Gilberto')),
  (3, 'Cuenta Gilberto: clase', 'PERSONAL', (SELECT clase FROM cta WHERE nombre = 'Cuenta Gilberto')),
  (4, 'Cuenta Gilberto: fiscalidad', 'LIBRE', (SELECT tipo_fiscalidad FROM cta WHERE nombre = 'Cuenta Gilberto')),
  (5, 'Cuenta Gilberto: solo egresos', 'true', (SELECT solo_egresos::text FROM cta WHERE nombre = 'Cuenta Gilberto')),
  (6, 'Cuenta Gilberto: saldo inicial', '0.00', (SELECT public.saldo_cuenta(id)::text FROM cta WHERE nombre = 'Cuenta Gilberto')),
  (7, 'Cuenta Gilberto: ingreso de 10 rechazado por el trigger', 'true', (SELECT rechazado::text FROM intento)),
  (8, 'ADMIN: una sola cuenta de clase PERSONAL', '1', (SELECT count(*)::text FROM cta WHERE clase = 'PERSONAL')),
  (9, 'cuenta de Gilberto Franco (DST) sigue siendo suya y distinta', 'true',
      (SELECT (count(*) >= 1 AND bool_and(g.id NOT IN (SELECT id FROM cta)))::text FROM gil g)),
  (10, 'cuenta de Gilberto Franco: no es solo egresos ni clase PERSONAL', 'true',
      (SELECT bool_and(NOT coalesce(g.solo_egresos, false) AND g.clase IS DISTINCT FROM 'PERSONAL')::text FROM gil g)),
  (11, 'cuentas con nombre ILIKE %gilberto% (todas las entidades)', '2',
      (SELECT count(*)::text FROM cuentas_financieras WHERE nombre ILIKE '%gilberto%'))
)
SELECT orden, prueba, esperado, coalesce(obtenido, '(null)') AS obtenido,
       CASE WHEN esperado = obtenido THEN 'OK' ELSE 'FALLA' END AS ok
FROM pruebas ORDER BY orden;
SELECT 'mensaje del trigger: ' || mensaje FROM intento;
ROLLBACK;
