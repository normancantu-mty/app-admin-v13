# -*- coding: ascii -*-
"""GENERA el SQL del corte de la v2 a produccion. No conecta a produccion: escribe un archivo.

Escrito el 2026-10-30 por el Socio (ejecutor A2), rama v2-arranque-limpio. Plan aprobado:
~/.claude/plans/lazy-growing-grove.md (Fase A2.2), borrador Socio/_checkpoints/
PLAN_corte_produccion_erp_v2_2026-10-29.md (secciones 4, 5 y 8).

El archivo es UNA transaccion:
  BEGIN; SET LOCAL lock_timeout/statement_timeout/TimeZone; LOCK de las tablas del corte;
  (1) precondicion (RAISE si no se cumple): conteos y md5 iguales a los del respaldo restaurado
      (--conteos), ninguna de las 6 migraciones v2 aplicada, objetos v2 inexistentes, la cuenta
      personal del ADMIN unica y ninguna cuenta con el UUID fijo de Transferencias;
  (2) las 6 migraciones v2, en orden de version, cada una con su fila en
      supabase_migrations.schema_migrations(version, name, statements);
  (3) DELETE de los movimientos en orden de llaves foraneas (NO bitacora, NO auditoria_logs);
  (4) la carga de arranque: el SQL de scripts/cargar_arranque.py construir(), con Transferencias
      en el UUID fijo y usuario_creador = --usuario. Sin seed_local, sin auth.users, sin tocar
      entidades.auth_id;
  (5) verificacion (RAISE si algo no cuadra): saldos, deuda, conteos, categorias, autor, auth_id;
  COMMIT;

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
        'lote_entradas', 'lote_salidas', 'lote_envasado', 'lote_etapas', 'lote_recordatorios']
# Conteos obligatorios en --conteos (plan A2.2); el resto de las tablas del corte, si vienen.
CONTEOS_OBLIGATORIOS = ['finanzas_ledger', 'inventario_ledger', 'transacciones_tickets', 'ticket_detalles',
                        'bot_borradores']
# md5 de lo que la carga LEE para armar sus ids: si cambio despues del respaldo, aborta.
MD5_OBLIGATORIOS = ['entidades', 'cuentas_financieras', 'catalogo_productos', 'listas_precios',
                    'recetas_produccion', 'receta_liquido_estandar', 'bot_identidades', 'parametros_costo']
PROHIBIDO_FUENTE = ('supabase_db_app-admin-v2', 'supabase_db_app-admin-dev', '55322', '54322',
                    'gnnqxtsdrbvmlkhfemjw', 'pooler.supabase.com', 'supabase.co')
PSQL_LOCAL = os.environ.get('PSQL', r'C:\Program Files\PostgreSQL\16\bin\psql.exe')
ETQ = '$corte_v2$'


def md5_sql(tabla):
    """El mismo md5 que scripts/corte_copia_efimera.py (orden COLLATE "C", sesion en UTC)."""
    return ("(SELECT md5(coalesce(string_agg(x.t, E'\\n' ORDER BY x.t COLLATE \"C\"), '')) "
            "FROM (SELECT r::text AS t FROM public.%s r) x)" % tabla)


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
        m = filas("SET TimeZone='UTC'; SET DateStyle='ISO, MDY'; SET IntervalStyle='postgres'; "
                  "SET extra_float_digits=1; SET bytea_output='hex'; SELECT " + md5_sql(t))[0][0]
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

    out = []
    w = out.append
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
        conds.append("  IF (SELECT count(*) FROM public.%s) <> %d THEN\n"
                     "    RAISE EXCEPTION 'precondicion: %s tiene %% filas y el respaldo %d', (SELECT count(*) FROM public.%s);\n"
                     "  END IF;" % (t, int(n_esp[t]), t, int(n_esp[t]), t))
    for t in MD5_OBLIGATORIOS:
        conds.append("  IF %s <> '%s' THEN\n    RAISE EXCEPTION 'precondicion: %s cambio desde el respaldo (md5)';\n  END IF;"
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
    conds.append("  IF (SELECT count(*) FROM public.cuentas_financieras WHERE id_entidad = %s AND nombre IN (%s, %s)) <> 1 THEN\n"
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
    w('-- (5) VERIFICACION ' + '-' * 70)
    v = []

    def chk(cond, msg, *args):
        v.append("  IF NOT (%s) THEN\n    RAISE EXCEPTION %s%s;\n  END IF;"
                 % (cond, ca.q('verificacion: ' + msg), ''.join(', ' + x for x in args)))

    nombres = {'EFECTIVO': 'Efectivo', 'FISCAL': 'Cuenta Fresnillo', 'TRANSFERENCIAS': 'Transferencias',
               'PERSONAL': 'Cuenta Gilberto'}
    for clase, monto in sorted(esp['saldos'].items()):
        sel = "(SELECT public.saldo_cuenta(id) FROM public.cuentas_financieras WHERE id_entidad = %s AND clase = '%s')" % (ca.q(ca.ADMIN), clase)
        chk("%s = %.2f" % (sel, monto), 'saldo %s = %% y se esperaba %.2f' % (clase, monto), sel)
        chk("(SELECT nombre FROM public.cuentas_financieras WHERE id_entidad = %s AND clase = '%s') = %s"
            % (ca.q(ca.ADMIN), clase, ca.q(nombres[clase])), 'la cuenta %s no se llama %s' % (clase, nombres[clase]))
    chk("(SELECT count(*) FROM public.cuentas_financieras WHERE id_entidad = %s AND clase IS NOT NULL) = 4" % ca.q(ca.ADMIN),
        'el ADMIN no tiene exactamente 4 cuentas con clase')
    chk("(SELECT clase FROM public.cuentas_financieras WHERE id = %s) = 'TRANSFERENCIAS'" % ca.q(ca.TRANSFERENCIAS_ID),
        'Transferencias no quedo en el UUID fijo %s' % ca.TRANSFERENCIAS_ID)
    chk("(SELECT solo_egresos AND tipo_fiscalidad = 'LIBRE' FROM public.cuentas_financieras WHERE id_entidad = %s AND clase = 'PERSONAL')"
        % ca.q(ca.ADMIN), 'la cuenta personal no es LIBRE y solo egresos')
    s_cargo = "(SELECT coalesce(sum(monto), 0) FROM public.finanzas_ledger WHERE tipo_movimiento = 'CARGO_DEUDA')"
    chk("%s = %.2f" % (s_cargo, esp['cargo_deuda']), 'CARGO_DEUDA = %% y se esperaba %.2f' % esp['cargo_deuda'], s_cargo)
    chk("(SELECT coalesce(sum(monto), 0) FROM public.finanzas_ledger WHERE tipo_movimiento = 'ABONO_DEUDA') = %.2f" % esp['abono_deuda'],
        'ABONO_DEUDA distinto de %.2f' % esp['abono_deuda'])
    n_fin = esp['n_saldo_inicial'] + esp['n_deuda']
    chk("(SELECT count(*) FROM public.finanzas_ledger) = %d" % n_fin, 'finanzas_ledger no tiene %d filas' % n_fin)
    chk("NOT EXISTS (SELECT 1 FROM public.finanzas_ledger WHERE categoria IS DISTINCT FROM 'ARRANQUE' OR usuario_creador IS DISTINCT FROM %s)" % U,
        'hay filas de finanzas que no son de la carga de arranque')
    n_inv = esp['n_bodega'] + esp['n_consignacion']
    chk("(SELECT count(*) FROM public.inventario_ledger) = %d" % n_inv, 'inventario_ledger no tiene %d filas' % n_inv)
    chk("NOT EXISTS (SELECT 1 FROM public.inventario_ledger WHERE usuario_creador IS DISTINCT FROM %s)" % U,
        'hay filas de inventario que no son de la carga de arranque')
    chk("(SELECT count(*) FROM public.categorias_movimiento) = %d" % esp['categorias'],
        'categorias_movimiento no tiene %d filas' % esp['categorias'])
    for t in ('transacciones_tickets', 'ticket_detalles', 'cotizaciones', 'cotizacion_detalles', 'avisos_captura',
              'bot_borradores', 'conversiones_transferencia'):
        chk("(SELECT count(*) FROM public.%s) = 0" % t, '%s no quedo en 0' % t)
    chk("(SELECT count(*) FROM supabase_migrations.schema_migrations) = (SELECT n_mig FROM _corte_pre) + 6",
        'schema_migrations no crecio exactamente 6')
    chk("(SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version IN (%s)) = 6" % lista_vers,
        'faltan migraciones v2 en schema_migrations')
    chk("(SELECT count(*) FROM public.entidades) = (SELECT n_ent FROM _corte_pre) - %d" % len(quitar_ent),
        'entidades no bajo exactamente %d' % len(quitar_ent))
    chk("NOT EXISTS (SELECT 1 FROM public.entidades WHERE id IN (%s))" % lista_quitar, 'quedo una entidad que se quitaba')
    chk("NOT EXISTS (SELECT 1 FROM public.catalogo_productos WHERE id IN (%s))" % lista_quitar_prod, 'quedo un producto que se quitaba')
    chk("(SELECT coalesce(string_agg(id::text || '=' || auth_id::text, ',' ORDER BY id), '') FROM public.entidades WHERE auth_id IS NOT NULL)"
        " = (SELECT logins FROM _corte_pre)", 'cambiaron los logins (auth_id) de las entidades que se quedan')
    chk("(SELECT count(*) FROM public.bitacora) >= (SELECT n_bitacora FROM _corte_pre)", 'la bitacora perdio filas')
    chk("(SELECT valor FROM public.parametros_costo WHERE clave = 'comision_conversion_transferencias_pct') IS NOT NULL",
        'falta el parametro de comision de conversion')
    w('DO $ver$\nBEGIN\n' + '\n'.join(v) + "\n  RAISE NOTICE 'CORTE v2: todas las verificaciones pasaron';\nEND\n$ver$;")
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
    print('\nGENERADO %s\n  bytes  %d\n  sha256 %s' % (os.path.abspath(a.generar), len(datos), h))


if __name__ == '__main__':
    main()
