-- ============================================================================
-- Fase 9, D92 — prueba de `registrar_en_lote` contra la base REAL, sin dejar nada.
--
-- Es un bloque DO que SIEMPRE termina en `raise exception`: todo lo que escribe
-- (el lote de prueba, las entradas de empaque, el envasado) se deshace. El
-- resultado viaja EN el mensaje de la excepcion:
--   'D92 VERDE: ...'  -> las tres afirmaciones se cumplieron.
--   'D92 ROJO: ...'   -> alguna fallo; el texto dice cual.
--
-- Afirmaciones:
--   1. Con el empaque que hay (la matriz no tiene para 24), 24 de 750 se RECHAZA
--      con FALTA_EMPAQUE y la lista de faltantes; no queda ni una fila.
--   2. CONTROL: 0 botellas no pide empaque, no bloquea, no mueve nada.
--   3. Tras una entrada de exactamente lo que falta, el mismo envasado PASA
--      (6 filas de inventario) y ningun insumo de la receta queda negativo.
--
-- Mutacion (al final del archivo): la comprobacion apagada DENTRO del bloque
-- (`if v_faltan is not null` -> `if false`; el DDL tambien se deshace) sale
-- 'D92 ROJO: 1. paso sin empaque'.
-- ============================================================================
do $$
declare
  v_admin uuid := (select id from public.entidades where rol = 'ADMIN' limit 1);
  v_750 uuid := 'c1000000-0000-0000-0000-000000000001';
  v_lote uuid;
  v_r jsonb;
  v_msg text := null;
  v_antes integer;
  v_desp integer;
  v_neg integer;
begin
  insert into public.lotes (codigo_lote, fecha_inicio, usuario_creador, notas)
  values ('PRUEBA-D92-NO-QUEDA', current_date, 'prueba:D92', 'se deshace al final')
  returning id into v_lote;

  -- 1. Sin empaque: rechazo con la lista.
  select count(*) into v_antes from public.inventario_ledger;
  begin
    v_r := public.registrar_en_lote(v_lote, '[]', '[]',
      jsonb_build_array(jsonb_build_object('id_producto', v_750, 'botellas', 24)), 'prueba:D92');
    raise exception 'D92 ROJO: 1. paso sin empaque (%)', v_r;
  exception when others then
    if sqlerrm like 'D92 ROJO%' then raise; end if;
    v_msg := sqlerrm;
  end;
  if v_msg not like 'FALTA_EMPAQUE:%' then
    raise exception 'D92 ROJO: 1. fallo por otra cosa: %', v_msg;
  end if;
  select count(*) into v_desp from public.inventario_ledger;
  if v_desp <> v_antes then
    raise exception 'D92 ROJO: 1. quedaron % filas de inventario', v_desp - v_antes;
  end if;

  -- 2. CONTROL: 0 botellas.
  v_r := public.registrar_en_lote(v_lote, '[]', '[]',
    jsonb_build_array(jsonb_build_object('id_producto', v_750, 'botellas', 0)), 'prueba:D92');
  if (v_r->>'filas_inventario')::int <> 0 or (v_r->>'envasado')::int <> 0 then
    raise exception 'D92 ROJO: 2. cero botellas movio algo: %', v_r;
  end if;

  -- 3. Entra EXACTAMENTE lo que falta, y el mismo envasado pasa.
  insert into public.inventario_ledger
    (id_producto, tipo_movimiento, cantidad, id_entidad_destino, cubeta, status, usuario_creador, notas)
  select m.id_producto, 'ENTRADA_COMPRA', m.cantidad - coalesce(s.stock, 0), v_admin,
         'PAGADO', 'ACTIVO', 'prueba:D92', 'entrada de prueba D92'
  from public.movimientos_de_envasado(v_750, 24) m
  left join public.stock_de_insumos(v_admin,
         array(select id_producto from public.movimientos_de_envasado(v_750, 24))) s
    on s.id_producto = m.id_producto
  where m.tipo_movimiento = 'TRASPASO' and coalesce(s.stock, 0) < m.cantidad;

  v_r := public.registrar_en_lote(v_lote, '[]', '[]',
    jsonb_build_array(jsonb_build_object('id_producto', v_750, 'botellas', 24)), 'prueba:D92');
  if (v_r->>'filas_inventario')::int <> 6 then
    raise exception 'D92 ROJO: 3. con empaque esperaba 6 filas y hubo %', v_r;
  end if;
  select count(*) into v_neg
  from public.stock_de_insumos(v_admin,
         array(select id_producto from public.movimientos_de_envasado(v_750, 24))) s
  where s.stock < 0;
  if v_neg <> 0 then
    raise exception 'D92 ROJO: 3. % insumos quedaron negativos', v_neg;
  end if;

  raise exception 'D92 VERDE: 1 rechazo [%] · 2 cero botellas = 0 filas · 3 tras la entrada pasa con 6 filas, 0 negativos. Nada queda.', v_msg;
end
$$;

-- ── LA MUTACION, corrida el 2026-09-23 (resultado: 'D92 ROJO: 1. paso sin empaque ... filas_inventario 6') ──
-- do $$
-- declare v_def text := pg_get_functiondef('public.registrar_en_lote(uuid,jsonb,jsonb,jsonb,text)'::regprocedure);
-- begin
--   execute replace(v_def, 'if v_faltan is not null then', 'if false then');
--   -- ...y el paso 1 de arriba, identico. Termina en raise: el DDL tambien se deshace.
-- end $$;
