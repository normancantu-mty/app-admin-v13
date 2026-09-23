# -*- coding: utf-8 -*-
"""FASE 8 — VARIOS HECHOS, VARIAS PROPUESTAS, Y LA MEMORIA CORTA. D73-D80.

─── DE DONDE SALE CADA CASO ────────────────────────────────────────────────────

- D79/D80: el mensaje textual del 2026-09-19 (*"Se acaba de vender una botella
  grande de 599 pesos... y de envio fueron 45 pesos"*). El bot propuso la venta,
  ANUNCIO el gasto sin proponerlo, y al volver a dictarlo salio una venta
  duplicada. Ahora cada hecho sale con su propuesta y su VA.
- D73/D76: *"cuanto me debe aeropuerto"* y cuatro veces *"y la deuda?"*
  (2026-09-21, 07:58): contestaba la cartera entera.
- D74: *"fue venta a concesion"* empezaba una venta de cero.

─── COMO SE MIDE ───────────────────────────────────────────────────────────────

**La salida del modelo NO se escribe a mano: sale de `grabada(clave)`**, o sea
de `bot/grabaciones_enrutador.json`, grabado con el modelo real y con el md5 del
PROMPT (si el PROMPT cambia, esto se pone rojo solo). Lo que corre de verdad es
la tuberia del bot: `manejar_texto` / `manejar_boton` con `BOT_ENSAYO` puesto,
asi que la puerta de ensayo (`decision_de_ensayo`) es la de produccion y cada
`/confirmar` se queda en `B.no_salieron` en vez de escribir. El servidor lo
dobla `_post_de_verdad` con respuestas de la forma real.

Hay DOS vueltas con el modelo doblado a mano y lo dicen en su nombre
("MECANISMO"): prueban la cola del bot, no lo que entiende el modelo.

Corre con:  python bot/probar_hechos.py
"""
import asyncio
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("BOT_LOG", os.path.join(tempfile.gettempdir(), "probar_bot.log"))

import bot_gastos as B  # noqa: E402
import grabar_enrutador as G  # noqa: E402

CHAT = 777000111
casos = []


def caso(nombre, obtenido, esperado, detalle=""):
    casos.append((nombre, obtenido, esperado, detalle))


# ─── Telegram, doblado ───────────────────────────────────────────────────────
class MensajeFalso(object):
    def __init__(self, chat_id, texto=""):
        self.chat = type("Chat", (), {})()
        self.chat.id = chat_id
        self.chat.send_action = self._nada
        self.text = texto
        self.dichos = []

    async def _nada(self, *a, **kw):
        return None

    async def reply_text(self, texto, **kw):
        self.dichos.append(str(texto))

    async def reply_photo(self, **kw):
        self.dichos.append("[foto]")


class UpdateDeTexto(object):
    def __init__(self, texto):
        self.message = MensajeFalso(CHAT, texto)
        self.callback_query = None

    @property
    def effective_message(self):
        return self.message

    @property
    def effective_chat(self):
        return self.message.chat


class Pregunta(object):
    def __init__(self, data):
        self.data = data
        self.message = MensajeFalso(CHAT)

    async def answer(self):
        return None


class UpdateDeBoton(object):
    def __init__(self, data):
        self.callback_query = Pregunta(data)
        self.message = None

    @property
    def effective_message(self):
        return self.callback_query.message

    @property
    def effective_chat(self):
        return self.callback_query.message.chat


# ─── El servidor, doblado con la forma real de sus respuestas ────────────────
class Servidor(object):
    def __init__(self, pendientes=None):
        self.llamadas = []
        self.n = 0
        self.pendientes = pendientes or []

    def _bid(self):
        self.n += 1
        return "b0000000-0000-4000-8000-%012d" % self.n

    def __call__(self, ruta, cuerpo):
        self.llamadas.append((ruta, dict(cuerpo)))
        if ruta == "/api/bot/catalogo":
            return 200, {"ok": True, "productos": [
                {"id": "c1000000-0000-0000-0000-000000000001", "sku": "plata-750ml",
                 "nombre": "Destilado Plata 750ml", "ml_por_unidad": 750}]}
        if ruta == "/api/bot/pendiente":
            return 200, {"ok": True, "pendientes": list(self.pendientes)}
        if ruta == "/api/bot/consulta":
            return 200, {"ok": True, "texto": "CARTERA de " + str(cuerpo.get("filtro"))}
        if ruta.endswith("/proponer"):
            bid = self._bid()
            r = {"ok": True, "borrador_id": bid, "sello": "s" + bid[-4:],
                 "mensaje": "PROPUESTA " + ruta.split("/")[3] + " " + bid[-4:],
                 "cuentas": [], "categorias": ["Logistica_Envios"], "id_deudor": "d1"}
            return 200, r
        return 500, {"error": "ruta no doblada: " + ruta}

    def rutas(self):
        return [r for r, _ in self.llamadas]

    def proponer(self):
        return [(r, c) for r, c in self.llamadas if r.endswith("/proponer")]


SERVIDOR = [None]


def correr(update, manejador):
    asyncio.run(manejador(update, None))


def texto(t, salida=None, enrutar=None):
    """Un mensaje escrito. `salida` es una GRABACION (dict) del modelo real."""
    u = UpdateDeTexto(t)
    original = B.enrutar
    if salida is not None:
        B.enrutar = lambda *a, **k: (True, dict(salida))
    elif enrutar is not None:
        B.enrutar = enrutar
    try:
        correr(u, B.manejar_texto)
    finally:
        B.enrutar = original
    return u.message.dichos


def boton(data):
    u = UpdateDeBoton(data)
    correr(u, B.manejar_boton)
    return u.callback_query.message.dichos


def limpiar(pendientes=None):
    B._olvidar_chat(CHAT)
    for d in (B._esperando_monto, B._esperando_vigencia, B._esperando_correccion,
              B._esperando_codigo, B._esperando_alta, B._ultimo_cliente, B._ultima_cotizacion):
        d.pop(CHAT, None)
    del B.no_salieron[:]
    SERVIDOR[0] = Servidor(pendientes)
    B._post_de_verdad = SERVIDOR[0]


def vivos():
    return [d["borrador_id"] for d in B._pendientes_de(CHAT)]


def confirmados():
    """Los `/confirmar` que la puerta de ensayo NO dejo salir: (ruta, borrador)."""
    return [(r, c.get("borrador_id")) for r, c in B.no_salieron if r.endswith("/confirmar")]


def cancelados():
    return [c.get("borrador_id") for r, c in B.no_salieron if r.endswith("/cancelar")]


B.ENSAYO = True
g = G.grabada

# ════════════════ PRODUCTOR = CONSUMIDOR: lo que ve el modelo al grabar ══════
limpiar()
B._pendientes[CHAT] = {"v1": {"tipo": "venta", "borrador_id": "v1", "sello": "s",
                              "mostrado": ("v1", G.MENSAJE_VENTA, None)}}
caso("D74 - _en_pantalla de una venta == la cadena con que se grabo",
     B._en_pantalla(CHAT), G.VENTA_EN_PANTALLA)
B._pendientes[CHAT]["g1"] = {"borrador_id": "g1", "sello": "s",
                             "mostrado": ("g1", B.AVISO_ENSAYO + "\n" + G.MENSAJE_GASTO, None)}
caso("D74 - dos vivas (venta y gasto, con aviso de ensayo) == la grabada",
     B._en_pantalla(CHAT), G.VENTA_Y_GASTO_EN_PANTALLA)
caso("D74 - CONTROL: el formato de la Fase 7 NO es el que se graba",
     "una propuesta de una venta lista, esperando que digas que va o que no"
     == G.VENTA_EN_PANTALLA, False)

# ════════════════ D80: EL MENSAJE DEL 2026-09-19 ═════════════════════════════
limpiar()
salida = g("d80_mensaje_2026_09_19")
dichos = texto(G.EL_MENSAJE_2026_09_19, salida)
prop = SERVIDOR[0].proponer()
caso("D80 - el mensaje del 2026-09-19: DOS propuestas (venta y gasto)",
     [r for r, _ in prop], ["/api/bot/venta/proponer", "/api/bot/gasto/proponer"],
     str(dichos))
caso("D80 - las dos quedan vivas, cada una con su VA", len(vivos()), 2)
caso("D79 - la primera sale como mensaje NUEVO (el servidor cancela lo viejo)",
     "conservar_pendientes" in prop[0][1], False)
caso("D79 - la segunda CONSERVA la primera", prop[1][1].get("conservar_pendientes"), True)
caso("D80 - el gasto es el de $45, la venta la de $599",
     (prop[1][1]["propuesta"]["monto"], prop[0][1]["propuesta"]["monto"]), (45, 599))
bid_venta, bid_gasto = vivos()
boton("vavt:" + bid_venta)
boton("va:" + bid_gasto)
caso("D80 - las DOS llegan a /confirmar (en ensayo: no salen), cada una con su id",
     confirmados(), [("/api/bot/venta/confirmar", bid_venta),
                     ("/api/bot/gasto/confirmar", bid_gasto)])

# CONTROL NEGATIVO: el mismo mensaje con la lista cortada a UN hecho (lo que el
# enrutador de la Fase 7 le entregaba al bot) propone una sola cosa.
limpiar()
una = dict(salida)
una["hechos"] = una["hechos"][:1]
texto(G.EL_MENSAJE_2026_09_19, una)
caso("D80 - CONTROL: con un solo hecho en la lista, UNA propuesta",
     [r for r, _ in SERVIDOR[0].proponer()], ["/api/bot/venta/proponer"])

# ════════════════ D80: venta + abono ═════════════════════════════════════════
limpiar()
texto("vendi 2 chicas a aeropuerto y me abono 1000", g("d80_venta_y_abono"))
rutas = sorted(r for r, _ in SERVIDOR[0].proponer())
caso("D80 - 'vendi 2 chicas a aeropuerto y me abono 1000': venta Y abono",
     rutas, ["/api/bot/abono/proponer", "/api/bot/venta/proponer"])
cuerpo_abono = [c for r, c in SERVIDOR[0].proponer() if "abono" in r][0]
# El nombre se compara sin mayusculas: la grabacion del 2026-09-22 lo trae en
# minusculas y el servidor lo empata contra la cartera sin distinguirlas.
caso("D80 - el abono es de 1000 y de Aeropuerto",
     (cuerpo_abono["propuesta"]["monto"], str(cuerpo_abono.get("deudor")).lower()), (1000, "aeropuerto"))

# ════════════════ D80: los controles del modelo real ═════════════════════════
limpiar()
texto("vendi una botella de 750", g("d49_un_solo_hecho"))
caso("D80 - CONTROL: un solo hecho -> UNA propuesta",
     [r for r, _ in SERVIDOR[0].proponer()], ["/api/bot/venta/proponer"])
limpiar()
texto("vendi una de 750 a publico, si, una botella de 750 fue la que vendi", g("d80_control_eco"))
caso("D80 - CONTROL: el eco de la venta NO es una segunda venta",
     [r for r, _ in SERVIDOR[0].proponer()], ["/api/bot/venta/proponer"])

# ════════════════ D79: el "va" escrito con 2+ vivas no adivina ═══════════════
limpiar()
texto(G.EL_MENSAJE_2026_09_19, g("d80_mensaje_2026_09_19"))
dichos = texto("va")
caso("D79 - 'va' escrito con DOS vivas: no confirma ninguna", confirmados(), [])
caso("D79 - ...y dice cuales hay",
     any("Tengo 2 propuestas" in d for d in dichos), True, str(dichos))
# (En ensayo un VA no escribe, asi que la confirmada sigue viva: el control
# arranca con UNA sola propuesta.)
limpiar()
texto("vendi una botella de 750", g("d49_un_solo_hecho"))
dichos = texto("va")
caso("D79 - CONTROL: con UNA viva, el 'va' escrito confirma como siempre",
     [r for r, _ in confirmados()], ["/api/bot/venta/confirmar"], str(dichos))

# El "no" escrito con dos vivas: se apagan las dos.
limpiar()
texto(G.EL_MENSAJE_2026_09_19, g("d80_mensaje_2026_09_19"))
dos = vivos()
dichos = texto("no")
caso("D79 - 'no' escrito con DOS vivas las cancela a las dos", sorted(cancelados()), sorted(dos))
caso("D79 - ...y no queda ninguna viva", vivos(), [])

# Un VA de una propuesta que ya NO esta viva no confirma la que este en el foco.
limpiar()
texto("vendi una botella de 750", g("d49_un_solo_hecho"))
viejo = vivos()[0]
texto("vendi una botella de 750", g("d49_un_solo_hecho"))
dichos = boton("vavt:" + viejo)
caso("D79 - el VA de una propuesta reemplazada NO escribe la vigente", confirmados(), [],
     str(dichos))
caso("D79 - CONTROL: el VA de la vigente si llega", (boton("vavt:" + vivos()[0]) is not None
                                                    and [r for r, _ in confirmados()]),
     ["/api/bot/venta/confirmar"])

# ════════════════ D79: incompletos, UNO a la vez y en orden (MECANISMO) ══════
limpiar()
dichos = texto("gaste en gasolina y vendi 2 de 750 a publico", g("d80_gasto_incompleto_y_venta"))
caso("D79 - dos incompletos: pregunta por el PRIMERO y no propone el segundo aun",
     [r for r, _ in SERVIDOR[0].proponer()], [], str(dichos))
caso("D79 - ...y dice que despues sigue con la venta",
     any("sigo con una venta" in d for d in dichos), True, str(dichos))


def contesta_300(*a, **k):
    # MECANISMO: la respuesta "300" completa el gasto a medias que el bot
    # guardo. El modelo aqui esta doblado a mano: se prueba la COLA.
    borrador = a[1] or {}
    return True, {"intencion": "gasto", "confianza": "alta", "campos": {}, "respuesta": "",
                  "hechos": [{"intencion": "gasto", "campos": dict(borrador, monto=300),
                              "faltantes": [], "pregunta": None, "confianza": "alta"}],
                  "hechos_de_mas": 0}


texto("300", enrutar=contesta_300)
caso("D79 - al contestar, sale el gasto Y DESPUES la venta que esperaba (MECANISMO)",
     [r for r, _ in SERVIDOR[0].proponer()],
     ["/api/bot/gasto/proponer", "/api/bot/venta/proponer"])
caso("D79 - ...y las dos quedan vivas", len(vivos()), 2)

# ════════════════ D79: el tope de 5 se dice ══════════════════════════════════
limpiar()
dichos = texto("seis gastos", g("d80_seis_gastos"))
caso("D79 - seis gastos dictados: cinco propuestas (el tope)",
     len(SERVIDOR[0].proponer()), 5)
caso("D79 - ...y el bot DICE el tope (el modelo recorto callado la renta)",
     any("el tope" in d for d in dichos), True, str(dichos[-1:]))

# ════════════════ D74: la correccion se SUMA ═════════════════════════════════
limpiar()
texto("vendi una de 750 a publico", g("d80_control_eco"))
antes = vivos()
peticion_antes = SERVIDOR[0].proponer()[0][1]
texto("fue venta a concesion", g("d74_fue_a_concesion"))
despues = SERVIDOR[0].proponer()[-1][1]
caso("D74 - 'fue venta a concesion' repropone LA MISMA venta, a concesion",
     (despues["propuesta"]["condicion_pago"], despues["productos"]),
     ("CONCESION", peticion_antes["productos"]))
caso("D74 - ...la anterior se apaga y queda UNA viva",
     (cancelados(), len(vivos())), (antes, 1))
caso("D74 - ...y el reproponer conserva (no mata otras)", despues.get("conservar_pendientes"), True)

# Con venta Y gasto en pantalla, "la venta fue a concesion" toca SOLO la venta.
limpiar()
texto(G.EL_MENSAJE_2026_09_19, g("d80_mensaje_2026_09_19"))
bid_venta, bid_gasto = vivos()
texto("la venta fue a concesion", g("d74_dos_en_pantalla_concesion"))
caso("D74 - con dos en pantalla, ajusta la venta y deja vivo el gasto",
     (bid_gasto in vivos(), bid_venta in vivos(), len(vivos())), (True, False, 2))

# Gasto: "eran 50, no 45".
limpiar()
texto(G.EL_MENSAJE_2026_09_19, g("d80_mensaje_2026_09_19"))
texto("eran 50, no 45", g("d74_gasto_eran_50"))
ultimo = SERVIDOR[0].proponer()[-1]
caso("D74 - 'eran 50, no 45' repropone el GASTO con 50 y el mismo concepto",
     (ultimo[0], ultimo[1]["propuesta"]["monto"], ultimo[1]["propuesta"]["descripcion"]),
     # "El mismo concepto" es el que el modelo grabo para el gasto original, no
     # una cadena escrita aqui: cada regrabacion lo redacta a su modo.
     ("/api/bot/gasto/proponer", 50,
      [h for h in g("d80_mensaje_2026_09_19")["hechos"] if h["intencion"] == "gasto"][0]["campos"]["descripcion"]))

# CONTROL: un hecho NUEVO con una venta en pantalla no es ajustar.
limpiar()
texto("vendi una de 750 a publico", g("d80_control_eco"))
texto("vendi otras 2 de 750 a publico", g("d74_control_otra_venta"))
ultima = SERVIDOR[0].proponer()[-1][1]
caso("D74 - CONTROL: 'vendi otras 2' es una venta NUEVA (2 piezas), no un ajuste",
     (ultima["productos"][0]["cantidad"], "conservar_pendientes" in ultima), (2, False))

# ════════════════ D73 + D76: la memoria corta y la cartera de UNO ════════════
limpiar()
texto("cuanto me debe aeropuerto", g("d76_cuanto_me_debe_aeropuerto"))
cuerpo = [c for r, c in SERVIDOR[0].llamadas if r == "/api/bot/consulta"][0]
caso("D76 - 'cuanto me debe aeropuerto' pide la cartera DE aeropuerto",
     (cuerpo["consulta"], cuerpo["filtro"]), ("cartera", "aeropuerto"))
hist = B.historial_para_el_modelo(CHAT)
caso("D73 - el turno queda en el historial con lo que contesto el bot",
     (len(hist), hist[0][1], hist[0][2]), (1, "cuanto me debe aeropuerto", "CARTERA de aeropuerto"))
visto = {}


def espia(*a, **k):
    visto["historial"] = k.get("historial", a[6] if len(a) > 6 else None)
    return True, dict(g("d73_y_la_deuda"))


texto("y la deuda?", enrutar=espia)
caso("D73 - el siguiente mensaje le llega al modelo CON ese historial",
     [t[1] for t in visto["historial"]], ["cuanto me debe aeropuerto"])
cuerpo = [c for r, c in SERVIDOR[0].llamadas if r == "/api/bot/consulta"][-1]
caso("D73 - 'y la deuda?' (modelo real, con historial) -> cartera de Aeropuerto",
     cuerpo["filtro"], "Aeropuerto")
caso("D73 - CONTROL: sin historial, 'y la deuda?' no sabe de quien (filtro null)",
     g("d73_control_sin_historial")["filtro"], None)
limpiar()
texto("quien me debe", g("d76_control_quien_me_debe"))
cuerpo = [c for r, c in SERVIDOR[0].llamadas if r == "/api/bot/consulta"][0]
caso("D76 - CONTROL: 'quien me debe' pide la cartera ENTERA (filtro null)",
     cuerpo["filtro"], None)

# Contaminacion: una venta de $599 en el historial y "vendi una chica".
chica = g("d73_control_vendi_una_chica")
caso("D73 - CONTAMINACION: con $599 en el historial, 'vendi una chica' NO trae 599",
     "599" in str(chica["hechos"]), False, str(chica["hechos"]))
limpiar()
texto("vendi una chica", chica)
caso("D73 - ...y la propuesta que sale no lleva monto",
     SERVIDOR[0].proponer()[0][1]["propuesta"].get("monto"), None)

# Los topes del historial: 15 turnos y 30 minutos.
limpiar()
for i in range(20):
    B._cerrar_turno(CHAT, "m%d" % i, ahora=1000.0 + i)
caso("D73 - el historial guarda los ultimos HISTORIAL_TURNOS (15)",
     [t[1] for t in B.historial_para_el_modelo(CHAT, ahora=1100.0)],
     ["m%d" % i for i in range(5, 20)])
caso("D73 - y olvida lo de hace mas de 30 min",
     B.historial_para_el_modelo(CHAT, ahora=1019.0 + B.HISTORIAL_TTL_S + 1), [])

# ════════════════ D77: rehidratar tras un reinicio ═══════════════════════════
VIVA = {"borrador_id": "e7000000-0000-4000-8000-000000000001", "sello": "abc", "tipo": "venta",
        "creado_en": "2026-09-23T05:00:00+00:00"}
limpiar(pendientes=[VIVA])
import time as _t  # noqa: E402
VIVA["creado_en"] = _t.strftime("%Y-%m-%dT%H:%M:%S+00:00", _t.gmtime(_t.time() - 60))
SERVIDOR[0].pendientes = [VIVA]
boton("vavt:" + VIVA["borrador_id"])
caso("D77 - proceso nuevo: el VA de una propuesta viva en la base la confirma",
     confirmados(), [("/api/bot/venta/confirmar", VIVA["borrador_id"])])
caso("D77 - ...con el sello que devolvio la base",
     [c.get("sello") for r, c in B.no_salieron if r.endswith("/confirmar")], ["abc"])
limpiar(pendientes=[])
dichos = boton("vavt:" + VIVA["borrador_id"])
caso("D77 - CONTROL: sin nada en la base, 'no tengo ninguna venta pendiente'",
     (confirmados(), any("No tengo ninguna venta" in d for d in dichos)), ([], True), str(dichos))

# ════════════════════════════════════════════════════════════════════════════
todo_bien = True
for nombre, obtenido, esperado, detalle in casos:
    bien = obtenido == esperado
    if not bien:
        todo_bien = False
    print("  [%s] %-72s  %s" % ("PASA" if bien else "FALLA", nombre,
                                "" if bien else "obtuve %r, esperaba %r %s"
                                % (obtenido, esperado, detalle)))
print("")
print("RESULTADO:", "los %d casos pasan" % len(casos) if todo_bien
      else "HAY CASOS QUE FALLAN")
sys.exit(0 if todo_bien else 1)
