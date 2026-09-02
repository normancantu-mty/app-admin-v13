-- ============================================================================
-- Abono completo: metodo de pago + indice de lectura por entidad
-- ============================================================================
-- Contexto: el formulario de abono (app/dashboard/distribuidores/[id]/abono)
-- solo capturaba origen, destino, monto y una linea de referencia. Se le agregan
-- fecha real del pago, nota y aplicacion a pedidos usando columnas que YA existen
-- (fecha_movimiento, descripcion, id_ticket). Lo unico que falta en la base es el
-- metodo de pago.
--
-- NULLABLE A PROPOSITO: las 118 filas existentes de finanzas_ledger no tienen
-- metodo de pago y no se les inventa uno. NO se migra ni se modifica ninguna.
--
-- Reversa:
--   DROP INDEX IF EXISTS idx_finanzas_ledger_entidad_fecha;
--   ALTER TABLE finanzas_ledger DROP CONSTRAINT IF EXISTS finanzas_ledger_metodo_pago_check;
--   ALTER TABLE finanzas_ledger DROP COLUMN IF EXISTS metodo_pago;
-- ============================================================================

ALTER TABLE finanzas_ledger ADD COLUMN IF NOT EXISTS metodo_pago text;

ALTER TABLE finanzas_ledger DROP CONSTRAINT IF EXISTS finanzas_ledger_metodo_pago_check;
ALTER TABLE finanzas_ledger ADD CONSTRAINT finanzas_ledger_metodo_pago_check
  CHECK (metodo_pago IS NULL OR metodo_pago IN ('EFECTIVO','TRANSFERENCIA','DEPOSITO','CHEQUE','OTRO'));

-- Primer indice de finanzas_ledger fuera de la PK. La propuesta FIFO y el estado
-- de cuenta consultan por (entidad, fecha desc) en cada carga.
CREATE INDEX IF NOT EXISTS idx_finanzas_ledger_entidad_fecha
  ON finanzas_ledger (id_entidad_relacionada, fecha_movimiento DESC);

COMMENT ON COLUMN finanzas_ledger.metodo_pago IS
  'Como entro el dinero: EFECTIVO|TRANSFERENCIA|DEPOSITO|CHEQUE|OTRO. NULL = capturado antes de 2026-09-02.';
