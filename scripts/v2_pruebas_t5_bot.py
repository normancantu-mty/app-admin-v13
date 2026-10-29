# -*- coding: utf-8 -*-
"""v2 LOCAL, T5: las rutas del bot de Telegram que escriben PRODUCCION, TRASPASO, la entrada de
empaque y la ANULACION, llamadas como las llama el proceso del bot (proponer -> sello -> confirmar).
Escrito el 2026-10-29 por el Socio (ejecutor).

    V2_BOT_TOKEN=<el token con que arranco el servidor local> \
      python scripts/v2_pruebas_t5_bot.py http://localhost:3002 <salida.json>

El servidor local tiene que arrancar con ESE token:  BOT_API_TOKEN=<token> npx next dev -p 3002
(el BOT_API_TOKEN del entorno de Windows es el de produccion: no se usa aqui). Se niega a correr
contra una URL que no sea localhost. Corre DESPUES de scripts/v2_simular_t5.mjs: anula la venta de
contado de $1,198 desde Cuenta Fresnillo que ese script hizo. Las cifras las comprueba
scripts/v2_verificar_t5.sql.

  0  anular la venta de Cuenta Fresnillo desde la lista del bot (anular_ticket_atomica)
  1  lote nuevo: 8 kg de chile guajillo + 1 tanda de 20 L a 40 grados  (registrar_en_lote)
  2  envasado de 6 x 750 -> falta empaque -> entrada de 10 botellas y 10 corchos (ENTRADA_COMPRA)
     -> envasado otra vez -> PRODUCCION + TRASPASO de cada insumo de la receta (registrar_envasado_diario)
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:3002'
SALIDA = sys.argv[2] if len(sys.argv) > 2 else 't5_bot.json'
if not re.match(r'^http://(localhost|127\.0\.0\.1):\d+$', BASE):
    sys.exit('URL no local: no corro.')
TOKEN = os.environ.get('V2_BOT_TOKEN', '')
if len(TOKEN) < 24:
    sys.exit('Falta V2_BOT_TOKEN (el token local con que arranco el servidor).')
NORMAN = 6571822622
P750 = 'c1000000-0000-0000-0000-000000000001'

fallas = 0
registro = {}


def post(ruta, cuerpo):
    req = urllib.request.Request(BASE + ruta, method='POST', data=json.dumps(cuerpo).encode('utf-8'),
                                 headers={'content-type': 'application/json', 'x-bot-token': TOKEN})
    try:
        r = urllib.request.urlopen(req, timeout=180)
        return r.status, json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        texto = e.read().decode('utf-8')
        try:
            return e.code, json.loads(texto)
        except ValueError:
            return e.code, {'crudo': texto[:500]}


def paso(nombre, ok, detalle=''):
    global fallas
    if not ok:
        fallas += 1
    print('PASO %s %s %s' % ('OK' if ok else 'FALLA', nombre, detalle))


def confirmar(ruta, prop):
    return post(ruta, {'telegram_id': NORMAN, 'borrador_id': prop.get('borrador_id'), 'sello': prop.get('sello')})


# 0. Anular (primero: la lista del bot ofrece solo las 8 filas mas recientes) la venta de Cuenta Fresnillo, escogiendo de la lista del bot
st, lista = post('/api/bot/anular/proponer', {'telegram_id': NORMAN, 'accion': 'anular'})
opciones = lista.get('opciones') or []
elegida = next((o for o in opciones if o.get('arrastra_venta') and o.get('tabla') == 'finanzas'
                and ('1,198' in (str(o.get('etiqueta')) + str(o.get('detalle'))) or '1198' in (str(o.get('etiqueta')) + str(o.get('detalle'))))), None)
paso('anular_lista', st == 200 and elegida is not None,
     '%s %d opciones; elegida=%s' % (st, len(opciones), elegida and (elegida.get('etiqueta'), elegida.get('detalle'))))
if elegida:
    st, prop = post('/api/bot/anular/proponer', {'telegram_id': NORMAN, 'tabla': 'finanzas',
                                                 'id_movimiento': elegida['id'], 'modo': 'anular'})
    paso('anular_proponer', st == 200 and prop.get('ok') is True, '%s %s' % (st, str(prop.get('mensaje') or prop.get('error'))[:240].replace('\n', ' ')))
    st, conf = confirmar('/api/bot/anular/confirmar', prop)
    paso('anular_confirmar', st == 200 and conf.get('ok') is True, '%s %s' % (st, str(conf.get('mensaje') or conf.get('error'))[:240].replace('\n', ' ')))
    registro['anular'] = {'elegida': elegida, 'confirmar': conf}

# 1. Lote nuevo
st, prop = post('/api/bot/lote/proponer', {'telegram_id': NORMAN, 'envasado': [],
                                           'insumos': [{'insumo': 'chile-guajillo', 'cantidad': 8}],
                                           'propuesta': {'tandas': [{'litros': 20, 'grado': 40}]}})
paso('lote_proponer', st == 200 and prop.get('ok') is True, '%s codigo=%s' % (st, prop.get('codigo_lote')))
st, conf = confirmar('/api/bot/lote/confirmar', prop)
paso('lote_confirmar', st == 200 and conf.get('ok') is True, '%s %s' % (st, str(conf.get('mensaje') or conf.get('error'))[:160].replace('\n', ' ')))
registro['lote'] = {'propuesta': prop.get('codigo_lote'), 'confirmar': conf}

# 2. Envasado diario con empaque faltante
pedido = {'telegram_id': NORMAN, 'insumos': [], 'envasado': [{'formato': '750', 'botellas': 6}], 'propuesta': {'tandas': []}}
st, prop = post('/api/bot/lote/proponer', pedido)
faltan = sorted(f.get('nombre') for f in prop.get('faltantes', []))
paso('envasado_bloqueado_por_empaque', st == 200 and prop.get('falta_empaque') is True,
     '%s faltan=%s' % (st, faltan))
registro['falta_empaque'] = prop.get('faltantes')
st, pinv = post('/api/bot/inventario/proponer', {'telegram_id': NORMAN,
                                                  'texto': 'llegaron 10 botellas de 750 y 10 corchos',
                                                  'envasado': prop.get('envasado') or [{'id_producto': P750, 'botellas': 6}]})
paso('entrada_empaque_proponer', st == 200 and pinv.get('ok') is True,
     '%s renglones=%s' % (st, [(r.get('nombre'), r.get('cantidad')) for r in pinv.get('renglones', [])]))
st, cinv = confirmar('/api/bot/inventario/confirmar', pinv)
paso('entrada_empaque_confirmar', st == 200 and cinv.get('ok') is True, '%s' % st)
st, prop = post('/api/bot/lote/proponer', pedido)
paso('envasado_proponer', st == 200 and prop.get('ok') is True and not prop.get('falta_empaque'),
     '%s %s' % (st, str(prop.get('mensaje') or prop.get('error'))[:200].replace('\n', ' ')))
st, conf = confirmar('/api/bot/lote/confirmar', prop)
paso('envasado_confirmar', st == 200 and conf.get('ok') is True, '%s %s' % (st, str(conf.get('mensaje') or conf.get('error'))[:200].replace('\n', ' ')))
registro['envasado'] = conf

with open(SALIDA, 'w', encoding='utf-8') as f:
    json.dump(registro, f, ensure_ascii=False, indent=1)
print('FALLAS: %d' % fallas if fallas else 'TODO OK')
sys.exit(1 if fallas else 0)
