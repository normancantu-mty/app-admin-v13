alter table agente.pedidos add column if not exists ubicacion_url text;
alter table agente.pedidos add column if not exists promesa_alertada_en timestamptz;
comment on column agente.pedidos.ubicacion_url is 'cerebro 1.15.14 T4: liga de mapa o coordenadas que mando el cliente; cuenta como domicilio';
comment on column agente.pedidos.promesa_alertada_en is 'cerebro 1.15.14 T2: candado de la alerta "LucIA confirmo pero el pedido no cerro" (una por pedido)';