# -*- coding: utf-8 -*-
"""COMPRA DE INSUMO DESDE EL BOT: el lado del bot (2026-11-07).

Escrito el 2026-11-07 por el ejecutor del Socio (bot con paridad de la web).

El servidor decide si un gasto es compra de insumo (`lib/bot-compra.ts`) y
contesta `compra_falta` + `compra_opciones` cuando le falta UN dato. Aqui se
prueba que el bot:
  - ofrece un boton por insumo candidato y, al tocarlo, repropone con su id;
  - toma el numero contestado ("50", "50 kg") como la cantidad SIN pasar por el
    modelo, y deja pasar al modelo lo que no es numero;
  - manda el texto dicho con el gasto de un mensaje de UN hecho;
  - confirma la compra por la ruta del gasto (tambien tras el Aprobar).

Corre la tuberia real (`manejar_texto`, `manejar_boton`) con `_post` y
`enrutar` doblados: **ninguna peticion sale de este proceso.** El servidor se
prueba en `tests/bot-compra.spec.ts`.

Corre con:  python bot/probar_compra.py      (sin red, sin modelo)
"""
import asyncio
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["BOT_LOG"] = os.path.join(tempfile.gettempdir(), "probar_compra.log")

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
    """`proponer` contesta, en orden, lo que haya en `propuestas`."""

    def __init__(self, propuestas):
        self.llamadas = []
        self.propuestas = list(propuestas)

    def __call__(self, ruta, cuerpo):
        self.llamadas.append((ruta, cuerpo))
        if ruta == "/api/bot/pendiente":
            return 200, {"ok": True, "pendientes": []}
        if ruta == "/api/bot/catalogo":
            return 200, {"ok": True, "productos": []}
        if ruta == B.RUTA_LEER_CUENTAS:
            return 200, {"ok": True, "cuentas": [CUENTA]}
        if ruta == PROPONER:
            extra = self.propuestas.pop(0) if self.propuestas else {}
            base = {"ok": True, "borrador_id": UUID, "sello": SELLO, "cuentas": [CUENTA],
                    "id_cuenta": "c-spin", "categorias": [], "mensaje": MENSAJE,
                    "tipo": "gasto", "compra_falta": None, "compra_opciones": []}
            base.update(extra)
            return 200, base
        if ruta == CONFIRMAR:
            return 200, {"ok": True, "id": "fin-1", "categoria_creada": None}
        return 200, {"ok": True}

    def cuerpos(self, ruta):
        return [c for r, c in self.llamadas if r == ruta]


modelo = {"llamadas": 0}


def correr(corutina, doble, ruta_del_modelo=None):
    enrutar_original, post_original = B.enrutar, B._post

    def enrutar_doble(*a, **kw):
        modelo["llamadas"] += 1
        return True, dict(ruta_del_modelo or {})

    B.enrutar, B._post = enrutar_doble, doble
    try:
        asyncio.run(corutina)
    finally:
        B.enrutar, B._post = enrutar_original, post_original


def limpiar():
    B._olvidar_chat(CHAT)
    B._memoria.pop(CHAT, None)
    B._pendientes.pop(CHAT, None)
    B._rehidratado.discard(CHAT)
    B._cuentas_leidas.clear()
    B._esperando_cantidad_compra.pop(CHAT, None)
    modelo["llamadas"] = 0


def hablar(texto, doble, ruta_del_modelo=None):
    u = UpdateDeTexto(CHAT, texto)
    correr(B.manejar_texto(u, None), doble, ruta_del_modelo)
    return u


def picar(dato, doble):
    u = UpdateDeBoton(CHAT, dato)
    correr(B.manejar_boton(u, None), doble)
    return u.callback_query.message


def gasto(campos):
    hecho = dict(intencion="gasto", campos=dict(campos), faltantes=[], pregunta=None, confianza="alta")
    return dict(intencion="gasto", confianza="alta", entendido="x", campos=dict(campos),
                respuesta="", hechos=[hecho], faltantes=[], pregunta=None)


def botones(teclado):
    return [b.callback_data for fila in (teclado.inline_keyboard if teclado else []) for b in fila]


FRASE = "compre 50 kg de chile a 1200 desde spin"
CAMPOS = {"monto": 1200, "descripcion": "50 kg de chile", "categoria": None}

# === 1. Dos insumos posibles: un boton por cada uno ==========================
limpiar()
doble = PostDoble([{"compra_falta": "insumo", "compra_opciones": OPCIONES},
                   {"borrador_id": UUID2, "tipo": "compra_insumo"}])
u = hablar(FRASE, doble, gasto(CAMPOS))
caso("INSUMO: el texto dicho viaja con el gasto de un hecho",
     doble.cuerpos(PROPONER)[0]["propuesta"].get("texto_dicho"), FRASE)
caso("INSUMO: un boton por candidato, con su borrador",
     [b for b in botones(u.message.teclados[-1]) if b.startswith("cmpi:")],
     ["cmpi:0:" + UUID, "cmpi:1:" + UUID])
caso("INSUMO: el VA del gasto sigue ahi (la pregunta es opcional)",
     "va:" + UUID in botones(u.message.teclados[-1]), True)
m = picar("cmpi:1:" + UUID, doble)
caso("INSUMO: tocar 'Chile Guajon' repropone con su id",
     doble.cuerpos(PROPONER)[-1]["propuesta"].get("id_insumo"), "i-guajon")
caso("INSUMO: ...sin volver a llamar al modelo", modelo["llamadas"], 1)
caso("INSUMO: ...y la memoria queda en el borrador nuevo", B._memoria[CHAT]["borrador_id"], UUID2)

# === 2. El VA de la compra va a la ruta del gasto =============================
picar("va:" + UUID2, doble)
caso("VA: la compra se confirma por /gasto/confirmar con su sello",
     doble.cuerpos(CONFIRMAR), [{"telegram_id": CHAT, "borrador_id": UUID2, "sello": SELLO}])
caso("APROBAR: el tipo compra_insumo tiene ruta de confirmar",
     B.RUTA_CONFIRMAR_DE.get("compra_insumo"), CONFIRMAR)

# === 3. Falta la cantidad: el numero contestado entra sin modelo ==============
limpiar()
doble = PostDoble([{"compra_falta": "cantidad"}, {"borrador_id": UUID2, "tipo": "compra_insumo"}])
hablar("compre chile guajillo, 1200 de spin", doble, gasto({"monto": 1200, "descripcion": "chile guajillo"}))
caso("CANTIDAD: queda esperando el numero de ESE borrador",
     B._esperando_cantidad_compra.get(CHAT), UUID)
hablar("50 kg", doble)
caso("CANTIDAD: '50 kg' repropone con cantidad_insumo",
     doble.cuerpos(PROPONER)[-1]["propuesta"].get("cantidad_insumo"), "50 kg")
caso("CANTIDAD: ...sin pasar por el modelo", modelo["llamadas"], 1)
caso("CANTIDAD: la espera se cierra con la compra", CHAT in B._esperando_cantidad_compra, False)

# === 4. Lo que no es numero sigue su camino normal ============================
limpiar()
doble = PostDoble([{"compra_falta": "cantidad"}, {}])
hablar("chile guajillo 1200", doble, gasto({"monto": 1200, "descripcion": "chile guajillo"}))
hablar("y 300 de gasolina", doble, gasto({"monto": 300, "descripcion": "gasolina"}))
caso("NO NUMERO: el mensaje va al modelo", modelo["llamadas"], 2)
caso("NO NUMERO: no se toma como cantidad",
     [c["propuesta"].get("cantidad_insumo") for c in doble.cuerpos(PROPONER)], [None, None])

# === 5. Lo puro ===============================================================
caso("PURA: '50'", B._cantidad_de_texto("50"), "50")
caso("PURA: '1,5 kilos' -> punto decimal", B._cantidad_de_texto("1,5 kilos"), "1.5 kilos")
caso("PURA: '1,000' no se vuelve decimal", B._cantidad_de_texto("1,000"), "1,000")
caso("PURA: una frase no es cantidad", B._cantidad_de_texto("50 kilos de chile"), None)
caso("PURA: texto sin numero", B._cantidad_de_texto("cancela"), None)
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
