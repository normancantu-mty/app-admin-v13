# -*- coding: utf-8 -*-
"""2026-11-03 -- EL BOT PARA EL EQUIPO (Norman: "le tiene que contestar a todos...
hace lo que entendio y luego nada mas espera mi click"). Escrito el 2026-11-03
por el ejecutor del Socio (bot ERP equipo).

Como `probar_grupos.py`: importa `bot_gastos`, simula los `Update` de un grupo y
dobla `_post_de_verdad` (corre el `_post` de verdad). El enrutador se dobla con
la salida REAL del modelo (`grabar_enrutador.grabada`), no con una escrita a mano.

Lo que se prueba, cada cosa con su control:
  1. El modelo real: "cuantas botellas quedan" -> consulta stock (tambien dicho
     por Luis en grupo); "cuanto llevamos gastado" -> consulta gastos; "agrega la
     subcategoria..." -> categoria. CONTROL: "gaste 300 en diesel" es gasto.
  2. Contesta a un no-Norman: Kevin (registrado, con marca) pregunta en el grupo
     sin mencionar al bot -> sale UNA consulta stock con SU telegram_id y el
     grupo, y la respuesta del servidor se dice en el grupo.
     CONTROL: un desconocido dice lo mismo -> no sale ninguna consulta y el bot
     pregunta quien es.
  3. El clic de un no-Norman NO ejecuta: Norman propone en el grupo, Kevin
     aprieta VA y Cancelar -> ningun /confirmar ni /cancelar, y se le explica.
     Kevin propone, Norman aprieta el VA de Kevin -> nada sale, y se le dice que
     su Aprobar llega por privado. CONTROL: Norman aprieta su VA -> sale 1.
  4. Categoria: Norman propone por el bot -> /categoria/proponer con los dos
     nombres; VA -> /categoria/confirmar con el sello. Kevin propone, VA ->
     espera -> a Norman le llega Aprobar; Aprobar -> /categoria/confirmar con el
     telegram_id de Norman (RUTA_CONFIRMAR_DE["alta_categoria"]).

MUTACIONES (corridas a mano el 2026-11-03, ver el informe):
  - `_boton_ajeno` devuelve siempre "" -> rojo en 3 (Kevin ve el "Listo").
  - quitar "alta_categoria" de RUTA_CONFIRMAR_DE -> rojo en 4 (el Aprobar no escribe).

Corre con:  python bot/probar_equipo.py      (sin red, sin modelo)
"""
import asyncio
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault(
    "BOT_LOG", os.path.join(tempfile.gettempdir(), "probar_bot.log"))
os.environ.pop("BOT_ENSAYO", None)

import bot_gastos as B  # noqa: E402
import enrutador as E  # noqa: E402
import grabar_enrutador as G  # noqa: E402

GRUPO = -1001234567890
NORMAN = B.NORMAN_TELEGRAM_ID
KEVIN = 222
LUIS = 555
DESCONOCIDO = 444
UUID_N = "11111111-2222-4333-8444-555555555555"
UUID_K = "99999999-8888-4777-8666-555555555555"
UUID_CAT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"

casos = []


def caso(nombre, obtenido, esperado):
    casos.append((nombre, obtenido, esperado))


IDENTIDADES = {
    NORMAN: {"ok": True, "registrado": True, "nombre": "Norman", "rol": "ADMIN",
             "requiere_aprobacion": False, "aprobador": True},
    KEVIN: {"ok": True, "registrado": True, "nombre": "Kevin", "rol": "ADMIN",
            "requiere_aprobacion": True, "aprobador": False},
}


class Servidor(object):
    def __init__(self):
        self.llamadas = []
        self.respuestas = {}

    def __call__(self, ruta, cuerpo):
        self.llamadas.append((ruta, dict(cuerpo)))
        if ruta == "/api/bot/identidad":
            return 200, dict(IDENTIDADES.get(cuerpo["telegram_id"],
                                             {"ok": True, "registrado": False}))
        cola = self.respuestas.get(ruta) or [(200, {"ok": True})]
        estado, obj = cola.pop(0) if len(cola) > 1 else cola[0]
        return estado, dict(obj)

    def a(self, ruta):
        return [c for r, c in self.llamadas if r == ruta]

    def escrituras(self):
        return [(r, c) for r, c in self.llamadas
                if r.endswith("/confirmar") or r.endswith("/cancelar")]


BOT_ID = 999
_ids = [1000]


class Usuario(object):
    def __init__(self, uid, is_bot=False):
        self.id = uid
        self.is_bot = is_bot
        self.first_name = None
        self.last_name = None
        self.username = None


class Chat(object):
    def __init__(self, cid):
        self.id = cid

    async def send_action(self, _a):
        return None


class Mensaje(object):
    def __init__(self, chat, texto="", de=None, contesta_a=None, bot=False):
        _ids[0] += 1
        self.message_id = _ids[0]
        self.chat = Chat(chat)
        self.text = texto
        self.from_user = Usuario(de, is_bot=bot) if de else None
        self.reply_to_message = contesta_a
        self.dichos = []
        self.teclados = []

    async def reply_text(self, texto, **kw):
        self.dichos.append(texto)
        self.teclados.append(kw.get("reply_markup"))
        return Mensaje(self.chat.id, texto, BOT_ID, bot=True)

    async def send_action(self, _a):
        return None


class Bot(object):
    username = "fresnillo_bot"

    def __init__(self):
        self.enviados = []

    async def send_message(self, chat_id, texto, reply_markup=None, **k):
        self.enviados.append((chat_id, texto, reply_markup))
        return Mensaje(chat_id, texto, BOT_ID, bot=True)

    async def send_photo(self, chat_id, **k):
        self.enviados.append((chat_id, "[foto]", None))


BOT = Bot()


class Update(object):
    def __init__(self, chat, persona, texto=""):
        self.message = Mensaje(chat, texto, persona)
        self.effective_user = Usuario(persona)
        self.callback_query = None

    @property
    def effective_message(self):
        return self.message

    @property
    def effective_chat(self):
        return self.message.chat

    def get_bot(self):
        return BOT


class Consulta(object):
    def __init__(self, chat, persona, data):
        self.message = Mensaje(chat)
        self.from_user = Usuario(persona)
        self.data = data

    async def answer(self, *a, **k):
        return None

    async def edit_message_reply_markup(self, **k):
        return None


class UpdateBoton(object):
    def __init__(self, chat, persona, data):
        self.callback_query = Consulta(chat, persona, data)
        self.message = None
        self.effective_user = Usuario(persona)

    @property
    def effective_message(self):
        return self.callback_query.message

    @property
    def effective_chat(self):
        return self.callback_query.message.chat

    def get_bot(self):
        return BOT


class Contexto(object):
    def __init__(self, args=None):
        self.args = args or []


def botones(teclado):
    if teclado is None:
        return []
    return [b.callback_data for fila in teclado.inline_keyboard for b in fila]


def boton(teclado, prefijo):
    for d in botones(teclado):
        if d.startswith(prefijo + ":"):
            return d
    raise AssertionError("no hay boton %r en %r" % (prefijo, botones(teclado)))


def limpiar():
    for d in (B._memoria, B._pendientes, B._apartado, B._modo_propuesta, B._caidos,
              B._cola, B._historial, B._eventos, B._identidades):
        dict.clear(d)
    B._rehidratado.clear()
    B._ya_pregunte.clear()
    B._preguntas_de_alta.clear()
    del B._por_aprobar[:]
    del BOT.enviados[:]


def correr(servidor, corutina):
    original = B._post_de_verdad
    B._post_de_verdad = servidor
    try:
        asyncio.run(corutina)
    except Exception as e:
        caso("sin excepcion en " + corutina.__name__, repr(e), None)
    finally:
        B._post_de_verdad = original


al_modelo = []


def modelo_que_dice(clave):
    salida = G.grabada(clave)

    def falso(texto, *a, **k):
        al_modelo.append(texto)
        return True, dict(salida)
    return falso


PROPUESTA = {"monto": 300, "descripcion": "gasolina", "categoria": "Logistica_Envios"}


def gasto_ok(bid):
    return (200, {"ok": True, "borrador_id": bid, "sello": "s-" + bid[:4],
                  "mensaje": "Esto es lo que voy a escribir. Revisalo:\nMONTO: $300.00"})


# === 1. El modelo real =======================================================
for clave, intencion, consulta in (
        ("e1103_cuantas_botellas_quedan", "consulta", "stock"),
        ("e1103_grupo_luis_botellas", "consulta", "stock"),
        ("e1103_cuanto_gastamos_mes", "consulta", "gastos"),
        ("e1103_agrega_subcategoria", "categoria", None),
        ("e1103_categoria_nueva", "categoria", None),
        ("e1103_control_gasto_diesel", "gasto", None)):
    s = G.grabada(clave)
    caso("modelo real: %s -> %s/%s" % (clave, intencion, consulta),
         (s.get("intencion"), s.get("consulta")), (intencion, consulta))
s = G.grabada("e1103_agrega_subcategoria")
caso("modelo real: los dos nombres de la categoria salen tal cual",
     (s["campos"].get("categoria"), s["campos"].get("subcategoria")), ("Logistica_Envios", "Diesel"))
caso("'gastos' es una consulta que el enrutador deja pasar", "gastos" in E.CONSULTAS_QUE_CONTESTA, True)
caso("'categoria' es una intencion que escribe (pasa por la confianza)",
     "categoria" in B.INTENCIONES_QUE_ESCRIBEN, True)

# === 2. Contesta a un no-Norman ==============================================
S = Servidor()
S.respuestas["/api/bot/consulta"] = [(200, {"ok": True, "texto": "INVENTARIO: 412 botellas", "privado": False})]
uk = Update(GRUPO, KEVIN, "cuantas botellas quedan?")


async def contesta_a_kevin():
    await B.manejar_texto(uk, Contexto())

B.enrutar = modelo_que_dice("e1103_grupo_luis_botellas")
correr(S, contesta_a_kevin())
caso("Kevin en el grupo (sin mencionar al bot): sale UNA consulta stock con SU id y el grupo",
     [(c.get("consulta"), c.get("telegram_id"), c.get("chat_id")) for c in S.a("/api/bot/consulta")],
     [("stock", KEVIN, GRUPO)])
caso("...y la respuesta del servidor se dice en el grupo",
     any("412 botellas" in t for t in uk.message.dichos), True)
caso("...y no escribe nada", S.escrituras(), [])
limpiar()

# CONTROL: un desconocido.
S = Servidor()
S.respuestas["/api/bot/consulta"] = [(200, {"ok": True, "texto": "INVENTARIO: 412 botellas", "privado": False})]
ud = Update(GRUPO, DESCONOCIDO, "cuantas botellas quedan?")
del al_modelo[:]


async def contesta_a_desconocido():
    await B.manejar_texto(ud, Contexto())

correr(S, contesta_a_desconocido())
caso("CONTROL: un desconocido no recibe el dato (ninguna consulta sale)", S.a("/api/bot/consulta"), [])
caso("CONTROL: ...lo que dijo no llega al modelo", list(al_modelo), [])
caso("CONTROL: ...y el bot pregunta quien es",
     any("quien es" in t.lower() for t in ud.message.dichos + [x[1] for x in BOT.enviados]), True)
limpiar()

# === 3. El clic de un no-Norman NO ejecuta ===================================
S = Servidor()
S.respuestas["/api/bot/gasto/proponer"] = [gasto_ok(UUID_N)]
S.respuestas["/api/bot/gasto/confirmar"] = [(200, {"ok": True})]
un = Update(GRUPO, NORMAN)


async def clic_ajeno():
    B._identidad_de(NORMAN)
    B._identidad_de(KEVIN)
    cn = B._clave(GRUPO, NORMAN)
    await B._proponer_gasto_directo(B._UpdateQueAnota(un, cn), cn, PROPUESTA)
    va = boton(un.message.teclados[-1], "va")
    caso("la propuesta de Norman lleva un borrador uuid en el VA", va, "va:" + UUID_N)
    for data in (va, "no:" + UUID_N):
        ub = UpdateBoton(GRUPO, KEVIN, data)
        await B.manejar_boton(ub, Contexto())
        dichos = ub.callback_query.message.dichos
        caso("Kevin aprieta %s de Norman: no sale ningun /confirmar ni /cancelar" % data.split(":")[0],
             S.escrituras(), [])
        caso("...se le explica que su clic no escribio nada (%s)" % data.split(":")[0],
             any("no escribio nada" in t for t in dichos), True)
        caso("...y no ve un 'Listo' (%s)" % data.split(":")[0], any("Listo" in t for t in dichos), False)
    caso("la propuesta de Norman sigue viva despues de los clics de Kevin",
         (B._memoria.get(cn) or {}).get("borrador_id"), UUID_N)
    # CONTROL: Norman aprieta su VA.
    ub = UpdateBoton(GRUPO, NORMAN, va)
    await B.manejar_boton(ub, Contexto())
    caso("CONTROL: el VA de Norman si sale, una vez, con su telegram_id",
         [(r, c.get("telegram_id")) for r, c in S.escrituras()], [("/api/bot/gasto/confirmar", NORMAN)])

correr(S, clic_ajeno())
limpiar()

S = Servidor()
S.respuestas["/api/bot/gasto/proponer"] = [gasto_ok(UUID_K)]
uk2 = Update(GRUPO, KEVIN)


async def norman_aprieta_lo_de_kevin():
    B._identidad_de(NORMAN)
    B._identidad_de(KEVIN)
    ck = B._clave(GRUPO, KEVIN)
    await B._proponer_gasto_directo(B._UpdateQueAnota(uk2, ck), ck, PROPUESTA)
    ub = UpdateBoton(GRUPO, NORMAN, boton(uk2.message.teclados[-1], "va"))
    await B.manejar_boton(ub, Contexto())
    caso("Norman aprieta el VA de Kevin en el grupo: nada sale", S.escrituras(), [])
    caso("...y se le dice que su Aprobar le llega por privado",
         any("por privado el Aprobar" in t for t in ub.callback_query.message.dichos), True)

correr(S, norman_aprieta_lo_de_kevin())
limpiar()

# === 4. Categoria por el bot =================================================
CAT_OK = (200, {"ok": True, "borrador_id": UUID_CAT, "sello": "s-cat",
                "mensaje": "Voy a agregar a la lista de gastos:\n  Logistica_Envios / Diesel"})
S = Servidor()
S.respuestas["/api/bot/categoria/proponer"] = [CAT_OK]
S.respuestas["/api/bot/categoria/confirmar"] = [(200, {"ok": True, "mensaje": "Listo. Quedo agregada: Logistica_Envios / Diesel."})]
up = Update(NORMAN, NORMAN, "agrega la subcategoria Diesel en Logistica_Envios")


async def categoria_norman():
    await B.manejar_texto(up, Contexto())
    caso("categoria: sale /categoria/proponer con los dos nombres, EGRESO por defecto",
         [(c.get("categoria"), c.get("subcategoria"), c.get("tipo")) for c in S.a("/api/bot/categoria/proponer")],
         [("Logistica_Envios", "Diesel", "EGRESO")])
    caso("categoria: proponer NO escribe", S.escrituras(), [])
    teclado = [t for t in up.message.teclados if t is not None]
    va = boton(teclado[-1], "vacat") if teclado else None
    caso("categoria: el boton es vacat:<borrador>", va, "vacat:" + UUID_CAT)
    ub = UpdateBoton(NORMAN, NORMAN, va or "vacat:x")
    await B.manejar_boton(ub, Contexto())
    caso("categoria: el VA de Norman manda /categoria/confirmar con el sello",
         [(r, c.get("telegram_id"), c.get("sello")) for r, c in S.escrituras()],
         [("/api/bot/categoria/confirmar", NORMAN, "s-cat")])
    caso("categoria: Norman ve el Listo", ub.callback_query.message.dichos[-1],
         "Listo. Quedo agregada: Logistica_Envios / Diesel.")

B.enrutar = modelo_que_dice("e1103_agrega_subcategoria")
correr(S, categoria_norman())
limpiar()

# Kevin propone una categoria: su VA espera, y el Aprobar de Norman escribe.
ESPERA = (200, {"ok": False, "espera_aprobacion": True, "borrador_id": UUID_CAT, "avisar_a": [NORMAN],
                "chat_id": GRUPO,
                "mensaje": "Listo, Kevin. No lo escribo todavia: se lo mande a Norman para que lo apruebe.",
                "mensaje_aprobador": "Kevin propone agregar la categoria Logistica_Envios / Diesel."})
S = Servidor()
S.respuestas["/api/bot/categoria/proponer"] = [CAT_OK]
S.respuestas["/api/bot/categoria/confirmar"] = [ESPERA, (200, {"ok": True, "mensaje": "Listo."})]
S.respuestas["/api/bot/aprobacion"] = [(200, {"ok": True, "borrador_id": UUID_CAT, "tipo": "alta_categoria",
                                              "sello": "s-cat", "estado": "ESPERA_APROBACION",
                                              "chat_id": GRUPO, "autor_telegram_id": KEVIN,
                                              "autor": "Kevin", "aprobador": "Norman"})]
ukc = Update(GRUPO, KEVIN, "agrega la subcategoria Diesel en Logistica_Envios")


async def categoria_kevin():
    await B.manejar_texto(ukc, Contexto())
    teclado = [t for t in ukc.message.teclados if t is not None]
    ub = UpdateBoton(GRUPO, KEVIN, boton(teclado[-1], "vacat"))
    await B.manejar_boton(ub, Contexto())
    caso("categoria de Kevin: su VA no escribe; se le dice que espera a Norman",
         ub.callback_query.message.dichos[-1],
         "Listo, Kevin. No lo escribo todavia: se lo mande a Norman para que lo apruebe.")
    aviso = [(t, m) for c, t, m in BOT.enviados if c == NORMAN]
    caso("categoria de Kevin: a Norman le llega Aprobar/Rechazar por privado",
         botones(aviso[0][1]) if aviso else [], ["apr:" + UUID_CAT, "rch:" + UUID_CAT])
    ua = UpdateBoton(NORMAN, NORMAN, "apr:" + UUID_CAT)
    await B.manejar_boton(ua, Contexto())
    caso("categoria de Kevin: el Aprobar de Norman manda /categoria/confirmar con SU id",
         [(r, c.get("telegram_id")) for r, c in S.llamadas if r == "/api/bot/categoria/confirmar"],
         [("/api/bot/categoria/confirmar", KEVIN), ("/api/bot/categoria/confirmar", NORMAN)])

correr(S, categoria_kevin())
limpiar()

# === Resultado ================================================================
fallan = 0
for nombre, obtenido, esperado in casos:
    ok = obtenido == esperado
    fallan += 0 if ok else 1
    print(("OK    " if ok else "FALLA ") + nombre + ("" if ok else "\n      obtuve %r\n      esperaba %r" % (obtenido, esperado)))
if fallan:
    print("RESULTADO: %d de %d casos FALLAN" % (fallan, len(casos)))
    sys.exit(1)
print("RESULTADO: los %d casos pasan" % len(casos))
