-- Estado de proceso del lote (2026-11-19). Escrito el 2026-11-19 por el agente (Cuartel).
-- Reversa: supabase/ROLLBACK_lote_estado_proceso_2026-11-19.sql
-- APLICADA en prod el 2026-11-19 (version 20261119215907). Ensayo previo BEGIN + raise (rollback) OK.
--
-- Contrato compartido con la app movil y el bot (fijado el 2026-11-19):
--   lotes.estado_proceso text not null default 'FERMENTACION'
--   check in ('FERMENTACION','DESTILADO','TERMINADO').
-- Regla: un lote con los TRES insumos (Aditivo 1 = sku mosto-1, Aditivo 2 =
-- aditivo-2, Levadura y enzimas = levadura-enzimas; cantidad > 0) pasa SOLO a
-- TERMINADO, salvo que ya este DESTILADO (DESTILADO nunca se degrada). La regla
-- vive aqui (trigger en lote_entradas) para que web, app y bot la hereden.
-- El trigger solo PROMUEVE FERMENTACION -> TERMINADO y solo cuando cambian los
-- insumos (INSERT, o UPDATE con otra cantidad): una correccion manual del
-- estado se respeta mientras nadie vuelva a tocar los insumos.
--
-- Ya existia un estado DERIVADO en la web (components/v2/lotes/estado.ts:
-- fermentacion / terminado / envasado, calculado de tandas y fechas, sin
-- columna). No es equivalente (otra regla, otros valores); la web pasa a leer
-- esta columna.
--
-- Permisos: la columna hereda los GRANT de tabla (authenticated: SELECT/UPDATE;
-- gia_lectura: SELECT) y las politicas existentes (UPDATE para ADMIN y
-- EMPLEADO_ADMIN). El bot escribe por la API de Next con service_role (sin RLS).

begin;

alter table public.lotes
  add column estado_proceso text not null default 'FERMENTACION'
  constraint lotes_estado_proceso_check check (estado_proceso in ('FERMENTACION', 'DESTILADO', 'TERMINADO'));

comment on column public.lotes.estado_proceso is
  'FERMENTACION | DESTILADO | TERMINADO. Pasa solo a TERMINADO cuando el lote tiene Aditivo 1, Aditivo 2 y Levadura y enzimas (cantidad > 0), salvo DESTILADO (trigger trg_lote_estado_por_insumos). Se cambia a mano con UPDATE (RLS: ADMIN/EMPLEADO_ADMIN) o con ajustar_lote.';

-- Tiene los tres insumos? (una sola definicion: el trigger y el backfill la usan)
create or replace function public.lote_tiene_tres_insumos(p_id_lote uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select count(distinct p.sku) = 3
    from public.lote_entradas e
    join public.catalogo_productos p on p.id = e.id_insumo
   where e.id_lote = p_id_lote
     and e.cantidad > 0
     and p.sku in ('mosto-1', 'aditivo-2', 'levadura-enzimas');
$$;

revoke all on function public.lote_tiene_tres_insumos(uuid) from public, anon;
grant execute on function public.lote_tiene_tres_insumos(uuid) to authenticated, service_role;

create or replace function public.tg_lote_estado_por_insumos()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'UPDATE' and old.cantidad is not distinct from new.cantidad
     and old.id_insumo is not distinct from new.id_insumo then
    return null;
  end if;
  if public.lote_tiene_tres_insumos(new.id_lote) then
    update public.lotes
       set estado_proceso = 'TERMINADO'
     where id = new.id_lote
       and estado_proceso = 'FERMENTACION';
  end if;
  return null;
end
$$;

REVOKE EXECUTE ON FUNCTION public.tg_lote_estado_por_insumos() FROM PUBLIC, anon, authenticated;

create trigger trg_lote_estado_por_insumos
  after insert or update on public.lote_entradas
  for each row execute function public.tg_lote_estado_por_insumos();

-- Backfill: los lotes que ya tienen los tres insumos.
update public.lotes l
   set estado_proceso = 'TERMINADO'
 where l.estado_proceso = 'FERMENTACION'
   and public.lote_tiene_tres_insumos(l.id);

-- ajustar_lote (correcciones): estado_proceso como 8a llave OPCIONAL. Si lo
-- visto y lo nuevo la traen, se compara y se corrige; si no, no se toca (los
-- clientes de antes siguen funcionando igual).
CREATE OR REPLACE FUNCTION public.ajustar_lote(p_id uuid, p_visto jsonb, p_nuevo jsonb, p_motivo text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  c_llaves constant text[] := ARRAY['codigo_lote', 'fecha_inicio', 'fecha_fin_fermentacion',
                                    'horas_fermentacion', 'brix_chile', 'brix_final', 'notas'];
  v_llaves text[];
  v_motivo text := btrim(COALESCE(p_motivo, ''));
  v_act    public.lotes;
  v_vis    public.lotes;
  v_nue    public.lotes;
  v_antes  jsonb;
  v_desp   jsonb;
  v_dif    text[];
  v_con_estado boolean;
  k        text;
BEGIN
  IF public.mi_rol() IS DISTINCT FROM 'ADMIN' THEN
    RAISE EXCEPTION 'Solo un ADMIN corrige lotes' USING ERRCODE = '42501';
  END IF;
  IF length(v_motivo) < 5 THEN
    RAISE EXCEPTION 'El motivo es obligatorio (minimo 5 caracteres)' USING ERRCODE = 'check_violation';
  END IF;
  IF p_visto IS NULL OR p_nuevo IS NULL
     OR jsonb_typeof(p_visto) <> 'object' OR jsonb_typeof(p_nuevo) <> 'object'
     OR NOT (p_visto ?& c_llaves) OR NOT (p_nuevo ?& c_llaves) THEN
    RAISE EXCEPTION 'Faltan datos: lo visto y lo nuevo traen las 7 llaves de la cabecera' USING ERRCODE = 'check_violation';
  END IF;
  v_con_estado := (p_visto ? 'estado_proceso') AND (p_nuevo ? 'estado_proceso');
  v_llaves := CASE WHEN v_con_estado THEN c_llaves || 'estado_proceso'::text ELSE c_llaves END;

  v_vis := jsonb_populate_record(NULL::public.lotes, p_visto);
  v_nue := jsonb_populate_record(NULL::public.lotes, p_nuevo);
  v_nue.codigo_lote := btrim(COALESCE(v_nue.codigo_lote, ''));
  v_nue.notas := NULLIF(btrim(COALESCE(v_nue.notas, '')), '');
  v_vis.notas := NULLIF(btrim(COALESCE(v_vis.notas, '')), '');
  IF v_nue.codigo_lote = '' OR length(v_nue.codigo_lote) > 40 THEN
    RAISE EXCEPTION 'El codigo del lote va de 1 a 40 caracteres' USING ERRCODE = 'check_violation';
  END IF;
  IF v_con_estado AND v_nue.estado_proceso IS DISTINCT FROM 'FERMENTACION'
     AND v_nue.estado_proceso IS DISTINCT FROM 'DESTILADO' AND v_nue.estado_proceso IS DISTINCT FROM 'TERMINADO' THEN
    RAISE EXCEPTION 'El estado va FERMENTACION, DESTILADO o TERMINADO' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_act FROM public.lotes WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El lote % no existe (o no lo puedes ver)', p_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  v_act.notas := NULLIF(btrim(COALESCE(v_act.notas, '')), '');

  v_antes := jsonb_build_object(
    'codigo_lote', v_act.codigo_lote, 'fecha_inicio', v_act.fecha_inicio,
    'fecha_fin_fermentacion', v_act.fecha_fin_fermentacion, 'horas_fermentacion', v_act.horas_fermentacion,
    'brix_chile', v_act.brix_chile, 'brix_final', v_act.brix_final, 'notas', v_act.notas);
  IF v_con_estado THEN
    v_antes := v_antes || jsonb_build_object('estado_proceso', v_act.estado_proceso);
  END IF;

  -- Lo que el usuario vio tiene que ser lo que hay.
  IF v_vis.codigo_lote IS DISTINCT FROM v_act.codigo_lote
     OR v_vis.fecha_inicio IS DISTINCT FROM v_act.fecha_inicio
     OR v_vis.fecha_fin_fermentacion IS DISTINCT FROM v_act.fecha_fin_fermentacion
     OR v_vis.horas_fermentacion IS DISTINCT FROM v_act.horas_fermentacion
     OR v_vis.brix_chile IS DISTINCT FROM v_act.brix_chile
     OR v_vis.brix_final IS DISTINCT FROM v_act.brix_final
     OR v_vis.notas IS DISTINCT FROM v_act.notas
     OR (v_con_estado AND v_vis.estado_proceso IS DISTINCT FROM v_act.estado_proceso) THEN
    RAISE EXCEPTION 'CAMBIO_CONCURRENTE: el lote % cambio mientras lo revisabas. Recarga y vuelve a confirmar.',
      v_act.codigo_lote
      USING ERRCODE = '40001';
  END IF;

  v_desp := jsonb_build_object(
    'codigo_lote', v_nue.codigo_lote, 'fecha_inicio', v_nue.fecha_inicio,
    'fecha_fin_fermentacion', v_nue.fecha_fin_fermentacion, 'horas_fermentacion', v_nue.horas_fermentacion,
    'brix_chile', v_nue.brix_chile, 'brix_final', v_nue.brix_final, 'notas', v_nue.notas);
  IF v_con_estado THEN
    v_desp := v_desp || jsonb_build_object('estado_proceso', v_nue.estado_proceso);
  END IF;

  FOREACH k IN ARRAY v_llaves LOOP
    IF (v_antes -> k) IS DISTINCT FROM (v_desp -> k) THEN
      v_dif := array_append(v_dif, k);
    END IF;
  END LOOP;
  IF v_dif IS NULL THEN
    RAISE EXCEPTION 'SIN_CAMBIO: el lote % ya tiene esos datos', v_act.codigo_lote USING ERRCODE = 'check_violation';
  END IF;

  -- Otro lote ya se llama asi (el alias de otro lo rechaza tg_lote_nombre_libre).
  IF EXISTS (SELECT 1 FROM public.lotes
              WHERE id <> p_id AND upper(btrim(codigo_lote)) = upper(v_nue.codigo_lote)) THEN
    RAISE EXCEPTION 'NOMBRE_OCUPADO: ya existe otro lote %. Usa otro codigo.', v_nue.codigo_lote
      USING ERRCODE = '23505';
  END IF;

  -- El motivo viaja a la bitacora y al alias SOLO en esta transaccion.
  PERFORM set_config('app.motivo_correccion', v_motivo, true);

  UPDATE public.lotes
     SET codigo_lote            = v_nue.codigo_lote,
         fecha_inicio           = v_nue.fecha_inicio,
         fecha_fin_fermentacion = v_nue.fecha_fin_fermentacion,
         horas_fermentacion     = v_nue.horas_fermentacion,
         brix_chile             = v_nue.brix_chile,
         brix_final             = v_nue.brix_final,
         notas                  = v_nue.notas,
         estado_proceso         = CASE WHEN v_con_estado THEN v_nue.estado_proceso ELSE estado_proceso END
   WHERE id = p_id;

  PERFORM set_config('app.motivo_correccion', '', true);

  RETURN jsonb_build_object(
    'id', p_id,
    'antes', v_antes,
    'despues', v_desp,
    'cambios', to_jsonb(v_dif),
    'alias', COALESCE((SELECT jsonb_agg(a.alias ORDER BY a.creado_en)
                         FROM public.lote_alias a WHERE a.id_lote = p_id), '[]'::jsonb));
END
$function$;

commit;
