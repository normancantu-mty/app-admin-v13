-- envia_guias_2026-10-10.sql -- tabla agente.guias_envia: una fila por intento de guia de envia.com (cotizada -> generando ->
-- generada | error | error_incierto | cancelada). El UNIQUE parcial guias_envia_un_vivo es EL candado anti-doble-cobro:
-- a lo mas UNA fila 'generando' o 'generada' por pedido, asi dos "va" simultaneos no pueden llamar dos veces a /ship/generate/.
-- Escrito el 2026-10-10 por el ejecutor del Socio (encargo DESDE_SOCIO_prompt_ejecutor_envia_api_2026-10-10.md §2.C). NO APLICADO.
-- Probado en un Postgres 16 LOCAL desechable (db_pg_test.ts), nunca contra Supabase.
-- Deshacer: sql/envia_guias_2026-10-10_DESHACER.sql
-- Comprobar despues:
--   select indexdef from pg_indexes where schemaname = 'agente' and indexname = 'guias_envia_un_vivo';
--   select relrowsecurity from pg_class where oid = 'agente.guias_envia'::regclass;   -- true

begin;

create table agente.guias_envia (
  id              bigint generated always as identity primary key,
  pedido_id       bigint not null references agente.pedidos (id),
  estado          text not null check (estado in ('cotizada', 'generando', 'generada', 'error', 'error_incierto', 'cancelada')),
  payload_rate    jsonb,          -- lo que se mando a /ship/rate/ (sin token)
  cotizacion      jsonb,          -- {service, totalPrice, deliveryEstimate, currency}
  cajas           jsonb,          -- [{largo, ancho, alto, kg}]
  va_por          text,
  va_en           timestamptz,
  va_texto        text,
  tracking        text,
  label_url       text,           -- solo para el grupo; jamas al cliente
  total_price     numeric(10, 2), -- cotizado (cotizada) o cobrado (generada)
  currency        text,
  balance_despues numeric(12, 2), -- currentBalance que devolvio envia
  respuesta       jsonb,
  error           text,
  cotizado_en     timestamptz,
  generado_en     timestamptz,
  creado_en       timestamptz not null default now(),
  actualizado_en  timestamptz not null default now()
);

create unique index guias_envia_un_vivo on agente.guias_envia (pedido_id) where estado in ('generando', 'generada');
create index guias_envia_pedido on agente.guias_envia (pedido_id, id desc);

-- RLS encendido y SIN politicas: anon/authenticated no ven ni escriben nada. La escriben solo envia-guias y el cerebro, por la
-- conexion directa (rol postgres), que pasa por encima de RLS.
alter table agente.guias_envia enable row level security;
revoke all on agente.guias_envia from anon, authenticated;

comment on table agente.guias_envia is 'Guias de envia.com por API (envia-guias). UNIQUE parcial guias_envia_un_vivo = candado anti doble cobro. 2026-10-10.';

commit;
