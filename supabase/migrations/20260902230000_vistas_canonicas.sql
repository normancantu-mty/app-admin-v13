-- ============================================================================
-- Vistas canonicas · sacar la aritmetica del dinero de TypeScript
-- ============================================================================
-- Hasta hoy no habia UNA sola vista ni funcion de calculo en Postgres: todos
-- los saldos, el stock y los pasivos se armaban en TypeScript, y nadie podia
-- auditar por que un saldo decia lo que decia sin leer codigo.
--
-- Estas cinco vistas mueven la aritmetica de lugar. **NO la cambian.** Cada
-- una reproduce al peso una funcion concreta de `lib/`, rarezas incluidas, y
-- la funcion sigue siendo la referencia: si una vista no coincide, la vista
-- esta mal. Las diferencias que se detectaron y NO se corrigieron aqui van
-- anotadas como [OJO] en el comentario de la vista que las hereda.
--
-- Nada de la aplicacion lee todavia de estas vistas. Esta migracion no cambia
-- el comportamiento de ninguna pantalla.
--
-- ─── LA TRAMPA DE SEGURIDAD, Y COMO SE EVITA ────────────────────────────────
-- En PostgreSQL una vista NO respeta por defecto el RLS de las tablas que
-- consulta: corre con los permisos de QUIEN LA CREO (aqui `postgres`, que es
-- dueno de las 9 tablas y tiene BYPASSRLS). Creada asi, cualquiera de estas
-- vistas seria una puerta trasera al ledger completo, y desharia el cierre del
-- 2026-09-02, cuando Gilberto paso de ver 118 filas de finanzas a 16.
--
-- Por eso **las cinco llevan `WITH (security_invoker = true)`**: cada consulta
-- evalua las politicas del usuario que la ejecuta, no las del dueno.
-- Postgres 17.6 lo soporta. Comprobado, no supuesto (ver el pie de archivo).
--
-- Consecuencia buscada del `security_invoker`: las vistas que dependen de
-- `cuentas_financieras` del ADMIN (v_movimiento_clasificado, v_pasivo_fiscal)
-- **fallan cerradas** para quien no puede ver esas cuentas. Un DST no ve las
-- cuentas de la matriz, asi que su conjunto admin sale vacio y todas las
-- banderas le dan `false` / los pasivos le dan 0. Es el mismo "fail closed"
-- que `filtrarMovimientosFirewallAdmin` (lib/dashboard-utils.ts): con la lista
-- de cuentas admin vacia devuelve vacio, nunca la lista entera.
--
-- Solo CREATE VIEW. Ni una tabla, ni un ALTER, ni un UPDATE, ni un DELETE, ni
-- una politica de RLS tocada.
-- ============================================================================


-- ============================================================================
-- 1 · v_saldo_entidad  —  la mas importante
-- ============================================================================
-- Reproduce `calcularSaldoPendienteInventarioConsignacion` y
-- `calcularSaldoPorPagarEfectivo` de lib/distribuidores-saldos.ts, mas el KPI
-- "Total Ganado" de app/dashboard/distribuidores/[id]/page.tsx.
--
-- LAS RAREZAS QUE HAY QUE REPRODUCIR, UNA POR UNA:
--
--  a) Un DST se endeuda con `monto_base_ingreso` y un LOC con
--     `total_cobrado_real`. No es un typo: para el DST la deuda se mide sin el
--     impuesto que la matriz ya separo.
--  b) Solo cuentan los tickets de `condicion_pago = 'CONCESION'`.
--  c) Se excluyen los tickets con `status = 'ANULADO'`. Un ticket sin status
--     se lee como ACTIVO (`t.status ?? 'ACTIVO'`).
--  d) De los abonos se excluyen los de `categoria = 'ABONO_PENDIENTE'`
--     (`esAbonoPendienteAprobacion`), que existen pero aun no son contables.
--  e) [OJO] Ese filtro de ABONO_PENDIENTE se aplica a los ABONO_DEUDA pero NO
--     a los CARGO_DEUDA, en `calcularSaldoPendienteInventarioConsignacion`.
--     En `calcularSaldoPorPagarEfectivo` si se aplica a los tres tipos. La
--     asimetria esta en el TypeScript y se copia tal cual; hoy no cambia
--     ningun numero porque el unico ABONO_PENDIENTE vivo es un ABONO_DEUDA.
--  f) El universo de `finanzas_ledger` es `status IN ('ACTIVO','APPROVED')`:
--     es lo que consultan el directorio (distribuidores/page.tsx:209) y el
--     perfil (distribuidores/[id]/page.tsx:272 + filtro `!= 'ANULADO'`).
--     APPROVED es legacy y hoy no tiene ni una fila, pero se sigue tolerando.
--  g) `debtBuyerEntityIds` vale `[entidad.id]` en las tres pantallas que
--     llaman a la funcion, asi que la deuda de un nodo son SUS tickets, sin
--     consolidar los de sus hijos.
--
-- `dias_sin_abonar` se cuenta en dias de CALENDARIO en America/Mexico_City, no
-- en milisegundos: un abono del lunes a las 8 pm y otro del martes a las 9 am
-- estan a un dia, no a cero. Es la misma regla que `diasEntre`
-- (lib/cartera-utils.ts). Aqui es NULL si el nodo nunca abono; la caida a la
-- fecha de entrega solo existe en la cartera, y vive en `v_cartera`.
-- ============================================================================
CREATE VIEW public.v_saldo_entidad WITH (security_invoker = true) AS
WITH finanzas_contables AS (
  -- Universo compartido por los tres bloques de abajo.
  SELECT
    fl.id_entidad_relacionada,
    fl.tipo_movimiento,
    fl.monto,
    fl.categoria,
    fl.fecha_movimiento
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

COMMENT ON VIEW public.v_saldo_entidad IS
'Reproduce calcularSaldoPendienteInventarioConsignacion y calcularSaldoPorPagarEfectivo '
'(lib/distribuidores-saldos.ts) y el KPI "Total Ganado" de '
'app/dashboard/distribuidores/[id]/page.tsx (calcularSaldos). Una fila por entidad visible. '
'Rarezas copiadas a proposito: DST se endeuda con monto_base_ingreso y LOC con '
'total_cobrado_real; solo tickets CONCESION; fuera los tickets ANULADO; fuera los abonos con '
'categoria ABONO_PENDIENTE. Universo de finanzas: status IN (ACTIVO, APPROVED). '
'dias_sin_abonar son dias de calendario en America/Mexico_City, NULL si nunca abono. '
'La funcion de TypeScript sigue siendo la referencia: si no coinciden, la vista esta mal.';


-- ============================================================================
-- 2 · v_stock_por_cubeta  —  entidad x producto x cubeta
-- ============================================================================
-- Reproduce `getStockPorCubetaPorEntidad` de lib/inventario-auditoria.ts, que
-- es el motor de la auditoria fisica.
--
-- Reglas copiadas:
--  · Movimientos con `status IN ('ACTIVO','APPROVED')`.
--  · La cubeta es CONSIGNADO solo si dice exactamente 'CONSIGNADO'; cualquier
--    otra cosa (incluida NULL) cae en PAGADO.
--  · Suma si el movimiento ENTRA a la entidad (destino = entidad y tipo de
--    entrada), resta si SALE (origen = entidad y tipo de salida). La entrada
--    tiene precedencia (en el TypeScript hay un `continue`), aunque hoy da
--    igual: las listas de entrada y de salida son disjuntas.
--  · Solo productos con `tipo = 'TERMINADO'`. Las materias primas no aparecen.
--  · Solo filas con stock ESTRICTAMENTE mayor que cero: el cero y el negativo
--    se caen de la lista, igual que en `mapToRows`.
--  · Redondeo a 4 decimales (las recetas usan DECIMAL(10,4)).
--
-- [OJO] LAS DOS VERDADES DEL INVENTARIO, QUE SIGUEN SIN UNIFICARSE.
-- Este motor exige un id de entidad EXPLICITO: un movimiento con
-- `id_entidad_destino IS NULL` no le pertenece a nadie y no entra aqui. El
-- Dashboard, en cambio, cuenta `id_entidad_destino IS NULL` como stock de
-- Matriz. Las dos lecturas conviven en el ERP y dan numeros distintos para la
-- matriz. Esta vista reproduce la de `inventario-auditoria.ts`, que es la que
-- pedia el prompt; unificarlas es otra sesion y otra decision de negocio.
-- ============================================================================
CREATE VIEW public.v_stock_por_cubeta WITH (security_invoker = true) AS
WITH movimientos AS (
  -- Un movimiento puede tocar a DOS entidades (origen y destino): se expande a
  -- una fila por (movimiento, entidad tocada), que es como lo recorre el bucle
  -- del TypeScript cuando se le pregunta por cada entidad.
  SELECT
    e.id     AS id_entidad,
    e.nombre AS entidad,
    il.id_producto,
    CASE WHEN il.cubeta = 'CONSIGNADO' THEN 'CONSIGNADO' ELSE 'PAGADO' END AS cubeta,
    CASE
      WHEN il.id_entidad_destino = e.id
       AND il.tipo_movimiento IN (
             'ENTRADA_COMPRA', 'PRODUCCION', 'DEVOLUCION_FISICA',
             'INGRESO_TRASPASO', 'ENTRADA_CONCESION')
      THEN il.cantidad
      WHEN il.id_entidad_origen = e.id
       AND il.tipo_movimiento IN (
             'SALIDA_VENTA', 'MERMA', 'TRASPASO',
             'EGRESO_TRASPASO', 'SALIDA_CONCESION')
      THEN -il.cantidad
      ELSE 0
    END AS delta
  FROM public.inventario_ledger il
  JOIN public.entidades e
    ON e.id = il.id_entidad_destino
    OR e.id = il.id_entidad_origen
  WHERE il.status IN ('ACTIVO', 'APPROVED')
)
SELECT
  m.id_entidad,
  m.entidad,
  m.id_producto,
  p.nombre                        AS producto,
  m.cubeta,
  ROUND(SUM(m.delta), 4)          AS stock
FROM movimientos m
JOIN public.catalogo_productos p ON p.id = m.id_producto
WHERE p.tipo = 'TERMINADO'
GROUP BY m.id_entidad, m.entidad, m.id_producto, p.nombre, m.cubeta
HAVING ROUND(SUM(m.delta), 4) > 0;

COMMENT ON VIEW public.v_stock_por_cubeta IS
'Reproduce getStockPorCubetaPorEntidad (lib/inventario-auditoria.ts): stock neto por entidad x '
'producto x cubeta (PAGADO/CONSIGNADO), replayeando el ledger completo. Solo productos '
'TERMINADO y solo filas con stock > 0, igual que mapToRows. '
'OJO: este motor exige id de entidad explicito, asi que los movimientos con '
'id_entidad_destino IS NULL (que el Dashboard cuenta como Matriz) NO aparecen aqui. Son las dos '
'verdades del inventario que el ERP todavia no unifica.';


-- ============================================================================
-- 3 · v_movimiento_clasificado  —  el Account_Firewall, en la base
-- ============================================================================
-- Una fila por movimiento de `finanzas_ledger`, con las banderas que hoy se
-- recalculan en cada pantalla. **Sin filtro de fechas a proposito**: el
-- periodo lo pone quien consulta, y asi la misma vista sirve al tablero, al
-- reporte semanal y al bot de Telegram sin que ninguno reinvente el corte.
--
-- Reproduce:
--  · `movimientoTocaCuentaAdmin` / `filtrarMovimientosFirewallAdmin`
--    (lib/dashboard-utils.ts)  ->  toca_cuenta_admin
--  · `movimientoContableEfectivo` (lib/finance-utils.ts)
--                                ->  es_contable_efectivo
--  · el bloque `ingresos` de `getFinanzasDashboard`
--                                ->  es_ingreso_admin
--  · `esTipoEgresoAdmin` + `resolveCuentaEgresoAdmin` + el bloque `egresos`
--                                ->  es_egreso_admin
--
-- `movimientoContableEfectivo` esta escrita como tres condiciones encadenadas
-- (fuera ANULADO/PENDING/REJECTED, fuera ABONO_PENDIENTE, dentro
-- ACTIVO/APPROVED). Las tres juntas se reducen a lo que dice el CASE de abajo;
-- se deja anotada la equivalencia para que se pueda comprobar a ojo.
--
-- [OJO] `resolveCuentaEgresoAdmin` tiene dos ramas (una para
-- GASTO_OPERATIVO / EGRESO_TRASPASO y otra para el resto) que devuelven
-- EXACTAMENTE lo mismo: `id_cuenta_origen ?? id_cuenta_destino`. La rama
-- especial no hace nada. Se copia el resultado, no la rama muerta.
-- ============================================================================
CREATE VIEW public.v_movimiento_clasificado WITH (security_invoker = true) AS
WITH cuentas_admin AS (
  -- El `adminAccountSet` del firewall. Bajo security_invoker, quien no puede
  -- ver las cuentas de la matriz obtiene el conjunto VACIO y todas las
  -- banderas le dan false: es el mismo "fail closed" de
  -- filtrarMovimientosFirewallAdmin, que con la lista vacia devuelve vacio.
  --
  -- El TypeScript toma UNA entidad ADMIN (`.eq('rol','ADMIN').limit(1)`); aqui
  -- se toman las cuentas de TODAS las entidades ADMIN. Hoy hay exactamente una
  -- ADMIN, asi que los dos conjuntos son el mismo; con dos, esta version es la
  -- determinista y el `limit(1)` sin `order by` seria el que elige al azar.
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

  -- movimientoTocaCuentaAdmin: por origen O por destino.
  --
  -- EL `COALESCE(..., false)` NO ES DECORACION, Y LO CAZO LA PRUEBA.
  -- En SQL, `NULL IN (...)` no da falso: da NULL. Un movimiento con las DOS
  -- cuentas en NULL (hoy hay varios: los PASIVO_* y algun gasto viejo) hacia
  -- `NULL OR NULL` = NULL, y la bandera salia NULL donde el TypeScript devuelve
  -- `false` — porque `Boolean(x && set.has(x))` con `x` indefinido es `false`.
  -- Una bandera NULL rompe cualquier `WHERE toca_cuenta_admin = false` de quien
  -- consulte, y encima falla ABIERTA en un `WHERE NOT toca_cuenta_admin`.
  -- Las cuatro banderas se cierran igual, aunque a dos de ellas hoy no les haga
  -- falta: una bandera de una vista canonica no puede ser NULL nunca.
  COALESCE(
    fl.id_cuenta_destino IN (SELECT id FROM cuentas_admin)
    OR fl.id_cuenta_origen IN (SELECT id FROM cuentas_admin)
  , false)                                                            AS toca_cuenta_admin,

  -- movimientoContableEfectivo(status, categoria).
  COALESCE(
    fl.status IN ('ACTIVO', 'APPROVED')
    AND fl.categoria IS DISTINCT FROM 'ABONO_PENDIENTE'
  , false)                                                            AS es_contable_efectivo,

  -- Ingreso de nivel Admin: firewall + tipo de ingreso + contable.
  COALESCE(
    (fl.id_cuenta_destino IN (SELECT id FROM cuentas_admin)
     OR fl.id_cuenta_origen IN (SELECT id FROM cuentas_admin))
    AND fl.status IN ('ACTIVO', 'APPROVED')
    AND fl.categoria IS DISTINCT FROM 'ABONO_PENDIENTE'
    AND fl.tipo_movimiento IN ('INGRESO_VENTA', 'ABONO_DEUDA')
  , false)                                                            AS es_ingreso_admin,

  -- Egreso de nivel Admin: firewall + esTipoEgresoAdmin + contable + la cuenta
  -- que resuelve `resolveCuentaEgresoAdmin` tiene que ser del ADMIN.
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


-- ============================================================================
-- 4 · v_pasivo_fiscal  —  IVA e IEPS por pagar
-- ============================================================================
-- Reproduce `calcularPasivosFiscalesAdmin` (lib/dashboard-utils.ts) junto con
-- `esPagoImpuestoIva` / `esPagoImpuestoIeps` (lib/finance-utils.ts).
--
-- [OJO] EL FILTRO DE STATUS AQUI ES MAS ESTRICTO QUE EN EL RESTO DEL ERP:
-- `mov.status === 'ACTIVO'` a secas, sin tolerar el legacy 'APPROVED' que si
-- aceptan todas las demas lecturas. Se copia tal cual porque asi esta escrito
-- y hoy no cambia ningun numero (no queda ni una fila APPROVED); pero es una
-- inconsistencia real y el dia que aparezca una fila APPROVED, los pasivos
-- diran algo distinto que el resto del tablero.
--
-- El acumulado usa `Math.abs(monto)`: el signo del ledger no se respeta, se
-- suman magnitudes. Tambien se copia.
--
-- Un pago de impuesto se reconoce por TEXTO, no por bandera: se concatenan
-- `categoria`, `categoria_gasto` y `descripcion` separados por espacio, se
-- pasa a mayusculas y se busca subcadena. Renombrar una categoria rompe el
-- calculo en silencio, igual que hoy.
--
-- Una sola fila: es el pasivo de la matriz, no hay uno por entidad.
-- ============================================================================
CREATE VIEW public.v_pasivo_fiscal WITH (security_invoker = true) AS
WITH cuentas_admin AS (
  SELECT c.id
  FROM public.cuentas_financieras c
  JOIN public.entidades e ON e.id = c.id_entidad
  WHERE e.rol = 'ADMIN'
),
activos AS (
  SELECT
    fl.tipo_movimiento,
    fl.monto,
    -- textoConceptoFiscal: `${categoria} ${categoria_gasto} ${descripcion}` en
    -- mayusculas, con los NULL como cadena vacia.
    upper(
      COALESCE(fl.categoria, '') || ' ' ||
      COALESCE(fl.categoria_gasto, '') || ' ' ||
      COALESCE(fl.descripcion, '')
    ) AS texto
  FROM public.finanzas_ledger fl
  WHERE fl.status = 'ACTIVO'                                   -- [OJO] sin APPROVED
    AND fl.categoria IS DISTINCT FROM 'ABONO_PENDIENTE'
    AND (fl.id_cuenta_destino IN (SELECT id FROM cuentas_admin)
      OR fl.id_cuenta_origen  IN (SELECT id FROM cuentas_admin))
),
sumas AS (
  SELECT
    COALESCE(SUM(CASE WHEN tipo_movimiento = 'PASIVO_IVA'  THEN abs(monto) END), 0) AS pasivo_iva,
    COALESCE(SUM(CASE WHEN tipo_movimiento = 'PASIVO_IEPS' THEN abs(monto) END), 0) AS pasivo_ieps,
    COALESCE(SUM(CASE WHEN tipo_movimiento = 'GASTO_OPERATIVO'
                       -- strpos, no LIKE: en LIKE el `_` es comodin y
                       -- 'FUGA_FISCAL_IVA' casaria tambien con 'FUGAXFISCALXIVA'.
                       -- `String.includes` de JS es literal.
                       AND (strpos(texto, 'FUGA_FISCAL_IVA') > 0
                         OR strpos(texto, 'FUGA FISCAL IVA') > 0
                         OR strpos(texto, 'PAGO IVA') > 0)
                      THEN abs(monto) END), 0) AS pagos_iva,
    COALESCE(SUM(CASE WHEN tipo_movimiento = 'GASTO_OPERATIVO'
                       AND (strpos(texto, 'FUGA_FISCAL_IEPS') > 0
                         OR strpos(texto, 'FUGA FISCAL IEPS') > 0
                         OR strpos(texto, 'PAGO IEPS') > 0)
                      THEN abs(monto) END), 0) AS pagos_ieps
  FROM activos
)
SELECT
  ROUND(GREATEST(0, pasivo_iva  - pagos_iva),  2) AS iva_por_pagar,
  ROUND(GREATEST(0, pasivo_ieps - pagos_ieps), 2) AS ieps_por_pagar,
  ROUND(pasivo_iva,  2)                           AS pasivo_iva_acumulado,
  ROUND(pasivo_ieps, 2)                           AS pasivo_ieps_acumulado,
  ROUND(pagos_iva,   2)                           AS pagos_iva,
  ROUND(pagos_ieps,  2)                           AS pagos_ieps,
  now()                                           AS calculado_en
FROM sumas;

COMMENT ON VIEW public.v_pasivo_fiscal IS
'Reproduce calcularPasivosFiscalesAdmin (lib/dashboard-utils.ts) con esPagoImpuestoIva / '
'esPagoImpuestoIeps (lib/finance-utils.ts). Una sola fila: es el pasivo de la matriz. '
'OJO: filtro de status ESTRICTO (status = ACTIVO, sin tolerar el legacy APPROVED que si aceptan '
'las demas lecturas del ERP): asi esta en el TypeScript y asi se copia. Los acumulados suman '
'abs(monto). Un pago de impuesto se reconoce por subcadena de texto sobre '
'categoria + categoria_gasto + descripcion, no por una bandera.';


-- ============================================================================
-- 5 · v_cartera  —  a quien visitar, cuanto tiene y cuanto debe
-- ============================================================================
-- Reproduce `construirCartera` de lib/cartera-utils.ts, que es lo que alimenta
-- /dashboard/cartera.
--
-- Reglas copiadas:
--  · Solo nodos con rol DST o LOC, y solo los que RECIBIERON mercancia
--    (`recibidas > 0`). El resto ni siquiera aparece como fila.
--  · `recibidas`: piezas de ENTRADA_CONCESION vivas con destino en el nodo.
--  · `salidas`: CUALQUIER movimiento vivo que salga del nodo — venta, merma,
--    traspaso o consignacion hacia abajo. Filtrar por tipo dejaria piezas
--    colgadas en el libro que ya no estan en el piso.
--  · Movimiento vivo = `status <> 'ANULADO'`. Las cantidades se toman en valor
--    absoluto (`Math.abs`).
--  · La deuda NO se recalcula: es la misma de
--    `calcularSaldoPendienteInventarioConsignacion`, o sea la de
--    `v_saldo_entidad`. Si esa formula cambia, esta pantalla cambia con ella.
--  · `generado = deuda + abonado`, derivado del saldo en vez de recalculado,
--    para que el porcentaje y la deuda no puedan contradecirse.
--  · `porcentaje_pagado` es NULL cuando no genero deuda: no es 0%, es "no
--    aplica", y por eso `estimado_en_piso` cae a `recibidas`.
--  · `dias_sin_abono` cuenta desde el ultimo abono; si nunca abono, desde la
--    ultima entrega. `referencia_dias` dice cual de las dos se esta midiendo.
--
-- [OJO] `construirCartera` filtra las finanzas por `status <> 'ANULADO'`,
-- mientras que el directorio y el perfil las piden con
-- `status IN ('ACTIVO','APPROVED')`. Hoy dan lo mismo porque en la base solo
-- existen ACTIVO y ANULADO, pero una fila PENDING o REJECTED entraria en la
-- cartera y no en el perfil, y el mismo nodo diria dos deudas distintas. Se
-- copia cada filtro donde estaba: la vista no arregla la diferencia, la deja
-- a la vista.
-- ============================================================================
CREATE VIEW public.v_cartera WITH (security_invoker = true) AS
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

COMMENT ON VIEW public.v_cartera IS
'Reproduce construirCartera (lib/cartera-utils.ts), lo que alimenta /dashboard/cartera: '
'recibidas, descargadas en libro, % pagado, estimado en piso, deuda y dias sin abonar, por nodo '
'DST/LOC que haya recibido mercancia. La deuda no se recalcula: es la misma de '
'calcularSaldoPendienteInventarioConsignacion (v_saldo_entidad). '
'OJO: construirCartera filtra finanzas por status <> ANULADO, mientras el directorio y el perfil '
'las piden con status IN (ACTIVO, APPROVED). Hoy coinciden porque solo existen ACTIVO y ANULADO; '
'una fila PENDING o REJECTED haria que el mismo nodo dijera dos deudas distintas.';


-- ============================================================================
-- Permisos
-- ============================================================================
-- Una vista nace con los default privileges del esquema. El paso 8
-- (20260902022000_revocar_select_anon.sql) dejo escrito que los default
-- privileges de `supabase_admin` siguen concediendole cosas a `anon` en
-- objetos NUEVOS y que `postgres` no los puede revocar. Asi que aqui se revoca
-- explicitamente, vista por vista, en vez de confiar en el default.
--
-- Con security_invoker, `anon` no sacaria ni una fila aunque tuviera el SELECT
-- (no tiene GRANT sobre las 9 tablas). Esto es la segunda reja, no la primera.
REVOKE ALL ON public.v_saldo_entidad,
              public.v_stock_por_cubeta,
              public.v_movimiento_clasificado,
              public.v_pasivo_fiscal,
              public.v_cartera
  FROM PUBLIC, anon;

GRANT SELECT ON public.v_saldo_entidad,
                public.v_stock_por_cubeta,
                public.v_movimiento_clasificado,
                public.v_pasivo_fiscal,
                public.v_cartera
  TO authenticated, service_role;


-- ============================================================================
-- COMPROBACION (no se ejecuta sola: es para copiar y pegar)
-- ============================================================================
-- 1. Que las cinco tengan security_invoker encendido de verdad:
--
--    SELECT c.relname, c.reloptions
--      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--     WHERE n.nspname = 'public' AND c.relkind = 'v'
--     ORDER BY c.relname;
--    -- las cinco deben mostrar {security_invoker=true}
--
-- 2. Que el RLS se respete de verdad, con la sesion de un DST:
--
--    BEGIN;
--    SET LOCAL ROLE authenticated;
--    SET LOCAL request.jwt.claims =
--      '{"sub":"5e33b4ae-9cfe-4e4d-becd-b6ed3f4fdbe7",
--        "email":"gfranco+fresnillo@infrasolutionsllc.com","role":"authenticated"}';
--    SELECT count(*) FROM v_saldo_entidad;            -- Gilberto: 2, no 15
--    SELECT count(*) FROM v_movimiento_clasificado;   -- Gilberto: 16, no 119
--    ROLLBACK;
--
--    Si alguna devuelve el total, la vista esta filtrando de menos y hay que
--    arreglarla antes de seguir.
-- ============================================================================


-- ============================================================================
-- NOTA DE APLICACION — este archivo es UNO, la base lo registro en DOS pasos
-- ============================================================================
-- Este archivo ya contiene la version buena y **una base nueva solo necesita
-- este archivo**. Pero la base de produccion lo registro con dos versiones:
--
--   · `vistas_canonicas`                      — el primer intento
--   · `vistas_canonicas_banderas_no_nulas`    — el arreglo, ya incorporado aqui
--
-- Que paso, porque vale la pena que quede escrito: las cuatro banderas de
-- `v_movimiento_clasificado` devolvian **NULL** —no `false`— en los movimientos
-- que tienen las DOS cuentas en NULL, porque en SQL `NULL IN (...)` es NULL y
-- `NULL OR NULL` tambien. El TypeScript devuelve `false` ahi
-- (`Boolean(x && set.has(x))`). Una bandera NULL se cuela por cualquier
-- `WHERE NOT toca_cuenta_admin` de quien consulte: falla ABIERTA.
--
-- **No lo encontro nadie leyendo: lo encontro la prueba de equivalencia**
-- (`tests/vistas-equivalencia.spec.ts`) en su primera corrida, comparando
-- bandera por bandera contra `movimientoTocaCuentaAdmin`. Es exactamente para
-- lo que existe: el SQL "se veia bien".
-- ============================================================================
