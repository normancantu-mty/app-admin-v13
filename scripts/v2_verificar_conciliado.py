# -*- coding: utf-8 -*-
"""v2 LOCAL: compara la carga `--consig conciliado` contra el JSON de la conciliacion.
Escrito el 2026-10-29 por el Socio (ejecutor). Solo lee la base LOCAL (docker exec).

  python scripts/v2_verificar_conciliado.py <conciliacion.json>

Por entidad: deuda esperada (JSON `deuda`) vs `v_saldo_entidad.saldo_pendiente_consignacion`,
y consignacion esperada (JSON `consignacion` 750/250/50/pasta) vs `v_stock_por_cubeta`
cubeta CONSIGNADO. Lee la base, no el script de carga: si la carga se equivoca, aqui sale.
Sirve tal cual despues de la carga real, ANTES de cualquier movimiento nuevo.
"""
import json
import subprocess
import sys

CONT = 'supabase_db_app-admin-v2'
SKU = {'750': 'plata-750ml', '250': 'plata-250ml', '50': 'plata-50ml', 'pasta': 'pasta'}


def filas(sql):
    r = subprocess.run(['docker', 'exec', '-i', CONT, 'psql', '-U', 'postgres', '-X', '-At', '-F', '\t', '-c', sql],
                       capture_output=True, text=True, encoding='utf-8')
    if r.returncode:
        sys.exit(r.stderr)
    return [l.split('\t') for l in r.stdout.splitlines() if l]


conc = json.load(open(sys.argv[1], encoding='utf-8'))
conc = conc.get('entidades', conc)
deuda = {n: float(v) for n, v in filas('SELECT nombre, coalesce(saldo_pendiente_consignacion, 0) FROM v_saldo_entidad')}
stock = {}
for ent, sku, s in filas("""SELECT v.entidad, p.sku, v.stock FROM v_stock_por_cubeta v
                            JOIN catalogo_productos p ON p.id = v.id_producto WHERE v.cubeta = 'CONSIGNADO'"""):
    stock[(ent, sku)] = float(s)

fallas = 0
print('entidad | deuda esperada | obtenida | consignacion esperada | obtenida | ok')
for nombre, d in conc.items():
    if nombre.startswith('_'):
        continue
    esp_c = {SKU[k]: float(v) for k, v in (d.get('consignacion') or {}).items() if float(v or 0)}
    obt_c = {sku: s for (ent, sku), s in stock.items() if ent == nombre}
    esp_d, obt_d = round(float(d.get('deuda') or 0), 2), round(deuda.get(nombre, 0.0), 2)
    ok = esp_d == obt_d and esp_c == obt_c
    fallas += 0 if ok else 1
    print('%s | %.2f | %.2f | %s | %s | %s' % (nombre, esp_d, obt_d, esp_c, obt_c, 'OK' if ok else 'FALLA'))
total_esp = sum(float(d.get('deuda') or 0) for k, d in conc.items() if not k.startswith('_'))
print('TOTAL deuda esperada %.2f | obtenida (entidades del JSON) %.2f' %
      (total_esp, sum(deuda.get(k, 0.0) for k in conc if not k.startswith('_'))))
print('FALLAS: %d' % fallas if fallas else 'TODO OK')
sys.exit(1 if fallas else 0)
