# -*- coding: utf-8 -*-
"""Cazador F0 · WP-2a — LA BITACORA: que ningun mensaje se pierda.

Escrito el 2026-10-17 por el ejecutor B del Socio.

NO lee el codigo. Simula `Update` de Telegram, llama a los handlers DE VERDAD
(`bitacora.anotar_update`, `bot_gastos.manejar_texto`, `BotQueAnota.send_message`,
`bitacora.al_arrancar`) y lee la BASE. La base es un doble de la ruta
`/api/bot/bitacora` que se porta como la tabla: `ON CONFLICT (clave) DO
NOTHING`, solo-agregar, `procesado` cambiable. Con `BITACORA_API` puesta
(p. ej. `http://localhost:3111`, un Next contra el Supabase LOCAL), los mismos
casos corren contra la ruta y la tabla de verdad (ver el pie del informe F0).

Lo que se prueba, cada cosa con su control:
  1. Un mensaje de grupo queda en la base ANTES de que corra el handler normal,
     con clave, origen, persona y fecha. CONTROL: un update sin nada dicho no
     escribe nada.
  2. API caida -> la fila va a la cola `.jsonl`; la base no la tiene. Vuelve la
     API -> `reintentar` la escribe y la cola desaparece. CONTROL: reintentar
     otra vez no duplica.
  3. EL CRITERIO DEL PLAN: "matar el bot con mensajes en vuelo, reiniciar:
     ninguno falta". 5 mensajes con la API caida, el proceso "muere" (se borra
     todo lo que vive en RAM), arranca otro con el mismo directorio, y Telegram
     re-entrega los 2 no confirmados -> estan los 5 en la base, una vez cada uno.
  4. `manejar_texto` real (modelo doblado como charla) -> la fila del mensaje
     termina `procesado=true`. La voz deja SU fila de transcripcion.
  5. Lo que dice el bot (`BotQueAnota.send_message`) queda con origen `bot`.
  6. Apagon de 13 h -> al arrancar se le avisa a Norman por privado. CONTROL:
     apagon de 2 h -> no se avisa.
  7. Ensayo y `import bot_gastos` a secas NO escriben ni encolan nada.
  8. Un boton y una edicion quedan cada uno en su propia fila.

MUTACIONES (corridas a mano, ver el informe): `_a_la_cola` que no escribe ->
rojo en 2 y 3; `clave_de` con time() -> rojo en 2 (duplica) y 3.

Corre con:  python bot/probar_bitacora.py      (sin red, sin modelo)
"""
import asyncio
import datetime as dt
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("BOT_LOG", os.path.join(tempfile.gettempdir(), "probar_bot.log"))
os.environ.pop("BOT_ENSAYO", None)

import bitacora  # noqa: E402

casos = []


def caso(nombre, obtenido, esperado):
    casos.append((nombre, obtenido, esperado))


# ─── LA BASE (doble de la ruta, o la ruta de verdad) ────────────────────────

API_REAL = os.environ.get("BITACORA_API")


class Base(object):
    """Se porta como `public.bitacora` detras de `/api/bot/bitacora`."""

    def __init__(self):
        self.filas = {}
        self.caida = False
        self.llamadas = 0

    def __call__(self, cuerpo):
        self.llamadas += 1
        if self.caida:
            return 0, {"error": "connection refused"}
        a = cuerpo.get("accion")
        if a == "anotar":
            for f in cuerpo["filas"]:
                self.filas.setdefault(f["clave"], dict(f))   # ON CONFLICT DO NOTHING
            return 200, {"ok": True}
        if a == "marcar":
            for c in cuerpo["claves"]:
                if c in self.filas:
                    self.filas[c]["procesado"] = cuerpo["procesado"]
            return 200, {"ok": True}
        if a == "etiquetar":
            f = self.filas.get(cuerpo["clave"])
            if f is not None and not f.get("etiquetas"):
                f["etiquetas"] = dict(cuerpo["etiquetas"])
            return 200, {"ok": True}
        if a == "norman":
            return 200, {"ok": True, "telegram_ids": [111]}
        return 400, {"error": "accion"}

    def fila(self, clave):
        return self.filas.get(clave)


class BaseReal(object):
    """La ruta de verdad (Next local) y la tabla de verdad (Supabase local)."""

    def __init__(self, api):
        self.api = api
        self.caida = False

    def __call__(self, cuerpo):
        if self.caida:
            return 0, {"error": "connection refused"}
        bitacora._config["api"] = self.api
        return bitacora._enviar_de_verdad(cuerpo)

    def _sql(self, q):
        r = subprocess.run(["docker", "exec", "-i", os.environ.get("BITACORA_DB", "supabase_db_sblocal"),
                            "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", q],
                           capture_output=True, text=True, encoding="utf-8")
        return r.stdout.strip()

    def fila(self, clave):
        crudo = self._sql("select row_to_json(b) from public.bitacora b where clave = '%s'"
                          % clave.replace("'", "''"))
        return json.loads(crudo) if crudo else None

    @property
    def filas(self):
        crudo = self._sql("select coalesce(json_object_agg(clave, row_to_json(b)), '{}') "
                          "from public.bitacora b where clave like 'tg:%%%s%%'" % CORRIDA)
        return json.loads(crudo or "{}")


CORRIDA = str(int(time.time()))[-6:]   # chats unicos por corrida: la tabla es solo-agregar


def nueva_base(directorio):
    base = BaseReal(API_REAL) if API_REAL else Base()
    bitacora.configurar(api=API_REAL or "http://nadie", token=os.environ.get("BITACORA_TOKEN", "x" * 32),
                        ensayo=False, enviar=base, directorio=directorio)
    return base


# ─── LOS DOBLES DE TELEGRAM ─────────────────────────────────────────────────

_ids = [5000]


class Usuario(object):
    def __init__(self, uid, first_name=None, username=None):
        self.id = uid
        self.first_name = first_name
        self.last_name = None
        self.username = username
        self.is_bot = False


class Chat(object):
    def __init__(self, cid, tipo):
        self.id = cid
        self.type = tipo

    async def send_action(self, _a):
        return None


class Voz(object):
    file_id = "AwACAgEAAxkBAAIB"


class Mensaje(object):
    def __init__(self, chat, tipo, texto=None, de=None, voz=False, mid=None):
        _ids[0] += 1
        self.message_id = mid or _ids[0]
        self.chat = Chat(chat, tipo)
        self.text = texto
        self.caption = None
        self.voice = Voz() if voz else None
        self.audio = None
        self.from_user = de
        self.reply_to_message = None
        self.date = dt.datetime(2026, 10, 17, 15, 0, tzinfo=dt.timezone.utc)
        self.dichos = []

    async def reply_text(self, texto, **kw):
        self.dichos.append(texto)
        return Mensaje(self.chat.id, self.chat.type, texto)


class Update(object):
    def __init__(self, mensaje):
        self.message = mensaje
        self.edited_message = None
        self.channel_post = None
        self.callback_query = None
        self.effective_user = mensaje.from_user

    @property
    def effective_message(self):
        return self.message

    @property
    def effective_chat(self):
        return self.message.chat

    def get_bot(self):
        return None


def correr(c):
    return asyncio.run(c)


GRUPO = -int("100" + CORRIDA)
KEVIN = Usuario(222, "Kevin", "kevin_r")

# ─── 1. un mensaje de grupo queda en la base ────────────────────────────────
tmp = tempfile.mkdtemp(prefix="bitacora_")
base = nueva_base(tmp)
m = Mensaje(GRUPO, "supergroup", "hoy empezamos el lote 7 con 40 kilos", KEVIN)
correr(bitacora.anotar_update(Update(m)))
clave = bitacora.clave_de(GRUPO, m.message_id, "grupo")
f = base.fila(clave) or {}
caso("1. la fila existe", bool(f), True)
caso("1. texto literal", f.get("texto"), "hoy empezamos el lote 7 con 40 kilos")
caso("1. origen grupo", f.get("origen"), "grupo")
caso("1. persona", f.get("persona"), "Kevin (@kevin_r)")
caso("1. telegram_id de la persona", f.get("telegram_id"), 222)
caso("1. nace sin procesar", f.get("procesado"), False)
antes = len(base.filas)
vacio = Update(Mensaje(GRUPO, "supergroup", None, KEVIN))
correr(bitacora.anotar_update(vacio))
caso("1. CONTROL: un update sin nada dicho no escribe", len(base.filas), antes)

# ─── 2. API caida -> cola -> reintento, sin duplicar ────────────────────────
base.caida = True
m2 = Mensaje(GRUPO, "supergroup", "se nos acabo el piloncillo", KEVIN)
correr(bitacora.anotar_update(Update(m2)))
c2 = bitacora.clave_de(GRUPO, m2.message_id, "grupo")
caso("2. con la API caida la base NO la tiene", base.fila(c2) is None, True)
caso("2. ... y esta en la cola local", os.path.exists(bitacora.ruta_cola()), True)
base.caida = False
enviadas, quedan = bitacora.reintentar()
caso("2. al volver, reintentar la escribe", (base.fila(c2) or {}).get("texto"), "se nos acabo el piloncillo")
caso("2. la cola queda vacia", (quedan, os.path.exists(bitacora.ruta_cola())), (0, False))
n = len(base.filas)
bitacora._a_la_cola({"accion": "anotar", "filas": [bitacora.fila_de_entrada(m2, KEVIN)]})
bitacora.reintentar()
caso("2. CONTROL: reintentar lo mismo otra vez no duplica", len(base.filas), n)

# ─── 3. matar el bot con mensajes en vuelo, reiniciar: ninguno falta ────────
tmp3 = tempfile.mkdtemp(prefix="bitacora_kill_")
base = nueva_base(tmp3)
base.caida = True   # la PC perdio la red: el bot sigue recibiendo y no puede escribir
en_vuelo = [Mensaje(GRUPO, "supergroup", "mensaje %d en vuelo" % i, KEVIN) for i in range(5)]
for mm in en_vuelo:
    correr(bitacora.anotar_update(Update(mm)))
# El proceso MUERE: todo lo que vivia en RAM se va. Solo queda el disco.
import importlib  # noqa: E402
bitacora = importlib.reload(bitacora)
base_viva = base
base_viva.caida = False
bitacora.configurar(api=API_REAL or "http://nadie", token=os.environ.get("BITACORA_TOKEN", "x" * 32),
                    ensayo=False, enviar=base_viva, directorio=tmp3)
# Arranca el proceso nuevo: vacia la cola...
correr(bitacora.al_arrancar(type("App", (), {"bot": None})()))
# ...y Telegram re-entrega SOLO los 2 ultimos: los 3 primeros ya los habia
# confirmado (el offset avanza al pedir el siguiente lote). Esos 3 viven
# unicamente en la cola del disco: si la cola no funciona, faltan.
for mm in en_vuelo[3:]:
    correr(bitacora.anotar_update(Update(mm)))
claves = [bitacora.clave_de(GRUPO, mm.message_id, "grupo") for mm in en_vuelo]
presentes = [c for c in claves if base_viva.fila(c)]
caso("3. los 5 mensajes en vuelo estan en la base", len(presentes), 5)
caso("3. ... una sola vez cada uno", sum(1 for k in base_viva.filas if k in claves), 5)
caso("3. la cola quedo vacia", os.path.exists(bitacora.ruta_cola()), False)

# ─── 4. el handler real marca procesado; la voz deja su transcripcion ───────
import bot_gastos as B  # noqa: E402
B.bitacora = bitacora   # el modulo recargado (en el bot real es el mismo)
base = nueva_base(tempfile.mkdtemp(prefix="bitacora_h_"))


def _post_doble(ruta, cuerpo):
    if ruta == "/api/bot/identidad":
        return 200, {"ok": True, "registrado": True, "nombre": "Kevin", "rol": "ADMIN",
                     "requiere_aprobacion": True}
    return 200, {"ok": True}


B._post_de_verdad = _post_doble
B.enrutar = lambda *a, **k: (True, {"intencion": "charla", "respuesta": "Que tal.",
                                     "entendido": "saludo", "campos": {}, "hechos": [],
                                     "confianza": "alta"})
B._le_hablan_al_bot = lambda u: True
PRIVADO = int("7" + CORRIDA)
mp = Mensaje(PRIVADO, "private", "hola bot", Usuario(PRIVADO, "Norman"))
up = Update(mp)
correr(bitacora.anotar_update(up))       # el grupo -1 corre primero
cp = bitacora.clave_de(PRIVADO, mp.message_id, "privado")
caso("4. antes de procesar: procesado=false", (base.fila(cp) or {}).get("procesado"), False)
correr(B.manejar_texto(up, None))
caso("4. manejar_texto real contesto", bool(mp.dichos), True)
caso("4. despues de procesar: procesado=true", (base.fila(cp) or {}).get("procesado"), True)
mv = Mensaje(PRIVADO, "private", None, Usuario(PRIVADO, "Norman"), voz=True)
correr(bitacora.anotar_update(Update(mv)))
bitacora.anotar(bitacora.fila_de_transcripcion(mv, "compre 20 kilos de chile"))
cv = bitacora.clave_de(PRIVADO, mv.message_id, "voz")
caso("4. la nota de voz queda con su file_id", (base.fila(cv) or {}).get("adjunto_ref"), Voz.file_id)
caso("4. la transcripcion queda en SU fila",
     (base.fila(cv + ":transcripcion") or {}).get("transcripcion"), "compre 20 kilos de chile")

# ─── 5. lo que dice el bot ──────────────────────────────────────────────────
from telegram.ext import ExtBot  # noqa: E402
from telegram.request import HTTPXRequest  # noqa: E402

_original = ExtBot.send_message


async def _send_doble(self, chat_id, text, *a, **k):
    return Mensaje(chat_id, "private", text, mid=888000 + int(CORRIDA[-3:]))

ExtBot.send_message = _send_doble
try:
    bot = bitacora.clase_bot()("123:abc", request=HTTPXRequest(), get_updates_request=HTTPXRequest())
    correr(bot.send_message(PRIVADO, "Listo. Quedo el gasto."))
finally:
    ExtBot.send_message = _original
cb = bitacora.clave_de(PRIVADO, 888000 + int(CORRIDA[-3:]), "bot")
fb = base.fila(cb) or {}
caso("5. la respuesta del bot queda con origen bot", (fb.get("origen"), fb.get("texto")),
     ("bot", "Listo. Quedo el gasto."))
caso("5. ... y ya procesada (no es algo que atender)", fb.get("procesado"), True)

# ─── 6. apagon > 12 h: aviso a Norman; CONTROL 2 h: nada ────────────────────


class BotQueApunta(object):
    def __init__(self):
        self.enviados = []

    async def send_message(self, chat_id, texto, **k):
        self.enviados.append((chat_id, texto))


for horas, esperado in ((13, 1), (2, 0)):
    d = tempfile.mkdtemp(prefix="bitacora_apagon_")
    nueva_base(d)
    ahora = time.time()
    bitacora._marcar_visto(ahora - horas * 3600)
    app = type("App", (), {})()
    app.bot = BotQueApunta()
    correr(bitacora.al_arrancar(app, ahora=ahora))
    caso("6. apagon de %d h -> avisos a Norman" % horas, len(app.bot.enviados), esperado)
    if esperado:
        caso("6. ... a su privado, y dice cuanto", (app.bot.enviados[0][0], "13 h" in app.bot.enviados[0][1]),
             (111, True))

# ─── 7. ensayo e import a secas: inertes ────────────────────────────────────
d7 = tempfile.mkdtemp(prefix="bitacora_ensayo_")
b7 = Base()
bitacora.configurar(api="http://nadie", token="x" * 32, ensayo=True, enviar=b7, directorio=d7)
bitacora.anotar(bitacora.fila_de_entrada(Mensaje(GRUPO, "supergroup", "ensayo", KEVIN), KEVIN))
caso("7. en ensayo no se llama a la API", b7.llamadas, 0)
caso("7. ... ni se encola", os.path.exists(os.path.join(d7, "pendiente.jsonl")), False)
r = subprocess.run([sys.executable, "-c",
                    "import sys; sys.path.insert(0, %r); import bot_gastos, bitacora; "
                    "print(bitacora._config['activa'])" % os.path.dirname(os.path.abspath(__file__))],
                   capture_output=True, text=True, env=dict(os.environ, BOT_LOG=os.path.join(tempfile.gettempdir(), "x.log")))
caso("7. import bot_gastos deja la bitacora APAGADA", r.stdout.strip().splitlines()[-1:] , ["False"])



class _AppFalsa(object):
    def __init__(self):
        self.grupos = []

    def __getattr__(self, _n):           # builder().bot().post_init().build()
        return lambda *a, **k: self

    def add_handler(self, h, group=0):
        self.grupos.append((group, type(h).__name__))

    def run_polling(self, **_k):
        pass


app7 = _AppFalsa()
bitacora.configurar(api="http://nadie", token="x" * 32, ensayo=False, enviar=Base(),
                    directorio=d7, activa=False)
guard = (B.Application, B.TOKEN_TG, B.TOKEN_API, B._candado)
B.Application, B.TOKEN_TG, B.TOKEN_API, B._candado = app7, "x", "y" * 30, (lambda: None)
try:
    B.main()
finally:
    B.Application, B.TOKEN_TG, B.TOKEN_API, B._candado = guard
caso("7. main() registra la bitacora en el grupo -1 (antes que todo)", app7.grupos[0], (-1, "TypeHandler"))
caso("7. main() sin polling de verdad deja la bitacora APAGADA", bitacora._config["activa"], False)

# ─── 8. un boton y una edicion: cada uno su fila ────────────────────────────
base = nueva_base(tempfile.mkdtemp(prefix="bitacora_b_"))


class Consulta(object):
    def __init__(self):
        self.id = "77" + CORRIDA
        self.data = "va:abc123"
        self.from_user = KEVIN
        self.message = Mensaje(GRUPO, "supergroup", "Propuesta: lote 7")


ub = Update(Mensaje(GRUPO, "supergroup", None, KEVIN))
ub.message = None
ub.callback_query = Consulta()
correr(bitacora.anotar_update(ub))
fb = base.fila(bitacora.clave_de(GRUPO, "cb77" + CORRIDA, "grupo")) or {}
caso("8. el boton queda como [boton] <data>", fb.get("texto"), "[boton] va:abc123")
orig = Mensaje(GRUPO, "supergroup", "eran 40 kilos", KEVIN)
correr(bitacora.anotar_update(Update(orig)))
ed = Mensaje(GRUPO, "supergroup", "eran 45 kilos", KEVIN, mid=orig.message_id)
ed.edit_date = dt.datetime(2026, 10, 17, 15, 5, tzinfo=dt.timezone.utc)
ue = Update(ed)
ue.message = None
ue.edited_message = ed
correr(bitacora.anotar_update(ue))
c_orig = bitacora.clave_de(GRUPO, orig.message_id, "grupo")
caso("8. la edicion no pisa el original", (base.fila(c_orig) or {}).get("texto"), "eran 40 kilos")
editadas = [k for k in base.filas if k.startswith(c_orig + ":editado:")]
caso("8. ... y queda en su propia fila", len(editadas), 1)

for d in (tmp, tmp3, d7):
    shutil.rmtree(d, ignore_errors=True)

# ─── RESULTADO ──────────────────────────────────────────────────────────────
fallos = [(n, o, e) for n, o, e in casos if o != e]
modo = "contra la ruta y la tabla de verdad (%s)" % API_REAL if API_REAL else "con el doble de la base"
for n, o, e in casos:
    print(("ok   " if o == e else "FALLA") + "  " + n + ("" if o == e else "  -> obtuve %r, esperaba %r" % (o, e)))
if fallos:
    print("RESULTADO: %d de %d casos FALLAN (%s)" % (len(fallos), len(casos), modo))
    sys.exit(1)
print("RESULTADO: los %d casos pasan (%s)" % (len(casos), modo))
