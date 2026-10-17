# -*- coding: utf-8 -*-
"""Cazador F0 - WP-9a: LA NOTA no genera movimientos.

Escrito el 2026-10-17 por el ejecutor B del Socio.

Dos capas, cada una con su control:

  1. EL MODELO REAL (grabado, `bot/grabaciones_enrutador.json`, con el md5 del
     PROMPT de hoy): las notas del conjunto de oro salen `nota` con su lote /
     cliente; CONTROLES: una nota pegada a un gasto o a un lote sale como ESE
     hecho, y "gracias" sale charla.
  2. EL BOT: con esa salida, `manejar_texto` -> despacho real. La nota pone
     etiquetas en la fila de la bitacora de ESE mensaje (doble de la ruta
     `/api/bot/bitacora`), contesta corto, y **ninguna** ruta del ERP recibe
     nada (`_post` doblado y contado). CONTROL: el gasto grabado SI toca la
     ruta del gasto (la prueba puede ver una escritura cuando la hay).

Corre con:  python bot/probar_nota.py
"""
import asyncio
import datetime as dt
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("BOT_LOG", os.path.join(tempfile.gettempdir(), "probar_bot.log"))

import bitacora  # noqa: E402
import bot_gastos as B  # noqa: E402
from grabar_enrutador import grabada  # noqa: E402

casos = []


def caso(nombre, obtenido, esperado):
    casos.append((nombre, obtenido, esperado))


# ─── 1. lo que dice el modelo real ──────────────────────────────────────────
n7 = grabada("f0_nota_lote_7")
caso("1. 'el 7 salio mas picoso' es nota", n7["intencion"], "nota")
caso("1. ... con el lote 7", str((n7.get("campos") or {}).get("lote", "")).strip(), "7")
caso("1. ... y sin hechos que escriban", n7.get("hechos"), [])
caso("1. la del trabajador en grupo es nota", grabada("f0_nota_grupo_trabajador")["intencion"], "nota")
nc = grabada("f0_nota_cliente")
caso("1. la del cliente es nota", nc["intencion"], "nota")
caso("1. ... con el cliente", "casa verde" in str((nc.get("campos") or {}).get("cliente", "")).lower(), True)
g = grabada("f0_control_nota_con_gasto")
caso("CONTROL nota pegada a un gasto: sale el gasto", [h["intencion"] for h in g.get("hechos") or []][:1], ["gasto"])
caso("CONTROL nota pegada a un lote: sale el lote",
     [h["intencion"] for h in grabada("f0_control_nota_con_lote").get("hechos") or []][:1], ["lote"])
caso("CONTROL 'gracias' es charla, no nota", grabada("f0_control_nota_gracias")["intencion"], "charla")


# ─── 2. el bot ──────────────────────────────────────────────────────────────
class Base(object):
    """Doble de `/api/bot/bitacora` (la misma semantica que `probar_bitacora`)."""

    def __init__(self):
        self.filas, self.ops = {}, []

    def __call__(self, cuerpo):
        self.ops.append(cuerpo)
        a = cuerpo.get("accion")
        if a == "anotar":
            for f in cuerpo["filas"]:
                self.filas.setdefault(f["clave"], dict(f))
        elif a == "etiquetar":
            f = self.filas.get(cuerpo["clave"])
            if f is not None and not f.get("etiquetas"):
                f["etiquetas"] = dict(cuerpo["etiquetas"])
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


class PostDoble(object):
    def __init__(self):
        self.rutas = []

    def __call__(self, ruta, cuerpo):
        self.rutas.append(ruta)
        if ruta == "/api/bot/catalogo":
            return 200, {"ok": True, "productos": []}
        return 200, {"ok": True, "borrador_id": "0c1b3f2a-9d44-4e7b-8a10-6f5c2d9e7b31", "sello": "s" * 64,
                     "mensaje": "propuesta"}


CHAT = 111


def decir(texto, salida, mid):
    base = Base()
    bitacora.configurar(api="http://nadie", token="x" * 32, ensayo=False, enviar=base,
                        directorio=tempfile.mkdtemp(prefix="nota_"))
    doble = PostDoble()
    orig = B.enrutar, B._post
    B.enrutar, B._post = (lambda *a, **k: (True, dict(salida))), doble
    u = Update(Mensaje(CHAT, texto, mid))
    try:
        B._olvidar_chat(CHAT)
        dict.pop(B._memoria, CHAT, None)
        asyncio.run(bitacora.anotar_update(u))   # el handler del grupo -1
        asyncio.run(B.manejar_texto(u, None))
    finally:
        B.enrutar, B._post = orig
        bitacora.configurar(activa=False)
    return u, base, doble


ESCRIBEN = ("/confirmar", "/proponer", "/registrar", "/cancelar", "/abono", "/gasto", "/venta", "/lote")

u, base, doble = decir("el 7 salió más picoso", n7, 7001)
clave = bitacora.clave_de_update(u)
fila = base.filas.get(clave) or {}
caso("2. la nota quedo en la bitacora (la fila del mensaje)", bool(fila), True)
caso("2. ... etiquetada como nota", (fila.get("etiquetas") or {}).get("tipo"), "nota")
caso("2. ... con el lote 7", str((fila.get("etiquetas") or {}).get("lote", "")).strip(), "7")
caso("2. cero rutas del ERP que escriben", [r for r in doble.rutas if any(x in r for x in ESCRIBEN)], [])
caso("2. contesta corto (una linea, <=60)", (len(u.message.dichos), len(u.message.dichos[0]) <= 60 if u.message.dichos else None),
     (1, True))
caso("2. ... y dice que lo anoto", u.message.dichos[0].startswith("Anotado") if u.message.dichos else None, True)
caso("2. no deja nada esperando VA", B._memoria.get(CHAT), None)

u, base, doble = decir("a Casa Verde le gusto mucho la chica, quieren probar la mini", nc, 7002)
fila = base.filas.get(bitacora.clave_de_update(u)) or {}
caso("2. la del cliente lleva la etiqueta cliente", "casa verde" in str((fila.get("etiquetas") or {}).get("cliente", "")).lower(), True)
caso("2. ... y tampoco escribe", [r for r in doble.rutas if any(x in r for x in ESCRIBEN)], [])

u, base, doble = decir("pague 300 de gasolina, por cierto el tambo 2 huele raro", g, 7003)
caso("CONTROL el gasto con observacion SI llega a la ruta del gasto",
     any("/gasto" in r for r in doble.rutas), True)
caso("CONTROL ... y su fila NO queda etiquetada como nota",
     ((base.filas.get(bitacora.clave_de_update(u)) or {}).get("etiquetas") or {}).get("tipo"), None)

# ─── RESULTADO ──────────────────────────────────────────────────────────────
fallos = [(n, o, e) for n, o, e in casos if o != e]
for n, o, e in casos:
    print(("ok   " if o == e else "FALLA") + "  " + n + ("" if o == e else "  -> obtuve %r, esperaba %r" % (o, e)))
if fallos:
    print("RESULTADO: %d de %d casos FALLAN" % (len(fallos), len(casos)))
    sys.exit(1)
print("RESULTADO: los %d casos pasan" % len(casos))
