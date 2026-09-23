alter table agente.vigia_alertas add column if not exists psid text, add column if not exists accion text, add column if not exists resultado jsonb;
create table if not exists agente.vigia_config (id int primary key default 1 check (id = 1), modo text not null default 'registrar' check (modo in ('apagado','registrar','rescatar')), horas_rescate int not null default 12, actualizado_en timestamptz default now());
insert into agente.vigia_config (id) values (1) on conflict do nothing;
alter table agente.vigia_config enable row level security;
revoke all on agente.vigia_config from anon, authenticated;
