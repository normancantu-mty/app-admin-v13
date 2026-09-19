-- ERP-87 (FASE 4): la cotizacion deja de ser un mensaje y pasa a ser una tabla.
--
-- Escrita el 2026-09-18 por el EJECUTOR. Aplicada con apply_migration del MCP.
--
-- DE DONDE SALE ESTO
-- ---------------------------------------------------------------------------
-- Del objetivo del proyecto (D-199): *"lo ideal es que maneje todo 100% desde
-- telegram"*. Cotizar es lo que se hace ANTES de vender, y hoy no existe en
-- ningun lado: se dice de palabra y se olvida. Una cotizacion guardada es la
-- unica forma de contestar "que le cotice a este senor el mes pasado" y de
-- saber cuantas se convirtieron en venta.
--
-- LO QUE ESTA TABLA **NO** HACE, Y ES LO MAS IMPORTANTE DE ELLA
-- ---------------------------------------------------------------------------
-- **Una cotizacion no mueve NADA.** No escribe en `inventario_ledger`, no
-- escribe en `finanzas_ledger`, no aparta stock, no genera deuda. Es una
-- promesa de precio, no un hecho economico. Por eso no tiene `id_cuenta`, no
-- tiene `condicion_pago` y no tiene impuestos: esas tres cosas se deciden el
-- dia que se vende, no el dia que se cotiza.
--
-- Esa propiedad NO la protege esta migracion -ninguna tabla puede impedir que
-- otro codigo escriba en el ledger-: la protege `tests/bot-cotizacion.spec.ts`,
-- que lee el codigo de la ruta y falla si aparece el nombre de cualquiera de
-- los dos ledgers.
--
-- EL FOLIO ES UNA SECUENCIA, NO UN COUNT
-- ---------------------------------------------------------------------------
-- `COT-0001`, `COT-0002`, ... sale de una `sequence` de Postgres, no de un
-- `count(*) + 1` en TypeScript. Dos cotizaciones dictadas en el mismo segundo
-- con un contador leido en la aplicacion producen el mismo folio y el `unique`
-- revienta la segunda; con la secuencia, cada una se lleva el suyo. El precio
-- de la secuencia es que un rollback deja huecos -no se reciclan- y eso esta
-- bien: un folio saltado se explica, un folio repetido no.
--
-- LA VIGENCIA SE CALCULA, EL VENCIMIENTO NO SE ESCRIBE
-- ---------------------------------------------------------------------------
-- `vigencia_dias` nace en 15 y `vigente_hasta` es una columna GENERADA
-- (`fecha + vigencia_dias`). El estado `VENCIDA` **no lo escribe nadie**: si
-- hubiera que escribirlo haria falta un trabajo diario que corriera solo, y el
-- dia que ese trabajo fallara la base diria "VIGENTE" de algo que ya no lo
-- esta. En vez de eso, `v_cotizaciones.estado_efectivo` lo deriva de la fecha
-- cada vez que se lee. Una cotizacion vencida lo esta porque paso el tiempo, no
-- porque alguien se acordo de marcarla.
--
-- El `CHECK` de `estado` SI acepta 'VENCIDA' -para poder cerrar una a mano
-- antes de tiempo-, pero el camino normal es VIGENTE -> CONVERTIDA.
--
-- OJO CON LA REGLA 4 DE CLAUDE.md: `estado` aqui NO es el `status` de los
-- ledgers. Aquella regla dice que 'ACTIVO'/'ANULADO' son los unicos valores
-- validos **en los dos ledgers y en los tickets**, y esta tabla no es ninguno
-- de los tres. La columna se llama `estado` y no `status` justamente para que
-- nadie las confunda al leer por encima.
--
-- A QUIEN SE COTIZA: LA COLUMNA QUE PARECE DE MAS Y NO LO ES
-- ---------------------------------------------------------------------------
-- `id_comprador` es NULO-permitido y existe `nombre_prospecto`. **El caso
-- normal de una cotizacion es alguien que TODAVIA NO es cliente**: si la tabla
-- exigiera una entidad de la red, cotizarle a un prospecto obligaria a darlo de
-- alta como distribuidor antes de saber si va a comprar, y la red se llenaria
-- de nodos que nunca compraron nada. Uno de los dos tiene que venir, y eso si
-- lo exige un CHECK.
--
-- ES ADITIVA: dos tablas nuevas, una secuencia nueva y una vista nueva. No
-- borra ni altera ninguna fila ni ninguna columna existente.
--
-- ROLLBACK:
--   drop view if exists public.v_cotizaciones;
--   drop table if exists public.cotizacion_detalles, public.cotizaciones;
--   drop sequence if exists public.cotizacion_folio_seq;

create sequence if not exists public.cotizacion_folio_seq as bigint start with 1;

comment on sequence public.cotizacion_folio_seq is
  'ERP-87. El consecutivo del folio COT-####. Es una secuencia y no un count(*) para que dos cotizaciones simultaneas no peleen por el mismo numero.';

create table if not exists public.cotizaciones (
  id               uuid primary key default gen_random_uuid(),
  folio            text not null unique
                   default ('COT-' || lpad(nextval('public.cotizacion_folio_seq')::text, 4, '0')),
  fecha            date not null default current_date,
  id_vendedor      uuid not null references public.entidades(id),
  id_comprador     uuid references public.entidades(id),
  nombre_prospecto text,
  zona             text not null default 'Zacatecas',
  vigencia_dias    integer not null default 15 check (vigencia_dias > 0 and vigencia_dias <= 365),
  vigente_hasta    date generated always as (fecha + vigencia_dias) stored,
  total            numeric(12,2) not null check (total >= 0),
  estado           text not null default 'VIGENTE'
                   check (estado in ('VIGENTE', 'VENCIDA', 'CONVERTIDA')),
  id_ticket        uuid references public.transacciones_tickets(id),
  notas            text,
  usuario_creador  text not null,
  creado_en        timestamptz not null default now(),
  -- A alguien se le cotiza: o es de la red, o tiene nombre. Las dos juntas
  -- tambien valen (un cliente de la red con nombre de contacto).
  constraint cotizaciones_alguien_recibe
    check (id_comprador is not null or nullif(btrim(coalesce(nombre_prospecto, '')), '') is not null),
  -- Convertida y sin ticket seria una conversion que nadie puede auditar; con
  -- ticket y sin convertir seria una venta que la cotizacion no reconoce.
  constraint cotizaciones_convertida_lleva_ticket
    check ((estado = 'CONVERTIDA') = (id_ticket is not null))
);

comment on table public.cotizaciones is
  'ERP-87. Una promesa de precio con fecha de caducidad. NO mueve inventario ni dinero: eso pasa el dia que se convierte en venta, y entonces el ticket queda en id_ticket.';
comment on column public.cotizaciones.vigente_hasta is
  'ERP-87. Columna GENERADA: fecha + vigencia_dias. Nadie la escribe, asi que no puede quedar desalineada de la vigencia.';
comment on column public.cotizaciones.estado is
  'ERP-87. VIGENTE | VENCIDA | CONVERTIDA. NO es el status de los ledgers (regla 4 de CLAUDE.md): esta tabla no es un ledger. Para saber si sigue viva lee v_cotizaciones.estado_efectivo, que ademas vence por fecha sin que nadie la toque.';
comment on column public.cotizaciones.total is
  'ERP-87. La suma de los renglones AL PRECIO COTIZADO. Se guarda calculada y no se recalcula al leer: el sentido de una cotizacion es que el precio no se mueva aunque la lista si.';

create table if not exists public.cotizacion_detalles (
  id              uuid primary key default gen_random_uuid(),
  id_cotizacion   uuid not null references public.cotizaciones(id) on delete cascade,
  id_producto     uuid not null references public.catalogo_productos(id),
  cantidad        integer not null check (cantidad > 0),
  precio_unitario numeric(12,2) not null check (precio_unitario >= 0),
  unique (id_cotizacion, id_producto)
);

comment on table public.cotizacion_detalles is
  'ERP-87. Los renglones cotizados con el precio del dia que se cotizo. Cuelgan de la cotizacion con on delete cascade: sin cabecera no significan nada.';

create index if not exists cotizacion_detalles_por_cotizacion
  on public.cotizacion_detalles (id_cotizacion);
create index if not exists cotizaciones_por_comprador
  on public.cotizaciones (id_comprador) where id_comprador is not null;

alter table public.cotizaciones       enable row level security;
alter table public.cotizacion_detalles enable row level security;

-- Escribir cotizaciones es de la matriz, igual que los lotes. Leerlas la matriz,
-- el socio, y **el cliente al que se le cotizo**: es su propio precio.
create policy cotizaciones_sel on public.cotizaciones
  for select to authenticated
  using (mi_rol() = any (array['ADMIN','SOCIO']) or id_comprador = mi_entidad_id());
create policy cotizaciones_ins_admin on public.cotizaciones
  for insert to authenticated with check (mi_rol() = 'ADMIN');
create policy cotizaciones_upd_admin on public.cotizaciones
  for update to authenticated using (mi_rol() = 'ADMIN') with check (mi_rol() = 'ADMIN');
create policy cotizaciones_del_admin on public.cotizaciones
  for delete to authenticated using (mi_rol() = 'ADMIN');

create policy cotizacion_detalles_sel on public.cotizacion_detalles
  for select to authenticated
  using (exists (
    select 1 from public.cotizaciones c
    where c.id = cotizacion_detalles.id_cotizacion
      and (mi_rol() = any (array['ADMIN','SOCIO']) or c.id_comprador = mi_entidad_id())
  ));
create policy cotizacion_detalles_ins_admin on public.cotizacion_detalles
  for insert to authenticated with check (mi_rol() = 'ADMIN');
create policy cotizacion_detalles_upd_admin on public.cotizacion_detalles
  for update to authenticated using (mi_rol() = 'ADMIN') with check (mi_rol() = 'ADMIN');
create policy cotizacion_detalles_del_admin on public.cotizacion_detalles
  for delete to authenticated using (mi_rol() = 'ADMIN');

-- La vista que vence sola. `security_invoker` porque el rol `postgres` tiene
-- rolbypassrls: una vista SECURITY DEFINER aqui le ensenaria a cualquiera las
-- cotizaciones de todos.
create or replace view public.v_cotizaciones
with (security_invoker = true) as
select
  c.id,
  c.folio,
  c.fecha,
  c.id_vendedor,
  c.id_comprador,
  c.nombre_prospecto,
  c.zona,
  c.vigencia_dias,
  c.vigente_hasta,
  c.total,
  c.estado,
  c.id_ticket,
  c.notas,
  c.usuario_creador,
  c.creado_en,
  case
    when c.estado = 'VIGENTE' and c.vigente_hasta < current_date then 'VENCIDA'
    else c.estado
  end as estado_efectivo,
  (c.vigente_hasta - current_date) as dias_restantes,
  coalesce(
    (select nombre from public.entidades e where e.id = c.id_comprador),
    c.nombre_prospecto
  ) as para_quien
from public.cotizaciones c;

comment on view public.v_cotizaciones is
  'ERP-87. Las cotizaciones con su estado REAL. estado_efectivo convierte VIGENTE en VENCIDA cuando ya paso vigente_hasta, sin que nadie tenga que correr un proceso diario. dias_restantes sale negativo cuando ya vencio.';

grant select on public.v_cotizaciones to authenticated, service_role;
