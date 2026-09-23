-- agente_schema_v2_20260922.sql (ver archivo en migracion_meta/). cerebro-1.10.0.
alter table agente.mensajes add column if not exists canal text;
create index if not exists ix_mensajes_contacto_fecha
  on agente.mensajes (contacto_id, creado_en desc, id desc);

alter table agente.mensajes drop constraint if exists mensajes_origen_check;
alter table agente.mensajes add constraint mensajes_origen_check check (
  split_part(split_part(origen, '@', 1), ':', 1) = any (array['modelo','reglas','puente','cliente','fijo'])
);

alter table agente.contactos
  add column if not exists telefono_e164 text,
  add column if not exists correo        text,
  add column if not exists rfc           text,
  add column if not exists ciudad        text,
  add column if not exists estado_mx     text,
  add column if not exists cp            text,
  add column if not exists tipo_cliente  text,
  add column if not exists origen        text,
  add column if not exists genero        text,
  add column if not exists locale        text,
  add column if not exists primer_pedido timestamptz,
  add column if not exists ultimo_pedido timestamptz,
  add column if not exists n_pedidos     int not null default 0,
  add column if not exists monto_total   numeric not null default 0,
  add column if not exists sku_favorito  text;
create index if not exists ix_contactos_tel on agente.contactos (telefono_e164) where telefono_e164 is not null;

update agente.conversaciones v set estado = 'cerrada'
 where v.estado = 'abierta'
   and exists (select 1 from agente.conversaciones w
                where w.contacto_id = v.contacto_id and w.estado = 'abierta'
                  and (w.ultima_en, w.id::text) > (v.ultima_en, v.id::text));
create unique index if not exists uq_conversacion_abierta
  on agente.conversaciones (contacto_id) where estado = 'abierta';

create index if not exists ix_decisiones_tipo on agente.decisiones (tipo, creado_en desc);

create table if not exists agente.dato_cliente (
  id                bigserial primary key,
  contacto_id       text not null references agente.contactos(id) on delete cascade,
  campo             text not null,
  valor             text not null,
  confianza         numeric not null default 1,
  fuente_mensaje_id bigint references agente.mensajes(id) on delete set null,
  extractor         text not null check (extractor in ('regex','modelo','humano','manychat','url')),
  creado_en         timestamptz not null default now()
);
create index if not exists ix_dato_cliente on agente.dato_cliente (contacto_id, campo, creado_en desc);

create table if not exists agente.pedidos (
  id              bigserial primary key,
  contacto_id     text not null references agente.contactos(id) on delete cascade,
  conversacion_id uuid references agente.conversaciones(id) on delete set null,
  estado          text not null default 'contacto' check (estado in (
                    'contacto','pregunto_precio','dio_talla','cotizado','pidio_entrega',
                    'pedido','pagado','entregado','cancelado','desaparecio','no_prospecto')),
  items           jsonb not null default '[]'::jsonb,
  total           numeric,
  ciudad          text,
  zona            text,
  receptor_nombre text,
  receptor_tel    text,
  domicilio       text,
  referencias     text,
  horario         text,
  metodo_pago     text,
  ocasion         text,
  objecion        text,
  origen          text,
  creado_en       timestamptz not null default now(),
  actualizado_en  timestamptz not null default now()
);
create unique index if not exists uq_pedido_vivo on agente.pedidos (contacto_id)
  where estado in ('contacto','pregunto_precio','dio_talla','cotizado','pidio_entrega','pedido');
create index if not exists ix_pedidos_estado on agente.pedidos (estado, actualizado_en desc);

create table if not exists agente.pedido_eventos (
  id                bigserial primary key,
  pedido_id         bigint not null references agente.pedidos(id) on delete cascade,
  de                text,
  a                 text not null,
  por               text not null check (por in ('cerebro','humano')),
  fuente_mensaje_id bigint references agente.mensajes(id) on delete set null,
  nota              text,
  creado_en         timestamptz not null default now()
);
create index if not exists ix_pedido_eventos on agente.pedido_eventos (pedido_id, creado_en);

create table if not exists agente.comprobantes (
  id            bigserial primary key,
  contacto_id   text not null references agente.contactos(id) on delete cascade,
  pedido_id     bigint references agente.pedidos(id) on delete set null,
  mensaje_id    bigint references agente.mensajes(id) on delete set null,
  storage_path  text,
  url_original  text,
  mime          text,
  bytes         int,
  error         text,
  recibido_en   timestamptz not null default now(),
  resultado     text check (resultado in ('pagado','no')),
  validado_por  text,
  validado_en   timestamptz,
  monto         numeric,
  fecha_pago    date,
  ultimos4      text check (ultimos4 ~ '^[0-9]{4}$')
);
create index if not exists ix_comprobantes_contacto on agente.comprobantes (contacto_id, recibido_en desc);

create table if not exists agente.meta_eventos (
  id          bigserial primary key,
  psid        text,
  page_id     text,
  tipo        text,
  texto       text,
  referral    jsonb,
  ts          timestamptz,
  crudo       jsonb not null,
  recibido_en timestamptz not null default now()
);
create index if not exists ix_meta_eventos_psid on agente.meta_eventos (psid, ts desc);
create index if not exists ix_meta_eventos_referral on agente.meta_eventos (recibido_en desc) where referral is not null;

alter table agente.dato_cliente   enable row level security;
alter table agente.pedidos        enable row level security;
alter table agente.pedido_eventos enable row level security;
alter table agente.comprobantes   enable row level security;
alter table agente.meta_eventos   enable row level security;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('comprobantes', 'comprobantes', false, 10485760, null),
       ('publico', 'publico', true, 1048576, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

create or replace function agente.avisar(p_texto text, p_botones jsonb default null, p_foto text default null)
returns bigint language plpgsql security definer
set search_path = agente, net, vault, public as $$
declare v_token text; v_body jsonb; v_req bigint; v_metodo text;
begin
  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'telegram_bot_token';
  if v_token is null then return null; end if;
  if p_foto is not null then
    v_metodo := 'sendPhoto';
    v_body := jsonb_build_object('chat_id', 6571822622, 'photo', p_foto, 'caption', left(p_texto, 1000));
  else
    v_metodo := 'sendMessage';
    v_body := jsonb_build_object('chat_id', 6571822622, 'text', left(p_texto, 4000),
                                 'disable_web_page_preview', true);
  end if;
  if p_botones is not null then
    v_body := v_body || jsonb_build_object('reply_markup', jsonb_build_object('inline_keyboard', p_botones));
  end if;
  select net.http_post(
    url := 'https://api.telegram.org/bot' || v_token || '/' || v_metodo,
    headers := jsonb_build_object('Content-Type','application/json'),
    body := v_body) into v_req;
  insert into agente.decisiones (tipo, detalle)
  values ('aviso_telegram', jsonb_build_object('request_id', v_req, 'metodo', v_metodo, 'texto', left(p_texto, 300)));
  return v_req;
end $$;

create or replace function agente.abrir_turno(
  p_id text, p_canal text, p_nombre text, p_horas int, p_n int, p_max_reglas int default 25)
returns jsonb language plpgsql security definer
set search_path = agente, public as $$
declare
  v_nuevo boolean; v_forzar boolean := false; v_conv uuid; v_ultima timestamptz;
  v_reusada boolean := false; v_hist jsonb; v_reglas jsonb; v_cli jsonb;
begin
  insert into agente.contactos as c (id, canal, nombre, ultimo_visto)
  values (p_id, p_canal, nullif(p_nombre, ''), now())
  on conflict (id) do update
     set ultimo_visto = now(), canal = excluded.canal,
         nombre = coalesce(excluded.nombre, c.nombre)
  returning (xmax = 0) into v_nuevo;

  update agente.contactos set datos = datos - 'forzar_bienvenida'
   where id = p_id and datos ? 'forzar_bienvenida'
  returning true into v_forzar;

  select id, ultima_en into v_conv, v_ultima from agente.conversaciones
   where contacto_id = p_id and estado = 'abierta' order by ultima_en desc limit 1;
  if v_conv is not null and v_ultima > now() - make_interval(hours => p_horas) then
    update agente.conversaciones set ultima_en = now() where id = v_conv;
    v_reusada := true;
  else
    if v_conv is not null then
      update agente.conversaciones set estado = 'cerrada' where id = v_conv;
    end if;
    v_conv := null;
    insert into agente.conversaciones (contacto_id, canal) values (p_id, p_canal)
    on conflict (contacto_id) where estado = 'abierta' do nothing
    returning id into v_conv;
    if v_conv is null then
      select id into v_conv from agente.conversaciones
       where contacto_id = p_id and estado = 'abierta' limit 1;
      v_reusada := true;
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('direccion', t.direccion, 'texto', t.texto,
           'en', t.creado_en, 'conv', t.conversacion_id) order by t.creado_en, t.id), '[]'::jsonb)
    into v_hist
    from (select m.direccion, m.texto, m.creado_en, m.id, m.conversacion_id
            from agente.mensajes m
           where m.contacto_id = p_id and m.texto <> ''
             and coalesce(m.origen, '') not like 'puente%'
             and coalesce(m.origen, '') not like '%tarde_fallo%'
           order by m.creado_en desc, m.id desc limit p_n) t;

  select coalesce(jsonb_agg(r.texto order by r.prioridad, r.id), '[]'::jsonb) into v_reglas
    from (select texto, prioridad, id from agente.reglas_vivas where activa
           order by prioridad, id limit p_max_reglas) r;

  select jsonb_strip_nulls(jsonb_build_object(
           'telefono', c.telefono_e164, 'correo', c.correo, 'ciudad', c.ciudad, 'cp', c.cp,
           'tipo_cliente', c.tipo_cliente, 'origen', c.origen, 'n_pedidos', nullif(c.n_pedidos, 0),
           'ultimo_pedido', c.ultimo_pedido, 'primer_visto', c.primer_visto,
           'pedido_vivo', (select jsonb_strip_nulls(jsonb_build_object('estado', p.estado,
                             'items', p.items, 'domicilio', p.domicilio, 'receptor', p.receptor_nombre,
                             'horario', p.horario))
                             from agente.pedidos p where p.contacto_id = c.id
                              and p.estado in ('contacto','pregunto_precio','dio_talla','cotizado','pidio_entrega','pedido')
                             limit 1)))
    into v_cli from agente.contactos c where c.id = p_id;

  return jsonb_build_object('conversacion_id', v_conv, 'reusada', v_reusada, 'nuevo', v_nuevo,
    'forzar', coalesce(v_forzar, false), 'historial', v_hist, 'reglas', v_reglas, 'cliente', v_cli);
end $$;

create or replace function agente.aplicar_datos(
  p_contacto text, p_mensaje bigint, p_extractor text, p_campos jsonb, p_pedido jsonb default null,
  p_conversacion uuid default null)
returns jsonb language plpgsql security definer
set search_path = agente, public as $$
declare
  k text; v text; v_conf numeric; n_datos int := 0;
  orden constant text[] := array['contacto','pregunto_precio','dio_talla','cotizado','pidio_entrega','pedido'];
  v_ped agente.pedidos; v_nuevo_estado text; v_items jsonb; v_evento boolean := false;
begin
  v_conf := case p_extractor when 'regex' then 0.95 when 'modelo' then 0.7 else 1 end;
  for k, v in select key, value from jsonb_each_text(coalesce(p_campos, '{}'::jsonb)) loop
    continue when v is null or btrim(v) = '';
    continue when exists (select 1 from agente.dato_cliente d
                           where d.contacto_id = p_contacto and d.campo = k
                             and d.id = (select max(id) from agente.dato_cliente
                                          where contacto_id = p_contacto and campo = k)
                             and d.valor = v);
    insert into agente.dato_cliente (contacto_id, campo, valor, confianza, fuente_mensaje_id, extractor)
    values (p_contacto, k, v, v_conf, p_mensaje, p_extractor);
    n_datos := n_datos + 1;
  end loop;

  update agente.contactos c set
    telefono_e164 = coalesce(p_campos->>'telefono', c.telefono_e164),
    correo        = coalesce(p_campos->>'correo', c.correo),
    rfc           = coalesce(p_campos->>'rfc', c.rfc),
    cp            = coalesce(p_campos->>'cp', c.cp),
    ciudad        = coalesce(p_campos->>'ciudad', c.ciudad),
    estado_mx     = coalesce(p_campos->>'estado_mx', c.estado_mx),
    tipo_cliente  = coalesce(p_campos->>'tipo_cliente', c.tipo_cliente),
    genero        = coalesce(p_campos->>'genero', c.genero),
    locale        = coalesce(p_campos->>'locale', c.locale),
    origen        = coalesce(c.origen, p_campos->>'origen')
  where c.id = p_contacto;

  if p_pedido is not null and p_pedido <> '{}'::jsonb then
    select * into v_ped from agente.pedidos
     where contacto_id = p_contacto and estado = any (orden) limit 1;
    if v_ped.id is null then
      insert into agente.pedidos (contacto_id, conversacion_id, origen)
      values (p_contacto, p_conversacion, (select origen from agente.contactos where id = p_contacto))
      on conflict do nothing returning * into v_ped;
      if v_ped.id is null then
        select * into v_ped from agente.pedidos where contacto_id = p_contacto and estado = any (orden) limit 1;
      end if;
      insert into agente.pedido_eventos (pedido_id, de, a, por, fuente_mensaje_id)
      values (v_ped.id, null, v_ped.estado, 'cerebro', p_mensaje);
    end if;

    v_items := case when jsonb_typeof(p_pedido->'items') = 'array' and jsonb_array_length(p_pedido->'items') > 0
                    then p_pedido->'items' else null end;
    v_nuevo_estado := v_ped.estado;
    if p_pedido->>'estado' = any (orden)
       and array_position(orden, p_pedido->>'estado') > array_position(orden, v_ped.estado) then
      v_nuevo_estado := p_pedido->>'estado';
      v_evento := true;
    end if;

    update agente.pedidos p set
      estado          = v_nuevo_estado,
      items           = coalesce(v_items, p.items),
      total           = coalesce((p_pedido->>'total')::numeric, p.total),
      ciudad          = coalesce(p_pedido->>'ciudad', p.ciudad),
      zona            = coalesce(p_pedido->>'zona', p.zona),
      receptor_nombre = coalesce(p_pedido->>'receptor_nombre', p.receptor_nombre),
      receptor_tel    = coalesce(p_pedido->>'receptor_tel', p.receptor_tel),
      domicilio       = coalesce(p_pedido->>'domicilio', p.domicilio),
      referencias     = coalesce(p_pedido->>'referencias', p.referencias),
      horario         = coalesce(p_pedido->>'horario', p.horario),
      metodo_pago     = coalesce(p_pedido->>'metodo_pago', p.metodo_pago),
      ocasion         = coalesce(p_pedido->>'ocasion', p.ocasion),
      objecion        = coalesce(p_pedido->>'objecion', p.objecion),
      actualizado_en  = now()
    where p.id = v_ped.id;

    if v_evento then
      insert into agente.pedido_eventos (pedido_id, de, a, por, fuente_mensaje_id)
      values (v_ped.id, v_ped.estado, v_nuevo_estado, 'cerebro', p_mensaje);
    end if;
  end if;

  return jsonb_build_object('datos', n_datos, 'pedido_id', v_ped.id, 'estado', v_nuevo_estado);
end $$;

create or replace function agente.marcar_comprobante(p_id bigint, p_resultado text, p_por text)
returns text language plpgsql security definer
set search_path = agente, public as $$
declare v_c agente.comprobantes; v_ped agente.pedidos; v_de text;
begin
  if p_resultado not in ('pagado','no') then return 'resultado invalido'; end if;
  select * into v_c from agente.comprobantes where id = p_id for update;
  if v_c.id is null then return 'no existe el comprobante ' || p_id; end if;
  if v_c.resultado is not null then
    return 'ya estaba marcado: ' || v_c.resultado || ' (' || coalesce(v_c.validado_por, '?') || ')';
  end if;
  update agente.comprobantes set resultado = p_resultado, validado_por = p_por, validado_en = now()
   where id = p_id;
  if p_resultado = 'no' then return 'comprobante ' || p_id || ' marcado: NO pagado'; end if;

  select * into v_ped from agente.pedidos where id = v_c.pedido_id;
  if v_ped.id is null then
    select * into v_ped from agente.pedidos where contacto_id = v_c.contacto_id
       and estado in ('contacto','pregunto_precio','dio_talla','cotizado','pidio_entrega','pedido') limit 1;
  end if;
  if v_ped.id is null then
    insert into agente.pedidos (contacto_id, estado) values (v_c.contacto_id, 'pedido') returning * into v_ped;
  end if;
  v_de := v_ped.estado;
  update agente.pedidos set estado = 'pagado', actualizado_en = now() where id = v_ped.id;
  insert into agente.pedido_eventos (pedido_id, de, a, por, nota)
  values (v_ped.id, v_de, 'pagado', 'humano', 'comprobante ' || p_id || ' via ' || p_por);
  update agente.comprobantes set pedido_id = v_ped.id where id = p_id;
  update agente.contactos set n_pedidos = n_pedidos + 1,
         primer_pedido = coalesce(primer_pedido, now()), ultimo_pedido = now(),
         monto_total = monto_total + coalesce(v_ped.total, 0)
   where id = v_c.contacto_id;
  return 'pedido ' || v_ped.id || ' marcado PAGADO (antes: ' || v_de || ')';
end $$;

revoke all on function agente.avisar(text, jsonb, text) from public, anon, authenticated;
revoke all on function agente.abrir_turno(text, text, text, int, int, int) from public, anon, authenticated;
revoke all on function agente.aplicar_datos(text, bigint, text, jsonb, jsonb, uuid) from public, anon, authenticated;
revoke all on function agente.marcar_comprobante(bigint, text, text) from public, anon, authenticated;
