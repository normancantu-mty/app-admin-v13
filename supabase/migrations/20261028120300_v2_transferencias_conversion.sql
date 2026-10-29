-- ============================================================================
-- v2: cuenta Transferencias, conversion a efectivo con comision, y su metrica
-- Escrito el 2026-10-28 por el Socio (ejecutor), rama v2-arranque-limpio.
-- ============================================================================
-- Lo que pidio Norman (2026-10-28): las ventas cobradas por transferencia caen en
-- una cuenta "Transferencias" del CEO Admin. Cuando se convierten a efectivo les
-- quitan una comision (5% hoy). El ERP registra cada conversion y muestra cuantas
-- transferencias y cuanto dinero se recibio, se convirtio y falta por convertir.
--
-- La cuenta misma (fila de cuentas_financieras con clase TRANSFERENCIAS) la crea
-- scripts/cargar_arranque.py con la fiscalidad que Norman eligio (t_fis).
--
-- convertir_transferencias(M): con c = round(M * pct / 100, 2) y n = M - c
--   EGRESO_TRASPASO  n  sale de Transferencias  (convencion de /api/finanzas/nuevo:
--                        la cuenta afectada va en id_cuenta_destino)
--   INGRESO_TRASPASO n  entra a Efectivo
--   GASTO_OPERATIVO  c  sale de Transferencias, categoria Financieros /
--                        "Comision por conversion de transferencias"
--   => Transferencias baja M, Efectivo sube n, el gasto del periodo sube c.
-- Se usan los tipos que ya existen: no hizo falta ensanchar el CHECK.
-- La comision cae en el centavo: c se redondea a 2 decimales y n es el
-- complemento exacto, asi que c + n = M siempre (CHECK en la tabla).
-- ============================================================================

-- Porcentaje vigente (cargar_arranque.py lo pone con t_pct de la captura).
INSERT INTO public.parametros_costo (clave, valor, unidad, fuente, nota)
VALUES ('comision_conversion_transferencias_pct', 5, '%',
        'Norman, voz 2026-10-28', 'Comision al convertir Transferencias a Efectivo')
ON CONFLICT (clave) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.conversiones_transferencia (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fecha              timestamptz NOT NULL DEFAULT now(),
  id_cuenta_origen   uuid NOT NULL REFERENCES public.cuentas_financieras(id),
  id_cuenta_destino  uuid NOT NULL REFERENCES public.cuentas_financieras(id),
  monto              numeric(12,2) NOT NULL CHECK (monto > 0),
  pct_comision       numeric(5,2)  NOT NULL CHECK (pct_comision >= 0 AND pct_comision < 100),
  comision           numeric(12,2) NOT NULL CHECK (comision >= 0),
  neto               numeric(12,2) NOT NULL CHECK (neto > 0),
  ids_ledger         uuid[] NOT NULL,
  status             text NOT NULL DEFAULT 'ACTIVO' CHECK (status IN ('ACTIVO', 'ANULADO')),
  nota               text,
  usuario_creador    text,
  creado_en          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversion_cuadra CHECK (comision + neto = monto)
);

COMMENT ON TABLE public.conversiones_transferencia IS
  'v2: cada conversion de Transferencias a Efectivo. ids_ledger = las 3 filas de finanzas_ledger.';

ALTER TABLE public.conversiones_transferencia ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.conversiones_transferencia FROM anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.conversiones_transferencia TO authenticated, service_role;

DROP POLICY IF EXISTS conversiones_sel ON public.conversiones_transferencia;
CREATE POLICY conversiones_sel ON public.conversiones_transferencia
  FOR SELECT TO authenticated USING (public.mi_rol() IN ('ADMIN', 'SOCIO'));
DROP POLICY IF EXISTS conversiones_ins ON public.conversiones_transferencia;
CREATE POLICY conversiones_ins ON public.conversiones_transferencia
  FOR INSERT TO authenticated WITH CHECK (public.mi_rol() = 'ADMIN');
DROP POLICY IF EXISTS conversiones_upd ON public.conversiones_transferencia;
CREATE POLICY conversiones_upd ON public.conversiones_transferencia
  FOR UPDATE TO authenticated USING (public.mi_rol() = 'ADMIN') WITH CHECK (public.mi_rol() = 'ADMIN');

-- SECURITY INVOKER a proposito: corre con la RLS y los triggers de autor de quien
-- llama (finanzas_ins_admin exige ADMIN). La guarda de rol es un mensaje claro,
-- no la unica defensa.
CREATE OR REPLACE FUNCTION public.convertir_transferencias(
  p_monto numeric,
  p_nota  text DEFAULT NULL,
  p_fecha timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_admin   uuid;
  v_trans   uuid;
  v_efec    uuid;
  v_pct     numeric;
  v_saldo   numeric;
  v_monto   numeric(12,2);
  v_com     numeric(12,2);
  v_neto    numeric(12,2);
  v_subcat  text;
  v_id      uuid := gen_random_uuid();
  v_ids     uuid[];
  v_autor   text := COALESCE(auth.jwt() ->> 'email', current_user);
BEGIN
  IF COALESCE(public.mi_rol(), '') <> 'ADMIN' AND current_user NOT IN ('postgres', 'service_role') THEN
    RAISE EXCEPTION 'Solo el ADMIN convierte transferencias' USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_monto := round(p_monto, 2);
  IF v_monto IS NULL OR v_monto <= 0 THEN
    RAISE EXCEPTION 'Monto invalido: %', p_monto USING ERRCODE = 'check_violation';
  END IF;

  SELECT c.id_entidad, c.id INTO v_admin, v_trans
    FROM public.cuentas_financieras c
    JOIN public.entidades e ON e.id = c.id_entidad
   WHERE c.clase = 'TRANSFERENCIAS' AND e.rol = 'ADMIN'
   ORDER BY e.id LIMIT 1;
  IF v_trans IS NULL THEN
    RAISE EXCEPTION 'No hay cuenta con clase TRANSFERENCIAS del ADMIN (corre scripts/cargar_arranque.py)';
  END IF;

  SELECT c.id INTO v_efec FROM public.cuentas_financieras c
   WHERE c.id_entidad = v_admin AND c.clase = 'EFECTIVO';
  IF v_efec IS NULL THEN
    RAISE EXCEPTION 'No hay cuenta con clase EFECTIVO del ADMIN';
  END IF;

  v_saldo := public.saldo_cuenta(v_trans);
  IF v_monto > v_saldo THEN
    RAISE EXCEPTION 'Se quieren convertir % y en Transferencias hay %', v_monto, v_saldo
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT valor INTO v_pct FROM public.parametros_costo
   WHERE clave = 'comision_conversion_transferencias_pct';
  v_pct  := COALESCE(v_pct, 5);
  v_com  := round(v_monto * v_pct / 100, 2);
  v_neto := v_monto - v_com;

  SELECT subcategoria INTO v_subcat FROM public.categorias_movimiento
   WHERE tipo = 'EGRESO' AND categoria = 'Financieros' AND activa
     AND subcategoria ILIKE 'Comisi_n por conversi_n de transferencias%'
   ORDER BY orden LIMIT 1;
  v_subcat := COALESCE(v_subcat, 'Comisión por conversión de transferencias');

  WITH ins AS (
    INSERT INTO public.finanzas_ledger
      (tipo_movimiento, monto, categoria, subcategoria, categoria_gasto, descripcion,
       id_cuenta_destino, fecha_movimiento, usuario_creador, status, metodo_pago)
    VALUES
      ('EGRESO_TRASPASO',  v_neto, 'TRANSFERENCIA', NULL, 'Conversión de transferencias a efectivo',
       'conversion:' || v_id, v_trans, p_fecha, v_autor, 'ACTIVO', NULL),
      ('INGRESO_TRASPASO', v_neto, 'TRANSFERENCIA', NULL, 'Conversión de transferencias a efectivo',
       'conversion:' || v_id, v_efec,  p_fecha, v_autor, 'ACTIVO', NULL),
      ('GASTO_OPERATIVO',  v_com,  'Financieros', v_subcat, v_subcat,
       'conversion:' || v_id, v_trans, p_fecha, v_autor, 'ACTIVO', 'TRANSFERENCIA')
    RETURNING id
  )
  SELECT array_agg(id) INTO v_ids FROM ins;

  INSERT INTO public.conversiones_transferencia
    (id, fecha, id_cuenta_origen, id_cuenta_destino, monto, pct_comision, comision, neto,
     ids_ledger, nota, usuario_creador)
  VALUES (v_id, p_fecha, v_trans, v_efec, v_monto, v_pct, v_com, v_neto, v_ids, p_nota, v_autor);

  RETURN jsonb_build_object('id', v_id, 'monto', v_monto, 'pct', v_pct, 'comision', v_com,
                            'neto', v_neto, 'ids_ledger', to_jsonb(v_ids));
END
$$;

REVOKE ALL ON FUNCTION public.convertir_transferencias(numeric, text, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.convertir_transferencias(numeric, text, timestamptz) TO authenticated, service_role;

-- Metrica de transferencias, una fila por cuenta TRANSFERENCIAS.
--   recibidas : lo que entro a la cuenta (ventas, abonos, traspasos, saldo inicial)
--   convertido: suma bruta de las conversiones ACTIVAS (y la comision pagada)
--   pendiente : recibido - convertido. El CONTEO pendiente es FIFO: las
--               transferencias mas viejas se dan por convertidas primero, y
--               cuentan como pendientes las que la suma convertida no alcanza.
CREATE OR REPLACE VIEW public.v_transferencias_resumen
WITH (security_invoker = true) AS
WITH cuentas AS (
  SELECT c.id, c.nombre FROM public.cuentas_financieras c WHERE c.clase = 'TRANSFERENCIAS'
),
recibidas AS (
  SELECT f.id_cuenta_destino AS id_cuenta, f.id, f.fecha_movimiento, f.monto,
         SUM(f.monto) OVER (PARTITION BY f.id_cuenta_destino
                            ORDER BY f.fecha_movimiento, f.id) AS acumulado
    FROM public.finanzas_ledger f
    JOIN cuentas c ON c.id = f.id_cuenta_destino
   WHERE f.tipo_movimiento IN ('INGRESO_VENTA', 'ABONO_DEUDA', 'INGRESO_TRASPASO', 'SALDO_INICIAL')
     AND f.status IN ('ACTIVO', 'APPROVED')
     AND f.categoria IS DISTINCT FROM 'ABONO_PENDIENTE'
),
convertidas AS (
  SELECT k.id_cuenta_origen AS id_cuenta, COUNT(*) AS n, SUM(k.monto) AS monto,
         SUM(k.comision) AS comision, SUM(k.neto) AS neto
    FROM public.conversiones_transferencia k
   WHERE k.status = 'ACTIVO'
   GROUP BY k.id_cuenta_origen
)
SELECT c.id AS id_cuenta,
       c.nombre AS cuenta,
       COUNT(r.id)::int                                  AS recibidas_n,
       COALESCE(SUM(r.monto), 0)::numeric(14,2)          AS recibido_monto,
       COALESCE(MAX(k.n), 0)::int                        AS conversiones_n,
       COALESCE(MAX(k.monto), 0)::numeric(14,2)          AS convertido_monto,
       COALESCE(MAX(k.comision), 0)::numeric(14,2)       AS comision_monto,
       COALESCE(MAX(k.neto), 0)::numeric(14,2)           AS neto_a_efectivo,
       COUNT(r.id) FILTER (WHERE r.acumulado > COALESCE(k.monto, 0))::int AS pendientes_n,
       (COALESCE(SUM(r.monto), 0) - COALESCE(MAX(k.monto), 0))::numeric(14,2) AS pendiente_monto,
       public.saldo_cuenta(c.id)                         AS saldo_cuenta
  FROM cuentas c
  LEFT JOIN recibidas r ON r.id_cuenta = c.id
  LEFT JOIN convertidas k ON k.id_cuenta = c.id
 GROUP BY c.id, c.nombre;

REVOKE ALL ON public.v_transferencias_resumen FROM anon;
GRANT SELECT ON public.v_transferencias_resumen TO authenticated, service_role;
