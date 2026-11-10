# -*- coding: utf-8 -*-
"""2026-11-08 -- LA FOTO DE UNA FACTURA/COTIZACION DE VARIAS LINEAS.

Escrito el 2026-11-08 por el ejecutor del Socio (bot: compra desde foto, multilinea).

Corre `manejar_foto` de verdad con la salida REAL grabada del OCR sobre la
COTIZACION 95691 de Solo Vidrio (`grabaciones_ocr.json`, caso
`cotizacion_95691`, sin datos bancarios). El servidor se dobla: lo que se mide
es lo que el BOT manda y ensena. El empate linea -> insumo, el cuadre, el IVA y
la regla del corcho se prueban del lado del servidor en
`tests/bot-compra-documento.spec.ts`.

Lo que se exige, y lo que lo tumbaria:
  (a) la foto con renglones va a `compra-documento/proponer` con las 6 lineas,
      subtotal, IVA y total; NO va al gasto de siempre.
  (b) se ensena UN resumen con un boton por cuenta; sin clic no sale ningun
      /confirmar, y un "va" escrito tampoco confirma.
  (c) el clic en una cuenta confirma ESE borrador con ESA cuenta, una vez, y la
      foto queda ligada al movimiento.
  (d) si no cuadra: se dice, no hay botones de cuenta, no se escribe.
  (e) una linea desconocida se pregunta con botones (insumos + "Gasto"); la
      respuesta vuelve a proponer con la eleccion.
  (f) si el servidor dice `caer_a_gasto` (o no contesta), sigue el gasto de siempre.
  (g) el fixture no trae CLABE ni numeros de 18 digitos.
  Ronda 2 (auditoria 2026-11-08):
  (h) si todo acaba en "Gasto", el gasto de siempre de ESE ticket (no un callejon).
  (i) cuadra sin preguntas ni borrador: nunca un resumen sin botones.
  (j) las dudas del OCR viajan como TEMAS (lista cerrada) y la bandera de instrucciones.
  (k) en un grupo: persona y grupo separados, rotulo, el clic de otro no escribe.

Corre con:  python bot/probar_compra_documento.py      (sin red, sin modelo)
"""
import asyncio
import io
import json
import os
import re
import shutil
import sys
import tempfile

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)
CARPETA = tempfile.mkdtemp(prefix="probar_compra_doc_")
os.environ["BOT_COMPROBANTES"] = os.path.join(CARPETA, "comprobantes")
os.environ["BOT_GRUPOS_SILENCIOSOS"] = os.path.join(CARPETA, "silenciosos.json")
os.environ.setdefault("BOT_LOG", os.path.join(tempfile.gettempdir(), "probar_bot.log"))
os.environ.pop("BOT_ENSAYO", None)
os.environ.pop("COMPROBANTES_EN_SUPABASE", None)

import bot_gastos as B  # noqa: E402
import comprobantes as C  # noqa: E402
import grabar_ocr as G  # noqa: E402
import ocr_ticket as O  # noqa: E402

NORMAN = B.NORMAN_TELEGRAM_ID
BOT_ID = 999
BID = "11111111-2222-4333-8444-555555555555"
BID2 = "99999999-8888-4777-8666-555555555555"
ID_MOV = "dddddddd-1111-4222-8333-444444444444"
CUENTAS = [{"id": "c-ef", "nombre": "Efectivo"}, {"id": "c-spin", "nombre": "Cuenta Spin"}]
GRABADO = G.cargar()
RUTA_P = "/api/bot/compra-documento/proponer"
RUTA_C = "/api/bot/compra-documento/confirmar"

casos = []


def caso(nombre, obtenido, esperado):
    casos.append((nombre, obtenido, esperado))


class Servidor(object):
    def __init__(self):
        self.llamadas = []
        self.respuestas = {}

    def __call__(self, ruta, cuerpo):
        self.llamadas.append((ruta, json.loads(json.dumps(cuerpo))))
        if ruta == "/api/bot/identidad":
            return 200, {"ok": True, "registrado": True, "nombre": "Norman", "rol": "ADMIN",
                         "requiere_aprobacion": False, "aprobador": True}
        if ruta == "/api/bot/catalogo":
            return 200, {"ok": True, "productos": ["x"], "categorias": G.catalogo()}
        cola = self.respuestas.get(ruta) or [(200, {"ok": True})]
        estado, obj = cola.pop(0) if len(cola) > 1 else cola[0]
        return estado, dict(obj)

    def a(self, ruta):
        return [c for r, c in self.llamadas if r == ruta]

    def escrituras(self):
        return [(r, c) for r, c in self.llamadas if r.endswith("/confirmar")]


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
        self.type = "supergroup" if cid < 0 else "private"

    async def send_action(self, _a):
        return None


class Archivo(object):
    def __init__(self, datos):
        self.datos = datos

    async def download_as_bytearray(self, **k):
        return bytearray(self.datos)


class Tamano(object):
    def __init__(self, fid):
        self.file_id = fid
        self.file_unique_id = fid + "-u"


class Mensaje(object):
    def __init__(self, chat, texto="", de=None, foto=False, bot=False):
        _ids[0] += 1
        self.message_id = _ids[0]
        self.chat = Chat(chat)
        self.text = texto
        self.caption = None
        self.photo = [Tamano("chica"), Tamano("grande")] if foto else ()
        for t in self.photo:
            t.file_unique_id += str(self.message_id)
        self.document = None
        self.from_user = Usuario(de, is_bot=bot) if de else None
        self.reply_to_message = None
        self.dichos = []
        self.teclados = []

    async def reply_text(self, texto, **kw):
        self.dichos.append(texto)
        self.teclados.append(kw.get("reply_markup"))
        return Mensaje(self.chat.id, texto, BOT_ID, bot=True)

    async def send_action(self, _a):
        return None


class Bot(object):
    username = "ERPFresnilloBot"

    def __init__(self):
        self.imagen = b"\xff\xd8 foto de prueba, no es la real"

    async def get_file(self, file_id, **k):
        return Archivo(self.imagen)

    async def send_message(self, chat_id, texto, reply_markup=None, **k):
        return Mensaje(chat_id, texto, BOT_ID, bot=True)


BOT = Bot()


class Update(object):
    def __init__(self, chat, persona, texto="", foto=False):
        self.message = Mensaje(chat, texto, persona, foto=foto)
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
    def __init__(self):
        self.args = []
        self.bot = BOT


def botones(teclado):
    if teclado is None:
        return []
    return [b.callback_data for fila in teclado.inline_keyboard for b in fila]


def todos_los_botones(mensaje):
    return [d for t in mensaje.teclados for d in botones(t)]


def limpiar():
    for d in (B._memoria, B._pendientes, B._apartado, B._preguntas, B._caidos, B._cola,
              B._historial, B._eventos, B._identidades, B._comprobante_en_vuelo):
        dict.clear(d)
    B._rehidratado.clear()
    B._ya_pregunte.clear()
    del B._por_aprobar[:]
    B._pausa.update(hasta=None, guardados=0)
    shutil.rmtree(C.CARPETA, ignore_errors=True)


def modelo(nombre):
    def falso(imagen, mime, texto, catalogo, correr=None):
        return True, json.loads(json.dumps(GRABADO["casos"][nombre]))
    return falso


LEER_REAL = O.leer_crudo


def correr(servidor, corutina, grabacion="cotizacion_95691"):
    original = B._post_de_verdad
    B._post_de_verdad = servidor
    O.leer_crudo = modelo(grabacion)
    try:
        asyncio.run(corutina)
    except Exception as e:
        caso("sin excepcion en " + corutina.__name__, repr(e), None)
    finally:
        B._post_de_verdad = original
        O.leer_crudo = LEER_REAL


def listo(bid):
    return (200, {"ok": True, "listo": True, "cuadra": True, "borrador_id": bid, "sello": "s-" + bid[:4],
                  "mensaje": "COTIZACION 95691 de SOLO VIDRIO (02/11/2026)\nOJO: es una COTIZACION.\n"
                             "5. 408 pzas Botella 750ml Vacia -> 750 ml; SIN corchos",
                  "cuentas": CUENTAS, "preguntas": []})


# -- (g) El fixture -----------------------------------------------------------
with io.open(G.RUTA, encoding="utf-8") as f:
    crudo = f.read()
caso("(g) el fixture no trae la palabra CLABE", bool(re.search("clabe", crudo, re.I)), False)
caso("(g) el fixture no trae numeros de 18 digitos", bool(re.search(r"\d{18}", crudo)), False)
caso("(g) sin_datos_bancarios quita una CLABE",
     G.sin_datos_bancarios({"x": "CLABE 012345678901234567", "y": "ref 0123 4567 8901 2345 67"}),
     {"x": None, "y": "ref [quitado]"})

# -- (a)(b)(c) La cotizacion: un resumen, botones de cuenta, el clic confirma ----
S = Servidor()
S.respuestas[RUTA_P] = [listo(BID)]
S.respuestas[RUTA_C] = [(200, {"ok": True, "id": ID_MOV, "mensaje": "Listo. Registre la compra completa."})]


async def cotizacion():
    u = Update(NORMAN, NORMAN, foto=True)
    await B.manejar_foto(u, Contexto())
    pp = S.a(RUTA_P)
    caso("(a) propone la compra de documento UNA vez", len(pp), 1)
    doc = pp[0]["documento"]
    caso("(a) viajan las 6 lineas, cantidad e importe",
         [(l["cantidad"], l["importe"]) for l in doc["lineas"]],
         [(880, 3986.4), (880, 369.6), (400, 3712), (400, 196), (408, 7519.44), (1, 2400.79)])
    caso("(a) la linea de 750 viaja tal cual (el servidor decide: botellas, sin corchos)",
         doc["lineas"][4]["descripcion"], "MEZCALERA 750 ML (CORCHO) (L)")
    caso("(a) subtotal, IVA, total, folio, tipo",
         (doc["subtotal"], doc["iva"], doc["total"], doc["folio"], doc["tipo_documento"]),
         (18184.23, 2909.48, 21093.71, "95691", "cotizacion"))
    caso("(a) NO va al gasto de siempre", S.a("/api/bot/gasto/proponer"), [])
    caso("(b) UN resumen (el del servidor), sin el resumen del ticket aparte",
         [d for d in u.message.dichos if "COTIZACION 95691" in d or "Total:" in d][:2],
         [listo(BID)[1]["mensaje"]])
    caso("(b) un boton por cuenta + Cancelar", todos_los_botones(u.message),
         ["cdc:0:" + BID, "cdc:1:" + BID, "no:" + BID])
    caso("(b) sin clic no sale ningun /confirmar", S.escrituras(), [])
    caso("(c) el borrador apunta a la foto", bool(C.de_borrador(BID)), True)

    t = Update(NORMAN, NORMAN, texto="va")
    await B.manejar_texto(t, Contexto())
    caso("(b) un 'va' escrito no confirma", S.escrituras(), [])
    caso("(b) y dice que se toca la cuenta", "tocando la cuenta" in " ".join(t.message.dichos), True)

    b = UpdateBoton(NORMAN, NORMAN, "cdc:1:" + BID)
    await B.manejar_boton(b, Contexto())
    esc = S.escrituras()
    caso("(c) el clic confirma UNA vez, ese borrador, esa cuenta",
         [(r, c["borrador_id"], c["sello"], c["id_cuenta"]) for r, c in esc],
         [(RUTA_C, BID, "s-" + BID[:4], "c-spin")])
    caso("(c) contesta el Listo del servidor", b.effective_message.dichos[0].startswith("Listo."), True)
    caso("(c) la foto queda ligada al movimiento",
         [r.get("id_movimiento") for r in C.registros().values()], [ID_MOV])
    b2 = UpdateBoton(NORMAN, NORMAN, "cdc:0:" + BID)
    await B.manejar_boton(b2, Contexto())
    caso("(c) un segundo clic ya no escribe", len(S.escrituras()), 1)


limpiar()
correr(S, cotizacion())

# -- (d) No cuadra ---------------------------------------------------------------
S = Servidor()
S.respuestas[RUTA_P] = [(200, {"ok": True, "listo": False, "cuadra": False, "borrador_id": None, "sello": None,
                               "mensaje": "COTIZACION 95691\nNO CUADRA, asi que NO lo registro:\n- linea 1",
                               "cuentas": [], "preguntas": []})]


async def no_cuadra():
    u = Update(NORMAN, NORMAN, foto=True)
    await B.manejar_foto(u, Contexto())
    caso("(d) dice que no cuadra", any("NO CUADRA" in d for d in u.message.dichos), True)
    caso("(d) sin botones de cuenta", [d for d in todos_los_botones(u.message) if d.startswith("cdc:")], [])
    caso("(d) no va al gasto de siempre", S.a("/api/bot/gasto/proponer"), [])
    caso("(d) no escribe", S.escrituras(), [])


limpiar()
correr(S, no_cuadra())

# -- (e) Linea desconocida: se pregunta, y la respuesta vuelve a proponer ---------
S = Servidor()
PREGUNTA = {"indice": 6, "descripcion": "CAJA CARTON 30X30", "motivo": "no se que insumo es",
            "opciones": [{"id": "i-a", "nombre": "Botella 750ml Vacia"}, {"id": "i-b", "nombre": "Corcho"}]}
S.respuestas[RUTA_P] = [
    (200, {"ok": True, "listo": False, "cuadra": True, "borrador_id": None, "sello": None,
           "mensaje": "COTIZACION\nNO SE QUE ES (escoge abajo, una por una):\n7. ?? \"CAJA CARTON 30X30\"",
           "cuentas": [], "preguntas": [PREGUNTA]}),
    listo(BID2)]


async def desconocida():
    u = Update(NORMAN, NORMAN, foto=True)
    await B.manejar_foto(u, Contexto())
    bs = todos_los_botones(u.message)
    caso("(e) pregunta la linea con un boton por insumo + Gasto + Cancelar",
         [d.split(":")[0] + ":" + d.split(":")[1] for d in bs], ["cdl:0", "cdl:1", "cdl:g", "no:x"])
    caso("(e) no hay botones de cuenta todavia", [d for d in bs if d.startswith("cdc:")], [])
    caso("(e) dice cual linea", any('Linea 7: "CAJA CARTON 30X30"' in d for d in u.message.dichos), True)
    b = UpdateBoton(NORMAN, NORMAN, [d for d in bs if d.startswith("cdl:g:")][0])
    await B.manejar_boton(b, Contexto())
    pp = S.a(RUTA_P)
    caso("(e) vuelve a proponer con la eleccion", [p.get("elecciones") for p in pp], [{}, {"6": "gasto"}])
    caso("(e) ahora si trae botones de cuenta", todos_los_botones(b.effective_message),
         ["cdc:0:" + BID2, "cdc:1:" + BID2, "no:" + BID2])
    caso("(e) no escribe sin clic", S.escrituras(), [])


limpiar()
correr(S, desconocida())

# -- (f) No es compra de insumos: el gasto de siempre ------------------------------
for nombre, respuesta in (("caer_a_gasto", (200, {"ok": False, "caer_a_gasto": True})),
                          ("servidor caido", (500, {"error": "boom"}))):
    S = Servidor()
    S.respuestas[RUTA_P] = [respuesta]
    S.respuestas["/api/bot/gasto/proponer"] = [(200, {
        "ok": True, "borrador_id": BID, "sello": "s-g", "mensaje": "Esto es lo que voy a escribir.",
        "cuentas": CUENTAS, "id_cuenta": "c-ef", "categorias": G.catalogo()})]

    async def cae(nombre=nombre):
        u = Update(NORMAN, NORMAN, foto=True)
        await B.manejar_foto(u, Contexto())
        caso("(f) %s: sigue con el gasto de siempre" % nombre, len(S.a("/api/bot/gasto/proponer")), 1)
        caso("(f) %s: sin clic no escribe" % nombre, S.escrituras(), [])

    limpiar()
    correr(S, cae())

# -- RONDA 2 (auditoria 2026-11-08) ---------------------------------------------
# (h) Todo acabo en "Gasto" ("BOTELLA AGUA 1L" de OXXO): el servidor ya no lo
#     toma como compra (caer_a_gasto) y el bot sigue con la propuesta de gasto de
#     siempre de ESE ticket. Antes: "No pude volver a proponer" o un resumen sin botones.
S = Servidor()
PREGUNTA_AGUA = {"indice": 0, "descripcion": "BOTELLA AGUA 1L", "motivo": "es botella pero no dice de cuantos ml",
                 "opciones": [{"id": "i-a", "nombre": "Botella 750ml Vacia"}]}
S.respuestas[RUTA_P] = [
    (200, {"ok": True, "listo": False, "cuadra": True, "borrador_id": None, "sello": None,
           "mensaje": "TICKET 9 de OXXO\nNO SE QUE ES (escoge abajo, una por una):\n1. ?? \"BOTELLA AGUA 1L\"",
           "cuentas": [], "preguntas": [PREGUNTA_AGUA]}),
    (200, {"ok": False, "caer_a_gasto": True, "motivo": "no es compra de insumos"})]
S.respuestas["/api/bot/gasto/proponer"] = [(200, {
    "ok": True, "borrador_id": BID, "sello": "s-g", "mensaje": "Esto es lo que voy a escribir.",
    "cuentas": CUENTAS, "id_cuenta": "c-ef", "categorias": G.catalogo()})]


async def todo_gasto():
    u = Update(NORMAN, NORMAN, foto=True)
    await B.manejar_foto(u, Contexto())
    bs = todos_los_botones(u.message)
    caso("(h) primero pregunta la linea", [d for d in bs if d.startswith("cdl:g:")] != [], True)
    caso("(h) todavia no va al gasto", S.a("/api/bot/gasto/proponer"), [])
    b = UpdateBoton(NORMAN, NORMAN, [d for d in bs if d.startswith("cdl:g:")][0])
    await B.manejar_boton(b, Contexto())
    caso("(h) re-propone con la eleccion", [p.get("elecciones") for p in S.a(RUTA_P)], [{}, {"0": "gasto"}])
    gp = S.a("/api/bot/gasto/proponer")
    caso("(h) todo gasto -> la propuesta de gasto de siempre, UNA vez", len(gp), 1)
    caso("(h) con el monto del ticket", (gp[0].get("propuesta") or {}).get("monto") if gp else None, 21093.71)
    caso("(h) nunca 'No pude volver a proponer'",
         any("No pude volver a proponer" in d for d in b.effective_message.dichos), False)
    caso("(h) sin clic no escribe", S.escrituras(), [])


limpiar()
correr(S, todo_gasto())

# (i) Defensa del bot: cuadra, sin preguntas y sin borrador -> nunca un resumen sin
#     botones; el gasto de siempre.
S = Servidor()
S.respuestas[RUTA_P] = [(200, {"ok": True, "listo": False, "cuadra": True, "borrador_id": None, "sello": None,
                               "mensaje": "TICKET\nDe que cuenta salio el dinero?", "cuentas": [], "preguntas": []})]
S.respuestas["/api/bot/gasto/proponer"] = [(200, {
    "ok": True, "borrador_id": BID, "sello": "s-g", "mensaje": "Esto es lo que voy a escribir.",
    "cuentas": CUENTAS, "id_cuenta": "c-ef", "categorias": G.catalogo()})]


async def sin_botones():
    u = Update(NORMAN, NORMAN, foto=True)
    await B.manejar_foto(u, Contexto())
    caso("(i) no ensena el resumen sin botones", any("De que cuenta salio" in d for d in u.message.dichos), False)
    caso("(i) sigue el gasto de siempre", len(S.a("/api/bot/gasto/proponer")), 1)


limpiar()
correr(S, sin_botones())

# (j) Las dudas del OCR y la bandera de instrucciones viajan (como TEMAS, no prosa).
t95 = O.normaliza(json.loads(json.dumps(GRABADO["casos"]["cotizacion_95691"])), [])
d95 = O.documento_de_compra(t95)
caso("(j) temas de duda de la 95691", d95.get("temas_duda"), ["categoria", "fecha", "otro dato"])
caso("(j) trae_instrucciones viaja", d95.get("trae_instrucciones"), False)
caso("(j) la prosa del modelo NO viaja", "podria" in json.dumps(d95).lower() or "11 feb" in json.dumps(d95), False)

# (k) En un GRUPO (como lo mando Norman el 2026-11-08): la persona y el grupo
#     viajan separados, el resumen lleva el rotulo, el clic de otro no escribe.
GRUPO = -5589123471
KEVIN = 222
S = Servidor()
S.respuestas[RUTA_P] = [listo(BID)]
S.respuestas[RUTA_C] = [(200, {"ok": True, "id": ID_MOV, "mensaje": "Listo. Registre la compra completa."})]


async def en_grupo():
    u = Update(GRUPO, NORMAN, foto=True)
    await B.manejar_foto(u, Contexto())
    pp = S.a(RUTA_P)
    caso("(k) grupo: telegram_id = la persona, chat_id = el grupo",
         [(p.get("telegram_id"), p.get("chat_id")) for p in pp], [(NORMAN, GRUPO)])
    resumen = [d for d in u.message.dichos if "COTIZACION 95691" in d]
    caso("(k) grupo: UN resumen, con el rotulo de quien lo propuso",
         [d.split("\n")[0] for d in resumen], ["Propuesto por Norman"])
    k = UpdateBoton(GRUPO, KEVIN, "cdc:0:" + BID)
    await B.manejar_boton(k, Contexto())
    caso("(k) grupo: el clic de Kevin no escribe", S.escrituras(), [])
    b = UpdateBoton(GRUPO, NORMAN, "cdc:0:" + BID)
    await B.manejar_boton(b, Contexto())
    caso("(k) grupo: el clic de Norman escribe UNA vez, con su id y el del grupo",
         [(c.get("telegram_id"), c.get("chat_id"), c.get("id_cuenta")) for r, c in S.escrituras()],
         [(NORMAN, GRUPO, "c-ef")])


limpiar()
correr(S, en_grupo())

# -- Resultado ----------------------------------------------------------------------
malos = 0
for nombre, obtenido, esperado in casos:
    bien = obtenido == esperado
    malos += 0 if bien else 1
    print(("OK    " if bien else "FALLA ") + nombre)
    if not bien:
        print("      obtenido:", repr(obtenido)[:300])
        print("      esperado:", repr(esperado)[:300])
print("RESULTADO: %d de %d casos FALLAN" % (malos, len(casos)))
shutil.rmtree(CARPETA, ignore_errors=True)
sys.exit(1 if malos else 0)
