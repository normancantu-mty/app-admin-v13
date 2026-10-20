# -*- coding: utf-8 -*-
"""Cazador F0 - WP-V: voz de salida y mencion del destinatario.

Escrito el 2026-10-17 por el ejecutor B del Socio.

  1. La regla de CUANDO hay audio (`voz_salida.debe_hablar`), con sus controles:
     un "Listo." no habla aunque te hayan hablado en audio; el interruptor
     `BOT_AUDIO_SIEMPRE` si lo hace hablar.
  2. La mencion: `@usuario`, o `text_mention` (largo en UTF-16) si no tiene.
  3. La TUBERIA real: una nota de voz por `manejar_voz` (descarga y Whisper
     doblados; enrutador doblado y contado) -> la respuesta sale en texto Y en
     audio, con el MISMO texto. CONTROL: el mismo mensaje escrito -> solo texto.
  4. En el grupo (envoltorio real `_UpdateQueAnota`): la primera linea es la
     mencion de quien hablo, con la entidad `text_mention` cuando no hay @.
  5. Opcional, con red: `VOZ_REAL=1` sintetiza de verdad con edge-tts (Dalia)
     y ffmpeg, y comprueba que sale un OGG (cabecera `OggS`). Sin `VOZ_REAL` se
     dice SALTADA para ese tramo; el resto corre siempre.

Corre con:  python bot/probar_voz_salida.py          (VOZ_REAL=1 para el tramo 5)
"""
import asyncio
import os
import sys
import tempfile
import types
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("BOT_LOG", os.path.join(tempfile.gettempdir(), "probar_bot.log"))
os.environ.pop("BOT_AUDIO_SIEMPRE", None)

import voz_salida as V  # noqa: E402

casos = []


def caso(nombre, obtenido, esperado):
    casos.append((nombre, obtenido, esperado))


# ─── 1. cuando hay audio ────────────────────────────────────────────────────
PREGUNTA = "Me falta:\n1. Cuantos dias va a fermentar?"
caso("1. te hablaron en audio -> audio", V.debe_hablar(True, "Esto es lo que voy a escribir."), True)
caso("1. ronda del cazador (plantilla) -> audio aunque sea texto", V.debe_hablar(False, PREGUNTA), True)
caso("1. ... la plantilla completa tambien", V.debe_hablar(False, "Lote nuevo. Contestame lo que sepas:"), True)
caso("1. ... con un aviso antes", V.debe_hablar(False, "Ojo: 1500 kg se sale\n" + PREGUNTA), True)
caso("CONTROL texto normal escrito -> sin audio", V.debe_hablar(False, "Cual es?"), False)
caso("CONTROL 'Listo.' no habla aunque te hablaran en audio", V.debe_hablar(True, "Listo. Quedo el lote L-1."), False)
caso("CONTROL '✅ registrado' no habla", V.debe_hablar(True, "✅ registrado"), False)
caso("CONTROL 'Anotado' (la nota) no habla", V.debe_hablar(True, "Anotado (7)."), False)
caso("1. interruptor BOT_AUDIO_SIEMPRE: el 'Listo.' si habla", V.debe_hablar(False, "Listo.", siempre=True), True)
os.environ["BOT_AUDIO_SIEMPRE"] = "1"
caso("1. ... leido del entorno", V.debe_hablar(False, "Listo."), True)
os.environ.pop("BOT_AUDIO_SIEMPRE")
caso("1. texto vacio nunca habla", V.debe_hablar(True, "  "), False)


# ─── 2. la mencion ──────────────────────────────────────────────────────────
class Usuario(object):
    def __init__(self, uid, first_name=None, username=None, last_name=None, is_bot=False):
        self.id, self.first_name, self.username, self.last_name, self.is_bot = uid, first_name, username, last_name, is_bot


caso("2. con @usuario: '@kevin_r' y sin entidad", V.mencion(Usuario(222, "Kevin", "kevin_r")), ("@kevin_r", None))
t, e = V.mencion(Usuario(333, "Jose", None, "Pena"))
caso("2. sin @: el nombre y text_mention", (t, e and e["type"]), ("Jose Pena", "text_mention"))
t, e = V.mencion(Usuario(334, u"María \U0001F336"))
caso("2. el largo es en UTF-16 (emoji = 2)", e["length"], 8)
caso("CONTROL a un bot no se le menciona", V.mencion(Usuario(9, "Bot", "otro_bot", is_bot=True)), None)
limpio = V.limpiar_markdown("**Hola**\n| a | b |\n# Titulo")
caso("2. limpiar_markdown quita tablas, enfasis y titulos",
     (limpio.split(), any(c in limpio for c in "|*#")), (["Hola", "Titulo"], False))

# ─── 3. la tuberia: nota de voz -> texto + audio ────────────────────────────
import bot_gastos as B  # noqa: E402
# E2 (auditoria IA 2026-10-17): estas pruebas no son de la puerta de privado
# (esa se prueba en probar_minimo_privilegio.py); aqui el chat privado es de
# alguien dado de alta.
async def _alta_ok(update, clave):
    return True
B._puerta_de_privado = _alta_ok

SINTETIZADOS = []


def tts_falso(texto, destino):
    destino = Path(destino).with_suffix(".ogg")
    destino.parent.mkdir(parents=True, exist_ok=True)
    destino.write_bytes(b"OggS" + b"\x00" * 60)
    SINTETIZADOS.append(texto)
    return destino


os.environ["BOT_VOZ_DIR"] = tempfile.mkdtemp(prefix="voz_salida_")
B.AUDIOS = Path(tempfile.mkdtemp(prefix="voz_entrada_"))
orig_tts = V.texto_a_voz
V.texto_a_voz = tts_falso


class Chat(object):
    def __init__(self, cid, tipo="private"):
        self.id, self.type = cid, tipo

    async def send_action(self, _a):
        return None


class Mensaje(object):
    def __init__(self, cid, texto=None, voz=False, de=None, tipo="private"):
        self.message_id = 5000
        self.chat = Chat(cid, tipo)
        self.text = texto
        self.caption = None
        self.voice = types.SimpleNamespace(file_id="AwACAgEAAx") if voz else None
        self.audio = self.reply_to_message = None
        self.from_user = de or Usuario(cid, "Norman")
        import datetime as dt
        self.date = dt.datetime(2026, 10, 17, 15, 0, tzinfo=dt.timezone.utc)
        self.dichos, self.voces, self.kwargs = [], [], []

    async def reply_text(self, texto, **k):
        self.dichos.append(str(texto))
        self.kwargs.append(k)

    async def reply_voice(self, voice=None, **k):
        # Lote v2: el bot manda los BYTES (para poder reintentar); antes, el archivo.
        datos = voice if isinstance(voice, (bytes, bytearray)) else voice.read()
        self.voces.append(bytes(datos[:4]))
        self.kwargs_voz = getattr(self, "kwargs_voz", []) + [k]


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


class Archivo(object):
    async def download_to_drive(self, ruta):
        Path(ruta).write_bytes(b"OggS")


class Contexto(object):
    def __init__(self):
        async def get_file(_fid):
            return Archivo()
        self.bot = types.SimpleNamespace(get_file=get_file)


sys.modules["transcribir_nota"] = types.SimpleNamespace(transcribir=lambda ruta, vocab=None: (True, "empezamos lote nuevo"))
CHAT = 111
veces_modelo = [0]


def modelo(*a, **k):
    veces_modelo[0] += 1
    return True, {"intencion": "charla", "confianza": "alta", "campos": {}, "respuesta": "ok"}


orig = B.enrutar, B._post
B.enrutar = modelo
B._post = lambda ruta, cuerpo: (200, {"ok": True, "productos": []})
try:
    B.lote_plantilla.olvidar(CHAT)
    u = Update(Mensaje(CHAT, voz=True))
    asyncio.run(B.manejar_voz(u, Contexto()))
    dichos, voces = u.message.dichos, u.message.voces
    caso("3. por voz: contesto el texto de la plantilla", any("1. Kilos de chile" in d for d in dichos), True)
    caso("3. ... y UNA nota de voz (OGG)", voces, [b"OggS"])
    caso("3. ... con el MISMO texto que se escribio", SINTETIZADOS[-1:] == [d for d in dichos if "1. Kilos" in d], True)
    caso("3. ... el 'Te entendi' NO va en audio", len(SINTETIZADOS), 1)

    # CONTROL: lo mismo escrito -> la plantilla, sin audio... salvo que es una ronda.
    B.lote_plantilla.olvidar(CHAT)
    SINTETIZADOS.clear()
    u = Update(Mensaje(CHAT, texto="40 kilos de chile"))
    asyncio.run(B.manejar_texto(u, None))
    caso("CONTROL escrito, sin plantilla viva: no hay ronda ni audio", (list(u.message.voces), list(SINTETIZADOS)), ([], []))
    u = Update(Mensaje(CHAT, texto="empezamos lote nuevo"))
    asyncio.run(B.manejar_texto(u, None))
    caso("3. escrito, pero es ronda del cazador: texto + audio", len(u.message.voces), 1)
    u = Update(Mensaje(CHAT, texto="40 kilos"))
    asyncio.run(B.manejar_texto(u, None))
    caso("3. ... la siguiente pregunta ('Me falta') tambien", (u.message.dichos[-1].startswith("Me falta"), len(u.message.voces)), (True, 1))
finally:
    B.enrutar, B._post = orig
    B.lote_plantilla.olvidar(CHAT)

# ─── 4. en el grupo: la mencion va primero ──────────────────────────────────
GRUPO = -100777
try:
    for quien, esperado_linea, con_entidad in ((Usuario(222, "Kevin", "kevin_r"), "@kevin_r", False),
                                               (Usuario(333, "Jose", None), "Jose", True)):
        m = Mensaje(GRUPO, texto="x", tipo="supergroup", de=quien)
        envuelto = B._UpdateQueAnota(Update(m), B._clave(GRUPO, quien.id), por_voz=True)
        asyncio.run(envuelto.effective_message.reply_text(PREGUNTA))
        caso("4. grupo (%s): la primera linea es la mencion" % esperado_linea, m.dichos[-1].split("\n")[0], esperado_linea)
        ent = (m.kwargs[-1].get("entities") or [None])[0]
        caso("4. ... text_mention solo si no hay @ (%s)" % esperado_linea,
             (ent is not None, getattr(ent, "type", None) if ent else None, getattr(getattr(ent, "user", None), "id", None)),
             (True, "text_mention", 333) if con_entidad else (False, None, None))
        caso("4. ... y el audio NO lee la mencion", SINTETIZADOS[-1], PREGUNTA)
    m = Mensaje(GRUPO, texto="x", tipo="supergroup", de=Usuario(222, "Kevin", "kevin_r"))
    asyncio.run(B._UpdateQueAnota(Update(m), B._clave(GRUPO, 222), por_voz=True).effective_message.reply_text("Listo. Quedo escrito."))
    caso("CONTROL grupo, 'Listo.': ni mencion ni audio", (m.dichos[-1].startswith("@"), m.voces), (False, []))
finally:
    V.texto_a_voz = orig_tts

# ─── 4b. si el audio truena (p.ej. edge-tts 7.2.8 -> 403), el texto ya salio ──
def tts_que_truena(texto, destino):
    raise RuntimeError("403, message='Invalid response status'")


V.texto_a_voz = tts_que_truena
try:
    m = Mensaje(CHAT, texto="x")
    asyncio.run(B._UpdateQueAnota(Update(m), CHAT, por_voz=True).effective_message.reply_text(PREGUNTA))
    caso("4b. TTS caido: el texto sale igual y no hay audio ni excepcion", (m.dichos, m.voces), ([PREGUNTA], []))
finally:
    V.texto_a_voz = orig_tts

# ─── 5. sintesis real (opcional) ────────────────────────────────────────────
if os.environ.get("VOZ_REAL") == "1":
    destino = Path(tempfile.mkdtemp(prefix="voz_real_")) / "prueba.ogg"
    ogg = V.texto_a_voz(PREGUNTA, destino)
    cabeza = Path(ogg).read_bytes()[:4]
    caso("5. edge-tts + ffmpeg dejan un OGG de verdad", (cabeza, Path(ogg).stat().st_size > 2000), (b"OggS", True))
    print("   (voz real: %s, %d bytes)" % (ogg, Path(ogg).stat().st_size))
else:
    print("5. SALTADA la sintesis real (VOZ_REAL=1 para correrla: usa la red de edge-tts).")

# ─── RESULTADO ──────────────────────────────────────────────────────────────
fallos = [(n, o, e) for n, o, e in casos if o != e]
for n, o, e in casos:
    print(("ok   " if o == e else "FALLA") + "  " + n + ("" if o == e else "  -> obtuve %r, esperaba %r" % (o, e)))
if fallos:
    print("RESULTADO: %d de %d casos FALLAN" % (len(fallos), len(casos)))
    sys.exit(1)
print("RESULTADO: los %d casos pasan" % len(casos))
