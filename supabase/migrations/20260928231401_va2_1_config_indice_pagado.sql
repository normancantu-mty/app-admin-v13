alter table agente.cerebro_config
  add column if not exists envio_decidir_min integer not null default 60,
  add column if not exists puente_caido_min integer not null default 25;

alter table agente.pedido_eventos drop constraint pedido_eventos_por_check;
alter table agente.pedido_eventos add constraint pedido_eventos_por_check
  check (por = any (array['cerebro'::text, 'humano'::text, 'sistema'::text]));

do $$
declare n int;
begin
  select count(*) into n from (select contacto_id from agente.pedidos
    where estado in ('contacto','pregunto_precio','dio_talla','cotizado','pidio_entrega','pedido','pagado')
    group by contacto_id having count(*) > 1) x;
  if n > 0 then raise exception 'va2 (c): % contactos con mas de un pedido vivo contando pagado; no se crea el indice', n; end if;
end $$;
drop index if exists agente.uq_pedido_vivo;
create unique index uq_pedido_vivo on agente.pedidos using btree (contacto_id)
  where (estado = any (array['contacto'::text, 'pregunto_precio'::text, 'dio_talla'::text, 'cotizado'::text,
                             'pidio_entrega'::text, 'pedido'::text, 'pagado'::text]));
