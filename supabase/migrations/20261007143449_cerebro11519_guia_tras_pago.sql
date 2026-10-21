do $$
declare a text; g text; a2 text; g2 text;
begin
  a := pg_get_functiondef('agente.asuntos_abiertos(integer)'::regprocedure);
  g := pg_get_functiondef('agente.guardian_lineas(text,boolean)'::regprocedure);
  if md5(a) <> '9908f3adadbbaedc56292dea992bbeb5' or md5(g) <> 'b6616c98f332ebbaa4b8bb0edbb33c25' then
    raise exception 'ALTO: definicion viva distinta a la auditada';
  end if;
  if (length(a) - length(replace(a, 'where p.estado = ''pedido'' and p.envio_decision is null', ''))) / length('where p.estado = ''pedido'' and p.envio_decision is null') <> 1 then
    raise exception 'ALTO: asuntos_abiertos no tiene la condicion exactamente 1 vez';
  end if;
  if (length(g) - length(replace(g, 'and p.estado not in (''cancelado'',''entregado'')', ''))) / length('and p.estado not in (''cancelado'',''entregado'')') <> 1 then
    raise exception 'ALTO: guardian_lineas no tiene la condicion exactamente 1 vez';
  end if;
  a2 := replace(a, 'where p.estado = ''pedido'' and p.envio_decision is null', 'where p.estado = ''pagado'' and p.envio_decision is null');
  g2 := replace(g, 'and p.estado not in (''cancelado'',''entregado'')', 'and p.estado = ''pagado''');
  execute a2;
  execute g2;
end $$;