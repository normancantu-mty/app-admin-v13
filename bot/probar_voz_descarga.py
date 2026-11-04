# -*- coding: utf-8 -*-
"""E-612: UNA NOTA DE VOZ QUE NO BAJA YA NO SE PIERDE EN SILENCIO.

Escrito el 2026-10-21 por el Socio.

Medido en produccion (bitacora + bot_gastos.log, 2026-10-21): las notas de voz
de las 09:04:59 y 14:29:30 quedaron `procesado=false`, sin transcripcion y sin
respuesta. A los 4-6 s el log dice "red inestable con Telegram (TimedOut)":
`get_file`/`download_to_drive` iban con el read_timeout por defecto de PTB
22.8 (5 s) y sin reintento; el manejador de errores trata TimedOut como
transitorio y NO le dice nada al usuario. Norman pregunto "Estas ahi?".

Aqui, con dobles del bot de Telegram:
  1. `_bajar_voz` pasa timeouts EXPLICITOS a get_file y a download_to_drive.
  2. Primer intento TimedOut -> UN reintento, y la nota baja.
  3. Dos fallos de red seguidos -> False (no hay tercer intento).
  4. Un error que no es de red (BadRequest) -> False sin reintento.
  5. `manejar_voz` con la descarga caida: le CONTESTA a Norman el aviso y no
     intenta transcribir.
  CONTROL: sin fallos, una sola llamada a get_file.

Corre con:  python bot/probar_voz_descarga.py      (sin red)
"""
import asyncio
import os
import sys
import tempfile
import types
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("BOT_LOG", os.path.join(tempfile.gettempdir(), "probar_bot.log"))
os.environ.pop("BOT_ENSAYO", None)

import bot_gastos as B  # noqa: E402
from telegram.error import BadRequest, NetworkError, TimedOut  # noqa: E402

casos = []


def caso(nombre, obtenido, esperado):
    casos.append((nombre, obtenido, esperado))


class Archivo(object):
    def __init__(self, guion):
        self.guion = guion
        self.kwargs = []

    async def download_to_drive(self, ruta, **k):
        self.kwargs.append(dict(k))
        falla = self.guion.pop(0) if self.guion else None
        if falla is not None:
            raise falla
        Path(ruta).write_bytes(b"OggS")


class BotTg(object):
    """`get_file` doblado: falla segun el guion (en get_file) y anota llamadas."""

    def __init__(self, guion_get=(), guion_bajar=()):
        self.guion_get = list(guion_get)
        self.guion_bajar = list(guion_bajar)
        self.llamadas = []
        self.archivo = Archivo(self.guion_bajar)

    async def get_file(self, file_id, **k):
        self.llamadas.append(dict(k))
        falla = self.guion_get.pop(0) if self.guion_get else None
        if falla is not None:
            raise falla
        return self.archivo


def bajar(bot):
    destino = Path(tempfile.mkdtemp()) / "nota.ogg"
    ok = asyncio.run(B._bajar_voz(bot, "fid", destino))
    return ok, destino.exists()


# 1 + CONTROL
bot = BotTg()
ok, existe = bajar(bot)
caso("CONTROL sin fallos: baja a la primera", (ok, existe, len(bot.llamadas)), (True, True, 1))
caso("1. get_file lleva los timeouts explicitos", bot.llamadas[0], B.TIMEOUTS_DESCARGA)
caso("1. download_to_drive tambien", bot.archivo.kwargs[0], B.TIMEOUTS_DESCARGA)
caso("1. read_timeout ya no es el default de 5 s", B.TIMEOUTS_DESCARGA["read_timeout"] >= 30, True)

# 2
bot = BotTg(guion_get=[TimedOut()])
caso("2. TimedOut en get_file -> un reintento y baja", bajar(bot) + (len(bot.llamadas),), (True, True, 2))
bot = BotTg(guion_bajar=[NetworkError("x")])
caso("2. NetworkError al bajar -> un reintento y baja", bajar(bot) + (len(bot.llamadas),), (True, True, 2))

# 3
bot = BotTg(guion_get=[TimedOut(), TimedOut()])
caso("3. dos TimedOut seguidos -> se rinde, sin tercer intento", bajar(bot) + (len(bot.llamadas),), (False, False, 2))

# 4
bot = BotTg(guion_get=[BadRequest("file is too big")])
caso("4. BadRequest -> False sin reintento", bajar(bot) + (len(bot.llamadas),), (False, False, 1))


# 5. manejar_voz con la descarga caida: aviso, y NO se transcribe
class Usuario(object):
    id, is_bot, username, first_name, last_name = 6571822622, False, "n", "N", None


class Chat(object):
    def __init__(self, cid):
        self.id, self.type = cid, "private"

    async def send_action(self, *a, **k):
        return None


class Mensaje(object):
    def __init__(self, cid):
        self.chat = Chat(cid)
        self.from_user = Usuario()
        self.voice = types.SimpleNamespace(file_id="fid", duration=3)
        self.message_id, self.text, self.caption, self.date = 1, None, None, None
        self.reply_to_message, self.entities, self.caption_entities = None, [], []
        self.dichos = []

    async def reply_text(self, texto, **k):
        self.dichos.append(str(texto))


class Update(object):
    def __init__(self, m):
        self.message, self.edited_message, self.channel_post, self.callback_query = m, None, None, None
        self.effective_user = m.from_user

    @property
    def effective_message(self):
        return self.message

    @property
    def effective_chat(self):
        return self.message.chat

    def get_bot(self):
        return None


transcribio = [0]


def transcribir_que_no_debe_correr(ruta, vocab=None):
    transcribio[0] += 1
    return True, "no debia llegar aqui"


sys.modules["transcribir_nota"] = types.SimpleNamespace(transcribir=transcribir_que_no_debe_correr)
orig_anotar = B.bitacora.anotar
B.bitacora.anotar = lambda fila: None
# La puerta de privado (e3d3d54) pregunta la identidad al ERP antes de bajar la
# nota. Sin este doble el caso dependia de tener un ERP local arriba y dado de
# alta, aunque el encabezado diga "sin red": con el ERP caido fallaba el caso 5.
B._identidad_de = lambda persona: {"ok": True, "registrado": True, "nombre": "Prueba"}
try:
    u = Update(Mensaje(111))
    ctx = types.SimpleNamespace(bot=BotTg(guion_get=[TimedOut(), TimedOut()]))
    asyncio.run(B.manejar_voz(u, ctx))
    caso("5. descarga caida: se le dice a Norman", u.message.dichos, [B.AVISO_VOZ_NO_BAJO])
    caso("5. ... y no se intenta transcribir", transcribio[0], 0)
finally:
    B.bitacora.anotar = orig_anotar

fallas = [(n, o, e) for n, o, e in casos if o != e]
for n, o, e in casos:
    print(("FALLA  " if o != e else "ok     ") + n + ("  -> obtuve %r, esperaba %r" % (o, e) if o != e else ""))
print("RESULTADO: " + ("%d de %d casos FALLAN" % (len(fallas), len(casos)) if fallas else "los %d casos pasan" % len(casos)))
sys.exit(1 if fallas else 0)
