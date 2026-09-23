-- Fase 2: ensayo de WhatsApp sobre el numero de prueba de Meta. Mismo patron que agente.whatsapp_escucha.
create table if not exists agente.whatsapp_ensayo (
  id bigserial primary key,
  recibido_en timestamptz not null default now(),
  wamid text unique,
  direccion text,
  payload jsonb
);
alter table agente.whatsapp_ensayo enable row level security;
revoke all on agente.whatsapp_ensayo from anon, authenticated;
revoke all on sequence agente.whatsapp_ensayo_id_seq from anon, authenticated;
