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

    async def send_photo(self, chat_id, **k):
        self.enviados.append((chat_id, "[foto]", None))

    def a(self, chat_id):
        return [t for c, t, _ in self.enviados if c == chat_id]


BOT = Bot()


class Usuario(object):
    def __init__(self, uid, is_bot=False):
        self.id = uid
        self.is_bot = is_bot


class Chat(object):
    def __init__(self, cid):
        self.id = cid

    async def send_action(self, _a):
        return None


class Mensaje(object):
    def __init__(self, chat, texto="", de=None, contesta_a=None):
        self.chat = Chat(chat)
        self.text = texto
        self.from_user = Usuario(de) if de else None
        self.reply_to_message = contesta_a
        self.dichos = []
        self.teclados = []

    async def reply_text(self, texto, **kw):
        self.dichos.append(texto)
        self.teclados.append(kw.get("reply_markup"))

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
         ["No te tengo registrado. Norman, ¿quien es?\n(Norman: contesta a su mensaje con \"este es <nombre>\".)"])
    caso("D95: lo que dijo el desconocido no llega al modelo", al_modelo, [])
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
                                              "autor_telegram_id": KEVIN, "autor": "Kevin"})]
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
S.respuestas["/api/bot/cancelar"] = [(200, {"ok": True, "autor_telegram_id": KEVIN, "chat_id": GRUPO})]


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
