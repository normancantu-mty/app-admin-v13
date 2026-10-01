create table if not exists agente.grupo_updates (
  update_id    bigint primary key,
  prueba       boolean not null default false,
  creado_en    timestamptz not null default now(),
  terminado_en timestamptz,
  ok           boolean,
  error        text
);
alter table agente.grupo_updates enable row level security;
comment on table agente.grupo_updates is 'cerebro 1.15.8: update_id de Telegram ya procesados por accion=grupo. Repetido = 200 sin modelo.';
