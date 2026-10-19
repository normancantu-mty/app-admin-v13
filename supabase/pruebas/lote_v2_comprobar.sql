-- Comprobaciones de la migracion 20261019150000_lote_v2_ciclo.sql.
-- Escrito el 2026-10-19 por el ejecutor del Socio (lote v2).
-- SOLO para el Postgres efimero (scripts/probar_migracion_efimera.py): inserta
-- filas de prueba. NUNCA contra produccion.
\set ON_ERROR_STOP 1

do $$
declare
  v_lote uuid;
  v_al uuid;
  v_r jsonb;
  v_n integer;
  v_falla boolean;
begin
  -- 1. columnas nuevas y litros ya nullable
  if (select is_nullable from information_schema.columns
      where table_schema='public' and table_name='lote_salidas' and column_name='litros') <> 'YES' then
    raise exception 'FALLA 1: lote_salidas.litros sigue NOT NULL';
  end if;
  select count(*) into v_n from information_schema.columns
   where table_schema='public' and table_name='lotes' and column_name in ('brix_chile','brix_final');
  if v_n <> 2 then raise exception 'FALLA 1: faltan columnas de brix (%)', v_n; end if;
  raise notice 'ok 1: brix_chile, brix_final; litros nullable';

  -- 2. una etapa con su aditivo 2, todo o nada
  insert into public.catalogo_productos (sku, nombre, tipo, unidad_medida, costo_unitario, es_materia_prima)
  values ('ing-al-prueba', 'Ingrediente Al (prueba)', 'INSUMO', 'KILOGRAMOS', 0, true) returning id into v_al;
  insert into public.lotes (codigo_lote, fecha_inicio, usuario_creador, brix_chile, brix_final)
  values ('L-19-10.1', date '2026-10-19', 'telegram:prueba', 12.5, 18) returning id into v_lote;

  v_r := public.registrar_etapa_lote(v_lote, 'aditivo_2', date '2026-10-22', 111, 'telegram:prueba',
           jsonb_build_array(jsonb_build_object('id_insumo', v_al, 'cantidad', 2.5)), '[]'::jsonb, '{"kg":2.5}'::jsonb);
  if (v_r->>'entradas')::int <> 1 then raise exception 'FALLA 2: entradas=%', v_r; end if;
  if (select cantidad from public.lote_entradas where id_lote=v_lote and id_insumo=v_al) <> 2.5 then
    raise exception 'FALLA 2: el aditivo 2 no quedo en lote_entradas';
  end if;
  raise notice 'ok 2: aditivo 2 -> lote_entradas y lote_etapas (%)', v_r;

  -- 3. la misma etapa otra vez: se rechaza y NO suma el aditivo
  v_falla := false;
  begin
    perform public.registrar_etapa_lote(v_lote, 'aditivo_2', date '2026-10-22', 111, 'telegram:prueba',
              jsonb_build_array(jsonb_build_object('id_insumo', v_al, 'cantidad', 2.5)), '[]'::jsonb, '{}'::jsonb);
  exception when others then
    v_falla := sqlerrm like 'ETAPA_YA_REGISTRADA%';
  end;
  if not v_falla then raise exception 'FALLA 3: la etapa repetida no se rechazo'; end if;
  if (select cantidad from public.lote_entradas where id_lote=v_lote and id_insumo=v_al) <> 2.5 then
    raise exception 'FALLA 3: la etapa repetida sumo el aditivo';
  end if;
  raise notice 'ok 3: etapa repetida rechazada (ETAPA_YA_REGISTRADA) y sin efecto';

  -- 4. destilacion: una fila por garrafa, litros NULL, peso y grado puestos
  v_r := public.registrar_etapa_lote(v_lote, 'destilacion', date '2026-10-25', 111, 'telegram:prueba', '[]'::jsonb,
           '[{"numero":1,"peso_kg":18.5,"grado_alcohol":52},{"numero":2,"peso_kg":17,"grado_alcohol":48},{"numero":3,"peso_kg":10,"grado_alcohol":30}]'::jsonb,
           '{}'::jsonb);
  select count(*) into v_n from public.lote_salidas
   where id_lote=v_lote and litros is null and peso_kg is not null and grado_alcohol is not null;
  if v_n <> 3 then raise exception 'FALLA 4: garrafas escritas=%', v_n; end if;
  if (select string_agg(numero_tanda::text, ',' order by numero_tanda) from public.lote_salidas where id_lote=v_lote) <> '1,2,3' then
    raise exception 'FALLA 4: numero_tanda no es el numero de garrafa';
  end if;
  raise notice 'ok 4: 3 garrafas, numero_tanda 1..3, litros NULL';

  -- 5. la vista de rendimiento sigue leyendo un lote con litros NULL
  perform * from public.v_lote_rendimiento where id = v_lote;
  raise notice 'ok 5: v_lote_rendimiento lee el lote sin error';

  -- 6. recordatorio: el reclamo es de UNA vez (lo que usa la ruta)
  insert into public.lote_recordatorios (id_lote, tipo) values (v_lote, 'aditivo_2') on conflict do nothing;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FALLA 6: el primer reclamo no inserto'; end if;
  insert into public.lote_recordatorios (id_lote, tipo) values (v_lote, 'aditivo_2') on conflict do nothing;
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FALLA 6: el segundo reclamo inserto (saldria dos veces)'; end if;
  raise notice 'ok 6: recordatorio reclamado 1 vez; el segundo reclamo no inserta';

  -- 7. temperatura: min <= prom <= max, y una fila por dia y fuente
  insert into public.temperatura_diaria (fecha, fuente, t_min, t_max, t_prom) values (date '2026-10-19', 'open-meteo exterior', 8, 24, 15.5);
  insert into public.temperatura_diaria (fecha, fuente, t_min, t_max, t_prom) values (date '2026-10-19', 'manual', 18, 22, 20);
  v_falla := false;
  begin
    insert into public.temperatura_diaria (fecha, fuente, t_min, t_max, t_prom) values (date '2026-10-20', 'open-meteo exterior', 30, 10, 20);
  exception when check_violation then v_falla := true;
  end;
  if not v_falla then raise exception 'FALLA 7: aceptó t_min > t_max'; end if;
  raise notice 'ok 7: temperatura por dia y fuente; orden min<=prom<=max';

  -- 8. el borrado del lote arrastra etapas y recordatorios (cascade)
  delete from public.lotes where id = v_lote;
  if exists (select 1 from public.lote_etapas where id_lote=v_lote) or exists (select 1 from public.lote_recordatorios where id_lote=v_lote) then
    raise exception 'FALLA 8: quedaron etapas o recordatorios huerfanos';
  end if;
  raise notice 'ok 8: cascade';

  -- 9. RLS encendida en las tres tablas nuevas
  select count(*) into v_n from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relname in ('lote_etapas','lote_recordatorios','temperatura_diaria') and c.relrowsecurity;
  if v_n <> 3 then raise exception 'FALLA 9: RLS en % de 3', v_n; end if;
  raise notice 'ok 9: RLS en las 3 tablas nuevas';
end $$;

select count(*) as politicas_rls_public from pg_policies where schemaname = 'public';
