# -*- coding: utf-8 -*-
"""D68 (Fase 7): EL OBJETIVO QUE VINO Y NO SIRVE, POR HTTP CONTRA LA RUTA REAL.

`POST /api/bot/cotizacion/proponer` con la cotizacion real de Norman del
2026-09-19 (Aeropuerto: 12 de 750 ml, 12 de 250 ml y 48 de 50 ml):

- `objetivo` -500, 0, "abc", true  -> **422** `objetivo_invalido`, con el motivo.
- CONTROLES NEGATIVOS: sin campo, null y ""  -> **200** sin escalar (el mismo
  total las tres veces); 15000 -> **200** y $15,008.00 (lo que ya daba D52).

**Todo va con `x-bot-ensayo: 1`** (D60): la ruta lee el catalogo y la red de
verdad, pero NO guarda el borrador ni cancela los PENDIENTE de Norman.

No se llama `probar_*` a proposito: necesita el ERP local arriba y el token, y
`tests/bot-python.spec.ts` corre todo `probar_*.py` en CI, donde no hay ninguno.

Uso:  python bot/comprobar_objetivo_http.py        (BOT_API_TOKEN en el entorno)
"""
import json
import os
import sys
import urllib.error
import urllib.request

API = os.environ.get("BOT_API_URL", "http://localhost:3000")
TOKEN = os.environ.get("BOT_API_TOKEN", "")
CHAT = int(os.environ.get("COMPROBAR_CHAT", "6571822622"))


def post(ruta, cuerpo):
    pet = urllib.request.Request(
        API + ruta, data=json.dumps(cuerpo).encode("utf-8"), method="POST",
        headers={"Content-Type": "application/json", "x-bot-token": TOKEN,
                 "x-bot-ensayo": "1"})
    try:
        with urllib.request.urlopen(pet, timeout=60) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8") or "{}")


if not TOKEN:
    print("Falta BOT_API_TOKEN.")
    sys.exit(2)

estado, cat = post("/api/bot/catalogo", {"telegram_id": CHAT})
por_ml = {}
for p in cat.get("productos") or []:
    por_ml.setdefault(int(p.get("ml_por_unidad") or 0), p)
faltan = [ml for ml in (750, 250, 50) if ml not in por_ml]
if estado != 200 or faltan:
    print("No pude armar la cotizacion real: catalogo %s, faltan %s" % (estado, faltan))
    sys.exit(2)

BASE = {
    "telegram_id": CHAT,
    "cliente": "Aeropuerto",
    "productos": [{"producto": por_ml[ml]["nombre"], "id_producto": por_ml[ml]["id"],
                   "cantidad": n} for ml, n in ((750, 12), (250, 12), (50, 48))],
}

casos = []


def caso(nombre, obtenido, esperado):
    casos.append((nombre, obtenido, esperado))


def con(**extra):
    cuerpo = dict(BASE)
    cuerpo.update(extra)
    return post("/api/bot/cotizacion/proponer", cuerpo)


for malo in (-500, 0, "abc", True):
    estado, r = con(objetivo=malo)
    caso("objetivo %r -> 422" % (malo,), estado, 422)
    caso("objetivo %r -> motivo objetivo_invalido" % (malo,), r.get("motivo"), "objetivo_invalido")
    caso("objetivo %r -> el error dice cual" % (malo,),
         ("No entendi el monto objetivo (%s)" % (str(malo) if malo is not True else "true"))
         in str(r.get("error")), True)

totales = []
for nombre, extra in (("sin campo", {}), ("null", {"objetivo": None}), ('""', {"objetivo": ""})):
    estado, r = con(**extra)
    caso("CONTROL %s -> 200" % nombre, estado, 200)
    caso("CONTROL %s -> ok, en ensayo" % nombre, (r.get("ok"), r.get("mensaje", "").count("Ajuste")), (True, 0))
    totales.append(r.get("mensaje", "").split("TOTAL:")[-1].split("\n")[0].strip())
caso("CONTROL: los tres 'no vino' dan el mismo total sin escalar", len(set(totales)), 1)

estado, r = con(objetivo=15000)
caso("CONTROL 15000 -> 200", estado, 200)
caso("CONTROL 15000 -> $15,008.00 (lo de D52)", "$15,008.00" in r.get("mensaje", ""), True)

fallos = 0
for nombre, obtenido, esperado in casos:
    ok = obtenido == esperado
    fallos += 0 if ok else 1
    print(("OK   " if ok else "FALLA") + " " + nombre
          + ("" if ok else "\n       obtenido: %r\n       esperado: %r" % (obtenido, esperado)))
print("\nTotal sin escalar: %s" % totales[0])
print("RESULTADO: %s" % ("los %d casos pasan" % len(casos) if not fallos
                         else "%d de %d casos FALLAN" % (fallos, len(casos))))
sys.exit(1 if fallos else 0)
