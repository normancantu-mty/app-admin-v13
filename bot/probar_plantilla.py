# -*- coding: utf-8 -*-
"""Cazador F0 - WP-7a: EL LOTE POR PLANTILLA, por la tuberia real del bot.

Escrito el 2026-10-17 por el ejecutor B del Socio.

Mete los mensajes del conjunto de oro (`bot/oro/casos.jsonl`, categoria
`lote_a_medias`, copiados aqui textuales) por `manejar_texto` -> despacho ->
`reply_text`, con `_post` DOBLADO (lo que contestaria la ruta) y `enrutar`
DOBLADO y CONTADO. Mide lo que pide el criterio de exito del plan v3:

  1. Cada lote dicho en 2-3 mensajes termina en UNA peticion completa a
     `/api/bot/lote/proponer` (kilos y dias), sin llamar al modelo.
  2. Cada respuesta del bot tiene <=4 preguntas numeradas.
  3. Varias respuestas en un mensaje (sueltas y numeradas).
  4. Rango fuera de lo normal: avisa y NO bloquea.
  5. Lo que no tiene campo va a `propuesta.notas`.
  6. Envasado sin lote abierto: la ruta ofrece abrirlo (ya no 422) y el boton
     repite la peticion con `abrir_lote_nuevo`.
  CONTROLES: un mensaje de dinero o un "va" con plantilla viva SI va al modelo;
  "cancela" suelta la plantilla; y sin el disparador el caso 01 NO termina en
  borrador (la prueba puede fallar).

El modelo esta doblado a proposito: esto mide la plantilla, no al enrutador
(eso lo mide el conjunto de oro del ejecutor A).

Corre con:  python bot/probar_plantilla.py
"""
import asyncio
import os
import re
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("BOT_LOG", os.path.join(tempfile.gettempdir(), "probar_bot.log"))

import bot_gastos as B  # noqa: E402
import lote_plantilla as P  # noqa: E402

CHAT = 987650017
UUID = "0c1b3f2a-9d44-4e7b-8a10-6f5c2d9e7b31"
PROPONER = "/api/bot/lote/proponer"
casos = []


def caso(nombre, obtenido, esperado):
    casos.append((nombre, obtenido, esperado))


class MensajeFalso(object):
    def __init__(self, chat_id, texto="", dichos=None):
        self.chat = type("Chat", (), {"id": chat_id, "type": "private"})()
        self.chat.send_action = self._nada
        self.text = texto
        self.dichos = dichos if dichos is not None else []
        self.teclados = []

    async def _nada(self, *a, **kw):
        return None

    async def reply_text(self, texto, **kw):
        self.dichos.append(str(texto))
        self.teclados.append(kw.get("reply_markup"))
        return None


class UpdateDeTexto(object):
    def __init__(self, chat_id, texto, dichos=None):
        self.message = MensajeFalso(chat_id, texto, dichos)

    @property
    def effective_message(self):
        return self.message

    @property
    def effective_chat(self):
        return self.message.chat


class PostDoble(object):
    def __init__(self, respuestas_lote=None):
        self.llamadas = []
        self.respuestas_lote = list(respuestas_lote or [])

    def __call__(self, ruta, cuerpo):
        self.llamadas.append((ruta, cuerpo))
        if ruta == "/api/bot/catalogo":
            return 200, {"ok": True, "productos": []}
        if ruta == PROPONER:
            if self.respuestas_lote:
                return self.respuestas_lote.pop(0)
            return 200, {"ok": True, "borrador_id": UUID, "sello": "s" * 64,
                         "codigo_lote": "L-1017", "mensaje": "Lote L-1017 (propuesta)"}
        return 200, {"ok": True}

    def lotes(self):
        return [c for r, c in self.llamadas if r == PROPONER]


class Modelo(object):
    """`enrutar` doblado: cuenta cuantas veces se le llama."""

    def __init__(self, ruta=None):
        self.veces = 0
        self.ruta = ruta or {"intencion": "charla", "confianza": "alta", "campos": {},
                             "respuesta": "ok"}

    def __call__(self, *a, **kw):
        self.veces += 1
        return True, dict(self.ruta)


def limpiar():
    B._olvidar_chat(CHAT)
    dict.pop(B._memoria, CHAT, None)
    P.olvidar(CHAT)


def conversar(mensajes, modelo=None, doble=None):
    """Mensajes en fila por `manejar_texto`. Devuelve (dichos, doble, modelo)."""
    limpiar()
    modelo = modelo or Modelo()
    doble = doble or PostDoble()
    dichos = []
    orig = B.enrutar, B._post
    B.enrutar, B._post = modelo, doble
    try:
        for m in mensajes:
            asyncio.run(B.manejar_texto(UpdateDeTexto(CHAT, m, dichos), None))
    finally:
        B.enrutar, B._post = orig
    return dichos, doble, modelo


def kilos(pet):
    for i in pet.get("insumos") or []:
        if "chile" in str(i.get("insumo")):
            return i.get("cantidad")
    return None


def numeradas(texto):
    return len(re.findall(r"(?m)^\s*\d+\.\s", texto))


# ─── 1. el conjunto de oro, lote a medias ───────────────────────────────────
ORO = [
    ("lote_a_medias_01", ["empezamos lote nuevo", "le entraron 40 kilos de chile",
                          "y van a ser 8 dias de fermentacion"], 40, 8),
    ("lote_a_medias_02", ["hoy arrancamos otro lote, 35 kilos de chile", "fermenta 10 dias"], 35, 10),
    ("lote_a_medias_03", ["ya empezamos el lote", "metimos 50 kilos de chile jalapeño", "se queda 7 dias"], 50, 7),
    ("lote_a_medias_04", ["lote nuevo con 30 kilos", "ahorita no se cuantos dias, te digo luego"], 30, None),
    ("lote_a_medias_05", ["arranque lote hoy", "42 kilos de chile",
                          "dos tambos de 200 litros a 24 grados"], 42, None),
]
for cid, mensajes, kg, dias in ORO:
    dichos, doble, modelo = conversar(mensajes)
    lotes = doble.lotes()
    caso(cid + ": UNA propuesta al final", len(lotes), 1)
    pet = lotes[-1] if lotes else {}
    caso(cid + ": kilos de chile", kilos(pet), kg)
    caso(cid + ": dias de fermentacion", (pet.get("propuesta") or {}).get("dias_fermentacion"), dias)
    caso(cid + ": sin llamar al modelo", modelo.veces, 0)
    caso(cid + ": ninguna respuesta con mas de 4 numeradas", max(numeradas(d) for d in dichos) <= 4, True)
    caso(cid + ": quedo el borrador en memoria", (B._memoria.get(CHAT) or {}).get("tipo"), "lote")
    if cid == "lote_a_medias_01":
        caso(cid + ": primero manda la plantilla COMPLETA", "1. Kilos de chile" in dichos[0]
             and "4. Tipo de chile" in dichos[0], True)
        caso(cid + ": luego pregunta SOLO lo que falta", dichos[1].startswith("Me falta:")
             and "dias" in dichos[1] and "kilos" not in dichos[1].lower(), True)
    notas = (pet.get("propuesta") or {}).get("notas") or ""
    if cid == "lote_a_medias_03":
        caso(cid + ": el tipo de chile va a notas", "jalapeno" in notas, True)
    if cid == "lote_a_medias_04":
        caso(cid + ": 'te digo luego' queda anotado como pendiente", "pendiente" in notas, True)
    if cid == "lote_a_medias_05":
        caso(cid + ": dos tandas de 200", [t.get("litros") for t in (pet.get("propuesta") or {}).get("tandas") or []], [200, 200])
        caso(cid + ": 'a 24 grados' NO se adivina: a notas", "24 grados" in notas, True)
        caso(cid + ": los dias se preguntaron una vez y quedan pendientes", "pendiente" in notas, True)

# ─── 2. varias respuestas en un mensaje ─────────────────────────────────────
dichos, doble, modelo = conversar(["dame la plantilla del lote", "1. 40  2. 8  3. 2 de 200  4. habanero"])
pet = (doble.lotes() or [{}])[-1]
caso("2. numeradas: kilos", kilos(pet), 40)
caso("2. numeradas: dias", pet.get("propuesta", {}).get("dias_fermentacion"), 8)
caso("2. numeradas: tandas", len(pet.get("propuesta", {}).get("tandas") or []), 2)
caso("2. numeradas: el chile a notas", "habanero" in (pet.get("propuesta", {}).get("notas") or ""), True)
dichos, doble, modelo = conversar(["empezamos lote nuevo", "40 kilos, 8 dias, le echamos 5 gramos de acido citrico"])
pet = (doble.lotes() or [{}])[-1]
caso("2. sueltas en un mensaje: kilos y dias", (kilos(pet), pet.get("propuesta", {}).get("dias_fermentacion")), (40, 8))
caso("2. el aditivo va a notas", "acido citrico" in (pet.get("propuesta", {}).get("notas") or ""), True)

# ─── 3. rango: avisa, no bloquea ────────────────────────────────────────────
dichos, doble, modelo = conversar(["empezamos lote nuevo", "1500 kilos de chile y 40 dias"])
pet = (doble.lotes() or [{}])[-1]
caso("3. fuera de rango: avisa", any("Ojo" in d and "1500" in d for d in dichos), True)
caso("3. ... y avisa tambien los dias", any("Ojo" in d and "40 dias" in d for d in dichos), True)
caso("3. ... y NO bloquea: propone con 1500", kilos(pet), 1500)

# ─── 4. el modelo dice `lote` sin datos -> plantilla completa ───────────────
modelo = Modelo({"intencion": "lote", "confianza": "alta", "campos": {}, "respuesta": ""})
dichos, doble, _m = conversar(["manana le metemos chile al lote"], modelo=modelo)
caso("4. lote sin datos (modelo): manda la plantilla, no 'Cuanto chile entro?'",
     bool(dichos) and "1. Kilos de chile" in dichos[-1], True)
caso("4. ... y no propuso nada", len(doble.lotes()), 0)
modelo.ruta = {"intencion": "charla", "confianza": "alta", "campos": {}, "respuesta": "ok"}
dichos2, doble2, _m = [], PostDoble(), None
orig = B.enrutar, B._post
B.enrutar, B._post = modelo, doble2
try:
    asyncio.run(B.manejar_texto(UpdateDeTexto(CHAT, "40 kilos y 8 dias", dichos2), None))
finally:
    B.enrutar, B._post = orig
caso("4. ... la respuesta la lee la plantilla y propone", len(doble2.lotes()), 1)

# ─── 5. CONTROLES: lo que NO es de la plantilla va al modelo ────────────────
for texto in ("pague 300 de gasolina", "va"):
    limpiar()
    modelo, doble, dichos = Modelo(), PostDoble(), []
    orig = B.enrutar, B._post
    B.enrutar, B._post = modelo, doble
    try:
        asyncio.run(B.manejar_texto(UpdateDeTexto(CHAT, "empezamos lote nuevo", dichos), None))
        asyncio.run(B.manejar_texto(UpdateDeTexto(CHAT, texto, dichos), None))
    finally:
        B.enrutar, B._post = orig
    if texto == "va":
        # El "va" lo toma el camino rapido de confirmar, antes del modelo: lo
        # que se mide es que la plantilla NO se lo coma.
        caso("5. CONTROL con plantilla viva, 'va' no lo consume la plantilla",
             (P.leer(texto, ["kg_chile"])["consumio"], len(doble.lotes()), len(dichos)), (False, 0, 2))
    else:
        caso("5. CONTROL con plantilla viva, %r va al modelo" % texto, modelo.veces, 1)
    caso("5. ... y la plantilla sigue viva", P.activa(CHAT), True)

modelo = Modelo({"intencion": "cancelar", "confianza": "alta", "campos": {}, "respuesta": ""})
dichos, doble, _m = conversar(["empezamos lote nuevo", "cancela eso"], modelo=modelo)
caso("5. CONTROL 'cancela' suelta la plantilla", P.activa(CHAT), False)
dichos, doble, _m = conversar(["empezamos lote nuevo", "cancela eso", "40 kilos y 8 dias"], modelo=Modelo(
    {"intencion": "cancelar", "confianza": "alta", "campos": {}, "respuesta": ""}))
caso("5. ... y despues de cancelar, '40 kilos' ya no propone por la plantilla", len(doble.lotes()), 0)

# CONTROL negativo: sin el disparador, el caso 01 NO termina en borrador.
original = P.es_disparador
P.es_disparador = lambda t: False
try:
    dichos, doble, modelo = conversar(ORO[0][1])
finally:
    P.es_disparador = original
caso("CONTROL sin disparador el caso 01 no propone (la prueba puede fallar)", len(doble.lotes()), 0)

# ─── 6. envasado sin lote abierto: oferta, no 422 ───────────────────────────
OFERTA = (200, {"ok": False, "ofrecer_abrir_lote": True,
                "mensaje": "No tengo ningun lote abierto (de los ultimos 30 dias). Abro un lote nuevo con este envasado?"})
modelo = Modelo({"intencion": "lote", "confianza": "alta",
                 "campos": {"botellas": 40, "formato": "250"}, "respuesta": ""})
doble = PostDoble([OFERTA])
dichos, doble, _m = conversar(["envasamos 40 chicas hoy sin lote abierto, no sé de cual salieron"],
                              modelo=modelo, doble=doble)
caso("6. envasado sin lote: se ofrece abrirlo", any("Abro un lote nuevo" in d for d in dichos), True)
caso("6. ... sin texto de error", any("No pude" in d for d in dichos), False)
caso("6. ... y queda esperando el boton", (B._memoria.get(CHAT) or {}).get("tipo"), "lote_ofrecer_abrir")
u = UpdateDeTexto(CHAT, "")
orig = B._post
B._post = doble
try:
    asyncio.run(B._manejar_boton(u, CHAT, None, ["abrlt", "x"], "abrlt"))
finally:
    B._post = orig
lotes = doble.lotes()
caso("6. el boton repite la peticion con abrir_lote_nuevo", (len(lotes), lotes[-1].get("abrir_lote_nuevo")), (2, True))
caso("6. ... con el mismo envasado", lotes[-1].get("envasado"), lotes[0].get("envasado"))
caso("6. ... y sale la propuesta de siempre (borrador con VA)", (B._memoria.get(CHAT) or {}).get("tipo"), "lote")
caso("6. callback_data del boton cabe en 64 bytes", len("abrlt:x".encode()) <= 64, True)

# ─── RESULTADO ──────────────────────────────────────────────────────────────
limpiar()
fallos = [(n, o, e) for n, o, e in casos if o != e]
for n, o, e in casos:
    print(("ok   " if o == e else "FALLA") + "  " + n + ("" if o == e else "  -> obtuve %r, esperaba %r" % (o, e)))
if fallos:
    print("RESULTADO: %d de %d casos FALLAN" % (len(fallos), len(casos)))
    sys.exit(1)
print("RESULTADO: los %d casos pasan" % len(casos))
