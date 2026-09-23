-- Solo escucha del WhatsApp vivo (camino A, autorizado por Norman 2026-09-22). Aditiva.
-- Deshacer: drop table agente.whatsapp_escucha;
create table agente.whatsapp_escucha (
  id bigserial primary key,
  recibido_en timestamptz not null default now(),
  campo text,
  payload jsonb not null
);
alter table agente.whatsapp_escucha enable row level security;
revoke all on agente.whatsapp_escucha from anon, authenticated;
revoke all on sequence agente.whatsapp_escucha_id_seq from anon, authenticated;
comment on table agente.whatsapp_escucha is 'Payload crudo de webhooks WhatsApp de la WABA 2474023429695567. La funcion whatsapp-escucha NUNCA contesta.';
