# -*- coding: utf-8 -*-
"""EL MODO ENSAYO NO PUEDE ESCRIBIR. **D60 (Fase 7).**

─── EL DEFECTO ─────────────────────────────────────────────────────────────────

El bot y las pruebas comparten UNA base: la de produccion. En la Fase 6 el
auditor tuvo que doblar `/confirmar` a mano en cada arnes para no escribir
dinero. Eso vivia en el criterio del que prueba, no en el codigo.

─── QUE SE MIDE AQUI ───────────────────────────────────────────────────────────

Todo sin red: `urllib.request.urlopen` esta doblado y registra la peticion que
HABRIA salido, con sus cabeceras. Asi se mide lo que de verdad sale del
proceso, no lo que una funcion dice que haria.

1. `decision_de_ensayo`: las ocho rutas `/confirmar` que el bot llama hoy (se
   sacan del codigo con una expresion regular, para que una novena no se
   cuele) no salen; una ruta que no existe todavia tampoco (lista cerrada por
   lo PERMITIDO); `/proponer` y las de solo lectura salen marcadas.
2. `_post` en ensayo: `/confirmar` NO llega a `urlopen`; `/proponer` llega con
   `x-bot-ensayo: 1` y su `mensaje` vuelve con el aviso.
3. CONTROL NEGATIVO: sin ensayo, el mismo `/confirmar` SI llega a `urlopen`,
   y sin la cabecera. Sin este, un `_post` que nunca llama nada pasaria.
4. El interruptor: apagado por default; su log no es el de produccion.

La prueba de punta a punta —una venta, un abono y una cotizacion contra el ERP
local, con las cifras de control antes y despues— esta en el informe de la
Fase 7, porque necesita el servidor arriba y la base de verdad.

Corre con:  python bot/probar_ensayo.py
"""
import io
import json
import os
import re
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# D46: el log va a un temporal. ANTES del import; ver `probar_log.py`.
os.environ.setdefault(
    "BOT_LOG", os.path.join(tempfile.gettempdir(), "probar_bot.log"))

import bot_gastos as B  # noqa: E402

casos = []


def caso(nombre, obtenido, esperado):
    casos.append((nombre, obtenido, esperado))


# ─── El doble de la red ──────────────────────────────────────────────────────

class RespuestaFalsa(object):
    status = 200

    def __init__(self, cuerpo):
        self._cuerpo = json.dumps(cuerpo).encode("utf-8")

    def read(self):
        return self._cuerpo

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class Red(object):
    """Registra cada peticion que llega a `urlopen`: la que de verdad salio."""

    def __init__(self):
        self.salieron = []

    def __call__(self, pet, timeout=None):
        cabeceras = {k.lower(): v for k, v in pet.header_items()}
        self.salieron.append((pet.full_url, cabeceras))
        return RespuestaFalsa({"ok": True, "mensaje": "Esto es lo que voy a escribir."})

    def rutas(self):
        return [u.replace(B.API, "") for u, _ in self.salieron]


def con_red(ensayo, llamada):
    red = Red()
    original, ensayo_original = B.urllib.request.urlopen, B.ENSAYO
    B.urllib.request.urlopen, B.ENSAYO = red, ensayo
    del B.no_salieron[:]
    try:
        resultado = llamada()
    finally:
        B.urllib.request.urlopen, B.ENSAYO = original, ensayo_original
    return red, resultado


# ═══ 1. La decision ═══════════════════════════════════════════════════════════

fuente = io.open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "bot_gastos.py"),
                 encoding="utf-8").read()
confirmar = sorted(set(re.findall(r'_post\("(/api/bot/[a-z_]+/confirmar)"', fuente)))
caso("el bot llama hoy ocho rutas /confirmar (si cambia, revisa este archivo)",
     len(confirmar), 8)
for ruta in confirmar:
    caso("no sale: " + ruta, B.decision_de_ensayo(ruta), "no_sale")

caso("no sale: /cancelar (cambia el estado de un borrador)",
     B.decision_de_ensayo("/api/bot/cancelar"), "no_sale")
caso("no sale: una ruta que todavia no existe (lista cerrada por lo permitido)",
     B.decision_de_ensayo("/api/bot/pago/registrar"), "no_sale")
caso("no sale: /confirmar con diagonal final",
     B.decision_de_ensayo("/api/bot/venta/confirmar/"), "no_sale")
caso("no sale: /confirmar gana aunque el prefijo sea de solo lectura",
     B.decision_de_ensayo("/api/bot/consulta/confirmar"), "no_sale")
for ruta in ("/api/bot/venta/proponer", "/api/bot/cotizacion/proponer",
             "/api/bot/abono/proponer", "/api/bot/consulta", "/api/bot/catalogo"):
    caso("sale marcada: " + ruta, B.decision_de_ensayo(ruta), "sale_marcada")


# ═══ 2. _post en ensayo, con la red doblada ═══════════════════════════════════

red, (estado, r) = con_red(True, lambda: B._post(
    "/api/bot/venta/confirmar", {"telegram_id": 1, "borrador_id": "x", "sello": "s"}))
caso("ensayo: /venta/confirmar NO llega a urlopen", red.salieron, [])
caso("ensayo: la respuesta dice que es ensayo", r.get("ensayo"), True)
caso("ensayo: ok es False (no dice 'Listo. Quedo escrita')", r.get("ok"), False)
caso("ensayo: el error lleva el aviso", B.AVISO_ENSAYO in r.get("error", ""), True)
caso("ensayo: queda registrado lo que no salio",
     [ruta for ruta, _ in B.no_salieron], ["/api/bot/venta/confirmar"])

red, (estado, r) = con_red(True, lambda: B._post("/api/bot/cancelar", {"borrador_id": "x"}))
caso("ensayo: /cancelar no sale y contesta ok", (red.salieron, r.get("ok")), ([], True))

red, (estado, r) = con_red(True, lambda: B._post("/api/bot/venta/proponer", {"texto": "x"}))
caso("ensayo: /venta/proponer SI sale", red.rutas(), ["/api/bot/venta/proponer"])
caso("ensayo: y sale con x-bot-ensayo: 1",
     red.salieron[0][1].get("x-bot-ensayo") if red.salieron else None, "1")
caso("ensayo: el mensaje de la propuesta lleva el aviso",
     r.get("mensaje", "").startswith(B.AVISO_ENSAYO), True)


# ═══ 3. CONTROL NEGATIVO: sin ensayo, /confirmar SI sale ═══════════════════════

red, (estado, r) = con_red(False, lambda: B._post(
    "/api/bot/venta/confirmar", {"telegram_id": 1, "borrador_id": "x", "sello": "s"}))
caso("SIN ensayo: /venta/confirmar SI llega a urlopen",
     red.rutas(), ["/api/bot/venta/confirmar"])
caso("SIN ensayo: sin cabecera de ensayo",
     "x-bot-ensayo" in (red.salieron[0][1] if red.salieron else {"x-bot-ensayo": 1}), False)
caso("SIN ensayo: el mensaje no se toca",
     r.get("mensaje"), "Esto es lo que voy a escribir.")


# ═══ 4. El interruptor ═══════════════════════════════════════════════════════

caso("apagado por default (entorno vacio)", B.ensayo_activo({}), False)
caso("BOT_ENSAYO=0 es apagado", B.ensayo_activo({"BOT_ENSAYO": "0"}), False)
caso("BOT_ENSAYO=1 es encendido", B.ensayo_activo({"BOT_ENSAYO": "1"}), True)
caso("el log de un ensayo NO es el de produccion",
     B.ruta_del_log({"BOT_ENSAYO": "1"}).name, "bot_gastos_ensayo.log")
caso("BOT_LOG manda sobre el ensayo",
     str(B.ruta_del_log({"BOT_ENSAYO": "1", "BOT_LOG": "x.log"})), "x.log")
caso("sin ensayo, el log es el de siempre", B.ruta_del_log({}).name, "bot_gastos.log")


# ─── Resultado ───────────────────────────────────────────────────────────────

fallos = 0
for nombre, obtenido, esperado in casos:
    ok = obtenido == esperado
    fallos += 0 if ok else 1
    print(("OK   " if ok else "FALLA") + " " + nombre
          + ("" if ok else "\n       obtenido: %r\n       esperado: %r" % (obtenido, esperado)))

print()
if fallos:
    print("RESULTADO: %d de %d casos FALLAN" % (fallos, len(casos)))
    sys.exit(1)
print("RESULTADO: los %d casos pasan" % len(casos))
