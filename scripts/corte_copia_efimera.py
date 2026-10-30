# -*- coding: ascii -*-
"""Restaura el respaldo de produccion (npm run respaldo) en un Postgres 17 DESECHABLE y cuenta.

Escrito el 2026-10-30 por el Socio (ejecutor A2), rama v2-arranque-limpio.

NUNCA toca produccion ni el contenedor local de la v2: solo habla con el contenedor que se le
pasa (por defecto `pg17-corte`, el del ensayo del corte) y se niega a correr contra
`supabase_db_app-admin-v2`. Levantar el contenedor es aparte:

  docker run --rm -d --name pg17-corte -p 55440:5432 -e POSTGRES_PASSWORD=<al azar> postgres:17

Pasos (mismo criterio que scripts/probar_migracion_efimera.py):
  1. Preludio: roles de Supabase (anon, authenticated, service_role, ...), esquemas auth,
     extensions, graphql, vault, net, storage, cron, supabase_migrations; auth.uid()/jwt()/role()
     de mentira; cascarones de net._http_response, net.http_request_queue, net.http_post y
     vault.decrypted_secrets (el volcado los referencia; pg_net y vault solo existen en Supabase).
  2. Esquema del volcado sin las extensiones exclusivas de Supabase. Los errores se cuentan.
  3. Datos del volcado: solo esquemas public, agente y socio (auth y storage no: ninguna FK del
     ERP apunta a auth.users, y el corte no los toca). El volcado ya trae
     `SET session_replication_role = replica` (sin triggers ni FK al cargar).
  4. supabase_migrations.schema_migrations con las versiones de `master` (produccion = master,
     supuesto S1 del plan, medido con list_migrations el 2026-10-30): el volcado no las trae.
  5. Conteos por tabla de la copia vs filas del volcado (por tabla), y md5 de las tablas que el
     corte toca. Escribe supabase/_corte/copia_<fecha>.json.

Uso:
  python scripts/corte_copia_efimera.py --fecha 2026-10-30 [--contenedor pg17-corte]
         [--respaldos C:/Users/norma/Documents/Cursor/app-admin/supabase/_respaldos]
         [--solo-conteos]      (no restaura; solo cuenta lo que ya hay)
Sale 0 solo si las tablas del corte coinciden fila por fila con el volcado.
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO_MASTER = os.path.join(os.path.dirname(RAIZ), 'app-admin')
RESPALDOS = os.path.join(REPO_MASTER, 'supabase', '_respaldos')
PROHIBIDOS = ('supabase_db_app-admin-v2', 'supabase_db_app-admin-dev', 'supabase_db_paridad-copia')

# Las tablas que el corte toca (borra, carga o altera). Se cuentan y se les saca md5.
TABLAS_CORTE = [
    'entidades', 'cuentas_financieras', 'catalogo_productos', 'listas_precios', 'recetas_produccion',
    'receta_liquido_estandar', 'parametros_costo', 'bot_identidades', 'bot_categorias',
    'finanzas_ledger', 'inventario_ledger', 'transacciones_tickets', 'ticket_detalles',
    'cotizaciones', 'cotizacion_detalles', 'avisos_captura', 'bot_borradores',
    'conteos_fisicos', 'conteo_detalles', 'lotes', 'lote_entradas', 'lote_salidas', 'lote_envasado',
    'lote_etapas', 'lote_recordatorios',
]

PRELUDIO = r"""
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin noinherit bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname='supabase_admin') then create role supabase_admin nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticator') then create role authenticator nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='supabase_auth_admin') then create role supabase_auth_admin nologin; end if;
  if not exists (select 1 from pg_roles where rolname='supabase_storage_admin') then create role supabase_storage_admin nologin; end if;
end $$;
create schema if not exists auth;
create schema if not exists extensions;
create schema if not exists graphql;
create schema if not exists vault;
create schema if not exists storage;
create schema if not exists cron;
create schema if not exists net;
create schema if not exists supabase_migrations;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
create table if not exists auth.users (id uuid primary key, email text);
create or replace function auth.uid() returns uuid language sql stable as $f$ select null::uuid $f$;
create or replace function auth.role() returns text language sql stable as $f$ select 'service_role'::text $f$;
create or replace function auth.jwt() returns jsonb language sql stable as $f$ select '{}'::jsonb $f$;
create table if not exists net.http_request_queue (id bigserial primary key, method text, url text,
  headers jsonb, body bytea, timeout_milliseconds integer);
create table if not exists net._http_response (id bigint, status_code integer, content_type text,
  headers jsonb, content text, timed_out boolean, error_msg text, created timestamptz not null default now());
create or replace function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
  headers jsonb default '{}'::jsonb, timeout_milliseconds integer default 5000)
  returns bigint language sql as $f$ select 0::bigint $f$;
create or replace function net.http_get(url text, params jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb,
  timeout_milliseconds integer default 5000) returns bigint language sql as $f$ select 0::bigint $f$;
create table if not exists vault.decrypted_secrets (id uuid, name text, description text, secret text,
  decrypted_secret text, key_id uuid, nonce bytea, created_at timestamptz, updated_at timestamptz);
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[],
  name text, created_by text, idempotency_key text unique, rollback text[]);
"""

SIN_EXTENSION = re.compile(
    r'^(CREATE EXTENSION IF NOT EXISTS "(pg_cron|pg_net|pg_graphql|supabase_vault|pg_stat_statements)"'
    r'|COMMENT ON EXTENSION "(pg_cron|pg_net|pg_graphql|supabase_vault|pg_stat_statements)").*$', re.M)
ESQUEMAS_DATOS = ('public', 'agente', 'socio')


def psql(cont, sql, tuplas=False, parar=False):
    args = ['docker', 'exec', '-i', cont, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q']
    if parar:
        args += ['-v', 'ON_ERROR_STOP=1']
    if tuplas:
        args += ['-A', '-t', '-F', '\t']
    p = subprocess.run(args, input=sql.encode('utf-8'), capture_output=True)
    return p.returncode, p.stdout.decode('utf-8', 'replace'), p.stderr.decode('utf-8', 'replace')


def filas(cont, sql):
    rc, out, err = psql(cont, sql, tuplas=True, parar=True)
    if rc:
        sys.exit('psql fallo: ' + err[-800:])
    return [l.split('\t') for l in out.splitlines() if l.strip()]


def secciones(texto):
    """Parte un volcado de pg_dump en secciones '--\\n-- Name|Data for Name: ...; Schema: X'."""
    partes = re.split(r'\n(?=--\n-- (?:Data for )?Name: )', texto)
    for p in partes:
        m = re.search(r'^-- (?:Data for )?Name: [^;]*; Type: [^;]*; Schema: ([^;]+);', p, re.M)
        yield (m.group(1) if m else None), p


def filas_en_volcado(texto):
    """Filas por tabla en el volcado de datos: renglones '\\t(' dentro de cada INSERT multi-fila."""
    n = {}
    for esquema, p in secciones(texto):
        m = re.search(r'^INSERT INTO "([^"]+)"\."([^"]+)"', p, re.M)
        if m:
            k = '%s.%s' % (m.group(1), m.group(2))
            n[k] = n.get(k, 0) + len(re.findall(r'^\t\(', p, re.M))
    return n


def versiones_master():
    p = subprocess.run(['git', '-C', REPO_MASTER, 'ls-tree', '--name-only', 'master', 'supabase/migrations/'],
                       capture_output=True, text=True)
    if p.returncode:
        sys.exit('git ls-tree master fallo: ' + p.stderr)
    return [os.path.basename(x)[:-4] for x in p.stdout.split() if x.endswith('.sql')]


def conteos(cont):
    """count(*) de cada tabla public y md5 de las del corte (orden por el texto de la fila, UTC)."""
    tablas = [r[0] for r in filas(cont, "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1")]
    sel = ' UNION ALL '.join("SELECT %s, count(*) FROM public.%s" % ("'" + t + "'", '"' + t + '"') for t in tablas)
    n = {t: int(c) for t, c in filas(cont, sel)}
    md5 = {}
    for t in TABLAS_CORTE:
        if t in n:
            md5[t] = filas(cont, "SET TimeZone='UTC'; SET DateStyle='ISO, MDY'; SET IntervalStyle='postgres'; "
                                 "SET extra_float_digits=1; SET bytea_output='hex'; SELECT md5(coalesce(string_agg(x.t, E'\\n' ORDER BY x.t COLLATE \"C\"), '')) "
                                 "FROM (SELECT r::text AS t FROM public.%s r) x" % t)[0][0]
    return n, md5


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--fecha', required=True)
    ap.add_argument('--contenedor', default='pg17-corte')
    ap.add_argument('--respaldos', default=RESPALDOS)
    ap.add_argument('--solo-conteos', action='store_true')
    ap.add_argument('--salida')
    a = ap.parse_args()
    if a.contenedor in PROHIBIDOS:
        sys.exit('%s no es un contenedor desechable: no corro.' % a.contenedor)
    f_esq = os.path.join(a.respaldos, a.fecha + '_schema.sql')
    f_dat = os.path.join(a.respaldos, a.fecha + '_datos.sql')
    for f in (f_esq, f_dat):
        if not os.path.exists(f):
            sys.exit('falta ' + f)
    datos = open(f_dat, encoding='utf-8').read()

    if not a.solo_conteos:
        ya = filas(a.contenedor, "SELECT count(*) FROM pg_tables WHERE schemaname='public'")[0][0]
        if ya != '0':
            sys.exit('el contenedor ya tiene %s tablas en public: restaura sobre uno limpio.' % ya)
        rc, _, err = psql(a.contenedor, PRELUDIO, parar=True)
        if rc:
            sys.exit('preludio fallo: ' + err[-800:])
        esquema = SIN_EXTENSION.sub('-- (quitada en la copia desechable)', open(f_esq, encoding='utf-8').read())
        rc, _, err = psql(a.contenedor, esquema)
        errores = [l for l in err.splitlines() if 'ERROR' in l]
        print('esquema: %d errores' % len(errores))
        for l in errores:
            print('   ' + l[:220])
        guardadas, saltadas = [], {}
        for esq, p in secciones(datos):
            if esq is None or esq in ESQUEMAS_DATOS:
                guardadas.append(p)
            else:
                saltadas[esq] = saltadas.get(esq, 0) + 1
        rc, _, err = psql(a.contenedor, '\n'.join(guardadas))
        errores = [l for l in err.splitlines() if 'ERROR' in l]
        print('datos: %d errores; secciones saltadas por esquema: %s' % (len(errores), saltadas))
        for l in errores:
            print('   ' + l[:220])
        vers = versiones_master()
        ins = ''.join("INSERT INTO supabase_migrations.schema_migrations(version, name) VALUES ('%s', '%s');\n"
                      % tuple(v.split('_', 1)) for v in vers)
        rc, _, err = psql(a.contenedor, ins, parar=True)
        if rc:
            sys.exit('schema_migrations fallo: ' + err[-500:])
        print('schema_migrations: %d versiones de master' % len(vers))

    n, md5 = conteos(a.contenedor)
    en_volcado = filas_en_volcado(datos)
    fallas = []
    for t in TABLAS_CORTE:
        esperado = en_volcado.get('public.' + t, 0)
        if t not in n:
            fallas.append('%s no existe en la copia' % t)
        elif n[t] != esperado:
            fallas.append('%s: copia %d vs volcado %d' % (t, n[t], esperado))
    otras = [t for t in n if t not in TABLAS_CORTE and n[t] != en_volcado.get('public.' + t, 0)]
    print('tabla | copia | volcado')
    for t in TABLAS_CORTE:
        print('%s | %s | %s' % (t, n.get(t), en_volcado.get('public.' + t, 0)))
    if otras:
        print('otras tablas public que no cuadran (no deciden): %s' % otras)
    salida = a.salida or os.path.join(RAIZ, 'supabase', '_corte', 'copia_%s.json' % a.fecha)
    os.makedirs(os.path.dirname(salida), exist_ok=True)
    h = hashlib.sha256(open(f_dat, 'rb').read()).hexdigest()
    json.dump({'fecha': a.fecha, 'volcado_datos_sha256': h, 'conteos': n, 'md5': md5,
               'filas_en_volcado': {k: v for k, v in en_volcado.items() if k.startswith('public.')}},
              open(salida, 'w', encoding='utf-8'), indent=1, sort_keys=True)
    print('escrito %s' % salida)
    if fallas:
        print('FALLA: ' + '; '.join(fallas))
        sys.exit(1)
    print('OK: las %d tablas del corte coinciden con el volcado' % len(TABLAS_CORTE))


if __name__ == '__main__':
    main()
