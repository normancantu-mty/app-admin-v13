-- v2 LOCAL (2026-10-29, Socio ejecutor): `v_cartera` gana la columna `id_acreedor`.
--
-- Por que: la cartera de la matriz sumaba la deuda de TODOS los locales, incluida la de
-- los locales que le deben a su distribuidor (red de David Flores y de Gilberto Franco).
-- Esa deuda no es de la matriz: el distribuidor ya la debe en su propio renglon por lo
-- que le entrego. Con la carga conciliada eran 19,382.00 contados de mas
-- (68,537.93 en vez de 49,155.93). Ver Socio/_checkpoints/conciliacion_locales_2026-10-29.md.
--
-- La definicion es la de 20260924144008_d112 sin cambios, salvo la columna nueva al
-- final (CREATE OR REPLACE VIEW solo admite columnas nuevas al final).
-- id_acreedor = COALESCE(id_nodo_padre, id_padre); NULL = la matriz.

CREATE OR REPLACE VIEW public.v_cartera WITH (security_invoker = true) AS
WITH inventario_vivo AS (
  SELECT
    il.tipo_movimiento,
    abs(il.cantidad) AS cantidad,
    il.id_entidad_origen,
    il.id_entidad_destino,
    il.fecha_movimiento
  FROM public.inventario_ledger il
  WHERE COALESCE(il.status, 'ACTIVO') <> 'ANULADO'
),
piso AS (
  SELECT
    e.id AS id_entidad,
    COALESCE(SUM(CASE WHEN iv.id_entidad_destino = e.id
                       AND iv.tipo_movimiento = 'ENTRADA_CONCESION'
                      THEN iv.cantidad ELSE 0 END), 0) AS recibidas,
    COALESCE(SUM(CASE WHEN iv.id_entidad_origen = e.id
                      THEN iv.cantidad ELSE 0 END), 0) AS salidas,
    MAX(CASE WHEN iv.id_entidad_destino = e.id
              AND iv.tipo_movimiento = 'ENTRADA_CONCESION'
             THEN iv.fecha_movimiento END)             AS ultima_entrega
  FROM public.entidades e
  LEFT JOIN inventario_vivo iv
    ON iv.id_entidad_destino = e.id
    OR iv.id_entidad_origen  = e.id
  WHERE e.rol IN ('DST', 'LOC')
  GROUP BY e.id
),
finanzas_cartera AS (
  -- [OJO] Aqui el filtro es `<> 'ANULADO'`, no `IN ('ACTIVO','APPROVED')`.
  SELECT
    fl.id_entidad_relacionada,
    fl.tipo_movimiento,
    fl.monto,
    fl.categoria,
    fl.fecha_movimiento
  FROM public.finanzas_ledger fl
  WHERE COALESCE(fl.status, 'ACTIVO') <> 'ANULADO'
    AND NOT fl.es_entrega_efectivo  -- D112: la entrega de efectivo NO es abono de concesion
),
deuda_tickets AS (
  SELECT
    tk.id_comprador AS id_entidad,
    SUM(CASE WHEN e.rol = 'DST' THEN tk.monto_base_ingreso ELSE tk.total_cobrado_real END) AS monto
  FROM public.transacciones_tickets tk
  JOIN public.entidades e ON e.id = tk.id_comprador
  WHERE COALESCE(tk.status, 'ACTIVO') <> 'ANULADO'
    AND tk.condicion_pago = 'CONCESION'
  GROUP BY tk.id_comprador
),
ajustes AS (
  SELECT
    f.id_entidad_relacionada AS id_entidad,
    SUM(CASE WHEN f.tipo_movimiento = 'CARGO_DEUDA' THEN f.monto ELSE 0 END) AS cargo_deuda,
    SUM(CASE WHEN f.tipo_movimiento = 'ABONO_DEUDA'
              AND f.categoria IS DISTINCT FROM 'ABONO_PENDIENTE'
             THEN f.monto ELSE 0 END) AS abonado,
    MAX(CASE WHEN f.tipo_movimiento = 'ABONO_DEUDA'
              AND f.categoria IS DISTINCT FROM 'ABONO_PENDIENTE'
             THEN f.fecha_movimiento END) AS ultimo_abono
  FROM finanzas_cartera f
  WHERE f.id_entidad_relacionada IS NOT NULL
  GROUP BY f.id_entidad_relacionada
),
base AS (
  SELECT
    e.id      AS id_entidad,
    e.nombre,
    e.rol,
    p.recibidas,
    p.salidas,
    p.ultima_entrega,
    COALESCE(dt.monto, 0) + COALESCE(aj.cargo_deuda, 0) - COALESCE(aj.abonado, 0) AS deuda,
    COALESCE(aj.abonado, 0) AS abonado,
    aj.ultimo_abono,
    -- v2: con quien es la deuda. NULL = la matriz; si no, el padre en la red
    -- (el DST que le entrego). Misma regla que cargar_arranque.py y la conciliacion.
    COALESCE(e.id_nodo_padre, e.id_padre) AS id_acreedor
  FROM public.entidades e
  JOIN piso p               ON p.id_entidad = e.id
  LEFT JOIN deuda_tickets dt ON dt.id_entidad = e.id
  LEFT JOIN ajustes       aj ON aj.id_entidad = e.id
  WHERE e.rol IN ('DST', 'LOC')
    AND p.recibidas > 0
),
calculada AS (
  SELECT
    b.*,
    b.deuda + b.abonado AS generado,
    CASE WHEN b.deuda + b.abonado > 0 THEN b.abonado / (b.deuda + b.abonado) END AS porcentaje_pagado,
    COALESCE(b.ultimo_abono, b.ultima_entrega) AS referencia_fecha,
    CASE
      WHEN b.ultimo_abono   IS NOT NULL THEN 'ABONO'
      WHEN b.ultima_entrega IS NOT NULL THEN 'ENTREGA'
      ELSE 'NINGUNA'
    END AS referencia_dias
  FROM base b
),
con_dias AS (
  SELECT
    c.*,
    CASE
      WHEN c.referencia_fecha IS NULL THEN NULL
      ELSE GREATEST(0, (
        (now() AT TIME ZONE 'America/Mexico_City')::date
        - (c.referencia_fecha AT TIME ZONE 'America/Mexico_City')::date
      ))
    END AS dias_sin_abono
  FROM calculada c
)
SELECT
  id_entidad,
  nombre,
  rol,
  recibidas,
  salidas,
  recibidas - salidas                     AS libro_dice,
  ROUND(generado, 2)                      AS generado,
  ROUND(abonado, 2)                       AS abonado,
  porcentaje_pagado,
  -- porcentajePagado === null ? recibidas : Math.max(0, Math.round(recibidas * (1 - pct)))
  CASE
    WHEN porcentaje_pagado IS NULL THEN recibidas
    ELSE GREATEST(0, ROUND(recibidas * (1 - porcentaje_pagado)))
  END                                     AS estimado_en_piso,
  ROUND(deuda, 2)                         AS deuda,
  ultimo_abono,
  dias_sin_abono,
  referencia_dias,
  -- prioridad = deuda > 0 ? deuda * dias : 0. Es el orden de visita.
  CASE WHEN deuda > 0 THEN ROUND(deuda * COALESCE(dias_sin_abono, 0), 2) ELSE 0 END AS prioridad,
  now()                                   AS calculado_en,
  id_acreedor
FROM con_dias;
