-- 2026-11-03 -- La FOTO del ticket de cada gasto, ligada a su movimiento.
-- Escrito el 2026-11-03 por el ejecutor del Socio (bot ERP, fotos de tickets).
-- Autorizado por Norman el 2026-11-03 (via el coordinador del Socio).
--
-- ADITIVA: una tabla nueva y un bucket nuevo. No toca ni renombra nada que exista.
-- El bucket `comprobantes` (de LucIA, 11 objetos) NO se usa: el de gastos es
-- propio para que su rollback (borrar el bucket) no toque nada ajeno.
--
-- Quien escribe: solo `/api/bot/comprobante/subir` con la service role, y solo
-- DESPUES del clic de Norman (la ruta exige que el movimiento ya exista).
-- Quien lee: ADMIN (la Matriz). El bucket es privado: sin politicas en
-- storage.objects, solo la service role lo toca.
--
-- ROLLBACK (en este orden):
--   1. Vaciar y borrar el bucket por la API de Storage (Postgres ya no deja
--      borrar filas de storage.objects a mano):
--        node scripts/borrar_bucket_tickets_gasto.mjs
--   2. drop table if exists public.comprobantes_gasto;

create table if not exists public.comprobantes_gasto (
  id                  uuid primary key default gen_random_uuid(),
  id_movimiento       uuid not null references public.finanzas_ledger(id) on delete cascade,
  borrador_id         uuid,
  telegram_id         bigint,
  ruta_storage        text not null,
  sha256              text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  mime                text not null default 'image/jpeg',
  bytes               integer check (bytes is null or bytes > 0),
  ancho               integer,
  alto                integer,
  -- Para pedir la factura despues (autofacturacion):
  rfc_emisor          text,
  razon_social        text,
  folio               text,
  fecha_ticket        date,
  hora_ticket         text,
  subtotal            numeric(14,2),
  iva                 numeric(14,2),
  total               numeric(14,2),
  forma_pago          text,
  url_facturacion     text,
  leyenda_facturacion text,
  ocr                 jsonb,
  factura_estado      text not null default 'pendiente'
                      check (factura_estado in ('pendiente','solicitada','facturada','no_aplica')),
  creado_en           timestamptz not null default now(),
  unique (id_movimiento, sha256)
);

create index if not exists comprobantes_gasto_movimiento_idx on public.comprobantes_gasto (id_movimiento);
create index if not exists comprobantes_gasto_factura_idx on public.comprobantes_gasto (factura_estado)
  where factura_estado = 'pendiente';

alter table public.comprobantes_gasto enable row level security;

drop policy if exists comprobantes_gasto_admin_sel on public.comprobantes_gasto;
create policy comprobantes_gasto_admin_sel on public.comprobantes_gasto
  for select using (public.mi_rol() = 'ADMIN');

comment on table public.comprobantes_gasto is
  'Foto del ticket de un gasto (bucket privado tickets_gasto) + campos leidos para facturar. La escribe solo el bot tras el clic de Norman. 2026-11-03.';

-- El bucket: privado, solo JPEG (el bot comprime: lado largo <= 1600 px,
-- <= 200 KB), tope 256 KB por archivo.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tickets_gasto', 'tickets_gasto', false, 262144, array['image/jpeg'])
on conflict (id) do nothing;
