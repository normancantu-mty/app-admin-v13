-- Paso 2 de la migracion de mensajeria: persistencia propia del agente.
-- Schema aparte (`agente`) a proposito: no toca ni una tabla del ERP en `public`.
-- Se deshace entero con  DROP SCHEMA agente CASCADE;
create schema if not exists agente;

create table if not exists agente.contactos (
  id            text primary key,              -- subscriber_id de ManyChat
  canal         text not null default 'manychat',
  nombre        text,
  primer_visto  timestamptz not null default now(),
  ultimo_visto  timestamptz not null default now(),
  etiquetas     jsonb not null default '[]'::jsonb,
  datos         jsonb not null default '{}'::jsonb
);

create table if not exists agente.conversaciones (
  id           uuid primary key default gen_random_uuid(),
  contacto_id  text not null references agente.contactos(id) on delete cascade,
  canal        text not null default 'manychat',
  abierta_en   timestamptz not null default now(),
  ultima_en    timestamptz not null default now(),
  estado       text not null default 'abierta'
);

create table if not exists agente.mensajes (
  id               bigserial primary key,
  conversacion_id  uuid not null references agente.conversaciones(id) on delete cascade,
  contacto_id      text not null,
  direccion        text not null check (direccion in ('entrante','saliente')),
  texto            text not null,
  -- como se produjo la respuesta: el modelo, las reglas, o el puente asincrono
  origen           text check (origen in ('modelo','reglas','puente','cliente')),
  modelo           text,
  ms               integer,
  tokens_entrada   integer,
  tokens_salida    integer,
  creado_en        timestamptz not null default now()
);

create table if not exists agente.decisiones (
  id               bigserial primary key,
  conversacion_id  uuid references agente.conversaciones(id) on delete cascade,
  tipo             text not null,
  detalle          jsonb not null default '{}'::jsonb,
  creado_en        timestamptz not null default now()
);

-- El indice que importa: traer los ultimos N turnos de UNA conversacion.
-- Es la consulta del camino critico (el cerebro hoy no tiene historial).
create index if not exists ix_mensajes_conv_fecha
  on agente.mensajes (conversacion_id, creado_en desc);
create index if not exists ix_conversaciones_contacto
  on agente.conversaciones (contacto_id, ultima_en desc);
create index if not exists ix_contactos_ultimo
  on agente.contactos (ultimo_visto desc);

-- RLS prendido y SIN politicas: solo la service_role entra. La Edge Function
-- usa esa llave; ningun cliente del navegador puede leer conversaciones.
alter table agente.contactos       enable row level security;
alter table agente.conversaciones  enable row level security;
alter table agente.mensajes        enable row level security;
alter table agente.decisiones      enable row level security;
