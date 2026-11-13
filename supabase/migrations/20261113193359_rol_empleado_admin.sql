-- rol_empleado_admin (2026-11-13) · plan aprobado por Cris, opcion (a)
-- Plan: IA/ERP/DESDE_CUARTEL_rol_empleado_admin_2026-11-13.md
-- Reversa: supabase/ROLLBACK_rol_empleado_admin_2026-11-13.sql
--
-- El empleado administrativo es una fila en `accesos` (rol EMPLEADO_ADMIN,
-- id_entidad = la matriz). mi_rol()/mi_entidad_id() ya leen `accesos` primero,
-- asi que opera COMO la matriz sin crear entidad ni cuentas.
--
-- Diseno: NO se toca ninguna politica existente. Se AGREGAN politicas
-- permisivas `*_empleado` (mi_rol() = 'EMPLEADO_ADMIN') solo para lo que usa
-- la app movil «Registro ERP». Quitar el rol = borrar esas politicas.
--
-- Opcion (a): la base le deja leer/escribir finanzas (Gastos, Ingresos,
-- Traspasos y Compra de insumo en la app). «Sin finanzas en el ERP web» es
-- restriccion de pantallas y guards de servidor, no de datos.
--
-- Lo que sigue SOLO ADMIN (sin politica de empleado): ajustes de inventario y
-- de saldo (tg_ajuste_solo_admin), editar/borrar ledger fuera de la ventana de
-- 12 h (tg_vigilar_update_no_admin lo trata como no-ADMIN), catalogo, recetas,
-- precios, entidades (escritura), cuentas (escritura), tickets (escritura),
-- cotizaciones, conteos, suscripciones, comprobantes, bitacora, alta de usuarios.

-- 1. accesos: rol nuevo + permiso de finanzas (lo lee el ERP web) -------------
ALTER TABLE public.accesos DROP CONSTRAINT accesos_rol_check;
ALTER TABLE public.accesos ADD CONSTRAINT accesos_rol_check
  CHECK (rol = ANY (ARRAY['ADMIN'::text, 'SOCIO'::text, 'EMPLEADO_ADMIN'::text]));
ALTER TABLE public.accesos ADD COLUMN permiso_finanzas boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.accesos.permiso_finanzas IS
  'Solo EMPLEADO_ADMIN: true = ve finanzas en el ERP web. La base no lo aplica (opcion a, 2026-11-13).';

-- 2. Lectura (lo que la app consulta, incluido Historial y lo que leen las RPC
--    SECURITY INVOKER: recetas, stock en inventario_ledger, entidad matriz) ---
CREATE POLICY lotes_sel_empleado              ON public.lotes                 FOR SELECT TO authenticated USING (public.mi_rol() = 'EMPLEADO_ADMIN');
CREATE POLICY lote_entradas_sel_empleado      ON public.lote_entradas         FOR SELECT TO authenticated USING (public.mi_rol() = 'EMPLEADO_ADMIN');
CREATE POLICY lote_salidas_sel_empleado       ON public.lote_salidas          FOR SELECT TO authenticated USING (public.mi_rol() = 'EMPLEADO_ADMIN');
CREATE POLICY lote_etapas_sel_empleado        ON public.lote_etapas           FOR SELECT TO authenticated USING (public.mi_rol() = 'EMPLEADO_ADMIN');
CREATE POLICY lote_envasado_sel_empleado      ON public.lote_envasado         FOR SELECT TO authenticated USING (public.mi_rol() = 'EMPLEADO_ADMIN');
CREATE POLICY inventario_sel_empleado         ON public.inventario_ledger     FOR SELECT TO authenticated USING (public.mi_rol() = 'EMPLEADO_ADMIN');
CREATE POLICY finanzas_sel_empleado           ON public.finanzas_ledger       FOR SELECT TO authenticated USING (public.mi_rol() = 'EMPLEADO_ADMIN');
CREATE POLICY cuentas_sel_empleado            ON public.cuentas_financieras   FOR SELECT TO authenticated USING (public.mi_rol() = 'EMPLEADO_ADMIN');
CREATE POLICY entidades_sel_empleado          ON public.entidades             FOR SELECT TO authenticated USING (public.mi_rol() = 'EMPLEADO_ADMIN');
CREATE POLICY tickets_sel_empleado            ON public.transacciones_tickets FOR SELECT TO authenticated USING (public.mi_rol() = 'EMPLEADO_ADMIN');
CREATE POLICY avisos_sel_empleado             ON public.avisos_captura        FOR SELECT TO authenticated USING (public.mi_rol() = 'EMPLEADO_ADMIN');
CREATE POLICY recetas_sel_empleado            ON public.recetas_produccion    FOR SELECT TO authenticated USING (public.mi_rol() = 'EMPLEADO_ADMIN');

-- 3. Alta de registros (lo que la app inserta directo o via RPC) -------------
CREATE POLICY lotes_ins_empleado              ON public.lotes                 FOR INSERT TO authenticated WITH CHECK (public.mi_rol() = 'EMPLEADO_ADMIN');
CREATE POLICY lote_entradas_ins_empleado      ON public.lote_entradas         FOR INSERT TO authenticated WITH CHECK (public.mi_rol() = 'EMPLEADO_ADMIN');
CREATE POLICY lote_salidas_ins_empleado       ON public.lote_salidas          FOR INSERT TO authenticated WITH CHECK (public.mi_rol() = 'EMPLEADO_ADMIN');
CREATE POLICY lote_envasado_ins_empleado      ON public.lote_envasado         FOR INSERT TO authenticated WITH CHECK (public.mi_rol() = 'EMPLEADO_ADMIN');
CREATE POLICY inventario_ins_empleado         ON public.inventario_ledger     FOR INSERT TO authenticated WITH CHECK (public.mi_rol() = 'EMPLEADO_ADMIN');
CREATE POLICY finanzas_ins_empleado           ON public.finanzas_ledger       FOR INSERT TO authenticated WITH CHECK (public.mi_rol() = 'EMPLEADO_ADMIN');
CREATE POLICY avisos_ins_empleado             ON public.avisos_captura        FOR INSERT TO authenticated WITH CHECK (public.mi_rol() = 'EMPLEADO_ADMIN');
-- Igual que lote_etapas_ins_admin: firma con su propio email, sin telegram_id.
CREATE POLICY lote_etapas_ins_empleado        ON public.lote_etapas           FOR INSERT TO authenticated
  WITH CHECK (public.mi_rol() = 'EMPLEADO_ADMIN' AND registrado_por = (auth.jwt() ->> 'email') AND telegram_id IS NULL);

-- 4. Updates/deletes que la app NECESITA (y solo esos) -----------------------
-- lotes UPDATE: las RPC hacen `select ... from lotes ... for update`, y en RLS
-- un FOR UPDATE exige pasar la politica de UPDATE.
CREATE POLICY lotes_upd_empleado              ON public.lotes                 FOR UPDATE TO authenticated
  USING (public.mi_rol() = 'EMPLEADO_ADMIN') WITH CHECK (public.mi_rol() = 'EMPLEADO_ADMIN');
-- lote_entradas UPDATE: las RPC hacen upsert (on conflict do update: el mismo
-- insumo dicho otra vez se suma).
CREATE POLICY lote_entradas_upd_empleado      ON public.lote_entradas         FOR UPDATE TO authenticated
  USING (public.mi_rol() = 'EMPLEADO_ADMIN') WITH CHECK (public.mi_rol() = 'EMPLEADO_ADMIN');
-- inventario UPDATE: compensacion de Compra de insumo (inventario.ts: status
-- ANULADO + notas). tg_vigilar_update_no_admin ya limita a un no-ADMIN a
-- ACTIVO->ANULADO, solo status/notas, dentro de 12 h. Ademas: solo lo suyo.
CREATE POLICY inventario_upd_empleado         ON public.inventario_ledger     FOR UPDATE TO authenticated
  USING (public.mi_rol() = 'EMPLEADO_ADMIN' AND usuario_creador = (auth.jwt() ->> 'email'))
  WITH CHECK (public.mi_rol() = 'EMPLEADO_ADMIN' AND usuario_creador = (auth.jwt() ->> 'email'));
-- lotes DELETE: compensacion al crear lote (lotes.ts `deshacer`). Solo los
-- lotes que el mismo creo; las hijas caen por ON DELETE CASCADE.
CREATE POLICY lotes_del_empleado              ON public.lotes                 FOR DELETE TO authenticated
  USING (public.mi_rol() = 'EMPLEADO_ADMIN' AND usuario_creador = (auth.jwt() ->> 'email'));

-- 5. Candado de las 3 RPC de la app: ADMIN o EMPLEADO_ADMIN ------------------
-- Se reemplaza SOLO la condicion del candado; el resto del cuerpo queda igual.
-- Si el texto no aparece exactamente una vez, la migracion entera aborta.
DO $mig$
DECLARE
  v_fn   text;
  v_def  text;
  v_viejo text := $t$and public.mi_rol() is distinct from 'ADMIN' then
    raise exception 'NO_AUTORIZADO: solo un ADMIN registra esto$t$;
  v_nuevo text := $t$and coalesce(public.mi_rol(), '') not in ('ADMIN', 'EMPLEADO_ADMIN') then
    raise exception 'NO_AUTORIZADO: solo un ADMIN o EMPLEADO_ADMIN registra esto$t$;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['registrar_etapa_lote', 'registrar_envasado_diario', 'registrar_en_lote'] LOOP
    SELECT pg_get_functiondef(p.oid) INTO STRICT v_def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_fn;
    IF (length(v_def) - length(replace(v_def, v_viejo, ''))) / length(v_viejo) <> 1 THEN
      RAISE EXCEPTION 'rol_empleado_admin: el candado de % no coincide; revisar a mano', v_fn;
    END IF;
    EXECUTE replace(v_def, v_viejo, v_nuevo);
  END LOOP;
END
$mig$;
