# -*- coding: utf-8 -*-
"""Suscripciones (2026-11-09): la pregunta de cada mes, sus botones, el monto
escrito y /suscripciones, sin red, sin Telegram y sin base.

El servidor se dobla con un `Servidor` que guarda el estado del mes en un dict
(lo mismo que la tabla `suscripcion_meses`: una fila por (id, mes), y el INSERT
que choca devuelve `reclamado: false`). La logica de "cuando toca" y "en que
estado esta" es del servidor y se prueba en `tests/suscripciones*.spec.ts`; aqui
se prueba el PROTOCOLO del bot:

  1. tick: cada pregunta sale UNA vez, solo a Norman, con los tres botones.
     Otro tick no la repite; un REINICIO (reload del modulo: la RAM se borra)
     tampoco. CONTROL: el mes siguiente si vuelve a salir.
  2. Si Telegram falla, la pregunta se suelta y el siguiente latido la reintenta.
  3. "Ya se pago" -> tarjeta con el monto; "Registrar" -> UN egreso; un segundo
     "Registrar" no escribe otro. "Otro monto" + numero -> egreso con ese monto.
     USD -> pide los pesos.
  4. "Todavia no" -> posponer; "Ya no la tengo" -> baja.
  5. El clic de otro que no es Norman no manda nada al servidor.
  6. /suscripciones: botones solo en privado.
  7. Cableado en bot_gastos: latido, comando, botones y texto pasan por aqui.
  8. Ningun callback_data pasa de 64 bytes.
  9. RONDA 2 (auditoria 2026-11-09): leer_monto como dicta Whisper; `entregado`
     y el reenvio UNICO de una pregunta que no salio; el "todavia no" de un mes
     anterior con SUS botones; el egreso ya capturado por otro canal (ligar /
     registrar otro); "Otro monto" y los pesos de USD por NOTA DE VOZ.

MUTACIONES corridas a mano (2026-11-09), cada una pone rojo al menos un caso:
  · tick ignora la respuesta del reclamo            -> rojo en 1 (latidos cruzados)
  · tick sin `soltar` al fallar                      -> rojo en 2
  · `es_norman` devuelve True siempre                -> rojo en 5

Corre con:  python bot/probar_suscripciones.py
"""
import asyncio
import importlib
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("BOT_LOG", os.path.join(tempfile.gettempdir(), "probar_bot.log"))
os.environ.pop("BOT_ENSAYO", None)

import suscripciones as S  # noqa: E402

NORMAN = S.NORMAN_TELEGRAM_ID
KEVIN = 222
casos = []


def caso(nombre, obtenido, esperado):
    casos.append((nombre, obtenido, esperado))


# ── dobles ───────────────────────────────────────────────────────────────────

class Servidor:
    """El estado del mes como la tabla: {(id, mes): fila}. Pagos -> egresos.

    Ronda 2: `leer` recorre TODAS las filas (un "todavia no" de octubre se
    reintenta en noviembre con SU mes), ofrece el 'reenvio' de una PREGUNTADA
    sin id de mensaje y con 6+ horas (`edad`, reloj logico), guarda el
    `id_mensaje` de `entregado`, y modela los egresos ya capturados por otro
    canal (`candidatos`) con `ligar` y `forzar_nuevo`."""

    def __init__(self, subs, mes="2026-11"):
        self.subs = subs  # id -> dict(nombre, monto, moneda)
        self.mes = mes
        self.filas = {}
        self.egresos = []
        self.ligados = []
        self.candidatos = {}  # id_suscripcion -> [dict(id, monto_texto, fecha, descripcion)]
        self.llamadas = []
        self.ahora = 0  # reloj logico del servidor
        self.leer_viejo = False  # dos latidos cruzados: `leer` aun no ve el reclamo del otro

    def __call__(self, ruta, cuerpo):
        self.llamadas.append((ruta, dict(cuerpo)))
        a = cuerpo.get("accion")
        if a == "leer":
            pre = []
            for i, s in self.subs.items():
                if not s.get("activa", True):
                    continue
                if self.leer_viejo or (i, self.mes) not in self.filas:
                    pre.append({"id_suscripcion": i, "mes": self.mes, "tipo": "nueva", "texto": "Pregunta " + s["nombre"]})
            if not self.leer_viejo:
                for (i, mes), f in sorted(self.filas.items()):
                    if not self.subs.get(i, {}).get("activa", True):
                        continue
                    if f["estado"] == "POSPUESTA" and f["volver"] <= self.ahora:
                        pre.append({"id_suscripcion": i, "mes": mes, "tipo": "reintento", "texto": "Otra vez " + self.subs[i]["nombre"]})
                    elif (f["estado"] == "PREGUNTADA" and f.get("id_mensaje") is None
                          and f.get("edad", 0) >= 6 and f.get("reenvios", 0) == 0):
                        pre.append({"id_suscripcion": i, "mes": mes, "tipo": "reenvio", "texto": "De nuevo " + self.subs[i]["nombre"]})
            return 200, {"ok": True, "preguntas": pre, "para": NORMAN}
        clave = (cuerpo.get("id_suscripcion"), cuerpo.get("mes"))
        f = self.filas.get(clave)
        if a == "reclamar":
            t = cuerpo["tipo"]
            if t == "nueva":
                if f is not None:
                    return 200, {"ok": True, "reclamado": False}
                self.filas[clave] = {"estado": "PREGUNTADA", "id_mensaje": None, "edad": 0, "reenvios": 0}
                return 200, {"ok": True, "reclamado": True}
            if t == "reintento" and f and f["estado"] == "POSPUESTA" and f["volver"] <= self.ahora:
                f.update(estado="PREGUNTADA", id_mensaje=None, edad=0, reenvios=0)
                return 200, {"ok": True, "reclamado": True}
            if (t == "reenvio" and f and f["estado"] == "PREGUNTADA" and f.get("id_mensaje") is None
                    and f.get("edad", 0) >= 6 and f.get("reenvios", 0) == 0):
                f.update(edad=0, reenvios=1)
                return 200, {"ok": True, "reclamado": True}
            return 200, {"ok": True, "reclamado": False}
        if a == "entregado":
            if f is not None:
                f["id_mensaje"] = cuerpo.get("id_mensaje")
            return 200, {"ok": True}
        if a == "soltar":
            if f and f["estado"] == "PREGUNTADA":
                f.update(estado="POSPUESTA", volver=self.ahora)
            return 200, {"ok": True}
        if a == "listar":
            pend = [{"id": i, "nombre": s["nombre"], "mes": self.mes} for i, s in self.subs.items()]
            return 200, {"ok": True, "texto": "Lista", "pendientes": pend, "privado": True}
        if cuerpo.get("telegram_id") != NORMAN:
            return 403, {"error": "Las suscripciones las marca Norman."}
        s = self.subs[clave[0]]
        cand = [] if (f and f["estado"] == "PAGADA") else list(self.candidatos.get(clave[0], []))
        if a == "proponer_pago":
            if f and f["estado"] == "PAGADA":
                return 200, {"ok": True, "ya_pagada": True, "nombre": s["nombre"]}
            if cand and not cuerpo.get("ignorar_candidatos"):
                return 200, {"ok": True, "nombre": s["nombre"], "candidatos": cand}
            if s["moneda"] == "USD":
                return 200, {"ok": True, "pide_pesos": True, "nombre": s["nombre"], "monto_catalogo": "USD 200.00", "candidatos": []}
            return 200, {"ok": True, "nombre": s["nombre"], "monto": s["monto"], "monto_texto": "$%.2f" % s["monto"],
                         "cuenta": "Cuenta personal", "pide_pesos": False, "candidatos": []}
        if a == "pagar":
            if f and f["estado"] == "PAGADA":
                return 409, {"error": "La de %s ya esta registrada como pagada." % clave[1]}
            if cand and not cuerpo.get("forzar_nuevo"):
                return 409, {"error": "Ya hay un egreso que la menciona.", "duplicado_posible": True,
                             "nombre": s["nombre"], "candidatos": cand}
            self.filas[clave] = {"estado": "PAGADA"}
            self.egresos.append((clave, cuerpo["monto"]))
            return 200, {"ok": True, "texto": "Registrado: %s $%.2f" % (s["nombre"], cuerpo["monto"])}
        if a == "ligar":
            if not any(c["id"] == cuerpo.get("id_movimiento") for c in cand):
                return 409, {"error": "Ese egreso ya no es candidato."}
            self.filas[clave] = {"estado": "PAGADA", "id_movimiento": cuerpo["id_movimiento"]}
            self.ligados.append((clave, cuerpo["id_movimiento"]))
            return 200, {"ok": True, "texto": "Ligado: %s" % s["nombre"]}
        if a == "posponer":
            self.filas[clave] = {"estado": "POSPUESTA", "volver": self.ahora + 3}
            return 200, {"ok": True, "texto": "Va. Te vuelvo a preguntar en 3 dias."}
        if a == "baja":
            s["activa"] = False
            self.filas[clave] = {"estado": "BAJA"}
            return 200, {"ok": True, "texto": "Listo: dada de baja."}
        return 400, {"error": "?"}

    def de(self, accion):
        return [c for r, c in self.llamadas if c.get("accion") == accion]


class _Enviado:
    def __init__(self, message_id):
        self.message_id = message_id


class Bot:
    def __init__(self, falla=False):
        self.enviados = []
        self.falla = falla

    async def send_message(self, chat_id, texto, reply_markup=None):
        if self.falla:
            raise RuntimeError("Telegram no contesta")
        self.enviados.append((chat_id, texto, _datos(reply_markup)))
        return _Enviado(1000 + len(self.enviados))


class Mensaje:
    def __init__(self):
        self.dichos = []
        self.teclados = []

    async def reply_text(self, texto, reply_markup=None, **_):
        self.dichos.append(texto)
        self.teclados.append(_datos(reply_markup))

    async def send_action(self, *_a, **_k):
        return None


class Update:
    def __init__(self):
        self.effective_message = Mensaje()


def _datos(teclado):
    if teclado is None:
        return []
    return [b.callback_data for fila in teclado.inline_keyboard for b in fila]


def correr(coro):
    return asyncio.run(coro)


SUBS = lambda: {1: {"nombre": "ManyChat", "monto": 480.0, "moneda": "MXN"},  # noqa: E731
                2: {"nombre": "Claude Max", "monto": 200.0, "moneda": "USD"}}

# ── 1. una vez, solo a Norman, y un reinicio no repite ───────────────────────
srv = Servidor(SUBS())
bot = Bot()
correr(S.tick(bot, srv))
caso("1. primer latido: salen las 2 preguntas", len(bot.enviados), 2)
caso("1. ... las dos a Norman (privado)", sorted({c for c, _, _ in bot.enviados}), [NORMAN])
caso("1. ... con los tres botones", bot.enviados[0][2], ["suspg:1:2026-11", "susno:1:2026-11", "susbj:1:2026-11"])
correr(S.tick(bot, srv))
caso("1. segundo latido: no repite", len(bot.enviados), 2)
S = importlib.reload(S)  # reinicio: la RAM del modulo se pierde
correr(S.tick(bot, srv))
caso("1. tras reiniciar: no repite (el estado esta en la base)", len(bot.enviados), 2)
srv.leer_viejo = True
correr(S.tick(bot, srv))
caso("1. latidos cruzados: `leer` la ofrece pero el reclamo la niega -> no sale", len(bot.enviados), 2)
srv.leer_viejo = False
srv.mes = "2026-12"
correr(S.tick(bot, srv))
caso("1. CONTROL: el mes siguiente si vuelve a preguntar", len(bot.enviados), 4)

# ── 2. Telegram falla -> se suelta y se reintenta ────────────────────────────
srv = Servidor({1: {"nombre": "ManyChat", "monto": 480.0, "moneda": "MXN"}})
caido = Bot(falla=True)
correr(S.tick(caido, srv))
caso("2. envio fallido: se suelta la pregunta", len(srv.de("soltar")), 1)
bot = Bot()
correr(S.tick(bot, srv))
caso("2. siguiente latido: la reintenta y sale", len(bot.enviados), 1)
correr(S.tick(bot, srv))
caso("2. ... y ya no otra vez", len(bot.enviados), 1)

# ── 3. ya se pago ────────────────────────────────────────────────────────────
srv = Servidor(SUBS())
u = Update()
correr(S.atender_boton(u, NORMAN, "suspg:1:2026-11", srv))
caso("3. 'Ya se pago' (MXN): tarjeta con el monto del catalogo", u.effective_message.teclados[-1],
     ["susok:1:2026-11:480.00", "susmt:1:2026-11"])
caso("3. ... y todavia no escribe nada", list(srv.egresos), [])
correr(S.atender_boton(u, NORMAN, "susok:1:2026-11:480.00", srv))
caso("3. 'Registrar': UN egreso con el monto del catalogo", srv.egresos, [((1, "2026-11"), 480.0)])
correr(S.atender_boton(u, NORMAN, "susok:1:2026-11:480.00", srv))
caso("3. segundo 'Registrar': no hay otro egreso", len(srv.egresos), 1)
caso("3. ... y se dice que ya estaba", u.effective_message.dichos[-1], "La de 2026-11 ya esta registrada como pagada.")

srv = Servidor(SUBS())
u = Update()
correr(S.atender_boton(u, NORMAN, "susmt:1:2026-11", srv))
r = correr(S.atender_texto(u, NORMAN, "$4,100.50", srv))
caso("3. 'Otro monto' + '$4,100.50': egreso con ese monto", (r, srv.egresos), (True, [((1, "2026-11"), 4100.5)]))
correr(S.atender_boton(u, NORMAN, "susmt:1:2026-11", srv))
r = correr(S.atender_texto(u, NORMAN, "gaste 300 de gasolina", srv))
caso("3. CONTROL: un texto que no es numero suelta la espera y sigue al bot", (r, S.esperando.get(NORMAN)), (False, None))
r = correr(S.atender_texto(u, NORMAN, "500", srv))
caso("3. CONTROL: sin espera, un numero no es de suscripciones", (r, len(srv.egresos)), (False, 1))

srv = Servidor(SUBS())
u = Update()
correr(S.atender_boton(u, NORMAN, "suspg:2:2026-11", srv))
caso("3. USD: pide los pesos (no hay tipo de cambio)", "PESOS" in u.effective_message.dichos[-1], True)
correr(S.atender_texto(u, NORMAN, "3950", srv))
caso("3. USD + '3950': egreso en pesos", srv.egresos, [((2, "2026-11"), 3950.0)])

# ── 4. todavia no / ya no la tengo ──────────────────────────────────────────
srv = Servidor(SUBS())
u = Update()
correr(S.atender_boton(u, NORMAN, "susno:1:2026-11", srv))
caso("4. 'Todavia no' -> posponer", [c["id_suscripcion"] for c in srv.de("posponer")], [1])
bot = Bot()
correr(S.tick(bot, srv))
caso("4. ... antes de 3 dias no se vuelve a preguntar la pospuesta", [t for _, t, _ in bot.enviados], ["Pregunta Claude Max"])
srv.ahora = 3
correr(S.tick(bot, srv))
caso("4. ... a los 3 dias si (reintento)", [t for _, t, _ in bot.enviados][-1], "Otra vez ManyChat")
correr(S.atender_boton(u, NORMAN, "susbj:2:2026-11", srv))
caso("4. 'Ya no la tengo' -> baja", (len(srv.de("baja")), srv.subs[2].get("activa")), (1, False))

# ── 5. el clic de otro ───────────────────────────────────────────────────────
srv = Servidor(SUBS())
u = Update()
for d in ("suspg:1:2026-11", "susok:1:2026-11:480.00", "susno:1:2026-11", "susbj:1:2026-11"):
    correr(S.atender_boton(u, (-100123, KEVIN), d, srv))
caso("5. Kevin (en grupo) aprieta los 4: nada llega al servidor", list(srv.llamadas), [])
caso("5. ... y se le dice por que", u.effective_message.dichos[0], "Las suscripciones las marca Norman. Tu clic no escribio nada.")
caso("5. un boton que no es de suscripciones no se toca", correr(S.atender_boton(u, NORMAN, "va:abc", srv)), False)

# ── 6. /suscripciones ────────────────────────────────────────────────────────
srv = Servidor(SUBS())
est, r = srv("/api/bot/suscripciones", {"accion": "listar", "telegram_id": NORMAN})
texto, teclado, _ = S.respuesta_de_lista(est, r, False)
caso("6. privado: un boton 'Ya se pago' por pendiente", _datos(teclado), ["suspg:1:2026-11", "suspg:2:2026-11"])
texto, teclado, _ = S.respuesta_de_lista(est, r, True)
caso("6. grupo: sin botones", teclado, None)
texto, teclado, rr = S.respuesta_de_lista(403, {"error": "Esa consulta es de la empresa"}, False)
caso("6. 403: se contesta el error", (texto, rr), ("Esa consulta es de la empresa", None))

# ── 7. cableado en bot_gastos ────────────────────────────────────────────────
import bot_gastos as B  # noqa: E402

caso("7. mismo NORMAN_TELEGRAM_ID en bot_gastos y en suscripciones", B.NORMAN_TELEGRAM_ID, S.NORMAN_TELEGRAM_ID)
caso("7. /suscripciones pasa por la puerta de grupo", getattr(B.comando_suscripciones, "con_puerta", False), True)
srv = Servidor(SUBS())
antes = B._post
B._post = srv
B.suscripciones = S


class Q:
    data = "susno:1:2026-11:x"


u = Update()
correr(B._manejar_boton(u, NORMAN, Q(), Q.data.split(":", 2), "susno"))
caso("7. _manejar_boton despacha 'susno' al modulo", [c["accion"] for c in srv.de("posponer")], ["posponer"])
S.esperando[NORMAN] = (1, "2026-11")
correr(B._manejar_texto(u, NORMAN, "480"))
caso("7. _manejar_texto entrega el monto esperado", srv.egresos, [((1, "2026-11"), 480.0)])
bot = Bot()
correr(S.tick(bot, B._post))
caso("7. el latido llama al tick con el _post del bot", len(srv.de("leer")), 1)
B._post = antes
fuente = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "bot_gastos.py"), encoding="utf-8").read()
caso("7. el latido cuelga suscripciones.tick", "await suscripciones.tick(app.bot, _post)" in fuente, True)
caso("7. main() registra /suscripciones", 'CommandHandler("suscripciones", comando_suscripciones)' in fuente, True)

# ── 8. 64 bytes ──────────────────────────────────────────────────────────────
peores = _datos(S.teclado_pregunta(9999999, "2026-12")) + _datos(S.teclado_registrar(9999999, "2026-12", 500000, "$500,000.00")) \
    + _datos(S.teclado_pendientes([{"id": 9999999, "mes": "2026-12", "nombre": "x" * 80}]))
caso("8. ningun callback_data pasa de 64 bytes", max(len(d.encode("utf-8")) for d in peores) <= 64, True)

# ── 9. RONDA 2 (auditoria 2026-11-09) ────────────────────────────────────────
UUID = "0b9e5a52-6f0e-4c1e-9a77-3d2f1c0e8a41"

# 9.4 leer_monto acepta como dicta Whisper y como escribe Norman.
caso("9.4 leer_monto: '480.', '480 MXN.', '$480', '480 pesos', '480 pesos.', '$ 4,100.50', '480,50'",
     [S.leer_monto(t) for t in ("480.", "480 MXN.", "$480", "480 pesos", "480 pesos.", "$ 4,100.50", "480,50")],
     [480.0, 480.0, 480.0, 480.0, 480.0, 4100.5, 480.5])
caso("9.4 CONTROL: lo que no es monto sigue siendo None",
     [S.leer_monto(t) for t in ("hola", "0", "", "480 dolares y algo", "1.2.3")], [None, None, None, None, None])

# 9.2 el tick avisa `entregado` con el message_id; sin ese aviso, a las 6 h sale UNA vez mas.
srv = Servidor({1: {"nombre": "ManyChat", "monto": 480.0, "moneda": "MXN"}})
bot = Bot()
correr(S.tick(bot, srv))
caso("9.2 tras mandar, el bot guarda el id del mensaje (entregado)",
     [(c["id_suscripcion"], c["mes"], c.get("id_mensaje")) for c in srv.de("entregado")], [(1, "2026-11", 1001)])
srv.filas[(1, "2026-11")]["edad"] = 7
correr(S.tick(bot, srv))
caso("9.2 con id de mensaje, 7 h despues NO se reenvia", len(bot.enviados), 1)
# El bot murio entre el reclamo y el envio: la fila quedo PREGUNTADA sin id.
srv = Servidor({1: {"nombre": "ManyChat", "monto": 480.0, "moneda": "MXN"}})
srv.filas[(1, "2026-11")] = {"estado": "PREGUNTADA", "id_mensaje": None, "edad": 7, "reenvios": 0}
bot = Bot()
correr(S.tick(bot, srv))
caso("9.2 bot muerto entre reclamo y envio: a las 7 h sale (reenvio)",
     ([t for _, t, _ in bot.enviados], [c["tipo"] for c in srv.de("reclamar")]), (["De nuevo ManyChat"], ["reenvio"]))
srv.filas[(1, "2026-11")].update(id_mensaje=None, edad=13)
correr(S.tick(bot, srv))
caso("9.2 ... y solo UNA vez", len(bot.enviados), 1)

# 9.1 un "todavia no" de octubre se reintenta en noviembre con los botones de OCTUBRE.
srv = Servidor({1: {"nombre": "ManyChat", "monto": 480.0, "moneda": "MXN"}})
srv.filas[(1, "2026-10")] = {"estado": "POSPUESTA", "volver": 0}
srv.filas[(1, "2026-11")] = {"estado": "PAGADA"}
bot = Bot()
correr(S.tick(bot, srv))
caso("9.1 POSPUESTA de octubre, ya en noviembre: sale con los botones de 2026-10",
     [d for _, _, d in bot.enviados], [["suspg:1:2026-10", "susno:1:2026-10", "susbj:1:2026-10"]])

# 9.5 el egreso ya capturado por otro canal: [Es este: ligarlo] / [No, registrar otro].
CAND = [{"id": UUID, "monto_texto": "$480.00", "fecha": "05-nov", "descripcion": "pago manychat"}]
srv = Servidor(SUBS())
srv.candidatos = {1: CAND, 2: CAND}
u = Update()
correr(S.atender_boton(u, NORMAN, "suspg:1:2026-11", srv))
caso("9.5 'Ya se pago' con un egreso que ya la menciona: ofrece ligarlo o registrar otro",
     u.effective_message.teclados[-1], ["suslg:1:2026-11:" + UUID, "susnv:1:2026-11"])
caso("9.5 ... y dice cual es", "pago manychat" in u.effective_message.dichos[-1], True)
correr(S.atender_boton(u, NORMAN, "suslg:1:2026-11:" + UUID, srv))
caso("9.5 'Es este: ligarlo': liga sin escribir egreso", (list(srv.ligados), list(srv.egresos)), ([((1, "2026-11"), UUID)], []))
srv = Servidor(SUBS())
srv.candidatos = {1: CAND, 2: CAND}
u = Update()
correr(S.atender_boton(u, NORMAN, "susnv:1:2026-11", srv))
caso("9.5 'No, registrar otro': la tarjeta lleva la marca de 'es otro'", u.effective_message.teclados[-1],
     ["susok:1:2026-11:480.00:n", "susmt:1:2026-11:n"])
caso("9.5 ... y pidio la propuesta sin candidatos", [c.get("ignorar_candidatos") for c in srv.de("proponer_pago")], [True])
correr(S.atender_boton(u, NORMAN, "susok:1:2026-11:480.00:n", srv))
caso("9.5 ... 'Registrar' con la marca: escribe aunque haya candidato",
     (list(srv.egresos), [c.get("forzar_nuevo") for c in srv.de("pagar")]), ([((1, "2026-11"), 480.0)], [True]))
correr(S.atender_boton(u, NORMAN, "susnv:2:2026-11", srv))
correr(S.atender_texto(u, NORMAN, "3950", srv))
caso("9.5 USD + 'registrar otro' + pesos escritos: tambien forzar_nuevo",
     (srv.egresos[-1], srv.de("pagar")[-1].get("forzar_nuevo")), (((2, "2026-11"), 3950.0), True))
# Carrera: el candidato aparecio entre la tarjeta y "Registrar".
srv = Servidor(SUBS())
u = Update()
correr(S.atender_boton(u, NORMAN, "suspg:1:2026-11", srv))
srv.candidatos = {1: CAND}
correr(S.atender_boton(u, NORMAN, "susok:1:2026-11:480.00", srv))
caso("9.5 'Registrar' y el servidor encuentra un egreso: no escribe y ofrece ligarlo",
     (list(srv.egresos), u.effective_message.teclados[-1]), ([], ["suslg:1:2026-11:" + UUID, "susnv:1:2026-11"]))
srv = Servidor(SUBS())
srv.candidatos = {1: CAND}
u = Update()
for d in ("suslg:1:2026-11:" + UUID, "susnv:1:2026-11"):
    correr(S.atender_boton(u, (-100123, KEVIN), d, srv))
caso("9.5 Kevin aprieta ligar / registrar otro: nada llega al servidor", list(srv.llamadas), [])

# 9.4 "Otro monto" y los pesos de una en USD, POR NOTA DE VOZ: la voz entra por
# `_enrutar_y_despachar` (no por `_manejar_texto`).
srv = Servidor(SUBS())
B._post = srv
B.suscripciones = S
al_modelo = []


async def _modelo_falso(update, chat, texto, esperando=""):
    al_modelo.append(texto)


modelo_antes = B._enrutar_y_despachar_mensaje
B._enrutar_y_despachar_mensaje = _modelo_falso
try:
    u = Update()
    correr(S.atender_boton(u, NORMAN, "suspg:2:2026-11", srv))
    correr(B._enrutar_y_despachar(u, NORMAN, "3,950 pesos."))
    caso("9.4 USD: los pesos dichos por voz ('3,950 pesos.') registran el egreso y no van al modelo",
         (list(srv.egresos), list(al_modelo)), ([((2, "2026-11"), 3950.0)], []))
    correr(S.atender_boton(u, NORMAN, "susmt:1:2026-11", srv))
    correr(B._enrutar_y_despachar(u, NORMAN, "480 MXN."))
    caso("9.4 'Otro monto' por voz ('480 MXN.')", srv.egresos[-1], ((1, "2026-11"), 480.0))
    correr(B._enrutar_y_despachar(u, NORMAN, "gaste 300 de gasolina"))
    caso("9.4 CONTROL: sin espera, la voz sigue al modelo", al_modelo, ["gaste 300 de gasolina"])
finally:
    B._enrutar_y_despachar_mensaje = modelo_antes
    B._post = antes
caso("9.4 la voz llama a _enrutar_y_despachar (donde esta el gancho)",
     "await _enrutar_y_despachar(update, chat, texto)" in fuente.split("async def manejar_voz", 1)[1], True)

peores = _datos(S.teclado_candidatos(9999999, "2026-12", [{"id": UUID, "monto_texto": "$500,000.00", "fecha": "31-dic"}] * 3)) \
    + _datos(S.teclado_registrar(9999999, "2026-12", 500000, "$500,000.00", forzar=True))
caso("9.5 con el uuid y la marca 'n', ningun callback_data pasa de 64 bytes", max(len(d.encode("utf-8")) for d in peores) <= 64, True)
caso("9.5 las acciones nuevas estan en ACCIONES (bot_gastos despacha por ahi)", {"suslg", "susnv"} <= set(S.ACCIONES), True)

fallos = [(n_, o, e) for n_, o, e in casos if o != e]
for n_, o, e in casos:
    print(("ok   " if o == e else "FALLA") + "  " + n_ + ("" if o == e else "  -> obtuve %r, esperaba %r" % (o, e)))
if fallos:
    print("RESULTADO: %d de %d casos FALLAN" % (len(fallos), len(casos)))
    sys.exit(1)
print("RESULTADO: los %d casos pasan" % len(casos))
