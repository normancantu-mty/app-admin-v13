# -*- coding: utf-8 -*-
"""2026-11-04: el fallo del modelo no se tira, no se marca procesado y se dice.

Escrito el 2026-11-04 por el Socio (ejecutor del clasificador).

La voz "Aeropuerto abono 5 mil pesos en efectivo." (10:02) se perdio con el log
`el modelo devolvio error: ` vacio: se tiraba el stdout, y como `enrutar` volvia
normal, `manejar_voz` marcaba `procesado=true`.

    python bot/probar_fallo_modelo.py      (sin red, sin modelo)
"""
import asyncio
import datetime as dt
import os
import subprocess
import sys
import tempfile

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)
os.environ.setdefault("BOT_LOG", os.path.join(tempfile.gettempdir(), "probar_bot.log"))

import bitacora  # noqa: E402
import bot_gastos as B  # noqa: E402
import enrutador as E  # noqa: E402
import tope  # noqa: E402

casos = []


def caso(nombre, obtenido, esperado):
    casos.append((nombre, obtenido, esperado))


# --- 1. el texto del error ---------------------------------------------------
e = E.error_del_modelo(1, "Credit balance is too low", "")
caso("1. con stderr vacio el stdout se conserva", "Credit balance is too low" in e, True)
caso("1. ... y el codigo de salida", "rc=1" in e, True)
caso("1. ... causa generica", e.causa, E.CAUSA_OTRA)
caso("1. sigue empezando igual (lo lee probar_tope)", e.startswith("el modelo devolvio error"), True)

for frase in ("Not logged in · Please run /login", "Invalid API key · Please run /login",
              "OAuth token has expired", "API Error: 401 authentication_error"):
    caso("1. login detectado: " + frase, E.error_del_modelo(1, frase, "").causa, E.CAUSA_LOGIN)
caso("1. login detectado en stderr tambien", E.error_del_modelo(1, "", "Not logged in").causa, E.CAUSA_LOGIN)
caso("1. CONTROL overloaded no es login", E.error_del_modelo(1, "", "overloaded").causa, E.CAUSA_OTRA)

secreto = "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789"
bot_token = "1234567890:" + "A" * 35
e = E.error_del_modelo(1, "fallo con " + secreto, "y " + bot_token + " Bearer abc.def")
caso("1. ningun token sale en el error", (secreto in e, bot_token in e, "abc.def" in e), (False, False, False))
caso("1. ... y lo demas si", "fallo con" in e, True)
caso("1. tope de 300 caracteres por flujo", len(E.error_del_modelo(1, "x " * 900, "y " * 900)) < 800, True)


# --- 2. enrutar con el subprocess doblado -------------------------------------
def con_modelo(salidas):
    """Corre `enrutar` con estas salidas (rc, stdout, stderr) en fila."""
    llamadas = []
    fila = list(salidas)

    def run(*a, **k):
        llamadas.append(a)
        rc, sale, err = fila.pop(0) if len(fila) > 1 else fila[0]
        return subprocess.CompletedProcess(a, rc, sale, err)

    orig = E.subprocess.run, E._claude, E.ESPERA_REINTENTO_S
    E.subprocess.run, E._claude, E.ESPERA_REINTENTO_S = run, (lambda *a, **k: ["claude"]), 0
    try:
        return E.enrutar("pague 300 de gasolina"), len(llamadas)
    finally:
        E.subprocess.run, E._claude, E.ESPERA_REINTENTO_S = orig


BUENO = '{"intencion": "charla", "campos": {}, "respuesta": "hola", "confianza": "alta"}'

(ok, r), n = con_modelo([(1, "algo raro", "")])
caso("2. falla generica: reintenta una vez y dice el stdout", (ok, n, "algo raro" in r), (False, 2, True))
(ok, r), n = con_modelo([(1, "", ""), (0, BUENO, "")])
caso("2. falla pasajera: el reintento la salva", (ok, n, r.get("intencion") if ok else r), (True, 2, "charla"))
(ok, r), n = con_modelo([(1, "Not logged in", "")])
caso("2. login: NO se reintenta", (ok, n, r.causa), (False, 1, E.CAUSA_LOGIN))
(ok, r), n = con_modelo([(1, "You've hit your limit · resets 3pm", "")])
caso("2. tope: NO se reintenta", (ok, n, isinstance(r, tope.Tope)), (False, 1, True))
(ok, r), n = con_modelo([(0, BUENO, "")])
caso("2. CONTROL bien a la primera: una llamada", (ok, n), (True, 1))


cuantos = [0]


def run_timeout(*a, **k):
    cuantos[0] += 1
    raise subprocess.TimeoutExpired("claude", 90)


orig = E.subprocess.run, E._claude, E.ESPERA_REINTENTO_S
E.subprocess.run, E._claude, E.ESPERA_REINTENTO_S = run_timeout, (lambda *a, **k: ["claude"]), 0
try:
    ok, r = E.enrutar("hola")
finally:
    E.subprocess.run, E._claude, E.ESPERA_REINTENTO_S = orig
caso("2. timeout: error con causa y sin reintento", (ok, str(r), r.causa, cuantos[0]),
     (False, "el modelo no contesto a tiempo", E.CAUSA_TIEMPO, 1))


# --- 3. el aviso --------------------------------------------------------------
a = B.aviso_modelo_caido(E.Caido("x", E.CAUSA_LOGIN))
caso("3. el aviso de login lo dice con su nombre", ("login de Claude" in a, "claude login" in a), (True, True))
caso("3. ... y dice que no escribio nada", "No escribi nada" in a, True)
a = B.aviso_modelo_caido("el modelo no contesto a tiempo")
caso("3. un error sin causa da el aviso generico", ("se me cayo el modelo" in a, "login" in a), (True, False))


# --- 4. la bitacora: fallo = procesado false ---------------------------------
# Estas pruebas no son de la puerta de privado: el chat es de alguien dado de alta.
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
        self.id, self.username, self.first_name, self.last_name = uid, "norman", "Norman", ""
        self.is_bot = False


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
        self.date = dt.datetime(2026, 11, 4, 16, 2, tzinfo=dt.timezone.utc)
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


CHAT = 222
base = Base()
bitacora.configurar(api="http://nadie", token="x" * 32, ensayo=False, enviar=base,
                    directorio=tempfile.mkdtemp(prefix="fallo_"))
salida = {"r": None}
mid = [9000]


def decir(texto):
    mid[0] += 1
    u = Update(Mensaje(CHAT, texto, mid[0]))
    asyncio.run(bitacora.anotar_update(u))
    asyncio.run(B.manejar_texto(u, None))
    return u, bitacora.clave_de_update(u)


orig = B.enrutar, B._post
B.enrutar = lambda *a, **k: salida["r"]
B._post = lambda ruta, cuerpo: (200, {"ok": True, "productos": []})
try:
    B._olvidar_chat(CHAT)
    salida["r"] = (False, E.Caido("el modelo devolvio error: rc=1", E.CAUSA_LOGIN))
    u1, c1 = decir("Aeropuerto abono 5 mil pesos en efectivo")
    caso("4. el fallo de login se avisa en el mismo chat", "login de Claude" in u1.message.dichos[0], True)
    caso("4. ... la fila existe", c1 in base.filas, True)
    caso("4. ... y NO se marca procesado", c1 in base.marcadas, False)
    salida["r"] = (False, E.Caido("el modelo no contesto a tiempo"))
    u2, c2 = decir("otro")
    caso("4. un fallo generico tampoco se marca", (c2 in base.marcadas, len(u2.message.dichos)), (False, 1))
    salida["r"] = (True, {"intencion": "charla", "confianza": "alta", "campos": {}, "respuesta": "Que tal."})
    u3, c3 = decir("hola")
    caso("4. CONTROL con el modelo bien SI se marca", c3 in base.marcadas, True)
    caso("4. ... sin pausa de por medio", B._pausa["hasta"], None)

    # El camino de la voz: `extra` trae la fila :transcripcion y tampoco se marca.
    salida["r"] = (False, E.Caido("el modelo devolvio error: rc=1"))
    mid[0] += 1
    uv = Update(Mensaje(CHAT, "voz", mid[0]))
    asyncio.run(bitacora.anotar_update(uv))
    cv = bitacora.clave_de_update(uv)
    asyncio.run(B._enrutar_y_despachar(uv, CHAT, "Aeropuerto abono"))
    asyncio.run(bitacora.marcar_procesado(uv, extra=[str(cv) + ":transcripcion"]))
    caso("4. voz: ni la nota ni su transcripcion se marcan",
         (cv in base.marcadas, str(cv) + ":transcripcion" in base.marcadas), (False, False))
finally:
    B.enrutar, B._post = orig
    bitacora.configurar(activa=False)

fallos = [(n, o, e) for n, o, e in casos if o != e]
for n, o, e in casos:
    print(("ok   " if o == e else "FALLA") + "  " + n + ("" if o == e else "  -> obtuve %r, esperaba %r" % (o, e)))
if fallos:
    print("RESULTADO: %d de %d casos FALLAN" % (len(fallos), len(casos)))
    sys.exit(1)
print("RESULTADO: los %d casos pasan" % len(casos))
