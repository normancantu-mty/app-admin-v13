-- ============================================================================
-- Los 17 indices de llave foranea que faltaban (+ 2 de fecha)
-- ============================================================================
-- POR QUE AHORA Y NO ANTES. El advisor de rendimiento de Supabase reporta 17
-- llaves foraneas sin indice. Con 468 filas de inventario y 119 de finanzas eso
-- no se nota: un escaneo secuencial de una tabla que cabe en una pagina es
-- rapido. Lo que cambio no es el tamano, es **la naturaleza del costo**:
--
--   * antes de las politicas de RLS (2026-09-02) cada lectura era un escaneo
--     simple;
--   * ahora **cada fila** pasa por una politica que hace subconsultas contra
--     `entidades` y `mis_entidades()`;
--   * y las cinco vistas canonicas del PROMPT 13 se apilan encima, uniendo
--     `finanzas_ledger` con `cuentas_financieras` y con `transacciones_tickets`.
--
-- Un join sin indice dentro de un filtro que se evalua por fila multiplica, no
-- suma. Estos indices son el piso que eso necesita.
--
-- **NO CAMBIAN NINGUNA CIFRA NI NINGUN COMPORTAMIENTO.** Un indice solo le da
-- al planificador otra forma de llegar a las mismas filas. Si una prueba falla
-- despues de crearlos, el problema es otro y hay que reportarlo, no ajustar el
-- indice. 84 activas / 468 / 61 / $386,201 quedan intactas.
--
-- NO SE DUPLICA `idx_finanzas_ledger_entidad_fecha`
-- (`finanzas_ledger(id_entidad_relacionada, fecha_movimiento DESC)`), que ya lo
-- creo 20260902030000_abono_metodo_pago_e_indice.sql.
--
-- ─── ROLLBACK ───────────────────────────────────────────────────────────────
-- Un `DROP INDEX` por cada uno; ninguno tiene dependencias ni restricciones
-- colgando. Los 19 nombres siguen el patron `idx_<tabla>_<columna>`:
--   DROP INDEX IF EXISTS public.idx_cuentas_financieras_id_entidad, ... ;
-- ============================================================================

-- ─── cuentas_financieras ────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_cuentas_financieras_id_entidad
  ON public.cuentas_financieras (id_entidad);

-- ─── entidades · el puente legacy son DOS columnas de padre, y las dos se leen
CREATE INDEX IF NOT EXISTS idx_entidades_id_padre
  ON public.entidades (id_padre);

CREATE INDEX IF NOT EXISTS idx_entidades_id_nodo_padre
  ON public.entidades (id_nodo_padre);

-- ─── finanzas_ledger ────────────────────────────────────────────────────────
-- Las dos cuentas son justo por donde entra el Account_Firewall.
CREATE INDEX IF NOT EXISTS idx_finanzas_ledger_id_cuenta_origen
  ON public.finanzas_ledger (id_cuenta_origen);

CREATE INDEX IF NOT EXISTS idx_finanzas_ledger_id_cuenta_destino
  ON public.finanzas_ledger (id_cuenta_destino);

-- Por aqui borra la cascada de anulacion (`.eq('id_ticket', ...)`).
CREATE INDEX IF NOT EXISTS idx_finanzas_ledger_id_ticket
  ON public.finanzas_ledger (id_ticket);

-- ─── inventario_ledger ──────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_inventario_ledger_id_producto
  ON public.inventario_ledger (id_producto);

CREATE INDEX IF NOT EXISTS idx_inventario_ledger_id_entidad_origen
  ON public.inventario_ledger (id_entidad_origen);

CREATE INDEX IF NOT EXISTS idx_inventario_ledger_id_entidad_destino
  ON public.inventario_ledger (id_entidad_destino);

-- ─── listas_precios ─────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_listas_precios_id_producto
  ON public.listas_precios (id_producto);

-- ─── recetas_produccion (el BOM) ────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_recetas_produccion_id_producto_terminado
  ON public.recetas_produccion (id_producto_terminado);

CREATE INDEX IF NOT EXISTS idx_recetas_produccion_id_insumo
  ON public.recetas_produccion (id_insumo);

-- ─── ticket_detalles ────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_ticket_detalles_id_ticket
  ON public.ticket_detalles (id_ticket);

CREATE INDEX IF NOT EXISTS idx_ticket_detalles_id_producto
  ON public.ticket_detalles (id_producto);

-- ─── transacciones_tickets ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_transacciones_tickets_id_vendedor
  ON public.transacciones_tickets (id_vendedor);

CREATE INDEX IF NOT EXISTS idx_transacciones_tickets_id_comprador
  ON public.transacciones_tickets (id_comprador);

CREATE INDEX IF NOT EXISTS idx_transacciones_tickets_id_cuenta_destino
  ON public.transacciones_tickets (id_cuenta_destino);

-- ─── LOS DOS DE FECHA, QUE NO SON LLAVE FORANEA ─────────────────────────────
-- **Todas** las pantallas filtran por rango de fecha (el filtro global vive en
-- una cookie y lo lee cada Server Component) y no habia un solo indice para
-- eso. `finanzas_ledger` ya lo tiene dentro del compuesto del prompt 4; estas
-- dos tablas no tenian nada.
CREATE INDEX IF NOT EXISTS idx_inventario_ledger_fecha_movimiento
  ON public.inventario_ledger (fecha_movimiento DESC);

CREATE INDEX IF NOT EXISTS idx_transacciones_tickets_fecha_transaccion
  ON public.transacciones_tickets (fecha_transaccion DESC);
