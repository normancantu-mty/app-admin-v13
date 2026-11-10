# -*- coding: utf-8 -*-
"""PREGUNTAS AL ERP DESDE EL BOT: el lado del bot (2026-11-07).

Escrito el 2026-11-07 por el ejecutor del Socio (bot con paridad de la web, Fase 2).

El servidor (`/api/bot/pregunta`) interpreta la pregunta sin modelo. Aqui se
prueba que el bot:
  - manda el texto tal cual a `/api/bot/pregunta` cuando el enrutador dice consulta;
  - si el servidor la reconoce, reenvia SU texto y no llama a `/api/bot/consulta`;
  - si no la reconoce y la consulta es conocida (stock), sigue a `/api/bot/consulta`;
  - si no la reconoce y es "otra", contesta el "no la puedo contestar con certeza"
    del servidor y NO la respuesta redactada por el modelo;
  - en modo ensayo, `/api/bot/pregunta` sale (es de solo lectura).

`_post` y `enrutar` doblados: ninguna peticion sale de este proceso.

Corre con:  python bot/probar_pregunta.py      (sin red, sin modelo)
"""
import asyncio
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["BOT_LOG"] = os.path.join(tempfile.gettempdir(), "probar_pregunta.log")

import bot_gastos as B  # noqa: E402


async def _alta_ok(update, clave):
    return True


B._puerta_de_privado = _alta_ok

CHAT = 555000777
UUID = "7c1f0c7e-2b64-4f0a-9c33-7d1e8b2f6a11"
UUID2 = "7c1f0c7e-2b64-4f0a-9c33-7d1e8b2f6a12"
SELLO = "s3ll0"
PROPONER = "/api/bot/gasto/proponer"
CONFIRMAR = "/api/bot/gasto/confirmar"
CUENTA = {"id": "c-spin", "nombre": "Cuenta Spin"}
MENSAJE = ("Esto es lo que voy a escribir. Revisalo:\n\nCUENTA:     Cuenta Spin (x)\n\n"
           "(la cuenta no la elige el modelo: sale de tu alta en Matriz, y si esta mal la cambias con el boton)\n\n"
           "Contesta VA para escribirlo, o dime que cambio.")
OPCIONES = [{"id": "i-guaj", "nombre": "Chile Guajillo"}, {"id": "i-guajon", "nombre": "Chile Guajon"}]

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
    def __init__(self, pregunta):
        self.llamadas = []
        self.pregunta = pregunta

    def __call__(self, ruta, cuerpo):
        self.llamadas.append((ruta, cuerpo))
        if ruta == "/api/bot/pendiente":
            return 200, {"ok": True, "pendientes": []}
        if ruta == "/api/bot/pregunta":
            return self.pregunta
        if ruta == "/api/bot/consulta":
            return 200, {"ok": True, "texto": "STOCK DE LA CONSULTA", "privado": False}
        return 200, {"ok": True}

    def rutas(self):
        return [r for r, c in self.llamadas]

    def cuerpos(self, ruta):
        return [c for r, c in self.llamadas if r == ruta]


def correr(corutina, doble, ruta_del_modelo):
    enrutar_original, post_original = B.enrutar, B._post
    B.enrutar = lambda *a, **kw: (True, dict(ruta_del_modelo))
    B._post = doble
    try:
        asyncio.run(corutina)
    finally:
        B.enrutar, B._post = enrutar_original, post_original


def limpiar():
    B._olvidar_chat(CHAT)
    B._memoria.pop(CHAT, None)
    B._pendientes.pop(CHAT, None)
    B._rehidratado.discard(CHAT)


def hablar(texto, doble, consulta, respuesta_del_modelo="Hay $12,345 en Spin"):
    ruta = dict(intencion="consulta", confianza="alta", entendido="x", campos={},
                consulta=consulta, filtro=None, respuesta=respuesta_del_modelo,
                hechos=[], faltantes=[], pregunta=None)
    u = UpdateDeTexto(CHAT, texto)
    limpiar()
    correr(B.manejar_texto(u, None), doble, ruta)
    return u.message.dichos


SALDO = (200, {"ok": True, "reconocida": True, "tipo": "saldo_cuenta",
               "texto": "Cuenta Spin: $300.00", "privado": False})
NO_SE = (200, {"ok": True, "reconocida": False, "motivo": "no_reconocida",
               "texto": "Esa no la puedo contestar con certeza, y no voy a adivinar una cifra."})

# === 1. Reconocida: el texto del servidor, y nada mas =========================
doble = PostDoble(SALDO)
dichos = hablar("cuanto hay en spin", doble, "otra")
caso("RECONOCIDA: el texto viaja tal cual a /api/bot/pregunta",
     doble.cuerpos("/api/bot/pregunta"), [{"telegram_id": CHAT, "texto": "cuanto hay en spin"}])
caso("RECONOCIDA: se contesta la cifra del servidor", dichos, ["Cuenta Spin: $300.00"])
caso("RECONOCIDA: no se llama a /api/bot/consulta", "/api/bot/consulta" in doble.rutas(), False)

# === 2. No reconocida + consulta conocida: sigue la consulta de siempre =======
doble = PostDoble(NO_SE)
dichos = hablar("cuantas botellas de 750 hay", doble, "stock")
caso("STOCK: no reconocida -> /api/bot/consulta", "/api/bot/consulta" in doble.rutas(), True)
caso("STOCK: se contesta lo de la consulta", dichos, ["STOCK DE LA CONSULTA"])

# === 3. No reconocida + "otra": honesto, y nunca la cifra del modelo ===========
doble = PostDoble(NO_SE)
dichos = hablar("cuanto hay en la cuenta de mi tia", doble, "otra")
caso("OTRA: dice que no la puede contestar con certeza",
     dichos, ["Esa no la puedo contestar con certeza, y no voy a adivinar una cifra."])
caso("OTRA: la cifra redactada por el modelo NO sale", any("12,345" in d for d in dichos), False)
caso("OTRA: no se llama a /api/bot/consulta", "/api/bot/consulta" in doble.rutas(), False)

# === 4. Sin permiso: el 403 del servidor ======================================
doble = PostDoble((403, {"error": "Esa consulta es de la empresa; tu alta solo alcanza a lo tuyo."}))
dichos = hablar("ventas de hoy", doble, "ventas")
caso("403: se dice el error del servidor",
     dichos, ["Esa consulta es de la empresa; tu alta solo alcanza a lo tuyo."])

# === 5. La ruta falla: se dice, y NO sigue a /consulta ni al modelo ===========
# Fase 5 (auditoria 2026-11-07): antes un 500 devolvia False y el respaldo
# `_responder_natural` podia mandar la cifra redactada por el modelo.
NO_PUDE = "No pude leer el dato del ERP ahora; intenta de nuevo."
for etiqueta, falla in (("500", (500, {"error": "Error interno."})),
                        ("TIMEOUT", (0, {"error": "no pude hablarle al ERP: timed out"}))):
    for consulta in ("otra", "stock"):
        doble = PostDoble(falla)
        dichos = hablar("cuanto hay en spin", doble, consulta)
        caso("%s (%s): dice que no pudo leer" % (etiqueta, consulta), dichos, [NO_PUDE])
        caso("%s (%s): no llama a /api/bot/consulta" % (etiqueta, consulta),
             "/api/bot/consulta" in doble.rutas(), False)
        caso("%s (%s): la cifra del modelo NO sale" % (etiqueta, consulta),
             any("12,345" in d for d in dichos), False)

# === 6. Fase 6: "¿cual de ellos?" con botones, y el clic vuelve a preguntar ===
ID_GIL = "11111111-2222-4333-8444-555555555555"
ID_GF = "11111111-2222-4333-8444-666666666666"
AMBIGUO = (200, {"ok": True, "reconocida": False, "motivo": "cliente_ambiguo", "para": "movimientos",
                 "texto": "¿Cual de ellos? Gilberto Franco, Gilberto Ruiz.",
                 "opciones": [{"id": ID_GIL, "nombre": "Gilberto Franco"}, {"id": ID_GF, "nombre": "Gilberto Ruiz"}]})
doble = PostDoble(AMBIGUO)
u = UpdateDeTexto(CHAT, "movimientos de gilberto")
limpiar()
correr(B.manejar_texto(u, None), doble, dict(intencion="consulta", confianza="alta", entendido="x", campos={},
                                             consulta="cartera", filtro="gilberto", respuesta="Debe $9,999",
                                             hechos=[], faltantes=[], pregunta=None))
teclado = u.message.teclados[-1] if u.message.teclados else None
datos = [b.callback_data for fila in (teclado.inline_keyboard if teclado else []) for b in fila]
caso("AMBIGUO: se pregunta cual, con el texto del servidor", u.message.dichos, ["¿Cual de ellos? Gilberto Franco, Gilberto Ruiz."])
caso("AMBIGUO: un boton por candidato, pqm:<uuid>", datos, ["pqm:" + ID_GIL, "pqm:" + ID_GF])
caso("AMBIGUO: callback_data cabe en 64 bytes", all(len(d.encode("utf-8")) <= 64 for d in datos), True)
caso("AMBIGUO: NO sigue a /api/bot/consulta (aunque la consulta sea cartera)", "/api/bot/consulta" in doble.rutas(), False)
caso("AMBIGUO: la cifra del modelo NO sale", any("9,999" in d for d in u.message.dichos), False)

MOVS = (200, {"ok": True, "reconocida": True, "tipo": "movimientos_cliente",
              "texto": "ULTIMOS MOVIMIENTOS — Gilberto Franco (DST)", "privado": False})
doble = PostDoble(MOVS)
ub = UpdateDeBoton(CHAT, "pqm:" + ID_GIL)
limpiar()
correr(B.manejar_boton(ub, None), doble, {})
caso("BOTON: vuelve a /api/bot/pregunta con la eleccion",
     doble.cuerpos("/api/bot/pregunta"), [{"telegram_id": CHAT, "eleccion": {"para": "movimientos", "id_entidad": ID_GIL}}])
caso("BOTON: contesta el texto del servidor", ub.callback_query.message.dichos, ["ULTIMOS MOVIMIENTOS — Gilberto Franco (DST)"])
caso("BOTON: no escribe (ninguna ruta de proponer/confirmar)",
     [r for r in doble.rutas() if "proponer" in r or "confirmar" in r], [])
doble = PostDoble(MOVS)
ub = UpdateDeBoton(CHAT, "pqd:" + ID_GF)
limpiar()
correr(B.manejar_boton(ub, None), doble, {})
caso("BOTON pqd: la eleccion es de deuda",
     [c.get("eleccion") for c in doble.cuerpos("/api/bot/pregunta")], [{"para": "deuda", "id_entidad": ID_GF}])

# Acotada (un DST/LOC): el servidor no la contesta con todo; sigue la consulta de su red.
ACOTADA = (200, {"ok": True, "reconocida": False, "motivo": "acotada", "texto": "Esa la contesto con lo de tu alta"})
doble = PostDoble(ACOTADA)
dichos = hablar("cuanto debo", doble, "cartera")
caso("ACOTADA + cartera: sigue a /api/bot/consulta", "/api/bot/consulta" in doble.rutas(), True)

# === 7. Ensayo ================================================================
caso("ENSAYO: /api/bot/pregunta sale (solo lectura)",
     B.decision_de_ensayo("/api/bot/pregunta"), "sale_marcada")
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
