-- Reglas que Norman puede cambiar sin desplegar codigo y sin esperar a una sesion.
-- El cerebro las lee EN CADA LLAMADA y las inyecta como bloque de sistema, detras del
-- marcador de cache (igual que el bloque de vigencia), asi que no rompen el prefijo cacheado.
create table if not exists agente.reglas_vivas (
  id          bigint generated always as identity primary key,
  texto       text        not null,
  activa      boolean     not null default true,
  prioridad   int         not null default 100,
  quien       text        not null default 'norman',
  nota        text,
  creada_en   timestamptz not null default now(),
  apagada_en  timestamptz
);

comment on table agente.reglas_vivas is
  'Adenda viva al NUCLEO. Norman la edita; el cerebro la lee en cada llamada. Nunca se borra una regla: se apaga (activa=false) para que quede el rastro de cuando dejo de valer.';

create index if not exists reglas_vivas_activas_idx
  on agente.reglas_vivas (prioridad, id) where activa;

alter table agente.reglas_vivas enable row level security;
