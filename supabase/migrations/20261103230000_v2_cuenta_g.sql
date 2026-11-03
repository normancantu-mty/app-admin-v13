-- ============================================================================
-- Cuenta G (2026-11-03): quinta cuenta de la matriz. LIBRE, acepta ingresos y
-- egresos. Inicia en cero: sin SALDO_INICIAL, el saldo sale del ledger.
-- Lleva clase propia porque uq_cuentas_financieras_entidad_clase impide repetir
-- clase en la misma entidad; con clase no nula aparece en /panel/correcciones.
--
-- Reversa (solo mientras la cuenta no tenga movimientos):
--   DELETE FROM public.cuentas_financieras WHERE clase = 'CUENTA_G';
--   y re-aplicar el CHECK sin 'CUENTA_G'.
-- ============================================================================

ALTER TABLE public.cuentas_financieras
  DROP CONSTRAINT cuentas_financieras_clase_check;
ALTER TABLE public.cuentas_financieras
  ADD CONSTRAINT cuentas_financieras_clase_check
  CHECK (clase IS NULL OR clase = ANY (ARRAY['EFECTIVO', 'PERSONAL', 'FISCAL', 'TRANSFERENCIAS', 'CUENTA_G']));

INSERT INTO public.cuentas_financieras (id_entidad, nombre, tipo_fiscalidad, clase, solo_egresos)
VALUES ('e0000000-0000-0000-0000-000000000001', 'Cuenta G', 'LIBRE', 'CUENTA_G', false);
