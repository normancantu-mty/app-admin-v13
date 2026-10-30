-- ============================================================================
-- ROLLBACK del corte ERP v2 (deshace las 6 migraciones v2 y vacia los datos v2)
-- Escrito el 2026-10-30 por el Socio (ejecutor A2), rama v2-arranque-limpio.
-- ============================================================================
-- NO trae BEGIN/COMMIT a proposito: lo envuelve scripts/corte_rollback.py en UNA transaccion
-- junto con la recarga de las tablas desde el volcado del respaldo y la verificacion de
-- conteos y md5. Correrlo suelto deja las tablas del ERP VACIAS.
--
-- Orden (borrador del plan de corte, seccion 8.3):
--   1. lo que solo existe en v2 y depende de lo demas (vista, RPC, tablas nuevas);
--   2. vaciar las 25 tablas que el corte toco, en orden de llaves foraneas (el CHECK de 15 tipos
--      no se puede reponer mientras haya filas SALDO_INICIAL);
--   3. revertir la migracion 120100 (trigger, funciones, indice, columnas, CHECK original);
--   4. revertir las vistas de 20261029120000 y 20261029120100 a su definicion anterior;
--   5. borrar las 6 filas de supabase_migrations.schema_migrations.
-- 20261028120000 (GRANT a service_role sobre agente) NO se revierte: en produccion ese permiso ya
-- existia antes del corte (se dio a mano; ver la migracion), asi que revertirlo romperia al bot.
-- El parametro comision_conversion_transferencias_pct sale solo: parametros_costo se vacia y se
-- recarga del volcado, que es de antes del corte.
-- Definiciones originales: pg_get_constraintdef / pg_get_viewdef de la copia restaurada del
-- respaldo 2026-10-30 de produccion, ANTES de aplicar el corte.
-- ============================================================================

-- 1. objetos que solo existen en v2
DROP VIEW IF EXISTS public.v_transferencias_resumen;
DROP FUNCTION IF EXISTS public.convertir_transferencias(numeric, text, timestamptz);
DROP TABLE IF EXISTS public.conversiones_transferencia;
DROP TABLE IF EXISTS public.categorias_movimiento;

-- 2. vaciar las tablas del corte (hijas primero)

DELETE FROM public.avisos_captura;
DELETE FROM public.bot_borradores;
DELETE FROM public.cotizacion_detalles;
DELETE FROM public.cotizaciones;
DELETE FROM public.finanzas_ledger;
DELETE FROM public.ticket_detalles;
DELETE FROM public.transacciones_tickets;
DELETE FROM public.inventario_ledger;
DELETE FROM public.conteo_detalles;
DELETE FROM public.conteos_fisicos;
DELETE FROM public.lote_recordatorios;
DELETE FROM public.lote_etapas;
DELETE FROM public.lote_envasado;
DELETE FROM public.lote_salidas;
DELETE FROM public.lote_entradas;
DELETE FROM public.lotes;
DELETE FROM public.bot_identidades;
DELETE FROM public.listas_precios;
DELETE FROM public.recetas_produccion;
DELETE FROM public.receta_liquido_estandar;
DELETE FROM public.cuentas_financieras;
DELETE FROM public.entidades;
DELETE FROM public.catalogo_productos;
DELETE FROM public.parametros_costo;
DELETE FROM public.bot_categorias;

-- 3. revertir 20261028120100_v2_cuentas_clase_y_saldo_inicial
DROP TRIGGER IF EXISTS trg_cuenta_solo_egresos ON public.finanzas_ledger;
DROP FUNCTION IF EXISTS public.tg_cuenta_solo_egresos();
DROP FUNCTION IF EXISTS public.saldo_cuenta(uuid);
DROP INDEX IF EXISTS public.uq_cuentas_financieras_entidad_clase;
ALTER TABLE public.cuentas_financieras DROP CONSTRAINT IF EXISTS cuentas_financieras_clase_check;
ALTER TABLE public.cuentas_financieras DROP COLUMN IF EXISTS clase, DROP COLUMN IF EXISTS solo_egresos;
ALTER TABLE public.finanzas_ledger DROP CONSTRAINT IF EXISTS finanzas_ledger_tipo_movimiento_check;
ALTER TABLE public.finanzas_ledger ADD CONSTRAINT finanzas_ledger_tipo_movimiento_check
  CHECK (((tipo_movimiento)::text = ANY (ARRAY[('INGRESO_VENTA'::character varying)::text, ('GASTO_OPERATIVO'::character varying)::text, ('ABONO_DEUDA'::character varying)::text, ('INGRESO_COMISION'::character varying)::text, ('DEUDA_A_MATRIZ'::character varying)::text, ('COMISION_PASIVA'::character varying)::text, ('PASIVO_IVA'::character varying)::text, ('PASIVO_IEPS'::character varying)::text, ('EGRESO_TRASPASO'::character varying)::text, ('INGRESO_TRASPASO'::character varying)::text, ('SUBSIDIO_FISCAL'::character varying)::text, ('CARGO_DEUDA'::character varying)::text, ('COMPRA_INSUMOS'::character varying)::text, ('MERMA'::character varying)::text, ('DEVOLUCION'::character varying)::text])));

-- 4. vistas: definicion de antes del corte
-- v_cartera perdio una columna (id_acreedor): CREATE OR REPLACE no puede quitarla, se recrea.
-- Ninguna vista depende de v_cartera (pg_depend en la copia).
DROP VIEW IF EXISTS public.v_cartera;
CREATE VIEW public.v_cartera WITH (security_invoker = true) AS
 WITH inventario_vivo AS (
         SELECT il.tipo_movimiento,
            abs(il.cantidad) AS cantidad,
            il.id_entidad_origen,
            il.id_entidad_destino,
            il.fecha_movimiento
           FROM inventario_ledger il
          WHERE COALESCE(il.status, 'ACTIVO'::text) <> 'ANULADO'::text
        ), piso AS (
         SELECT e.id AS id_entidad,
            COALESCE(sum(
                CASE
                    WHEN iv.id_entidad_destino = e.id AND iv.tipo_movimiento::text = 'ENTRADA_CONCESION'::text THEN iv.cantidad
                    ELSE 0::numeric
                END), 0::numeric) AS recibidas,
            COALESCE(sum(
                CASE
                    WHEN iv.id_entidad_origen = e.id THEN iv.cantidad
                    ELSE 0::numeric
                END), 0::numeric) AS salidas,
            max(
                CASE
                    WHEN iv.id_entidad_destino = e.id AND iv.tipo_movimiento::text = 'ENTRADA_CONCESION'::text THEN iv.fecha_movimiento
                    ELSE NULL::timestamp with time zone
                END) AS ultima_entrega
           FROM entidades e
             LEFT JOIN inventario_vivo iv ON iv.id_entidad_destino = e.id OR iv.id_entidad_origen = e.id
          WHERE e.rol::text = ANY (ARRAY['DST'::character varying::text, 'LOC'::character varying::text])
          GROUP BY e.id
        ), finanzas_cartera AS (
         SELECT fl.id_entidad_relacionada,
            fl.tipo_movimiento,
            fl.monto,
            fl.categoria,
            fl.fecha_movimiento
           FROM finanzas_ledger fl
          WHERE COALESCE(fl.status, 'ACTIVO'::text) <> 'ANULADO'::text AND NOT fl.es_entrega_efectivo
        ), deuda_tickets AS (
         SELECT tk.id_comprador AS id_entidad,
            sum(
                CASE
                    WHEN e.rol::text = 'DST'::text THEN tk.monto_base_ingreso
                    ELSE tk.total_cobrado_real
                END) AS monto
           FROM transacciones_tickets tk
             JOIN entidades e ON e.id = tk.id_comprador
          WHERE COALESCE(tk.status, 'ACTIVO'::character varying)::text <> 'ANULADO'::text AND tk.condicion_pago = 'CONCESION'::text
          GROUP BY tk.id_comprador
        ), ajustes AS (
         SELECT f.id_entidad_relacionada AS id_entidad,
            sum(
                CASE
                    WHEN f.tipo_movimiento::text = 'CARGO_DEUDA'::text THEN f.monto
                    ELSE 0::numeric
                END) AS cargo_deuda,
            sum(
                CASE
                    WHEN f.tipo_movimiento::text = 'ABONO_DEUDA'::text AND f.categoria::text IS DISTINCT FROM 'ABONO_PENDIENTE'::text THEN f.monto
                    ELSE 0::numeric
                END) AS abonado,
            max(
                CASE
                    WHEN f.tipo_movimiento::text = 'ABONO_DEUDA'::text AND f.categoria::text IS DISTINCT FROM 'ABONO_PENDIENTE'::text THEN f.fecha_movimiento
                    ELSE NULL::timestamp with time zone
                END) AS ultimo_abono
           FROM finanzas_cartera f
          WHERE f.id_entidad_relacionada IS NOT NULL
          GROUP BY f.id_entidad_relacionada
        ), base AS (
         SELECT e.id AS id_entidad,
            e.nombre,
            e.rol,
            p.recibidas,
            p.salidas,
            p.ultima_entrega,
            COALESCE(dt.monto, 0::numeric) + COALESCE(aj.cargo_deuda, 0::numeric) - COALESCE(aj.abonado, 0::numeric) AS deuda,
            COALESCE(aj.abonado, 0::numeric) AS abonado,
            aj.ultimo_abono
           FROM entidades e
             JOIN piso p ON p.id_entidad = e.id
             LEFT JOIN deuda_tickets dt ON dt.id_entidad = e.id
             LEFT JOIN ajustes aj ON aj.id_entidad = e.id
          WHERE (e.rol::text = ANY (ARRAY['DST'::character varying::text, 'LOC'::character varying::text])) AND p.recibidas > 0::numeric
        ), calculada AS (
         SELECT b.id_entidad,
            b.nombre,
            b.rol,
            b.recibidas,
            b.salidas,
            b.ultima_entrega,
            b.deuda,
            b.abonado,
            b.ultimo_abono,
            b.deuda + b.abonado AS generado,
                CASE
                    WHEN (b.deuda + b.abonado) > 0::numeric THEN b.abonado / (b.deuda + b.abonado)
                    ELSE NULL::numeric
                END AS porcentaje_pagado,
            COALESCE(b.ultimo_abono, b.ultima_entrega) AS referencia_fecha,
                CASE
                    WHEN b.ultimo_abono IS NOT NULL THEN 'ABONO'::text
                    WHEN b.ultima_entrega IS NOT NULL THEN 'ENTREGA'::text
                    ELSE 'NINGUNA'::text
                END AS referencia_dias
           FROM base b
        ), con_dias AS (
         SELECT c.id_entidad,
            c.nombre,
            c.rol,
            c.recibidas,
            c.salidas,
            c.ultima_entrega,
            c.deuda,
            c.abonado,
            c.ultimo_abono,
            c.generado,
            c.porcentaje_pagado,
            c.referencia_fecha,
            c.referencia_dias,
                CASE
                    WHEN c.referencia_fecha IS NULL THEN NULL::integer
                    ELSE GREATEST(0, (now() AT TIME ZONE 'America/Mexico_City'::text)::date - (c.referencia_fecha AT TIME ZONE 'America/Mexico_City'::text)::date)
                END AS dias_sin_abono
           FROM calculada c
        )
 SELECT id_entidad,
    nombre,
    rol,
    recibidas,
    salidas,
    recibidas - salidas AS libro_dice,
    round(generado, 2) AS generado,
    round(abonado, 2) AS abonado,
    porcentaje_pagado,
        CASE
            WHEN porcentaje_pagado IS NULL THEN recibidas
            ELSE GREATEST(0::numeric, round(recibidas * (1::numeric - porcentaje_pagado)))
        END AS estimado_en_piso,
    round(deuda, 2) AS deuda,
    ultimo_abono,
    dias_sin_abono,
    referencia_dias,
        CASE
            WHEN deuda > 0::numeric THEN round(deuda * COALESCE(dias_sin_abono, 0)::numeric, 2)
            ELSE 0::numeric
        END AS prioridad,
    now() AS calculado_en
   FROM con_dias;
-- En Supabase los privilegios por default de public dan permisos a anon al crear: se quitan,
-- como estaban (relacl original: postgres, authenticated y service_role, sin anon).
REVOKE ALL ON public.v_cartera FROM PUBLIC, anon;
GRANT ALL ON public.v_cartera TO authenticated, service_role;
-- El DROP se lleva el comentario de la vista (lo detecto el ensayo: pg_dump -s antes/despues).
COMMENT ON VIEW "public"."v_cartera" IS 'Reproduce construirCartera (lib/cartera-utils.ts), lo que alimenta /dashboard/cartera: recibidas, descargadas en libro, % pagado, estimado en piso, deuda y dias sin abonar, por nodo DST/LOC que haya recibido mercancia. La deuda no se recalcula: es la misma de calcularSaldoPendienteInventarioConsignacion (v_saldo_entidad). OJO: construirCartera filtra finanzas por status <> ANULADO, mientras el directorio y el perfil las piden con status IN (ACTIVO, APPROVED). Hoy coinciden porque solo existen ACTIVO y ANULADO; una fila PENDING o REJECTED haria que el mismo nodo dijera dos deudas distintas.';

CREATE OR REPLACE VIEW public.v_stock_por_cubeta WITH (security_invoker = true) AS
 WITH movimientos AS (
         SELECT e.id AS id_entidad,
            e.nombre AS entidad,
            il.id_producto,
                CASE
                    WHEN il.cubeta = 'CONSIGNADO'::text THEN 'CONSIGNADO'::text
                    ELSE 'PAGADO'::text
                END AS cubeta,
                CASE
                    WHEN il.id_entidad_destino = e.id AND (il.tipo_movimiento::text = ANY (ARRAY['ENTRADA_COMPRA'::text, 'PRODUCCION'::text, 'DEVOLUCION_FISICA'::text, 'INGRESO_TRASPASO'::text, 'ENTRADA_CONCESION'::text])) THEN il.cantidad
                    WHEN il.id_entidad_origen = e.id AND (il.tipo_movimiento::text = ANY (ARRAY['SALIDA_VENTA'::text, 'MERMA'::text, 'TRASPASO'::text, 'EGRESO_TRASPASO'::text, 'SALIDA_CONCESION'::text, 'DEVOLUCION_FISICA'::text])) THEN - il.cantidad
                    ELSE 0::numeric
                END AS delta
           FROM inventario_ledger il
             JOIN entidades e ON e.id = il.id_entidad_destino OR e.id = il.id_entidad_origen
          WHERE il.status = ANY (ARRAY['ACTIVO'::text, 'APPROVED'::text])
        )
 SELECT m.id_entidad,
    m.entidad,
    m.id_producto,
    p.nombre AS producto,
    m.cubeta,
    round(sum(m.delta), 4) AS stock
   FROM movimientos m
     JOIN catalogo_productos p ON p.id = m.id_producto
  WHERE p.tipo::text = 'TERMINADO'::text
  GROUP BY m.id_entidad, m.entidad, m.id_producto, p.nombre, m.cubeta
 HAVING round(sum(m.delta), 4) > 0::numeric;

-- 5. el registro de migraciones
DELETE FROM supabase_migrations.schema_migrations
 WHERE version IN ('20261028120000', '20261028120100', '20261028120200', '20261028120300',
                   '20261029120000', '20261029120100');
