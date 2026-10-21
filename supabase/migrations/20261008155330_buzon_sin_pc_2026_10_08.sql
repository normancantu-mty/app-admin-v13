create schema if not exists socio;
revoke all on schema socio from public, anon, authenticated;

create table if not exists socio.buzon_updates (
  update_id    bigint primary key,
  update       jsonb not null,
  recibido_en  timestamptz not null default now(),
  devuelto_en  timestamptz,
  entregado_en timestamptz
);
create index if not exists buzon_updates_pendientes on socio.buzon_updates (update_id) where entregado_en is null;

create table if not exists socio.buzon_archivos (
  file_id        text primary key,
  update_id      bigint not null references socio.buzon_updates (update_id) on delete cascade,
  file_unique_id text not null,
  ruta           text not null unique,
  tamano         integer not null,
  datos          bytea not null,
  guardado_en    timestamptz not null default now()
);

create table if not exists socio.pc_latido (
  clave text primary key default 'pc',
  en    timestamptz not null
);

alter table socio.buzon_updates  enable row level security;
alter table socio.buzon_archivos enable row level security;
alter table socio.pc_latido      enable row level security;
revoke all on all tables in schema socio from public, anon, authenticated;