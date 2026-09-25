# -*- coding: utf-8 -*-
"""FASE 9 (D94, D95, D96, D97, D98, D100) — EL BOT EN UN GRUPO DE TELEGRAM.

Como `probar_empaque.py`: NO lee el codigo. Importa `bot_gastos`, simula los
`Update` de Telegram de un grupo con varias personas, y dobla
**`_post_de_verdad`** (no `_post`): asi corre el `_post` de verdad, que es donde
la clave de RAM se parte en `telegram_id` (la persona) + `chat_id` (el grupo).
Se mide lo que de verdad saldria hacia el servidor.

Lo que se prueba, cada cosa con su control:
  1. D94: Gilberto propone en el grupo, Kevin aprieta VA -> NO sale ningun
     `/confirmar`; Gilberto aprieta VA -> sale, con `telegram_id` = Gilberto y
     `chat_id` = el grupo. "Propuesto por" / "Confirmado por" solo en grupo.
     CONTROL: en privado el cuerpo sale igual que siempre (sin `chat_id`).
  2. D95: un desconocido escribe -> "No te tengo registrado. Norman, ¿quien
     es?" UNA vez, y lo que dijo no llega al modelo. Norman le contesta
     "este es Gilberto" -> propuesta de alta -> VA -> `/api/bot/miembro/confirmar`.
     CONTROL: "es mucho" contestado a alguien YA registrado no es un registro.
  3. D98: Kevin da VA -> el servidor contesta `espera_aprobacion` -> a Norman le
     llega por privado con Aprobar/Rechazar; Aprobar -> `/api/bot/aprobacion`
     (lee) -> el `confirmar` del tipo con el `telegram_id` de Norman -> aviso en
     el grupo. Rechazar -> `/cancelar` -> aviso en el grupo.
  4. D97: el abono de un DST vuelve `pendiente_de_aprobacion` -> se dice
     PENDIENTE (no "Listo.") y Norman recibe `apa:`; `apa` -> la ruta de la
     funcion compartida.
  5. D96: una consulta `privado` en grupo va al privado de quien pregunto.
     CONTROL: la misma sin `privado`, y la misma en chat privado, se contestan ahi.
  6. D100: el modelo recibe `hablante` en grupo y no en privado; el historial
     del grupo va rotulado por nombre. La charla entre personas no se contesta.
  10. D118/D119 (alta natural): al entrar un desconocido el bot pregunta quien
     es; Norman contesta A LA PREGUNTA y se registra al que entro. El primer
     "hola" de un desconocido tambien pregunta, una vez. CONTROL: la charla de
     un registrado sigue sin contestarse; la ruta vieja sigue.

MUTACIONES (corridas, ver `_avance_fase9`):
  · `_clave` devuelve el chat (la identidad vuelve a ser el grupo) -> rojo.
  · `_cuerpo_para_servidor` manda el chat como `telegram_id` -> rojo.
  · `_anotar_aprobacion` no anota nada (Norman nunca se entera) -> rojo.

Corre con:  python bot/probar_grupos.py      (sin red, sin modelo)
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

GRUPO = -1001234567890
NORMAN = 111
KEVIN = 222
GILBERTO = 333
DESCONOCIDO = 444

casos = []


def caso(nombre, obtenido, esperado):
    casos.append((nombre, obtenido, esperado))


# ─── Los dobles ───────────────────────────────────────────────────────────────

IDENTIDADES = {
    NORMAN: {"ok": True, "registrado": True, "nombre": "Norman", "rol": "ADMIN",
             "requiere_aprobacion": False, "aprobador": True},
    KEVIN: {"ok": True, "registrado": True, "nombre": "Kevin", "rol": "ADMIN",
            "requiere_aprobacion": True, "aprobador": False},
    GILBERTO: {"ok": True, "registrado": True, "nombre": "Gilberto", "rol": "DST",
               "requiere_aprobacion": False, "aprobador": False},
}


class Servidor(object):
    """Doble de `_post_de_verdad`. `respuestas`: ruta -> lista de (estado, obj)."""

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

    def confirmar(self):
        return [(r, c) for r, c in self.llamadas if r.endswith("/confirmar")]


class Bot(object):
    username = "fresnillo_bot"

    def __init__(self):
        self.enviados = []

    async def send_message(self, chat_id, texto, reply_markup=None, **k):
        self.enviados.append((chat_id, texto, reply_markup))
        return Mensaje(chat_id, texto, BOT_ID, bot=True)

    async def send_photo(self, chat_id, **k):
        self.enviados.append((chat_id, "[foto]", None))

    def a(self, chat_id):
        return [t for c, t, _ in self.enviados if c == chat_id]


BOT = Bot()


class Usuario(object):
    def __init__(self, uid, is_bot=False, first_name=None, last_name=None, username=None):
        self.id = uid
        self.is_bot = is_bot
        self.first_name = first_name
        self.last_name = last_name
        self.username = username


BOT_ID = 999
_ids = [1000]


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
        # Como Telegram: devuelve el mensaje que mando el bot (con su id).
        return Mensaje(self.chat.id, texto, BOT_ID, bot=True)

    async def send_action(self, _a):
        return None


class Update(object):
    def __init__(self, chat, persona, texto="", contesta_a=None):
        self.message = Mensaje(chat, texto, persona, contesta_a)
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


al_modelo = []


def _enrutar_falso(texto, *a, **k):
    al_modelo.append((texto, dict(k)))
    return True, E._normaliza({"intencion": "charla", "respuesta": "Aqui ando.",
                               "entendido": "platica", "confianza": "alta"})


def limpiar():
    for d in (B._memoria, B._pendientes, B._apartado, B._modo_propuesta, B._caidos,
              B._cola, B._historial, B._eventos, B._identidades):
        dict.clear(d)
    B._rehidratado.clear()
    B._ya_pregunte.clear()
    B._preguntas_de_alta.clear()
    del B._por_aprobar[:]
    del BOT.enviados[:]
    del al_modelo[:]


def correr(servidor, corutina):
    original = B._post_de_verdad
    B._post_de_verdad = servidor
    try:
        asyncio.run(corutina)
    except Exception as e:  # una excepcion es un caso rojo, y se sigue
        caso("sin excepcion en " + corutina.__name__, repr(e), None)
    finally:
        B._post_de_verdad = original


B.enrutar = _enrutar_falso
PROPUESTA = {"monto": 300, "descripcion": "gasolina", "categoria": "Logistica_Envios"}
GASTO_OK = (200, {"ok": True, "borrador_id": "b-gas", "sello": "s-gas",
                  "mensaje": "Esto es lo que voy a escribir. Revisalo:\nMONTO: $300.00"})


# ═══ 0. Puras ════════════════════════════════════════════════════════════════
caso("clave en privado = el int de siempre", B._clave(NORMAN, NORMAN), NORMAN)
caso("clave en grupo = (grupo, persona)", B._clave(GRUPO, KEVIN), (GRUPO, KEVIN))
caso("cuerpo en grupo: telegram_id = la persona, chat_id = el grupo",
     B._cuerpo_para_servidor({"telegram_id": (GRUPO, KEVIN), "x": 1}),
     {"telegram_id": KEVIN, "chat_id": GRUPO, "x": 1})
caso("CONTROL: cuerpo en privado, intacto (sin chat_id)",
     B._cuerpo_para_servidor({"telegram_id": NORMAN, "x": 1}), {"telegram_id": NORMAN, "x": 1})
B._identidades[KEVIN] = (1e18, IDENTIDADES[KEVIN])
caso("rotulo: en grupo, 'Listo.' dice quien confirmo",
     B._rotulo_de_grupo((GRUPO, KEVIN), "Listo. Quedo escrito."),
     "Listo. Quedo escrito.\nConfirmado por Kevin.")
caso("CONTROL: rotulo en privado, intacto",
     B._rotulo_de_grupo(NORMAN, "Listo. Quedo escrito."), "Listo. Quedo escrito.")
caso("rotulo: una propuesta (boton VA) dice quien la propuso",
     B._rotulo_de_grupo((GRUPO, KEVIN), "MONTO $1", B._teclado_confirmar("b")).split("\n")[0],
     "Propuesto por Kevin")
limpiar()

# ═══ 1. D94: el VA de otro no confirma lo ajeno ══════════════════════════════
S = Servidor()
S.respuestas["/api/bot/gasto/proponer"] = [GASTO_OK]
S.respuestas["/api/bot/gasto/confirmar"] = [(200, {"ok": True})]
u_prop = Update(GRUPO, GILBERTO)


async def d94():
    B._identidad_de(GILBERTO)
    cg = B._clave(GRUPO, GILBERTO)
    await B._proponer_gasto_directo(B._UpdateQueAnota(u_prop, cg), cg, PROPUESTA)
    teclado = u_prop.message.teclados[-1]
    va = boton(teclado, "va")
    # Kevin aprieta el VA de la propuesta de Gilberto.
    uk = UpdateBoton(GRUPO, KEVIN, va)
    await B.manejar_boton(uk, Contexto())
    caso("D94: el VA de Kevin sobre lo de Gilberto NO manda ningun /confirmar",
         S.confirmar(), [])
    caso("D94: ... y Kevin no ve un 'Listo'",
         any("Listo" in t for t in uk.callback_query.message.dichos), False)
    # Gilberto aprieta su VA.
    ug = UpdateBoton(GRUPO, GILBERTO, va)
    await B.manejar_boton(ug, Contexto())
    caso("D94: el VA de Gilberto si sale, con SU telegram_id y el chat aparte",
         [(r, c.get("telegram_id"), c.get("chat_id")) for r, c in S.confirmar()],
         [("/api/bot/gasto/confirmar", GILBERTO, GRUPO)])
    caso("D94: la propuesta en el grupo dice quien la hizo",
         u_prop.message.dichos[-1].split("\n")[0], "Propuesto por Gilberto")
    caso("D94: la escritura dice quien la confirmo",
         ug.callback_query.message.dichos[-1], "Listo. Quedo escrito.\nConfirmado por Gilberto.")

correr(S, d94())
caso("D94: la propuesta salio con telegram_id = Gilberto y chat_id = grupo",
     [(c["telegram_id"], c.get("chat_id")) for c in S.a("/api/bot/gasto/proponer")],
     [(GILBERTO, GRUPO)])
limpiar()

# CONTROL privado: el mismo flujo, cuerpo sin chat_id, textos sin rotulo.
S = Servidor()
S.respuestas["/api/bot/gasto/proponer"] = [GASTO_OK]
up = Update(NORMAN, NORMAN)


async def privado():
    await B._proponer_gasto_directo(B._UpdateQueAnota(up, NORMAN), NORMAN, PROPUESTA)
    ub = UpdateBoton(NORMAN, NORMAN, boton(up.message.teclados[-1], "va"))
    await B.manejar_boton(ub, Contexto())
    caso("CONTROL privado: la escritura dice 'Listo. Quedo escrito.' sin rotulo",
         ub.callback_query.message.dichos[-1], "Listo. Quedo escrito.")

correr(S, privado())
caso("CONTROL privado: proponer y confirmar salen SIN chat_id, como siempre",
     [("chat_id" in c, c["telegram_id"]) for r, c in S.llamadas if r.startswith("/api/bot/gasto")],
     [(False, NORMAN), (False, NORMAN)])
caso("CONTROL privado: la propuesta no lleva 'Propuesto por'",
     up.message.dichos[-1].startswith("Propuesto por"), False)
limpiar()

# ═══ 2. D95: el desconocido, y el registro ═══════════════════════════════════
S = Servidor()
S.respuestas["/api/bot/miembro/proponer"] = [(200, {"ok": True, "borrador_id": "b-mb", "sello": "s-mb",
                                                    "mensaje": "REGISTRO: Gilberto -> Casa Verde (DST)"})]
S.respuestas["/api/bot/miembro/confirmar"] = [(200, {"ok": True, "mensaje": "Listo: Gilberto queda registrado como Casa Verde."})]
ux1 = Update(GRUPO, DESCONOCIDO, "vendi 3 grandes")
ux2 = Update(GRUPO, DESCONOCIDO, "hola?")


async def d95():
    await B.manejar_texto(ux1, Contexto())
    await B.manejar_texto(ux2, Contexto())
    caso("D95: al desconocido se le pregunta, una vez",
         ux1.message.dichos[:1] + ux2.message.dichos,
         ["No te tengo registrado. Norman, ¿quien es?\n(Norman: contesta a su mensaje, o a este, con \"este es <nombre>\".)"])
    # Fase 10 (D105): una COPIA. `caso` guarda la referencia y `limpiar()`
    # vacia la lista antes de evaluarla: con `al_modelo` a secas pasaba siempre.
    caso("D95: lo que dijo el desconocido no llega al modelo", list(al_modelo), [])
    # Norman le contesta a su mensaje.
    un = Update(GRUPO, NORMAN, "este es Gilberto", contesta_a=Mensaje(GRUPO, "vendi 3 grandes", DESCONOCIDO))
    await B.manejar_texto(un, Contexto())
    caso("D95: 'este es Gilberto' propone el alta del que escribio",
         [(c["telegram_id"], c.get("chat_id"), c["miembro_telegram_id"], c["texto"])
          for c in S.a("/api/bot/miembro/proponer")],
         [(NORMAN, GRUPO, DESCONOCIDO, "este es Gilberto")])
    vamb = boton(un.message.teclados[-1], "vamb")
    await B.manejar_boton(UpdateBoton(GRUPO, NORMAN, vamb), Contexto())
    caso("D95: el VA de Norman escribe el alta",
         [(c["telegram_id"], c["borrador_id"], c["sello"]) for c in S.a("/api/bot/miembro/confirmar")],
         [(NORMAN, "b-mb", "s-mb")])
    caso("D95: y se le vuelve a preguntar al servidor quien es",
         DESCONOCIDO in B._identidades, False)
    # CONTROL: "es mucho" contestado a Kevin (registrado) no es registro.
    uc = Update(GRUPO, NORMAN, "es mucho", contesta_a=Mensaje(GRUPO, "gaste 300", KEVIN))
    await B.manejar_texto(uc, Contexto())
    caso("D95 CONTROL: 'es mucho' a alguien registrado NO propone alta",
         len(S.a("/api/bot/miembro/proponer")), 1)
    caso("D95 CONTROL: ... y si llega al modelo", [t for t, _ in al_modelo], ["es mucho"])

correr(S, d95())
limpiar()

# ═══ 3. D98: Kevin propone, Norman aprueba ═══════════════════════════════════
ESPERA = (200, {"ok": False, "espera_aprobacion": True, "borrador_id": "b-gas", "avisar_a": [NORMAN],
                "propuesto_por": "Kevin",
                "mensaje": "Listo, Kevin. No lo escribo todavia: se lo mande a Norman para que lo apruebe.",
                "mensaje_aprobador": "Kevin propone un gasto y espera tu Aprobar."})
S = Servidor()
S.respuestas["/api/bot/gasto/proponer"] = [GASTO_OK]
S.respuestas["/api/bot/gasto/confirmar"] = [ESPERA, (200, {"ok": True})]
S.respuestas["/api/bot/aprobacion"] = [(200, {"ok": True, "borrador_id": "b-gas", "tipo": None, "sello": "s-gas",
                                              "estado": "ESPERA_APROBACION", "chat_id": GRUPO,
                                              "autor_telegram_id": KEVIN, "autor": "Kevin",
                                              "aprobador": "Norman"})]
uk = Update(GRUPO, KEVIN)


async def d98():
    ck = B._clave(GRUPO, KEVIN)
    B._identidad_de(KEVIN)
    await B._proponer_gasto_directo(B._UpdateQueAnota(uk, ck), ck, PROPUESTA)
    ub = UpdateBoton(GRUPO, KEVIN, boton(uk.message.teclados[-1], "va"))
    await B.manejar_boton(ub, Contexto())
    caso("D98: a Kevin se le dice que espera a Norman (sin 'Confirmado por')",
         ub.callback_query.message.dichos[-1],
         "Listo, Kevin. No lo escribo todavia: se lo mande a Norman para que lo apruebe.")
    caso("D98: la propuesta de Kevin ya no esta viva en su RAM", B._memoria.get(ck), None)
    aviso = [(t, m) for c, t, m in BOT.enviados if c == NORMAN]
    caso("D98: a Norman le llega por privado, con la propuesta",
         [t.split("\n")[0] for t, _ in aviso], ["Kevin propone un gasto y espera tu Aprobar."])
    caso("D98: ... con Aprobar y Rechazar", botones(aviso[0][1]) if aviso else [],
         ["apr:b-gas", "rch:b-gas"])
    # Norman aprieta Aprobar en su chat privado.
    ua = UpdateBoton(NORMAN, NORMAN, "apr:b-gas")
    await B.manejar_boton(ua, Contexto())
    caso("D98: Aprobar lee lo que espera y manda el confirmar del tipo con el telegram_id de Norman",
         [(r, c.get("telegram_id"), c.get("sello")) for r, c in S.llamadas
          if r in ("/api/bot/aprobacion", "/api/bot/gasto/confirmar")][-2:],
         [("/api/bot/aprobacion", NORMAN, None), ("/api/bot/gasto/confirmar", NORMAN, "s-gas")])
    caso("D98: Norman ve 'Aprobado'", ua.callback_query.message.dichos[-1], "Aprobado. Quedo escrito.")
    caso("D98: en el grupo se avisa quien aprobo", BOT.a(GRUPO),
         ["Aprobado por Norman: lo que propuso Kevin quedo escrito."])

correr(S, d98())
limpiar()

# Rechazar.
S = Servidor()
S.respuestas["/api/bot/cancelar"] = [(200, {"ok": True, "autor_telegram_id": KEVIN, "chat_id": GRUPO,
                                            "rechazado_por": "Norman"})]


async def rechazar():
    ur = UpdateBoton(NORMAN, NORMAN, "rch:b-gas")
    await B.manejar_boton(ur, Contexto())
    caso("D98: Rechazar cancela con el telegram_id de Norman",
         [(c["telegram_id"], c["borrador_id"]) for c in S.a("/api/bot/cancelar")], [(NORMAN, "b-gas")])
    caso("D98: Rechazar no escribe nada", S.confirmar(), [])
    caso("D98: y a Kevin se le avisa en el grupo", BOT.a(GRUPO),
         ["Norman rechazo lo que propusiste. No se escribio nada."])

correr(S, rechazar())
limpiar()

# ═══ 4. D97: el abono de un DST ══════════════════════════════════════════════
S = Servidor()
S.respuestas["/api/bot/abono/confirmar"] = [(200, {
    "ok": True, "pendiente_de_aprobacion": True, "borrador_id": "b-ab", "avisar_a": [NORMAN],
    "mensaje": "Listo: registre el abono de $1500.00. Queda PENDIENTE hasta que Norman lo apruebe.",
    "mensaje_aprobador": "Gilberto registro un abono de $1500.00 de Casa Verde. ¿Lo apruebo?"})]
S.respuestas["/api/bot/aprobacion/confirmar"] = [(200, {"ok": True, "accion": "aprobado", "chat_id": GRUPO,
                                                        "mensaje": "Abono de Casa Verde aprobado por Norman: ya cuenta en la cartera."})]


async def d97():
    cg = B._clave(GRUPO, GILBERTO)
    B._memoria[cg] = {"tipo": "abono", "borrador_id": "b-ab", "sello": "s-ab"}
    ug = UpdateBoton(GRUPO, GILBERTO, "vaab:b-ab")
    await B.manejar_boton(ug, Contexto())
    caso("D97: al DST se le dice PENDIENTE (no 'Listo. Quedo registrado')",
         ug.callback_query.message.dichos[-1],
         "Listo: registre el abono de $1500.00. Queda PENDIENTE hasta que Norman lo apruebe.")
    aviso = [(t, m) for c, t, m in BOT.enviados if c == NORMAN]
    caso("D97: a Norman le llega por privado con apa/rca",
         [(t, botones(m)) for t, m in aviso],
         [("Gilberto registro un abono de $1500.00 de Casa Verde. ¿Lo apruebo?", ["apa:b-ab", "rca:b-ab"])])
    ua = UpdateBoton(NORMAN, NORMAN, "apa:b-ab")
    await B.manejar_boton(ua, Contexto())
    caso("D97: Aprobar va a la funcion compartida, accion aprobar",
         [(c["telegram_id"], c["borrador_id"], c["accion"]) for c in S.a("/api/bot/aprobacion/confirmar")],
         [(NORMAN, "b-ab", "aprobar")])
    caso("D97: el grupo se entera", BOT.a(GRUPO),
         ["Abono de Casa Verde aprobado por Norman: ya cuenta en la cartera."])

correr(S, d97())
limpiar()

# ═══ 5. D96: lo privado va por privado ═══════════════════════════════════════
S = Servidor()
S.respuestas["/api/bot/consulta"] = [(200, {"ok": True, "texto": "QUIEN DEBE — $1,650.00", "privado": True}),
                                     (200, {"ok": True, "texto": "STOCK ...", "privado": False}),
                                     (200, {"ok": True, "texto": "QUIEN DEBE — $1,650.00", "privado": True})]


async def d96():
    u1 = Update(GRUPO, KEVIN, "/cartera")
    await B.comando_cartera(u1, Contexto())
    caso("D96: 'quien debe' en grupo va al privado de Kevin", BOT.a(KEVIN), ["QUIEN DEBE — $1,650.00"])
    caso("D96: ... y en el grupo solo se dice", u1.message.dichos, ["Te lo mande por privado."])
    u2 = Update(GRUPO, KEVIN, "/stock")
    await B.comando_stock(u2, Contexto())
    caso("D96 CONTROL: lo que no es privado se contesta en el grupo", u2.message.dichos, ["STOCK ..."])
    u3 = Update(NORMAN, NORMAN, "/cartera")
    await B.comando_cartera(u3, Contexto())
    caso("D96 CONTROL: en privado se contesta ahi mismo", u3.message.dichos, ["QUIEN DEBE — $1,650.00"])
    caso("D96: la consulta de grupo sale con telegram_id Kevin y chat_id grupo",
         [(c["telegram_id"], c.get("chat_id")) for c in S.a("/api/bot/consulta")][0], (KEVIN, GRUPO))

correr(S, d96())
limpiar()

# ═══ 6. D100: el modelo sabe quien habla; la charla de grupo no se contesta ══
S = Servidor()


async def d100():
    u1 = Update(GRUPO, KEVIN, "jaja ya llegue")
    await B.manejar_texto(u1, Contexto())
    caso("D100: en grupo el modelo recibe hablante = Kevin", al_modelo[-1][1].get("hablante"), "Kevin")
    caso("D100: la charla entre personas no se contesta", u1.message.dichos, [])
    u2 = Update(GRUPO, KEVIN, "hola bot", contesta_a=Mensaje(GRUPO, "Aqui ando.", 999))
    u2.message.reply_to_message.from_user.is_bot = True
    await B.manejar_texto(u2, Contexto())
    caso("D100 CONTROL: contestarle al bot si se contesta", u2.message.dichos, ["Aqui ando."])
    hist = B.historial_para_el_modelo(B._clave(GRUPO, KEVIN))
    caso("D100: el historial del grupo lleva el nombre", [t[3] for t in hist], ["Kevin", "Kevin"])
    caso("D100: y el modelo lo lee como 'Kevin:'",
         "] Kevin: hola bot" in "\n".join(E._pedazo_historial(hist)), True)
    u3 = Update(NORMAN, NORMAN, "hola")
    await B.manejar_texto(u3, Contexto())
    caso("D100 CONTROL: en privado no viaja hablante", "hablante" in al_modelo[-1][1], False)
    caso("D100 CONTROL: en privado la charla si se contesta", u3.message.dichos, ["Aqui ando."])
    caso("D100 CONTROL: el historial privado sigue siendo de 3 y dice 'Norman:'",
         ("] Norman: hola" in "\n".join(E._pedazo_historial(B.historial_para_el_modelo(NORMAN))),
          len(B.historial_para_el_modelo(NORMAN)[0])), (True, 3))
    caso("D100 CONTROL: el contexto privado no dice QUIEN TE ESCRIBE",
         "QUIEN TE ESCRIBE" in E._pedazo_contexto(None, None, None), False)

correr(S, d100())
limpiar()

# ═══ 7. FASE 10 (D105, D106): las guardas que ninguna prueba defendia ═══════
# 7a. Auto-registro: Kevin (dado de alta) contesta A SU PROPIO mensaje con
# "/registrar Norman". `/registrar` se salta la pregunta de identidad, asi que
# lo unico que lo para en el bot es `miembro.id == quien habla`.
# Mutacion: quitar esa guarda en `_quiza_registro` -> rojo.
# FASE 11 (D109): por la ENTRADA REAL, `comando_registrar` (el CommandHandler de
# /registrar), no por `manejar_texto`: en produccion un /registrar nunca llega
# a `manejar_texto` (el filtro de texto excluye comandos).
S = Servidor()
S.respuestas["/api/bot/miembro/proponer"] = [(200, {"ok": True, "borrador_id": "b-mb", "sello": "s-mb",
                                                    "mensaje": "REGISTRO: Gilberto -> Casa Verde (DST)"})]


async def autorregistro():
    uk = Update(GRUPO, KEVIN, "/registrar Norman", contesta_a=Mensaje(GRUPO, "gaste 300", KEVIN))
    await B.comando_registrar(uk, Contexto(["Norman"]))
    caso("D105: nadie se registra a si mismo (Kevin contesta a lo suyo con /registrar)",
         len(S.a("/api/bot/miembro/proponer")), 0)
    un = Update(GRUPO, NORMAN, "/registrar Gilberto", contesta_a=Mensaje(GRUPO, "hola", DESCONOCIDO))
    await B.comando_registrar(un, Contexto(["Gilberto"]))
    caso("D105 CONTROL: el /registrar de Norman sobre OTRO si propone el alta",
         [(c["telegram_id"], c["miembro_telegram_id"]) for c in S.a("/api/bot/miembro/proponer")],
         [(NORMAN, DESCONOCIDO)])

correr(S, autorregistro())
limpiar()


# 7b. ERP que no contesta la identidad: lo cerrado es NO procesar y decirlo.
# Mutacion: `if ident is None:` devuelve True (la puerta se abre) -> rojo.
class ServidorCaido(Servidor):
    def __call__(self, ruta, cuerpo):
        if ruta == "/api/bot/identidad":
            self.llamadas.append((ruta, dict(cuerpo)))
            return 0, {"error": "no pude hablarle al ERP: timed out"}
        return Servidor.__call__(self, ruta, cuerpo)


S = ServidorCaido()


async def erp_caido():
    ug = Update(GRUPO, GILBERTO, "gaste 300 de gasolina")
    await B.manejar_texto(ug, Contexto())
    caso("D105: ERP caido -> se dice que no se pudo verificar",
         ug.message.dichos, ["No pude revisar quien eres (el ERP no contesto). No hice nada."])
    caso("D105: ERP caido -> nada llega al modelo", list(al_modelo), [])
    caso("D105: ERP caido -> ninguna llamada mas que la identidad",
         [r for r, _ in S.llamadas], ["/api/bot/identidad"])

correr(S, erp_caido())
limpiar()
S = Servidor()


async def erp_vivo():
    ug = Update(GRUPO, GILBERTO, "gaste 300 de gasolina")
    await B.manejar_texto(ug, Contexto())
    caso("D105 CONTROL: con el ERP vivo, lo mismo de Gilberto si llega al modelo",
         [t for t, _ in al_modelo], ["gaste 300 de gasolina"])

correr(S, erp_vivo())
limpiar()

# 7c. D106: el aviso dice QUIEN aprobo o rechazo (Norman o Kevin), no "Norman".
S = Servidor()
S.respuestas["/api/bot/cancelar"] = [(200, {"ok": True, "autor_telegram_id": GILBERTO, "chat_id": GRUPO,
                                            "rechazado_por": "Kevin"})]


async def kevin_rechaza():
    ur = UpdateBoton(KEVIN, KEVIN, "rch:b-gas")
    await B.manejar_boton(ur, Contexto())
    caso("D106: cuando rechaza Kevin, el grupo lee 'Kevin rechazo'", BOT.a(GRUPO),
         ["Kevin rechazo lo que propusiste. No se escribio nada."])

correr(S, kevin_rechaza())
limpiar()
S = Servidor()
S.respuestas["/api/bot/aprobacion"] = [(200, {"ok": True, "borrador_id": "b-gas", "tipo": "gasto", "sello": "s-gas",
                                              "estado": "ESPERA_APROBACION", "chat_id": GRUPO,
                                              "autor_telegram_id": GILBERTO, "autor": "Gilberto",
                                              "aprobador": "Kevin"})]
S.respuestas["/api/bot/gasto/confirmar"] = [(200, {"ok": True})]


async def kevin_aprueba():
    ua = UpdateBoton(KEVIN, KEVIN, "apr:b-gas")
    await B.manejar_boton(ua, Contexto())
    caso("D106: cuando aprueba Kevin, el grupo lee 'Aprobado por Kevin'", BOT.a(GRUPO),
         ["Aprobado por Kevin: lo que propuso Gilberto quedo escrito."])

correr(S, kevin_aprueba())
limpiar()
S = Servidor()
S.respuestas["/api/bot/aprobacion"] = [(200, {"ok": True, "borrador_id": "b-gas", "tipo": "gasto", "sello": "s-gas",
                                              "estado": "ESPERA_APROBACION", "chat_id": GRUPO,
                                              "autor_telegram_id": GILBERTO, "autor": "Gilberto"})]
S.respuestas["/api/bot/gasto/confirmar"] = [(409, {"ok": False, "ya_resuelto": True,
                                                   "error": "Eso ya lo resolvio otro aprobador. No escribi nada."})]


async def segundo_aprobador():
    ua = UpdateBoton(NORMAN, NORMAN, "apr:b-gas")
    await B.manejar_boton(ua, Contexto())
    caso("D106: el segundo aprobador ve que ya se resolvio, y el grupo no recibe otro aviso",
         (ua.callback_query.message.dichos[-1], BOT.a(GRUPO)),
         ("Eso ya lo resolvio otro aprobador. No escribi nada.", []))

correr(S, segundo_aprobador())
limpiar()

# ═══ 8. FASE 11 (D109): los comandos pasan por la puerta de grupo ══════════
# Un desconocido que manda CUALQUIER comando en un grupo recibe el "¿quien es?"
# y el comando no llega al servidor (ni una llamada mas que la identidad).
# Mutacion: quitar `@_con_puerta` de un comando -> rojo en su caso.
NLP = chr(10)
PREGUNTA = ("No te tengo registrado. Norman, ¿quien es?" + NLP
            + '(Norman: contesta a su mensaje, o a este, con "este es <nombre>".)')
COMANDOS = sorted(n for n in dir(B) if n.startswith("comando_"))
S = Servidor()


async def comandos_desconocido():
    for nombre in COMANDOS:
        limpiar()
        del S.llamadas[:]
        ux = Update(GRUPO, DESCONOCIDO, "/" + nombre[8:] + " Gilberto 500",
                    contesta_a=Mensaje(GRUPO, "hola", GILBERTO))
        # Cada comando por separado: una excepcion en uno no esconde a los demas.
        try:
            await getattr(B, nombre)(ux, Contexto(["Gilberto", "500"]))
        except Exception as e:
            ux.message.dichos.append("EXCEPCION " + repr(e)[:80])
        caso("D109: desconocido en grupo manda /" + nombre[8:] + " -> se le pregunta quien es",
             ux.message.dichos, [PREGUNTA])
        caso("D109: ... y /" + nombre[8:] + " no llega al servidor",
             [r for r, _ in S.llamadas if r != "/api/bot/identidad"], [])

correr(S, comandos_desconocido())
limpiar()
# FASE 11 (D112): 12 con /entrega.
caso("D109: son los 12 comandos que registra main()", len(COMANDOS), 12)
S = Servidor()
S.respuestas["/api/bot/consulta"] = [(200, {"ok": True, "texto": "Nadie debe."})]


async def comandos_control():
    ug = Update(GRUPO, GILBERTO, "/cartera")
    await B.comando_cartera(ug, Contexto())
    caso("D109 CONTROL: Gilberto (registrado) en grupo -> /cartera SI llega al servidor",
         len(S.a("/api/bot/consulta")), 1)
    up = Update(DESCONOCIDO, DESCONOCIDO, "/cartera")
    await B.comando_cartera(up, Contexto())
    caso("D109 CONTROL: en privado la puerta no mira nada (el servidor decide)",
         (len(S.a("/api/bot/consulta")), len(S.a("/api/bot/identidad"))), (2, 1))

correr(S, comandos_control())
limpiar()

# ═══ 9. FASE 11 (D112): la entrega de efectivo del DST ════════════════════
# /entrega <monto> [nombre]. Quien puede lo decide el servidor; aqui se mide lo
# que sale hacia el: el DST propone la suya (sin nombre), su VA espera el
# Aprobar, y el Aprobar de Norman llega al confirmar de ENTREGA (no al de gasto).
# Mutaciones: quitar "entrega_efectivo" de RUTA_CONFIRMAR_DE -> rojo;
# quitar la rama "entrega_efectivo" del "va" escrito -> rojo.
S = Servidor()
S.respuestas["/api/bot/entrega/proponer"] = [(200, {
    "ok": True, "borrador_id": "b-ent", "sello": "s-ent", "id_entidad": "e-gil", "nombre": "Gilberto",
    "mensaje": "ENTREGA DE EFECTIVO — Gilberto" + NLP + "Monto: $1,500.00"})]
S.respuestas["/api/bot/entrega/confirmar"] = [
    (200, {"ok": False, "espera_aprobacion": True, "borrador_id": "b-ent", "avisar_a": [NORMAN],
           "mensaje": "Listo, Gilberto. No lo escribo todavia: se lo mande a Norman y a Kevin para que lo aprueben.",
           "mensaje_aprobador": "Gilberto propone una entrega de efectivo y espera tu Aprobar."}),
    (200, {"ok": True, "ids": ["f-1"], "filas_escritas": 1,
           "mensaje": "Listo: registre la entrega de efectivo de $1500.00 de Gilberto."})]
S.respuestas["/api/bot/aprobacion"] = [(200, {"ok": True, "borrador_id": "b-ent", "tipo": "entrega_efectivo",
                                              "sello": "s-ent", "estado": "ESPERA_APROBACION", "chat_id": GRUPO,
                                              "autor_telegram_id": GILBERTO, "autor": "Gilberto",
                                              "aprobador": "Norman"})]


def _sin_conservar(c):
    return {k: v for k, v in c.items() if k != "conservar_pendientes"}


async def d112_dst():
    ug = Update(GRUPO, GILBERTO, "/entrega 1500")
    await B.comando_entrega(ug, Contexto(["1500"]))
    caso("D112: el DST propone SU entrega: sale el monto, sin nombre, con la persona y el grupo",
         [_sin_conservar(c) for c in S.a("/api/bot/entrega/proponer")],
         [{"telegram_id": GILBERTO, "chat_id": GRUPO, "monto": 1500.0}])
    caso("D112: la propuesta trae VA de entrega y Cancelar", botones(ug.message.teclados[-1]),
         ["vaet:b-ent", "no:b-ent"])
    ub = UpdateBoton(GRUPO, GILBERTO, "vaet:b-ent")
    await B.manejar_boton(ub, Contexto())
    caso("D112: el VA del DST va al confirmar de ENTREGA con su sello",
         [(r, c["telegram_id"], c["sello"]) for r, c in S.confirmar()],
         [("/api/bot/entrega/confirmar", GILBERTO, "s-ent")])
    caso("D112: al DST se le dice que espera (no 'Listo: registre')",
         ub.callback_query.message.dichos[-1],
         "Listo, Gilberto. No lo escribo todavia: se lo mande a Norman y a Kevin para que lo aprueben.")
    aviso = [(t, m) for c, t, m in BOT.enviados if c == NORMAN]
    caso("D112: a Norman le llega por privado con Aprobar/Rechazar",
         [(t.split(NLP)[0], botones(m)) for t, m in aviso],
         [("Gilberto propone una entrega de efectivo y espera tu Aprobar.", ["apr:b-ent", "rch:b-ent"])])
    ua = UpdateBoton(NORMAN, NORMAN, "apr:b-ent")
    await B.manejar_boton(ua, Contexto())
    caso("D112: el Aprobar de Norman llega al confirmar de ENTREGA (RUTA_CONFIRMAR_DE)",
         [(r, c["telegram_id"], c["sello"]) for r, c in S.confirmar()][-1:],
         [("/api/bot/entrega/confirmar", NORMAN, "s-ent")])
    caso("D112: Norman ve 'Aprobado'", ua.callback_query.message.dichos[-1], "Aprobado. Quedo escrito.")

correr(S, d112_dst())
limpiar()

S = Servidor()
S.respuestas["/api/bot/entrega/proponer"] = [
    (200, {"ok": False, "hay_que_elegir": True, "mensaje": "No se a quien te refieres con Gil. Es alguno de estos?",
           "opciones": [{"id_entidad": "e-gil", "nombre": "Gilberto", "rol": "DST"},
                        {"id_entidad": "e-gilda", "nombre": "Gilda", "rol": "LOC"}]}),
    (200, {"ok": True, "borrador_id": "b-ent2", "sello": "s-ent2", "id_entidad": "e-gilda",
           "mensaje": "ENTREGA DE EFECTIVO — Gilda"})]
S.respuestas["/api/bot/entrega/confirmar"] = [(200, {"ok": True, "filas_escritas": 1,
                                                    "mensaje": "Listo: registre la entrega de efectivo de $2000.00 de Gilda."})]


async def d112_matriz():
    un = Update(NORMAN, NORMAN, "/entrega 2,000 Gil")
    await B.comando_entrega(un, Contexto(["2,000", "Gil"]))
    caso("D112: la matriz dice el nombre; con duda, botones por indice",
         (S.a("/api/bot/entrega/proponer")[0].get("entidad"), botones(un.message.teclados[-1])),
         ("Gil", ["setet:0", "setet:1", "no:x"]))
    ue = UpdateBoton(NORMAN, NORMAN, "setet:1")
    await B.manejar_boton(ue, Contexto())
    segunda = S.a("/api/bot/entrega/proponer")[-1]
    caso("D112: el boton re-propone por uuid de la lista, con el mismo monto",
         (segunda.get("id_entidad"), segunda.get("entidad"), segunda.get("monto")), ("e-gilda", None, 2000.0))
    # El "va" ESCRITO tambien llega al confirmar de entrega (no al de gasto).
    uv = Update(NORMAN, NORMAN, "va")
    await B._confirmar(uv, NORMAN, por_boton=True)
    caso("D112: el 'va' escrito de una entrega va a SU confirmar",
         [r for r, _ in S.confirmar()], ["/api/bot/entrega/confirmar"])
    caso("D112: ... y dice lo que escribio el servidor", uv.message.dichos[-1:],
         ["Listo: registre la entrega de efectivo de $2000.00 de Gilda."])
    ux = Update(NORMAN, NORMAN, "/entrega mil")
    antes = len(S.llamadas)
    await B.comando_entrega(ux, Contexto(["mil"]))
    caso("D112: monto ilegible -> no sale nada al servidor", len(S.llamadas) - antes, 0)

correr(S, d112_matriz())
limpiar()

S = Servidor()
S.respuestas["/api/bot/entrega/proponer"] = [
    (403, {"error": "Solo registras tu propia entrega de efectivo, no la de otro distribuidor."})]


async def d112_ajeno():
    ug = Update(GILBERTO, GILBERTO, "/entrega 500 Martin")
    await B.comando_entrega(ug, Contexto(["500", "Martin"]))
    caso("D112 celda No: DST con la entrega de OTRO -> se le dice el 403 y no hay VA",
         (ug.message.dichos, [t for t in ug.message.teclados if t is not None]),
         (["Solo registras tu propia entrega de efectivo, no la de otro distribuidor."], []))
    caso("D112 celda No: ... y nada llega a un confirmar", S.confirmar(), [])

correr(S, d112_ajeno())
limpiar()

# ═══ 10. D118/D119: el alta natural ═════════════════════════════════════════
# D118: al ENTRAR alguien al grupo, si no esta dado de alta, el bot pregunta
# quien es; Norman contesta A ESA PREGUNTA ("es Gilberto") y se registra al
# miembro del pendiente (no al bot, autor del mensaje contestado).
# D119: el primer mensaje de un desconocido, aunque sea "hola", dispara la
# pregunta una sola vez; la charla de los registrados sigue sin contestarse.
# Mutaciones: quitar el handler de main() -> rojo; registrar al autor del
# mensaje contestado en vez del pendiente -> rojo; quitar la guarda de una vez
# (en la entrada o en la puerta) -> rojo.


class UpdateEntrada(object):
    """El update de servicio de Telegram: `message.new_chat_members`."""

    def __init__(self, chat, quien_agrega, miembros):
        self.message = Mensaje(chat, "", quien_agrega)
        self.message.text = None
        self.message.new_chat_members = miembros
        self.effective_user = Usuario(quien_agrega)
        self.callback_query = None

    @property
    def effective_message(self):
        return self.message

    @property
    def effective_chat(self):
        return self.message.chat

    def get_bot(self):
        return BOT


NUEVO = Usuario(DESCONOCIDO, first_name="Gil", last_name="Ramos", username="gilr")
PREGUNTA_ENTRADA = 'Norman, ¿quien es Gil Ramos (@gilr)? Contestame a este mensaje con "es <nombre>".'
PROPUESTA_MB = (200, {"ok": True, "borrador_id": "b-mb2", "sello": "s-mb2",
                      "mensaje": "REGISTRO: Gilberto -> Casa Verde (DST)"})

caso("D118: nombre visible con nombre, apellido y @", B._nombre_visible(NUEVO), "Gil Ramos (@gilr)")
caso("D118: nombre visible solo con @", B._nombre_visible(Usuario(1, username="x")), "@x")
caso("D118: nombre visible sin nada", B._nombre_visible(Usuario(1)), "esta persona")

S = Servidor()
S.respuestas["/api/bot/miembro/proponer"] = [PROPUESTA_MB]
S.respuestas["/api/bot/miembro/confirmar"] = [(200, {"ok": True, "mensaje": "Listo: Gilberto queda registrado."})]


async def d118_entrada():
    await B.manejar_entrada(UpdateEntrada(GRUPO, NORMAN, [NUEVO]), Contexto())
    caso("D118: entra un desconocido -> el bot pregunta quien es, en el grupo",
         [(c, t) for c, t, _ in BOT.enviados], [(GRUPO, PREGUNTA_ENTRADA)])
    caso("D118: ... y la pregunta queda anotada con el miembro que entro",
         sorted(B._preguntas_de_alta.values()), [DESCONOCIDO])
    # Sale y vuelve a entrar: no se vuelve a preguntar (una vez por grupo-persona).
    await B.manejar_entrada(UpdateEntrada(GRUPO, NORMAN, [NUEVO]), Contexto())
    caso("D118: si vuelve a entrar, no se pregunta dos veces", len(BOT.enviados), 1)
    # Su primer "hola" despues de entrar tampoco dispara otra pregunta.
    uh = Update(GRUPO, DESCONOCIDO, "hola")
    await B.manejar_texto(uh, Contexto())
    caso("D118: su 'hola' despues de entrar no repite la pregunta", uh.message.dichos, [])
    caso("D118: ... y no llega al modelo", list(al_modelo), [])
    # Norman contesta A LA PREGUNTA DEL BOT.
    (chat_id, mid), = list(B._preguntas_de_alta.keys())
    pregunta = Mensaje(GRUPO, PREGUNTA_ENTRADA, BOT_ID, bot=True)
    pregunta.message_id = mid
    un = Update(GRUPO, NORMAN, "es Gilberto", contesta_a=pregunta)
    await B.manejar_texto(un, Contexto())
    caso("D118: Norman contesta al bot -> se propone el alta DEL QUE ENTRO (no del bot)",
         [(c["telegram_id"], c.get("chat_id"), c["miembro_telegram_id"], c["texto"])
          for c in S.a("/api/bot/miembro/proponer")],
         [(NORMAN, GRUPO, DESCONOCIDO, "es Gilberto")])
    caso("D118: ... con el mismo boton VA de siempre", boton(un.message.teclados[-1], "vamb"), "vamb:b-mb2")
    caso("D118: ... y 'es Gilberto' no llega al modelo", list(al_modelo), [])
    await B.manejar_boton(UpdateBoton(GRUPO, NORMAN, "vamb:b-mb2"), Contexto())
    caso("D118: el VA de Norman escribe el alta",
         [(c["telegram_id"], c["borrador_id"]) for c in S.a("/api/bot/miembro/confirmar")],
         [(NORMAN, "b-mb2")])
    caso("D118: registrado, su pregunta pendiente se borra", dict(B._preguntas_de_alta), {})

correr(S, d118_entrada())
limpiar()

S = Servidor()


async def d118_registrado_y_bot():
    gil = Usuario(GILBERTO, first_name="Gilberto")
    await B.manejar_entrada(UpdateEntrada(GRUPO, NORMAN, [gil]), Contexto())
    caso("D118: entra alguien ya dado de alta -> el bot no dice nada", list(BOT.enviados), [])
    otro_bot = Usuario(555, is_bot=True, first_name="OtroBot")
    este_bot = Usuario(BOT_ID, is_bot=True, first_name="Fresnillo", username="fresnillo_bot")
    await B.manejar_entrada(UpdateEntrada(GRUPO, NORMAN, [otro_bot, este_bot]), Contexto())
    caso("D118: entra un bot (otro, o este mismo) -> nada, ni se pregunta al ERP",
         (list(BOT.enviados), [c["telegram_id"] for c in S.a("/api/bot/identidad")]), ([], [GILBERTO]))
    caso("D118: sin pregunta anotada", dict(B._preguntas_de_alta), {})

correr(S, d118_registrado_y_bot())
limpiar()

# Kevin (dado de alta, no es Norman) contesta a la pregunta del bot: el
# servidor lo niega (`permisoDeAccion(..., 'registrar')`); el bot lo dice y no
# revienta ni confirma nada.
S = Servidor()
S.respuestas["/api/bot/miembro/proponer"] = [(403, {"error": "Solo Norman registra miembros."})]


async def d118_no_norman():
    await B.manejar_entrada(UpdateEntrada(GRUPO, KEVIN, [NUEVO]), Contexto())
    (chat_id, mid), = list(B._preguntas_de_alta.keys())
    pregunta = Mensaje(GRUPO, PREGUNTA_ENTRADA, BOT_ID, bot=True)
    pregunta.message_id = mid
    uk = Update(GRUPO, KEVIN, "es Gilberto", contesta_a=pregunta)
    await B.manejar_texto(uk, Contexto())
    caso("D118: Kevin contesta a la pregunta -> sale al servidor con SU telegram_id (el decide)",
         [(c["telegram_id"], c["miembro_telegram_id"]) for c in S.a("/api/bot/miembro/proponer")],
         [(KEVIN, DESCONOCIDO)])
    caso("D118: ... el servidor lo niega y Kevin lo ve, sin boton VA",
         (uk.message.dichos, [botones(t) for t in uk.message.teclados]),
         (["Solo Norman registra miembros."], [[]]))
    caso("D118: ... y no se confirma nada", S.confirmar(), [])
    caso("D118: ... y la pregunta sigue viva para Norman", sorted(B._preguntas_de_alta.values()), [DESCONOCIDO])
    # CONTROL: "es Gilberto" contestado a OTRO mensaje del bot (no una pregunta)
    # no es registro: va al modelo como siempre.
    otro = Mensaje(GRUPO, "Aqui ando.", BOT_ID, bot=True)
    un = Update(GRUPO, NORMAN, "es Gilberto", contesta_a=otro)
    await B.manejar_texto(un, Contexto())
    caso("D118 CONTROL: contestar a un mensaje del bot que no es pregunta NO propone alta",
         (len(S.a("/api/bot/miembro/proponer")), [t for t, _ in al_modelo]), (1, ["es Gilberto"]))

correr(S, d118_no_norman())
limpiar()


# main() registra el handler de entrada, y el filtro REAL de python-telegram-bot
# lo acepta con un Update real de Telegram (de_json) que trae new_chat_members.
class _AppFalsa(object):
    def __init__(self):
        self.handlers = []

    def builder(self):
        return self

    def token(self, *_a):
        return self

    def post_init(self, *_a):
        return self

    def build(self):
        return self

    def add_handler(self, h):
        self.handlers.append(h)

    def add_error_handler(self, *_a):
        pass

    def run_polling(self, **_k):
        pass


def _handlers_de_main():
    from telegram import Update as UpdateTG
    app = _AppFalsa()
    guardados = (B.Application, B.TOKEN_TG, B.TOKEN_API, B._candado)
    B.Application, B.TOKEN_TG, B.TOKEN_API, B._candado = app, "x", "y" * 30, (lambda: None)
    try:
        B.main()
    finally:
        B.Application, B.TOKEN_TG, B.TOKEN_API, B._candado = guardados
    real = UpdateTG.de_json({"update_id": 1, "message": {
        "message_id": 7, "date": 0, "chat": {"id": GRUPO, "type": "supergroup", "title": "g"},
        "from": {"id": NORMAN, "is_bot": False, "first_name": "Norman"},
        "new_chat_members": [{"id": DESCONOCIDO, "is_bot": False, "first_name": "Gil"}]}}, None)
    return [getattr(h.callback, "__name__", "?") for h in app.handlers if h.check_update(real)]


try:
    caso("D118: main() registra un handler que atiende la entrada al grupo (filtro real de PTB)",
         _handlers_de_main(), ["manejar_entrada"])
except Exception as e:
    caso("D118: main() registra el handler de entrada (sin excepcion)", repr(e), None)
limpiar()

# D119: el "hola" del desconocido (sin haber entrado con el bot presente).
S = Servidor()
S.respuestas["/api/bot/miembro/proponer"] = [PROPUESTA_MB]


async def d119_hola():
    u1 = Update(GRUPO, DESCONOCIDO, "hola")
    await B.manejar_texto(u1, Contexto())
    u2 = Update(GRUPO, DESCONOCIDO, "hola, buenas")
    await B.manejar_texto(u2, Contexto())
    caso("D119: el primer 'hola' de un desconocido dispara la pregunta, una sola vez",
         (u1.message.dichos, u2.message.dichos), ([PREGUNTA], []))
    caso("D119: ... y ninguno de sus 'hola' llega al modelo", list(al_modelo), [])
    caso("D119: la pregunta de la puerta queda anotada con el desconocido",
         sorted(B._preguntas_de_alta.values()), [DESCONOCIDO])
    # Norman contesta A LA PREGUNTA DEL BOT (no al mensaje de la persona).
    (chat_id, mid), = list(B._preguntas_de_alta.keys())
    pregunta = Mensaje(GRUPO, PREGUNTA, BOT_ID, bot=True)
    pregunta.message_id = mid
    un = Update(GRUPO, NORMAN, "este es Gilberto", contesta_a=pregunta)
    await B.manejar_texto(un, Contexto())
    caso("D119: Norman contesta a la pregunta del bot -> se propone al desconocido",
         [(c["telegram_id"], c["miembro_telegram_id"]) for c in S.a("/api/bot/miembro/proponer")],
         [(NORMAN, DESCONOCIDO)])
    # La ruta vieja sigue: contestar al mensaje de la persona.
    un2 = Update(GRUPO, NORMAN, "este es Gilberto", contesta_a=u1.message)
    await B.manejar_texto(un2, Contexto())
    caso("D119: la ruta vieja (contestar al 'hola' de la persona) sigue proponiendo al mismo",
         [c["miembro_telegram_id"] for c in S.a("/api/bot/miembro/proponer")], [DESCONOCIDO, DESCONOCIDO])

correr(S, d119_hola())
limpiar()

S = Servidor()


async def d119_registrado():
    g1 = Update(GRUPO, GILBERTO, "hola")
    await B.manejar_texto(g1, Contexto())
    g2 = Update(GRUPO, GILBERTO, "que onda")
    await B.manejar_texto(g2, Contexto())
    caso("D119 CONTROL: la charla de un registrado sigue sin contestarse",
         (g1.message.dichos, g2.message.dichos), ([], []))
    caso("D119 CONTROL: ... ni se le pregunta quien es", dict(B._preguntas_de_alta), {})
    caso("D119 costo: dos charlas de un registrado = 1 identidad (cache) y 1 modelo por mensaje",
         (len(S.a("/api/bot/identidad")), [t for t, _ in al_modelo]), (1, ["hola", "que onda"]))

correr(S, d119_registrado())
limpiar()

# ─── Resultado ───────────────────────────────────────────────────────────────
fallan = 0
for nombre, obtenido, esperado in casos:
    ok = obtenido == esperado
    fallan += 0 if ok else 1
    print(("OK    " if ok else "FALLA ") + nombre)
    if not ok:
        print("       obtenido: %r" % (obtenido,))
        print("       esperado: %r" % (esperado,))
print()
if fallan:
    print("RESULTADO: %d de %d casos FALLAN" % (fallan, len(casos)))
    sys.exit(1)
print("RESULTADO: los %d casos pasan" % len(casos))
