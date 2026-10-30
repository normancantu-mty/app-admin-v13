# -*- coding: ascii -*-
"""ROLLBACK del corte ERP v2: down_v2.sql + recarga de las tablas del ERP desde el respaldo.

Escrito el 2026-10-30 por el Socio (ejecutor A2), rama v2-arranque-limpio. Implementa el
borrador del plan de corte, seccion 8.3 (rollback por TABLAS, no de la base entera: el esquema
`agente` sigue escribiendo y no se toca).

Arma UN archivo SQL y lo corre en UNA transaccion (psql -1 implicito: BEGIN ... COMMIT):
  1. precondicion: las 6 migraciones v2 estan aplicadas (si no, no hay nada que deshacer);
  2. supabase/_corte/down_v2.sql (vacia las 25 tablas y deshace el DDL de las 6 migraciones);
  3. ALTER TABLE ... DISABLE TRIGGER USER en las 25 tablas (tg_forzar_autor no reescribe el
     autor y tg_bitacora no llena auditoria_logs con la recarga);
  4. los INSERT del volcado de datos (npm run respaldo) de esas 25 tablas, padres primero, y el
     setval de las secuencias que usan;
  5. ENABLE TRIGGER USER;
  6. verificacion con RAISE: count(*) y md5 de cada tabla iguales a los del respaldo restaurado
     en la copia (scripts/corte_copia_efimera.py, el JSON de --conteos), y cero filas v2 en
     schema_migrations.
El SQL generado trae datos del negocio: se escribe en supabase/_corte/ (en .gitignore).

Uso:
  python scripts/corte_rollback.py --volcado C:/.../_respaldos/2026-10-30_datos.sql \\
      --conteos supabase/_corte/copia_2026-10-30.json --contenedor pg17-corte     (ensayo)
  python scripts/corte_rollback.py ... --dsn postgresql://...                     (produccion)
  python scripts/corte_rollback.py ... --solo-generar                             (sin correr)
Imprime el tiempo que tardo la transaccion.
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOWN = os.path.join(RAIZ, 'supabase', '_corte', 'down_v2.sql')
PSQL_LOCAL = os.environ.get('PSQL', r'C:\Program Files\PostgreSQL\16\bin\psql.exe')
PROHIBIDOS = ('supabase_db_app-admin-v2', 'supabase_db_app-admin-dev', 'supabase_db_paridad-copia')
# Padres primero (inverso del orden de borrado de down_v2.sql).
RECARGA = ['bot_categorias', 'parametros_costo', 'catalogo_productos', 'entidades', 'cuentas_financieras',
           'receta_liquido_estandar', 'recetas_produccion', 'listas_precios', 'bot_identidades',
           'lotes', 'lote_entradas', 'lote_salidas', 'lote_envasado', 'lote_etapas', 'lote_recordatorios',
           'conteos_fisicos', 'conteo_detalles', 'inventario_ledger', 'transacciones_tickets',
           'ticket_detalles', 'finanzas_ledger', 'cotizaciones', 'cotizacion_detalles', 'bot_borradores',
           'avisos_captura']
VERSIONES_V2 = ['20261028120000', '20261028120100', '20261028120200', '20261028120300',
                '20261029120000', '20261029120100']


def md5_sql(tabla):
    """El mismo md5 que scripts/corte_copia_efimera.py y corte_produccion.py."""
    return ("(SELECT md5(coalesce(string_agg(x.t, E'\\n' ORDER BY x.t COLLATE \"C\"), '')) "
            "FROM (SELECT r::text AS t FROM public.%s r) x)" % tabla)


def secciones(texto):
    for p in re.split(r'\n(?=--\n-- (?:Data for )?Name: )', texto):
        m = re.search(r'^-- (?:Data for )?Name: ([^;]*); Type: ([^;]*); Schema: ([^;]+);', p, re.M)
        if m:
            yield m.group(1), m.group(2), m.group(3), p


def secuencias_de(esquema, tablas):
    """Secuencias que usan las tablas recargadas, leidas del volcado de esquema (el de Supabase no
    trae comentarios de seccion): defaults con nextval, identidades y OWNED BY."""
    seqs = set()
    for t in tablas:
        m = re.search(r'CREATE TABLE IF NOT EXISTS "public"\."%s" \((.*?)\n\);' % re.escape(t), esquema, re.S)
        if m:
            seqs.update(re.findall(r'nextval"?\(\'"public"\."([^"]+)"\'', m.group(1)))
        for m in re.finditer(r'ALTER TABLE (?:ONLY )?"public"\."%s" ALTER COLUMN "[^"]+" ADD GENERATED [A-Z ]+ AS IDENTITY \(\s*'
                             r'SEQUENCE NAME "public"\."([^"]+)"' % re.escape(t), esquema):
            seqs.add(m.group(1))
    for m in re.finditer(r'ALTER SEQUENCE "public"\."([^"]+)" OWNED BY "public"\."([^"]+)"\.', esquema):
        if m.group(2) in tablas:
            seqs.add(m.group(1))
    return seqs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--volcado', required=True, help='AAAA-MM-DD_datos.sql del respaldo de ANTES del corte')
    ap.add_argument('--conteos', required=True, help='copia_<fecha>.json de corte_copia_efimera.py (mismo respaldo)')
    ap.add_argument('--down', default=DOWN)
    ap.add_argument('--dsn')
    ap.add_argument('--contenedor')
    ap.add_argument('--solo-generar', action='store_true')
    ap.add_argument('--salida')
    a = ap.parse_args()
    if not a.solo_generar and bool(a.dsn) == bool(a.contenedor):
        sys.exit('uno de --dsn o --contenedor (o --solo-generar)')
    if a.contenedor in PROHIBIDOS:
        sys.exit('%s no es un destino de rollback: no corro.' % a.contenedor)

    cont = json.load(open(a.conteos, encoding='utf-8'))
    n_esp, md5_esp = cont['conteos'], cont['md5']
    datos_b = open(a.volcado, 'rb').read()
    if cont.get('volcado_datos_sha256') and hashlib.sha256(datos_b).hexdigest() != cont['volcado_datos_sha256']:
        sys.exit('--conteos no es de este volcado (sha256 distinto)')
    datos = datos_b.decode('utf-8')
    f_esq = re.sub(r'_datos\.sql$', '_schema.sql', a.volcado)
    seqs = secuencias_de(open(f_esq, encoding='utf-8').read(), set(RECARGA))

    por_tabla, setvals = {}, []
    for nombre, tipo, esq, p in secciones(datos):
        if esq != 'public':
            continue
        if tipo == 'TABLE DATA' and nombre in RECARGA:
            por_tabla[nombre] = p
        elif tipo == 'SEQUENCE SET' and nombre in seqs:
            setvals.append(p)
    for t in RECARGA:
        if n_esp.get(t, 0) and t not in por_tabla:
            sys.exit('el volcado no trae datos de %s y --conteos dice %s filas' % (t, n_esp[t]))

    out = ['-- ROLLBACK del corte v2. GENERADO por scripts/corte_rollback.py; trae datos: no se versiona.',
           'BEGIN;', "SET LOCAL lock_timeout = '10s';", "SET LOCAL statement_timeout = '10min';",
           "SET LOCAL TimeZone = 'UTC';", "SET LOCAL DateStyle = 'ISO, MDY';",
           "SET LOCAL IntervalStyle = 'postgres';", "SET LOCAL extra_float_digits = 1;",
           "SET LOCAL bytea_output = 'hex';",
           "DO $pre$ BEGIN IF (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version IN (%s)) <> 6 THEN "
           "RAISE EXCEPTION 'rollback: las 6 migraciones v2 no estan aplicadas; no hay corte que deshacer'; END IF; END $pre$;"
           % ', '.join("'%s'" % v for v in VERSIONES_V2),
           open(a.down, encoding='utf-8').read()]
    out += ['ALTER TABLE public.%s DISABLE TRIGGER USER;' % t for t in RECARGA]
    for t in RECARGA:
        if t in por_tabla:
            out.append(por_tabla[t])
    out += setvals
    out += ['ALTER TABLE public.%s ENABLE TRIGGER USER;' % t for t in RECARGA]
    v = []
    for t in RECARGA:
        v.append("  IF (SELECT count(*) FROM public.%s) <> %d OR %s <> '%s' THEN\n"
                 "    RAISE EXCEPTION 'rollback: %s no quedo igual al respaldo (%% filas)', (SELECT count(*) FROM public.%s);\n  END IF;"
                 % (t, int(n_esp.get(t, 0)), md5_sql(t), md5_esp[t], t, t))
    v.append("  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version IN (%s)) THEN\n"
             "    RAISE EXCEPTION 'rollback: quedan filas v2 en schema_migrations';\n  END IF;"
             % ', '.join("'%s'" % x for x in VERSIONES_V2))
    out.append("DO $ver$\nBEGIN\n%s\n  RAISE NOTICE 'ROLLBACK v2: las %d tablas quedaron iguales al respaldo';\nEND\n$ver$;"
               % ('\n'.join(v), len(RECARGA)))
    out.append('COMMIT;')
    sql = '\n'.join(out) + '\n'
    salida = a.salida or os.path.join(RAIZ, 'supabase', '_corte', 'rollback_%s.sql' % cont.get('fecha', 'x'))
    os.makedirs(os.path.dirname(salida), exist_ok=True)
    open(salida, 'w', encoding='utf-8', newline='\n').write(sql)
    print('generado %s (%d bytes, sha256 %s); secuencias: %s'
          % (salida, len(sql.encode()), hashlib.sha256(sql.encode()).hexdigest(), sorted(seqs)))
    if a.solo_generar:
        return
    if a.contenedor:
        args = ['docker', 'exec', '-i', a.contenedor, 'psql', '-U', 'postgres', '-d', 'postgres']
        env = None
    else:
        args = [PSQL_LOCAL, '-d', a.dsn]
        env = dict(os.environ, PGCLIENTENCODING='UTF8')
    t0 = time.time()
    p = subprocess.run(args + ['-X', '-q', '-v', 'ON_ERROR_STOP=1'], input=sql.encode('utf-8'),
                       capture_output=True, env=env)
    dt = time.time() - t0
    err = p.stderr.decode('utf-8', 'replace')
    print('\n'.join(l for l in err.splitlines() if 'NOTICE:  ROLLBACK' in l or 'ERROR' in l))
    print('rc=%d en %.1f s' % (p.returncode, dt))
    sys.exit(p.returncode)


if __name__ == '__main__':
    main()
