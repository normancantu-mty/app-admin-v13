-- ============================================================================
-- RECUPERADA DEL SERVIDOR EL 2026-09-12 — no tenia archivo en el repo.
-- ============================================================================
-- Aplicada en produccion el 2026-09-02; su SQL solo vivia dentro de
-- `supabase_migrations.schema_migrations`. Es la definicion VIGENTE de
-- `v_movimiento_clasificado`, o sea las cuatro banderas del Account_Firewall
-- que usan las pantallas de Finanzas y General. Se reconstruye literal, sin
-- una sola edicion. Ver ERP-73.
--
-- ROLLBACK: no aplica. Volver a la version anterior reintroduce el defecto de
-- NULL que esta migracion vino a corregir.
-- ============================================================================

-- Rehace v_movimiento_clasificado: sus cuatro banderas devolvian NULL cuando el
-- movimiento tenia las DOS cuentas en NULL (`NULL IN (...)` no es falso en SQL,
-- es NULL). El TypeScript devuelve false en ese caso. Lo cazo la prueba de
-- equivalencia.
DROP VIEW IF EXISTS public.v_movimiento_clasificado;

CREATE VIEW public.v_movimiento_clasificado WITH (security_invoker = true) AS
WITH cuentas_admin AS (
  SELECT c.id
  FROM public.cuentas_financieras c
  JOIN public.entidades e ON e.id = c.id_entidad
  WHERE e.rol = 'ADMIN'
)
SELECT
  fl.id,
  fl.fecha_movimiento,
  fl.tipo_movimiento,
  fl.monto,
  fl.categoria,
  fl.categoria_gasto,
  fl.descripcion,
  fl.status,
  fl.id_cuenta_origen,
  fl.id_cuenta_destino,
  fl.id_entidad_relacionada,
  fl.id_ticket,

  COALESCE(
    fl.id_cuenta_destino IN (SELECT id FROM cuentas_admin)
    OR fl.id_cuenta_origen IN (SELECT id FROM cuentas_admin)
  , false)                                                            AS toca_cuenta_admin,

  COALESCE(
    fl.status IN ('ACTIVO', 'APPROVED')
    AND fl.categoria IS DISTINCT FROM 'ABONO_PENDIENTE'
  , false)                                                            AS es_contable_efectivo,

  COALESCE(
    (fl.id_cuenta_destino IN (SELECT id FROM cuentas_admin)
     OR fl.id_cuenta_origen IN (SELECT id FROM cuentas_admin))
    AND fl.status IN ('ACTIVO', 'APPROVED')
    AND fl.categoria IS DISTINCT FROM 'ABONO_PENDIENTE'
    AND fl.tipo_movimiento IN ('INGRESO_VENTA', 'ABONO_DEUDA')
  , false)                                                            AS es_ingreso_admin,

  COALESCE(
    (fl.id_cuenta_destino IN (SELECT id FROM cuentas_admin)
     OR fl.id_cuenta_origen IN (SELECT id FROM cuentas_admin))
    AND fl.status IN ('ACTIVO', 'APPROVED')
    AND fl.categoria IS DISTINCT FROM 'ABONO_PENDIENTE'
    AND (
      COALESCE(fl.tipo_movimiento, '') IN
        ('GASTO_OPERATIVO', 'COMPRA_INSUMOS', 'SUBSIDIO_FISCAL', 'EGRESO_TRASPASO')
      OR starts_with(COALESCE(fl.tipo_movimiento, ''), 'EGRESO_')
      OR starts_with(COALESCE(fl.tipo_movimiento, ''), 'GASTO_')
      OR starts_with(COALESCE(fl.tipo_movimiento, ''), 'CARGO_')
    )
    AND COALESCE(fl.id_cuenta_origen, fl.id_cuenta_destino)
        IN (SELECT id FROM cuentas_admin)
  , false)                                                            AS es_egreso_admin
FROM public.finanzas_ledger fl;

COMMENT ON VIEW public.v_movimiento_clasificado IS
'Una fila por movimiento de finanzas_ledger con las banderas del Account_Firewall ya '
'calculadas. Reproduce movimientoTocaCuentaAdmin / filtrarMovimientosFirewallAdmin, '
'esTipoEgresoAdmin y resolveCuentaEgresoAdmin (lib/dashboard-utils.ts) y '
'movimientoContableEfectivo (lib/finance-utils.ts). SIN filtro de fechas: el periodo lo pone '
'quien consulta. Falla cerrada: si el invocador no ve las cuentas del ADMIN, el conjunto admin '
'sale vacio y todas las banderas dan false, igual que filtrarMovimientosFirewallAdmin con la '
'lista de cuentas vacia. Ninguna bandera es NULL nunca: en SQL NULL IN (...) da NULL, no falso.';

REVOKE ALL ON public.v_movimiento_clasificado FROM PUBLIC, anon;
GRANT SELECT ON public.v_movimiento_clasificado TO authenticated, service_role;
