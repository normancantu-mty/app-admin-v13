# -*- coding: utf-8 -*-
"""Lote v2 (arreglo a): LA VOZ DE SALIDA YA NO MUERE CON TimedOut.

Escrito el 2026-10-19 por el ejecutor del Socio (lote v2).

El 2026-10-19 09:06, en produccion: `voz de salida: no pude mandar el audio
(TimedOut)` a los ~8.8 s. `reply_voice` iba con el read_timeout por defecto de
PTB 22.8 (5 s) y sin reintento. Aqui, con un doble del mensaje de Telegram:

  1. `_mandar_voz` pasa los timeouts EXPLICITOS (read 60, write 60, connect 15,
     pool 15) en cada intento.
  2. Primer intento TimedOut -> UN reintento, y el audio sale.
     NetworkError igual.
  3. Dos fallos seguidos -> se rinde (no hay tercer intento) y la excepcion
     sube; `_hablar` la atrapa: el texto ya salio, el bot no se cae.
  4. Un error que no es de red (BadRequest) NO se reintenta.
  5. `_hablar` real (TTS doblado) manda los BYTES del OGG con esos timeouts.
  6. `main()` crea el HTTPXRequest de envio con media_write_timeout=60 (el
     default de PTB es 20) -- se lee del objeto HTTPXRequest construido, no
     del codigo fuente.
  CONTROL: sin fallos hay UNA sola llamada (el reintento no duplica de gratis).

Corre con:  python bot/probar_voz_reintento.py      (sin red)
"""
import asyncio
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("BOT_LOG", os.path.join(tempfile.gettempdir(), "probar_bot.log"))
os.environ.pop("BOT_ENSAYO", None)

import bot_gastos as B  # noqa: E402
from telegram.error import BadRequest, NetworkError, TimedOut  # noqa: E402

casos = []


def caso(nombre, obtenido, esperado):
    casos.append((nombre, obtenido, esperado))


class MensajeTg(object):
    """`reply_voice` doblado: falla segun el guion y anota cada llamada."""

    def __init__(self, guion=()):
        self.guion = list(guion)
        self.llamadas = []

    async def reply_voice(self, voice=None, **k):
        self.llamadas.append((bytes(voice[:4]) if isinstance(voice, (bytes, bytearray)) else voice, dict(k)))
        if self.guion:
            falla = self.guion.pop(0)
            if falla is not None:
                raise falla
        return "enviado"


async def _sin_espera(_s):
    return None


B.asyncio.sleep, _sleep_orig = _sin_espera, B.asyncio.sleep
ESPERADOS = {"read_timeout": 60, "write_timeout": 60, "connect_timeout": 15, "pool_timeout": 15}
try:
    # 1 + CONTROL
    m = MensajeTg()
    r = asyncio.run(B._mandar_voz(m, b"OggS-datos"))
    caso("CONTROL sin fallos: UNA llamada", len(m.llamadas), 1)
    caso("1. timeouts explicitos en la llamada", m.llamadas[0][1], ESPERADOS)
    caso("1. ... y son los de la constante del bot", B.TIMEOUTS_VOZ, ESPERADOS)

    # 2
    m = MensajeTg([TimedOut("Timed out")])
    r = asyncio.run(B._mandar_voz(m, b"OggS-datos"))
    caso("2. TimedOut y luego bien: sale al segundo intento", (r, len(m.llamadas)), ("enviado", 2))
    caso("2. ... el reintento lleva los mismos timeouts", m.llamadas[1][1], ESPERADOS)
    caso("2. ... y los mismos bytes", m.llamadas[1][0], b"OggS")
    m = MensajeTg([NetworkError("reset")])
    asyncio.run(B._mandar_voz(m, b"OggS-datos"))
    caso("2. NetworkError tambien se reintenta", len(m.llamadas), 2)

    # 3
    m = MensajeTg([TimedOut("1"), TimedOut("2"), None])
    try:
        asyncio.run(B._mandar_voz(m, b"OggS-datos"))
        sube = None
    except TimedOut as e:
        sube = type(e).__name__
    caso("3. dos TimedOut: se rinde con TimedOut", sube, "TimedOut")
    caso("3. ... sin tercer intento (UN reintento)", len(m.llamadas), 2)

    # 4
    m = MensajeTg([BadRequest("voice messages forbidden")])
    try:
        asyncio.run(B._mandar_voz(m, b"OggS-datos"))
        sube = None
    except BadRequest:
        sube = "BadRequest"
    caso("4. BadRequest NO se reintenta", (sube, len(m.llamadas)), ("BadRequest", 1))

    # 5. _hablar real con el TTS doblado
    tmp = Path(tempfile.mkdtemp(prefix="voz_reintento_"))
    os.environ["BOT_VOZ_DIR"] = str(tmp)

    def _tts(texto, destino):
        Path(destino).write_bytes(b"OggS" + b"\x00" * 60)
        return Path(destino)

    tts_orig = B.voz_salida.texto_a_voz
    B.voz_salida.texto_a_voz = _tts
    try:
        m = MensajeTg([TimedOut("Timed out")])
        asyncio.run(B._hablar(m, 123, "Lote nuevo. Contestame lo que sepas"))
        caso("5. _hablar: TimedOut + reintento -> el audio sale", len(m.llamadas), 2)
        caso("5. ... manda bytes OGG con los timeouts", (m.llamadas[-1][0], m.llamadas[-1][1]), (b"OggS", ESPERADOS))
        m = MensajeTg([TimedOut("1"), TimedOut("2")])
        asyncio.run(B._hablar(m, 123, "otra"))   # no debe lanzar
        caso("5. _hablar: dos fallos no tumban al bot", len(m.llamadas), 2)
    finally:
        B.voz_salida.texto_a_voz = tts_orig
        os.environ.pop("BOT_VOZ_DIR", None)
finally:
    B.asyncio.sleep = _sleep_orig


# 6. main(): el HTTPXRequest de envio, construido de verdad
class _AppFalsa(object):
    def __getattr__(self, _n):
        return lambda *a, **k: self

    def add_handler(self, h, group=0):
        pass

    def run_polling(self, **_k):
        pass


creados = []
_HX = B.HTTPXRequest


def _hx(*a, **k):
    obj = _HX(*a, **k)
    creados.append(obj)
    return obj


class _BotFalso(object):
    def __init__(self, token, request=None, get_updates_request=None):
        self.request, self.get_updates_request = request, get_updates_request


guard = (B.Application, B.TOKEN_TG, B.TOKEN_API, B._candado, B.HTTPXRequest, B.bitacora.clase_bot)
B.Application, B.TOKEN_TG, B.TOKEN_API, B._candado = _AppFalsa(), "x", "y" * 30, (lambda: None)
B.HTTPXRequest = _hx
B.bitacora.clase_bot = lambda: _BotFalso
try:
    B.main()
finally:
    (B.Application, B.TOKEN_TG, B.TOKEN_API, B._candado, B.HTTPXRequest, B.bitacora.clase_bot) = guard
envio = creados[0] if creados else None
caso("6. main() crea los dos HTTPXRequest", len(creados), 2)
caso("6. el de envio: media_write_timeout=60 (default PTB 20)",
     getattr(envio, "_media_write_timeout", None), 60)
caso("6. CONTROL el de getUpdates no se toco",
     getattr(creados[1] if len(creados) > 1 else None, "_media_write_timeout", None), 20.0)

fallos = [(n, o, e) for n, o, e in casos if o != e]
for n, o, e in casos:
    print(("ok   " if o == e else "FALLA") + "  " + n + ("" if o == e else "  -> obtuve %r, esperaba %r" % (o, e)))
print("valores: reply_voice %s | reintentos %d | HTTPXRequest media_write_timeout %s"
      % (B.TIMEOUTS_VOZ, B.REINTENTOS_VOZ, B.MEDIA_WRITE_TIMEOUT))
if fallos:
    print("RESULTADO: %d de %d casos FALLAN" % (len(fallos), len(casos)))
    sys.exit(1)
print("RESULTADO: los %d casos pasan" % len(casos))
