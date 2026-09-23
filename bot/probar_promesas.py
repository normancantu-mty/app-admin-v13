# -*- coding: utf-8 -*-
"""LO QUE FALLO DELANTE DE NORMAN. **D48 · D49 · D50 (Fase 6).**

─── DE DONDE SALE CADA CASO ────────────────────────────────────────────────────

**Ninguno de los tres sale de leer codigo.** Los tres salen de una conversacion
real del 2026-09-19, con el codigo de la Fase 5 ya cargado y 744 pruebas en
verde. Las frases de abajo son las de la transcripcion, no versiones limpias.

  D48 — LA PROMESA INCUMPLIDA, y es el peor de la tanda:
        Norman: tienes pensado Aplicar el envio como un gasto?
        Bot:    Si, el envio se captura como gasto en Logistica_Envios, y no
                importa en que orden lo hagas.
        Bot:    Listo. Quedo escrita.
        Norman: Y luego el gasto?, No lo has escrito o si?
        Medido contra `finanzas_ledger`: **la fila de $45 no existe.**

  D49 — EL SEGUNDO HECHO, TIRADO EN SILENCIO:
        «Se acaba de vender una botella grande de 599 pesos... y de envio fueron
        45 pesos» son una venta Y un gasto. Se escribio uno y se perdio el otro
        sin decir nada. Norman solo lo descubrio porque pregunto.

  D50 — LA MEMORIA DEL CLIENTE:
        Norman: cotizame para **el mismo cliente** 35 grandes, 43 chicas...
        Bot:    No tengo a "el mismo cliente" en la red.
        Tres mensajes antes habia cotizado a Aeropuerto.

─── COMO SE MIDE ───────────────────────────────────────────────────────────────

El modelo esta doblado y la tuberia corre de verdad, igual que en
`probar_conversacion.py`. Eso no mide si el modelo clasifica bien --para eso
esta la pasada en Telegram del informe-- sino que **lo que el modelo devuelve no
se convierta en una mentira al salir a pantalla**, que es exactamente donde
estaba el defecto: el 2026-09-19 el enrutador acerto la intencion y la
conversacion fracaso igual.

Corre con:  python bot/probar_promesas.py
"""
import asyncio
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# D46: el log va a un temporal. ANTES del import; ver `probar_log.py`.
os.environ.setdefault(
    "BOT_LOG", os.path.join(tempfile.gettempdir(), "probar_bot.log"))

import bot_gastos as B  # noqa: E402
import grabar_enrutador as G  # noqa: E402

CHAT = 444333222
UUID = "1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9"

casos = []


def caso(nombre, obtenido, esperado, detalle=""):
    casos.append((nombre, obtenido, esperado, detalle))


class MensajeFalso(object):
    def __init__(self, chat_id, texto=""):
        self.chat = type("Chat", (), {"id": chat_id, "send_action": None})()
        self.chat.send_action = self._nada
        self.text = texto
        self.dichos = []

    async def _nada(self, *a, **kw):
        return None

    async def reply_text(self, texto, **kw):
        self.dichos.append(str(texto))
        return None

    async def send_action(self, _a):
        return None


class UpdateDeTexto(object):
    def __init__(self, chat_id, texto):
        self.message = MensajeFalso(chat_id, texto)

    @property
    def effective_message(self):
        return self.message

    @property
    def effective_chat(self):
        return self.message.chat


class PostDoble(object):
    def __init__(self, respuestas=None):
        self.llamadas = []
        self.respuestas = respuestas or {}

    def __call__(self, ruta, cuerpo):
        self.llamadas.append((ruta, cuerpo))
        if ruta == "/api/bot/catalogo":
            return 200, {"ok": True, "productos": [
                {"id": "c1000000-0000-0000-0000-000000000001",
                 "sku": "plata-750ml", "nombre": "Destilado Plata 750ml",
                 "ml_por_unidad": 750}]}
        return self.respuestas.get(ruta, (500, {"error": "No pude proponerlo."}))

    def rutas(self):
        return [r for r, _ in self.llamadas]

    def cuerpo_de(self, ruta):
        for r, c in self.llamadas:
            if r == ruta:
                return c
        return None


def hablar(texto, ruta_del_modelo, respuestas=None, preparar=None):
    u = UpdateDeTexto(CHAT, texto)
    doble = PostDoble(respuestas)
    enrutar_original, post_original = B.enrutar, B._post

    def enrutar_doble(*a, **kw):
        return True, dict(ruta_del_modelo)

    B.enrutar, B._post = enrutar_doble, doble
    try:
        if preparar:
            preparar()
        asyncio.run(B.manejar_texto(u, None))
    finally:
        B.enrutar, B._post = enrutar_original, post_original
    return u.message.dichos, doble


def limpiar():
    B._memoria.pop(CHAT, None)
    B._ultimo_cliente.pop(CHAT, None)
    B._ultima_cotizacion.pop(CHAT, None)
    B._esperando_monto.pop(CHAT, None)
    B._esperando_vigencia.pop(CHAT, None)
    B._esperando_correccion.pop(CHAT, None)


VENTA_OK = {"/api/bot/venta/proponer": (200, {
    "ok": True, "borrador_id": UUID, "sello": "s3ll0",
    "mensaje": "Esto es lo que voy a escribir. Revisalo:\nTOTAL: $599.00"})}

COTIZACION_OK = {"/api/bot/cotizacion/proponer": (200, {
    "ok": True, "borrador_id": UUID, "sello": "s3ll0",
    "mensaje": "Esta es la cotizacion. Revisala:\nTOTAL: $10,176.00",
    "para_quien": "Aeropuerto", "es_de_la_red": True, "clientes": []})}


# ═══════════════ D48 — EL BOT NO PROMETE NADA QUE HARA DESPUES ═══════════════
#
# La frase de abajo es LA de la transcripcion, palabra por palabra. Si algun dia
# vuelve a salir a pantalla, esta prueba se pone roja.

LA_PROMESA = ("Si, el envio se captura como gasto en Logistica_Envios, "
              "y no importa en que orden lo hagas.")

limpiar()
dichos, _ = hablar(
    "tienes pensado Aplicar el envio como un gasto?",
    dict(intencion="charla", confianza="alta", entendido="pregunta por el envio",
         campos={}, respuesta=LA_PROMESA))

caso("VERDE - la frase EXACTA del 2026-09-19 no vuelve a salir a pantalla",
     [d for d in dichos if "se captura" in d], [], str(dichos))
caso("VERDE - ...y en su lugar dice que NO lo ha escrito",
     dichos, [B.SIN_COLA])

# Las otras formas de prometer. Todas son de escrituras de dinero.
PROMESAS = [
    "Si, el envio se captura como gasto en Logistica_Envios.",
    "Listo, lo voy a registrar en un momento.",
    "Queda registrado el envio de 45 pesos.",
    "Se aplica como gasto, no te preocupes.",
    "Ahorita lo meto como gasto.",
    "Voy a capturar el gasto del envio.",
    "El gasto se guarda despues de la venta.",
    "No importa en que orden lo hagas.",
]
coladas = []
for promesa in PROMESAS:
    limpiar()
    dichos, _ = hablar("y el envio?", dict(intencion="charla", confianza="alta",
                                           entendido="x", campos={},
                                           respuesta=promesa))
    if dichos != [B.SIN_COLA]:
        coladas.append((promesa, dichos))
caso("VERDE - ninguna de las %d formas de prometer llega a pantalla" % len(PROMESAS),
     coladas, [], "")

# ── CONTROL NEGATIVO, y es el que le da valor a todo lo de arriba ────────────
#    Si el filtro reemplazara SIEMPRE, el bot dejaria de conversar y las
#    aserciones de arriba pasarian igual. Una respuesta sana tiene que pasar
#    intacta, incluso hablando de gastos y de dinero.
SANAS = [
    "Aqui ando. Que hiciste hoy?",
    "Ese gasto no lo he escrito. Dimelo y lo capturo.",
    "El envio de 45 pesos no entro en la venta.",
    "Hoy llevas tres gastos capturados.",
    "Va, te la armo.",
]
mordidas = []
for sana in SANAS:
    limpiar()
    dichos, _ = hablar("algo", dict(intencion="charla", confianza="alta",
                                    entendido="x", campos={}, respuesta=sana))
    if dichos != [sana]:
        mordidas.append((sana, dichos))
caso("ROJO  - una respuesta sana pasa INTACTA (el filtro no muerde de mas)",
     mordidas, [], "")

# Y el gemelo, sobre la funcion pelada: el detector tiene que reconocer la
# frase original. Sin esto, un regex que no casara con nada daria verde arriba.
caso("ROJO  - el detector reconoce la frase original del incidente",
     B._sin_promesas(LA_PROMESA), B.SIN_COLA, "")


# ═══════════════ D49 — EL SEGUNDO HECHO NO SE PIERDE EN SILENCIO ═════════════
#
# El mensaje de Norman, textual, con sus dos hechos: una venta de $599 y un
# envio de $45. Medido contra produccion: la fila de $45 nunca existio.

EL_MENSAJE = ("Se acaba de vender una botella grande de 599 pesos, lo enviamos "
              "a domicilio y nosotros absorbimos el costo del envio y de envio "
              "fueron 45 pesos.")

limpiar()
dichos, doble = hablar(
    EL_MENSAJE,
    dict(intencion="venta", confianza="alta", entendido="una venta y un envio",
         campos={"productos": [{"producto": "750 ml", "cantidad": 1,
                                "id_producto": "c1000000-0000-0000-0000-000000000001"}]},
         respuesta="Va.",
         otro_hecho={"tipo": "gasto", "monto": 45,
                     "descripcion": "un envio a domicilio"}),
    respuestas=VENTA_OK)

caso("VERDE - la venta SI se propone",
     "/api/bot/venta/proponer" in doble.rutas(), True, str(doble.rutas()))
caso("VERDE - y el envio de $45 queda constancia en la respuesta",
     any("45" in d and "no lo escribi" in d.lower() for d in dichos), True,
     str(dichos))
caso("VERDE - ...diciendo que NO se escribio",
     any("NO lo escribi todavia" in d for d in dichos), True, str(dichos))

# **El gasto NO se escribe solo.** Decirlo es el alcance; encolarlo no lo es, y
# escribir dinero que Norman no vio propuesto va contra el diseno de sellos.
caso("VERDE - pero el gasto NO se escribe solo: cero llamadas a gasto/proponer",
     [r for r in doble.rutas() if "gasto" in r], [], str(doble.rutas()))

# ── CONTROL NEGATIVO: un mensaje con UN solo hecho no inventa un segundo ────
limpiar()
dichos, doble = hablar(
    "vendi una botella de 750",
    dict(intencion="venta", confianza="alta", entendido="una venta",
         campos={"productos": [{"producto": "750 ml", "cantidad": 1,
                                "id_producto": "c1000000-0000-0000-0000-000000000001"}]},
         respuesta="Va.", otro_hecho=None),
    respuestas=VENTA_OK)
caso("ROJO  - con un solo hecho NO se inventa un segundo",
     [d for d in dichos if "Tambien oi" in d], [], str(dichos))

# ── CONTROL NEGATIVO: el ECO del primer hecho no se menciona ────────────────
#    Si el modelo repite la venta dentro de `otro_hecho`, el bot escribiria la
#    venta y acto seguido diria que no la escribio. Eso es una mentira NUEVA.
limpiar()
dichos, _ = hablar(
    "vendi una de 750 en 599",
    dict(intencion="venta", confianza="alta", entendido="x",
         campos={"productos": [{"producto": "750 ml", "cantidad": 1,
                                "id_producto": "c1000000-0000-0000-0000-000000000001"}]},
         respuesta="Va.",
         otro_hecho={"tipo": "venta", "monto": 599, "descripcion": "la botella"}),
    respuestas=VENTA_OK)
caso("ROJO  - un `otro_hecho` que repite la intencion NO se menciona",
     [d for d in dichos if "Tambien oi" in d], [], str(dichos))

# ── CONTROL NEGATIVO: basura en `otro_hecho` no llega a pantalla ────────────
for basura in [{"tipo": "brujeria", "monto": 45, "descripcion": "algo"},
               {"tipo": "gasto", "monto": 45, "descripcion": ""},
               {"tipo": "gasto", "monto": -45, "descripcion": "un envio"},
               "no soy un objeto", None]:
    limpiar()
    dichos, _ = hablar(
        "vendi una de 750",
        dict(intencion="venta", confianza="alta", entendido="x",
             campos={"productos": [{"producto": "750 ml", "cantidad": 1,
                                    "id_producto": "c1000000-0000-0000-0000-000000000001"}]},
             respuesta="Va.", otro_hecho=basura),
        respuestas=VENTA_OK)
    sucias = [d for d in dichos if "brujeria" in d or "-45" in d]
    if sucias:
        caso("ROJO  - basura en otro_hecho (%r)" % (basura,), sucias, [], "")
caso("ROJO  - nada de la basura de `otro_hecho` llego a pantalla",
     len([c for c in casos if c[0].startswith("ROJO  - basura")]), 0, "")

# Un monto negativo se cae, pero la descripcion sobrevive: se dice el hecho sin
# inventarle una cifra. Callarse por un monto raro seria volver al silencio.
caso("VERDE - sin monto valido, se menciona el hecho SIN cifra",
     B._frase_de_hecho_suelto({"tipo": "gasto", "monto": None,
                               "descripcion": "un envio"}),
     "Tambien oi un envio, que es un gasto. Ese NO lo escribi todavia. "
     "Dimelo y lo capturo.", "")


# ═══════════════ D50 — "EL MISMO CLIENTE" ════════════════════════════════════

def cotizar(texto, campos, respuestas=COTIZACION_OK):
    return hablar(texto, dict(intencion="cotizacion", confianza="alta",
                              entendido="x", campos=campos, respuesta="Va."),
                  respuestas=respuestas)


DOS_RENGLONES = [{"producto": "750 ml", "cantidad": 12,
                  "id_producto": "c1000000-0000-0000-0000-000000000001"}]

# 1. Se cotiza a Aeropuerto...
limpiar()
cotizar("cotizale 12 de 750 a aeropuerto",
        {"productos": DOS_RENGLONES, "cliente": "Aeropuerto"})
caso("VERDE - despues de cotizar, el bot recuerda a Aeropuerto",
     B._cliente_recordado(CHAT), "Aeropuerto", "")

# 2. ...y "el mismo cliente" resuelve a Aeropuerto Y LO NOMBRA.
#
# D66 (Fase 7): la salida del modelo YA NO se escribe a mano. Hasta aqui esta
# linea era `{"cliente": "el mismo cliente"}` tecleado, y el modelo real no
# emitia eso: la prueba paso verde toda la Fase 6 con D50 roto (auditoria
# §12.4). Ahora es lo que el modelo REAL contesto a la frase, grabado con el md5
# del PROMPT; si el PROMPT cambia, `grabada` falla y pide volver a grabar.
D50_1 = G.cargar()["frases"]["d50_1_mismo_cliente"]
dichos, doble = hablar(D50_1["texto"], G.grabada("d50_1_mismo_cliente"),
                       respuestas=COTIZACION_OK)
cuerpo = doble.cuerpo_de("/api/bot/cotizacion/proponer") or {}
caso("VERDE - `el mismo cliente` viaja a la ruta como Aeropuerto",
     cuerpo.get("cliente"), "Aeropuerto", str(cuerpo)[:160])
caso("VERDE - ...y el bot lo DICE, no lo resuelve callado",
     any("Aeropuerto" in d and "el ultimo que cotizaste" in d for d in dichos),
     True, str(dichos))

# Las otras formas de decirlo.
for forma in ["el mismo", "para el mismo", "al mismo", "el anterior", "para el"]:
    _, doble = cotizar("cotizame 12 de 750",
                       {"productos": DOS_RENGLONES, "cliente": forma})
    cuerpo = doble.cuerpo_de("/api/bot/cotizacion/proponer") or {}
    if cuerpo.get("cliente") != "Aeropuerto":
        caso("VERDE - `%s` resuelve a Aeropuerto" % forma,
             cuerpo.get("cliente"), "Aeropuerto", "")
caso("VERDE - las 5 formas de decir `el mismo` resuelven a Aeropuerto",
     len([c for c in casos if c[0].startswith("VERDE - `") and "resuelve a" in c[0]]),
     0, "")

# D66: y las cinco frases de la auditoria (§8.1), con lo que el modelo REAL
# emitio para cada una, por la tuberia entera.
for clave in ("d50_1_mismo_cliente", "d50_2_olvidalo_textual", "d50_3_al_mismo",
              "d50_4_mismo_distribuidor", "d50_5_al_anterior"):
    limpiar()
    cotizar("cotizale 12 de 750 a aeropuerto",
            {"productos": DOS_RENGLONES, "cliente": "Aeropuerto"})
    grabada = G.grabada(clave)
    _, doble = hablar(G.cargar()["frases"][clave]["texto"], grabada,
                      respuestas=COTIZACION_OK)
    cuerpo = doble.cuerpo_de("/api/bot/cotizacion/proponer") or {}
    caso("VERDE - grabacion real %s (cliente %r) resuelve a Aeropuerto"
         % (clave, (grabada.get("campos") or {}).get("cliente")),
         cuerpo.get("cliente"), "Aeropuerto", str(doble.rutas()))

# ── CONTROL NEGATIVO 1: como PRIMER mensaje del chat, sigue preguntando ─────
limpiar()
dichos, doble = cotizar("cotizame para el mismo cliente 12 de 750",
                        {"productos": DOS_RENGLONES, "cliente": "el mismo cliente"})
cuerpo = doble.cuerpo_de("/api/bot/cotizacion/proponer") or {}
caso("ROJO  - sin memoria, `el mismo cliente` NO se inventa un cliente",
     cuerpo.get("cliente"), "el mismo cliente", str(cuerpo)[:160])
caso("ROJO  - ...y no dice que lo resolvio de memoria",
     [d for d in dichos if "el ultimo que cotizaste" in d], [], str(dichos))

# ── CONTROL NEGATIVO 2: pasado el vencimiento, pregunta ─────────────────────
limpiar()
cotizar("cotizale 12 de 750 a aeropuerto",
        {"productos": DOS_RENGLONES, "cliente": "Aeropuerto"})
B._ultimo_cliente[CHAT]["en"] -= (B.VIDA_DEL_CLIENTE + 60)
caso("ROJO  - pasado el vencimiento, la memoria del cliente caduca",
     B._cliente_recordado(CHAT), "", "")
_, doble = cotizar("cotizame para el mismo cliente 12 de 750",
                   {"productos": DOS_RENGLONES, "cliente": "el mismo cliente"})
cuerpo = doble.cuerpo_de("/api/bot/cotizacion/proponer") or {}
caso("ROJO  - ...y `el mismo cliente` vuelve a preguntarse",
     cuerpo.get("cliente"), "el mismo cliente", "")

# ── CONTROL NEGATIVO 3: un nombre de verdad NO se pisa con el recordado ─────
#    Es el que impide el dano caro: mandarle la cotizacion al distribuidor que
#    no era porque el bot decidio que "el mismo" le ganaba a lo que se dijo.
limpiar()
cotizar("cotizale 12 de 750 a aeropuerto",
        {"productos": DOS_RENGLONES, "cliente": "Aeropuerto"})
_, doble = cotizar("cotizale 12 de 750 a Casa Verde",
                   {"productos": DOS_RENGLONES, "cliente": "Casa Verde"})
cuerpo = doble.cuerpo_de("/api/bot/cotizacion/proponer") or {}
caso("ROJO  - un nombre dicho NO lo pisa la memoria",
     cuerpo.get("cliente"), "Casa Verde", str(cuerpo)[:160])


# ═══════════════ D51 — EL MONTO OBJETIVO LLEGA A LA RUTA ═════════════════════
#
# La aritmetica se prueba en `tests/bot-cotizacion.spec.ts` (`escalarAObjetivo`).
# Lo que se mide aqui es el CABLE: que el bot recupere de que cotizacion se esta
# hablando y mande el objetivo. Sin este cable, la funcion queda perfecta y
# muerta -- que es como se colo D30.

limpiar()
cotizar("cotizale 12 de 750 a aeropuerto",
        {"productos": DOS_RENGLONES, "cliente": "Aeropuerto"})
dichos, doble = cotizar(
    "ahora una cuyo total sea lo mas cercano a 15,000, manteniendo la proporcion",
    {"monto_objetivo": 15000})
cuerpo = doble.cuerpo_de("/api/bot/cotizacion/proponer") or {}
caso("VERDE - un objetivo sin renglones reusa la cotizacion anterior",
     len(cuerpo.get("productos") or []), 1, str(cuerpo)[:200])
caso("VERDE - ...y manda el objetivo a la ruta",
     cuerpo.get("objetivo"), 15000.0, str(cuerpo)[:200])
caso("VERDE - ...y sigue siendo para el mismo cliente, dicho en voz alta",
     cuerpo.get("cliente") == "Aeropuerto"
     and any("Aeropuerto" in d for d in dichos), True, str(dichos))

# ── CONTROL NEGATIVO: sin cotizacion anterior, no se inventa ninguna ────────
limpiar()
dichos, doble = cotizar("hazme una de unos 15 mil", {"monto_objetivo": 15000})
caso("ROJO  - sin cotizacion anterior, NO se propone nada",
     "/api/bot/cotizacion/proponer" in doble.rutas(), False, str(doble.rutas()))
caso("ROJO  - ...y se pregunta que cotizar",
     dichos, ["Que le cotizo?"])

# ── D67 (Fase 7): el objetivo que VINO y no sirve SE DICE ─────────────────
#    Salida REAL del modelo (grabacion d67_objetivo_cero): a "ahora una que
#    salga en 0 pesos" emite `monto_objetivo: 0`. Hasta hoy eso era identico a
#    "no pidio objetivo" y la cotizacion salia sin escalar, callada.
limpiar()
cotizar("cotizale 12 de 750 a aeropuerto",
        {"productos": DOS_RENGLONES, "cliente": "Aeropuerto"})
D67_CERO = G.cargar()["frases"]["d67_objetivo_cero"]
dichos, doble = hablar(D67_CERO["texto"], G.grabada("d67_objetivo_cero"),
                       respuestas=COTIZACION_OK)
cuerpo = doble.cuerpo_de("/api/bot/cotizacion/proponer") or {}
caso("VERDE - D67: un objetivo de 0 (salida real) se DICE",
     [d for d in dichos if d.startswith("No entendi el monto objetivo (0)")] != [],
     True, str(dichos))
caso("VERDE - D67: ...y se cotiza sin escalar (el objetivo no viaja)",
     ("objetivo" in cuerpo, len(cuerpo.get("productos") or [])), (False, 1),
     str(cuerpo)[:200])
# Y sin cotizacion anterior NO promete cotizar: la regla 16 vale para el bot.
B._ultima_cotizacion.pop(CHAT, None)
dichos, doble = hablar(D67_CERO["texto"], G.grabada("d67_objetivo_cero"),
                       respuestas=COTIZACION_OK)
caso("VERDE - D67: sin cotizacion anterior dice 'no entendi' y NO promete cotizar",
     ([d for d in dichos if d.startswith("No entendi el monto objetivo (0)")] != [],
      [d for d in dichos if "Te cotizo" in d],
      "/api/bot/cotizacion/proponer" in doble.rutas()),
     (True, [], False), str(dichos))
# CONTROL NEGATIVO: un objetivo bueno NO dispara el aviso.
limpiar()
cotizar("cotizale 12 de 750 a aeropuerto",
        {"productos": DOS_RENGLONES, "cliente": "Aeropuerto"})
dichos, _ = cotizar("ahora una de unos 15 mil", {"monto_objetivo": 15000})
caso("ROJO  - D67: un objetivo que sirve no dice 'no entendi'",
     [d for d in dichos if "No entendi el monto objetivo" in d], [], str(dichos))
# CONTROL NEGATIVO: sin objetivo, tampoco.
limpiar()
dichos, _ = cotizar("cotizale 12 de 750 a aeropuerto",
                    {"productos": DOS_RENGLONES, "cliente": "Aeropuerto"})
caso("ROJO  - D67: sin objetivo no dice 'no entendi'",
     [d for d in dichos if "No entendi el monto objetivo" in d], [], str(dichos))
# La funcion, en la frontera: que vino, que no.
caso("VERDE - D67: _objetivo_que_no_sirve distingue ausente de invalido",
     [B._objetivo_que_no_sirve(c) for c in (
         {}, {"monto_objetivo": None}, {"monto_objetivo": ""},
         {"monto_objetivo": 0}, {"monto_objetivo": -500}, {"monto_objetivo": "abc"},
         {"monto_objetivo": 15000})],
     [None, None, None, "0", "-500", "abc", None], "")

# ── CONTROL NEGATIVO: un objetivo basura no viaja ───────────────────────────
limpiar()
cotizar("cotizale 12 de 750 a aeropuerto",
        {"productos": DOS_RENGLONES, "cliente": "Aeropuerto"})
for malo in ["abc", -100, 0, None, 9999999]:
    _, doble = cotizar("cotizame 12 de 750",
                       {"productos": DOS_RENGLONES, "monto_objetivo": malo})
    cuerpo = doble.cuerpo_de("/api/bot/cotizacion/proponer") or {}
    if "objetivo" in cuerpo:
        caso("ROJO  - objetivo basura %r no viaja" % (malo,), cuerpo.get("objetivo"),
             None, "")
caso("ROJO  - ningun objetivo basura llego a la ruta",
     len([c for c in casos if c[0].startswith("ROJO  - objetivo basura")]), 0, "")


print("")
todo_bien = True
for nombre, obtenido, esperado, detalle in casos:
    bien = obtenido == esperado
    if not bien:
        todo_bien = False
    print("  [%s] %-64s  %s" % ("PASA" if bien else "FALLA", nombre,
                                detalle if bien else "obtuve %r, esperaba %r"
                                % (obtenido, esperado)))
print("")
print("RESULTADO:", "los %d casos pasan" % len(casos) if todo_bien
      else "HAY CASOS QUE FALLAN")
sys.exit(0 if todo_bien else 1)
