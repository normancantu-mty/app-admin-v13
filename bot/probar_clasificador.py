# -*- coding: utf-8 -*-
"""2026-11-04: el clasificador entiende cuenta, fecha y categorias, y nada se
escribe sin clic.

Escrito el 2026-11-04 por el Socio (ejecutor del clasificador).

Norman: "a veces si digo desde la cuenta tal no me hace caso y lo toma como una
descripcion... debe ser un agente que clasifique todo lo que se escucha en la
categoria adecuada y proponga las mejores".

    python bot/probar_clasificador.py      (sin red, sin modelo)
"""
import asyncio
import io
import json
import os
import subprocess
import sys
import tempfile
import time

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)
os.environ.setdefault("BOT_LOG", os.path.join(tempfile.gettempdir(), "probar_bot.log"))

import bot_gastos as B  # noqa: E402
import claude_cli  # noqa: E402
import enrutador as E  # noqa: E402
import tope  # noqa: E402

casos = []
UUID_X = "e274064a-e1be-451d-b920-f02b99d29d78"


def caso(nombre, obtenido, esperado):
    casos.append((nombre, obtenido, esperado))


EFECTIVO = {"id": E.ID_EFECTIVO, "nombre": "Efectivo"}
SPIN = {"id": E.ID_SPIN, "nombre": "Cuenta Spin"}
GILBERTO = {"id": E.ID_GILBERTO, "nombre": "Cuenta Gilberto"}
TRANSFER = {"id": E.ID_TRANSFERENCIAS, "nombre": "Transferencias"}
CUENTAS = [EFECTIVO, SPIN, GILBERTO, TRANSFER]
CATS = ["Logistica / Gasolina", "Oficina / Papeleria", "Servicios / Luz"]


# --- 1. el esquema --------------------------------------------------------------
esq = E.esquema_de(CUENTAS, 3)
campos_e = esq["properties"]["campos"]["properties"]
caso("1. enum de cuentas: las vivas y null", campos_e["cuenta_id"]["enum"],
     [c["id"] for c in CUENTAS] + [None])
caso("1. categorias: hasta 3 numeros de la lista",
     (campos_e["categorias_sugeridas"]["maxItems"], campos_e["categorias_sugeridas"]["items"]["enum"]), (3, [1, 2, 3]))
caso("1. los hechos usan los mismos campos",
     esq["properties"]["hechos"]["items"]["properties"]["campos"]["properties"]["cuenta_id"]["enum"][-1], None)
caso("1. sin listas el esquema no ofrece nada", (E.esquema_de(None, 0)["properties"]["campos"]["properties"]
     ["cuenta_id"]["enum"], E.esquema_de(None, 0)["properties"]["campos"]["properties"]["categorias_sugeridas"]["maxItems"]),
     ([None], 0))
linea = subprocess.list2cmdline(claude_cli.con_esquema(
    ["C:/x/npm/claude.CMD", "-p", "--append-system-prompt", claude_cli.SISTEMA],
    E.esquema_de([{"id": "%036d" % i, "nombre": "x"} for i in range(12)], 150)))
caso("1. cabe en el tope de 8,191 de cmd.exe (12 cuentas, 150 categorias)", len(linea) < 7000, True)


# --- 2. casar_cuenta --------------------------------------------------------------
def casa(oida):
    c = E.casar_cuenta(oida, CUENTAS)
    return c and c["id"]


caso("2. nombre", casa("Cuenta Spin"), E.ID_SPIN)
caso("2. alias", casa("la de spin by oxxo"), E.ID_SPIN)
caso("2. Spain es Spin", casa("Spain"), E.ID_SPIN)
caso("2. Whisper: Efectrivo", casa("Efectrivo"), E.ID_EFECTIVO)
caso("2. Whisper: espin", casa("cuenta espin"), E.ID_SPIN)
caso("2. CONTROL Kevin no casa", casa("la cuenta de Kevin"), None)
caso("2. CONTROL la G no se adivina", casa("la G"), None)
caso("2. CONTROL Fresnillo no esta en la lista", casa("cuenta Fresnillo"), None)
caso("2. CONTROL vacio", casa(""), None)


# --- 3. aplicar_catalogos ---------------------------------------------------------
def aplica(campos, intencion="gasto"):
    r = {"intencion": intencion, "campos": campos,
         "hechos": [{"intencion": intencion, "campos": campos}]}
    E.aplicar_catalogos(r, CUENTAS, CATS)
    return r["hechos"][0]["campos"]


c = aplica({"monto": 1, "categorias_sugeridas": [2, 1], "cuenta_id": E.ID_SPIN})
caso("3. numeros a nombres", c["categorias_sugeridas"], ["Oficina / Papeleria", "Logistica / Gasolina"])
caso("3. categoria = la primera (y una sola vez aunque el objeto se repita)", c["categoria"], "Oficina / Papeleria")
caso("3. cuenta de la lista con su nombre", (c["cuenta_id"], c["cuenta_nombre"]), (E.ID_SPIN, "Cuenta Spin"))
c = aplica({"categorias_sugeridas": [0, 9, True, "1", 3, 3]})
caso("3. fuera de rango se tira", c["categorias_sugeridas"], ["Servicios / Luz"])
c = aplica({"cuenta_id": "11111111-1111-1111-1111-111111111111"})
caso("3. cuenta inventada se tira", "cuenta_id" in c, False)
c = aplica({"cuenta_id": None, "cuenta_oida": "Efectrivo"})
caso("3. lo oido se rescata", (c.get("cuenta_id"), "cuenta_oida" in c), (E.ID_EFECTIVO, False))
c = aplica({"cuenta_id": None, "cuenta_oida": "la de Kevin"})
caso("3. lo que no casa se queda oido", (c.get("cuenta_id"), c.get("cuenta_oida")), (None, "la de Kevin"))
c = aplica({"cuenta_id": E.ID_GILBERTO}, "abono")
caso("3. solo_egresos no recibe abonos", (c.get("cuenta_id"), c.get("cuenta_solo_paga")), (None, "Cuenta Gilberto"))
c = aplica({"cuenta_id": E.ID_GILBERTO, "sobre": "abono"}, "ajustar")
caso("3. ... tampoco ajustando", c.get("cuenta_id"), None)
c = aplica({"cuenta_id": E.ID_GILBERTO})
caso("3. CONTROL en un gasto si paga", c.get("cuenta_id"), E.ID_GILBERTO)
caso("3. fecha valida pasa", aplica({"fecha": "2026-11-03"}).get("fecha"), "2026-11-03")
caso("3. fecha sin convertir se tira", "fecha" in aplica({"fecha": "ayer"}), False)
c = aplica({"cuenta_nombre": "X", "cuenta_solo_paga": "Y"})
caso("3. el modelo no escribe las llaves del codigo", ("cuenta_nombre" in c, "cuenta_solo_paga" in c), (False, False))
c = aplica({"categoria": "Mantenimiento / Soldadura", "subcategoria": "Soldadura", "categorias_sugeridas": [1]}, "categoria")
caso("3. la intencion categoria (alta) no se toca", c["categoria"], "Mantenimiento / Soldadura")


# --- 4. el sobre de --output-format json ---------------------------------------------
def con_salida(stdout, rc=0, stderr=""):
    orig = E.subprocess.run, E._claude, E.ESPERA_REINTENTO_S
    vistos = []

    def run(cmd, **k):
        vistos.append(cmd)
        return subprocess.CompletedProcess(cmd, rc, stdout, stderr)

    E.subprocess.run, E._claude, E.ESPERA_REINTENTO_S = run, (lambda *a, **k: ["claude", "-p"]), 0
    try:
        return E.enrutar("gaste 400 de Spin", None, CATS, None, None, None, cuentas=CUENTAS, hoy="2026-11-04"), vistos
    finally:
        E.subprocess.run, E._claude, E.ESPERA_REINTENTO_S = orig


OBJ = {"intencion": "gasto", "confianza": "alta", "entendido": "x", "respuesta": "x",
       "campos": {"monto": 400, "descripcion": "gasolina", "cuenta_id": E.ID_SPIN, "categorias_sugeridas": [1]},
       "hechos": []}
SOBRE = {"type": "result", "is_error": False, "result": "", "structured_output": OBJ, "total_cost_usd": 0.05,
         "usage": {"input_tokens": 2, "output_tokens": 500}}
(ok, r), vistos = con_salida(json.dumps(SOBRE))
caso("4. structured_output se usa y se valida", (ok, r["campos"]["cuenta_id"], r["campos"]["categoria"]),
     (True, E.ID_SPIN, "Logistica / Gasolina"))
caso("4. el comando lleva el esquema", ("--json-schema" in vistos[0], vistos[0][vistos[0].index("--output-format") + 1]),
     (True, "json"))
caso("4. el esquema lleva las cuentas de esta llamada", E.ID_SPIN in vistos[0][vistos[0].index("--json-schema") + 1], True)
(ok, r), _ = con_salida(json.dumps(dict(SOBRE, structured_output=None, result=json.dumps(OBJ))))
caso("4. sin structured_output sale del result", (ok, r.get("intencion") if ok else r), (True, "gasto"))
(ok, r), _ = con_salida(json.dumps(OBJ))
caso("4. objeto pelado tambien (dobles viejos)", ok, True)
(ok, r), vistos = con_salida(json.dumps(dict(SOBRE, is_error=True, result="Not logged in \u00b7 Please run /login",
                                             structured_output=None)), rc=1)
caso("4. login en el sobre: causa y sin reintento", (ok, r.causa, len(vistos)), (False, E.CAUSA_LOGIN, 1))
(ok, r), vistos = con_salida(json.dumps(dict(SOBRE, is_error=True, result="API Error: 500", structured_output=None)))
caso("4. is_error con rc 0 es fallo", (ok, "API Error: 500" in r, len(vistos)), (False, True, 2))
(ok, r), _ = con_salida(json.dumps(dict(SOBRE, is_error=True, result="You've hit your limit \u00b7 resets 3pm",
                                        structured_output=None)), rc=1)
caso("4. tope en el sobre", (ok, isinstance(r, tope.Tope)), (False, True))
(ok, r), _ = con_salida(json.dumps(dict(SOBRE, is_error=True, result="overloaded", structured_output=None)), rc=1)
caso("4. CONTROL la llave usage del sobre no es tope", (ok, isinstance(r, tope.Tope)), (False, False))


# --- 5. el contexto -----------------------------------------------------------------
ctx = E._pedazo_contexto(None, CATS, None, cuentas=CUENTAS, hoy="2026-11-04")
caso("5. hoy con su dia", "HOY ES 2026-11-04 (miercoles)." in ctx, True)
caso("5. cuentas con alias", ("Cuenta Spin (tambien: spin, spin by oxxo, spain, span, espin)" in ctx), True)
caso("5. solo paga se dice", (E.ID_GILBERTO + " = Cuenta Gilberto (tambien: gilberto, gil) SOLO PAGA") in ctx, True)
caso("5. categorias numeradas", "  1 = Logistica / Gasolina" in ctx, True)
caso("5. sin hoy pone la fecha de la PC", "HOY ES " in E._pedazo_contexto(None, None, None), True)


# --- 6. el bot ----------------------------------------------------------------------
class Mensaje(object):
    def __init__(self):
        self.dichos = []

    async def reply_text(self, texto, reply_markup=None, **k):
        self.dichos.append((str(texto), reply_markup))


class Update(object):
    def __init__(self, contesta_a=None):
        self.effective_message = self.message = Mensaje()
        self.message.reply_to_message = contesta_a


class Contestado(object):
    """El mensaje del bot al que Norman contesta: su teclado es el real."""

    def __init__(self, teclado):
        self.reply_markup = teclado


def botones(t):
    return [b.callback_data for fila in (t.inline_keyboard if t else ()) for b in fila]


MSJ_GASTO = ("Esto es lo que voy a escribir. Revisalo:\n\nMONTO:      $400.00\nCATEGORIA:  Logistica / Gasolina\n"
             "CUENTA:     Efectivo (el dinero SALE de aqui)\n\n"
             "(la cuenta no la elige el modelo: sale de tu alta en CEO Admin, y si esta mal la cambias con el boton)\n\n"
             "Contesta VA para escribirlo, o dime que cambio.")
MSJ_ABONO = ('Esto es lo que voy a escribir. Revisalo:\n\nABONO DE:   Aeropuerto (DST)\n\n'
             'El dinero sale de "Aeropuerto" y entra a "Efectivo".\n'
             '(las cuentas no las elige el modelo: salen de tu alta y de la entidad que debe)\n\n'
             'Contesta VA para escribirlo, o dime que cambio.')


class Servidor(object):
    def __init__(self):
        self.pedidos, self.n, self.abono_422, self.en_base = [], 0, False, []

    def __call__(self, ruta, cuerpo):
        self.pedidos.append((ruta, json.loads(json.dumps(cuerpo))))
        self.n += 1
        bid = "00000000-0000-4000-8000-%012d" % self.n
        if ruta.endswith("/pendiente"):
            return 200, {"ok": True, "pendientes": self.en_base}
        if ruta.endswith("gasto/proponer"):
            return 200, {"ok": True, "borrador_id": bid, "sello": "s", "cuentas": CUENTAS,
                         "id_cuenta": cuerpo.get("id_cuenta") or E.ID_EFECTIVO,
                         "categorias": CATS, "mensaje": MSJ_GASTO}
        if ruta.endswith("abono/proponer"):
            if self.abono_422 and cuerpo.get("id_cuenta"):
                return 422, {"error": "La cuenta de la matriz la escoge Norman al aprobar."}
            return 200, {"ok": True, "borrador_id": bid, "sello": "s", "cuentas": [] if self.abono_422 else CUENTAS,
                         "id_cuenta": cuerpo.get("id_cuenta") or E.ID_EFECTIVO, "id_deudor": "d1",
                         "opciones": [], "mensaje": MSJ_ABONO}
        return 200, {"ok": True, "mensaje": "escrito", "filas_escritas": 1}


CHAT = 333
srv = Servidor()
orig_post = B._post
B._post = srv
B._catalogo[:] = list(CATS) if isinstance(B._catalogo, list) else B._catalogo


def en(c):
    return asyncio.run(c)


def fresco():
    B._olvidar_chat(CHAT)
    srv.pedidos[:] = []
    B._modo_propuesta[CHAT] = "nuevo"


def propone_gasto(cuenta=None, sugeridas=None):
    u = Update()
    en(B._proponer_gasto_directo(u, CHAT, {"monto": 400, "categoria": CATS[0], "descripcion": "gasolina"},
                                 cuenta, sugeridas))
    return u


def propuesto():
    """El ultimo proponer (lo que sigue suele ser cancelar el reemplazado)."""
    return [p for p in srv.pedidos if p[0].endswith("/proponer")][-1]


def boton(data):
    u = Update()
    partes = data.split(":", 2)
    en(B._manejar_boton(u, CHAT, None, partes, partes[0]))
    return u


try:
    fresco()
    u = propone_gasto()
    txt, tecl = u.message.dichos[0]
    bid = B._memoria.get(CHAT)["borrador_id"]
    caso("6. sin cuenta dicha: NO hay VA", "va:" + bid in botones(tecl), False)
    caso("6. ... se pregunta con las cuatro", [d for d in botones(tecl) if d.startswith("setcta:")],
         ["setcta:%d:%s" % (i, bid) for i in range(4)])
    caso("6. ... el texto no dice una cuenta que nadie escogio",
         ("cual? Escoge abajo" in txt, "Efectivo (el dinero" in txt, "te pongo el VA" in txt, "Contesta VA" in txt),
         (True, False, True, False))
    u = Update()
    en(B._confirmar(u, CHAT))
    caso("6. un va escrito NO escribe", [r for r, _ in srv.pedidos if "confirmar" in r], [])
    caso("6. ... y vuelve a preguntar", "De cual cuenta" in u.message.dichos[0][0], True)
    u = Update()
    en(B._confirmar(u, CHAT, por_boton=True))
    caso("6. ni con un boton viejo", [r for r, _ in srv.pedidos if "confirmar" in r], [])
    u = boton("setcta:1:" + bid)
    d = B._memoria.get(CHAT)
    caso("6. escoger re-sella contra esa cuenta", propuesto()[1].get("id_cuenta"), E.ID_SPIN)
    caso("6. ... y ya hay VA", ("va:" + d["borrador_id"]) in botones(u.message.dichos[0][1]), True)
    caso("6. ... con su pie", (B.PIE_CUENTA_DICHA in u.message.dichos[0][0], "no la elige" in u.message.dichos[0][0]),
         (True, False))
    u = Update()
    en(B._confirmar(u, CHAT))
    caso("6. ... y el va ya escribe", any("gasto/confirmar" in r for r, _ in srv.pedidos), True)

    fresco()
    u = propone_gasto({"id_cuenta": E.ID_SPIN})
    txt, tecl = u.message.dichos[0]
    caso("6. cuenta dicha: viaja al servidor", srv.pedidos[0][1].get("id_cuenta"), E.ID_SPIN)
    caso("6. ... VA directo, sin preguntar", "va:" + B._memoria.get(CHAT)["borrador_id"] in botones(tecl), True)
    caso("6. ... el servidor la ensena", "CUENTA:" in txt, True)

    fresco()
    u = propone_gasto({"oida": "la de Kevin"})
    caso("6. oida sin casar: se dice cual", 'No encontre "la de Kevin"' in u.message.dichos[0][0], True)

    fresco()
    B._cuentas_viejas = srv
    r0 = Servidor.__call__
    Servidor.__call__ = lambda s, ruta, cuerpo: (lambda e, r: (e, dict(r, cuentas=[EFECTIVO])) if "gasto/proponer" in ruta else (e, r))(*r0(s, ruta, cuerpo))
    u = propone_gasto()
    Servidor.__call__ = r0
    caso("6. con una sola cuenta no se pregunta", "va:" + B._memoria.get(CHAT)["borrador_id"] in botones(u.message.dichos[0][1]), True)

    fresco()
    u = propone_gasto({"id_cuenta": E.ID_SPIN}, [CATS[0], CATS[1], CATS[2]])
    bid = B._memoria.get(CHAT)["borrador_id"]
    tec = botones(u.message.dichos[0][1])
    caso("6. sugeridas: botones de las otras dos", [x for x in tec if x.startswith("setsug:")],
         ["setsug:1:" + bid, "setsug:2:" + bid])
    caso("6. ... y Otra sigue", "cat:" + bid in tec, True)
    u = boton("setsug:2:" + bid)
    d = B._memoria.get(CHAT)
    caso("6. escoger una re-sella con ella", propuesto()[1]["propuesta"]["categoria"], CATS[2])
    caso("6. ... conserva la cuenta dicha", propuesto()[1].get("id_cuenta"), E.ID_SPIN)
    caso("6. ... y las otras sugeridas", [x.split(":")[1] for x in botones(u.message.dichos[0][1]) if x.startswith("setsug:")],
         ["0", "1"])

    fresco()
    propone_gasto(None, [CATS[0], CATS[1]])
    bid = B._memoria.get(CHAT)["borrador_id"]
    u = boton("setsug:1:" + bid)
    caso("6. cambiar categoria no se salta la pregunta de cuenta", B._memoria.get(CHAT)["cuenta_pendiente"], True)
    caso("6. ... sigue sin VA", any(x.startswith("va:") for x in botones(u.message.dichos[0][1])), False)

    fresco()
    propone_gasto()
    primero = B._memoria.get(CHAT)["borrador_id"]
    B._modo_propuesta[CHAT] = "agrega"
    B._soltar_foco(CHAT)
    propone_gasto()
    segundo = B._memoria.get(CHAT)["borrador_id"]
    boton("setcta:1:" + primero)
    caso("6. dos gastos: el boton re-sella el suyo, no el foco",
         (B._memoria.get(CHAT).get("id_cuenta"), segundo in dict.get(B._pendientes, CHAT, {})), (E.ID_SPIN, True))
    u = boton("setcta:1:" + primero)
    caso("6. boton de una propuesta caida: no hace nada", u.message.dichos[0][0], B.YA_NO_ACTIVA)

    # abono
    fresco()
    u = Update()
    en(B._proponer_abono(u, CHAT, {"monto": 5000}, nombre="Aeropuerto"))
    txt, tecl = u.message.dichos[0]
    d = B._memoria.get(CHAT)
    caso("7. abono sin cuenta: sin VA y sin Gilberto",
         (any(x.startswith("vaab:") for x in botones(tecl)), [c["nombre"] for c in d["cuentas"]]),
         (False, ["Efectivo", "Cuenta Spin", "Transferencias"]))
    caso("7. ... el texto pregunta", ("entra a: cual?" in txt, "no las elige" in txt), (True, False))
    boton("setcta:1:" + d["borrador_id"])
    caso("7. setcta va a abono/proponer, no a gasto", propuesto()[0], "/api/bot/abono/proponer")
    caso("7. ... con la cuenta y el deudor", (propuesto()[1].get("id_cuenta"), propuesto()[1].get("id_deudor")),
         (E.ID_SPIN if d["cuentas"][1]["id"] == E.ID_SPIN else None, "d1"))

    fresco()
    u = Update()
    en(B._proponer_abono(u, CHAT, {"monto": 5000}, nombre="Aeropuerto", cuenta={"id_cuenta": E.ID_EFECTIVO}))
    d = B._memoria.get(CHAT)
    caso("7. abono con cuenta dicha: VA directo y Cambiar cuenta",
         (("vaab:" + d["borrador_id"]) in botones(u.message.dichos[0][1]), ("cta:" + d["borrador_id"]) in botones(u.message.dichos[0][1])),
         (True, True))
    caso("7. ... con su pie", B.PIE_CUENTA_DICHA in u.message.dichos[0][0], True)

    fresco()
    srv.abono_422 = True
    u = Update()
    en(B._proponer_abono(u, CHAT, {"monto": 5000}, nombre="Aeropuerto", cuenta={"id_cuenta": E.ID_SPIN}))
    srv.abono_422 = False
    caso("7. DST: el 422 re-propone sin cuenta", [p[1].get("id_cuenta") for p in srv.pedidos], [E.ID_SPIN, None])
    caso("7. ... y queda con VA (sin cuentas no se pregunta)",
         any(x.startswith("vaab:") for x in botones(u.message.dichos[0][1])), True)

    # --- 10. El bug del 2026-11-04: borrador 60e66116 y abono e274064a -----------------
    def mensaje_nuevo():
        B._modo_propuesta[CHAT] = "nuevo"
        B._soltar_foco(CHAT)

    def confirmados():
        return [(r, c.get("borrador_id")) for r, c in srv.pedidos if r.endswith("/confirmar")]

    def dos_vivas():
        fresco()
        u = propone_gasto({"id_cuenta": E.ID_SPIN})
        gasto = B._memoria.get(CHAT)["borrador_id"]
        mensaje_nuevo()
        v = Update()
        en(B._proponer_abono(v, CHAT, {"monto": 5000, "metodo_pago": "efectivo"}, nombre="Aeropuerto",
                             cuenta={"id_cuenta": E.ID_EFECTIVO}))
        return gasto, B._memoria.get(CHAT)["borrador_id"], u.message.dichos[0][1], v.message.dichos[0][1]

    gasto, abono, tecl_gasto, tecl_abono = dos_vivas()
    B._modo_propuesta[CHAT] = "nuevo"
    caso("10. mensaje nuevo: la bandera sale siempre",
         B._con_conservar("/api/bot/abono/proponer", {"telegram_id": CHAT}).get("conservar_pendientes"), True)
    caso("10. CONTROL otras rutas no la llevan", "conservar_pendientes" in B._con_conservar("/api/bot/cancelar", {}), False)
    caso("10. el abono NO cancela el gasto", ([r for r, _ in srv.pedidos if "cancelar" in r],
         sorted(B._pendientes[CHAT])), ([], sorted([gasto, abono])))
    u = boton("cta:" + gasto)
    caso("10. Cambiar cuenta del gasto vivo es del gasto, no del foco",
         (u.message.dichos[0][0], [x for x in botones(u.message.dichos[0][1]) if x.endswith(gasto)][:1]),
         ("Contra cual?", ["setcta:0:" + gasto]))
    boton("va:" + gasto)
    caso("10. cada una con su VA: el del gasto escribe el gasto", confirmados(), [("/api/bot/gasto/confirmar", gasto)])
    boton("vaab:" + abono)
    caso("10. ... y el del abono, el abono", confirmados()[-1:], [("/api/bot/abono/confirmar", abono)])

    # El caso exacto de Norman: gasto caido, foco = abono, toca "Cambiar cuenta" del viejo.
    gasto, abono, _t1, _t2 = dos_vivas()
    B._pendientes[CHAT].pop(gasto)
    B._memoria.get(CHAT).pop("cuentas", None)
    antes = len(srv.pedidos)
    u = boton("cta:" + gasto)
    caso("10. CASO EXACTO: el cta caido dice que ya no esta activa", u.message.dichos[0][0], B.YA_NO_ACTIVA)
    caso("10. ... y nunca 'Solo tienes una cuenta'", "una cuenta" in u.message.dichos[0][0], False)
    caso("10. ... no llega al servidor ni toca el foco",
         (len(srv.pedidos) - antes, B._memoria.get(CHAT)["borrador_id"]), (0, abono))
    for accion in ("cat", "monto", "montoab", "deu", "comp", "cod", "cli", "vig"):
        u = boton(accion + ":" + gasto)
        caso("10. todo boton valida: " + accion, u.message.dichos[0][0], B.YA_NO_ACTIVA)
    for data in ("setcta:0:", "setsug:0:", "setcat:0:"):
        caso("10. todo boton valida: " + data, boton(data + gasto).message.dichos[0][0], B.YA_NO_ACTIVA)
    u = boton("vaab:" + gasto)
    caso("10. VA de una caida no escribe la vigente", (u.message.dichos[0][0], confirmados()), (B.YA_NO_ACTIVA, []))
    u = boton("cta:" + abono)
    caso("10. sin lista de cuentas no inventa 'una'",
         ("reinicio" in u.message.dichos[0][0], "una cuenta" in u.message.dichos[0][0]), (True, False))

    fresco()
    propone_gasto({"id_cuenta": E.ID_SPIN})
    bid = B._memoria.get(CHAT)["borrador_id"]
    u = boton("cat:" + bid)
    caso("10. la lista de categorias sabe de quien es", botones(u.message.dichos[0][1])[0], "setcat:0:" + bid)
    boton("setcat:1:" + bid)
    caso("10. ... y sigue funcionando", propuesto()[1]["propuesta"]["categoria"], CATS[1])

    # El "va" escrito
    gasto, abono, tecl_gasto, tecl_abono = dos_vivas()
    u = Update()
    en(B._manejar_texto(u, CHAT, "va"))
    caso("11. va sin reply con dos: no escribe", confirmados(), [])
    caso("11. ... pregunta cual, con un boton por propuesta",
         (u.message.dichos[0][0].startswith("Tengo 2 propuestas"), botones(u.message.dichos[0][1])),
         (True, ["va:" + gasto, "va:" + abono]))
    u = Update(Contestado(tecl_gasto))
    en(B._manejar_texto(u, CHAT, "va"))
    caso("11. va contestando a la propuesta: escribe ESA", confirmados(), [("/api/bot/gasto/confirmar", gasto)])

    gasto, abono, tecl_gasto, tecl_abono = dos_vivas()
    B._pendientes[CHAT].pop(gasto)
    u = Update(Contestado(tecl_gasto))
    en(B._manejar_texto(u, CHAT, "va"))
    caso("11. va a una caida, con otra viva: no se lleva la otra", (u.message.dichos[0][0], confirmados()),
         (B.YA_NO_ACTIVA, []))

    gasto, abono, tecl_gasto, tecl_abono = dos_vivas()
    u = Update(Contestado(tecl_abono))
    en(B._manejar_texto(u, CHAT, "no"))
    caso("11. no contestando: apaga esa sola", [c.get("borrador_id") for r, c in srv.pedidos if "cancelar" in r], [abono])
    caso("11. ... y la otra sigue viva", sorted(B._pendientes[CHAT]), [gasto])

    dos_vivas()
    u = Update()
    en(B._manejar_texto(u, CHAT, "no"))
    caso("11. CONTROL no sin reply con dos: las dos (D79)", (len([r for r, _ in srv.pedidos if "cancelar" in r]),
         B._pendientes.get(CHAT, {})), (2, {}))

    teclado_apr = B.InlineKeyboardMarkup([[B.InlineKeyboardButton("Aprobar", callback_data="apr:" + UUID_X)]])
    caso("11. un mensaje de Aprobar no es una propuesta", B._borrador_del_reply(Update(Contestado(teclado_apr))), "")
    caso("11. sin teclado no hay id", B._borrador_del_reply(Update(Contestado(None))), "")

    # El metodo
    fresco()
    u = Update()
    en(B._proponer_abono(u, CHAT, B._propuesta_de_abono({"monto": 5000, "metodo_pago": "efectivo"}), nombre="Aeropuerto"))
    caso("12. el metodo viaja al servidor", propuesto()[1]["propuesta"]["metodo_pago"], "efectivo")
    boton("setcta:0:" + B._memoria.get(CHAT)["borrador_id"])
    caso("12. ... y sobrevive a cambiar la cuenta", propuesto()[1]["propuesta"]["metodo_pago"], "efectivo")

    # El reinicio con el abono pendiente: vuelve de la base y su VA escribe ESE.
    fresco()
    B._modo_propuesta.pop(CHAT, None)
    srv.en_base = [{"borrador_id": UUID_X, "sello": "s", "tipo": "abono", "creado_en": time.strftime("%Y-%m-%dT%H:%M:%S")}]
    B._rehidratar(CHAT)
    srv.en_base = []
    boton("vaab:" + UUID_X)
    caso("13. reinicio: el VA del abono pendiente lo escribe", confirmados(), [("/api/bot/abono/confirmar", UUID_X)])

    # lectura de cuentas
    llamadas = []
    B._post = lambda r, c: (llamadas.append((r, c)), (200, {"ok": True, "cuentas": CUENTAS}))[1]
    B._cuentas_leidas.clear()
    a = B._cuentas_vivas(CHAT)
    b = B._cuentas_vivas(CHAT)
    caso("8. lee una vez por TTL", (len(llamadas), [c["nombre"] for c in a] == [c["nombre"] for c in CUENTAS], a == b), (1, True, True))
    caso("8. ... por la ruta de lectura y sin cancelar pendientes",
         (llamadas[0][0], llamadas[0][1]["conservar_pendientes"]), (B.RUTA_LEER_CUENTAS, True))
    B._post = lambda r, c: (0, {"error": "x"})
    B._cuentas_leidas.clear()
    caso("8. si falla, lista vacia y no se cae", B._cuentas_vivas(CHAT), [])
finally:
    B._post = orig_post
    B._olvidar_chat(CHAT)

cabeceras = {}


class Respuesta(object):
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return b'{"ok": true}'


orig_open = B.urllib.request.urlopen
B.urllib.request.urlopen = lambda pet, timeout=None: (cabeceras.update(dict(pet.header_items())), Respuesta())[1]
try:
    B._post_de_verdad(B.RUTA_LEER_CUENTAS, {})
    caso("8. la lectura sale SIEMPRE en ensayo", cabeceras.get("X-bot-ensayo"), "1")
    cabeceras.clear()
    B._post_de_verdad("/api/bot/gasto/proponer", {})
    caso("8. CONTROL un proponer de verdad no", "X-bot-ensayo" in cabeceras, B.ENSAYO)
finally:
    B.urllib.request.urlopen = orig_open


# --- 9. el callback y los textos del servidor ----------------------------------------
UUID = "0c1b3f2a-9d44-4e7b-8a10-6f5c2d9e7b31"
datos = botones(B._teclado_gasto({"borrador_id": UUID, "cuentas": CUENTAS * 3, "cuenta_pendiente": True,
                                  "sugeridas": CATS + ["x"], "propuesta": {}}))
caso("9. ningun callback pasa de 64 bytes", max(len(x.encode("utf-8")) for x in datos) <= 64, True)
RAIZ = os.path.dirname(AQUI)
gastos = io.open(os.path.join(RAIZ, "lib", "bot-gastos.ts"), encoding="utf-8").read()
abonos = io.open(os.path.join(RAIZ, "lib", "bot-abonos.ts"), encoding="utf-8").read()
caso("9. el pie de gasto sigue igual en el servidor", "(la cuenta no la elige el modelo: sale de tu alta" in gastos, True)
caso("9. la linea CUENTA tambien", "`CUENTA:     ${contexto.nombreCuenta}" in gastos, True)
caso("9. el pie de abono tambien", "(las cuentas no las elige el modelo: salen de tu alta" in abonos, True)
caso('9. y "entra a"', 'y entra a "${contexto.nombreCuentaDestino}".' in abonos, True)
caso("9. y el cierre", (B._CIERRE in gastos, B._CIERRE in abonos), (True, True))

fallos = [(n, o, e) for n, o, e in casos if o != e]
for n, o, e in casos:
    print(("ok   " if o == e else "FALLA") + "  " + n + ("" if o == e else "  -> obtuve %r, esperaba %r" % (o, e)))
if fallos:
    print("RESULTADO: %d de %d casos FALLAN" % (len(fallos), len(casos)))
    sys.exit(1)
print("RESULTADO: los %d casos pasan" % len(casos))
