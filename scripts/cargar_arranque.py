# -*- coding: utf-8 -*-
"""Carga de ARRANQUE de la v2 del ERP sobre la base LOCAL. Nunca toca produccion.

Escrito el 2026-10-28 por el Socio (ejecutor), rama v2-arranque-limpio.

Lee la captura de Norman (artefacto "ERP arranque", coleccion `captura`, doc `norman`,
exportada a JSON) y aplica, en UNA transaccion contra el contenedor local
`supabase_db_app-admin-v2` (puerto 55322):

  1. Catalogo: quita los productos marcados `q`, renombra/ajusta (Aditivo 1, Levadura y
     enzimas en kg a $1580 con 0.02 kg por lote) y da de alta los `nuevos`.
  2. Entidades: quita las marcadas en `ent` (con sus cuentas). Antes revisa que nada
     las referencie (hijos en la red, identidades del bot) y aborta si algo lo hace.
  3. Cuentas del CEO Admin: clase de cada cuenta; la antigua "Cuenta personal" se
     RENOMBRA "Cuenta Gilberto" (Norman, 2026-10-29) y queda LIBRE, en 0 y solo egresos; crea "Transferencias" con la fiscalidad `t_fis`; comision `t_pct`.
     Saldo inicial por cuenta = una fila SALDO_INICIAL con fecha del corte (sin IVA/IEPS).
  4. Inventario de bodega contado: ENTRADA_COMPRA a la Matriz, cubeta PAGADO, sin
     movimiento de dinero (no genera IVA/IEPS ni gasto).
  5. Consignacion y saldo por local/distribuidor segun --consig:
       cero        nadie arranca con consignacion ni deuda              (default)
       libro       lo que dice el libro de produccion (libro_produccion.json, leido con
                   SELECT el 2026-10-29: v_saldo_entidad y v_stock_por_cubeta)
       capturo     lo que Norman capturo en el artefacto (`cons`, `deuda`)
       conciliado  la conciliacion por local (--conciliacion, JSON
                   {entidad: {consignacion: {"750","250","50","pasta"}, deuda, fantasma,
                   descartado, nota}}), o envuelto en {"_meta", "entidades"}.
                   `fantasma` y `descartado` NO se cargan: se reportan y quedan en la
                   nota del movimiento. Si `acreedor` no coincide con el padre de la
                   entidad (Matriz = sin padre), aborta: el ERP deriva el acreedor de
                   la jerarquia, no lo guarda en la deuda.
     Consignacion = ENTRADA_CONCESION al local (cubeta CONSIGNADO). Deuda = CARGO_DEUDA
     (o ABONO_DEUDA si es a favor del local) sin cuenta: mueve v_saldo_entidad y no la
     liquidez de la Matriz.
  6. Categorias cerradas: las de la captura a `categorias_movimiento`.

Uso (desde la raiz del worktree):
  python scripts/cargar_arranque.py --captura scripts/arranque_datos/captura_norman.json
  python scripts/cargar_arranque.py --captura ... --consig conciliado \
      --conciliacion C:/Users/norma/Documents/Claude/Socio/_checkpoints/conciliacion_locales_2026-10-29.json
  --seco       arma y ejecuta todo dentro de una transaccion que se deshace (ROLLBACK)
  --ejemplo    permite una captura sin `listo: true` (pruebas)

Se niega a correr dos veces sobre la misma base (busca filas con categoria ARRANQUE).

Corte a produccion (2026-10-30): el SQL de la carga lo arma `construir()`, que tambien usa
scripts/corte_produccion.py para GENERAR el archivo del corte (no conecta a produccion). Este
script, por si solo, sigue hablando SOLO con la base local. La cuenta Transferencias nace con un
UUID FIJO (TRANSFERENCIAS_ID) en los dos caminos, para que ERP_AGENTE_CUENTA_TRANSFERENCIA se
pueda fijar antes de cargar.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import unicodedata

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONT = 'supabase_db_app-admin-v2'
PUERTO_LOCAL = '55322'
ADMIN = 'e0000000-0000-0000-0000-000000000001'
# UUID fijo de la cuenta Transferencias del CEO Admin (plan de corte S7): LucIA la recibe en
# ERP_AGENTE_CUENTA_TRANSFERENCIA. Fijo en local y en produccion.
TRANSFERENCIAS_ID = 'e0000000-0000-0000-0000-0000000000f1'
# Autor de las filas de la carga. En el corte a produccion lo cambia construir(usuario=...).
USUARIO_LOCAL = 'arranque@v2.local'
LIBRO = os.path.join(RAIZ, 'scripts', 'arranque_datos', 'libro_produccion.json')
# Presentaciones de la consignacion: indice del artefacto (j), clave de la conciliacion, producto.
PRESENTACIONES = [
    (0, '750', 'c1000000-0000-0000-0000-000000000001'),
    (1, '250', 'c1000000-0000-0000-0000-000000000003'),
    (2, '50', 'c1000000-0000-0000-0000-000000000004'),
    (3, 'pasta', '9f310b3c-9924-4b63-b08b-a50a88795347'),
]
NOMBRE_CUENTA = {'efectivo': 'Efectivo', 'fresnillo': 'Cuenta Fresnillo',
                 'personal': 'Cuenta Gilberto', 'transferencias': 'Transferencias'}
# Norman, 2026-10-29: la cuenta de clase PERSONAL se llama "Cuenta Gilberto". La base de
# origen (copia de produccion) la trae como "Cuenta personal": se renombra en la carga.
# Despues de renombrar, todo lo demas la identifica por clase, no por nombre.
NOMBRE_VIEJO_PERSONAL = 'Cuenta personal'
CLASE = {'efectivo': 'EFECTIVO', 'fresnillo': 'FISCAL', 'personal': 'PERSONAL',
         'transferencias': 'TRANSFERENCIAS'}


def q(v):
    """Literal SQL. Los datos vienen de la captura: se citan, nunca se pegan crudos."""
    if v is None:
        return 'NULL'
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, (int, float)):
        return repr(round(float(v), 4))
    return "'" + str(v).replace("'", "''") + "'"


def psql(sql, tuplas=False):
    args = ['docker', 'exec', '-i', CONT, 'psql', '-U', 'postgres', '-d', 'postgres',
            '-v', 'ON_ERROR_STOP=1', '-X', '-q']
    if tuplas:
        args += ['-A', '-t', '-F', '\t']
    p = subprocess.run(args, input=sql.encode('utf-8'), capture_output=True)
    if p.returncode != 0:
        sys.exit('psql fallo:\n' + p.stderr.decode('utf-8', 'replace'))
    return p.stdout.decode('utf-8', 'replace')


def filas(sql):
    return [l.split('\t') for l in psql(sql, tuplas=True).splitlines() if l.strip()]


def slug(texto):
    t = unicodedata.normalize('NFKD', texto).encode('ascii', 'ignore').decode().lower()
    return re.sub(r'[^a-z0-9]+', '-', t).strip('-')


def norm(texto):
    return slug(texto or '')


def id_producto(clave, ids):
    m = re.fullmatch(r'c(\d)-(\d\d)', clave)
    if m:
        uid = 'c%s000000-0000-0000-0000-0000000000%s' % (m.group(1), m.group(2))
        return uid if uid in ids else None
    hits = [i for i in ids if i.startswith(clave)]
    return hits[0] if len(hits) == 1 else None


def construir(cap, a, filas, usuario=USUARIO_LOCAL, corte_prod=False):
    """Arma el SQL de la carga de arranque (sin BEGIN ni COMMIT).

    `filas(sql)` lee la base de ORIGEN (local, o la copia restaurada del respaldo en el corte).
    corte_prod=True: inventario_ledger y ticket_detalles se vacian ANTES en la misma transaccion
    (scripts/corte_produccion.py), asi que sus referencias a un producto no impiden quitarlo.
    Devuelve (sentencias, reporte, esperado), con esperado = lo que la base debe decir despues.
    """
    corte = cap.get('corte') or sys.exit('La captura no trae fecha de corte')
    fecha = '%s 23:59:00-06' % corte          # cierre del dia del corte, hora de Zacatecas
    nota_arranque = 'ARRANQUE %s: ' % corte
    reporte = []
    sql = []
    esperado = {'saldos': {}, 'cargo_deuda': 0.0, 'abono_deuda': 0.0, 'n_saldo_inicial': 0,
                'n_deuda': 0, 'n_bodega': 0, 'n_consignacion': 0, 'fecha': fecha}
    productos = {r[0]: r for r in filas('SELECT id, sku, nombre, unidad_medida, costo_unitario::text FROM catalogo_productos')}
    entidades = {r[0]: r for r in filas('SELECT id, nombre, rol, coalesce(id_padre::text, \'\') FROM entidades')}

    # ---------------------------------------------------------------- 1. catalogo
    prod = cap.get('prod', {})
    quitar_prod, contado = [], {}
    for clave, d in prod.items():
        uid = id_producto(clave, productos)
        if not uid:
            sys.exit('Producto de la captura sin match en el catalogo: %s' % clave)
        if d.get('q'):
            quitar_prod.append(uid)
        elif d.get('c') is not None:
            contado[uid] = float(d['c'])

    for uid in quitar_prod:
        refs = filas("""SELECT 'recetas_produccion', count(*) FROM recetas_produccion WHERE id_insumo = %(u)s OR id_producto_terminado = %(u)s
            UNION ALL SELECT 'receta_liquido_estandar', count(*) FROM receta_liquido_estandar WHERE id_insumo = %(u)s
            UNION ALL SELECT 'listas_precios', count(*) FROM listas_precios WHERE id_producto = %(u)s
            UNION ALL SELECT 'inventario_ledger', count(*) FROM inventario_ledger WHERE id_producto = %(u)s
            UNION ALL SELECT 'ticket_detalles', count(*) FROM ticket_detalles WHERE id_producto = %(u)s""" % {'u': q(uid)})
        con = {t: int(n) for t, n in refs if int(n)}
        if corte_prod:
            con.pop('inventario_ledger', None)
            con.pop('ticket_detalles', None)
        elif con.get('inventario_ledger') or con.get('ticket_detalles'):
            sys.exit('El producto %s tiene movimientos (%s): no se quita.' % (productos[uid][2], con))
        reporte.append('quita producto %s (%s)%s' % (productos[uid][2], productos[uid][1],
                       (' -- tambien sale de ' + ', '.join('%s:%d' % kv for kv in con.items())) if con else ''))
        sql += ['DELETE FROM recetas_produccion WHERE id_insumo = %s OR id_producto_terminado = %s;' % (q(uid), q(uid)),
                'DELETE FROM receta_liquido_estandar WHERE id_insumo = %s;' % q(uid),
                'DELETE FROM listas_precios WHERE id_producto = %s;' % q(uid),
                'DELETE FROM catalogo_productos WHERE id = %s;' % q(uid)]

    # Ajustes que Norman dicto en la captura (notas de 8e1bc102 y 1180a7cd).
    ajustes = {
        '8e1bc102-48eb-4d4f-b547-6e2afd6663e1': "nombre = 'Aditivo 1', unidad_medida = 'KILOGRAMOS'",
        '1180a7cd-df16-4bde-b7bd-0e21d008112a': "unidad_medida = 'KILOGRAMOS', costo_unitario = 1580",
    }
    for uid, cambio in ajustes.items():
        if uid in productos and uid not in quitar_prod:
            sql.append('UPDATE catalogo_productos SET %s WHERE id = %s;' % (cambio, q(uid)))
            reporte.append('ajusta %s: %s' % (productos[uid][2], cambio))
    sql.append("""UPDATE receta_liquido_estandar SET cantidad_por_lote = 0.02,
        fuente = 'Norman, captura de arranque 2026-10-28: ~20 g por lote, $1580/kg'
        WHERE id_insumo = '1180a7cd-df16-4bde-b7bd-0e21d008112a';""")

    for n in cap.get('nuevos', []):
        sku = slug(n['n'])
        sql.append("""INSERT INTO catalogo_productos (sku, nombre, tipo, unidad_medida, costo_unitario, es_materia_prima)
            VALUES (%s, %s, %s, %s, %s, %s);""" % (q(sku), q(n['n']), q(n.get('t', 'INSUMO')),
                                                   q(n.get('u', 'PIEZAS')), q(float(n.get('costo') or 0)),
                                                   q(n.get('t', 'INSUMO') == 'INSUMO' and n.get('u') == 'KILOGRAMOS')))
        reporte.append('alta producto %s (%s, %s, $%s), contado %s' % (n['n'], sku, n.get('u'), n.get('costo'), n.get('c')))

    # ---------------------------------------------------------------- 2. entidades
    por_nombre = {norm(v[1]): k for k, v in entidades.items()}
    quitar_ent = []
    for nombre, si in (cap.get('ent') or {}).items():
        if not si:
            continue
        uid = por_nombre.get(norm(nombre)) or sys.exit('Entidad a quitar sin match: %s' % nombre)
        hijos = [v[1] for v in entidades.values() if v[3] == uid]
        if hijos:
            sys.exit('La entidad %s tiene hijos en la red (%s): no se quita.' % (nombre, hijos))
        quitar_ent.append(uid)
        reporte.append('quita entidad %s (%s) y sus cuentas' % (nombre, entidades[uid][2]))
        sql += ['DELETE FROM bot_identidades WHERE id_entidad = %s OR id_cuenta_destino IN (SELECT id FROM cuentas_financieras WHERE id_entidad = %s);' % (q(uid), q(uid)),
                'DELETE FROM cuentas_financieras WHERE id_entidad = %s;' % q(uid),
                'UPDATE entidades SET id_nodo_padre = NULL WHERE id_nodo_padre = %s;' % q(uid),
                'DELETE FROM entidades WHERE id = %s;' % q(uid)]

    # ---------------------------------------------------------------- 3. cuentas
    cuentas = cap.get('cuentas', {})
    t_fis = cap.get('t_fis') or 'LIBRE'
    t_pct = float(cap.get('t_pct') if cap.get('t_pct') not in (None, '') else 5)
    sql.append("""INSERT INTO cuentas_financieras (id, id_entidad, nombre, tipo_fiscalidad, clase)
        SELECT %s, %s, 'Transferencias', %s, 'TRANSFERENCIAS'
        WHERE NOT EXISTS (SELECT 1 FROM cuentas_financieras WHERE id_entidad = %s AND nombre = 'Transferencias');"""
               % (q(TRANSFERENCIAS_ID), q(ADMIN), q(t_fis), q(ADMIN)))
    viejas = filas("SELECT count(*) FROM cuentas_financieras WHERE id_entidad = %s AND nombre IN (%s, %s)"
                   % (q(ADMIN), q(NOMBRE_VIEJO_PERSONAL), q(NOMBRE_CUENTA['personal'])))
    if int(viejas[0][0]) != 1:
        sys.exit('Esperaba UNA cuenta del ADMIN llamada %r o %r y hay %s: no adivino cual renombrar.'
                 % (NOMBRE_VIEJO_PERSONAL, NOMBRE_CUENTA['personal'], viejas[0][0]))
    sql.append("UPDATE cuentas_financieras SET nombre = %s, clase = 'PERSONAL' WHERE id_entidad = %s AND nombre IN (%s, %s);"
               % (q(NOMBRE_CUENTA['personal']), q(ADMIN), q(NOMBRE_VIEJO_PERSONAL), q(NOMBRE_CUENTA['personal'])))
    reporte.append('renombra %s -> %s (clase PERSONAL)' % (NOMBRE_VIEJO_PERSONAL, NOMBRE_CUENTA['personal']))
    for k in ('efectivo', 'fresnillo'):
        sql.append("UPDATE cuentas_financieras SET clase = %s WHERE id_entidad = %s AND nombre = %s;"
                   % (q(CLASE[k]), q(ADMIN), q(NOMBRE_CUENTA[k])))
    sql.append("UPDATE cuentas_financieras SET tipo_fiscalidad = 'LIBRE', solo_egresos = true "
               "WHERE id_entidad = %s AND clase = 'PERSONAL';" % q(ADMIN))
    sql.append("UPDATE parametros_costo SET valor = %s, fuente = 'captura de arranque (t_pct)' "
               "WHERE clave = 'comision_conversion_transferencias_pct';" % q(t_pct))
    reporte.append('Transferencias: %s, comision %s%%; %s LIBRE, solo egresos, saldo 0' % (t_fis, t_pct, NOMBRE_CUENTA['personal']))
    for k in ('efectivo', 'fresnillo', 'transferencias', 'personal'):
        monto = float(cuentas.get(k) or 0)
        esperado['saldos'][CLASE[k]] = round(monto, 2)
        if k == 'personal' and monto:
            sys.exit('La %s arranca en 0 (solo egresos) y la captura trae %s' % (NOMBRE_CUENTA['personal'], monto))
        if monto == 0:
            continue
        sql.append("""INSERT INTO finanzas_ledger (tipo_movimiento, monto, categoria, subcategoria, categoria_gasto,
              descripcion, id_cuenta_destino, fecha_movimiento, usuario_creador, status)
            SELECT 'SALDO_INICIAL', %s, 'ARRANQUE', 'Saldo inicial (arranque)', 'Saldo inicial (arranque)',
              %s, id, %s, 'arranque@v2.local', 'ACTIVO'
            FROM cuentas_financieras WHERE id_entidad = %s AND clase = %s;"""
                   % (q(monto), q(nota_arranque + 'saldo contado por Norman'), q(fecha), q(ADMIN), q(CLASE[k])))
        reporte.append('saldo inicial %s = %.2f' % (NOMBRE_CUENTA[k], monto))
        esperado['n_saldo_inicial'] += 1

    # ---------------------------------------------------------------- 4. inventario de bodega
    def entrada_bodega(uid_sql, cant, costo_sql, nombre):
        sql.append("""INSERT INTO inventario_ledger (id_producto, tipo_movimiento, cantidad, cubeta, id_entidad_destino,
              costo_unitario_movimiento, notas, fecha_movimiento, usuario_creador, status)
            SELECT id, 'ENTRADA_COMPRA', %s, 'PAGADO', %s, %s, %s, %s, 'arranque@v2.local', 'ACTIVO'
            FROM catalogo_productos WHERE %s;"""
                   % (q(cant), q(ADMIN), costo_sql, q(nota_arranque + 'inventario contado (sin dinero)'), q(fecha), uid_sql))
        reporte.append('bodega %s = %s' % (nombre, cant))
        esperado['n_bodega'] += 1

    for uid, cant in sorted(contado.items(), key=lambda kv: productos[kv[0]][1]):
        if cant > 0:
            entrada_bodega('id = %s' % q(uid), cant, 'costo_unitario', productos[uid][2])
    for n in cap.get('nuevos', []):
        if float(n.get('c') or 0) > 0:
            entrada_bodega('sku = %s' % q(slug(n['n'])), float(n['c']), 'costo_unitario', n['n'])

    # ---------------------------------------------------------------- 5. consignacion y deuda
    vivas = {k: v for k, v in entidades.items() if k not in quitar_ent and v[2] in ('LOC', 'DST')
             and k != '11111111-1111-1111-1111-111111111111'}
    cons, deuda, notas = {}, {}, {}
    precio_origen = {}  # uid -> {id_producto: precio_neto de la conciliacion}
    if a.consig == 'libro':
        lib = json.load(open(LIBRO, encoding='utf-8'))
        for uid, pres in lib['consignado'].items():
            cons[uid] = {id_producto(k, productos): v for k, v in pres.items()}
        deuda = {uid: v for uid, v in lib['saldos'].items()}
        reporte.append('consignacion: modo libro (%s, leido %s)' % (os.path.basename(LIBRO), lib['leido_en']))
    elif a.consig == 'capturo':
        nombres = {norm(v[1]): k for k, v in vivas.items()}
        for clave, v in (cap.get('cons') or {}).items():
            nombre, j = clave.rsplit('|', 1)
            uid = nombres.get(norm(nombre)) or sys.exit('consignacion capturada para entidad desconocida: %s' % nombre)
            prod_j = [p for (jj, _, p) in PRESENTACIONES if jj == int(j)][0]
            cons.setdefault(uid, {})[prod_j] = float(v or 0)
        for nombre, v in (cap.get('deuda') or {}).items():
            uid = nombres.get(norm(nombre)) or sys.exit('deuda capturada para entidad desconocida: %s' % nombre)
            deuda[uid] = float(v or 0)
        reporte.append('consignacion: modo capturo (%d entidades con consignacion, %d con deuda)' % (len(cons), len(deuda)))
    elif a.consig == 'conciliado':
        if not a.conciliacion or not os.path.exists(a.conciliacion):
            sys.exit('--consig conciliado necesita --conciliacion <ruta existente>')
        conc = json.load(open(a.conciliacion, encoding='utf-8'))
        # Formato del analista (2026-10-29): {"_meta": {...}, "entidades": {nombre: {...}}}.
        # Tambien se acepta el plano {nombre: {...}} que se pidio al principio.
        meta = conc.get('_meta') or {}
        conc = conc.get('entidades', {k: v for k, v in conc.items() if not k.startswith('_')})
        if meta:
            reporte.append('conciliacion: %s' % json.dumps(meta, ensure_ascii=False))
        nombres = {norm(v[1]): k for k, v in vivas.items()}
        for clave, d in conc.items():
            uid = clave if clave in vivas else nombres.get(norm(clave))
            if not uid:
                sys.exit('conciliacion para entidad desconocida o quitada: %s' % clave)
            # El ERP no guarda acreedor en la deuda: lo deriva de la jerarquia (la deuda de un LOC
            # hijo de un DST es con ese DST, que es el vendedor de sus tickets). Si la conciliacion
            # dice otro acreedor que el padre, la carga lo contradiria: se aborta.
            acreedor = (d.get('acreedor') or '').strip()
            padre = entidades[uid][3]
            padre_nombre = entidades[padre][1] if padre in entidades else ''
            if acreedor and norm(acreedor) != norm(padre_nombre or 'Matriz'):
                sys.exit('acreedor de %s en la conciliacion = %s, pero su padre en entidades = %s'
                         % (clave, acreedor, padre_nombre or 'Matriz (sin padre)'))
            for _, k, p in PRESENTACIONES:
                c = float((d.get('consignacion') or {}).get(k) or 0)
                if c:
                    cons.setdefault(uid, {})[p] = c
                # Ronda 2 (2026-10-29): el precio al que se valuo la deuda de arranque viaja con la
                # consignacion (costo_unitario_movimiento, columna que nadie mas lee). La devolucion
                # (app/actions/devoluciones.ts, preciosDeAbono) abona ese precio y no otro.
                pn = float((d.get('precio_neto') or {}).get(k) or 0)
                if pn > 0:
                    precio_origen.setdefault(uid, {})[p] = pn
            deuda[uid] = float(d.get('deuda') or 0)
            extra = {k: d.get(k) for k in ('acreedor', 'fantasma', 'descartado', 'nota') if d.get(k) not in (None, '', 0, [], {})}
            if extra:
                notas[uid] = json.dumps(extra, ensure_ascii=False)
                reporte.append('conciliacion %s: %s (no se carga; queda en la nota)' % (vivas[uid][1], notas[uid]))
        reporte.append('consignacion: modo conciliado (%s)' % a.conciliacion)
    else:
        reporte.append('consignacion: modo cero (ningun local arranca con consignacion ni deuda) -- PENDIENTE DE NORMAN')

    for uid, pres in sorted(cons.items()):
        if uid in quitar_ent or uid not in entidades:
            continue
        for p, c in pres.items():
            if c and c > 0:
                sql.append("""INSERT INTO inventario_ledger (id_producto, tipo_movimiento, cantidad, cubeta, id_entidad_destino,
                      costo_unitario_movimiento, notas, fecha_movimiento, usuario_creador, status)
                    VALUES (%s, 'ENTRADA_CONCESION', %s, 'CONSIGNADO', %s, %s, %s, %s, 'arranque@v2.local', 'ACTIVO');"""
                           % (q(p), q(c), q(uid), q(precio_origen.get(uid, {}).get(p, 0)),
                              q(nota_arranque + 'consignacion inicial (' + a.consig + ')'), q(fecha)))
                esperado['n_consignacion'] += 1
        reporte.append('consignacion %s: %s' % (entidades[uid][1], {productos[p][1]: c for p, c in pres.items() if c}))
    for uid, monto in sorted(deuda.items()):
        if uid in quitar_ent or uid not in entidades or not monto:
            continue
        tipo = 'CARGO_DEUDA' if monto > 0 else 'ABONO_DEUDA'
        sql.append("""INSERT INTO finanzas_ledger (tipo_movimiento, monto, categoria, subcategoria, categoria_gasto, descripcion,
              id_entidad_relacionada, fecha_movimiento, usuario_creador, status)
            VALUES (%s, %s, 'ARRANQUE', 'Saldo inicial (arranque)', 'Saldo inicial del local', %s, %s, %s, 'arranque@v2.local', 'ACTIVO');"""
                   % (q(tipo), q(abs(monto)), q(nota_arranque + 'deuda inicial (' + a.consig + ')' +
                                                 ((' ' + notas[uid]) if uid in notas else '')), q(uid), q(fecha)))
        reporte.append('deuda inicial %s: %.2f (%s)' % (entidades[uid][1], monto, tipo))
        esperado['n_deuda'] += 1
        esperado['cargo_deuda' if monto > 0 else 'abono_deuda'] += round(abs(monto), 2)

    # ---------------------------------------------------------------- 6. categorias
    orden = 0
    for cat in cap.get('cats', []):
        for sub in cat.get('s', []):
            orden += 1
            sql.append("INSERT INTO categorias_movimiento (tipo, categoria, subcategoria, orden) VALUES (%s, %s, %s, %d) "
                       "ON CONFLICT (tipo, categoria, subcategoria) DO NOTHING;" % (q(cat['t']), q(cat['n'].strip()), q(sub.strip()), orden))
    reporte.append('categorias: %d categorias, %d subcategorias' % (len(cap.get('cats', [])), orden))
    esperado['categorias'] = orden
    esperado['cargo_deuda'] = round(esperado['cargo_deuda'], 2)
    esperado['abono_deuda'] = round(esperado['abono_deuda'], 2)
    esperado['quitar_ent'] = list(quitar_ent)
    esperado['quitar_prod'] = list(quitar_prod)
    if usuario != USUARIO_LOCAL:
        lit = q(USUARIO_LOCAL)
        sql = [x.replace(lit, q(usuario)) for x in sql]
    return sql, reporte, esperado




def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--captura', required=True)
    ap.add_argument('--consig', choices=['cero', 'libro', 'capturo', 'conciliado'], default='cero')
    ap.add_argument('--conciliacion')
    ap.add_argument('--seco', action='store_true')
    ap.add_argument('--ejemplo', action='store_true')
    a = ap.parse_args()

    cap = json.load(open(a.captura, encoding='utf-8'))
    cap = cap.get('data', cap)
    if not cap.get('listo') and not a.ejemplo:
        sys.exit('La captura no esta marcada como lista (listo != true). Usa --ejemplo para probar.')

    p = subprocess.run(['docker', 'port', CONT], capture_output=True, text=True)
    if PUERTO_LOCAL not in p.stdout:
        sys.exit('El contenedor %s no publica %s: no es la base local v2. No corro.' % (CONT, PUERTO_LOCAL))

    if filas("SELECT 1 FROM finanzas_ledger WHERE categoria = 'ARRANQUE' LIMIT 1"):
        sys.exit('Esta base ya tiene una carga de arranque (finanzas_ledger.categoria = ARRANQUE). '
                 'Para repetirla: python scripts/v2_local_reset.py y vuelve a correr esto.')

    sql, reporte, _ = construir(cap, a, filas)
    sql.insert(0, 'BEGIN;')

    # La sesion corre como postgres: los triggers de autor ponen usuario_creador desde el JWT
    # (no hay) y dejan lo que mandamos. Se verifica dentro de la misma transaccion.
    sql.append("""SELECT 'cuenta', c.nombre, c.tipo_fiscalidad, coalesce(c.clase,''), public.saldo_cuenta(c.id)::text
        FROM cuentas_financieras c WHERE c.id_entidad = %s ORDER BY c.nombre;""" % q(ADMIN))
    sql.append('ROLLBACK;' if a.seco else 'COMMIT;')

    salida = psql('\n'.join(sql), tuplas=True)
    print('\n'.join('  - ' + r for r in reporte))
    print('\nCuentas del CEO Admin despues de la carga (saldo_cuenta):')
    for l in salida.splitlines():
        if l.startswith('cuenta'):
            print('  ', l.replace('\t', ' | '))
    print('\nSECO: todo se deshizo (ROLLBACK).' if a.seco else '\nCOMMIT: carga aplicada en la base LOCAL.')


if __name__ == '__main__':
    main()
