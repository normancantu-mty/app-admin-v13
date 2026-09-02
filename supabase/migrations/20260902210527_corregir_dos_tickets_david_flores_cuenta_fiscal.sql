-- Corrige dos tickets de David Flores (DST) capturados por error contra la cuenta fiscal.
--
-- QUE PASO
-- Dos ventas a David Flores (rol DST) quedaron con id_cuenta_destino = 'Cuenta Fresnillo',
-- la cuenta fiscal (FULL_TAX), y por eso el motor de impuesto inverso les separo IVA e IEPS.
-- Norman confirmo el 2026-09-02 que con David nunca ha operado por esa cuenta: es error de captura.
-- Razon estructural: la factura se le hace al LOCAL, no al distribuidor; cuando el local paga,
-- se le paga al distribuidor por su servicio. Un ticket con destino a la cuenta fiscal NUNCA
-- debe tener a un DST como comprador. El guardarrail vive en app/actions/pos.ts.
--
-- POR QUE UN UPDATE Y NO ANULAR + RECAPTURAR
-- El POS pone fecha_transaccion = now(). Recapturar hoy moveria dos ventas de junio y agosto a
-- septiembre y con ellas los reportes mensuales. La fecha es el dato que hay que conservar.
--
-- POR QUE ES SEGURO (verificado contra la base el 2026-09-02, antes de aplicar)
-- Las dos filas son CONCESION y no tienen NI UNA fila en finanzas_ledger (id_ticket IN (...) = 0).
-- No hay cascada de dinero que deshacer: son tres columnas en dos filas y nada mas.
-- No se tocan total_cobrado_real, ni las lineas, ni las fechas, ni el inventario.
--
-- EFECTO ESPERADO
-- El Saldo Pendiente de David Flores sube exactamente $4,610.03 (3,268.93 + 1,341.10), de
-- $850.90 a $5,460.93. Esa subida es correcta: para un DST el saldo se calcula sobre
-- monto_base_ingreso (lib/distribuidores-saldos.ts), asi que el impuesto fantasma estaba
-- escondiendo deuda real. Las ventas NO cambian: 61 tickets activos y $386,201.00 siguen igual.
--
-- ─── REVERSA (valores viejos, para deshacerlo) ──────────────────────────────────
-- UPDATE transacciones_tickets
-- SET id_cuenta_destino = '7e6fc483-1bf7-4d85-be4f-6755e0409968', -- Cuenta Fresnillo
--     monto_base_ingreso = 4219.07, impuesto_iva_calculado = 1032.83, impuesto_ieps_calculado = 2236.11
-- WHERE id = 'a83054d0-88a1-4814-a649-aea52ea8f6a8';
--
-- UPDATE transacciones_tickets
-- SET id_cuenta_destino = '7e6fc483-1bf7-4d85-be4f-6755e0409968', -- Cuenta Fresnillo
--     monto_base_ingreso = 1730.90, impuesto_iva_calculado = 423.72, impuesto_ieps_calculado = 917.38
-- WHERE id = '8fdb213c-a658-479f-852f-7e03cde497fc';
-- ────────────────────────────────────────────────────────────────────────────────

-- Guarda: si alguna de las dos filas tiene dinero ligado, algo cambio desde el analisis
-- y la correccion ya no es de tres columnas. Aborta en vez de dejar el ledger inconsistente.
DO $$
DECLARE
  filas_dinero integer;
  cuenta_efectivo uuid;
BEGIN
  SELECT count(*) INTO filas_dinero
  FROM finanzas_ledger
  WHERE id_ticket IN ('a83054d0-88a1-4814-a649-aea52ea8f6a8','8fdb213c-a658-479f-852f-7e03cde497fc');

  IF filas_dinero <> 0 THEN
    RAISE EXCEPTION
      'Abortado: los tickets tienen % fila(s) en finanzas_ledger; se esperaban 0. Revisar a mano.',
      filas_dinero;
  END IF;

  SELECT id INTO cuenta_efectivo FROM cuentas_financieras WHERE nombre = 'Efectivo';
  IF cuenta_efectivo IS NULL THEN
    RAISE EXCEPTION 'Abortado: no existe la cuenta "Efectivo".';
  END IF;
END $$;

-- Idempotente: acotado por id, y `status = 'ACTIVO'` mas la condicion de impuestos hacen que
-- una segunda corrida no encuentre filas que cambiar.
UPDATE transacciones_tickets
SET id_cuenta_destino = (SELECT id FROM cuentas_financieras WHERE nombre = 'Efectivo'),
    monto_base_ingreso = total_cobrado_real,
    impuesto_iva_calculado = 0,
    impuesto_ieps_calculado = 0
WHERE id IN ('a83054d0-88a1-4814-a649-aea52ea8f6a8','8fdb213c-a658-479f-852f-7e03cde497fc')
  AND status = 'ACTIVO';
