-- ===========================================================================
--  D112 · la ENTREGA DE EFECTIVO del distribuidor deja de ser un abono de concesion
-- ===========================================================================
--  Escrito el 2026-09-24 por el ejecutor de la Fase 11 (encargo del Socio,
--  `Fresnillo/ERP_Fresnillo/DESDE_SOCIO_prompt_ejecutor_fase11_ampliada_2026-09-23.md`, Bloque C).
--  **ESTA MIGRACION NO ESTA APLICADA.** Se aplica con `apply_migration` del MCP,
--  y despues el archivo se mueve a `supabase/migrations/` con el nombre con que
--  quedo sellado (LEEME.md). **Se aplica ANTES de desplegar el codigo del
--  Bloque C**: el codigo escribe la columna `es_entrega_efectivo` solo en una
--  entrega, pero sin la columna esa escritura falla (y lo dice; no escribe a medias).
--
-- ---------------------------------------------------------------------------
--  1. EL PROBLEMA (medido 2026-09-24, solo lectura)
-- ---------------------------------------------------------------------------
--  Un DST que vende de contado cobra el efectivo: `lib/venta-servidor.ts` parte
--  el cobro en INGRESO_COMISION (lo suyo) y DEUDA_A_MATRIZ (lo de la matriz).
--  Cuando entrega ese efectivo, se registra como ABONO_DEUDA / ABONO_REAL: el
--  MISMO renglon que el pago de una concesion. Consecuencias:
--    · `v_cartera` le baja la deuda de CONCESION con dinero que ya era de la matriz;
--    · nadie puede decir cuanto efectivo cobro y no ha entregado
--      (`v_saldo_entidad.saldo_por_pagar_efectivo` sale negativo en las 11
--      entidades; el bot lo oculta desde D104).
--  Hoy: DEUDA_A_MATRIZ vivo = $6,554.00 (Martin 3 filas $3,021.00, 2026-05-26/27;
--  Gilberto 1 fila $3,533.00, 2026-09-01).
--
-- ---------------------------------------------------------------------------
--  2. EL DISENO, Y POR QUE NO ES UN `tipo_movimiento` NUEVO
-- ---------------------------------------------------------------------------
--  Se agrega UNA columna, `finanzas_ledger.es_entrega_efectivo` (default false),
--  y la entrega sigue siendo `ABONO_DEUDA`. Se descarto el tipo nuevo, medido:
--    · `v_movimiento_clasificado.es_ingreso_admin` cuenta como ingreso de la
--      matriz SOLO `INGRESO_VENTA` y `ABONO_DEUDA`. La venta de contado de un DST
--      no escribe ingreso de la matriz (escribe DEUDA_A_MATRIZ): el ingreso nace
--      cuando la entrega entra. Un tipo nuevo desaparece ese ingreso de los
--      tableros, en silencio.
--    · La aprobacion (`lib/aprobacion-abonos.ts`) aplica el desglose fiscal a
--      un `ABONO_DEUDA`; un tipo nuevo se lo saltaria.
--    · Son 18 archivos que leen `ABONO_DEUDA`. Con la columna, el que se me
--      olvide cuenta la entrega COMO HOY (falla hacia el estado actual). Con un
--      tipo nuevo, el que se me olvide pierde ingreso o IVA (falla hacia algo nuevo y peor).
--  Lo unico que cambia es la DEUDA DE CONCESION: `v_cartera` y la columna
--  `saldo_pendiente_consignacion` de `v_saldo_entidad` dejan de restar la entrega.
--  `saldo_por_pagar_efectivo` NO cambia (ahi la entrega SI resta, es su lugar).
--
-- ---------------------------------------------------------------------------
--  3. LO QUE NO SE REINTERPRETA
-- ---------------------------------------------------------------------------
--  **Ninguna fila existente cambia.** Las 28 ABONO_REAL de hoy quedan con
--  `es_entrega_efectivo = false`, aunque alguna haya sido una entrega de
--  efectivo: eso no se puede saber desde la base y no se adivina. Por eso la
--  lectura nueva (`v_efectivo_por_entregar`) cuenta SOLO desde el dia en que
--  esta migracion se aplica, y lo dice en su columna `desde`.
--  Si Norman quiere marcar entregas viejas, es una decision suya fila por fila
--  (pregunta abierta en `DESDE_EJECUTOR_fase11_2026-09-23.md`).

-- ---------------------------------------------------------------------------
--  4. EL CAMBIO
-- ---------------------------------------------------------------------------

ALTER TABLE public.finanzas_ledger
  ADD COLUMN IF NOT EXISTS es_entrega_efectivo boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.finanzas_ledger.es_entrega_efectivo IS
'D112: true = el distribuidor/local ENTREGA a la matriz efectivo que cobro de contado '
'(DEUDA_A_MATRIZ). Es ABONO_DEUDA para ingreso y fiscal, pero NO paga concesion: '
'v_cartera y saldo_pendiente_consignacion no la restan. Se lee en v_efectivo_por_entregar.';

-- Una entrega es un ABONO_DEUDA sin pedido. Nada mas puede llevar la marca.
ALTER TABLE public.finanzas_ledger
  DROP CONSTRAINT IF EXISTS finanzas_ledger_entrega_efectivo_check;
ALTER TABLE public.finanzas_ledger
  ADD CONSTRAINT finanzas_ledger_entrega_efectivo_check
  CHECK (NOT es_entrega_efectivo OR (tipo_movimiento = 'ABONO_DEUDA' AND id_ticket IS NULL));

-- Las dos vistas, copiadas de `supabase/migrations/20260902223147_vistas_canonicas.sql`
-- (la definicion vigente) con SOLO las lineas marcadas `D112` agregadas.
-- CREATE OR REPLACE conserva columnas, grants y `security_invoker`.

CREATE OR REPLACE VIEW public.v_saldo_entidad WITH (security_invoker = true) AS
WITH finanzas_contables AS (
  -- Universo compartido por los tres bloques de abajo.
  SELECT
    fl.id_entidad_relacionada,
    fl.tipo_movimiento,
    fl.monto,
    fl.categoria,
    fl.fecha_movimiento,
    fl.es_entrega_efectivo
  FROM public.finanzas_ledger fl
  WHERE fl.status IN ('ACTIVO', 'APPROVED')
),
deuda_tickets AS (
  -- (a) + (b) + (c). `id_comprador = e.id` es el `debtBuyerEntityIds` de (g).
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
    -- (e) CARGO_DEUDA sin filtro de ABONO_PENDIENTE: asi esta en el TypeScript.
    SUM(CASE WHEN f.tipo_movimiento = 'CARGO_DEUDA' THEN f.monto ELSE 0 END) AS cargo_deuda,
    SUM(CASE WHEN f.tipo_movimiento = 'ABONO_DEUDA'
              AND f.categoria IS DISTINCT FROM 'ABONO_PENDIENTE'
              AND NOT f.es_entrega_efectivo  -- D112: la entrega de efectivo NO paga concesion
             THEN f.monto ELSE 0 END) AS abono_deuda,
    -- Bloque de `calcularSaldoPorPagarEfectivo`: aqui el filtro de
    -- ABONO_PENDIENTE si alcanza a los tres tipos.
    SUM(CASE WHEN f.tipo_movimiento = 'DEUDA_A_MATRIZ'
              AND f.categoria IS DISTINCT FROM 'ABONO_PENDIENTE'
             THEN f.monto ELSE 0 END) AS deuda_a_matriz_efectivo,
    SUM(CASE WHEN f.tipo_movimiento = 'CARGO_DEUDA'
              AND f.categoria IS DISTINCT FROM 'ABONO_PENDIENTE'
             THEN f.monto ELSE 0 END) AS cargo_deuda_efectivo,
    SUM(CASE WHEN f.tipo_movimiento = 'ABONO_DEUDA'
              AND f.categoria IS DISTINCT FROM 'ABONO_PENDIENTE'
             THEN f.monto ELSE 0 END) AS abono_deuda_efectivo,
    -- "Total Ganado" historico, sin recorte de periodo.
    SUM(CASE WHEN f.tipo_movimiento IN ('INGRESO_COMISION', 'COMISION_PASIVA')
             THEN f.monto ELSE 0 END) AS total_ganado,
    MAX(CASE WHEN f.tipo_movimiento = 'ABONO_DEUDA'
              AND f.categoria IS DISTINCT FROM 'ABONO_PENDIENTE'
              AND NOT f.es_entrega_efectivo  -- D112: la entrega de efectivo NO paga concesion
             THEN f.fecha_movimiento END) AS ultimo_abono
  FROM finanzas_contables f
  WHERE f.id_entidad_relacionada IS NOT NULL
  GROUP BY f.id_entidad_relacionada
)
SELECT
  e.id                                   AS id_entidad,
  e.nombre,
  e.rol,
  -- fromTickets + cargoDeuda - abonos
  ROUND(
    COALESCE(dt.monto, 0) + COALESCE(aj.cargo_deuda, 0) - COALESCE(aj.abono_deuda, 0)
  , 2)                                   AS saldo_pendiente_consignacion,
  -- DEUDA_A_MATRIZ + CARGO_DEUDA - ABONO_DEUDA. Positivo: el nodo debe
  -- efectivo a la matriz. Negativo: saldo a favor del nodo.
  ROUND(
    COALESCE(aj.deuda_a_matriz_efectivo, 0)
    + COALESCE(aj.cargo_deuda_efectivo, 0)
    - COALESCE(aj.abono_deuda_efectivo, 0)
  , 2)                                   AS saldo_por_pagar_efectivo,
  ROUND(COALESCE(aj.total_ganado, 0), 2) AS total_ganado_comisiones,
  aj.ultimo_abono,
  CASE
    WHEN aj.ultimo_abono IS NULL THEN NULL
    ELSE GREATEST(0, (
      (now() AT TIME ZONE 'America/Mexico_City')::date
      - (aj.ultimo_abono AT TIME ZONE 'America/Mexico_City')::date
    ))
  END                                    AS dias_sin_abonar,
  -- Para que quien audite pueda rehacer la resta sin abrir el codigo.
  ROUND(COALESCE(dt.monto, 0), 2)        AS deuda_generada_tickets,
  ROUND(COALESCE(aj.cargo_deuda, 0), 2)  AS cargos_deuda,
  ROUND(COALESCE(aj.abono_deuda, 0), 2)  AS abonos_aprobados,
  now()                                  AS calculado_en
FROM public.entidades e
LEFT JOIN deuda_tickets dt ON dt.id_entidad = e.id
LEFT JOIN ajustes       aj ON aj.id_entidad = e.id;

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
    aj.ultimo_abono
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
  now()                                   AS calculado_en
FROM con_dias;

-- La lectura nueva. `desde` es el dia (hora de Zacatecas) en que se aplica esta
-- migracion: se ESCRIBE como literal en la definicion de la vista al aplicarla,
-- para que no se mueva nunca despues. Lo anterior a esa fecha no se cuenta: las
-- entregas de antes estan revueltas con abonos de concesion y no se separan.
--   cobrado_de_contado  = DEUDA_A_MATRIZ desde `desde`
--   entregado           = entregas aprobadas desde `desde`
--   entregas_por_aprobar= entregas de un DST capturadas en la web que esperan al ADMIN
--   por_entregar        = cobrado_de_contado - entregado (negativo = entrego efectivo
--                         que cobro ANTES de `desde`; no se recorta a cero)
-- Todos los DST salen siempre (con ceros si no hay nada); un LOC, solo si tiene movimiento.
DO $d112$
DECLARE
  corte date := (now() AT TIME ZONE 'America/Mexico_City')::date;
BEGIN
  EXECUTE format($v$
CREATE OR REPLACE VIEW public.v_efectivo_por_entregar WITH (security_invoker = true) AS
WITH vivos AS (
  SELECT
    fl.id_entidad_relacionada AS id_entidad,
    fl.tipo_movimiento,
    fl.monto,
    fl.categoria,
    fl.es_entrega_efectivo
  FROM public.finanzas_ledger fl
  WHERE COALESCE(fl.status, 'ACTIVO') <> 'ANULADO'
    AND fl.id_entidad_relacionada IS NOT NULL
    AND (fl.fecha_movimiento AT TIME ZONE 'America/Mexico_City')::date >= %1$L::date
),
sumas AS (
  SELECT
    id_entidad,
    SUM(CASE WHEN tipo_movimiento = 'DEUDA_A_MATRIZ'
              AND categoria IS DISTINCT FROM 'ABONO_PENDIENTE'
             THEN monto ELSE 0 END) AS cobrado,
    SUM(CASE WHEN es_entrega_efectivo
              AND categoria IS DISTINCT FROM 'ABONO_PENDIENTE'
             THEN monto ELSE 0 END) AS entregado,
    SUM(CASE WHEN es_entrega_efectivo
              AND categoria = 'ABONO_PENDIENTE'
             THEN monto ELSE 0 END) AS por_aprobar
  FROM vivos
  GROUP BY id_entidad
)
SELECT
  e.id                                              AS id_entidad,
  e.nombre,
  e.rol,
  ROUND(COALESCE(s.cobrado, 0), 2)                  AS cobrado_de_contado,
  ROUND(COALESCE(s.entregado, 0), 2)                AS entregado,
  ROUND(COALESCE(s.por_aprobar, 0), 2)              AS entregas_por_aprobar,
  ROUND(COALESCE(s.cobrado, 0) - COALESCE(s.entregado, 0), 2) AS por_entregar,
  %1$L::date                                        AS desde,
  now()                                             AS calculado_en
FROM public.entidades e
LEFT JOIN sumas s ON s.id_entidad = e.id
WHERE e.rol = 'DST'
   OR (e.rol = 'LOC' AND s.id_entidad IS NOT NULL
       AND (s.cobrado <> 0 OR s.entregado <> 0 OR s.por_aprobar <> 0))
$v$, corte);
END
$d112$;

COMMENT ON VIEW public.v_efectivo_por_entregar IS
'D112: efectivo cobrado de contado (DEUDA_A_MATRIZ) menos entregado a la matriz '
'(es_entrega_efectivo), por DST/LOC, SOLO desde la columna `desde`. Lo anterior no se separa.';

REVOKE ALL ON public.v_efectivo_por_entregar FROM PUBLIC, anon;
GRANT SELECT ON public.v_efectivo_por_entregar TO authenticated, service_role;

-- ---------------------------------------------------------------------------
--  5. COMO SE COMPRUEBA DESPUES DE APLICAR
-- ---------------------------------------------------------------------------
--  (1) Sin ninguna entrega marcada, las dos vistas viejas dan EXACTAMENTE lo
--      mismo que antes (nada existente tiene la marca):
--        select round(sum(deuda),2) from v_cartera;            -- igual que antes
--        select round(sum(saldo_pendiente_consignacion),2) from v_saldo_entidad;
--  (2) select * from v_efectivo_por_entregar;  -> los DST, en ceros, `desde` = hoy.
--  (3) La marca no entra donde no va (debe fallar con 23514):
--        insert into finanzas_ledger (tipo_movimiento, monto, es_entrega_efectivo, status)
--        values ('GASTO_OPERATIVO', 1, true, 'ACTIVO');
--  (4) `npm run verificar`: `vistas-equivalencia` sigue verde (v_cartera = construirCartera).
--  Control corrido ANTES, en una copia local del respaldo 2026-09-20 (Postgres 16):
--  ver `Fresnillo/ERP_Fresnillo/_avance_fase11_2026-09-23.md`, D112.
--
-- ---------------------------------------------------------------------------
--  6. ROLLBACK (en este orden)
-- ---------------------------------------------------------------------------
--  Volver a correr las dos definiciones de `20260902223147_vistas_canonicas.sql`
--  como CREATE OR REPLACE (quitan las lineas D112), y despues:
--    drop view if exists public.v_efectivo_por_entregar;
--    alter table public.finanzas_ledger drop constraint if exists finanzas_ledger_entrega_efectivo_check;
--    alter table public.finanzas_ledger drop column if exists es_entrega_efectivo;
--  OJO: si ya hay entregas escritas, borrar la columna las vuelve abonos de
--  concesion otra vez (el estado de hoy). No se pierde dinero; se pierde la marca.
-- ===========================================================================
