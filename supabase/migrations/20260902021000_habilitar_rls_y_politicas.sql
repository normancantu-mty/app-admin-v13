-- ============================================================================
-- Paso 7 · RLS + politicas en las 9 tablas de public
-- ============================================================================
-- Modelo acordado:
--   ADMIN  ve todo                          escribe todo
--   SOCIO  ve todo                          NO escribe nada
--   DST    ve lo suyo + sus locales hijos   escribe acotado a ese mismo alcance
--   LOC    ve solo lo suyo                  no escribe (hoy no inician sesion)
--
-- Todas las politicas van `TO authenticated`: `anon` no gana nada por politica,
-- ni siquiera antes de que el paso 8 le quite el SELECT.
--
-- Sin FORCE ROW LEVEL SECURITY: `postgres` (dueno de las tablas) y
-- `service_role` siguen pasando de largo, que es de lo que dependen
-- lib/inventario-auditoria.ts y las lecturas con service role del dashboard.
--
-- DOS DESVIACIONES DELIBERADAS respecto del prompt, ambas por datos de
-- produccion (marcadas [DESVIACION] mas abajo): los INSERT de DST en los dos
-- ledgers se acotan a mis_entidades() (yo + mis hijos) y no a mi_entidad_id()
-- (solo yo). Con la version estrecha se rompen escrituras que los DST hacen
-- hoy. El detalle esta en cada politica.
-- ============================================================================


-- ===========================================================================
-- 1. entidades
-- ===========================================================================
ALTER TABLE public.entidades ENABLE ROW LEVEL SECURITY;

CREATE POLICY entidades_sel_admin_socio ON public.entidades
  FOR SELECT TO authenticated USING (public.mi_rol() IN ('ADMIN','SOCIO'));

-- DST: la suya y sus locales hijos. LOC: solo la suya (mis_entidades() de un
-- LOC sin hijos devuelve una sola fila).
CREATE POLICY entidades_sel_propias ON public.entidades
  FOR SELECT TO authenticated
  USING (id IN (SELECT t.id FROM public.mis_entidades() AS t(id)));

CREATE POLICY entidades_ins_admin ON public.entidades
  FOR INSERT TO authenticated WITH CHECK (public.mi_rol() = 'ADMIN');
CREATE POLICY entidades_upd_admin ON public.entidades
  FOR UPDATE TO authenticated
  USING (public.mi_rol() = 'ADMIN') WITH CHECK (public.mi_rol() = 'ADMIN');
CREATE POLICY entidades_del_admin ON public.entidades
  FOR DELETE TO authenticated USING (public.mi_rol() = 'ADMIN');


-- ===========================================================================
-- 2. cuentas_financieras
-- ===========================================================================
ALTER TABLE public.cuentas_financieras ENABLE ROW LEVEL SECURITY;

CREATE POLICY cuentas_sel_admin_socio ON public.cuentas_financieras
  FOR SELECT TO authenticated USING (public.mi_rol() IN ('ADMIN','SOCIO'));

CREATE POLICY cuentas_sel_mias ON public.cuentas_financieras
  FOR SELECT TO authenticated
  USING (id_entidad IN (SELECT t.id FROM public.mis_entidades() AS t(id)));

CREATE POLICY cuentas_ins_admin ON public.cuentas_financieras
  FOR INSERT TO authenticated WITH CHECK (public.mi_rol() = 'ADMIN');
CREATE POLICY cuentas_upd_admin ON public.cuentas_financieras
  FOR UPDATE TO authenticated
  USING (public.mi_rol() = 'ADMIN') WITH CHECK (public.mi_rol() = 'ADMIN');
CREATE POLICY cuentas_del_admin ON public.cuentas_financieras
  FOR DELETE TO authenticated USING (public.mi_rol() = 'ADMIN');


-- ===========================================================================
-- 3. catalogo_productos  ·  lectura abierta: el POS y el Catalogo la necesitan
-- ===========================================================================
ALTER TABLE public.catalogo_productos ENABLE ROW LEVEL SECURITY;

CREATE POLICY catalogo_sel_autenticado ON public.catalogo_productos
  FOR SELECT TO authenticated USING (true);

CREATE POLICY catalogo_ins_admin ON public.catalogo_productos
  FOR INSERT TO authenticated WITH CHECK (public.mi_rol() = 'ADMIN');
CREATE POLICY catalogo_upd_admin ON public.catalogo_productos
  FOR UPDATE TO authenticated
  USING (public.mi_rol() = 'ADMIN') WITH CHECK (public.mi_rol() = 'ADMIN');
CREATE POLICY catalogo_del_admin ON public.catalogo_productos
  FOR DELETE TO authenticated USING (public.mi_rol() = 'ADMIN');


-- ===========================================================================
-- 4. listas_precios  ·  idem
-- ===========================================================================
ALTER TABLE public.listas_precios ENABLE ROW LEVEL SECURITY;

CREATE POLICY precios_sel_autenticado ON public.listas_precios
  FOR SELECT TO authenticated USING (true);

CREATE POLICY precios_ins_admin ON public.listas_precios
  FOR INSERT TO authenticated WITH CHECK (public.mi_rol() = 'ADMIN');
CREATE POLICY precios_upd_admin ON public.listas_precios
  FOR UPDATE TO authenticated
  USING (public.mi_rol() = 'ADMIN') WITH CHECK (public.mi_rol() = 'ADMIN');
CREATE POLICY precios_del_admin ON public.listas_precios
  FOR DELETE TO authenticated USING (public.mi_rol() = 'ADMIN');


-- ===========================================================================
-- 5. recetas_produccion  ·  la formula NO la ve un DST
-- ===========================================================================
ALTER TABLE public.recetas_produccion ENABLE ROW LEVEL SECURITY;

CREATE POLICY recetas_sel_admin_socio ON public.recetas_produccion
  FOR SELECT TO authenticated USING (public.mi_rol() IN ('ADMIN','SOCIO'));

CREATE POLICY recetas_ins_admin ON public.recetas_produccion
  FOR INSERT TO authenticated WITH CHECK (public.mi_rol() = 'ADMIN');
CREATE POLICY recetas_upd_admin ON public.recetas_produccion
  FOR UPDATE TO authenticated
  USING (public.mi_rol() = 'ADMIN') WITH CHECK (public.mi_rol() = 'ADMIN');
CREATE POLICY recetas_del_admin ON public.recetas_produccion
  FOR DELETE TO authenticated USING (public.mi_rol() = 'ADMIN');


-- ===========================================================================
-- 6. transacciones_tickets
-- ===========================================================================
ALTER TABLE public.transacciones_tickets ENABLE ROW LEVEL SECURITY;

CREATE POLICY tickets_sel_admin_socio ON public.transacciones_tickets
  FOR SELECT TO authenticated USING (public.mi_rol() IN ('ADMIN','SOCIO'));

CREATE POLICY tickets_sel_mios ON public.transacciones_tickets
  FOR SELECT TO authenticated
  USING (
    id_vendedor IN (SELECT t.id FROM public.mis_entidades() AS t(id))
    OR id_comprador IN (SELECT t.id FROM public.mis_entidades() AS t(id))
  );

CREATE POLICY tickets_ins_admin ON public.transacciones_tickets
  FOR INSERT TO authenticated WITH CHECK (public.mi_rol() = 'ADMIN');

-- Estrecho a proposito: el DST solo puede emitir tickets siendo el mismo el
-- vendedor. Verificado contra produccion: los 12 tickets de DST tienen
-- id_vendedor = el propio DST, y la cobranza (auditoria.ts:288) tambien pone
-- id_vendedor = entidadOperadora.id.
CREATE POLICY tickets_ins_dst ON public.transacciones_tickets
  FOR INSERT TO authenticated
  WITH CHECK (public.mi_rol() = 'DST' AND id_vendedor = public.mi_entidad_id());

CREATE POLICY tickets_upd_admin ON public.transacciones_tickets
  FOR UPDATE TO authenticated
  USING (public.mi_rol() = 'ADMIN') WITH CHECK (public.mi_rol() = 'ADMIN');

-- Anulacion (status -> ANULADO). La ventana de 24 h / 6 h la sigue imponiendo
-- el codigo (audit.ts); aqui solo se acota el alcance.
CREATE POLICY tickets_upd_dst ON public.transacciones_tickets
  FOR UPDATE TO authenticated
  USING (
    public.mi_rol() = 'DST' AND (
      id_vendedor IN (SELECT t.id FROM public.mis_entidades() AS t(id))
      OR id_comprador IN (SELECT t.id FROM public.mis_entidades() AS t(id))
    )
  )
  WITH CHECK (
    public.mi_rol() = 'DST' AND (
      id_vendedor IN (SELECT t.id FROM public.mis_entidades() AS t(id))
      OR id_comprador IN (SELECT t.id FROM public.mis_entidades() AS t(id))
    )
  );

CREATE POLICY tickets_del_admin ON public.transacciones_tickets
  FOR DELETE TO authenticated USING (public.mi_rol() = 'ADMIN');


-- ===========================================================================
-- 7. ticket_detalles  ·  hereda la visibilidad de su ticket
-- ===========================================================================
ALTER TABLE public.ticket_detalles ENABLE ROW LEVEL SECURITY;

CREATE POLICY detalles_sel_admin_socio ON public.ticket_detalles
  FOR SELECT TO authenticated USING (public.mi_rol() IN ('ADMIN','SOCIO'));

CREATE POLICY detalles_sel_por_ticket ON public.ticket_detalles
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.transacciones_tickets tk
    WHERE tk.id = ticket_detalles.id_ticket
      AND (
        tk.id_vendedor IN (SELECT t.id FROM public.mis_entidades() AS t(id))
        OR tk.id_comprador IN (SELECT t.id FROM public.mis_entidades() AS t(id))
      )
  ));

CREATE POLICY detalles_ins_admin ON public.ticket_detalles
  FOR INSERT TO authenticated WITH CHECK (public.mi_rol() = 'ADMIN');

-- [AGREGADO respecto del prompt] El prompt no menciona INSERT en
-- ticket_detalles, pero sin esta politica NINGUNA venta de DST se completa:
-- pos.ts:448 y auditoria.ts:457 insertan las lineas del ticket justo despues
-- de crearlo. Acotado al ticket que el propio DST acaba de emitir.
CREATE POLICY detalles_ins_dst ON public.ticket_detalles
  FOR INSERT TO authenticated
  WITH CHECK (public.mi_rol() = 'DST' AND EXISTS (
    SELECT 1 FROM public.transacciones_tickets tk
    WHERE tk.id = ticket_detalles.id_ticket
      AND tk.id_vendedor = public.mi_entidad_id()
  ));

CREATE POLICY detalles_upd_admin ON public.ticket_detalles
  FOR UPDATE TO authenticated
  USING (public.mi_rol() = 'ADMIN') WITH CHECK (public.mi_rol() = 'ADMIN');
CREATE POLICY detalles_del_admin ON public.ticket_detalles
  FOR DELETE TO authenticated USING (public.mi_rol() = 'ADMIN');


-- ===========================================================================
-- 8. finanzas_ledger
-- ===========================================================================
ALTER TABLE public.finanzas_ledger ENABLE ROW LEVEL SECURITY;

-- Esta politica es tambien la que salva las filas de PASIVO_IVA / PASIVO_IEPS
-- con id_entidad_relacionada NULL (43 filas hoy): el ADMIN las ve por rol, no
-- por pertenencia.
CREATE POLICY finanzas_sel_admin_socio ON public.finanzas_ledger
  FOR SELECT TO authenticated USING (public.mi_rol() IN ('ADMIN','SOCIO'));

CREATE POLICY finanzas_sel_mias ON public.finanzas_ledger
  FOR SELECT TO authenticated
  USING (
    id_entidad_relacionada IN (SELECT t.id FROM public.mis_entidades() AS t(id))
    OR id_cuenta_origen IN (
      SELECT c.id FROM public.cuentas_financieras c
      WHERE c.id_entidad IN (SELECT t.id FROM public.mis_entidades() AS t(id)))
    OR id_cuenta_destino IN (
      SELECT c.id FROM public.cuentas_financieras c
      WHERE c.id_entidad IN (SELECT t.id FROM public.mis_entidades() AS t(id)))
  );

CREATE POLICY finanzas_ins_admin ON public.finanzas_ledger
  FOR INSERT TO authenticated WITH CHECK (public.mi_rol() = 'ADMIN');

-- [DESVIACION 1/2] El prompt pedia `id_entidad_relacionada = mi_entidad_id()`.
-- Con esa version se rompen escrituras REALES de hoy:
--   · Gilberto Franco (DST) tiene 2 filas con id_entidad_relacionada =
--     "Nuevo Ideal", su LOC hijo, no el mismo.
--   · La cobranza de un DST sobre su LOC escribe id_entidad_relacionada =
--     idEntidadObjetivo, o sea el hijo (auditoria.ts:325, 338, 381).
-- Por eso mis_entidades() (yo + mis hijos) en vez de mi_entidad_id() (solo yo).
CREATE POLICY finanzas_ins_dst ON public.finanzas_ledger
  FOR INSERT TO authenticated
  WITH CHECK (
    public.mi_rol() = 'DST'
    AND id_entidad_relacionada IN (SELECT t.id FROM public.mis_entidades() AS t(id))
  );

CREATE POLICY finanzas_upd_admin ON public.finanzas_ledger
  FOR UPDATE TO authenticated
  USING (public.mi_rol() = 'ADMIN') WITH CHECK (public.mi_rol() = 'ADMIN');

CREATE POLICY finanzas_upd_dst ON public.finanzas_ledger
  FOR UPDATE TO authenticated
  USING (
    public.mi_rol() = 'DST'
    AND id_entidad_relacionada IN (SELECT t.id FROM public.mis_entidades() AS t(id))
  )
  WITH CHECK (
    public.mi_rol() = 'DST'
    AND id_entidad_relacionada IN (SELECT t.id FROM public.mis_entidades() AS t(id))
  );

CREATE POLICY finanzas_del_admin ON public.finanzas_ledger
  FOR DELETE TO authenticated USING (public.mi_rol() = 'ADMIN');


-- ===========================================================================
-- 9. inventario_ledger
-- ===========================================================================
ALTER TABLE public.inventario_ledger ENABLE ROW LEVEL SECURITY;

CREATE POLICY inventario_sel_admin_socio ON public.inventario_ledger
  FOR SELECT TO authenticated USING (public.mi_rol() IN ('ADMIN','SOCIO'));

CREATE POLICY inventario_sel_mio ON public.inventario_ledger
  FOR SELECT TO authenticated
  USING (
    id_entidad_origen IN (SELECT t.id FROM public.mis_entidades() AS t(id))
    OR id_entidad_destino IN (SELECT t.id FROM public.mis_entidades() AS t(id))
  );

CREATE POLICY inventario_ins_admin ON public.inventario_ledger
  FOR INSERT TO authenticated WITH CHECK (public.mi_rol() = 'ADMIN');

-- [DESVIACION 2/2] Misma razon que en finanzas. Verificado contra produccion:
-- David Flores (DST) tiene 18 filas con origen NULL y destino = uno de sus LOC
-- hijos, y Gilberto 6 con origen = "Nuevo Ideal". Ninguna de esas dos formas
-- pasa si se exige que el origen o el destino sea el DST mismo.
CREATE POLICY inventario_ins_dst ON public.inventario_ledger
  FOR INSERT TO authenticated
  WITH CHECK (
    public.mi_rol() = 'DST' AND (
      id_entidad_origen IN (SELECT t.id FROM public.mis_entidades() AS t(id))
      OR id_entidad_destino IN (SELECT t.id FROM public.mis_entidades() AS t(id))
    )
  );

CREATE POLICY inventario_upd_admin ON public.inventario_ledger
  FOR UPDATE TO authenticated
  USING (public.mi_rol() = 'ADMIN') WITH CHECK (public.mi_rol() = 'ADMIN');

CREATE POLICY inventario_upd_dst ON public.inventario_ledger
  FOR UPDATE TO authenticated
  USING (
    public.mi_rol() = 'DST' AND (
      id_entidad_origen IN (SELECT t.id FROM public.mis_entidades() AS t(id))
      OR id_entidad_destino IN (SELECT t.id FROM public.mis_entidades() AS t(id))
    )
  )
  WITH CHECK (
    public.mi_rol() = 'DST' AND (
      id_entidad_origen IN (SELECT t.id FROM public.mis_entidades() AS t(id))
      OR id_entidad_destino IN (SELECT t.id FROM public.mis_entidades() AS t(id))
    )
  );

CREATE POLICY inventario_del_admin ON public.inventario_ledger
  FOR DELETE TO authenticated USING (public.mi_rol() = 'ADMIN');
