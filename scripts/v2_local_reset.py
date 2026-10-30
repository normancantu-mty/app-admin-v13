# -*- coding: ascii -*-
"""Rearma la base LOCAL de la v2 desde cero. SOLO LOCAL: nunca toca produccion.

Escrito el 2026-10-28 por el Socio (ejecutor), rama v2-arranque-limpio.

Por que no basta `supabase db reset`: 5 de las migraciones son correcciones de DATOS de
produccion (tickets de David Flores, backfills de mayo, costos de empaque, ml por SKU) con una
guarda que aborta si no encuentra esas filas. En una base vacia abortan, y `db reset` se detiene en
la primera. No se editan (regla del encargo); se saltan aqui con su motivo, y su efecto sobre el
catalogo ya viene en los datos copiados de produccion.

Pasos:
  1. `npx supabase db reset --local` con [db.migrations] y [db.seed] desactivados en config.toml
     (deja la base de Supabase limpia, sin nada nuestro).
  2. Aplica supabase/local_compat/*.sql y supabase/migrations/*.sql, una transaccion por archivo,
     con ON_ERROR_STOP; salta SALTAR. Las dos carpetas se MEZCLAN y se ordenan por version (nombre
     de archivo): es exactamente el orden de antes del 2026-10-30, cuando las dos de local_compat
     vivian en migrations/. Salieron de ahi para que la prueba de sincronia (ERP-73) no las exija en
     produccion; aqui se siguen aplicando y anotando igual, asi que la base local queda identica. Cada una aplicada se anota en supabase_migrations.schema_migrations, para que
     `npx supabase migration list --local` la vea.
  3. Corre supabase/seed_local/*.sql en orden (00 apaga cron, 50 datos de produccion si existe --
     ese archivo esta en .gitignore--, 60 usuarios de prueba).

Uso (desde la raiz del worktree):
  python scripts/v2_local_reset.py            # todo
  python scripts/v2_local_reset.py --sin-reset   # solo pasos 2-3 sobre la base actual
Sale 1 si una migracion no saltada falla.
"""
import os
import subprocess
import sys

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MIG = os.path.join(RAIZ, 'supabase', 'migrations')
# Solo local: esquema previo a la primera migracion y el cascaron de pg_net. NUNCA a produccion
# (el generador del corte, scripts/corte_produccion.py, rechaza cualquier ruta de esta carpeta).
LOCAL_COMPAT = os.path.join(RAIZ, 'supabase', 'local_compat')
SEED = os.path.join(RAIZ, 'supabase', 'seed_local')
CONT = 'supabase_db_app-admin-v2'   # project_id = "app-admin-v2" en config.toml
PUERTO_LOCAL = '55322'

SALTAR = {
    '20260902210527_corregir_dos_tickets_david_flores_cuenta_fiscal.sql':
        'UPDATE de 2 tickets de produccion; la v2 arranca sin tickets',
    '20260915005918_erp16_backfill_18_entradas_de_mayo_y_validar.sql':
        'backfill de 18 filas de inventario de mayo; la v2 arranca sin movimientos '
        '(su VALIDATE no hace falta: 20260918014009 recrea el CHECK ya validado)',
    '20260918021316_erp10_backfill_las_4_compras_de_insumo_que_nunca_se_capturaron.sql':
        'INSERT de 4 compras historicas; la v2 arranca sin movimientos',
    '20260918023056_erp26_los_11_costos_de_empaque_que_faltaban.sql':
        'UPDATE de costos en catalogo; ya vienen en el catalogo copiado de produccion',
    '20260918145818_erp84b_los_mililitros_contra_los_sku_que_de_verdad_existen.sql':
        'UPDATE de ml_por_unidad; ya viene en el catalogo copiado de produccion',
}


def psql(sql_bytes, una_transaccion=True):
    args = ['docker', 'exec', '-i', CONT, 'psql', '-U', 'postgres', '-d', 'postgres',
            '-v', 'ON_ERROR_STOP=1', '-q', '-X']
    if una_transaccion:
        args.append('-1')
    p = subprocess.run(args, input=sql_bytes, capture_output=True)
    return p.returncode, p.stderr.decode('utf-8', 'replace')


def config_desactivada():
    txt = open(os.path.join(RAIZ, 'supabase', 'config.toml'), encoding='utf-8').read()
    m = txt.split('[db.migrations]')[1].split('[')[0]
    s = txt.split('[db.seed]')[1].split('[')[0]
    return 'enabled = false' in m and 'enabled = false' in s


def main():
    if '--sin-reset' not in sys.argv:
        if not config_desactivada():
            sys.exit('config.toml: [db.migrations] y [db.seed] deben estar en enabled = false')
        r = subprocess.run('npx supabase db reset --local', shell=True, cwd=RAIZ)
        if r.returncode != 0:
            sys.exit('db reset --local fallo')

    # Garantia: el contenedor escucha en el puerto LOCAL de la v2.
    p = subprocess.run(['docker', 'port', CONT], capture_output=True, text=True)
    if PUERTO_LOCAL not in p.stdout:
        sys.exit('el contenedor %s no publica %s: no es la base local v2' % (CONT, PUERTO_LOCAL))

    psql(b"CREATE SCHEMA IF NOT EXISTS supabase_migrations;"
         b"CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations"
         b"(version text PRIMARY KEY, statements text[], name text);")

    fallas, saltadas, aplicadas = [], [], 0
    archivos = {}
    for carpeta in (LOCAL_COMPAT, MIG):
        if not os.path.isdir(carpeta):
            continue
        for x in os.listdir(carpeta):
            if x.endswith('.sql'):
                if x in archivos:
                    sys.exit('migracion repetida en local_compat/ y migrations/: %s' % x)
                archivos[x] = os.path.join(carpeta, x)
    for f in sorted(archivos):
        if f in SALTAR:
            saltadas.append(f)
            print('SALTA', f, '--', SALTAR[f])
            continue
        sql = open(archivos[f], 'rb').read()
        ver, nombre = f[:-4].split('_', 1)
        reg = ("\nINSERT INTO supabase_migrations.schema_migrations(version, name) "
               "VALUES ('%s', '%s') ON CONFLICT DO NOTHING;\n" % (ver, nombre)).encode()
        rc, err = psql(sql + reg)
        if rc != 0:
            linea = [e for e in err.splitlines() if 'ERROR' in e][:1]
            fallas.append((f, linea[0] if linea else err[:300]))
            print('FALLA', f, fallas[-1][1])
        else:
            aplicadas += 1
    print('migraciones: %d aplicadas, %d saltadas, %d fallas' % (aplicadas, len(saltadas), len(fallas)))
    if fallas:
        sys.exit(1)

    if os.path.isdir(SEED):
        for f in sorted(x for x in os.listdir(SEED) if x.endswith('.sql')):
            rc, err = psql(open(os.path.join(SEED, f), 'rb').read())
            print('seed', f, 'OK' if rc == 0 else 'FALLA ' + err[:400])
            if rc != 0:
                sys.exit(1)


if __name__ == '__main__':
    main()
