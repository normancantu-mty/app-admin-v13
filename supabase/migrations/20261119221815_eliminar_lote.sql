-- Eliminar un lote desde /correcciones (2026-11-19). Escrito el 2026-11-19 por el agente (Cuartel).
-- APLICADA en prod el 2026-11-19 (version 20261119221815). Ensayo previo como ADMIN (rollback): confirmacion mala rechazada; borrado con 4 entradas en cascada y 1 fila DELETE en auditoria_logs.
-- Reversa: supabase/ROLLBACK_eliminar_lote_2026-11-19.sql
--
-- eliminar_lote(p_id, p_confirmacion, p_motivo): SOLO ADMIN, en una transaccion.
--   * Rechaza (LOTE_CON_ENVASADO) si el lote tiene botellas en lote_envasado o
--     filas ACTIVAS de inventario_ledger 'ENVASADO lote <codigo>: ...': esas
--     filas movieron inventario (producto terminado y empaque) y no tienen FK al
--     lote; borrar el lote las dejaria huerfanas. Primero se anulan.
--   * Si no, borra el lote; ON DELETE CASCADE (verificado en pg_constraint el
--     2026-11-19) se lleva lote_entradas, lote_salidas, lote_etapas, lote_alias
--     y lote_recordatorios. Ningun ledger referencia lotes por FK, ni tickets.
--   * Antes de borrar deja en auditoria_logs una fila operacion='DELETE' con el
--     lote COMPLETO (cabecera + hijos) en datos_antes y el motivo: con eso se
--     puede reconstruir a mano. Para eso el CHECK de operacion admite 'DELETE'.
--   * Confirmacion: hay que mandar el codigo del lote tal cual (la UI lo pide).
-- SECURITY DEFINER con search_path pg_catalog primero (como c0d2c86): escribe
-- auditoria_logs, que no tiene permisos de escritura para clientes.

begin;

alter table public.auditoria_logs drop constraint auditoria_logs_operacion_check;
alter table public.auditoria_logs add constraint auditoria_logs_operacion_check
  check (operacion = any (array['INSERT'::text, 'UPDATE'::text, 'DELETE'::text]));

create or replace function public.eliminar_lote(p_id uuid, p_confirmacion text, p_motivo text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_lote   public.lotes;
  v_motivo text := btrim(coalesce(p_motivo, ''));
  v_env    integer;
  v_inv    integer;
  v_foto   jsonb;
begin
  if public.mi_rol() is distinct from 'ADMIN' then
    raise exception 'NO_AUTORIZADO: solo un ADMIN elimina lotes' using errcode = '42501';
  end if;
  if length(v_motivo) < 5 then
    raise exception 'El motivo es obligatorio (minimo 5 caracteres)' using errcode = 'check_violation';
  end if;

  select * into v_lote from public.lotes where id = p_id for update;
  if not found then
    raise exception 'El lote % no existe', p_id using errcode = 'foreign_key_violation';
  end if;
  if btrim(coalesce(p_confirmacion, '')) is distinct from btrim(v_lote.codigo_lote) then
    raise exception 'CONFIRMACION: escribe el codigo del lote (%) para eliminarlo', v_lote.codigo_lote
      using errcode = 'check_violation';
  end if;

  select count(*) into v_env from public.lote_envasado where id_lote = p_id;
  select count(*) into v_inv from public.inventario_ledger
   where status = 'ACTIVO' and notas like 'ENVASADO lote ' || v_lote.codigo_lote || ':%';
  if v_env > 0 or v_inv > 0 then
    raise exception 'LOTE_CON_ENVASADO: el lote % tiene % envasado(s) y % movimiento(s) de inventario activos ligados. Anula primero ese inventario; no se borra un lote que ya movio inventario.',
      v_lote.codigo_lote, v_env, v_inv using errcode = 'check_violation';
  end if;

  v_foto := jsonb_build_object(
    'lote', to_jsonb(v_lote),
    'entradas', coalesce((select jsonb_agg(to_jsonb(e)) from public.lote_entradas e where e.id_lote = p_id), '[]'::jsonb),
    'salidas', coalesce((select jsonb_agg(to_jsonb(s)) from public.lote_salidas s where s.id_lote = p_id), '[]'::jsonb),
    'etapas', coalesce((select jsonb_agg(to_jsonb(t)) from public.lote_etapas t where t.id_lote = p_id), '[]'::jsonb),
    'alias', coalesce((select jsonb_agg(to_jsonb(a)) from public.lote_alias a where a.id_lote = p_id), '[]'::jsonb),
    'recordatorios', coalesce((select jsonb_agg(to_jsonb(r)) from public.lote_recordatorios r where r.id_lote = p_id), '[]'::jsonb));

  insert into public.auditoria_logs (tabla, id_registro, operacion, usuario, rol, datos_antes, datos_despues, motivo)
  values ('lotes', p_id, 'DELETE', public.usuario_de_sesion(), public.mi_rol(), v_foto,
          jsonb_build_object('eliminado', true, 'codigo_lote', v_lote.codigo_lote), v_motivo);

  delete from public.lotes where id = p_id;

  return jsonb_build_object(
    'id', p_id,
    'codigo_lote', v_lote.codigo_lote,
    'entradas', jsonb_array_length(v_foto->'entradas'),
    'salidas', jsonb_array_length(v_foto->'salidas'),
    'etapas', jsonb_array_length(v_foto->'etapas'),
    'alias', jsonb_array_length(v_foto->'alias'));
end
$$;

REVOKE ALL ON FUNCTION public.eliminar_lote(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.eliminar_lote(uuid, text, text) TO authenticated;

commit;
