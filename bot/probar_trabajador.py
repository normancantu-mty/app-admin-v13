# -*- coding: utf-8 -*-
"""Cazador F0 · WP-6 — EL ROL TRABAJADOR, de punta a punta.

Escrito el 2026-10-17 por el ejecutor B del Socio.

Corre el BOT de verdad (`_proponer_gasto_directo`, `_confirmar`,
`_avisar_aprobaciones`, `_boton_de_aprobacion`, `_post`) contra las RUTAS de
verdad (un `next dev` del worktree) y una base LOCAL (Supabase en Docker), y
lee la base con `psql`. Nada de leer el codigo.

**Solo corre contra localhost.** Si `TRABAJADOR_API` no es localhost/127.0.0.1
se niega; sin stack local dice SALTADA (sale 0, como las de humo: lo dice, no lo pinta).

Lo que se prueba, cada cosa con su control:
  1. /api/bot/identidad: rol TRABAJADOR, requiere aprobacion, NO es aprobador.
     CONTROL: Kevin (misma Matriz, sin rol_bot) sigue ADMIN y aprobador.
  2. Consultas: stock, cartera, ventas y produccion -> 403 para el trabajador;
     precios no. CONTROL: Kevin, stock -> no es 403.
  3. Captura un gasto por el bot y da VA -> ESPERA_APROBACION, cero filas en
     finanzas_ledger, y el aviso va a Norman y a Kevin, NUNCA a el mismo.
  4. El trabajador no aprueba lo de otro (Kevin propone; el trabajador aprieta
     Aprobar -> no escribe, sigue en espera).
  5. Norman aprueba lo del trabajador -> UNA fila en finanzas_ledger con
     `telegram:<etiqueta del trabajador>`. Un segundo gasto lo aprueba Kevin.
  6. Lotes: el trabajador ya puede PROPONER (antes 403 a todo no-ADMIN,
     lib/bot-permisos.ts:125). CONTROL: un LOC sigue en 403.

Prerrequisitos (el informe F0 trae el bloque completo):
  - Supabase local con las migraciones del bot + 20261017085000 (rol_bot) y el
    andamio local de finanzas_ledger; identidades 111 (Norman), 222 (Kevin),
    333 (trabajador), 444 (LOC).
  - `next dev -p 3111` del worktree con NEXT_PUBLIC_SUPABASE_URL local.

Corre con:
  TRABAJADOR_API=http://localhost:3111 BOT_API_TOKEN=<token local> python bot/probar_trabajador.py
"""
import asyncio
import json
import os
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request

API = os.environ.get("TRABAJADOR_API", "")
DB = os.environ.get("TRABAJADOR_DB", "supabase_db_sblocal")
host = urllib.parse.urlparse(API).hostname if API else None
if API and host not in ("localhost", "127.0.0.1"):
    print("ME NIEGO: TRABAJADOR_API=%s no es local. Esta prueba escribe." % API)
    sys.exit(2)


def _vivo():
    if not API:
        return False
    try:
        urllib.request.urlopen(urllib.request.Request(API + "/api/bot/identidad", data=b"{}",
                               headers={"content-type": "application/json"}), timeout=60)
    except urllib.error.HTTPError:
        return True
    except Exception:
        return False
    return True


if not _vivo():
    # Igual que las de humo (`tests/humo-entorno.ts`): sin entorno se SALTA con
    # el motivo escrito, no se pinta rojo. `tests/bot-python.spec.ts` corre
    # todo `probar_*.py` y el CI no tiene stack local. SALTADA no es un verde:
    # el informe F0 dice como correrla de verdad.
    print("RESULTADO: SALTADA — no hay stack local (TRABAJADOR_API=%r). No se probo nada." % API)
    sys.exit(0)

os.environ["ERP_API_URL"] = API
os.environ.pop("BOT_ENSAYO", None)
os.environ.setdefault("BOT_LOG", os.path.join(tempfile.gettempdir(), "probar_trabajador.log"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bot_gastos as B  # noqa: E402

NORMAN, KEVIN, TRAB, LOC = 111, 222, 333, 444
casos = []


def caso(nombre, obtenido, esperado):
    casos.append((nombre, obtenido, esperado))


def sql(q):
    r = subprocess.run(["docker", "exec", "-i", DB, "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", q],
                       capture_output=True, text=True, encoding="utf-8")
    if r.returncode != 0:
        raise SystemExit("psql: " + r.stderr)
    return r.stdout.strip()


class BotQueApunta(object):
    def __init__(self):
        self.enviados = []

    async def send_message(self, chat_id, texto, **k):
        self.enviados.append(int(chat_id))

    async def send_photo(self, *a, **k):
        return None


class Mensaje(object):
    def __init__(self, chat):
        self.chat_id = chat
        self.dichos = []

    async def reply_text(self, texto, **k):
        self.dichos.append(texto)


class Usuario(object):
    def __init__(self, uid):
        self.id = uid
        self.first_name = "u%d" % uid
        self.last_name = None
        self.username = None
        self.is_bot = False


class Chat(object):
    def __init__(self, cid):
        self.id = cid
        self.type = "private"


class Update(object):
    def __init__(self, uid):
        self.bot = BotQueApunta()
        self.effective_message = Mensaje(uid)
        self.message = self.effective_message
        self.effective_user = Usuario(uid)
        self.effective_chat = Chat(uid)
        self.callback_query = None

    def get_bot(self):
        return self.bot


class Consulta(object):
    async def edit_message_reply_markup(self, **k):
        return None


def correr(c):
    return asyncio.run(c)


def ledger_de(etiqueta):
    return int(sql("select count(*) from finanzas_ledger where usuario_creador = 'telegram:%s'" % etiqueta))


def estado_de(bid):
    return sql("select estado from bot_borradores where id = '%s'" % bid)


def proponer_y_va(uid, monto):
    """El camino del bot: el gasto ya resuelto por el enrutador, y el VA."""
    u = Update(uid)
    B._memoria.pop(uid, None)
    correr(B._proponer_gasto_directo(u, uid, {"monto": monto, "categoria": "Logistica_Envios",
                                               "descripcion": "flete de prueba %s" % monto}))
    bid = (B._memoria.get(uid) or {}).get("borrador_id")
    B._por_aprobar.clear()
    correr(B._confirmar(u, uid, por_boton=True))
    avisos = [list(p["avisar_a"]) for p in B._por_aprobar]
    correr(B._avisar_aprobaciones(u))
    return bid, u, avisos


def aprobar(uid, bid):
    u = Update(uid)
    correr(B._boton_de_aprobacion(u, uid, Consulta(), "apr", bid))
    return u.effective_message.dichos


# ─── 1. la identidad ────────────────────────────────────────────────────────
s, r = B._post("/api/bot/identidad", {"telegram_id": TRAB})
caso("1. trabajador: rol", r.get("rol"), "TRABAJADOR")
caso("1. trabajador: requiere aprobacion", r.get("requiere_aprobacion"), True)
caso("1. trabajador: NO es aprobador", r.get("aprobador"), False)
s, r = B._post("/api/bot/identidad", {"telegram_id": KEVIN})
caso("1. CONTROL Kevin: ADMIN y aprobador", (r.get("rol"), r.get("aprobador")), ("ADMIN", True))

# ─── 2. las consultas ───────────────────────────────────────────────────────
for c in ("stock", "cartera", "ventas", "produccion"):
    s, r = B._post("/api/bot/consulta", {"telegram_id": TRAB, "consulta": c})
    caso("2. trabajador no ve %s (403)" % c, s, 403)
s, r = B._post("/api/bot/consulta", {"telegram_id": TRAB, "consulta": "precios"})
caso("2. trabajador si pregunta precios (no 403)", s != 403, True)
s, r = B._post("/api/bot/consulta", {"telegram_id": KEVIN, "consulta": "stock"})
caso("2. CONTROL Kevin pregunta stock (no 403)", s != 403, True)

# ─── 3. captura -> espera; avisa a Norman y Kevin, no a el ──────────────────
antes = ledger_de("trabajador_prueba")
bid_t, u_t, avisos = proponer_y_va(TRAB, 211)
caso("3. el bot propuso (hay borrador)", bool(bid_t), True)
caso("3. su VA lo deja en ESPERA_APROBACION", estado_de(bid_t), "ESPERA_APROBACION")
caso("3. ... y no escribio nada en el ledger", ledger_de("trabajador_prueba"), antes)
caso("3. el aviso va a Norman y Kevin", sorted(avisos[0]) if avisos else None, [NORMAN, KEVIN])
caso("3. ... y el bot se los mando por privado", sorted(u_t.bot.enviados), [NORMAN, KEVIN])
caso("3. ... nunca al trabajador", TRAB in u_t.bot.enviados, False)

# ─── 4. el trabajador no aprueba lo de otro ─────────────────────────────────
bid_k, _u, avisos_k = proponer_y_va(KEVIN, 322)
caso("4. lo de Kevin espera a Norman (solo Norman)", avisos_k[0] if avisos_k else None, [NORMAN])
dichos = aprobar(TRAB, bid_k)
caso("4. el trabajador aprieta Aprobar: sigue en espera", estado_de(bid_k), "ESPERA_APROBACION")
caso("4. ... y se le dice que no le toca", any("Norman" in d for d in dichos), True)

# ─── 5. Norman aprueba; un segundo lo aprueba Kevin ─────────────────────────
dichos = aprobar(NORMAN, bid_t)
caso("5. Norman aprueba -> CONFIRMADO", estado_de(bid_t), "CONFIRMADO")
caso("5. ... una fila con la etiqueta del trabajador", ledger_de("trabajador_prueba"), antes + 1)
bid_t2, _u, _a = proponer_y_va(TRAB, 233)
aprobar(KEVIN, bid_t2)
caso("5. Kevin tambien aprueba lo del trabajador", estado_de(bid_t2), "CONFIRMADO")
caso("5. ... y queda escrito", ledger_de("trabajador_prueba"), antes + 2)
aprobar(NORMAN, bid_k)   # deja limpio lo de Kevin

# ─── 6. lotes: el trabajador propone; un LOC sigue fuera ────────────────────
lote = {"telegram_id": TRAB, "texto": "lote de prueba", "lote": {"codigo_lote": "PRUEBA-1"}}
s, r = B._post("/api/bot/lote/proponer", lote)
caso("6. el trabajador puede proponer un lote (no 403)", s != 403, True)
s, r = B._post("/api/bot/lote/proponer", dict(lote, telegram_id=LOC))
caso("6. CONTROL un LOC sigue en 403", s, 403)

# ─── RESULTADO ──────────────────────────────────────────────────────────────
fallos = [(n, o, e) for n, o, e in casos if o != e]
for n, o, e in casos:
    print(("ok   " if o == e else "FALLA") + "  " + n + ("" if o == e else "  -> obtuve %r, esperaba %r" % (o, e)))
if fallos:
    print("RESULTADO: %d de %d casos FALLAN (contra %s)" % (len(fallos), len(casos), API))
    sys.exit(1)
print("RESULTADO: los %d casos pasan (contra %s y la base local)" % (len(casos), API))
