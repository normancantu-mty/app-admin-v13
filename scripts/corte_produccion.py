# -*- coding: ascii -*-
"""GENERA el SQL del corte de la v2 a produccion. No conecta a produccion: escribe un archivo.

Escrito el 2026-10-30 por el Socio (ejecutor A2), rama v2-arranque-limpio. Plan aprobado:
~/.claude/plans/lazy-growing-grove.md (Fase A2.2), borrador Socio/_checkpoints/
PLAN_corte_produccion_erp_v2_2026-10-29.md (secciones 4, 5 y 8).

El archivo es UNA transaccion:
  SET client_encoding = 'UTF8' (el archivo es UTF-8 aunque el psql de Windows diga WIN1252);
  BEGIN; SET LOCAL lock_timeout/statement_timeout/TimeZone; LOCK de las 25 tablas del corte;
  (1) precondicion (RAISE si no se cumple): conteos y md5 de las 25 tablas iguales a los del
      respaldo restaurado (--conteos), ninguna de las 6 migraciones v2 aplicada, objetos v2
      inexistentes, la cuenta personal del ADMIN unica y ninguna cuenta con el UUID fijo de
      Transferencias;
  (2) las 6 migraciones v2, en orden de version, cada una con su fila en
      supabase_migrations.schema_migrations(version, name, statements);
  (3) DELETE de los movimientos en orden de llaves foraneas (NO bitacora, NO auditoria_logs);
  (4) la carga de arranque: el SQL de scripts/cargar_arranque.py construir(), con Transferencias
      en el UUID fijo y usuario_creador = --usuario. Sin seed_local, sin auth.users, sin tocar
      entidades.auth_id;
  (5) verificacion (RAISE si algo no cuadra): saldos, deuda, conteos, categorias, autor, auth_id,
      y HUELLAS de contenido: md5 de las filas cargadas de 6 tablas y de pg_get_functiondef /
      pg_get_viewdef de lo que crean las 6 migraciones. Ninguna condicion pasa con NULL
      (IF (cond) IS NOT TRUE / IS DISTINCT FROM);
  COMMIT;

Las huellas esperadas las calcula ESTE script: corre el mismo cuerpo (1)-(4) contra la copia
desechable (--fuente docker:...) dentro de una transaccion que termina en ROLLBACK, lee el md5 y
lo escribe en (5). Lo que cambia en cada corrida (uuid nuevos, now(), current_date, secuencias)
se normaliza: un uuid que no existia antes del corte sale como '<nuevo>', un timestamp igual a
now() como '<now>', una fecha igual a current_date como '<hoy>', y las columnas con default de
secuencia o aleatorio no entran.

De donde salen los ids: la carga necesita el catalogo, las entidades y las cuentas de produccion.
Se leen (solo lectura) de la COPIA DESECHABLE del respaldo (scripts/corte_copia_efimera.py), la
misma que da --conteos. Si produccion cambio despues del respaldo, la precondicion (md5 de esas
tablas) aborta y no se escribe nada: se repite respaldo -> copia -> generar.

Uso (desde la raiz del worktree):
  python scripts/corte_produccion.py --destino prod --generar supabase/_corte/corte_2026-10-30.sql \\
      --conteos supabase/_corte/copia_2026-10-30.json --fuente docker:pg17-corte \\
      --captura scripts/arranque_datos/captura_norman.json --consig conciliado \\
      --conciliacion C:/Users/norma/Documents/Claude/Socio/_checkpoints/conciliacion_locales_2026-10-29.json
Imprime el SHA-256 y el tamano del archivo, y lo deja tambien en <archivo>.sha256.
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cargar_arranque as ca  # noqa: E402
import corte_copia_efimera as cce  # noqa: E402

RAIZ = ca.RAIZ
MIG = os.path.join(RAIZ, 'supabase', 'migrations')
MIGRACIONES_V2 = [
    '20261028120000_v2_compat_grants_agente',
    '20261028120100_v2_cuentas_clase_y_saldo_inicial',
    '20261028120200_v2_categorias_movimiento',
    '20261028120300_v2_transferencias_conversion',
    '20261029120000_v2_cartera_acreedor',
    '20261029120100_v2_devolucion_fisica_cubeta',
]
# Las cifras que el plan aprobado da por buenas (conciliacion vigente del 2026-10-29). Si la
# captura o la conciliacion dicen otra cosa, no se genera sin --acepto-cifras-nuevas.
CIFRAS_PLAN = {'EFECTIVO': 4690.00, 'FISCAL': 12059.33, 'TRANSFERENCIAS': 599.00, 'PERSONAL': 0.00,
               'cargo_deuda': 68537.93, 'categorias': 64}
# Orden de borrado, verificado contra pg_constraint de la copia del respaldo 2026-10-30:
# cotizaciones -> tickets, finanzas_ledger -> tickets, ticket_detalles -> tickets (cascade),
# cotizacion_detalles -> cotizaciones (cascade), conteo_detalles -> conteos_fisicos,
# lote_* -> lotes (cascade). avisos_captura y bot_borradores no tienen FK a movimientos.
BORRAR = ['avisos_captura', 'bot_borradores', 'cotizacion_detalles', 'cotizaciones', 'finanzas_ledger',
          'ticket_detalles', 'transacciones_tickets', 'inventario_ledger', 'conteo_detalles',
          'conteos_fisicos', 'lote_recordatorios', 'lote_etapas', 'lote_envasado', 'lote_salidas',
          'lote_entradas', 'lotes']
LOCK = ['finanzas_ledger', 'inventario_ledger', 'transacciones_tickets', 'ticket_detalles', 'cotizaciones',
        'cotizacion_detalles', 'avisos_captura', 'bot_borradores', 'cuentas_financieras', 'entidades',
        'catalogo_productos', 'listas_precios', 'recetas_produccion', 'receta_liquido_estandar',
        'bot_identidades', 'parametros_costo', 'conteos_fisicos', 'conteo_detalles', 'lotes',
        'lote_entradas', 'lote_salidas', 'lote_envasado', 'lote_etapas', 'lote_recordatorios',
        'bot_categorias']
# Conteo Y md5 de las 25 tablas del corte (las de corte_copia_efimera.TABLAS_CORTE, una sola lista):
# si cualquiera cambio despues del respaldo, la precondicion aborta (auditoria 2026-10-30, punto 2).
CONTEOS_OBLIGATORIOS = list(cce.TABLAS_CORTE)
MD5_OBLIGATORIOS = list(cce.TABLAS_CORTE)
assert set(LOCK) == set(cce.TABLAS_CORTE), 'LOCK y TABLAS_CORTE no son las mismas 25 tablas'
# Tablas cuyo CONTENIDO cargado se verifica con huella dentro de la transaccion (punto 4).
HUELLA_TABLAS = ['finanzas_ledger', 'inventario_ledger', 'categorias_movimiento', 'catalogo_productos',
                 'cuentas_financieras', 'entidades']
VOLATIL = re.compile(r'(?i)nextval|gen_random_uuid|uuid_generate|random\(|clock_timestamp|statement_timestamp|timeofday')
SESION_MD5 = ("SET TimeZone='UTC'; SET DateStyle='ISO, MDY'; SET IntervalStyle='postgres'; "
              "SET extra_float_digits=1; SET bytea_output='hex'; ")
PROHIBIDO_FUENTE = ('supabase_db_app-admin-v2', 'supabase_db_app-admin-dev', '55322', '54322',
                    'gnnqxtsdrbvmlkhfemjw', 'pooler.supabase.com', 'supabase.co')
PSQL_LOCAL = os.environ.get('PSQL', r'C:\Program Files\PostgreSQL\16\bin\psql.exe')
ETQ = '$corte_v2$'


def md5_sql(tabla):
    """El mismo md5 que scripts/corte_copia_efimera.py (orden COLLATE "C", sesion en UTC)."""
    return ("(SELECT md5(coalesce(string_agg(x.t, E'\\n' ORDER BY x.t COLLATE \"C\"), '')) "
            "FROM (SELECT r::text AS t FROM public.%s r) x)" % tabla)


def expr_col(col, tipo, default):
    """Texto estable de una columna para la huella (None = la columna no entra)."""
    c = 'r."%s"' % col
    if tipo == 'uuid':
        return ("CASE WHEN %s IS NULL THEN NULL WHEN %s IN (SELECT u FROM _corte_ids) THEN %s::text "
                "ELSE '<nuevo>' END" % (c, c, c))
    if VOLATIL.search(default or ''):
        return None
    if tipo.startswith('timestamp'):
        return "CASE WHEN %s = now() THEN '<now>' ELSE %s::text END" % (c, c)
    if tipo == 'date':
        return "CASE WHEN %s = current_date THEN '<hoy>' ELSE %s::text END" % (c, c)
    return '%s::text' % c


def huella_sql(tabla, exprs):
    return ("(SELECT md5(coalesce(string_agg(x.t, E'\\n' ORDER BY x.t COLLATE \"C\"), '')) "
            "FROM (SELECT ROW(%s)::text AS t FROM public.%s r) x)" % (', '.join(exprs), tabla))


def objeto_sql(clase, esquema, nombre):
    """count:md5 de la definicion de las funciones (todas las sobrecargas) o de la vista."""
    if clase == 'funcion':
        return ("(SELECT count(*)::text || ':' || md5(coalesce(string_agg(d, E'\\n' ORDER BY d COLLATE \"C\"), '')) "
                "FROM (SELECT pg_get_functiondef(p.oid) AS d FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace "
                "WHERE ns.nspname = '%s' AND p.proname = '%s' AND p.prokind IN ('f', 'p')) x)" % (esquema, nombre))
    return ("(SELECT count(*)::text || ':' || md5(coalesce(string_agg(pg_get_viewdef(c.oid, true), E'\\n'), '')) "
            "FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace "
            "WHERE ns.nspname = '%s' AND c.relname = '%s' AND c.relkind IN ('v', 'm'))" % (esquema, nombre))


def objetos_de_migraciones():
    """(clase, esquema, nombre) de cada CREATE FUNCTION / CREATE VIEW de las 6 migraciones."""
    vistos = []
    for m in MIGRACIONES_V2:
        # Sin comentarios: "-- CREATE OR REPLACE VIEW solo admite..." no es una vista.
        txt = re.sub(r'(?s)/\*.*?\*/', ' ', re.sub(r'--[^\n]*', ' ', leer_migracion(m)))
        for clase, pat in (('funcion', r'create\s+(?:or\s+replace\s+)?function\s+'),
                           ('vista', r'create\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+')):
            for s, n in re.findall(r'(?i)' + pat + r'(?:"?(\w+)"?\.)?"?(\w+)"?', txt):
                k = (clase, (s or 'public').lower(), n.lower())
                if k not in vistos:
                    vistos.append(k)
    return vistos


def ensayar(fuente, sql):
    """Corre sql (que termina en ROLLBACK) contra la copia DESECHABLE y devuelve sus filas."""
    if not fuente.startswith('docker:') or any(p in fuente for p in PROHIBIDO_FUENTE + cce.PROHIBIDOS):
        sys.exit('las huellas se ensayan solo contra la copia desechable docker:<contenedor>: %s' % fuente)
    if not sql.rstrip().endswith('ROLLBACK;'):
        sys.exit('el ensayo de las huellas tiene que terminar en ROLLBACK')
    p = subprocess.run(['docker', 'exec', '-i', fuente[7:], 'psql', '-U', 'postgres', '-d', 'postgres',
                        '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-A', '-t', '-F', '\t'],
                       input=sql.encode('utf-8'), capture_output=True)
    if p.returncode:
        sys.exit('el ensayo del cuerpo (1)-(4) contra la copia fallo:\n' + p.stderr.decode('utf-8', 'replace')[-3000:])
    return [l.split('\t') for l in p.stdout.decode('utf-8', 'replace').splitlines() if l.strip()]


def ruta_prohibida(ruta):
    r = os.path.abspath(ruta).replace('\\', '/').lower()
    return '/seed_local/' in r or '/local_compat/' in r or r.endswith(('/seed_local', '/local_compat'))


def lector(fuente):
    """filas(sql) de SOLO LECTURA contra la copia desechable."""
    if any(p in fuente for p in PROHIBIDO_FUENTE):
        sys.exit('--fuente %s no es la copia desechable del respaldo: no leo de ahi.' % fuente)
    pre = 'SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;\n'
    if fuente.startswith('docker:'):
        base = ['docker', 'exec', '-i', fuente[7:], 'psql', '-U', 'postgres', '-d', 'postgres']
    elif fuente.startswith(('postgres://', 'postgresql://')):
        base = [PSQL_LOCAL, '-d', fuente]
    else:
        sys.exit('--fuente: docker:<contenedor> o postgresql://...')

    def filas(sql):
        p = subprocess.run(base + ['-v', 'ON_ERROR_STOP=1', '-X', '-q', '-A', '-t', '-F', '\t'],
                           input=(pre + sql).encode('utf-8'), capture_output=True,
                           env=dict(os.environ, PGCLIENTENCODING='UTF8'))
        if p.returncode:
            sys.exit('lectura de la fuente fallo:\n' + p.stderr.decode('utf-8', 'replace'))
        return [l.split('\t') for l in p.stdout.decode('utf-8', 'replace').splitlines() if l.strip()]
    return filas


def leer_migracion(nombre):
    ruta = os.path.join(MIG, nombre + '.sql')
    if ruta_prohibida(ruta) or os.path.dirname(os.path.abspath(ruta)) != os.path.abspath(MIG):
        sys.exit('migracion fuera de supabase/migrations: %s' % ruta)
    txt = open(ruta, encoding='utf-8').read()
    # Un BEGIN/COMMIT suelto dentro del archivo cerraria la transaccion del corte a la mitad.
    txt = re.sub(r'(?im)^\s*(begin|commit|start\s+transaction)\s*;\s*$', '-- (quitado por el corte)', txt)
    if re.search(r'(?i)\bconcurrently\b', txt):
        sys.exit('%s usa CONCURRENTLY: no cabe en una transaccion' % nombre)
    if ETQ in txt:
        sys.exit('%s contiene %s' % (nombre, ETQ))
    return txt


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--destino', required=True, choices=['prod'])
    ap.add_argument('--generar', required=True)
    ap.add_argument('--conteos', required=True, help='JSON de corte_copia_efimera.py o {tabla: n}')
    ap.add_argument('--fuente', required=True, help='docker:pg17-corte (copia desechable del respaldo)')
    ap.add_argument('--captura', required=True)
    ap.add_argument('--consig', choices=['cero', 'libro', 'capturo', 'conciliado'], default='conciliado')
    ap.add_argument('--conciliacion')
    ap.add_argument('--usuario', default='arranque@corte-2026-10-30')
    ap.add_argument('--acepto-cifras-nuevas', action='store_true')
    a = ap.parse_args()
    a.seco, a.ejemplo = False, False

    for r in [a.generar, a.conteos, a.captura] + ([a.conciliacion] if a.conciliacion else []):
        if ruta_prohibida(r):
            sys.exit('ruta prohibida en el corte (seed_local/ o local_compat/): %s' % r)

    cont = json.load(open(a.conteos, encoding='utf-8'))
    n_esp = cont.get('conteos', cont)
    md5_esp = cont.get('md5', {})
    faltan = [t for t in CONTEOS_OBLIGATORIOS if t not in n_esp] + \
             ['md5:' + t for t in MD5_OBLIGATORIOS if t not in md5_esp]
    if faltan:
        sys.exit('--conteos no trae: %s (usa el JSON de scripts/corte_copia_efimera.py)' % faltan)

    cap = json.load(open(a.captura, encoding='utf-8'))
    cap = cap.get('data', cap)
    if not cap.get('listo'):
        sys.exit('La captura no esta marcada como lista (listo != true).')

    filas = lector(a.fuente)
    # La copia tiene que ser ESE respaldo: mismos conteos y md5 que dice --conteos.
    for t in sorted(set(CONTEOS_OBLIGATORIOS) | set(k for k in n_esp if k in LOCK)):
        n = int(filas('SELECT count(*) FROM public.%s' % t)[0][0])
        if n != int(n_esp[t]):
            sys.exit('la fuente no es la copia de --conteos: %s tiene %d y --conteos dice %s' % (t, n, n_esp[t]))
    for t in MD5_OBLIGATORIOS:
        m = filas(SESION_MD5 + "SELECT " + md5_sql(t))[0][0]
        if m != md5_esp[t]:
            sys.exit('la fuente no es la copia de --conteos: md5 de %s distinto' % t)
    if filas("SELECT 1 FROM supabase_migrations.schema_migrations WHERE version IN (%s)"
             % ', '.join("'%s'" % v.split('_', 1)[0] for v in MIGRACIONES_V2)):
        sys.exit('la fuente ya tiene migraciones v2: no es un respaldo de antes del corte')

    carga, reporte, esp = ca.construir(cap, a, filas, usuario=a.usuario, corte_prod=True)
    for s in carga:
        if 'auth.users' in s or re.search(r'(?i)auth_id\s*=', s) or 'seed_local' in s:
            sys.exit('la carga toca auth o seed_local: no genero.\n' + s[:300])

    difiere = {k: (esp['saldos'].get(k, esp.get(k)), v) for k, v in CIFRAS_PLAN.items()
               if round(float(esp['saldos'].get(k, esp.get(k)) or 0), 2) != round(v, 2)}
    if esp['abono_deuda']:
        difiere['abono_deuda'] = (esp['abono_deuda'], 0)
    if difiere and not a.acepto_cifras_nuevas:
        sys.exit('las cifras de la captura/conciliacion no son las del plan (obtenido, plan): %s. '
                 'Si es a proposito: --acepto-cifras-nuevas' % difiere)

    quitar_ent = esp['quitar_ent']
    con_login = filas("SELECT id, nombre, auth_id FROM entidades WHERE auth_id IS NOT NULL AND id IN (%s)"
                      % (', '.join(ca.q(u) for u in quitar_ent) or 'NULL'))
    vers = [m.split('_', 1)[0] for m in MIGRACIONES_V2]
    lista_vers = ', '.join("'%s'" % v for v in vers)
    lista_quitar = ', '.join(ca.q(u) for u in quitar_ent) or 'NULL::uuid'
    lista_quitar_prod = ', '.join(ca.q(u) for u in esp['quitar_prod']) or 'NULL::uuid'
    U = ca.q(a.usuario)

    # Columnas uuid de las tablas de la huella ANTES del corte: sus valores son los "ids que ya
    # existian"; cualquier uuid que la carga genere al azar sale en la huella como '<nuevo>'.
    uuid_pre = filas("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' "
                     "AND data_type = 'uuid' AND table_name IN (%s) ORDER BY 1, 2"
                     % ', '.join("'%s'" % t for t in HUELLA_TABLAS))
    if not uuid_pre:
        sys.exit('la fuente no tiene columnas uuid en las tablas de la huella: no es la copia del respaldo')
    objetos = objetos_de_migraciones()

    out = []
    w = out.append
    w("SET client_encoding = 'UTF8';")
    w('-- CORTE ERP v2 -> produccion. GENERADO por scripts/corte_produccion.py el %s. NO EDITAR A MANO:'
      % cont.get('fecha', '?'))
    w('-- se regenera con el comando del encabezado de ese script. Una sola transaccion: si cualquier')
    w('-- RAISE salta, no queda nada escrito. Fuente de ids: %s; conteos: %s.'
      % (a.fuente, os.path.basename(a.conteos)))
    w('BEGIN;')
    w("SET LOCAL lock_timeout = '10s';")
    w("SET LOCAL statement_timeout = '5min';")
    # El md5 de la precondicion compara el texto de cada fila contra el de la copia: se fija todo
    # lo que cambia como se ve una fila (zona, fechas, flotantes, bytea).
    w("SET LOCAL TimeZone = 'UTC';")
    w("SET LOCAL DateStyle = 'ISO, MDY';")
    w("SET LOCAL IntervalStyle = 'postgres';")
    w("SET LOCAL extra_float_digits = 1;")
    w("SET LOCAL bytea_output = 'hex';")
    w('LOCK TABLE %s IN EXCLUSIVE MODE;' % ', '.join('public.' + t for t in LOCK))
    w('')
    w('-- (1) PRECONDICION ' + '-' * 70)
    conds = []
    for t in sorted(set(CONTEOS_OBLIGATORIOS) | set(k for k in n_esp if k in LOCK)):
        conds.append("  IF (SELECT count(*) FROM public.%s) IS DISTINCT FROM %d THEN\n"
                     "    RAISE EXCEPTION 'precondicion: %s tiene %% filas y el respaldo %d', (SELECT count(*) FROM public.%s);\n"
                     "  END IF;" % (t, int(n_esp[t]), t, int(n_esp[t]), t))
    for t in MD5_OBLIGATORIOS:
        conds.append("  IF %s IS DISTINCT FROM '%s' THEN\n    RAISE EXCEPTION 'precondicion: %s cambio desde el respaldo (md5)';\n  END IF;"
                     % (md5_sql(t), md5_esp[t], t))
    conds.append("  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version IN (%s)) THEN\n"
                 "    RAISE EXCEPTION 'precondicion: ya hay migraciones v2 aplicadas';\n  END IF;" % lista_vers)
    conds.append("  IF to_regclass('public.categorias_movimiento') IS NOT NULL OR to_regclass('public.conversiones_transferencia') IS NOT NULL\n"
                 "     OR to_regprocedure('public.saldo_cuenta(uuid)') IS NOT NULL\n"
                 "     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='cuentas_financieras' AND column_name='clase') THEN\n"
                 "    RAISE EXCEPTION 'precondicion: hay objetos v2 sin su fila en schema_migrations';\n  END IF;")
    conds.append("  IF NOT EXISTS (SELECT 1 FROM public.entidades WHERE id = %s AND rol = 'ADMIN') THEN\n"
                 "    RAISE EXCEPTION 'precondicion: no existe el CEO Admin %s';\n  END IF;" % (ca.q(ca.ADMIN), ca.ADMIN))
    conds.append("  IF EXISTS (SELECT 1 FROM public.cuentas_financieras WHERE id = %s OR (id_entidad = %s AND nombre = 'Transferencias')) THEN\n"
                 "    RAISE EXCEPTION 'precondicion: ya existe la cuenta Transferencias o el UUID %s';\n  END IF;"
                 % (ca.q(ca.TRANSFERENCIAS_ID), ca.q(ca.ADMIN), ca.TRANSFERENCIAS_ID))
    conds.append("  IF (SELECT count(*) FROM public.cuentas_financieras WHERE id_entidad = %s AND nombre IN (%s, %s)) IS DISTINCT FROM 1 THEN\n"
                 "    RAISE EXCEPTION 'precondicion: no hay UNA cuenta personal del ADMIN';\n  END IF;"
                 % (ca.q(ca.ADMIN), ca.q(ca.NOMBRE_VIEJO_PERSONAL), ca.q(ca.NOMBRE_CUENTA['personal'])))
    w('DO $pre$\nBEGIN\n' + '\n'.join(conds) + '\nEND\n$pre$;')
    # Estado previo que la verificacion compara: logins de las entidades que se quedan, conteos.
    w("CREATE TEMP TABLE _corte_pre ON COMMIT DROP AS SELECT\n"
      "  (SELECT count(*) FROM supabase_migrations.schema_migrations) AS n_mig,\n"
      "  (SELECT count(*) FROM public.entidades) AS n_ent,\n"
      "  (SELECT count(*) FROM public.bitacora) AS n_bitacora,\n"
      "  (SELECT coalesce(string_agg(id::text || '=' || auth_id::text, ',' ORDER BY id), '') FROM public.entidades\n"
      "    WHERE auth_id IS NOT NULL AND id NOT IN (%s)) AS logins;" % lista_quitar)
    # Los uuid que ya existian (para la huella de (5)); Transferencias entra con su UUID fijo.
    w("CREATE TEMP TABLE _corte_ids ON COMMIT DROP AS SELECT DISTINCT u FROM (\n  %s\n  UNION ALL SELECT %s::uuid\n) z WHERE u IS NOT NULL;"
      % ('\n  UNION ALL '.join('SELECT "%s" AS u FROM public.%s' % (c, t) for t, c in uuid_pre), ca.q(ca.TRANSFERENCIAS_ID)))
    w('')
    w('-- (2) MIGRACIONES v2 ' + '-' * 68)
    for m in MIGRACIONES_V2:
        txt = leer_migracion(m)
        ver, nombre = m.split('_', 1)
        w('-- >>> %s.sql' % m)
        w(txt.rstrip())
        w("INSERT INTO supabase_migrations.schema_migrations(version, name, statements) VALUES ('%s', '%s', ARRAY[%s%s%s]);"
          % (ver, nombre, ETQ, txt, ETQ))
        w('-- <<< %s.sql' % m)
    w('')
    w('-- (3) BORRADO DE MOVIMIENTOS, en orden de llaves foraneas. NO bitacora, NO auditoria_logs ' + '-' * 5)
    for t in BORRAR:
        w('DELETE FROM public.%s;' % t)
    w('')
    w('-- (4) CARGA DE ARRANQUE (cargar_arranque.construir) ' + '-' * 40)
    w('\n'.join(carga))
    w('')

    # ---- Huellas: el cuerpo (1)-(4) se ensaya dos veces contra la copia, con ROLLBACK. -------
    cuerpo = '\n'.join(out) + '\n'
    cols = ensayar(a.fuente, cuerpo +
                   "SELECT table_name, column_name, data_type, coalesce(column_default, '') FROM information_schema.columns\n"
                   " WHERE table_schema = 'public' AND table_name IN (%s) ORDER BY table_name, ordinal_position;\nROLLBACK;\n"
                   % ', '.join("'%s'" % t for t in HUELLA_TABLAS))
    exprs = {t: [] for t in HUELLA_TABLAS}
    fuera = {t: [] for t in HUELLA_TABLAS}
    for t, c, tipo, dflt in cols:
        e = expr_col(c, tipo, dflt)
        (exprs[t].append(e) if e else fuera[t].append(c))
    if any(not exprs[t] for t in HUELLA_TABLAS):
        sys.exit('una tabla de la huella no tiene columnas: %s' % exprs)
    huellas = [('tabla ' + t, huella_sql(t, exprs[t])) for t in HUELLA_TABLAS] + \
              [('%s %s.%s' % o, objeto_sql(*o)) for o in objetos]
    res = ensayar(a.fuente, cuerpo + SESION_MD5.replace('SET ', 'SET LOCAL ') + '\n' +
                  '\nUNION ALL '.join("SELECT %s, %s" % (ca.q(k), e) for k, e in huellas) + ';\nROLLBACK;\n')
    esperado_h = dict((k, val) for k, val in res)
    if sorted(esperado_h) != sorted(k for k, _ in huellas):
        sys.exit('el ensayo no devolvio todas las huellas: %s' % esperado_h)
    for k, val in esperado_h.items():
        if not k.startswith('tabla ') and val.startswith('0:'):
            sys.exit('%s no existe despues de las migraciones: la huella no probaria nada' % k)

    w('-- (5) VERIFICACION ' + '-' * 70)
    v = []

    def chk(cond, msg, *args):
        # IS NOT TRUE: una condicion que da NULL (fila que no existe) FALLA, no pasa.
        v.append("  IF (%s) IS NOT TRUE THEN\n    RAISE EXCEPTION %s%s;\n  END IF;"
                 % (cond, ca.q('verificacion: ' + msg), ''.join(', ' + x for x in args)))

    def chk_igual(expr, esperado, msg, *args):
        v.append("  IF (%s) IS DISTINCT FROM (%s) THEN\n    RAISE EXCEPTION %s%s;\n  END IF;"
                 % (expr, esperado, ca.q('verificacion: ' + msg), ''.join(', ' + x for x in args)))

    nombres = {'EFECTIVO': 'Efectivo', 'FISCAL': 'Cuenta Fresnillo', 'TRANSFERENCIAS': 'Transferencias',
               'PERSONAL': 'Cuenta Gilberto'}
    for clase, monto in sorted(esp['saldos'].items()):
        sel = "(SELECT public.saldo_cuenta(id) FROM public.cuentas_financieras WHERE id_entidad = %s AND clase = '%s')" % (ca.q(ca.ADMIN), clase)
        chk_igual(sel, '%.2f' % monto, 'saldo %s = %% y se esperaba %.2f' % (clase, monto), sel)
        chk_igual("(SELECT nombre FROM public.cuentas_financieras WHERE id_entidad = %s AND clase = '%s')" % (ca.q(ca.ADMIN), clase),
                  ca.q(nombres[clase]), 'la cuenta %s no se llama %s' % (clase, nombres[clase]))
    chk_igual("(SELECT count(*) FROM public.cuentas_financieras WHERE id_entidad = %s AND clase IS NOT NULL)" % ca.q(ca.ADMIN), '4',
              'el ADMIN no tiene exactamente 4 cuentas con clase')
    chk_igual("(SELECT clase FROM public.cuentas_financieras WHERE id = %s)" % ca.q(ca.TRANSFERENCIAS_ID), "'TRANSFERENCIAS'",
              'Transferencias no quedo en el UUID fijo %s' % ca.TRANSFERENCIAS_ID)
    chk_igual("(SELECT solo_egresos AND tipo_fiscalidad = 'LIBRE' FROM public.cuentas_financieras WHERE id_entidad = %s AND clase = 'PERSONAL')"
              % ca.q(ca.ADMIN), 'true', 'la cuenta personal no es LIBRE y solo egresos')
    s_cargo = "(SELECT coalesce(sum(monto), 0) FROM public.finanzas_ledger WHERE tipo_movimiento = 'CARGO_DEUDA')"
    chk_igual(s_cargo, '%.2f' % esp['cargo_deuda'], 'CARGO_DEUDA = %% y se esperaba %.2f' % esp['cargo_deuda'], s_cargo)
    chk_igual("(SELECT coalesce(sum(monto), 0) FROM public.finanzas_ledger WHERE tipo_movimiento = 'ABONO_DEUDA')", '%.2f' % esp['abono_deuda'],
              'ABONO_DEUDA distinto de %.2f' % esp['abono_deuda'])
    n_fin = esp['n_saldo_inicial'] + esp['n_deuda']
    chk_igual("(SELECT count(*) FROM public.finanzas_ledger)", '%d' % n_fin, 'finanzas_ledger no tiene %d filas' % n_fin)
    chk("NOT EXISTS (SELECT 1 FROM public.finanzas_ledger WHERE categoria IS DISTINCT FROM 'ARRANQUE' OR usuario_creador IS DISTINCT FROM %s)" % U,
        'hay filas de finanzas que no son de la carga de arranque')
    n_inv = esp['n_bodega'] + esp['n_consignacion']
    chk_igual("(SELECT count(*) FROM public.inventario_ledger)", '%d' % n_inv, 'inventario_ledger no tiene %d filas' % n_inv)
    chk("NOT EXISTS (SELECT 1 FROM public.inventario_ledger WHERE usuario_creador IS DISTINCT FROM %s)" % U,
        'hay filas de inventario que no son de la carga de arranque')
    chk_igual("(SELECT count(*) FROM public.categorias_movimiento)", '%d' % esp['categorias'],
              'categorias_movimiento no tiene %d filas' % esp['categorias'])
    for t in ('transacciones_tickets', 'ticket_detalles', 'cotizaciones', 'cotizacion_detalles', 'avisos_captura',
              'bot_borradores', 'conversiones_transferencia'):
        chk_igual("(SELECT count(*) FROM public.%s)" % t, '0', '%s no quedo en 0' % t)
    chk_igual("(SELECT count(*) FROM supabase_migrations.schema_migrations)", "(SELECT n_mig FROM _corte_pre) + 6",
              'schema_migrations no crecio exactamente 6')
    chk_igual("(SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version IN (%s))" % lista_vers, '6',
              'faltan migraciones v2 en schema_migrations')
    chk_igual("(SELECT count(*) FROM public.entidades)", "(SELECT n_ent FROM _corte_pre) - %d" % len(quitar_ent),
              'entidades no bajo exactamente %d' % len(quitar_ent))
    chk("NOT EXISTS (SELECT 1 FROM public.entidades WHERE id IN (%s))" % lista_quitar, 'quedo una entidad que se quitaba')
    chk("NOT EXISTS (SELECT 1 FROM public.catalogo_productos WHERE id IN (%s))" % lista_quitar_prod, 'quedo un producto que se quitaba')
    chk_igual("(SELECT coalesce(string_agg(id::text || '=' || auth_id::text, ',' ORDER BY id), '') FROM public.entidades WHERE auth_id IS NOT NULL)",
              "(SELECT logins FROM _corte_pre)", 'cambiaron los logins (auth_id) de las entidades que se quedan')
    chk("(SELECT count(*) FROM public.bitacora) >= (SELECT n_bitacora FROM _corte_pre)", 'la bitacora perdio filas')
    chk("(SELECT valor FROM public.parametros_costo WHERE clave = 'comision_conversion_transferencias_pct') IS NOT NULL",
        'falta el parametro de comision de conversion')
    # Huellas de contenido, con el valor que dio el ensayo contra la copia del respaldo.
    for k, e in huellas:
        chk_igual(e, ca.q(esperado_h[k]), 'huella de %s distinta del ensayo (%s): %%' % (k, esperado_h[k]), e)
    w('DO $ver$\nBEGIN\n' + '\n'.join(v) + "\n  RAISE NOTICE 'CORTE v2: todas las verificaciones pasaron (%d chequeos, %d huellas)';\nEND\n$ver$;"
      % (len(v), len(huellas)))
    w('COMMIT;')
    texto = '\n'.join(out) + '\n'

    os.makedirs(os.path.dirname(os.path.abspath(a.generar)), exist_ok=True)
    with open(a.generar, 'w', encoding='utf-8', newline='\n') as f:
        f.write(texto)
    datos = open(a.generar, 'rb').read()
    h = hashlib.sha256(datos).hexdigest()
    with open(a.generar + '.sha256', 'w', encoding='ascii', newline='\n') as f:
        f.write('%s  %s\n' % (h, os.path.basename(a.generar)))
    print('\n'.join('  - ' + r for r in reporte))
    print('\nesperado: %s' % json.dumps({k: v for k, v in esp.items() if k not in ('quitar_ent', 'quitar_prod')}, sort_keys=True))
    if con_login:
        print('\nENTIDADES QUE SE QUITAN Y TIENEN LOGIN (auth.users NO se toca; queda huerfano):')
        for i, nmb, au in con_login:
            print('  %s | %s | auth_id %s' % (i, nmb, au))
    print('\nhuellas (ensayo contra %s; columnas que no entran: %s):'
          % (a.fuente, dict((t, c) for t, c in fuera.items() if c)))
    for k, val in sorted(esperado_h.items()):
        print('  %s = %s' % (k, val))
    print('\nGENERADO %s\n  bytes  %d\n  sha256 %s' % (os.path.abspath(a.generar), len(datos), h))


if __name__ == '__main__':
    main()
