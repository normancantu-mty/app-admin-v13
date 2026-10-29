# -*- coding: utf-8 -*-
"""v2 LOCAL: pruebas por API (PostgREST/RPC local y la ruta /api/finanzas/nuevo de la app local).
Escrito el 2026-10-28 por el Socio (ejecutor). Solo localhost.

  python scripts/v2_pruebas_api.py http://localhost:3002

1. Conversion de 333.33 por RPC como ADMIN -> comision 16.67 (round 16.6665), neto 316.66.
2. Convertir mas de lo pendiente -> rechazo.
3. El DST no puede convertir -> rechazo.
4. Ingreso a la Cuenta Gilberto (clase PERSONAL, solo egresos) -> rechazo del trigger.
5. Gasto por la ruta de la app con categoria fuera de la lista -> 400.
6. Gasto por la ruta con categoria/subcategoria de la lista -> 200.
"""
import base64
import json
import sys
import urllib.error
import urllib.request

APP = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:3002'
SB = 'http://127.0.0.1:55321'
if not (APP.startswith('http://localhost:') or APP.startswith('http://127.0.0.1:')):
    sys.exit('APP no es local')
ANON = ('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.'
        'CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0')
fallas = 0


def http(url, datos=None, cab=None, metodo=None):
    req = urllib.request.Request(url, data=None if datos is None else json.dumps(datos).encode(),
                                 headers=cab or {}, method=metodo)
    try:
        r = urllib.request.urlopen(req)
        return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def sesion(email, clave):
    st, cuerpo = http(SB + '/auth/v1/token?grant_type=password', {'email': email, 'password': clave},
                      {'apikey': ANON, 'Content-Type': 'application/json'})
    assert st == 200, cuerpo
    return json.loads(cuerpo)


def rest(token, ruta, datos=None, metodo=None):
    return http(SB + '/rest/v1/' + ruta, datos, {'apikey': ANON, 'Authorization': 'Bearer ' + token,
                                                 'Content-Type': 'application/json',
                                                 'Prefer': 'return=representation'}, metodo)


def prueba(nombre, ok, detalle):
    global fallas
    fallas += 0 if ok else 1
    print('%s | %s | %s' % ('OK   ' if ok else 'FALLA', nombre, detalle[:220]))


adm = sesion('normancantu@gmail.com', 'v2-local-admin')
dst = sesion('dst.prueba@v2.local', 'v2-local-dst')
T = adm['access_token']

st, c = rest(T, 'rpc/convertir_transferencias', {'p_monto': 333.33, 'p_nota': 'SIMULACION v2: prueba al centavo'})
r = json.loads(c) if st == 200 else {}
prueba('conversion 333.33 al centavo', st == 200 and r.get('comision') == 16.67 and r.get('neto') == 316.66,
       'esperado comision 16.67 neto 316.66; obtenido %s %s' % (st, c))

st, c = rest(T, 'rpc/convertir_transferencias', {'p_monto': 99999})
prueba('convertir mas de lo pendiente se rechaza', st >= 400 and 'Transferencias hay' in c, '%s %s' % (st, c))

st, c = rest(dst['access_token'], 'rpc/convertir_transferencias', {'p_monto': 1})
prueba('DST no convierte', st >= 400, '%s %s' % (st, c))

st, c = rest(T, 'cuentas_financieras?select=id&clase=eq.PERSONAL&id_entidad=eq.e0000000-0000-0000-0000-000000000001')
personal = json.loads(c)[0]['id']
st, c = rest(T, 'finanzas_ledger', {'tipo_movimiento': 'INGRESO_TRASPASO', 'monto': 10, 'id_cuenta_destino': personal,
                                     'categoria': 'TRANSFERENCIA', 'status': 'ACTIVO'})
prueba('Cuenta Gilberto (PERSONAL) no recibe ingresos', st >= 400 and 'solo egresos' in c, '%s %s' % (st, c))

# Cookie de @supabase/ssr: sb-<host>-auth-token = "base64-" + base64url(json de la sesion)
cookie = 'sb-127-auth-token=base64-' + base64.urlsafe_b64encode(json.dumps(adm).encode()).decode().rstrip('=')
st, c = rest(T, 'cuentas_financieras?select=id&nombre=eq.Efectivo&id_entidad=eq.e0000000-0000-0000-0000-000000000001')
efectivo = json.loads(c)[0]['id']
cab = {'Content-Type': 'application/json', 'Cookie': cookie}
st, c = http(APP + '/api/finanzas/nuevo', {'tipo_movimiento': 'GASTO_OPERATIVO', 'categoria': 'Inventada',
                                           'subcategoria': 'Tampoco', 'cuenta_destino': efectivo, 'monto': 10}, cab)
prueba('gasto con categoria fuera de la lista -> 400', st == 400, '%s %s' % (st, c))
st, c = http(APP + '/api/finanzas/nuevo', {'tipo_movimiento': 'GASTO_OPERATIVO', 'categoria': 'Servicios',
                                           'subcategoria': 'Luz', 'cuenta_destino': efectivo, 'monto': 120.40,
                                           'descripcion': 'SIMULACION v2: recibo de luz por API'}, cab)
prueba('gasto Servicios/Luz por la ruta de la app -> 200', st == 200, '%s %s' % (st, c))

print('FALLAS: %d' % fallas if fallas else 'TODO OK')
sys.exit(1 if fallas else 0)
