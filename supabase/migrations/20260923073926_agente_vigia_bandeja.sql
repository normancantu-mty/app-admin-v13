create table if not exists agente.vigia_alertas (
  id bigserial primary key,
  canal text not null,
  hilo text not null,
  quien text,
  ultimo_ts timestamptz not null,
  texto text,
  avisado_en timestamptz not null default now(),
  unique (hilo, ultimo_ts)
);
create table if not exists agente.vigia_corridas (
  id bigserial primary key,
  corrida_en timestamptz not null default now(),
  pendientes int,
  nuevos int,
  errores jsonb
);
alter table agente.vigia_alertas enable row level security;
alter table agente.vigia_corridas enable row level security;
revoke all on agente.vigia_alertas, agente.vigia_corridas from anon, authenticated;
revoke all on sequence agente.vigia_alertas_id_seq, agente.vigia_corridas_id_seq from anon, authenticated;
select vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'vigia_clave', 'clave del cron para vigia-bandeja')
 where not exists (select 1 from vault.secrets where name = 'vigia_clave');
