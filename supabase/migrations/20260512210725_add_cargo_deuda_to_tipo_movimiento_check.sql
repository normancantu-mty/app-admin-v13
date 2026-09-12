-- ============================================================================
-- RECUPERADA DEL SERVIDOR EL 2026-09-12 — no tenia archivo en el repo.
-- ============================================================================
-- Esta migracion estaba APLICADA en produccion y su SQL solo existia dentro de
-- `supabase_migrations.schema_migrations` (columna `statements`). Si la base se
-- hubiera perdido, este texto se perdia con ella: el repo no lo tenia.
-- Se reconstruye literal, sin una sola edicion, para que el repo vuelva a
-- describir la base. Ver ERP-73.
--
-- ROLLBACK: no hay. Es el CHECK vigente de `tipo_movimiento`; quitarlo dejaria
-- la columna sin validar. Para cambiarlo se escribe una migracion nueva.
-- ============================================================================

ALTER TABLE public.finanzas_ledger DROP CONSTRAINT IF EXISTS finanzas_ledger_tipo_movimiento_check;
ALTER TABLE public.finanzas_ledger ADD CONSTRAINT finanzas_ledger_tipo_movimiento_check
  CHECK (tipo_movimiento IN (
    'INGRESO_VENTA',
    'GASTO_OPERATIVO',
    'ABONO_DEUDA',
    'INGRESO_COMISION',
    'DEUDA_A_MATRIZ',
    'COMISION_PASIVA',
    'PASIVO_IVA',
    'PASIVO_IEPS',
    'EGRESO_TRASPASO',
    'INGRESO_TRASPASO',
    'SUBSIDIO_FISCAL',
    'CARGO_DEUDA',
    'COMPRA_INSUMOS',
    'MERMA',
    'DEVOLUCION'
  ));
