# -*- coding: utf-8 -*-
"""MERMA DESDE EL BOT: el lado del bot (2026-11-07).

Escrito el 2026-11-07 por el ejecutor del Socio (bot con paridad de la web, Fase 3).

El servidor (`/api/bot/merma/proponer`) lee la merma sin modelo. Aqui se prueba
que el bot:
  - "se rompieron 2 de 750" va a `/api/bot/merma/proponer` ANTES del modelo;
  - si el servidor dice `no_es_merma`, el mismo mensaje sigue al enrutador;
  - si falta un dato, contesta la pregunta del servidor y no llama al modelo;
  - la propuesta se ensena con el boton VA, y el VA (escrito o boton) va a
    `/api/bot/merma/confirmar` con `{telegram_id, borrador_id, sello}` y nada mas;
  - el 403 del servidor se dice tal cual;
  - el patron es el mismo que `PATRON_MERMA` del servidor (casos puros).

`_post` y `enrutar` doblados: ninguna peticion sale de este proceso.

Corre con:  python bot/probar_merma.py      (sin red, sin modelo)
"""
import asyncio
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["BOT_LOG"] = os.path.join(tempfile.gettempdir(), "probar_merma.log")

import bot_gastos as B  # noqa: E402


async def _alta_ok(update, clave):
    return True


B._puerta_de_privado = _alta_ok

CHAT = 555000778
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


PROPUESTA = (200, {"ok": True, "borrador_id": BORRADOR, "sello": SELLO,
                   "mensaje": "MERMA: sale del inventario y NO toca dinero ... Contesta VA para escribirlo."})
ESCRITA = (200, {"ok": True, "filas_inventario": 1,
                 "mensaje": "Salieron 2 piezas de Destilado Plata 750ml como merma."})

# === 1. Merma reconocida: propuesta con boton, sin modelo ======================
doble = PostDoble({"/api/bot/merma/proponer": PROPUESTA})
espia = EnrutarEspia()
m = decir("se rompieron 2 botellas de 750", doble, espia)
caso("MERMA: el texto viaja a /api/bot/merma/proponer",
     doble.cuerpos("/api/bot/merma/proponer"), [{"telegram_id": CHAT, "texto": "se rompieron 2 botellas de 750"}])
caso("MERMA: el modelo NO se llama", espia.textos, [])
caso("MERMA: se ensena la propuesta del servidor", [d.startswith("MERMA:") for d in m.dichos], [True])
caso("MERMA: la propuesta trae el boton VA de SU borrador", "va:" + BORRADOR in botones(m), True)
caso("MERMA: queda en memoria como merma", (B._memoria.get(CHAT) or {}).get("tipo"), "merma")

# === 2. VA escrito -> confirmar con el sello y nada mas ========================
doble2 = PostDoble({"/api/bot/merma/confirmar": ESCRITA})
m2 = decir("va", doble2, espia, limpio=False)
caso("VA: va a /api/bot/merma/confirmar con {telegram_id, borrador_id, sello}",
     doble2.cuerpos("/api/bot/merma/confirmar"), [{"telegram_id": CHAT, "borrador_id": BORRADOR, "sello": SELLO}])
caso("VA: no toca la ruta del gasto", "/api/bot/gasto/confirmar" in doble2.rutas(), False)
caso("VA: dice lo que escribio el servidor", m2.dichos[-1:],
     ["Salieron 2 piezas de Destilado Plata 750ml como merma."])

# === 3. VA por boton ===========================================================
doble = PostDoble({"/api/bot/merma/proponer": PROPUESTA})
decir("se cayo una de 750", doble, EnrutarEspia())
doble3 = PostDoble({"/api/bot/merma/confirmar": ESCRITA})
ub = UpdateDeBoton(CHAT, "va:" + BORRADOR)
correr(B.manejar_boton(ub, None), doble3, EnrutarEspia())
caso("BOTON: el VA del boton va a /api/bot/merma/confirmar",
     [c.get("borrador_id") for c in doble3.cuerpos("/api/bot/merma/confirmar")], [BORRADOR])

# === 4. No es merma: el mismo mensaje sigue al enrutador =======================
doble = PostDoble({"/api/bot/merma/proponer": (200, {"ok": False, "no_es_merma": True})})
espia = EnrutarEspia()
decir("se rompio la llanta, 300 del taller", doble, espia)
caso("NO_ES_MERMA: se pregunto al servidor", "/api/bot/merma/proponer" in doble.rutas(), True)
caso("NO_ES_MERMA: el mensaje sigue al modelo", len(espia.textos), 1)

# === 5. Falta un dato: la pregunta del servidor ================================
PREGUNTA = "Merma de Destilado Plata 750ml: cuantas piezas?"
doble = PostDoble({"/api/bot/merma/proponer": (200, {"ok": False, "pregunta": PREGUNTA})})
espia = EnrutarEspia()
m = decir("se rompieron botellas de 750", doble, espia)
caso("PREGUNTA: se dice la pregunta del servidor", m.dichos, [PREGUNTA])
caso("PREGUNTA: el modelo NO se llama", espia.textos, [])

# === 6. 403 =====================================================================
NO_TOCA = "Registrar merma por aqui no te toca con tu alta."
doble = PostDoble({"/api/bot/merma/proponer": (403, {"error": NO_TOCA})})
m = decir("se rompieron 2 de 750", doble, EnrutarEspia())
caso("403: se dice el error del servidor", m.dichos, [NO_TOCA])

# === 7. Sin palabra de merma: ni se pregunta al servidor =======================
doble = PostDoble({})
decir("gasolina 300 desde spin", doble, EnrutarEspia())
caso("SIN PATRON: no se llama a merma/proponer", "/api/bot/merma/proponer" in doble.rutas(), False)

# === 8. El patron, puro (mismo que PATRON_MERMA del servidor) ==================
for t, esperado in [("merma de 2 de 750", True), ("Se rompió una de 750", True), ("se nos cayeron 3", True),
                    ("llegaron 2 rotas", True), ("una quebrada", True), ("vendi 2 de 750 a aeropuerto", False),
                    ("cuanto hay en spin", False), ("gasolina 300", False)]:
    caso("PATRON: %r" % t, B._habla_de_merma(t), esperado)
caso("RUTA: el VA de merma va a su ruta", B.RUTA_CONFIRMAR_DE.get("merma"), "/api/bot/merma/confirmar")
limpiar()

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
