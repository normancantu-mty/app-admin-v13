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
  v_lote2 uuid;
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

  -- 10. (ronda 2) el reintento: el reclamo nace intentos=1, entregado_en NULL;
  -- el compare-and-swap sobre intentos lo gana UNO; entregado lo cierra.
  if (select intentos from public.lote_recordatorios where id_lote=v_lote and tipo='aditivo_2') <> 1
     or (select entregado_en from public.lote_recordatorios where id_lote=v_lote and tipo='aditivo_2') is not null then
    raise exception 'FALLA 10: el reclamo no nacio con intentos=1 y entregado_en NULL';
  end if;
  update public.lote_recordatorios set intentos = 2
   where id_lote=v_lote and tipo='aditivo_2' and intentos = 1 and entregado_en is null;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FALLA 10: el primer reintento no gano'; end if;
  update public.lote_recordatorios set intentos = 2
   where id_lote=v_lote and tipo='aditivo_2' and intentos = 1 and entregado_en is null;
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FALLA 10: dos latidos ganaron el mismo reintento'; end if;
  update public.lote_recordatorios set entregado_en = now()
   where id_lote=v_lote and tipo='aditivo_2' and entregado_en is null;
  update public.lote_recordatorios set intentos = 3
   where id_lote=v_lote and tipo='aditivo_2' and intentos = 2 and entregado_en is null;
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FALLA 10: un recordatorio entregado se pudo reintentar'; end if;
  raise notice 'ok 10: reintento por compare-and-swap (1 gana, 0 el segundo); entregado lo cierra';

  -- 11. (ronda 2) destilacion en un lote con salidas previas: numera desde max+1
  insert into public.lotes (codigo_lote, fecha_inicio, usuario_creador)
  values ('L-19-10.2', date '2026-10-19', 'telegram:prueba') returning id into v_lote2;
  insert into public.lote_salidas (id_lote, numero_tanda, litros, grado_alcohol) values (v_lote2, 1, 10, 45);
  v_r := public.registrar_etapa_lote(v_lote2, 'destilacion', date '2026-10-25', 111, 'telegram:prueba', '[]'::jsonb,
           '[{"numero":1,"peso_kg":18,"grado_alcohol":50},{"numero":2,"peso_kg":10,"grado_alcohol":30}]'::jsonb, '{}'::jsonb);
  if (select string_agg(numero_tanda::text, ',' order by numero_tanda) from public.lote_salidas where id_lote=v_lote2) <> '1,2,3' then
    raise exception 'FALLA 11: con una tanda previa las garrafas no van 2,3';
  end if;
  raise notice 'ok 11: con una salida previa las garrafas quedan 2 y 3 (max+1), sin chocar con el unique';
  delete from public.lotes where id = v_lote2;

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

  -- 12. (ronda 5, C) chile-guajon: existe UNA vez (la migracion se aplica dos
  -- veces en la prueba: el ON CONFLICT la hace re-ejecutable) y copia tipo,
  -- unidad y es_materia_prima de chile-guajillo; costo sin confirmar.
  select count(*) into v_n from public.catalogo_productos where sku = 'chile-guajon';
  if v_n <> 1 then raise exception 'FALLA 12: chile-guajon aparece % veces', v_n; end if;
  if exists (select 1 from public.catalogo_productos n, public.catalogo_productos g
             where n.sku = 'chile-guajon' and g.sku = 'chile-guajillo'
               and (n.tipo, n.unidad_medida, n.es_materia_prima) is distinct from (g.tipo, g.unidad_medida, g.es_materia_prima)) then
    raise exception 'FALLA 12: chile-guajon no copia tipo/unidad/materia prima de chile-guajillo';
  end if;
  if (select costo_cero_confirmado from public.catalogo_productos where sku = 'chile-guajon') then
    raise exception 'FALLA 12: el costo del guajon quedo confirmado (no se inventa)';
  end if;
  raise notice 'ok 12: chile-guajon una vez, como chile-guajillo, costo sin confirmar';
end $$;

-- 13. (ronda 5, B) el envasado diario: sin lote, con su inventario, y el candado
-- de empaque (D92) igual que el envasado de un lote.
do $$
declare
  v_admin uuid;
  v_botella uuid;
  v_corcho uuid;
  v_r jsonb;
  v_n integer;
  v_falla boolean;
begin
  if (select is_nullable from information_schema.columns
      where table_schema='public' and table_name='lote_envasado' and column_name='id_lote') <> 'YES' then
    raise exception 'FALLA 13: lote_envasado.id_lote sigue NOT NULL';
  end if;
  insert into public.entidades (nombre, rol, zona) values ('Matriz prueba', 'ADMIN', 'Zacatecas') returning id into v_admin;
  insert into public.catalogo_productos (sku, nombre, tipo, unidad_medida, es_materia_prima, ml_por_unidad)
  values ('botella-750-prueba', 'Destilado 750 (prueba)', 'TERMINADO', 'PIEZAS', false, 750) returning id into v_botella;
  insert into public.catalogo_productos (sku, nombre, tipo, unidad_medida, es_materia_prima)
  values ('corcho-prueba', 'Corcho (prueba)', 'INSUMO', 'PIEZAS', false) returning id into v_corcho;
  insert into public.recetas_produccion (id_producto_terminado, id_insumo, cantidad_requerida) values (v_botella, v_corcho, 1);
  insert into public.inventario_ledger (id_producto, tipo_movimiento, cantidad, id_entidad_destino, usuario_creador)
  values (v_corcho, 'ENTRADA_COMPRA', 10, v_admin, 'prueba');

  v_r := public.registrar_envasado_diario(date '2026-10-19',
           jsonb_build_array(jsonb_build_object('id_producto', v_botella, 'botellas', 6)),
           'telegram:prueba', 'codigo dicho: L-12-10.1 (el envasado no se liga al lote)');
  if (v_r->>'envasado')::int <> 1 or (v_r->>'filas_inventario')::int <> 2 then
    raise exception 'FALLA 13: resultado %', v_r;
  end if;
  if not exists (select 1 from public.lote_envasado where id_producto = v_botella and id_lote is null
                 and botellas = 6 and fecha = date '2026-10-19' and nota like 'codigo dicho: L-12-10.1%') then
    raise exception 'FALLA 13: no quedo la fila de lote_envasado sin lote con su nota';
  end if;
  if (select sum(cantidad) from public.inventario_ledger where id_producto = v_botella and tipo_movimiento = 'PRODUCCION'
      and id_entidad_destino = v_admin) <> 6
     or (select sum(cantidad) from public.inventario_ledger where id_producto = v_corcho and tipo_movimiento = 'TRASPASO'
      and id_entidad_origen = v_admin) <> 6 then
    raise exception 'FALLA 13: el inventario no se movio +6 botellas / -6 corchos';
  end if;
  raise notice 'ok 13: envasado diario sin lote: lote_envasado(id_lote NULL, nota) + inventario +6/-6 (%)', v_r;

  -- 14. falta empaque (quedan 4 corchos, se piden 5): no queda NADA
  select count(*) into v_n from public.lote_envasado;
  v_falla := false;
  begin
    perform public.registrar_envasado_diario(date '2026-10-19',
              jsonb_build_array(jsonb_build_object('id_producto', v_botella, 'botellas', 5)), 'telegram:prueba', null);
  exception when others then
    v_falla := sqlerrm like 'FALTA_EMPAQUE:%';
  end;
  if not v_falla then raise exception 'FALLA 14: sin empaque suficiente no salio FALTA_EMPAQUE'; end if;
  if (select count(*) from public.lote_envasado) <> v_n then raise exception 'FALLA 14: quedo una fila a medias'; end if;
  raise notice 'ok 14: sin empaque suficiente -> FALTA_EMPAQUE y nada escrito';

  -- 15. vacio: se rechaza
  v_falla := false;
  begin
    perform public.registrar_envasado_diario(date '2026-10-19', '[]'::jsonb, 'telegram:prueba', null);
  exception when others then v_falla := sqlerrm like 'ENVASADO_VACIO%';
  end;
  if not v_falla then raise exception 'FALLA 15: un envasado vacio no se rechazo'; end if;
  raise notice 'ok 15: envasado vacio rechazado';
end $$;

select count(*) as politicas_rls_public from pg_policies where schemaname = 'public';
