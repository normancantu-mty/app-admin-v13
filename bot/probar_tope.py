# -*- coding: utf-8 -*-
"""Cazador F0 (item 6): el TOPE de la suscripcion no cuelga al bot.

Escrito el 2026-10-17 por el ejecutor B del Socio.

  1. `tope.detectar` reconoce el aviso de limite de `claude -p` y saca la hora
     (12 h, 24 h, epoch del formato viejo, sin hora -> +30 min).
     CONTROLES: un error cualquiera, o un JSON bueno que dice "limit", NO es tope.
  2. `enrutador.enrutar` con `subprocess.run` doblado: el aviso sale como
     `(False, Tope)` -- sigue siendo un `str` --, y un JSON bueno sigue saliendo.
  3. EL BOT (`manejar_texto` real, bitacora doblada): con tope contesta
     "Estoy en pausa hasta las HH:MM; ya lo guardé.", el mensaje queda
     `procesado=false`, y el SIGUIENTE no llama al modelo. Al pasar la hora, el
     primero avisa cuantos quedaron y si llama al modelo, y ese si se marca.
     La plantilla del lote (sin modelo) sigue funcionando en pausa.
     CONTROL: un error que no es tope da el mensaje de siempre y no pausa.

Corre con:  python bot/probar_tope.py
"""
import asyncio
import datetime as dt
import os
import subprocess
import sys
import tempfile
import types

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("BOT_LOG", os.path.join(tempfile.gettempdir(), "probar_bot.log"))

import tope  # noqa: E402

casos = []


def caso(nombre, obtenido, esperado):
    casos.append((nombre, obtenido, esperado))


# ─── 1. detectar ────────────────────────────────────────────────────────────
DIEZ = dt.datetime(2026, 10, 19, 10, 0)
t = tope.detectar("You've hit your limit · resets 3pm (America/Mexico_City)", "", DIEZ)
caso("1. 'hit your limit · resets 3pm' es tope", isinstance(t, tope.Tope), True)
caso("1. ... hasta las 15:00 de hoy", t.hasta, dt.datetime(2026, 10, 19, 15, 0))
caso("1. ... y el texto que contesta", tope.texto_pausa(t.hasta), "Estoy en pausa hasta las 15:00; ya lo guardé.")
caso("1. 3pm visto a las 16:00 es manana",
     tope.detectar("You've hit your limit · resets 3pm", "", DIEZ.replace(hour=16)).hasta,
     dt.datetime(2026, 10, 20, 15, 0))
caso("1. '5-hour limit reached ∙ resets 11:30am'",
     tope.detectar("", "5-hour limit reached ∙ resets 11:30am", DIEZ).hasta, dt.datetime(2026, 10, 19, 11, 30))
caso("1. 'Session limit reached · resets 12am' es medianoche",
     tope.detectar("Session limit reached · resets 12am", "", DIEZ).hasta, dt.datetime(2026, 10, 20, 0, 0))
epoch = int(dt.datetime(2026, 10, 19, 13, 45).timestamp())
caso("1. formato viejo 'usage limit reached|<epoch>'",
     tope.detectar("Claude AI usage limit reached|%d" % epoch, "", DIEZ).hasta, dt.datetime(2026, 10, 19, 13, 45))
caso("1. sin hora: pausa de %d min" % tope.PAUSA_SIN_HORA_MIN,
     tope.detectar("Usage limit reached", "", DIEZ).hasta, DIEZ + dt.timedelta(minutes=tope.PAUSA_SIN_HORA_MIN))
caso("1. el Tope es un str (el codigo viejo lo trata como texto)", isinstance(t, str) and "tope" in t, True)
caso("CONTROL un error cualquiera no es tope", tope.detectar("", "Error: overloaded_error 529", DIEZ), None)
caso("CONTROL un timeout de red no es tope", tope.detectar("", "fetch failed ECONNRESET", DIEZ), None)
caso("CONTROL vacio no es tope", tope.detectar("", "", DIEZ), None)

# ─── 2. enrutador.enrutar ───────────────────────────────────────────────────
import enrutador as E  # noqa: E402


def correr_con(stdout, stderr="", rc=1):
    orig = E.subprocess.run, E._claude
    E._claude = lambda: ["claude", "-p"]
    E.subprocess.run = lambda *a, **k: subprocess.CompletedProcess(a, rc, stdout, stderr)
    try:
        return E.enrutar("pague 300 de gasolina")
    finally:
        E.subprocess.run, E._claude = orig


ok, r = correr_con("You've hit your limit · resets 3pm (America/Mexico_City)\n", rc=1)
caso("2. enrutar con el aviso: (False, Tope)", (ok, isinstance(r, tope.Tope)), (False, True))
ok, r = correr_con("", "Claude AI usage limit reached|%d" % epoch, rc=1)
caso("2. ... tambien por stderr y formato viejo", (ok, isinstance(r, tope.Tope)), (False, True))
ok, r = correr_con("Usage limit reached", rc=0)
caso("2. ... y con rc=0 pero sin objeto", isinstance(r, tope.Tope), True)
ok, r = correr_con("", "Error: overloaded", rc=1)
caso("CONTROL error que no es tope: el texto de siempre", (ok, isinstance(r, tope.Tope), r.startswith("el modelo devolvio error")),
     (False, False, True))
ok, r = correr_con('{"intencion": "charla", "confianza": "alta", "campos": {}, '
                   '"respuesta": "tu usage limit reached no aplica aqui"}', rc=0)
caso("CONTROL un JSON bueno que dice 'limit reached' NO es tope", (ok, r.get("intencion") if ok else r), (True, "charla"))

# ─── 3. el bot ──────────────────────────────────────────────────────────────
import bitacora  # noqa: E402
import bot_gastos as B  # noqa: E402
# E2 (auditoria IA 2026-10-17): estas pruebas no son de la puerta de privado
# (esa se prueba en probar_minimo_privilegio.py); aqui el chat privado es de
# alguien dado de alta.
async def _alta_ok(update, clave):
    return True
B._puerta_de_privado = _alta_ok


class Base(object):
    def __init__(self):
        self.filas, self.marcadas = {}, set()

    def __call__(self, cuerpo):
        a = cuerpo.get("accion")
        if a == "anotar":
            for f in cuerpo["filas"]:
                self.filas.setdefault(f["clave"], dict(f))
        elif a == "marcar" and cuerpo.get("procesado"):
            self.marcadas.update(cuerpo["claves"])
        return 200, {"ok": True}


class Usuario(object):
    def __init__(self, uid):
        self.id, self.first_name, self.last_name, self.username, self.is_bot = uid, "Norman", None, None, False


class Chat(object):
    def __init__(self, cid):
        self.id, self.type = cid, "private"

    async def send_action(self, _a):
        return None


class Mensaje(object):
    def __init__(self, cid, texto, mid):
        self.message_id, self.chat, self.text, self.caption = mid, Chat(cid), texto, None
        self.voice = self.audio = self.reply_to_message = None
        self.from_user = Usuario(cid)
        self.date = dt.datetime(2026, 10, 17, 15, 0, tzinfo=dt.timezone.utc)
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


CHAT = 111
base = Base()
bitacora.configurar(api="http://nadie", token="x" * 32, ensayo=False, enviar=base,
                    directorio=tempfile.mkdtemp(prefix="tope_"))
llamadas = []
salida = {"r": None}


def modelo(*a, **k):
    llamadas.append(a[0])
    return salida["r"]


orig = B.enrutar, B._post
B.enrutar = modelo
B._post = lambda ruta, cuerpo: (200, {"ok": True, "productos": []})
mid = [8000]


def decir(texto):
    mid[0] += 1
    u = Update(Mensaje(CHAT, texto, mid[0]))
    asyncio.run(bitacora.anotar_update(u))
    asyncio.run(B.manejar_texto(u, None))
    return u, bitacora.clave_de_update(u)


try:
    B._olvidar_chat(CHAT)
    B.lote_plantilla.olvidar(CHAT)
    en_2h = (dt.datetime.now() + dt.timedelta(hours=2)).replace(second=0, microsecond=0)
    salida["r"] = (False, tope.Tope("tope de la suscripcion: x", en_2h))
    u1, c1 = decir("pague 300 de gasolina")
    esperado = "Estoy en pausa hasta las %s; ya lo guardé." % en_2h.strftime("%H:%M")
    caso("3. con tope contesta la hora y que lo guardo", u1.message.dichos, [esperado])
    caso("3. ... el mensaje quedo en la bitacora", c1 in base.filas, True)
    caso("3. ... y NO se marco procesado (queda en la cola)", c1 in base.marcadas, False)

    salida["r"] = (True, {"intencion": "charla", "confianza": "alta", "campos": {}, "respuesta": "Que tal."})
    u2, c2 = decir("y 200 de comida")
    caso("3. el siguiente en pausa NO llama al modelo", len(llamadas), 1)
    caso("3. ... contesta lo mismo y tampoco se marca", (u2.message.dichos, c2 in base.marcadas), ([esperado], False))

    u3, c3 = decir("empezamos lote nuevo")
    caso("3. la plantilla del lote (sin modelo) sigue en pausa", "Lote nuevo." in u3.message.dichos[-1], True)  # Lote v2: la 1a linea es el codigo
    B.lote_plantilla.olvidar(CHAT)

    B._pausa["hasta"] = dt.datetime.now() - dt.timedelta(minutes=1)   # paso la hora
    u4, c4 = decir("hola")
    caso("3. al volver avisa cuantos quedaron", u4.message.dichos[0],
         "Ya regrese. 2 mensajes de la pausa quedaron guardados sin procesar; repitemelos si siguen vigentes.")
    caso("3. ... y ya llama al modelo", (len(llamadas), u4.message.dichos[-1]), (2, "Que tal."))
    caso("3. ... y ESE si se marca procesado", c4 in base.marcadas, True)
    caso("3. ... los de la pausa siguen sin marcar", (c1 in base.marcadas, c2 in base.marcadas), (False, False))

    salida["r"] = (False, "el modelo devolvio error: overloaded")
    u5, c5 = decir("pague 100 de luz")
    caso("CONTROL error que no es tope: el mensaje de siempre", u5.message.dichos[0].startswith("No pude leer ese mensaje"), True)
    caso("CONTROL ... no pausa y si se marca", (B._pausa["hasta"], c5 in base.marcadas), (None, True))
finally:
    B.enrutar, B._post = orig
    B._pausa.update(hasta=None, guardados=0)
    bitacora.configurar(activa=False)

# ─── RESULTADO ──────────────────────────────────────────────────────────────
fallos = [(n, o, e) for n, o, e in casos if o != e]
for n, o, e in casos:
    print(("ok   " if o == e else "FALLA") + "  " + n + ("" if o == e else "  -> obtuve %r, esperaba %r" % (o, e)))
if fallos:
    print("RESULTADO: %d de %d casos FALLAN" % (len(fallos), len(casos)))
    sys.exit(1)
print("RESULTADO: los %d casos pasan" % len(casos))
