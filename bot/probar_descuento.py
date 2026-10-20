# -*- coding: utf-8 -*-
"""EL DESCUENTO VIAJA, Y NO SE CALCULA EN EL CAMINO. **D55 · D56 (Bloque D).**

Norman: *"en ocasiones vamos a poner promociones, mi pregunta es si las podemos
meter por medio de este bot. Eso si me interesa."*

─── QUE MIDE ESTA PRUEBA, Y QUE NO ─────────────────────────────────────────────

Mide **el tramo de Python**: que el descuento que el modelo dicta salga de
`enrutador._normaliza`, cruce `bot_gastos` y llegue al cuerpo que se le manda a
`/api/bot/venta/proponer` y a `/api/bot/cotizacion/proponer` **con la misma
forma y sin una sola cuenta hecha en el camino**.

**No mide la aritmetica ni el tope**: esos viven en `lib/bot-descuento.ts` y los
cubre `tests/bot-descuento.spec.ts` con la cotizacion real de $10,176.00. Estan
alla a proposito -- el tope tiene que estar del lado del servidor, porque un
tope que viviera en este proceso lo saltaria cualquiera que le hable al endpoint
por fuera. Lo que se prueba aqui es la mitad que le toca a Python: **que no
estorbe, que no invente y que no se quede con la mitad del dato.**

─── EL CONTROL NEGATIVO QUE LE DA VALOR ────────────────────────────────────────

Que un mensaje SIN descuento no meta el campo. Sin eso, un `"descuento": {}`
colgado de cada venta viajaria hasta el servidor para que lo ignore, y un dato
que viaja para ser ignorado acaba usandose algun dia.

Corre con:  python bot/probar_descuento.py
"""
import asyncio
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# D46: el log va a un temporal, y esta linea va ANTES del import.
os.environ.setdefault(
    "BOT_LOG", os.path.join(tempfile.gettempdir(), "probar_bot.log"))

import bot_gastos as B  # noqa: E402
# E2 (auditoria IA 2026-10-17): estas pruebas no son de la puerta de privado
# (esa se prueba en probar_minimo_privilegio.py); aqui el chat privado es de
# alguien dado de alta.
async def _alta_ok(update, clave):
    return True
B._puerta_de_privado = _alta_ok
import enrutador as E  # noqa: E402

CHAT = 987654321
P750 = "c1000000-0000-0000-0000-000000000001"

casos = []


def caso(nombre, obtenido, esperado, detalle=""):
    casos.append((nombre, obtenido, esperado, detalle))


# ═══════════ EL ARNES (el mismo de las otras pruebas del bot) ════════════════

class MensajeFalso(object):
    def __init__(self, chat_id, texto=""):
        self.chat = type("Chat", (), {"id": chat_id})()
        self.chat.send_action = self._nada
        self.text = texto
        self.dichos = []

    async def _nada(self, *a, **kw):
        return None

    async def reply_text(self, texto, **kw):
        self.dichos.append(str(texto))
        return None


class UpdateDeTexto(object):
    def __init__(self, chat_id, texto):
        self.message = MensajeFalso(chat_id, texto)

    @property
    def effective_message(self):
        return self.message

    @property
    def effective_chat(self):
        return self.message.chat


VENTA_OK = {"/api/bot/venta/proponer": (200, {
    "ok": True, "borrador_id": "b-1", "sello": "s",
    "mensaje": "Esto es lo que voy a escribir.", "total": 5184,
    "cuentas": [], "id_cuenta": "cta-1"})}

COTIZACION_OK = {"/api/bot/cotizacion/proponer": (200, {
    "ok": True, "borrador_id": "b-2", "sello": "s",
    "mensaje": "Esta es la cotizacion.", "total": 5184,
    "para_quien": "Aeropuerto", "es_de_la_red": True,
    "vigencia_dias": 15, "vigente_hasta": "2026-10-04", "clientes": []})}


class PostDoble(object):
    def __init__(self, respuestas):
        self.llamadas = []
        self.respuestas = respuestas

    def __call__(self, ruta, cuerpo):
        self.llamadas.append((ruta, cuerpo))
        if ruta == "/api/bot/catalogo":
            return 200, {"ok": True, "productos": [
                {"id": P750, "sku": "plata-750ml",
                 "nombre": "Destilado Plata 750ml", "ml_por_unidad": 750}]}
        return self.respuestas.get(ruta, (500, {"error": "No pude proponerlo."}))

    def cuerpo_de(self, ruta):
        for r, c in self.llamadas:
            if r == ruta:
                return c
        return None


def hablar(texto, ruta_del_modelo, respuestas):
    """Mete una frase por la tuberia real. Solo se dobla `enrutar` y `_post`."""
    B._memoria.pop(CHAT, None)
    B._ultimo_cliente.pop(CHAT, None)
    B._ultima_cotizacion.pop(CHAT, None)
    u = UpdateDeTexto(CHAT, texto)
    doble = PostDoble(respuestas)
    enrutar_original, post_original = B.enrutar, B._post

    def enrutar_doble(*a, **kw):
        return True, dict(ruta_del_modelo)

    B.enrutar, B._post = enrutar_doble, doble
    try:
        asyncio.run(B.manejar_texto(u, None))
    finally:
        B.enrutar, B._post = enrutar_original, post_original
    return u.message.dichos, doble


def renglon():
    return [{"producto": "750 ml", "cantidad": 12, "id_producto": P750}]


# ═══════════ 1. LA CRIBA DEL ENRUTADOR ═══════════════════════════════════════
#
# `_normaliza_descuento` solo valida la FORMA. El tope y la aritmetica son del
# servidor, y esta prueba comprueba que aqui NO estan.

caso("VERDE - un porcentaje dictado sobrevive la criba",
     E._normaliza_descuento({"porcentaje": 10}), {"porcentaje": 10.0}, "")
caso("VERDE - un total dictado sobrevive la criba",
     E._normaliza_descuento({"total_final": "5000"}), {"total_final": 5000.0}, "")
caso("VERDE - el motivo se limpia y viaja",
     E._normaliza_descuento({"porcentaje": 15, "motivo": "  promocion\n de septiembre "}),
     {"porcentaje": 15.0, "motivo": "promocion de septiembre"}, "")

# **El tope NO esta aqui, y es deliberado.** Un 60% pasa la criba de Python y se
# lo come la ruta con un 422. Si algun dia esta asercion se pone roja porque
# alguien "endurecio" el bot, hay que leer el comentario de `_normaliza_descuento`
# antes de celebrar: un tope duplicado da la falsa sensacion de que basta con el
# de aca, y el dia que alguien le hable al endpoint por fuera no habria ninguno.
caso("VERDE - el tope NO vive en Python: un 60% pasa la criba y lo topa la ruta",
     E._normaliza_descuento({"porcentaje": 60}), {"porcentaje": 60.0}, "")

# ── CONTROL NEGATIVO: la basura no pasa ─────────────────────────────────────
for basura in [{"porcentaje": 10, "total_final": 5000},   # los dos a la vez
               {"porcentaje": -5},
               {"porcentaje": 0},
               {"porcentaje": "mucho"},
               {"total_final": 0},
               {"total_final": 10 ** 9},                   # fuera de escala
               {"motivo": "promocion"},                    # sin numero
               {}, None, "no soy un objeto", 7]:
    if E._normaliza_descuento(basura) is not None:
        caso("ROJO  - basura en descuento (%r)" % (basura,),
             E._normaliza_descuento(basura), None, "")
caso("ROJO  - ninguna basura paso la criba del enrutador",
     len([c for c in casos if c[0].startswith("ROJO  - basura")]), 0, "")

# ── Y que `_normaliza` BORRE el campo en vez de dejarlo a medias ────────────
r = E._normaliza({"intencion": "venta", "confianza": "alta", "entendido": "x",
                  "campos": {"descuento": {"porcentaje": 10, "total_final": 5000}}})
caso("ROJO  - un descuento invalido se BORRA de campos, no se deja a medias",
     "descuento" in r["campos"], False, str(r["campos"]))

r = E._normaliza({"intencion": "venta", "confianza": "alta", "entendido": "x",
                  "campos": {"descuento": {"porcentaje": 10}}})
caso("VERDE - un descuento valido queda en campos",
     r["campos"].get("descuento"), {"porcentaje": 10.0}, "")


# ═══════════ 2. EL DESCUENTO LLEGA AL CUERPO DE LA VENTA ═════════════════════

dichos, doble = hablar(
    "vendi 12 de 750 con 10% de descuento",
    dict(intencion="venta", confianza="alta", entendido="x",
         campos={"productos": renglon(), "descuento": {"porcentaje": 10}},
         respuesta="Va."),
    VENTA_OK)
cuerpo = doble.cuerpo_de("/api/bot/venta/proponer") or {}
caso("VERDE - la venta se propuso", bool(cuerpo), True, "")
caso("VERDE - y el descuento viaja dentro de `propuesta`",
     (cuerpo.get("propuesta") or {}).get("descuento"), {"porcentaje": 10.0},
     str(cuerpo.get("propuesta")))

# ── CONTROL NEGATIVO: sin descuento, el campo NO va ─────────────────────────
dichos, doble = hablar(
    "vendi 12 de 750",
    dict(intencion="venta", confianza="alta", entendido="x",
         campos={"productos": renglon()}, respuesta="Va."),
    VENTA_OK)
cuerpo = doble.cuerpo_de("/api/bot/venta/proponer") or {}
caso("ROJO  - sin descuento dictado, `descuento` NO aparece en la venta",
     "descuento" in (cuerpo.get("propuesta") or {}), False,
     str(cuerpo.get("propuesta")))

# ── Y un descuento vacio tampoco cuenta como descuento ──────────────────────
dichos, doble = hablar(
    "vendi 12 de 750",
    dict(intencion="venta", confianza="alta", entendido="x",
         campos={"productos": renglon(), "descuento": {}}, respuesta="Va."),
    VENTA_OK)
cuerpo = doble.cuerpo_de("/api/bot/venta/proponer") or {}
caso("ROJO  - un `descuento` vacio no viaja",
     "descuento" in (cuerpo.get("propuesta") or {}), False,
     str(cuerpo.get("propuesta")))


# ═══════════ 3. Y AL DE LA COTIZACION ════════════════════════════════════════

dichos, doble = hablar(
    "cotizale 12 de 750 a aeropuerto, dejaselo en 5,000",
    dict(intencion="cotizacion", confianza="alta", entendido="x",
         campos={"productos": renglon(), "cliente": "aeropuerto",
                 "descuento": {"total_final": 5000, "motivo": "promocion"}},
         respuesta="Va."),
    COTIZACION_OK)
cuerpo = doble.cuerpo_de("/api/bot/cotizacion/proponer") or {}
caso("VERDE - la cotizacion se propuso", bool(cuerpo), True, "")
caso("VERDE - y el descuento viaja completo, con su motivo",
     (cuerpo.get("propuesta") or {}).get("descuento"),
     {"total_final": 5000.0, "motivo": "promocion"}, str(cuerpo.get("propuesta")))

dichos, doble = hablar(
    "cotizale 12 de 750 a aeropuerto",
    dict(intencion="cotizacion", confianza="alta", entendido="x",
         campos={"productos": renglon(), "cliente": "aeropuerto"},
         respuesta="Va."),
    COTIZACION_OK)
cuerpo = doble.cuerpo_de("/api/bot/cotizacion/proponer") or {}
caso("ROJO  - sin descuento dictado, `descuento` NO aparece en la cotizacion",
     "descuento" in (cuerpo.get("propuesta") or {}), False,
     str(cuerpo.get("propuesta")))


# ═══════════ 4. PYTHON NO HACE NINGUNA CUENTA ════════════════════════════════
#
# La asercion mas importante del archivo. Lo que sale del bot tiene que ser el
# MISMO numero que dijo el modelo: ni el importe, ni el total, ni el porcentaje
# derivado de un total. Si algun dia aparece un `importe` o un `total` calculado
# en el cuerpo, alguien movio la cuenta al lado equivocado de la frontera.

dichos, doble = hablar(
    "vendi 12 de 750 con 10% de descuento",
    dict(intencion="venta", confianza="alta", entendido="x",
         campos={"productos": renglon(), "descuento": {"porcentaje": 10}},
         respuesta="Va."),
    VENTA_OK)
salio = ((doble.cuerpo_de("/api/bot/venta/proponer") or {})
         .get("propuesta") or {}).get("descuento") or {}
caso("ROJO  - Python no agrega campos calculados al descuento",
     sorted(salio.keys()), ["porcentaje"], str(salio))
caso("ROJO  - y el numero que sale es el que entro, sin tocar",
     salio.get("porcentaje"), 10.0, "")


print("")
todo_bien = True
for nombre, obtenido, esperado, detalle in casos:
    bien = obtenido == esperado
    if not bien:
        todo_bien = False
    print("  [%s] %-64s  %s" % ("PASA" if bien else "FALLA", nombre,
                                detalle if bien else "obtuve %r, esperaba %r"
                                % (obtenido, esperado)))
print("")
print("RESULTADO:", "los %d casos pasan" % len(casos) if todo_bien
      else "HAY CASOS QUE FALLAN")
sys.exit(0 if todo_bien else 1)
