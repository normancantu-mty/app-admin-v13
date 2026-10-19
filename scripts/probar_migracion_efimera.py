# -*- coding: utf-8 -*-
"""Aplica migraciones NUEVAS sobre un Postgres EFIMERO con el esquema de produccion.

Escrito el 2026-10-19 por el ejecutor del Socio (lote v2).

Nunca toca produccion ni el stack de Supabase: levanta un cluster de Postgres
local (initdb en una carpeta temporal, puerto propio), le carga el volcado de
esquema del respaldo (`supabase/_respaldos/AAAA-MM-DD_schema.sql`, el ultimo),
aplica las migraciones pedidas con ON_ERROR_STOP y --single-transaction, corre
el archivo de comprobaciones (SQL que hace RAISE EXCEPTION si algo no cuadra) y
apaga y borra el cluster.

El volcado trae extensiones que solo existen en Supabase (pg_cron, pg_net,
pg_graphql, supabase_vault). Se quitan esas lineas y se crean antes los roles y
un `auth.uid()` de mentira; los errores que queden al cargar el volcado se
cuentan y se imprimen, pero NO deciden: lo que decide es que las migraciones
nuevas entren sin un solo error y que las comprobaciones pasen.

Uso:
  python scripts/probar_migracion_efimera.py <migracion.sql>... [--comprobar archivo.sql] [--volcado ruta]
Sale con 0 solo si todo paso.
"""
import glob
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

PG = os.environ.get("PG_BIN", r"C:\Program Files\PostgreSQL\16\bin")
PUERTO = os.environ.get("PG_PUERTO_EFIMERO", "54329")
RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESPALDOS = [os.path.join(RAIZ, "supabase", "_respaldos"),
             os.path.join(os.path.dirname(RAIZ), "app-admin", "supabase", "_respaldos")]

PRELUDIO = """
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname='supabase_admin') then create role supabase_admin nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticator') then create role authenticator nologin; end if;
  if not exists (select 1 from pg_roles where rolname='postgres') then create role postgres superuser; end if;
end $$;
create schema if not exists auth;
create schema if not exists extensions;
create schema if not exists graphql;
create schema if not exists vault;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
create table if not exists auth.users (id uuid primary key, email text);
create or replace function auth.uid() returns uuid language sql stable as $f$ select null::uuid $f$;
create or replace function auth.role() returns text language sql stable as $f$ select 'service_role'::text $f$;
create or replace function auth.jwt() returns jsonb language sql stable as $f$ select '{}'::jsonb $f$;
"""

SIN_EXTENSION = re.compile(r'^CREATE EXTENSION IF NOT EXISTS "(pg_cron|pg_net|pg_graphql|supabase_vault|pg_stat_statements)".*$', re.M)


def correr(args, **kw):
    return subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace", **kw)


def psql(*args, entrada=None):
    base = [os.path.join(PG, "psql"), "-h", "127.0.0.1", "-p", PUERTO, "-U", "postgres", "-d", "postgres", "-X", "-q"]
    return correr(base + list(args), input=entrada)


def ultimo_volcado():
    for carpeta in RESPALDOS:
        v = sorted(glob.glob(os.path.join(carpeta, "*_schema.sql")))
        if v:
            return v[-1]
    return None


def main(argv):
    migraciones, comprobar, volcado = [], None, None
    i = 0
    while i < len(argv):
        if argv[i] == "--comprobar":
            comprobar = argv[i + 1]
            i += 2
        elif argv[i] == "--volcado":
            volcado = argv[i + 1]
            i += 2
        else:
            migraciones.append(argv[i])
            i += 1
    volcado = volcado or ultimo_volcado()
    if not volcado or not migraciones:
        print("uso: probar_migracion_efimera.py <migracion.sql>... [--comprobar x.sql] [--volcado y.sql]")
        return 2
    print("volcado de esquema: " + volcado)
    datos = tempfile.mkdtemp(prefix="pg_efimero_")
    ok = False
    try:
        r = correr([os.path.join(PG, "initdb"), "-D", datos, "-U", "postgres", "-A", "trust", "-E", "UTF8", "--locale=C"])
        if r.returncode != 0:
            print("initdb fallo: " + r.stderr[-800:])
            return 1
        # Sin capturar la salida: en Windows el postmaster hereda las tuberias y
        # `capture_output` se queda esperando para siempre.
        rc = subprocess.call([os.path.join(PG, "pg_ctl"), "-D", datos, "-o", "-p " + PUERTO, "-l",
                              os.path.join(datos, "log.txt"), "-w", "start"],
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if rc != 0:
            print("pg_ctl start fallo, rc=%d (ver %s)" % (rc, os.path.join(datos, "log.txt")))
            return 1
        r = psql("-v", "ON_ERROR_STOP=1", entrada=PRELUDIO)
        if r.returncode != 0:
            print("preludio fallo: " + r.stderr[-800:])
            return 1
        with open(volcado, encoding="utf-8") as f:
            texto = SIN_EXTENSION.sub("-- (quitada en el efimero)", f.read())
        r = psql(entrada=texto)
        errores = [l for l in r.stderr.splitlines() if "ERROR" in l]
        print("volcado cargado: %d errores (no deciden; las primeras 5):" % len(errores))
        for l in errores[:5]:
            print("   " + l[:200])
        r = psql("-t", "-A", "-c", "select count(*) from information_schema.tables where table_schema='public' "
                 "and table_name in ('lotes','lote_salidas','lote_entradas','catalogo_productos','bot_borradores','bot_identidades','entidades')")
        print("tablas base presentes (de 7): " + r.stdout.strip())
        if r.stdout.strip() != "7":
            print("FALLA: el esquema base no quedo completo; no tiene sentido probar encima.")
            return 1
        for m in migraciones:
            r = psql("--single-transaction", "-v", "ON_ERROR_STOP=1", "-f", m)
            print("migracion %s -> rc=%d %s" % (os.path.basename(m), r.returncode, r.stderr.strip()[-600:]))
            if r.returncode != 0:
                return 1
        if comprobar:
            r = psql("-v", "ON_ERROR_STOP=1", "-f", comprobar)
            print("comprobaciones %s -> rc=%d" % (os.path.basename(comprobar), r.returncode))
            print((r.stdout.strip() + os.linesep + r.stderr.strip())[-4000:])
            if r.returncode != 0:
                return 1
        ok = True
        return 0
    finally:
        subprocess.call([os.path.join(PG, "pg_ctl"), "-D", datos, "-m", "immediate", "-w", "stop"],
                        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1)
        shutil.rmtree(datos, ignore_errors=True)
        print("RESULTADO: " + ("las migraciones entran y las comprobaciones pasan" if ok else "FALLA"))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
