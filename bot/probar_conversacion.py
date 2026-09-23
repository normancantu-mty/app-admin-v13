# -*- coding: utf-8 -*-
"""EL CONJUNTO DORADO — las frases de Norman, corridas por la tuberia real.

─── LAS TRES ASERCIONES, Y DE DONDE SALEN ──────────────────────────────────────

Norman, 2026-09-19: *«Sigue muy cuadrado.»* · *«No comprende.»* Las dos frases
que vio salen de una sola linea de Python que publicaba `entendido` --telemetria
del enrutador-- como si fuera la respuesta:

    Norman: anula el movimiento anterior  ->  "quiere anular el movimiento anterior"
    Norman: sii                           ->  "solo dijo que si, sin decir a que"

**El bot no le hablaba a Norman: lo narraba ante un tercero que no existe.**

Asi que esta prueba exige tres cosas, y las tres sobre lo que SALE A PANTALLA:

  1. **ninguna respuesta publica `entendido`** -- ni crudo ni con prefijo;
  2. **`sii` con una propuesta viva la confirma** -- no la degrada a charla;
  3. **ninguna respuesta habla de Norman en tercera persona.**

─── COMO ESTA HECHA, Y QUE NO ES ───────────────────────────────────────────────

Corre la tuberia de verdad: `manejar_texto` -> `_enrutar_y_despachar` ->
despacho -> `reply_text`. Lo que se lee son los textos que el bot le habria
mandado a Telegram.

**El modelo esta DOBLADO, y se dice aqui en vez de esconderlo.** `enrutar` se
sustituye por una funcion que devuelve el JSON que devolveria el modelo --con el
`entendido` envenenado a proposito, con las frases textuales del incidente--.
Eso NO mide si el modelo clasifica bien: mide que **lo que el modelo devuelve no
se le escupa a Norman en la cara**, que es exactamente donde estaba el defecto.
Clasificar es la capa 1 y ya funcionaba: el log del 2026-09-19 tiene las cuatro
intenciones bien clasificadas y la conversacion fue un fracaso igual.

Corre con:  python bot/probar_conversacion.py
"""
import asyncio
import os
import re
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# D46 (Fase 6): **el log va a un temporal, y esta linea tiene que ir ANTES del
# import.** `bot_gastos` instala su `FileHandler` al importarse; sin esto, correr
# esta prueba escribe en `bot/bot_gastos.log` y le reinicia el reloj al detector
# de cuelgue de `decidir_reinicio.py`, que mide por el `mtime` de ese archivo.
os.environ.setdefault(
    "BOT_LOG", os.path.join(tempfile.gettempdir(), "probar_bot.log"))

import bot_gastos as B  # noqa: E402

CHAT = 987654321
UUID = "0c1b3f2a-9d44-4e7b-8a10-6f5c2d9e7b31"

# Las dos frases TEXTUALES que Norman vio en pantalla el 2026-09-19. No son
# inventadas para la prueba: estan en la transcripcion.
VENENO_ANULAR = "quiere anular el movimiento anterior"
VENENO_SII = "solo dijo que si, sin decir a que"

# Como suena un bot que narra a su usuario ante un tercero. Si una respuesta
# empieza asi, volvio el defecto aunque `entendido` ya no exista.
TERCERA_PERSONA = re.compile(
    r"\b(quiere|quiso|queria|dijo|decia|pidio|pregunto|solicito|menciono|"
    r"esta pidiendo|el usuario|norman)\b", re.IGNORECASE)

casos = []


def caso(nombre, obtenido, esperado, detalle=""):
    casos.append((nombre, obtenido, esperado, detalle))


class MensajeFalso(object):
    def __init__(self, chat_id, texto=""):
        self.chat = type("Chat", (), {"id": chat_id, "send_action": None})()
        self.chat.send_action = self._nada
        self.text = texto
        self.dichos = []

    async def _nada(self, *a, **kw):
        return None

    async def reply_text(self, texto, **kw):
        self.dichos.append(str(texto))
        return None

    async def send_action(self, _a):
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


class PostDoble(object):
    def __init__(self, respuestas=None):
        self.llamadas = []
        self.respuestas = respuestas or {}

    def __call__(self, ruta, cuerpo):
        self.llamadas.append((ruta, cuerpo))
        if ruta == "/api/bot/catalogo":
            return 200, {"ok": True, "productos": [
                {"id": "c1000000-0000-0000-0000-000000000001",
                 "sku": "plata-750ml", "nombre": "Destilado Plata 750ml",
                 "ml_por_unidad": 750}]}
        return self.respuestas.get(ruta, (500, {"error": "No pude proponerlo."}))

    def rutas(self):
        return [r for r, _ in self.llamadas]


def hablar(texto, ruta_del_modelo, respuestas=None, preparar=None):
    """Mete una frase por la tuberia real y devuelve lo que el bot contesto.

    `ruta_del_modelo` es lo que devolveria el modelo. Se sustituye `enrutar`,
    no `_enrutar_y_despachar`: todo el despacho corre de verdad.
    """
    u = UpdateDeTexto(CHAT, texto)
    doble = PostDoble(respuestas)
    enrutar_original, post_original = B.enrutar, B._post

    def enrutar_doble(*a, **kw):
        return True, dict(ruta_del_modelo)

    B.enrutar, B._post = enrutar_doble, doble
    try:
        if preparar:
            preparar()
        asyncio.run(B.manejar_texto(u, None))
    finally:
        B.enrutar, B._post = enrutar_original, post_original
    return u.message.dichos, doble


def limpiar():
    B._olvidar_chat(CHAT)
    B._memoria.pop(CHAT, None)
    B._esperando_monto.pop(CHAT, None)
    B._esperando_vigencia.pop(CHAT, None)
    B._esperando_correccion.pop(CHAT, None)


def propuesta_viva(tipo="gasto"):
    B._memoria[CHAT] = {"tipo": tipo, "borrador_id": UUID, "sello": "s3ll0",
                        "propuesta": {"monto": 1000.0}}


# ═══════════════ 1. `entendido` NO SALE A PANTALLA. NUNCA. (D26) ═════════════
#
# Se pasan las frases de Norman por TODAS las intenciones que pueden contestar
# sin escribir nada -- que son las que publicaban el eco -- con el `entendido`
# envenenado. Ni una sola respuesta puede contenerlo.

FRASES = [
    ("anula el movimiento anterior",
     dict(intencion="anular", confianza="alta", entendido=VENENO_ANULAR,
          campos={}, respuesta="Cual quieres anular?")),
    ("sii", dict(intencion="charla", confianza="baja", entendido=VENENO_SII,
                 campos={}, respuesta="Si a que? No tengo nada en pantalla.")),
    ("12 de 750 ml, 12 de 250 ml y 48 de 50ml",
     dict(intencion="cotizacion", confianza="alta",
          entendido="quiere cotizar tres productos", campos={},
          respuesta="Va, te la armo.")),
    ("como vamos hoy", dict(intencion="reporte", confianza="alta",
                            entendido="pregunto como va el dia", campos={})),
    ("que pedo", dict(intencion="charla", confianza="alta",
                      entendido="solo esta saludando", campos={},
                      respuesta="Aqui ando. Que hiciste?")),
    ("no se", dict(intencion="consulta", confianza="alta",
                   entendido="el usuario no sabe que quiere", campos={})),
    ("una venta", dict(intencion="venta", confianza="alta",
                       entendido="quiere registrar una venta", campos={})),
    ("entro chile", dict(intencion="lote", confianza="alta",
                         entendido="dijo que entro chile", campos={})),
]

sucias, terceras = [], []
for texto, ruta in FRASES:
    limpiar()
    dichos, _ = hablar(texto, ruta)
    for d in dichos:
        if str(ruta.get("entendido")) in d:
            sucias.append((texto, d))
        if TERCERA_PERSONA.search(d):
            terceras.append((texto, d))

caso("VERDE - ninguna respuesta publica `entendido` (%d frases)" % len(FRASES),
     sucias, [], "")
caso("VERDE - ninguna respuesta habla de Norman en tercera persona",
     terceras, [], "")

# Control de que el detector SI muerde: si `TERCERA_PERSONA` no casara con
# nada, la asercion de arriba seria decorativa.
caso("ROJO  - el detector reconoce la frase original",
     bool(TERCERA_PERSONA.search(VENENO_ANULAR)
          and TERCERA_PERSONA.search(VENENO_SII)), True, "")

# Y el gemelo: el detector no puede marcar una respuesta sana.
caso("ROJO  - el detector NO marca una respuesta en segunda persona",
     bool(TERCERA_PERSONA.search("Listo. Quedo escrito.")), False, "")


# ═══════════════ 2. `sii` CON PROPUESTA VIVA LA CONFIRMA (D28/D29) ═══════════

limpiar()
dichos, doble = hablar(
    "sii",
    dict(intencion="confirmar", confianza="alta", entendido=VENENO_SII, campos={}),
    respuestas={"/api/bot/gasto/confirmar": (200, {"ok": True})},
    preparar=propuesta_viva)
caso("VERDE - `sii` con propuesta viva LLAMA a confirmar",
     "/api/bot/gasto/confirmar" in doble.rutas(), True, str(doble.rutas()))
caso("VERDE - ...y contesta que quedo escrito", dichos, ["Listo. Quedo escrito."])

# Lo que el modelo ve es lo que decide si puede resolver el "sii". Si
# `_en_pantalla` devolviera "", el modelo no tendria contra que interpretarlo
# y "sii" volveria a salir `charla`, que es lo que paso el 2026-09-19.
limpiar()
propuesta_viva()
pantalla = B._en_pantalla(CHAT)
caso("VERDE - con propuesta viva, el modelo SABE que hay algo en pantalla",
     pantalla != "" and "esperando" in pantalla, True, repr(pantalla))

# ── CONTROL NEGATIVO: `sii` SIN nada pendiente no puede escribir nada. ───────
#    Es el que le da valor al de arriba: un bot que confirma siempre escribe
#    filas que nadie pidio.
limpiar()
dichos, doble = hablar(
    "sii", dict(intencion="confirmar", confianza="alta", entendido=VENENO_SII,
                campos={}),
    respuestas={"/api/bot/gasto/confirmar": (200, {"ok": True})})
caso("ROJO  - `sii` sin nada pendiente NO llama a confirmar",
     "/api/bot/gasto/confirmar" in doble.rutas(), False, str(doble.rutas()))
caso("ROJO  - ...y lo dice sin narrar a Norman",
     dichos, ["No tengo nada pendiente que escribir."])

# ── CONTROL NEGATIVO: sin sello no hay confirmacion. Un borrador a medias
#    comparte casilla con uno sellado, y un "va" adelantado no puede escribir.
limpiar()
B._memoria[CHAT] = {"tipo": "gasto", "estado": "incompleto", "campos": {}}
dichos, doble = hablar(
    "sii", dict(intencion="confirmar", confianza="alta", entendido="", campos={}),
    respuestas={"/api/bot/gasto/confirmar": (200, {"ok": True})})
caso("ROJO  - un borrador incompleto NO se confirma",
     "/api/bot/gasto/confirmar" in doble.rutas(), False, str(doble.rutas()))


# ═══════════════ 3. EL MODELO REDACTA, PYTHON DESPACHA (D27) ═════════════════

limpiar()
REDACTADA = "Aqui ando. Que hiciste hoy?"
dichos, _ = hablar("que onda", dict(intencion="charla", confianza="alta",
                                    entendido="solo saludo", campos={},
                                    respuesta=REDACTADA))
caso("VERDE - si el modelo redacta, habla el modelo", dichos, [REDACTADA])

# CONTROL NEGATIVO: si el modelo NO redacta, se cae a la cadena fija -- **no al
# `entendido`**. Ese fallback era la linea exacta del defecto.
limpiar()
dichos, _ = hablar("asdfgh", dict(intencion="charla", confianza="alta",
                                  entendido="no se entiende que quiso decir",
                                  campos={}, respuesta=""))
caso("ROJO  - sin redaccion NO se cae al `entendido`",
     "no se entiende" in dichos[0], False, dichos[0])
caso("ROJO  - ...sino a la frase fija",
     dichos, ["No te entendi. Dime que hiciste o que quieres saber."])


# ═══════════════ 4. ESTANDO EN UN ESTADO, SE ENRUTA (D31) ════════════════════
#
# "De cuanto era? Solo el numero" + "mejor cancela" contestaba *"No lo lei como
# numero. Solo la cifra, por favor."* Eso es lo cuadrado, con nombre propio: el
# modelo apagado y el bot vuelto formulario.

limpiar()


def esperando_monto():
    propuesta_viva()
    B._esperando_monto[CHAT] = True


dichos, doble = hablar(
    "mejor cancela",
    dict(intencion="cancelar", confianza="alta", entendido="quiere cancelar",
         campos={}),
    respuestas={"/api/bot/cancelar": (200, {"ok": True})},
    preparar=esperando_monto)
caso("VERDE - esperando un monto, 'mejor cancela' NO regaña",
     any("Solo la cifra" in d for d in dichos), False, str(dichos))
caso("VERDE - ...y cancela de verdad",
     "/api/bot/cancelar" in doble.rutas(), True, str(doble.rutas()))

# CONTROL NEGATIVO: el camino rapido sigue existiendo. Si el texto SI es el
# numero, no se paga una llamada al modelo.
limpiar()
dichos, doble = hablar(
    "1500",
    dict(intencion="charla", confianza="alta", entendido="NO DEBERIA LLAMARSE",
         campos={}),
    respuestas={"/api/bot/gasto/proponer": (500, {"error": "x"})},
    preparar=esperando_monto)
caso("ROJO  - un monto de verdad NO pasa por el modelo",
     "/api/bot/catalogo" in doble.rutas(), False, str(doble.rutas()))

print("")
todo_bien = True
for nombre, obtenido, esperado, detalle in casos:
    bien = obtenido == esperado
    if not bien:
        todo_bien = False
    print("  [%s] %-56s  %s" % ("PASA" if bien else "FALLA", nombre,
                                detalle if bien else "obtuve %r, esperaba %r"
                                % (obtenido, esperado)))
print("")
print("RESULTADO:", "los %d casos pasan" % len(casos) if todo_bien
      else "HAY CASOS QUE FALLAN")
sys.exit(0 if todo_bien else 1)
