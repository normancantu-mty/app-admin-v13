# -*- coding: utf-8 -*-
"""REGALOS DESDE EL BOT: el lado del bot (2026-11-23).

Escrito el 2026-11-23 por el Socio (ejecutor).

Norman, en el grupo: "Regalo una grande de norman en conferencia de IA" y el bot
contesto "Cuanto costo la botella que regalaste?" (dos veces). Aqui se prueba que:
  - ese mensaje va a `/api/bot/regalo/proponer` y NO llega al modelo (que pedia monto);
  - aunque el servidor no tenga la ruta (404) tampoco cae a gasto;
  - una pregunta (quien / cuantas / razon) se contesta con un mensaje corto, y
    "Solo registralo" no la repite; un gasto dictado en medio NO se la come;
  - el VA va a `/api/bot/regalo/confirmar` con `{telegram_id, borrador_id, sello}`;
  - "regalos", "cuantos regalos lleva Kevin" y /regalos contestan el contador.

`_post` y `enrutar` doblados: ninguna peticion sale de este proceso.

Corre con:  python bot/probar_regalo.py      (sin red, sin modelo)
"""
import asyncio
import os
import re
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["BOT_LOG"] = os.path.join(tempfile.gettempdir(), "probar_regalo.log")

import bot_gastos as B  # noqa: E402


async def _alta_ok(update, clave):
    return True


B._puerta_de_privado = _alta_ok

CHAT = 555000779
BORRADOR = "7c1f0c7e-2b64-4f0a-9c33-7d1e8b2f6a99"
SELLO = "s3ll0m"

casos = []


def caso(nombre, obtenido, esperado):
    casos.append((nombre, obtenido, esperado))


class MensajeFalso(object):
    def __init__(self, chat_id, texto=""):
        self.chat = type("Chat", (), {"id": chat_id, "type": "private"})()
        self.chat.send_action = self._nada
        self.text = texto
        self.dichos = []
        self.teclados = []

    async def _nada(self, *a, **kw):
        return None

    async def reply_text(self, texto, **kw):
        self.dichos.append(str(texto))
        self.teclados.append(kw.get("reply_markup"))
        return None

    async def reply_photo(self, *a, **kw):
        return None


class UpdateDeTexto(object):
    def __init__(self, chat_id, texto):
        self.message = MensajeFalso(chat_id, texto)
        self.callback_query = None

    @property
    def effective_message(self):
        return self.message

    @property
    def effective_chat(self):
        return self.message.chat


class ConsultaFalsa(object):
    def __init__(self, chat_id, data):
        self.data = data
        self.message = MensajeFalso(chat_id)

    async def answer(self, *a, **kw):
        return None

    async def edit_message_reply_markup(self, *a, **kw):
        return None


class UpdateDeBoton(object):
    def __init__(self, chat_id, data):
        self.callback_query = ConsultaFalsa(chat_id, data)
        self.message = None

    @property
    def effective_message(self):
        return self.callback_query.message

    @property
    def effective_chat(self):
        return self.callback_query.message.chat


class PostDoble(object):
    def __init__(self, respuestas):
        self.llamadas = []
        self.respuestas = respuestas

    def __call__(self, ruta, cuerpo):
        self.llamadas.append((ruta, cuerpo))
        if ruta in self.respuestas:
            return self.respuestas[ruta]
        if ruta == "/api/bot/pendiente":
            return 200, {"ok": True, "pendientes": []}
        return 200, {"ok": True}

    def rutas(self):
        return [r for r, c in self.llamadas]

    def cuerpos(self, ruta):
        return [c for r, c in self.llamadas if r == ruta]


class EnrutarEspia(object):
    def __init__(self):
        self.textos = []

    def __call__(self, *a, **kw):
        self.textos.append(a[0] if a else kw.get("texto"))
        return True, dict(intencion="otra", confianza="alta", entendido="x", campos={}, consulta=None,
                          filtro=None, respuesta="RESPUESTA DEL MODELO", hechos=[], faltantes=[], pregunta=None)


def correr(corutina, doble, espia):
    enrutar_original, post_original = B.enrutar, B._post
    B.enrutar = espia
    B._post = doble
    try:
        asyncio.run(corutina)
    finally:
        B.enrutar, B._post = enrutar_original, post_original


def limpiar():
    B._olvidar_chat(CHAT)
    B._memoria.pop(CHAT, None)
    B._pendientes.pop(CHAT, None)
    B._rehidratado.discard(CHAT)


def decir(texto, doble, espia, limpio=True):
    u = UpdateDeTexto(CHAT, texto)
    if limpio:
        limpiar()
    correr(B.manejar_texto(u, None), doble, espia)
    return u.message


def botones(mensaje):
    salida = []
    for teclado in mensaje.teclados:
        for fila in getattr(teclado, "inline_keyboard", None) or []:
            salida.extend(b.callback_data for b in fila)
    return salida


REAL = "Regalo una grande de norman en conferencia de IA"
RUTA = "/api/bot/regalo/proponer"
PROPUESTA = (200, {"ok": True, "borrador_id": BORRADOR, "sello": SELLO,
                   "mensaje": "REGALO: sale del inventario ... Contesta VA para escribirlo."})
CONTADOR = (200, {"ok": True, "consulta": True, "texto": "REGALOS de Kevin: 6 botellas"})
PREGUNTA_MOTIVO = (200, {"ok": False, "falta": "motivo", "texto": "Kevin regalo 5 grandes",
                         "pregunta": "Cual fue la razon?"})


def sin_precio(dichos):
    return not any(re.search(r"cost|precio|monto|[$]", d, re.I) for d in dichos)


# === 1. El mensaje real: propuesta, sin modelo y sin preguntar costo ============
doble, espia = PostDoble({RUTA: PROPUESTA}), EnrutarEspia()
m = decir(REAL, doble, espia)
caso("REAL: viaja tal cual a regalo/proponer", doble.cuerpos(RUTA), [{"telegram_id": CHAT, "texto": REAL}])
caso("REAL: el modelo NO se llama", espia.textos, [])
caso("REAL: no pregunta costo", sin_precio(m.dichos), True)
caso("REAL: boton VA de SU borrador", "va:" + BORRADOR in botones(m), True)
doble2 = PostDoble({"/api/bot/regalo/confirmar": (200, {"ok": True, "mensaje": "Listo. Norman regalo 1 botella."})})
m2 = decir("va", doble2, espia, limpio=False)
caso("VA: a regalo/confirmar con el sello y nada mas", doble2.cuerpos("/api/bot/regalo/confirmar"),
     [{"telegram_id": CHAT, "borrador_id": BORRADOR, "sello": SELLO}])
caso("VA: no toca gasto", "/api/bot/gasto/confirmar" in doble2.rutas(), False)
caso("VA: dice lo del servidor", m2.dichos[-1:], ["Listo. Norman regalo 1 botella."])

# === 2. Sin la ruta (404): un regalo de botellas no cae a gasto =================
doble, espia = PostDoble({RUTA: (404, {})}), EnrutarEspia()
m = decir(REAL, doble, espia)
caso("404: el modelo NO se llama", espia.textos, [])
caso("404: dice que no registro nada y no pide costo", ("No registre nada" in m.dichos[-1], sin_precio(m.dichos)), (True, True))
doble, espia = PostDoble({RUTA: (404, {})}), EnrutarEspia()
decir("regalo para la esposa de Gilberto 500 pesos", doble, espia)
caso("404: un gasto que dice regalo sigue al modelo", len(espia.textos), 1)
doble, espia = PostDoble({RUTA: (200, {"ok": False, "no_es_regalo": True})}), EnrutarEspia()
decir("regalo para la esposa de Gilberto 500", doble, espia)
caso("NO_ES_REGALO: sigue al modelo", len(espia.textos), 1)

# === 3. La pregunta en el aire ==================================================
doble, espia = PostDoble({RUTA: PREGUNTA_MOTIVO}), EnrutarEspia()
m = decir("Kevin regalo 5 grandes", doble, espia)
caso("PREGUNTA: la del servidor", m.dichos, ["Cual fue la razon?"])
doble, espia = PostDoble({RUTA: PROPUESTA}), EnrutarEspia()
m = decir("boda de Juan", doble, espia, limpio=False)
caso("RESPUESTA: viaja con el dictado original", doble.cuerpos(RUTA),
     [{"telegram_id": CHAT, "texto": "Kevin regalo 5 grandes", "completa": {"falta": "motivo", "dicho": "boda de Juan"}}])
caso("RESPUESTA: el modelo NO se llama", espia.textos, [])
decir("Kevin regalo 5 grandes", PostDoble({RUTA: PREGUNTA_MOTIVO}), EnrutarEspia())
doble, espia = PostDoble({RUTA: PROPUESTA}), EnrutarEspia()
decir("Solo registralo", doble, espia, limpio=False)
caso("SOLO REGISTRALO: se registra, no se repite la pregunta",
     [c.get("completa") for c in doble.cuerpos(RUTA)], [{"falta": "motivo", "dicho": "Solo registralo"}])
for otro in ("gasolina 300 desde spin", "vendi 2 grandes a aeropuerto", "cuanto hay en spin", "cancela"):
    decir("Kevin regalo 5 grandes", PostDoble({RUTA: PREGUNTA_MOTIVO}), EnrutarEspia())
    doble = PostDoble({RUTA: PROPUESTA})
    decir(otro, doble, EnrutarEspia(), limpio=False)
    caso("EN MEDIO: %r no es la razon" % otro, RUTA in doble.rutas(), False)
decir("Kevin regalo 5 grandes", PostDoble({RUTA: PREGUNTA_MOTIVO}), EnrutarEspia())
B._regalo_a_medias[CHAT]["cuando"] -= 3600
doble = PostDoble({RUTA: PROPUESTA})
decir("boda de Juan", doble, EnrutarEspia(), limpio=False)
caso("VENCIDA: a la hora ya no se completa", RUTA in doble.rutas(), False)

# === 4. El contador =============================================================
for t in ("regalos", "cuantos regalos lleva Kevin"):
    doble, espia = PostDoble({RUTA: CONTADOR}), EnrutarEspia()
    m = decir(t, doble, espia)
    caso("CONTADOR %r: contesta el texto del servidor" % t, m.dichos, ["REGALOS de Kevin: 6 botellas"])
    caso("CONTADOR %r: sin modelo y sin borrador" % t, (espia.textos, B._memoria.get(CHAT)), ([], None))
for args, esperado in (([], "regalos"), (["kevin"], "regalos de kevin")):
    doble = PostDoble({RUTA: CONTADOR})
    limpiar()
    correr(B.comando_regalos(UpdateDeTexto(CHAT, "/regalos"), type("C", (), {"args": args})()), doble, EnrutarEspia())
    caso("/regalos %s" % args, [c["texto"] for c in doble.cuerpos(RUTA)], [esperado])

# === 5. Puras ===================================================================
for falta, t, esperado in (("quien", "Kevin", True), ("quien", "fue Luis", True), ("piezas", "1 grande", True),
                           ("piezas", "boda de Juan", False), ("motivo", "regalo Luis 2 minis en la expo", False),
                           ("motivo", "evento de 500 pesos", False)):
    caso("CONTESTA %s %r" % (falta, t), B._contesta_al_regalo(falta, t), esperado)
limpiar()
B._regalo_a_medias.clear()

print("")
todo_bien = True
for nombre, obtenido, esperado in casos:
    bien = obtenido == esperado
    if not bien:
        todo_bien = False
    print("  [%s] %-70s  %s" % ("PASA" if bien else "FALLA", nombre,
                                "" if bien else "obtuve %r, esperaba %r" % (obtenido, esperado)))
print("")
print("RESULTADO:", "los %d casos pasan" % len(casos) if todo_bien else "HAY CASOS QUE FALLAN")
sys.exit(0 if todo_bien else 1)
