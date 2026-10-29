-- ============================================================================
-- v2: clase de cuenta, cuenta de solo egresos y saldo inicial
-- Escrito el 2026-10-28 por el Socio (ejecutor), rama v2-arranque-limpio.
-- ============================================================================
-- 1. `cuentas_financieras.clase`: hasta hoy la app sabia que cuenta es cual por
--    SUBCADENA del nombre (clasificarCuentaLiquidezPorNombre). La conversion de
--    transferencias necesita encontrar "la cuenta Transferencias" y "la cuenta
--    Efectivo" del ADMIN sin adivinar por nombre: por eso la columna.
-- 2. `cuentas_financieras.solo_egresos`: la Cuenta personal arranca en 0 y solo
--    registra egresos (Norman, 2026-10-28). Un trigger rechaza cualquier ingreso
--    hacia una cuenta marcada.
-- 3. `SALDO_INICIAL` en finanzas_ledger.tipo_movimiento: el saldo de arranque de
--    cada cuenta. No es venta ni abono: `v_movimiento_clasificado` no lo cuenta
--    como ingreso del periodo (es_ingreso_admin sigue en INGRESO_VENTA/ABONO_DEUDA),
--    y no genera PASIVO_IVA ni PASIVO_IEPS. Solo mueve la liquidez de su cuenta.
-- 4. `saldo_cuenta(id)`: el saldo de una cuenta con la MISMA regla que
--    getLiquidezPorCuenta (lib/dashboard-utils.ts), para verificar en SQL y para
--    que la conversion no convierta mas de lo que hay.
-- ============================================================================

ALTER TABLE public.cuentas_financieras
  ADD COLUMN IF NOT EXISTS clase text,
  ADD COLUMN IF NOT EXISTS solo_egresos boolean NOT NULL DEFAULT false;

ALTER TABLE public.cuentas_financieras
  DROP CONSTRAINT IF EXISTS cuentas_financieras_clase_check;
ALTER TABLE public.cuentas_financieras
  ADD CONSTRAINT cuentas_financieras_clase_check
  CHECK (clase IS NULL OR clase IN ('EFECTIVO', 'PERSONAL', 'FISCAL', 'TRANSFERENCIAS'));

-- Una cuenta de cada clase por entidad.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cuentas_financieras_entidad_clase
  ON public.cuentas_financieras (id_entidad, clase) WHERE clase IS NOT NULL;

COMMENT ON COLUMN public.cuentas_financieras.clase IS
  'v2: EFECTIVO / PERSONAL / FISCAL / TRANSFERENCIAS. La usa convertir_transferencias().';
COMMENT ON COLUMN public.cuentas_financieras.solo_egresos IS
  'v2: true = la cuenta no acepta ingresos (trigger trg_cuenta_solo_egresos). Cuenta personal.';

-- tipo_movimiento: los 15 de siempre + SALDO_INICIAL.
ALTER TABLE public.finanzas_ledger
  DROP CONSTRAINT IF EXISTS finanzas_ledger_tipo_movimiento_check;
ALTER TABLE public.finanzas_ledger
  ADD CONSTRAINT finanzas_ledger_tipo_movimiento_check CHECK (tipo_movimiento::text = ANY (ARRAY[
    'INGRESO_VENTA', 'GASTO_OPERATIVO', 'ABONO_DEUDA', 'INGRESO_COMISION', 'DEUDA_A_MATRIZ',
    'COMISION_PASIVA', 'PASIVO_IVA', 'PASIVO_IEPS', 'EGRESO_TRASPASO', 'INGRESO_TRASPASO',
    'SUBSIDIO_FISCAL', 'CARGO_DEUDA', 'COMPRA_INSUMOS', 'MERMA', 'DEVOLUCION',
    'SALDO_INICIAL'
  ]::text[]));

CREATE OR REPLACE FUNCTION public.tg_cuenta_solo_egresos()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NEW.tipo_movimiento IN ('INGRESO_VENTA', 'ABONO_DEUDA', 'INGRESO_TRASPASO',
                             'INGRESO_COMISION', 'SALDO_INICIAL')
     AND NEW.id_cuenta_destino IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.cuentas_financieras c
                  WHERE c.id = NEW.id_cuenta_destino AND c.solo_egresos) THEN
    RAISE EXCEPTION 'La cuenta % es de solo egresos: no recibe %', NEW.id_cuenta_destino, NEW.tipo_movimiento
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_cuenta_solo_egresos ON public.finanzas_ledger;
CREATE TRIGGER trg_cuenta_solo_egresos
  BEFORE INSERT OR UPDATE OF tipo_movimiento, id_cuenta_destino ON public.finanzas_ledger
  FOR EACH ROW EXECUTE FUNCTION public.tg_cuenta_solo_egresos();
-- Funcion de trigger: no se publica como /rest/v1/rpc (tests/candados-base.spec.ts).
REVOKE EXECUTE ON FUNCTION public.tg_cuenta_solo_egresos() FROM PUBLIC, anon, authenticated;

-- Saldo de una cuenta. Misma regla que getLiquidezPorCuenta:
--   entra:  INGRESO_VENTA, ABONO_DEUDA, INGRESO_TRASPASO, SALDO_INICIAL  (por id_cuenta_destino)
--   sale:   GASTO_OPERATIVO, CARGO_DEUDA, SUBSIDIO_FISCAL, COMPRA_INSUMOS, EGRESO_TRASPASO
--           (por COALESCE(id_cuenta_origen, id_cuenta_destino))
--   solo filas contables (status ACTIVO/APPROVED, categoria distinta de ABONO_PENDIENTE).
CREATE OR REPLACE FUNCTION public.saldo_cuenta(p_id_cuenta uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT COALESCE(SUM(
           CASE
             WHEN f.tipo_movimiento IN ('INGRESO_VENTA', 'ABONO_DEUDA', 'INGRESO_TRASPASO', 'SALDO_INICIAL')
                  AND f.id_cuenta_destino = p_id_cuenta THEN f.monto
             WHEN f.tipo_movimiento IN ('GASTO_OPERATIVO', 'CARGO_DEUDA', 'SUBSIDIO_FISCAL',
                                        'COMPRA_INSUMOS', 'EGRESO_TRASPASO')
                  AND COALESCE(f.id_cuenta_origen, f.id_cuenta_destino) = p_id_cuenta THEN -f.monto
             ELSE 0
           END), 0)::numeric(14,2)
    FROM public.finanzas_ledger f
   WHERE (f.id_cuenta_destino = p_id_cuenta OR f.id_cuenta_origen = p_id_cuenta)
     AND f.status IN ('ACTIVO', 'APPROVED')
     AND f.categoria IS DISTINCT FROM 'ABONO_PENDIENTE';
$$;

REVOKE ALL ON FUNCTION public.saldo_cuenta(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.saldo_cuenta(uuid) TO authenticated, service_role;
