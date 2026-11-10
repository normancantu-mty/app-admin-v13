# -*- coding: utf-8 -*-
"""Varias propuestas vivas: cada una se trata de forma independiente.

Escrito el 2026-11-04 por el Socio (ejecutor de arreglos). Es el arnes de la auditoria
de ese dia convertido en prueba: Norman pidio "que aguante varios, que los trate de
forma independiente", y la escritura se guiaba por el foco y por un modo global.

Lo que hace que esta prueba muerda:
- entra por `_despachar_hechos`, `_manejar_texto` y `_manejar_boton`, no por la funcion
  de proponer;
- los botones salen del teclado que el bot mando, no se escriben a mano;
- el doble del servidor modela `bot_borradores`: lo que no esta PENDIENTE contesta 409,
  y lo escrito queda en `libro`. **El veredicto de cada caso es que se escribio.**
- el doble entra debajo de `_post` (en `_post_de_verdad`) y, como las rutas reales, una
  `proponer` sin `conservar_pendientes` cancela todo lo pendiente (lib/bot-servidor.ts).

    python bot/probar_independientes.py      (sin red, sin modelo)
"""
import asyncio
import datetime as dt
import json
import os
import sys
import tempfile
import time

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)
os.environ.setdefault("BOT_LOG", os.path.join(tempfile.gettempdir(), "probar_bot.log"))

import bot_gastos as B  # noqa: E402
import correr_pruebas as CP  # noqa: E402
import enrutador as E  # noqa: E402

casos = []


def caso(nombre, obtenido, esperado):
    casos.append((nombre, json.loads(json.dumps(obtenido)), json.loads(json.dumps(esperado))))


CUENTAS = [{"id": E.ID_EFECTIVO, "nombre": "Efectivo"}, {"id": E.ID_SPIN, "nombre": "Cuenta Spin"},
           {"id": E.ID_GILBERTO, "nombre": "Cuenta Gilberto"},
           {"id": E.ID_TRANSFERENCIAS, "nombre": "Transferencias"}]
NOMBRE = {c["id"]: c["nombre"] for c in CUENTAS}
CATS = ["Logistica / Gasolina", "Oficina / Papeleria", "Servicios / Luz"]
OPCIONES = [{"id_entidad": "deu-%d" % i, "nombre": "Deudor%d" % i, "rol": "DST", "deuda": 100} for i in range(5)]
MSJ_G = ("Revisalo:\n\nMONTO:      $%s\nCUENTA:     %s (el dinero SALE de aqui)\n\n"
         "(la cuenta no la elige el modelo: sale de tu alta en CEO Admin, y si esta mal la cambias con el boton)\n\n"
         "Contesta VA para escribirlo, o dime que cambio.")
MSJ_A = ('ABONO DE: %s MONTO %s\n\nEl dinero sale de "X" y entra a "%s".\n'
         "(las cuentas no las elige el modelo: salen de tu alta y de la entidad que debe)\n\n"
         "Contesta VA para escribirlo, o dime que cambio.")


class Servidor(object):
    def __init__(self):
        self.n, self.borradores, self.pedidos, self.libro = 0, {}, [], []
        self.rechaza_monto = None
        self.guarda_contexto = True
        self.error_abono = None
        self.alias = {}

    def nuevo(self, tipo, contexto=None, **datos):
        self.n += 1
        bid = "00000000-0000-4000-8000-%012d" % self.n
        self.borradores[bid] = dict(datos, tipo=tipo, estado="PENDIENTE",
                                    contexto=contexto if self.guarda_contexto else None)
        return bid

    def __call__(self, ruta, c):
        self.pedidos.append((ruta, json.loads(json.dumps(c))))
        if ruta.split("?")[0].endswith("/proponer") and c.get("conservar_pendientes") is not True:
            for v in self.borradores.values():
                if v["estado"] == "PENDIENTE":
                    v["estado"] = "CANCELADO"
        if ruta.endswith("/pendiente"):
            hora = time.strftime("%Y-%m-%dT%H:%M:%S")
            return 200, {"ok": True, "pendientes": [
                dict({"borrador_id": k, "sello": "s", "tipo": v["tipo"], "creado_en": hora},
                     **({"contexto": v["contexto"]} if v["contexto"] else {}))
                for k, v in self.borradores.items() if v["estado"] == "PENDIENTE"]}
        if "leer=cuentas" in ruta:
            return 200, {"ok": True, "cuentas": CUENTAS}
        if ruta.endswith("/catalogo"):
            return 200, {"ok": True, "productos": []}
        if ruta.endswith("gasto/proponer"):
            p = c["propuesta"]
            if self.rechaza_monto == p.get("monto"):
                return 422, {"error": "no"}
            k = c.get("id_cuenta") or E.ID_EFECTIVO
            bid = self.nuevo("gasto", dict(c.get("contexto_bot") or {}, cuentas=CUENTAS, id_cuenta=k),
                             monto=p.get("monto"), desc=p.get("descripcion"), cuenta=NOMBRE[k])
            return 200, {"ok": True, "borrador_id": bid, "sello": "s", "cuentas": CUENTAS, "id_cuenta": k,
                         "categorias": CATS, "mensaje": MSJ_G % (p.get("monto"), NOMBRE[k])}
        if ruta.endswith("abono/proponer"):
            if self.error_abono and c.get("id_cuenta"):
                return 422, {"error": self.error_abono}
            d = c.get("id_deudor") or self.alias.get(c.get("deudor"), c.get("deudor"))
            if c.get("deudor") == "Jose":
                return 200, {"ok": False, "hay_que_elegir": True, "mensaje": "Cual?", "opciones": OPCIONES[3:5]}
            if not d:
                return 200, {"ok": False, "hay_que_elegir": True, "mensaje": "Quien te pago?", "opciones": OPCIONES}
            k = c.get("id_cuenta") or E.ID_EFECTIVO
            p = c["propuesta"]
            bid = self.nuevo("abono", dict(c.get("contexto_bot") or {}, cuentas=CUENTAS, id_cuenta=k, id_deudor=d,
                                           nombre_deudor=d), monto=p.get("monto"), deudor=d, cuenta=NOMBRE[k])
            return 200, {"ok": True, "borrador_id": bid, "sello": "s", "cuentas": CUENTAS, "id_cuenta": k,
                         "id_deudor": d, "nombre_deudor": d, "opciones": OPCIONES,
                         "mensaje": MSJ_A % (d, p.get("monto"), NOMBRE[k])}
        if ruta.endswith("venta/proponer"):
            k = c.get("id_cuenta") or E.ID_EFECTIVO
            return 200, {"ok": True, "borrador_id": self.nuevo("venta", monto=999, cuenta=NOMBRE[k]), "sello": "s",
                         "cuentas": CUENTAS, "id_cuenta": k, "opciones": [], "mensaje": "VENTA a " + NOMBRE[k]}
        if ruta.endswith("categoria/proponer"):
            return 200, {"ok": True, "borrador_id": self.nuevo("alta_categoria"), "sello": "s", "mensaje": "cat"}
        if ruta.endswith("entrega/proponer"):
            return 200, {"ok": True, "borrador_id": self.nuevo("entrega_efectivo", monto=c.get("monto")),
                         "sello": "s", "mensaje": "entrega"}
        if ruta.endswith("anular/proponer"):
            return 200, {"ok": True, "hay_que_elegir": True, "mensaje": "Cual?", "opciones": [
                {"tabla": "finanzas", "id": "m1", "etiqueta": "mov 1", "detalle": "x"}]}
        if ruta.endswith("convertir/proponer"):
            return 200, {"ok": True, "hay_que_elegir": True, "mensaje": "Cual?", "opciones": [
                {"id": "c1", "etiqueta": "COT-1", "detalle": "x", "estado": "VIGENTE"}]}
        if ruta.endswith("/cancelar"):
            v = self.borradores.get(c.get("borrador_id"))
            if v:
                v["estado"] = "CANCELADO"
            return 200, {"ok": True}
        if ruta.endswith("/confirmar"):
            v = self.borradores.get(c.get("borrador_id"))
            if not v or v["estado"] != "PENDIENTE":
                return 409, {"error": "ya no pendiente"}
            v["estado"] = "CONFIRMADO"
            self.libro.append((v.get("monto"), v.get("cuenta"), v.get("deudor")))
            return 200, {"ok": True, "filas_escritas": 1, "mensaje": "Listo."}
        return 200, {"ok": True}


class Chat(object):
    async def send_action(self, *a):
        return None


class Mensaje(object):
    siguiente = 1000

    def __init__(self, contesta_a=None, del_bot=False, teclado=None):
        Mensaje.siguiente += 1
        self.message_id = Mensaje.siguiente
        self.dichos, self.reply_to_message, self.chat, self.text = [], contesta_a, Chat(), ""
        self.reply_markup = teclado
        self.from_user = type("U", (), {"is_bot": del_bot})()

    async def reply_text(self, texto, reply_markup=None, **k):
        enviado = Mensaje(del_bot=True, teclado=reply_markup)
        self.dichos.append((str(texto), reply_markup, enviado))
        return enviado


class Update(object):
    def __init__(self, contesta_a=None):
        self.effective_message = self.message = Mensaje(contesta_a)


CHAT = 777
srv = Servidor()
orig_post = B._post_de_verdad
clave_real = B._clave_de
run = asyncio.run


def nuevo():
    global srv
    srv = Servidor()
    B._post_de_verdad = srv
    B._olvidar_chat(CHAT)
    B._catalogo[:] = list(CATS)
    B._cuentas_leidas.clear()
    B._esperando_monto.pop(CHAT, None)


def reinicio():
    """Se va la RAM del proceso; la base se queda."""
    B._olvidar_chat(CHAT)
    B._esperando_monto.pop(CHAT, None)
    B._cuentas_leidas.clear()
    B._rehidratado.discard(CHAT)


def ruta_de(intencion, campos, pregunta=None):
    hecho = {"intencion": intencion, "campos": campos, "faltantes": [], "pregunta": pregunta, "confianza": "alta"}
    return {"intencion": intencion, "campos": campos, "hechos": [hecho], "confianza": "alta",
            "entendido": "x", "respuesta": ""}


def gasto(monto=400, desc="gasolina", cuenta=None, **extra):
    c = dict({"monto": monto, "descripcion": desc}, **extra)
    if cuenta:
        c["cuenta_id"] = cuenta
    return ruta_de("gasto", c)


def abono(monto=5000, deudor="Delirio", cuenta=None):
    c = {"monto": monto, "deudor": deudor}
    if cuenta:
        c["cuenta_id"] = cuenta
    return ruta_de("abono", c)


def ajuste(**campos):
    return dict(ruta_de("ajustar", campos), hechos=[])


def dicta(ruta, contesta_a=None):
    u = Update(contesta_a)
    run(B._despachar_hechos(u, CHAT, ruta, B._hechos_de(ruta)))
    return u


def texto(t, contesta_a=None):
    u = Update(contesta_a)
    u.message.text = t
    B._rehidratar(CHAT)
    run(B._manejar_texto(u, CHAT, t))
    return u


def boton(data):
    u = Update()
    B._rehidratar(CHAT)
    partes = data.split(":", 2)
    run(B._manejar_boton(u, CHAT, None, partes, partes[0]))
    return u


def teclado(u, i=-1):
    t = u.message.dichos[i][1]
    return [b.callback_data for fila in (t.inline_keyboard if t else ()) for b in fila]


def rotulos(u, i=-1):
    return [b.text for fila in u.message.dichos[i][1].inline_keyboard for b in fila]


def ultimo(u):
    return u.message.dichos[-1][0]


def enviado(u, i=-1):
    """El mensaje del bot, tal como Norman lo tiene en pantalla."""
    return u.message.dichos[i][2]


def foco():
    return B._memoria.get(CHAT)["borrador_id"]


def vivos():
    return sorted((v.get("monto"), v.get("desc") or v.get("deudor"), v.get("cuenta"))
                  for v in srv.borradores.values() if v["estado"] == "PENDIENTE")


def cual(accion, u):
    return next(x for x in teclado(u) if x.startswith(accion + ":"))


SPIN, EFECTIVO = E.ID_SPIN, E.ID_EFECTIVO

try:
    # --- S1: la cuenta tras un reinicio ------------------------------------------
    nuevo()
    u = dicta(gasto())
    caso("S1 sin cuenta dicha no hay VA", any(x.startswith("va:") for x in teclado(u)), False)
    reinicio()
    v = texto("va")
    caso("S1 va tras reinicio: no escribe la default", srv.libro, [])
    caso("S1 ... y pregunta", "De cual cuenta" in ultimo(v), True)

    nuevo()
    u = dicta(gasto())
    pantalla = enviado(u)
    reinicio()
    v = texto("va", pantalla)
    caso("S1b va contestando al mensaje de la pregunta: no escribe", (srv.libro, "De cual cuenta" in ultimo(v)), ([], True))

    nuevo()
    dicta(abono())
    reinicio()
    v = texto("va")
    caso("S1c abono sin cuenta tras reinicio: no escribe", (srv.libro, "De cual cuenta" in ultimo(v)), ([], True))

    nuevo()
    dicta(gasto(400, "gasolina"))
    dicta(gasto(900, "papel"))
    reinicio()
    v = texto("va")
    caso("S1d dos tras reinicio: rotulos con monto y concepto", rotulos(v), ["VA: un gasto $400 gasolina", "VA: un gasto $900 papel"])
    w = boton(teclado(v)[0])
    caso("S1d ... el clic pregunta la cuenta, no escribe", (srv.libro, "De cual cuenta" in ultimo(w)), ([], True))

    nuevo()
    u = dicta(gasto())
    spin = [x for x in teclado(u) if x.startswith("setcta")][1]
    reinicio()
    boton(spin)
    n = foco()
    caso("S1e el boton de cuenta del teclado original sirve tras el reinicio", vivos(), [[400, "gasolina", "Cuenta Spin"]])
    boton("va:" + n)
    caso("S1e ... y escribe esa", srv.libro, [[400, "Cuenta Spin", None]])

    nuevo()
    dicta(gasto())
    v = texto("va")
    caso("S1f CONTROL sin reinicio tampoco", (srv.libro, "De cual cuenta" in ultimo(v)), ([], True))

    nuevo()
    dicta(gasto(400, "gasolina", SPIN))
    reinicio()
    texto("va")
    caso("S1g la cuenta dicha sobrevive al reinicio", srv.libro, [[400, "Cuenta Spin", None]])

    nuevo()
    dicta(abono(5000, "Delirio", SPIN))
    reinicio()
    texto("va")
    caso("S1g abono: la cuenta dicha sobrevive", srv.libro, [[5000, "Cuenta Spin", "Delirio"]])

    nuevo()
    srv.guarda_contexto = False
    u = dicta(gasto())
    spin = [x for x in teclado(u) if x.startswith("setcta")][1]
    reinicio()
    v = texto("va")
    caso("S1h borrador viejo sin contexto: se pregunta y no escribe", (srv.libro, "No escribi nada" in ultimo(v)), ([], True))
    w = boton(spin)
    caso("S1h ... su boton de cuenta no adivina", (srv.libro, len(vivos()), "otra vez" in ultimo(w)), ([], 1, True))

    # --- S2: la espera lleva su borrador -------------------------------------------
    nuevo()
    dicta(gasto(400, "A", SPIN))
    a = foco()
    dicta(gasto(900, "B", SPIN))
    b = foco()
    boton("monto:" + a)
    boton("cat:" + b)
    texto("150")
    caso("S2 Cambiar monto de A, foco en B: el numero cae en A", vivos(), [[150.0, "A", "Cuenta Spin"], [900, "B", "Cuenta Spin"]])

    nuevo()
    dicta(abono(5000, "Delirio", SPIN))
    a = foco()
    boton("montoab:" + a)
    dicta(gasto(900, "B", SPIN))
    texto("150")
    caso("S2b montoab de A, dictado B: el numero cae en A", vivos(), [[150.0, "Delirio", "Cuenta Spin"], [900, "B", "Cuenta Spin"]])

    nuevo()
    dicta(gasto(400, "A", SPIN))
    a = foco()
    dicta(gasto(900, "B", SPIN))
    boton("monto:" + a)
    boton("no:" + a)
    v = texto("150")
    caso("S2c A se cancelo esperando su monto: B no se toca", vivos(), [[900, "B", "Cuenta Spin"]])

    # --- S3: cambiar de cuenta reemplaza a su borrador ------------------------------
    nuevo()
    dicta(gasto(400, "A", EFECTIVO))
    a = foco()
    r = gasto(None, "algo")
    r["hechos"][0]["pregunta"] = "Cuanto?"
    r["hechos"][0]["faltantes"] = ["monto"]
    dicta(r)
    caso("S3 un hecho que pregunta no deja A tocado", vivos(), [[400, "A", "Efectivo"]])
    boton("setcta:1:" + a)
    n = foco()
    caso("S3 setcta tras un hecho a medias reemplaza, no suma", vivos(), [[400, "A", "Cuenta Spin"]])
    e = boton("va:" + n)
    f = boton("va:" + a)
    caso("S3 el VA viejo contesta YA_NO_ACTIVA", ultimo(f), B.YA_NO_ACTIVA)
    caso("S3 una sola fila", srv.libro, [[400, "Cuenta Spin", None]])

    nuevo()
    dicta(gasto(400, "A", SPIN))
    a = foco()
    srv.rechaza_monto = 13
    dicta(gasto(13, "x", SPIN))
    boton("cat:" + a)
    boton("setcat:1:" + a)
    caso("S3b tras un proponer rechazado, setcat reemplaza", len(vivos()), 1)

    # --- S4: lo nuevo no cancela a otro ---------------------------------------------
    nuevo()
    dicta(gasto(400, "A", SPIN))
    a = foco()
    u = Update()
    run(B._proponer_categoria(u, CHAT, {"telegram_id": CHAT, "tipo": "EGRESO", "categoria": "X", "subcategoria": "Y"}))
    caso("S4b categoria nueva no cancela a A", srv.borradores[a]["estado"], "PENDIENTE")

    nuevo()
    dicta(gasto(400, "A", SPIN))
    a = foco()
    u = Update()
    run(B._proponer_abono(u, CHAT, {"monto": 500, "metodo_pago": None, "nota": None, "fecha": None}, nombre="Delirio"))
    caso("S4 /abono no cancela a A", (srv.borradores[a]["estado"], len(vivos())), ("PENDIENTE", 2))

    # Los comandos del encargo, por su funcion real (sin la puerta de grupo). Despues de
    # cada uno, A sigue viva Y su boton la escribe a ella: no basta con que siga PENDIENTE.
    Contexto = type("Contexto", (), {})
    B._clave_de = lambda update: CHAT
    for nombre, comando, args in (("/abono", B.comando_abono, ["Delirio", "500"]),
                                  ("/entrega", B.comando_entrega, ["500", "Kevin"]),
                                  ("/anular", B.comando_anular, []),
                                  ("/corregir", B.comando_corregir, []),
                                  ("/alta", B.comando_alta, []),
                                  ("/convertir", B.comando_convertir, [])):
        nuevo()
        dicta(gasto(400, "A", SPIN))
        a = foco()
        contexto = Contexto()
        contexto.args = args
        run(comando.__wrapped__(Update(), contexto))
        cancelados = [r for r, _ in srv.pedidos if r.endswith("/cancelar")]
        boton("va:" + a)
        caso("S4 %s no cancela a A y A sigue escribible" % nombre,
             (cancelados, srv.borradores[a]["estado"], srv.libro), ([], "CONFIRMADO", [[400, "Cuenta Spin", None]]))
    B._clave_de = clave_real

    # --- S5: las listas tienen dueno ------------------------------------------------
    nuevo()
    dicta(abono(5000, "Delirio", SPIN))
    a = foco()
    dicta(abono(800, "Pepe", SPIN))
    b = foco()
    lista = teclado(boton("deu:" + a))
    caso("S5 la lista lleva su borrador", lista[2], "setdeu:2:" + a)
    boton("montoab:" + b)
    B._esperando_monto.pop(CHAT, None)
    boton(lista[2])
    caso("S5 el indice de la lista de A cae en A", vivos(), [[800, "Pepe", "Cuenta Spin"], [5000, "deu-2", "Cuenta Spin"]])

    nuevo()
    u = dicta(abono(5000, "Jose", SPIN))
    lista = teclado(u)
    dicta(abono(800, "Pepe", SPIN))
    boton(lista[0])
    caso("S5b la pregunta de A, con B dictado despues: no toca a B",
         vivos(), [[800, "Pepe", "Cuenta Spin"], [5000, "deu-3", "Cuenta Spin"]])
    w = boton(lista[1])
    caso("S5b ... la lista contestada ya no vive", (ultimo(w), len(vivos())), (B.YA_NO_ACTIVA, 2))

    nuevo()
    dicta(abono(5000, "Delirio", SPIN))
    w = boton("setdeu:1")
    caso("S5c un boton de lista sin dueno no se aplica al foco", (ultimo(w), vivos()), (B.YA_NO_ACTIVA, [[5000, "Delirio", "Cuenta Spin"]]))

    # --- S6: contestar a la pregunta "cual" -----------------------------------------
    nuevo()
    dicta(gasto(400, "A", SPIN))
    dicta(gasto(900, "B", SPIN))
    q = texto("va")
    v = texto("va", enviado(q))
    caso("S6 va a la pregunta cual: no escribe", (srv.libro, ultimo(v).startswith("Tengo 2 propuestas")), ([], True))
    v = texto("va", Mensaje(del_bot=True, teclado=q.message.dichos[0][1]))
    caso("S6 ... aunque el id no se conozca (reinicio): el teclado la delata", srv.libro, [])

    nuevo()
    dicta(gasto(400, "A", SPIN))
    dicta(gasto(900, "B", SPIN))
    q = texto("va")
    v = texto("no", enviado(q))
    caso("S6b no a la pregunta cual: no apaga", (len(vivos()), "toca la que cancelo" in ultimo(v)), (2, True))

    # --- S7: no:x --------------------------------------------------------------------
    nuevo()
    dicta(gasto(900, "B", SPIN))
    b = foco()
    w = boton("no:x")
    caso("S7 no:x cancela en la base, no solo en RAM", (vivos(), srv.borradores[b]["estado"]), ([], "CANCELADO"))

    nuevo()
    dicta(gasto(400, "A"))
    dicta(gasto(900, "B"))
    u = Update()
    run(B._ajustar(u, CHAT, ajuste(sobre="gasto", cuenta_id=SPIN, cuenta_nombre="Cuenta Spin")))
    cancelar = teclado(u)[-1]
    caso("S7b el Cancelar de una pregunta dice de que pregunta es", cancelar.startswith("no:x:q"), True)
    boton(cancelar)
    caso("S7b ... cierra la pregunta y solo ella", len(vivos()), 2)
    w = boton(teclado(u)[0])
    caso("S7b ... y sus otros botones ya no viven", (ultimo(w), [v[2] for v in vivos()]),
         (B.YA_NO_ACTIVA, ["Efectivo", "Efectivo"]))

    nuevo()
    dicta(gasto(400, "A", SPIN))
    a = foco()
    dicta(gasto(900, "B", SPIN))
    q = texto("no")
    caso("S7c no con dos: pregunta", (len(vivos()), "toca la que cancelo" in ultimo(q)), (2, True))
    boton(teclado(q)[0])
    caso("S7c ... y el boton apaga solo esa", vivos(), [[900, "B", "Cuenta Spin"]])

    # --- S8 a S10: ajustar -----------------------------------------------------------
    nuevo()
    dicta(gasto(400, "A", SPIN))
    u = Update()
    run(B._ajustar(u, CHAT, ajuste(sobre="gasto", cuenta_oida="la de Kevin")))
    d = B._memoria.get(CHAT)
    caso("S8 cuenta que no casa: se avisa y se pregunta",
         (any(x.startswith("va:") for x in teclado(u)), d["cuenta_pendiente"], "la de Kevin" in ultimo(u)), (False, True, True))

    nuevo()
    dicta(abono(5000, "Delirio", SPIN))
    c = {"cuenta_id": E.ID_GILBERTO}
    E._aplica_a(c, "ajustar", CUENTAS, [])
    u = Update()
    run(B._ajustar(u, CHAT, ajuste(**c)))
    caso("S9 ajuste sin `sobre` a Gilberto sobre un abono: no entra, pregunta",
         (any(x.startswith("vaab:") for x in teclado(u)), [v[2] for v in vivos()], "solo paga" in ultimo(u)),
         (False, ["Efectivo"], True))

    nuevo()
    dicta(gasto(400, "A"))
    a = foco()
    dicta(gasto(900, "B"))
    b = foco()
    u = Update()
    run(B._ajustar(u, CHAT, ajuste(sobre="gasto", cuenta_id=SPIN, cuenta_nombre="Cuenta Spin")))
    caso("S10 ajuste con dos y sin reply: no toca ninguna", [v[2] for v in vivos()], ["Efectivo", "Efectivo"])
    caso("S10 ... pregunta a cual, con rotulos", (rotulos(u)[:2], "A cual" in ultimo(u)),
         (["un gasto $400 A", "un gasto $900 B"], True))
    boton(teclado(u)[1])
    caso("S10 ... y el boton aplica el cambio a ESA", vivos(), [[400, "A", "Efectivo"], [900, "B", "Cuenta Spin"]])

    nuevo()
    u1 = dicta(gasto(400, "A"))
    dicta(gasto(900, "B"))
    u = Update(enviado(u1))
    run(B._ajustar(u, CHAT, ajuste(sobre="gasto", cuenta_id=SPIN, cuenta_nombre="Cuenta Spin")))
    caso("S10b contestando a A: ajusta A sin preguntar", vivos(), [[400, "A", "Cuenta Spin"], [900, "B", "Efectivo"]])

    # --- S11: doble clic -------------------------------------------------------------
    nuevo()
    dicta(gasto(400, "A", SPIN))
    a = foco()
    dicta(gasto(900, "B", SPIN))
    boton("va:" + a)
    w = boton("va:" + a)
    caso("S11 doble clic con B viva", (ultimo(w), len(srv.libro)), (B.YA_NO_ACTIVA, 1))

    # --- S12: el mismo gasto dos veces -----------------------------------------------
    nuevo()
    dicta(gasto(400, "gasolina", SPIN))
    a = foco()
    q = dicta(gasto(400, "gasolina", SPIN))
    caso("S12 el mismo gasto: se avisa y no se agrega", (len(vivos()), "parece lo mismo" in ultimo(q)), (1, True))
    boton("va:" + a)
    caso("S12 ... el VA de la viva sigue sirviendo", len(srv.libro), 1)

    nuevo()
    dicta(gasto(400, "gasolina", SPIN))
    q = dicta(gasto(400, "gasolina", SPIN))
    boton(teclado(q)[1])
    caso("S12b 'es el mismo': no se agrega y la viva sigue", len(vivos()), 1)

    nuevo()
    dicta(gasto(400, "gasolina", SPIN))
    q = dicta(gasto(400, "gasolina", SPIN))
    boton(teclado(q)[0])
    caso("S12c 'es otro': se agrega", len(vivos()), 2)

    nuevo()
    dicta(gasto(400, "gasolina", SPIN))
    q = dicta(gasto(450, "gasolina", SPIN))
    caso("S12d CONTROL otro monto se suma sin preguntar", len(vivos()), 2)

    # --- #3: corregir un gasto de noche no lo mueve de dia ---------------------------------
    corregida = B._recaptura_con({"monto": 100, "fecha": "2026-11-04T03:00:00+00:00"}, "monto", 200)
    caso("3 la correccion lleva el instante de la fila, no su dia en UTC",
         corregida["fecha"], "2026-11-04T03:00:00+00:00")

    # --- S13: contestar a una propuesta terminada --------------------------------------
    nuevo()
    u = dicta(gasto(400, "A", SPIN))
    pantalla = enviado(u)
    a = foco()
    boton("va:" + a)
    pantalla.reply_markup = None  # Telegram le quita el teclado
    dicta(gasto(900, "B", SPIN))
    v = texto("va", pantalla)
    caso("S13 va a una propuesta escrita, sin teclado: no escribe la otra", (ultimo(v), len(srv.libro)), (B.YA_NO_ACTIVA, 1))

    nuevo()
    u = dicta(gasto(400, "A", SPIN))
    pantalla = enviado(u)
    boton("va:" + foco())
    pantalla.reply_markup = None
    dicta(gasto(900, "B", SPIN))
    reinicio()
    v = texto("va", pantalla)
    caso("S13b ... tampoco tras un reinicio: contesta a un mensaje del bot que no se conoce",
         (len(srv.libro), "Tengo 1 propuesta" in ultimo(v)), (1, True))

    # --- #11: el reintento del abono ---------------------------------------------------
    nuevo()
    srv.error_abono = "Esa cuenta no es tuya o esta vetada."
    u = dicta(abono(5000, "Delirio", SPIN))
    caso("11 cuenta vetada: no la cambia en silencio, pregunta",
         (any(x.startswith("vaab:") for x in teclado(u)), B._memoria.get(CHAT)["cuenta_pendiente"]), (False, True))

    nuevo()
    srv.error_abono = "Origen y destino serian la misma cuenta. No escribo eso."
    u = dicta(abono(5000, "Delirio", SPIN))
    caso("11 otro 422: se dice y no se reintenta sin cuenta",
         (ultimo(u), len([1 for r, _ in srv.pedidos if r.endswith("abono/proponer")]), vivos()),
         (srv.error_abono, 1, []))

    # --- #12: rotulos que se distinguen ---------------------------------------------------
    nuevo()
    dicta(gasto(400, "gasolina", SPIN, fecha="2026-11-01"))
    dicta(gasto(400, "gasolina", SPIN, fecha="2026-11-02"))
    q = texto("va")
    caso("12 dos rotulos nunca iguales", len(set(rotulos(q))), 2)

    # --- #13: los tipos que antes no rehidrataban --------------------------------------
    nuevo()
    bid = srv.nuevo("lote_etapa")
    B._rehidratar(CHAT)
    texto("va")
    caso("13 lote_etapa rehidratada confirma por SU ruta",
         ([r for r, _ in srv.pedidos if r.endswith("/confirmar")], srv.borradores[bid]["estado"]),
         ([B.RUTA_CONFIRMAR_DE["lote_etapa"]], "CONFIRMADO"))
    for tipo, accion in (("entrega_efectivo", "vaet"), ("alta_miembro", "vamb"), ("alta_categoria", "vacat"),
                         ("entrada_insumo", "vaent")):
        nuevo()
        bid = srv.nuevo(tipo)
        B._rehidratar(CHAT)
        boton(accion + ":" + bid)
        rutas = [r for r, _ in srv.pedidos if r.endswith("/confirmar")]
        caso("13 %s rehidratada no cae en gasto/confirmar" % tipo,
             (len(rutas) == 1, rutas[0] if rutas else "", srv.borradores[bid]["estado"]),
             (True, B.RUTA_CONFIRMAR_DE.get(tipo, rutas[0] if rutas else ""), "CONFIRMADO"))

    # === Segundo auditor, 2026-11-04 =====================================================
    HOY = dt.date.today().isoformat()
    GIL, TRANS = E.ID_GILBERTO, E.ID_TRANSFERENCIAS

    def venta_viva():
        run(B._proponer_venta(Update(), CHAT, {"productos": [{"producto": "X", "cantidad": 1}], "propuesta": {}}))
        return foco()

    def libro():
        return [(m, d or c) for m, c, d in srv.libro]

    # --- 1. D1: una venta no entra a una cuenta de solo egresos ---------------------------
    nuevo()
    venta_viva()
    c = {"cuenta_id": GIL}
    E._aplica_a(c, "ajustar", CUENTAS, [])
    u = Update()
    run(B._ajustar(u, CHAT, ajuste(**c)))
    caso("D1 venta ajustada a Gilberto: no queda en Gilberto y lo dice",
         (vivos(), [p.get("id_cuenta") for r, p in srv.pedidos if r.endswith("venta/proponer")][-1:],
          "solo paga" in ultimo(u)),
         ([[999, None, "Efectivo"]], [None], True))
    nuevo()
    venta_viva()
    run(B._ajustar(Update(), CHAT, ajuste(cuenta_id=SPIN)))
    caso("D1 control: venta ajustada a Spin si cambia", vivos(), [[999, None, "Cuenta Spin"]])
    caso("D1 Cambiar cuenta de una venta no ofrece Gilberto",
         GIL in [x["id"] for x in B._memoria.get(CHAT)["cuentas"]], False)

    # --- 2. "Es el mismo" y "Mejor no": la viva sigue, y el texto no dice lo contrario ----
    nuevo()
    dicta(gasto(400, "gasolina", SPIN))
    a = foco()
    u = dicta(gasto(400, "gasolina", SPIN))
    w = boton(teclado(u)[1])
    caso("2 Es el mismo: no dice cancelado y nombra lo que sigue",
         ("Cancelado" in ultimo(w), "Sigue pendiente" in ultimo(w), vivos()),
         (False, True, [[400, "gasolina", "Cuenta Spin"]]))
    boton("va:" + a)
    caso("2 y su VA sigue escribiendo", libro(), [[400, "Cuenta Spin"]])
    nuevo()
    dicta(gasto(400, "gasolina", SPIN))
    dicta(gasto(400, "gasolina", SPIN))
    n = texto("no")
    caso("2 el no escrito a la pregunta dice lo mismo", ("Sigue pendiente" in ultimo(n), len(vivos())), (True, 1))
    nuevo()
    dicta(gasto(400, "A"))
    dicta(gasto(900, "B"))
    u = Update()
    run(B._ajustar(u, CHAT, ajuste(sobre="gasto", cuenta_id=SPIN)))
    w = boton(teclado(u)[-1])
    caso("2 Mejor no de un ajuste: no dice cancelado", ("Cancelado" in ultimo(w), len(vivos())), (False, 2))
    nuevo()
    u = dicta(abono(700, "Jose", SPIN))
    w = boton(teclado(u)[-1]) if teclado(u)[-1].startswith("no:") else texto("no")
    caso("2 sin nada vivo sigue diciendo cancelado", ultimo(w), "Cancelado. No escribi nada.")

    # --- 3. Boton VA de un abono sin cuenta sabida ----------------------------------------
    nuevo()
    srv.guarda_contexto = False
    dicta(abono(500, "Pepe", SPIN))
    a = foco()
    reinicio()
    w = boton("vaab:" + a)
    caso("3 abono de antes del contexto: el boton rehusa como el va",
         (srv.libro, "No escribi nada" in ultimo(w)), ([], True))
    nuevo()
    dicta(abono(500, "Pepe"))
    a = foco()
    w = boton("vaab:" + a)
    caso("3 boton viejo de abono con cuenta pendiente: pregunta", (srv.libro, "De cual cuenta" in ultimo(w)), ([], True))
    nuevo()
    dicta(abono(500, "Pepe", SPIN))
    a = foco()
    reinicio()
    boton("vaab:" + a)
    caso("3 control: con contexto el boton escribe tras reinicio", libro(), [[500, "Pepe"]])

    # --- 4. D2: pregunta contestada por voz ----------------------------------------------
    nuevo()
    u = dicta(abono(5000, "Jose", SPIN))
    lista = teclado(u)
    dicta(abono(5000, "Pepe", SPIN))
    w = boton(lista[0])
    caso("D2 boton viejo de la pregunta contestada no crea otro abono",
         (ultimo(w), vivos()), (B.YA_NO_ACTIVA, [[5000, "Pepe", "Cuenta Spin"]]))
    nuevo()
    u = dicta(abono(5000, "Jose", SPIN))
    vieja = teclado(u)
    u = dicta(abono(5000, "Jose", SPIN))
    nueva = teclado(u)
    w = boton(vieja[0])
    x = boton(nueva[0])
    caso("D2 la misma pregunta dos veces: vale solo la nueva", (ultimo(w), len(vivos())), (B.YA_NO_ACTIVA, 1))
    nuevo()
    dicta(gasto(400, "A", SPIN))
    g = foco()
    u = dicta(abono(5000, "Jose", SPIN))
    boton("monto:" + g)
    B._esperando_monto.pop(CHAT, None)
    dicta(abono(5000, "Pepe", SPIN))
    caso("D2 la pregunta apartada tambien se cierra (no vuelve al foco)", B._apartado.get(CHAT), None)
    nuevo()
    u = dicta(abono(5000, "Jose", SPIN))
    lista = teclado(u)
    dicta(abono(800, "Pepe", SPIN))
    boton(lista[0])
    caso("D2 control: otro monto es otro abono y su lista sigue viva (S5)", len(vivos()), 2)

    # --- 5. D3: sin fecha es hoy ----------------------------------------------------------
    nuevo()
    dicta(gasto(400, "gasolina", SPIN))
    u = dicta(gasto(400, "gasolina", SPIN, fecha=HOY))
    caso("D3 sin fecha contra fecha de hoy avisa", ("parece lo mismo" in ultimo(u), len(vivos())), (True, 1))
    nuevo()
    dicta(gasto(400, "gasolina", SPIN, fecha=HOY))
    u = dicta(gasto(400, "gasolina", SPIN))
    caso("D3 y al reves", ("parece lo mismo" in ultimo(u), len(vivos())), (True, 1))
    nuevo()
    dicta(gasto(400, "gasolina", SPIN))
    dicta(gasto(400, "gasolina", SPIN, fecha=(dt.date.today() - dt.timedelta(days=1)).isoformat()))
    caso("D3 control: ayer es otro gasto", len(vivos()), 2)

    # --- 6. T18: ajustar en reply a una terminada tras reinicio ---------------------------
    nuevo()
    u = dicta(gasto(400, "A", SPIN))
    a = foco()
    pantalla = enviado(u)
    boton("va:" + a)
    pantalla.reply_markup = None
    dicta(gasto(900, "B", SPIN))
    reinicio()
    B._rehidratar(CHAT)
    u = Update(pantalla)
    run(B._ajustar(u, CHAT, ajuste(sobre="gasto", monto=111)))
    caso("T18 el ajuste no cae en la unica viva: pregunta, en singular",
         (vivos(), ultimo(u).startswith("No se a que propuesta"), teclado(u)[0].startswith("setaj:")),
         ([[900, "B", "Cuenta Spin"]], True, True))
    boton(teclado(u)[0])
    caso("T18 tocada la opcion, se le aplica", [v[0] for v in vivos()], [111])
    nuevo()
    u = dicta(gasto(400, "A", SPIN))
    run(B._ajustar(Update(enviado(u)), CHAT, ajuste(sobre="gasto", monto=111)))
    caso("T18 control: reply a la viva la ajusta sin preguntar", [v[0] for v in vivos()], [111])

    # --- 7. S12 para abono ----------------------------------------------------------------
    nuevo()
    dicta(abono(500, "Pepe", SPIN))
    a = foco()
    u = dicta(abono(500, "Pepe", SPIN))
    caso("S12 abono: el mismo dos veces no se agrega y su borrador se apaga en la base",
         ("parece lo mismo" in ultimo(u), "Es otro abono?" in ultimo(u), len(vivos()),
          sorted(v["estado"] for v in srv.borradores.values())),
         (True, True, 1, ["CANCELADO", "PENDIENTE"]))
    w = boton(teclado(u)[1])
    caso("S12 abono: Es el mismo deja el primero", ("Sigue pendiente" in ultimo(w), len(vivos())), (True, 1))
    u = dicta(abono(500, "Pepe", SPIN))
    boton(teclado(u)[0])
    caso("S12 abono: Si, es otro lo agrega", len(vivos()), 2)
    for bid in [k for k, v in srv.borradores.items() if v["estado"] == "PENDIENTE"]:
        boton("vaab:" + bid)
    caso("S12 abono: cada uno con su VA escribe el suyo", libro(), [[500, "Pepe"], [500, "Pepe"]])
    nuevo()
    srv.alias = {"Chuy": "Pepe"}
    dicta(abono(500, "Pepe", SPIN))
    u = dicta(abono(500, "Chuy", SPIN))
    caso("S12 abono: dicho distinto, mismo deudor del servidor", ("parece lo mismo" in ultimo(u), len(vivos())), (True, 1))
    nuevo()
    dicta(abono(500, "Pepe", SPIN))
    dicta(abono(500, "Luis", SPIN))
    dicta(abono(600, "Pepe", SPIN))
    caso("S12 abono control: otro deudor u otro monto se suma", len(vivos()), 3)
    nuevo()
    dicta(abono(500, "Pepe", SPIN))
    u = Update()
    run(B._ajustar(u, CHAT, ajuste(sobre="abono", cuenta_id=TRANS)))
    caso("S12 abono control: cambiarle la cuenta no se toma por duplicado",
         vivos(), [[500, "Pepe", "Transferencias"]])

    # --- 8. correr_pruebas: SALTADA no es ok ----------------------------------------------
    caso("8 estados de una prueba",
         [CP.estado(0, "RESULTADO: SALTADA - no hay stack"), CP.estado(0, "5. SALTADA la sintesis"),
          CP.estado(0, "RESULTADO: pasan"), CP.estado(1, "RESULTADO: SALTADA"), CP.estado("TOPE", "")],
         ["SALTADA", "ok*", "ok", "ROJO", "ROJO"])
    caso("8 la saltada no entra al total y va con su nombre",
         CP.resumen([("a", "ok"), ("b", "ok*"), ("c", "SALTADA")]).splitlines(),
         ["ROJOS 0 de 2 corridas", "SALTADAS 1 (no probaron nada): c",
          "CON TRAMO SALTADO 1 (el resto corrio): b"])
finally:
    B._post_de_verdad = orig_post
    B._clave_de = clave_real
    B._olvidar_chat(CHAT)

malos = [(n, o, e) for n, o, e in casos if o != e]
for n, o, e in casos:
    print(("ok   " if o == e else "FALLA") + "  " + n + ("" if o == e else "  -> obtuve %r, esperaba %r" % (o, e)))
if malos:
    print("RESULTADO: %d de %d casos FALLAN" % (len(malos), len(casos)))
    sys.exit(1)
print("RESULTADO: los %d casos pasan" % len(casos))
