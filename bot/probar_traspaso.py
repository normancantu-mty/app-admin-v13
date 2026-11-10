# -*- coding: utf-8 -*-
"""TRASPASO ENTRE CUENTAS: el lado del bot (2026-11-05).

Escenario del encargo: Norman dicto "Transferencia de la cuenta de Gilberto a la
Spin $25,000 pesos." y el enrutador lo dejo en charla con `hechos: []`.

Aqui corre la tuberia real (`manejar_texto`, `manejar_boton`) con la salida
GRABADA del modelo y `_post` doblado: **ninguna peticion sale de este proceso.**
El servidor (sellos, doble clic, atomicidad, anular) se prueba en
`tests/bot-traspaso.spec.ts`.

Corre con:  python bot/probar_traspaso.py      (sin red, sin modelo)
"""
import asyncio
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# D46: el log va a un temporal. ANTES del import; ver `probar_log.py`.
os.environ["BOT_LOG"] = os.path.join(tempfile.gettempdir(), "probar_traspaso.log")

import bot_gastos as B  # noqa: E402


async def _alta_ok(update, clave):
    return True


B._puerta_de_privado = _alta_ok
import enrutador as E  # noqa: E402
import grabar_enrutador as G  # noqa: E402

CHAT = 555000222
UUID = "5a1f0c7e-2b64-4f0a-9c33-7d1e8b2f6a10"
SELLO = "s3ll0"
RUTA_PROPONER = "/api/bot/traspaso/proponer"
RUTA_CONFIRMAR = "/api/bot/traspaso/confirmar"
GILBERTO = "2e2d25d1-84ed-4a66-bd1a-5cc7072f346b"
SPIN = "ecc06594-3ba3-44b1-b108-151e3aeac619"
EFECTIVO = "67e91f62-0ac3-43fe-a640-ec1b85e994b0"
TRANSFERENCIAS = "e0000000-0000-0000-0000-0000000000f1"

casos = []


def caso(nombre, obtenido, esperado):
    casos.append((nombre, obtenido, esperado))


class MensajeFalso(object):
    def __init__(self, chat_id, texto=""):
        self.chat = type("Chat", (), {"id": chat_id, "type": "private"})()
        self.chat.send_action = self._nada
        self.text = texto
        self.dichos = []
        self.teclados = []

    async def _nada(self, *a, **kw):
        return None

    async def reply_text(self, texto, **kw):
        self.dichos.append(str(texto))
        self.teclados.append(kw.get("reply_markup"))
        return None

    async def reply_photo(self, *a, **kw):
        return None


class UpdateDeTexto(object):
    def __init__(self, chat_id, texto):
        self.message = MensajeFalso(chat_id, texto)
        self.callback_query = None

    @property
    def effective_message(self):
        return self.message

    @property
    def effective_chat(self):
        return self.message.chat


class ConsultaFalsa(object):
    def __init__(self, chat_id, data):
        self.data = data
        self.message = MensajeFalso(chat_id)

    async def answer(self, *a, **kw):
        return None


class UpdateDeBoton(object):
    def __init__(self, chat_id, data):
        self.callback_query = ConsultaFalsa(chat_id, data)
        self.message = None

    @property
    def effective_message(self):
        return self.callback_query.message

    @property
    def effective_chat(self):
        return self.callback_query.message.chat


class PostDoble(object):
    def __init__(self, respuestas=None):
        self.llamadas = []
        self.respuestas = respuestas or {}

    def __call__(self, ruta, cuerpo):
        self.llamadas.append((ruta, cuerpo))
        if ruta in self.respuestas:
            return self.respuestas[ruta]
        if ruta == "/api/bot/catalogo":
            return 200, {"ok": True, "productos": []}
        if ruta == "/api/bot/pendiente":
            return 200, {"ok": True, "pendientes": []}
        if ruta == B.RUTA_LEER_CUENTAS:
            return 200, {"ok": True, "cuentas": G.CUENTAS}
        if ruta == RUTA_PROPONER:
            return 200, {"ok": True, "borrador_id": UUID, "sello": SELLO,
                         "mensaje": "TRASPASO ENTRE CUENTAS. Contesta VA."}
        if ruta == RUTA_CONFIRMAR:
            return 200, {"ok": True, "filas_escritas": 2, "mensaje": "Listo. Paso $1.00 de A a B."}
        return 200, {"ok": True, "borrador_id": UUID, "sello": SELLO, "mensaje": "Listo.",
                     "opciones": [], "movimientos": [], "cotizaciones": [], "clientes": []}

    def rutas(self):
        return [r for r, _ in self.llamadas]

    def cuerpos(self, ruta):
        return [c for r, c in self.llamadas if r == ruta]


def limpiar():
    B._olvidar_chat(CHAT)
    B._memoria.pop(CHAT, None)
    B._pendientes.pop(CHAT, None)
    B._rehidratado.discard(CHAT)
    B._cuentas_leidas.clear()


def correr(corutina, doble, ruta_del_modelo=None):
    enrutar_original, post_original = B.enrutar, B._post

    def enrutar_doble(*a, **kw):
        return True, dict(ruta_del_modelo or {})

    B.enrutar, B._post = enrutar_doble, doble
    try:
        asyncio.run(corutina)
    finally:
        B.enrutar, B._post = enrutar_original, post_original


def hablar(texto, ruta_del_modelo, doble=None):
    """Una frase por la tuberia real. Devuelve (lo dicho, el doble, el update)."""
    doble = doble or PostDoble()
    u = UpdateDeTexto(CHAT, texto)
    correr(B.manejar_texto(u, None), doble, ruta_del_modelo)
    return u.message.dichos, doble, u


def picar(dato, doble):
    u = UpdateDeBoton(CHAT, dato)
    correr(B.manejar_boton(u, None), doble)
    return u.callback_query.message.dichos


def dijo(dichos, *pedazos):
    junto = " ".join(dichos)
    return all(p in junto for p in pedazos)


def ruta(intencion, campos, **resto):
    base = dict(intencion=intencion, confianza="alta", entendido="x",
                campos=campos, respuesta="", hechos=[], faltantes=[], pregunta=None)
    # Como en la salida real de `enrutar`: lo que escribe viaja tambien en `hechos`.
    if intencion == "traspaso":
        base["hechos"] = [dict(intencion=intencion, campos=dict(campos), faltantes=[],
                               pregunta=None, confianza="alta")]
    base.update(resto)
    return base


CONFIRMA = ruta("confirmar", {})

# ═══ 1. La frase real de Norman, con la salida grabada del modelo ═════════════
limpiar()
dichos, doble, u = hablar("Transferencia de la cuenta de Gilberto a la Spin $25,000 pesos.",
                          G.grabada("tr_1_frase_real"))
caso("FRASE REAL: el modelo la entiende como traspaso",
     G.grabada("tr_1_frase_real")["intencion"], "traspaso")
caso("FRASE REAL: ya no sale con hechos vacios",
     len(G.grabada("tr_1_frase_real")["hechos"]), 1)
caso("FRASE REAL: llama a proponer una sola vez", doble.rutas().count(RUTA_PROPONER), 1)
caso("FRASE REAL: origen Gilberto, destino Spin, 25 mil",
     [(c["propuesta"]["origen_id"], c["propuesta"]["destino_id"], c["propuesta"]["monto"])
      for c in doble.cuerpos(RUTA_PROPONER)], [(GILBERTO, SPIN, 25000)])
caso("FRASE REAL: no toca gasto, abono ni confirmar",
     [r for r in doble.rutas() if r != B.RUTA_LEER_CUENTAS and (
         r.startswith(("/api/bot/gasto", "/api/bot/abono")) or r.endswith("/confirmar"))], [])
caso("FRASE REAL: ensena la propuesta del servidor", dijo(dichos, "TRASPASO ENTRE CUENTAS"), True)
caso("FRASE REAL: la propuesta lleva boton VA con su borrador",
     [b.callback_data for fila in u.message.teclados[-1].inline_keyboard for b in fila],
     ["va:" + UUID, "no:" + UUID])
caso("FRASE REAL: queda sellada en memoria como traspaso",
     (B._memoria[CHAT]["tipo"], B._memoria[CHAT]["borrador_id"], B._memoria[CHAT]["sello"]),
     ("traspaso", UUID, SELLO))

# ═══ 2. El VA escrito va a la ruta del traspaso, no a la del gasto ════════════
dichos, doble, _ = hablar("si escribelo", CONFIRMA)
caso("VA ESCRITO: va a /traspaso/confirmar", doble.rutas().count(RUTA_CONFIRMAR), 1)
caso("VA ESCRITO: el default no lo manda a gasto",
     "/api/bot/confirmar" in doble.rutas() or "/api/bot/gasto/confirmar" in doble.rutas(), False)
caso("VA ESCRITO: solo viajan chat, borrador y sello (lo sellado no se reescribe)",
     doble.cuerpos(RUTA_CONFIRMAR), [{"telegram_id": CHAT, "borrador_id": UUID, "sello": SELLO}])
caso("VA ESCRITO: ensena el Listo del servidor", dijo(dichos, "Listo."), True)
caso("VA ESCRITO: la memoria queda limpia", CHAT in B._memoria, False)

# ═══ 3. Doble clic: el segundo ya no encuentra nada que confirmar ═════════════
limpiar()
_, doble, _ = hablar("pase 5 mil de efectivo a spin", G.grabada("tr_2_pase"))
d1 = picar("va:" + UUID, doble)
d2 = picar("va:" + UUID, doble)
caso("BOTON: primer clic llega a /traspaso/confirmar", dijo(d1, "Listo."), True)
caso("DOBLE CLIC: una sola llamada de confirmar", doble.rutas().count(RUTA_CONFIRMAR), 1)
caso("DOBLE CLIC: el segundo no dice Listo", dijo(d2, "Listo."), False)

# Un fallo del servidor NO pierde la propuesta, y el reintento manda el MISMO sello.
limpiar()
falla = PostDoble({RUTA_CONFIRMAR: (500, {"ok": False, "error": "No pude escribir el traspaso. No quedo nada escrito."})})
hablar("pase 5 mil de efectivo a spin", G.grabada("tr_2_pase"), falla)
d = picar("va:" + UUID, falla)
caso("REINTENTO: el error del servidor se dice", dijo(d, "No quedo nada escrito"), True)
caso("REINTENTO: no dice Listo", dijo(d, "Listo."), False)
caso("REINTENTO: la propuesta sigue viva", B._memoria.get(CHAT, {}).get("borrador_id"), UUID)
picar("va:" + UUID, falla)
caso("REINTENTO: manda el mismo borrador y sello",
     [(c["borrador_id"], c["sello"]) for c in falla.cuerpos(RUTA_CONFIRMAR)],
     [(UUID, SELLO), (UUID, SELLO)])

# ═══ 4. Nunca adivina la cuenta ═══════════════════════════════════════════════
limpiar()
dichos, doble, _ = hablar("movi 3000 de spin a la cuenta de kevin",
                          G.grabada("tr_5_destino_desconocido"))
caso("DESCONOCIDA: no propone", RUTA_PROPONER in doble.rutas(), False)
caso("DESCONOCIDA: dice cual no ubico y ensena las cuentas",
     dijo(dichos, "la cuenta de kevin", "A cual cuenta entra", "Efectivo", "Cuenta Spin"), True)

limpiar()
dichos, doble, _ = hablar("pasa 800 de la G a efectivo", G.grabada("tr_7_ambigua"))
caso("AMBIGUA: no propone (la G no se toma por Gilberto)", RUTA_PROPONER in doble.rutas(), False)
caso("AMBIGUA: pregunta de cual sale", dijo(dichos, "De cual cuenta sale"), True)

limpiar()
dichos, doble, _ = hablar("haz un traspaso de 500 a spin", G.grabada("tr_6_falta_origen"))
caso("FALTA ORIGEN: no propone", RUTA_PROPONER in doble.rutas(), False)
caso("FALTA ORIGEN: lo pregunta", dijo(dichos, "De cual cuenta sale"), True)
caso("FALTA ORIGEN: no hay sello que un va pudiera tomar",
     (B._memoria[CHAT].get("estado"), B._memoria[CHAT].get("borrador_id")), ("incompleto", None))
# Un "va" antes de tiempo no escribe.
dichos, doble2, _ = hablar("va", CONFIRMA)
caso("FALTA ORIGEN: un va antes de tiempo no llama a confirmar",
     RUTA_CONFIRMAR in doble2.rutas(), False)
# La respuesta "de efectivo" llega como cuenta suelta y cae en el lado que faltaba.
dichos, doble3, _ = hablar("de efectivo", ruta("ajustar", {
    "cuenta_id": EFECTIVO, "cuenta_nombre": "Efectivo"}))
caso("FALTA ORIGEN: la cuenta contestada cae en el lado que faltaba",
     [(c["propuesta"]["origen_id"], c["propuesta"]["destino_id"], c["propuesta"]["monto"])
      for c in doble3.cuerpos(RUTA_PROPONER)], [(EFECTIVO, SPIN, 500)])

limpiar()
dichos, doble, _ = hablar("pasa 900 de spin a gilberto", ruta("traspaso", {
    "monto": 900, "origen_id": SPIN, "origen_nombre": "Cuenta Spin",
    "destino_solo_paga": "Cuenta Gilberto"}))
caso("SOLO PAGA: no propone", RUTA_PROPONER in doble.rutas(), False)
caso("SOLO PAGA: explica por que y pide otra", dijo(
    dichos, "Cuenta Gilberto", "solo registra salidas", "A cual otra cuenta entra"), True)

limpiar()
dichos, doble, _ = hablar("pasa de efectivo a spin", ruta("traspaso", {
    "origen_id": EFECTIVO, "destino_id": SPIN}))
caso("SIN MONTO: no propone", RUTA_PROPONER in doble.rutas(), False)
caso("SIN MONTO: lo pregunta", dijo(dichos, "De cuanto fue"), True)

limpiar()
malo = PostDoble({RUTA_PROPONER: (422, {"ok": False, "error": "El origen y el destino son la misma cuenta."})})
dichos, _, _ = hablar("pasa 100 de spin a spin", ruta("traspaso", {
    "monto": 100, "origen_id": SPIN, "destino_id": SPIN}), malo)
caso("RECHAZO DEL SERVIDOR: se dice tal cual", dijo(dichos, "la misma cuenta"), True)
caso("RECHAZO DEL SERVIDOR: no deja borrador", (B._memoria.get(CHAT) or {}).get("borrador_id"), None)

# ═══ 5. Lo que hace el codigo con lo que dice el modelo (sin adivinar) ════════
cuentas = list(G.CUENTAS)
c = {"origen_id": "id-inventado", "destino_id": SPIN, "origen_nombre": "lo puso el modelo"}
E._aplica_lados_de_traspaso(c, cuentas)
caso("ENRUTADOR: un id fuera de la lista se tira", "origen_id" in c, False)
caso("ENRUTADOR: el nombre del modelo no sobrevive", "origen_nombre" in c, False)
caso("ENRUTADOR: falta origen", E.lado_de_traspaso_que_falta(c), "origen")
c = {"origen_id": SPIN, "origen_oida": "la Spin", "destino_id": GILBERTO, "destino_oida": "Gilberto"}
E._aplica_lados_de_traspaso(c, cuentas)
caso("ENRUTADOR: Gilberto no puede ser destino",
     (c.get("destino_id"), c.get("destino_solo_paga")), (None, "Cuenta Gilberto"))
c = {"origen_id": GILBERTO, "origen_oida": "la cuenta de Gilberto", "destino_id": SPIN, "destino_oida": "la Spin"}
E._aplica_lados_de_traspaso(c, cuentas)
caso("ENRUTADOR: Gilberto SI puede ser origen", c.get("origen_id"), GILBERTO)
caso("CONTRASTE: id y oido que nombran la misma cuenta valen",
     (c.get("origen_id"), c.get("destino_id"), E.lado_de_traspaso_que_falta(c)), (GILBERTO, SPIN, None))
c = {"origen_id": EFECTIVO, "origen_oida": "efectivo de Aeropuerto", "destino_id": SPIN, "destino_oida": "Spin"}
E._aplica_lados_de_traspaso(c, cuentas)
caso("CONTRASTE: 'efectivo de Aeropuerto' no es Efectivo aunque el modelo lo diga",
     (c.get("origen_id"), c.get("origen_oida"), E.lado_de_traspaso_que_falta(c)),
     (None, "efectivo de Aeropuerto", "origen"))
c = {"origen_id": SPIN, "origen_oida": "efectivo", "destino_id": EFECTIVO, "destino_oida": "spin"}
E._aplica_lados_de_traspaso(c, cuentas)
caso("CONTRASTE: un id que contradice lo oido no se escoge",
     (c.get("origen_id"), c.get("destino_id")), (None, None))
c = {"origen_id": EFECTIVO, "destino_id": SPIN}
E._aplica_lados_de_traspaso(c, cuentas)
caso("CONTRASTE: un id sin nada oido no se le cree",
     (c.get("origen_id"), c.get("destino_id"), E.lado_de_traspaso_que_falta(c)), (None, None, "origen"))
limpiar()
dichos, doble, _ = hablar("pase 500 del efectivo de Aeropuerto a Spin", ruta("traspaso", {
    "monto": 500, "origen_oida": "efectivo de Aeropuerto", "destino_id": SPIN, "destino_nombre": "Cuenta Spin"}))
caso("CONTRASTE: de punta a punta no propone", RUTA_PROPONER in doble.rutas(), False)
caso("CONTRASTE: de punta a punta repregunta", dijo(dichos, 'No ubico "efectivo de Aeropuerto"', "De cual cuenta sale"), True)
caso("CONTRASTE: la frase real del defecto, grabada, trae sin origen",
     (G.grabada("tr_12_efectivo_de_aeropuerto")["intencion"],
      G.grabada("tr_12_efectivo_de_aeropuerto")["campos"].get("origen_id")), ("traspaso", None))
limpiar()
c = {"origen_oida": "la G", "destino_oida": "spin"}
E._aplica_lados_de_traspaso(c, cuentas)
caso("ENRUTADOR: lo oido que casa se valida; lo que no, se queda como oido",
     (c.get("destino_id"), c.get("origen_id"), c.get("origen_oida")), (SPIN, None, "la G"))
caso("LADOS: la cuenta suelta llena lo que falta",
     B._lados_de_traspaso({"cuenta_id": SPIN, "cuenta_nombre": "Spin", "destino_id": EFECTIVO}).get("origen_id"),
     SPIN)
caso("LADOS: sin hueco no pisa ningun lado",
     B._lados_de_traspaso({"cuenta_id": SPIN, "origen_id": EFECTIVO, "destino_id": TRANSFERENCIAS}),
     {"origen_id": EFECTIVO, "destino_id": TRANSFERENCIAS})

# ═══ 6. El ajuste sobre la propuesta en pantalla ══════════════════════════════
limpiar()
_, doble, _ = hablar("Transferencia de la cuenta de Gilberto a la Spin $25,000 pesos.",
                     G.grabada("tr_1_frase_real"))
dichos, doble, _ = hablar("no, que sean 20 mil", G.grabada("tr_11_ajuste"))
caso("AJUSTE: repropone con el monto nuevo y los mismos lados",
     [(c["propuesta"]["origen_id"], c["propuesta"]["destino_id"], c["propuesta"]["monto"])
      for c in doble.cuerpos(RUTA_PROPONER)], [(GILBERTO, SPIN, 20000)])
caso("AJUSTE: nada se confirma solo", RUTA_CONFIRMAR in doble.rutas(), False)

limpiar()
_, doble, _ = hablar("pase 5 mil de efectivo a spin", G.grabada("tr_2_pase"))
dichos, doble, _ = hablar("mejor spin", ruta("ajustar", {"cuenta_id": SPIN, "cuenta_nombre": "Cuenta Spin"}))
caso("AJUSTE SUELTO: no adivina de que lado", RUTA_PROPONER in doble.rutas(), False)
caso("AJUSTE SUELTO: lo pregunta", dijo(dichos, "origen o de destino"), True)
caso("AJUSTE SUELTO: la propuesta sigue viva", B._memoria.get(CHAT, {}).get("borrador_id"), UUID)

limpiar()
_, doble, _ = hablar("pase 5 mil de efectivo a spin", G.grabada("tr_2_pase"))
dichos, doble, _ = hablar("mejor al efectivo de Aeropuerto", ruta("ajustar", {
    "destino_oida": "efectivo de Aeropuerto"}))
caso("AJUSTE SIN UBICAR: no repropone con la cuenta vieja", RUTA_PROPONER in doble.rutas(), False)
caso("AJUSTE SIN UBICAR: dice que no la ubica", dijo(dichos, 'No ubico "efectivo de Aeropuerto"'), True)
caso("AJUSTE SIN UBICAR: la propuesta sigue viva", B._memoria.get(CHAT, {}).get("borrador_id"), UUID)

A_MEDIAS = {"monto": 500, "destino_id": SPIN, "destino_nombre": "Cuenta Spin"}
c = {"monto": 500, "origen_id": EFECTIVO, "origen_oida": "efectivo", "destino_id": SPIN}
E._aplica_lados_de_traspaso(c, cuentas, A_MEDIAS)
caso("A MEDIAS: el lado ya validado vale aunque el modelo lo repita sin oido",
     (c.get("origen_id"), c.get("destino_id")), (EFECTIVO, SPIN))
c = {"origen_id": EFECTIVO, "origen_oida": "efectivo", "destino_id": SPIN, "destino_oida": "la cuenta de kevin"}
E._aplica_lados_de_traspaso(c, cuentas, A_MEDIAS)
caso("A MEDIAS: si dijo otra cosa de ese lado, manda lo que dijo",
     (c.get("destino_id"), c.get("destino_oida")), (None, "la cuenta de kevin"))
c = {"origen_id": SPIN, "destino_id": EFECTIVO}
E._aplica_lados_de_traspaso(c, cuentas, A_MEDIAS)
caso("A MEDIAS: un lado que no estaba en la captura sigue sin creersele",
     (c.get("origen_id"), c.get("destino_id")), (None, None))
r = {"intencion": "traspaso", "campos": {"origen_id": EFECTIVO, "origen_oida": "efectivo", "destino_id": SPIN}}
caso("A MEDIAS: `enrutar` le pasa la captura al contraste",
     E.aplicar_catalogos(r, cuentas, [], A_MEDIAS)["campos"].get("destino_id"), SPIN)

# ═══ 6b. Doble dictado: dos dictados iguales no son dos traspasos en silencio ═
FRASE = "Transferencia de la cuenta de Gilberto a la Spin $25,000 pesos."
OTRO = "6b2f0c7e-2b64-4f0a-9c33-7d1e8b2f6a11"
SEGUNDO = {RUTA_PROPONER: (200, {"ok": True, "borrador_id": OTRO, "sello": "s3ll0-2",
                                 "mensaje": "TRASPASO ENTRE CUENTAS. Contesta VA."})}


def dictado(monto=25000, origen=GILBERTO, destino=SPIN, fecha=None):
    return ruta("traspaso", {"monto": monto, "origen_id": origen, "origen_nombre": "x",
                             "destino_id": destino, "destino_nombre": "y", "fecha": fecha})


def boton(u, fila):
    """El callback_data que de verdad se le ensena a la persona (`_lista_de` le ata
    su pregunta): un `dup:si` escrito a mano contesta YA_NO_ACTIVA."""
    return u.message.teclados[-1].inline_keyboard[fila][0].callback_data


limpiar()
hablar(FRASE, dictado())
dichos, doble, u = hablar(FRASE, dictado())
caso("DOBLE DICTADO: el segundo no propone", RUTA_PROPONER in doble.rutas(), False)
caso("DOBLE DICTADO: pregunta si es otro", dijo(dichos, "parece lo mismo", "Es otro traspaso?"), True)
caso("DOBLE DICTADO: el primero sigue vivo", UUID in B._pendientes[CHAT], True)
caso("DOBLE DICTADO: la pregunta queda en pantalla",
     B._memoria[CHAT].get("tipo"), "duplicado_eligiendo")
d = picar(boton(u, 1), PostDoble())
caso("DOBLE DICTADO: 'es el mismo' no agrega y deja vivo el primero",
     (UUID in B._pendientes[CHAT], dijo(d, "no lo agregue", "con su VA")), (True, True))
_, _, u = hablar(FRASE, dictado())
doble = PostDoble(SEGUNDO)
picar(boton(u, 0), doble)
caso("DOBLE DICTADO: 'es otro' si propone, una vez, con lo que dicto",
     [(c["propuesta"]["origen_id"], c["propuesta"]["destino_id"], c["propuesta"]["monto"])
      for c in doble.cuerpos(RUTA_PROPONER)], [(GILBERTO, SPIN, 25000)])
caso("DOBLE DICTADO: y quedan dos, cada uno con su VA", sorted(B._pendientes[CHAT]), sorted([UUID, OTRO]))
for nombre, otro in (("otro monto", dictado(monto=24000)), ("otro origen", dictado(origen=EFECTIVO)),
                     ("otro destino", dictado(destino=EFECTIVO)),
                     ("lados invertidos", dictado(origen=SPIN, destino=GILBERTO)),
                     ("otro dia", dictado(fecha="2026-01-02"))):
    limpiar()
    hablar(FRASE, dictado())
    _, doble, _ = hablar(FRASE, otro, PostDoble(SEGUNDO))
    caso("DOBLE DICTADO: " + nombre + " no se toma por el mismo", doble.rutas().count(RUTA_PROPONER), 1)
limpiar()
hablar(FRASE, dictado())
_, doble, _ = hablar("no, que sean 25 mil", ruta("ajustar", {"monto": 25000}))
caso("DOBLE DICTADO: un ajuste a lo mismo no se pregunta contra si mismo",
     doble.rutas().count(RUTA_PROPONER), 1)

# ═══ 7. Tras un reinicio el VA sigue siendo del traspaso ══════════════════════
limpiar()
rehidrato = PostDoble({"/api/bot/pendiente": (200, {"ok": True, "pendientes": [
    {"borrador_id": UUID, "sello": SELLO, "tipo": "traspaso", "creado_en": "2026-11-05T10:00:00"}]})})
d = picar("va:" + UUID, rehidrato)
caso("REHIDRATADO: el boton va a /traspaso/confirmar", RUTA_CONFIRMAR in rehidrato.rutas(), True)
caso("REHIDRATADO: con su sello", rehidrato.cuerpos(RUTA_CONFIRMAR)[0]["sello"], SELLO)

# ═══ 8. Regresion: no se come al abono ni al gasto ════════════════════════════
for clave, esperada in (("tr_8_no_abono", "abono"), ("tr_9_abono_con_cuenta", "abono"),
                        ("tr_10_no_gasto", "gasto")):
    caso("REGRESION: " + clave + " sigue siendo " + esperada,
         G.grabada(clave)["intencion"], esperada)
limpiar()
_, doble, _ = hablar("Aeropuerto me pago 5,000 por transferencia", G.grabada("tr_8_no_abono"))
caso("REGRESION: abono por transferencia no llama a traspaso",
     [r for r in doble.rutas() if "traspaso" in r], [])
caso("REGRESION: ...y si llama a su ruta de abono",
     any("abono" in r for r in doble.rutas()), True)
limpiar()
_, doble, _ = hablar("le transferi 3,000 a Solo Vidrio por las botellas", G.grabada("tr_10_no_gasto"))
caso("REGRESION: gasto por transferencia no llama a traspaso",
     [r for r in doble.rutas() if "traspaso" in r], [])
for clave in ("tr_2_pase", "tr_3_a_transferencias", "tr_4_desde_transferencias"):
    caso("VARIANTE: " + clave + " es traspaso", G.grabada(clave)["intencion"], "traspaso")
limpiar()

print("")
todo_bien = True
for nombre, obtenido, esperado in casos:
    bien = obtenido == esperado
    if not bien:
        todo_bien = False
    print("  [%s] %-70s  %s" % ("PASA" if bien else "FALLA", nombre,
                                "" if bien else "obtuve %r, esperaba %r" % (obtenido, esperado)))
print("")
print("RESULTADO:", "los %d casos pasan" % len(casos) if todo_bien else "HAY CASOS QUE FALLAN")
sys.exit(0 if todo_bien else 1)
