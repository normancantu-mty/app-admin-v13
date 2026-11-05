# -*- coding: utf-8 -*-
"""2026-11-03 -- GRUPOS SILENCIOSOS ("Fresnillo - Equipo"). Escrito el 2026-11-03
por el ejecutor del Socio (bot ERP, fotos + grupo Equipo).

Corre el DESPACHO real: arma los handlers con `main()` (app falsa), y a cada
`Update` REAL de PTB (`Update.de_json`) le aplica la regla de PTB: por grupo, en
orden ascendente, corre el primer handler cuyo `check_update` acepta.

Lo que se exige (y lo que lo tumba):
  1. Norman dice "gaste 300 de diesel" en el grupo silencioso: CERO respuestas,
     CERO llamadas al ERP (ni borrador), UNA fila en la bitacora. Se tumba quitando
     `_Silencio` de `main()`: CONTROL, el mismo mensaje en un grupo normal llega a
     `manejar_texto`.
  2. Foto, documento y voz: se anotan y no los atiende nadie.
  3. Un desconocido dice hola: no se pregunta "quien es".
  4. Mencion explicita (@ERPFresnilloBot): SI llega al handler de texto.
  5. El bot entra a un grupo con "Equipo" en el titulo: se registra solo, sin
     saludar; el update siguiente del grupo ya esta callado.

Corre con:  python bot/probar_silencio.py      (sin red, sin modelo)
"""
import asyncio
import io
import json
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
CARPETA = tempfile.mkdtemp(prefix="probar_silencio_")
LISTA = os.path.join(CARPETA, "grupos_silenciosos.json")
os.environ["BOT_GRUPOS_SILENCIOSOS"] = LISTA
os.environ["BOT_COMPROBANTES"] = os.path.join(CARPETA, "comprobantes")
os.environ.setdefault("BOT_LOG", os.path.join(tempfile.gettempdir(), "probar_bot.log"))
os.environ.pop("BOT_ENSAYO", None)

from telegram import Update as UpdateTG  # noqa: E402

import bitacora  # noqa: E402
import bot_gastos as B  # noqa: E402
import grupos_silenciosos as GS  # noqa: E402

NORMAN = B.NORMAN_TELEGRAM_ID
EQUIPO = -1009999999999
NORMAL = -1001111111111
DESCONOCIDO = 444
casos = []


def caso(nombre, obtenido, esperado):
    casos.append((nombre, obtenido, esperado))


class AppFalsa(object):
    def __init__(self):
        self.handlers = []

    def builder(self):
        return self

    def bot(self, _b):
        return self

    def post_init(self, _f):
        return self

    def build(self):
        return self

    def add_handler(self, h, group=0):
        self.handlers.append((group, h))

    def add_error_handler(self, _h):
        return None

    def run_polling(self, **k):
        return None


def handlers_de_main():
    app = AppFalsa()
    guardados = (B.Application, B.TOKEN_TG, B.TOKEN_API, B._candado)
    B.Application, B.TOKEN_TG, B.TOKEN_API, B._candado = app, "x", "y" * 30, (lambda: None)
    try:
        B.main()
    finally:
        B.Application, B.TOKEN_TG, B.TOKEN_API, B._candado = guardados
    return app.handlers


HANDLERS = handlers_de_main()


def despacha(update):
    """Los callbacks que PTB correria: el primero que acepta en cada grupo."""
    salida = []
    for grupo in sorted(set(g for g, _h in HANDLERS)):
        for g, h in HANDLERS:
            if g == grupo and h.check_update(update):
                salida.append(h)
                break
    return salida


def nombres(update):
    return [getattr(h.callback, "__name__", "?") for h in despacha(update)]


_n = [100]


def mensaje(chat, de=NORMAN, titulo="Fresnillo \u00b7 Equipo", **extra):
    _n[0] += 1
    m = {"message_id": _n[0], "date": 1762000000,
         "chat": {"id": chat, "type": "supergroup", "title": titulo},
         "from": {"id": de, "is_bot": False, "first_name": "X"}}
    m.update(extra)
    return UpdateTG.de_json({"update_id": _n[0], "message": m}, None)


FOTO = [{"file_id": "f1", "file_unique_id": "u1", "width": 90, "height": 90},
        {"file_id": "f2", "file_unique_id": "u2", "width": 900, "height": 900}]

# \u2500\u2500 1. El caso que pidio el coordinador, con el despacho y la bitacora reales \u2500\u2500
GS.agregar(EQUIPO, "Fresnillo \u00b7 Equipo")
filas = []
respuestas = []
al_erp = []


def enviar(ruta_o_fila, *a, **k):
    filas.append(ruta_o_fila)
    return True


async def corre(update):
    """Lo que hace PTB: cada callback, en orden, y nada mas."""
    for h in despacha(update):
        await h.callback(update, None)


actualizaciones = mensaje(EQUIPO, text="gaste 300 de diesel")
caso("1. 'gaste 300 de diesel' en silencioso: solo bitacora + silencio",
     nombres(actualizaciones), ["anotar_update", "_callar"])

original_post = B._post_de_verdad
B._post_de_verdad = lambda ruta, cuerpo: (al_erp.append(ruta), (200, {"ok": True}))[1]
guardado_anota = bitacora.anotar


def anota(fila):
    filas.append(fila)
    return True


bitacora.anotar = anota
bitacora.configurar(enviar=lambda *a, **k: True, directorio=CARPETA, activa=True)
try:
    asyncio.run(corre(actualizaciones))
except Exception as e:
    caso("1. sin excepcion", repr(e), None)
caso("1. cero llamadas al ERP (ni identidad, ni borrador)", al_erp, [])
caso("1. cero borradores en memoria", dict(B._memoria), {})
caso("1. UNA fila en la bitacora", len(filas), 1)
caso("1. la fila trae el texto y el chat", (filas[0].get("texto"), filas[0].get("chat_id")),
     ("gaste 300 de diesel", EQUIPO))
bitacora.anotar = guardado_anota
B._post_de_verdad = original_post

# CONTROL: la misma frase, en un grupo normal, si llega al handler de texto.
caso("1. CONTROL: en un grupo normal llega a manejar_texto",
     nombres(mensaje(NORMAL, titulo="Ventas", text="gaste 300 de diesel")),
     ["anotar_update", "manejar_texto"])

# \u2500\u2500 2. Foto, documento, voz, comando \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
caso("2. foto", nombres(mensaje(EQUIPO, photo=FOTO, caption="ticket")), ["anotar_update", "_callar"])
caso("2. CONTROL: foto en grupo normal va a manejar_foto",
     nombres(mensaje(NORMAL, titulo="Ventas", photo=FOTO)), ["anotar_update", "manejar_foto"])
DOC = {"file_id": "d1", "file_unique_id": "d", "mime_type": "image/jpeg", "file_name": "a.jpg"}
caso("2. documento", nombres(mensaje(EQUIPO, document=DOC)), ["anotar_update", "_callar"])
VOZ = {"file_id": "v1", "file_unique_id": "v", "duration": 3}
caso("2. voz", nombres(mensaje(EQUIPO, voice=VOZ)), ["anotar_update", "_callar"])
caso("2. CONTROL: voz en grupo normal", nombres(mensaje(NORMAL, titulo="Ventas", voice=VOZ)),
     ["anotar_update", "manejar_voz"])
caso("2. comando sin mencion",
     nombres(mensaje(EQUIPO, text="/cartera", entities=[{"type": "bot_command", "offset": 0, "length": 8}])),
     ["anotar_update", "_callar"])

# \u2500\u2500 3. Desconocido \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
caso("3. un desconocido dice hola: nadie pregunta quien es",
     nombres(mensaje(EQUIPO, de=DESCONOCIDO, text="hola")), ["anotar_update", "_callar"])
caso("3. entra alguien al grupo: no se le pregunta",
     nombres(mensaje(EQUIPO, new_chat_members=[{"id": DESCONOCIDO, "is_bot": False, "first_name": "G"}])),
     ["anotar_update", "_callar"])
caso("3. CONTROL: en grupo normal la entrada va a manejar_entrada",
     nombres(mensaje(NORMAL, titulo="Ventas",
                     new_chat_members=[{"id": DESCONOCIDO, "is_bot": False, "first_name": "G"}])),
     ["anotar_update", "manejar_entrada"])

# \u2500\u2500 4. Mencion explicita \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
caso("4. con mencion SI llega al handler de texto",
     nombres(mensaje(EQUIPO, text="@ERPFresnilloBot cuanto hay de stock")),
     ["anotar_update", "manejar_texto"])
caso("4. la mencion no distingue mayusculas",
     nombres(mensaje(EQUIPO, text="oye @erpfresnillobot ayuda")), ["anotar_update", "manejar_texto"])
caso("4. foto con mencion en el pie",
     nombres(mensaje(EQUIPO, photo=FOTO, caption="@ERPFresnilloBot ticket")),
     ["anotar_update", "manejar_foto"])
caso("4. CONTROL: mencionar a otro no cuenta",
     nombres(mensaje(EQUIPO, text="@otrobot hola")), ["anotar_update", "_callar"])

# \u2500\u2500 5. Registro solo \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
NUEVO = -1007777777777
caso("5. antes del registro no estaba", NUEVO in GS.ids(), False)
entra = mensaje(NUEVO, titulo="Fresnillo \u00b7 EQUIPO",
                new_chat_members=[{"id": 999, "is_bot": True, "first_name": "bot"}])
caso("5. el bot entra a un 'Equipo': no saluda ni pregunta", nombres(entra), ["anotar_update", "_callar"])
caso("5. quedo en la lista", NUEVO in GS.ids(), True)
with io.open(LISTA, encoding="utf-8") as f:
    caso("5. y en el archivo, con titulo", [c["titulo"] for c in json.load(f)["chats"] if c["chat_id"] == NUEVO],
         ["Fresnillo \u00b7 EQUIPO"])
caso("5. CONTROL: un grupo sin 'Equipo' no se registra",
     (nombres(mensaje(NORMAL, titulo="Ventas", text="hola")), NORMAL in GS.ids()),
     (["anotar_update", "manejar_texto"], False))
caso("5. sin acento ni mayusculas tambien", GS.titulo_de_equipo("EQUIPO fresnillo"), True)
caso("5. CONTROL: 'equipaje' no es equipo", GS.titulo_de_equipo("Equipaje"), False)

# Privado: nunca se calla, aunque el id coincidiera.
privado = UpdateTG.de_json({"update_id": 9000, "message": {
    "message_id": 9000, "date": 1762000000, "chat": {"id": NORMAN, "type": "private"},
    "from": {"id": NORMAN, "is_bot": False, "first_name": "N"}, "text": "gaste 300 de diesel"}}, None)
caso("CONTROL: en privado sigue llegando", nombres(privado), ["anotar_update", "manejar_texto"])

# \u2500\u2500 Resultado \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
malos = 0
for nombre, obtenido, esperado in casos:
    bien = obtenido == esperado
    malos += 0 if bien else 1
    print(("OK    " if bien else "FALLA ") + nombre)
    if not bien:
        print("      obtenido:", repr(obtenido)[:300])
        print("      esperado:", repr(esperado)[:300])
print("RESULTADO: %d de %d casos FALLAN" % (malos, len(casos)))
shutil.rmtree(CARPETA, ignore_errors=True)
sys.exit(1 if malos else 0)
