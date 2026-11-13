-- REVERSA de 20261113200000_rol_empleado_admin.sql (2026-11-13)
-- Antes de correrla: desactivar o cambiar de rol las filas EMPLEADO_ADMIN de
-- `accesos` (si quedan, el CHECK de abajo falla y la reversa aborta entera):
--   select id, nombre, etiqueta from public.accesos where rol = 'EMPLEADO_ADMIN';
-- Los usuarios Auth de esos empleados NO se borran aqui.

BEGIN;

DO $rev$
DECLARE
  v_fn   text;
  v_def  text;
  v_nuevo text := $t$and coalesce(public.mi_rol(), '') not in ('ADMIN', 'EMPLEADO_ADMIN') then
    raise exception 'NO_AUTORIZADO: solo un ADMIN o EMPLEADO_ADMIN registra esto$t$;
  v_viejo text := $t$and public.mi_rol() is distinct from 'ADMIN' then
    raise exception 'NO_AUTORIZADO: solo un ADMIN registra esto$t$;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['registrar_etapa_lote', 'registrar_envasado_diario', 'registrar_en_lote'] LOOP
    SELECT pg_get_functiondef(p.oid) INTO STRICT v_def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_fn;
    IF position(v_nuevo in v_def) = 0 THEN
      RAISE EXCEPTION 'reversa: el candado de % no es el de la migracion; revisar a mano', v_fn;
    END IF;
    EXECUTE replace(v_def, v_nuevo, v_viejo);
  END LOOP;
END
$rev$;

DROP POLICY lotes_del_empleado         ON public.lotes;
DROP POLICY inventario_upd_empleado    ON public.inventario_ledger;
DROP POLICY lote_entradas_upd_empleado ON public.lote_entradas;
DROP POLICY lotes_upd_empleado         ON public.lotes;
DROP POLICY lote_etapas_ins_empleado   ON public.lote_etapas;
DROP POLICY avisos_ins_empleado        ON public.avisos_captura;
DROP POLICY finanzas_ins_empleado      ON public.finanzas_ledger;
DROP POLICY inventario_ins_empleado    ON public.inventario_ledger;
DROP POLICY lote_envasado_ins_empleado ON public.lote_envasado;
DROP POLICY lote_salidas_ins_empleado  ON public.lote_salidas;
DROP POLICY lote_entradas_ins_empleado ON public.lote_entradas;
DROP POLICY lotes_ins_empleado         ON public.lotes;
DROP POLICY recetas_sel_empleado       ON public.recetas_produccion;
DROP POLICY avisos_sel_empleado        ON public.avisos_captura;
DROP POLICY tickets_sel_empleado       ON public.transacciones_tickets;
DROP POLICY entidades_sel_empleado     ON public.entidades;
DROP POLICY cuentas_sel_empleado       ON public.cuentas_financieras;
DROP POLICY finanzas_sel_empleado      ON public.finanzas_ledger;
DROP POLICY inventario_sel_empleado    ON public.inventario_ledger;
DROP POLICY lote_envasado_sel_empleado ON public.lote_envasado;
DROP POLICY lote_etapas_sel_empleado   ON public.lote_etapas;
DROP POLICY lote_salidas_sel_empleado  ON public.lote_salidas;
DROP POLICY lote_entradas_sel_empleado ON public.lote_entradas;
DROP POLICY lotes_sel_empleado         ON public.lotes;

ALTER TABLE public.accesos DROP COLUMN permiso_finanzas;
ALTER TABLE public.accesos DROP CONSTRAINT accesos_rol_check;
ALTER TABLE public.accesos ADD CONSTRAINT accesos_rol_check
  CHECK (rol = ANY (ARRAY['ADMIN'::text, 'SOCIO'::text]));

COMMIT;
