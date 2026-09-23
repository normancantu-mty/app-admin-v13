-- Pasos 2-3 de WhatsApp al cerebro (2026-09-23, ejecutor). Deshacer: drop table agente.wa_respuestas, agente.wa_config;
create table if not exists agente.wa_config (
  id int primary key default 1 check (id = 1),
  modo text not null default 'sombra' check (modo in ('apagado','sombra','canario','todos')),
  lista_blanca text[] not null default '{}',
  actualizado_en timestamptz not null default now(),
  nota text
);
insert into agente.wa_config (id, modo, lista_blanca, nota)
values (1, 'sombra', '{}', 'arranque paso 2: el cerebro calcula y no envia')
on conflict (id) do nothing;
alter table agente.wa_config enable row level security;

create table if not exists agente.wa_respuestas (
  id bigserial primary key,
  wamid text unique not null,
  recibido_en timestamptz not null default now(),
  duplicados int not null default 0,
  telefono text,
  nombre text,
  tipo text,
  texto_entrante text,
  modo text,
  contacto text,
  firma text,
  bloque jsonb,
  salida jsonb,
  envio jsonb,
  enviado boolean not null default false,
  ms_cerebro int,
  ms_total int,
  error text,
  ts_meta timestamptz
);
alter table agente.wa_respuestas enable row level security;
