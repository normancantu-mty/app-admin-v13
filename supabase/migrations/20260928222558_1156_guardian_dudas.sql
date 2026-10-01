create table if not exists agente.guardian_dudas (
  id            bigint generated always as identity primary key,
  huella        text not null unique,
  fuente        text not null check (fuente in ('texto', 'codigo', 'conducta')),
  cita_a        text not null,
  cita_b        text not null,
  pregunta      text not null,
  opciones      text[] not null,
  respuesta     text,
  message_id    bigint,
  creada_en     timestamptz not null default now(),
  preguntada_en timestamptz,
  contestada_en timestamptz,
  prueba        boolean not null default false,
  request_id    bigint,
  ultima_vez_en timestamptz,
  propuesta     text,
  regla_id      bigint
);
create unique index if not exists guardian_dudas_una_pendiente
  on agente.guardian_dudas (prueba) where preguntada_en is not null and respuesta is null;
create index if not exists guardian_dudas_cola on agente.guardian_dudas (prueba, creada_en) where preguntada_en is null;
alter table agente.guardian_dudas enable row level security;
comment on table agente.guardian_dudas is 'cerebro 1.15.6: contradicciones que el guardian pregunta a Norman, una a la vez. Lo contestado no se vuelve a preguntar (huella unica).';
