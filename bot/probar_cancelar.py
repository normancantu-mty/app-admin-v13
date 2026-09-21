# -*- coding: utf-8 -*-
"""El "no" del bot, EJERCITADO. Defecto 1 (D1-D8), 2026-09-19.

─── POR QUE ESTA PRUEBA ES ASI Y NO DE OTRA FORMA ──────────────────────────────

`app/api/bot/cancelar/route.ts` llevaba una semana escrita, comentada y correcta.
**Y no la llamaba nadie:** `grep -rn "bot/cancelar"` sobre `.py` y `.ts` daba
cero. Los dos "no" del bot --el boton y la palabra-- hacian un `_memoria.pop` y
ya; la fila de `bot_borradores` se quedaba PENDIENTE para siempre y el rastro
decia que habia un borrador vivo que nadie abandono.

**Cuatro archivos de prueba miraban ese codigo y ninguno lo vio**, porque los
cuatro hacian `readFileSync` y comparaban texto: encontraban la ruta escrita y
daban verde. Un arreglo cubierto por una prueba que hace `readFileSync` no esta
cubierto.

Asi que esto NO lee el codigo. Importa `bot_gastos`, le pone un DOBLE a `_post`,
arma el teclado de verdad, **le saca el `callback_data` al boton "Cancelar" tal
como lo veria Telegram**, y dispara `manejar_boton`. Lo que se afirma es lo que
paso, no lo que esta escrito.

Corre con:  python bot/probar_cancelar.py
"""
import asyncio
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# D46 (Fase 6): **el log va a un temporal, y esta linea tiene que ir ANTES del
# import.** `bot_gastos` instala su `FileHandler` al importarse; sin esto, correr
# esta prueba escribe en `bot/bot_gastos.log` y le reinicia el reloj al detector
# de cuelgue de `decidir_reinicio.py`, que mide por el `mtime` de ese archivo.
os.environ.setdefault(
    "BOT_LOG", os.path.join(tempfile.gettempdir(), "probar_bot.log"))

import bot_gastos as B  # noqa: E402

CHAT = 987654321
UUID = "0c1b3f2a-9d44-4e7b-8a10-6f5c2d9e7b31"

casos = []


def caso(nombre, obtenido, esperado, detalle=""):
    casos.append((nombre, obtenido, esperado, detalle))


# ───────────────────────── el doble y los falsos de Telegram ─────────────────

class PostDoble(object):
    """Registra cada llamada. `respuestas` mapea ruta -> (estado, objeto)."""

    def __init__(self, respuestas=None, revienta=False):
        self.llamadas = []
        self.respuestas = respuestas or {}
        self.revienta = revienta

    def __call__(self, ruta, cuerpo):
        self.llamadas.append((ruta, cuerpo))
        if self.revienta:
            raise RuntimeError("la red se cayo")
        return self.respuestas.get(ruta, (200, {"ok": True}))

    def rutas(self):
        return [r for r, _ in self.llamadas]

    def cuerpo_de(self, ruta):
        for r, c in self.llamadas:
            if r == ruta:
                return c
        return None


class MensajeFalso(object):
    def __init__(self, chat_id, texto=""):
        self.chat = type("Chat", (), {"id": chat_id})()
        self.text = texto
        self.dichos = []

    async def reply_text(self, texto, **kw):
        self.dichos.append(texto)
        return None

    async def send_action(self, _accion):
        return None


class ConsultaFalsa(object):
    def __init__(self, chat_id, data):
        self.data = data
        self.message = MensajeFalso(chat_id)
        self.contestada = False

    async def answer(self, *a, **kw):
        self.contestada = True


class UpdateDeBoton(object):
    def __init__(self, chat_id, data):
        self.callback_query = ConsultaFalsa(chat_id, data)

    @property
    def effective_message(self):
        return self.callback_query.message

    @property
    def effective_chat(self):
        return self.callback_query.message.chat


class UpdateDeTexto(object):
    def __init__(self, chat_id, texto):
        self.message = MensajeFalso(chat_id, texto)

    @property
    def effective_message(self):
        return self.message

    @property
    def effective_chat(self):
        return self.message.chat


def dato_de_boton(teclado, etiqueta):
    """El `callback_data` del boton que dice `etiqueta`. Como lo ve Telegram."""
    for fila in teclado.inline_keyboard:
        for boton in fila:
            if boton.text == etiqueta:
                return boton.callback_data
    raise AssertionError("no hay boton %r en el teclado" % etiqueta)


def con_doble(doble, corutina):
    """Corre la corutina con `_post` sustituido, y lo devuelve a su sitio."""
    original = B._post
    B._post = doble
    try:
        return asyncio.run(corutina)
    finally:
        B._post = original


def propuesta_viva(tipo="gasto", borrador_id=UUID):
    B._memoria[CHAT] = {"tipo": tipo, "borrador_id": borrador_id,
                        "propuesta": {"monto": 1000.0}}


# ─── 1 (VERDE): EL BOTON. El dato sale del teclado, no de mi imaginacion. ─────
#     Si alguien cambia el prefijo de `callback_data`, esta prueba lo sigue,
#     porque lee el boton. Y si se rompe el cableado, da rojo aunque el prefijo
#     siga igual.
propuesta_viva()
teclado = B._teclado_confirmar(UUID)
dato = dato_de_boton(teclado, "Cancelar")
caso("VERDE - el boton Cancelar lleva el uuid", dato, "no:" + UUID, dato)

u = UpdateDeBoton(CHAT, dato)
doble = PostDoble()
con_doble(doble, B.manejar_boton(u, None))
caso("VERDE - el boton LLAMA a /api/bot/cancelar",
     "/api/bot/cancelar" in doble.rutas(), True, str(doble.rutas()))
caso("VERDE - ...con el borrador_id del boton",
     (doble.cuerpo_de("/api/bot/cancelar") or {}).get("borrador_id"), UUID)
caso("VERDE - ...y con el telegram_id",
     (doble.cuerpo_de("/api/bot/cancelar") or {}).get("telegram_id"), CHAT)
caso("VERDE - contesta que no escribio nada",
     u.callback_query.message.dichos, ["Cancelado. No escribi nada."])
caso("VERDE - D4: la memoria queda limpia", CHAT in B._memoria, False)

# ─── 2 (VERDE): EL TEXTO. Mismo efecto por la otra puerta. ───────────────────
#     El id NO viene en la mano: sale de la propuesta viva, y se lee ANTES de
#     limpiar la memoria. Un `pop` adelantado aqui deja de llamar a la ruta sin
#     que nada mas cambie -- por eso el caso existe.
propuesta_viva()
ut = UpdateDeTexto(CHAT, "no")
doble = PostDoble()
con_doble(doble, B.manejar_texto(ut, None))
caso("VERDE - el texto 'no' LLAMA a /api/bot/cancelar",
     "/api/bot/cancelar" in doble.rutas(), True, str(doble.rutas()))
caso("VERDE - ...con el id de la propuesta viva",
     (doble.cuerpo_de("/api/bot/cancelar") or {}).get("borrador_id"), UUID)
caso("VERDE - y contesta igual", ut.message.dichos, ["Cancelado. No escribi nada."])

# ─── 3 (VERDE, D3): el 409. Si ya estaba escrito, "no escribi nada" es mentira.
propuesta_viva()
u = UpdateDeBoton(CHAT, "no:" + UUID)
doble = PostDoble({"/api/bot/cancelar": (409, {"error": "ya confirmado"})})
con_doble(doble, B.manejar_boton(u, None))
caso("VERDE - un 409 NO dice 'no escribi nada'",
     "No escribi nada" in u.callback_query.message.dichos[0], False,
     u.callback_query.message.dichos[0])
caso("VERDE - un 409 ofrece anularlo",
     "anule" in u.callback_query.message.dichos[0], True,
     u.callback_query.message.dichos[0])

# ─── 4 (VERDE, D4): la red se cae y la memoria SE LIMPIA IGUAL. ──────────────
#     Sin esto, un fallo de red deja el estado local colgado y el siguiente
#     mensaje de Norman contesta sobre un borrador que el ya cancelo.
propuesta_viva()
u = UpdateDeBoton(CHAT, "no:" + UUID)
reventado = PostDoble(revienta=True)
exploto = False
try:
    con_doble(reventado, B.manejar_boton(u, None))
except Exception:
    exploto = True
caso("VERDE - si el POST revienta, la memoria queda limpia igual",
     CHAT in B._memoria, False, "exploto=%r" % exploto)

# ─── 5 (CONTROL NEGATIVO, D2): "Mejor no" de las listas. `no:x`, sin uuid. ───
#     Este es el boton que NO tiene borrador. Si `no:x` llamara a la ruta,
#     mandariamos "x" como uuid y el servidor contestaria 400 -- y Norman veria
#     un error por haber dicho que no. **Cancelar no puede fallarle nunca.**
B._memoria.pop(CHAT, None)
listas = B._teclado_movimientos([
    dict(tabla="finanzas", id=UUID, etiqueta="19 sep - $1,000.00 - luz",
         detalle="x", valores=None, arrastra_venta=False)])
dato_x = dato_de_boton(listas, "Mejor no")
caso("ROJO  - el 'Mejor no' de las listas no lleva uuid", dato_x, "no:x", dato_x)

u = UpdateDeBoton(CHAT, dato_x)
doble = PostDoble()
con_doble(doble, B.manejar_boton(u, None))
caso("ROJO  - 'no:x' NO llama a la ruta", doble.rutas(), [])
caso("ROJO  - ...pero contesta igual",
     u.callback_query.message.dichos, ["Cancelado. No escribi nada."])

# ─── 6 (CONTROL NEGATIVO, D2): "no" a secas, sin nada pendiente. ─────────────
B._memoria.pop(CHAT, None)
ut = UpdateDeTexto(CHAT, "no")
doble = PostDoble()
con_doble(doble, B.manejar_texto(ut, None))
caso("ROJO  - 'no' sin propuesta viva NO llama a la ruta", doble.rutas(), [])
caso("ROJO  - ...y contesta igual de bien",
     ut.message.dichos, ["Cancelado. No escribi nada."])

# ─── 7 (CONTROL NEGATIVO): el doble tiene que poder VER una llamada. ────────
#     Si `PostDoble` estuviera mal enchufado, los casos 5 y 6 darian verde
#     solos y los casos 1 y 2 serian los unicos que miden. Esto fija que el
#     instrumento funciona en ambos sentidos.
control = PostDoble()
control("/api/bot/loquesea", {"a": 1})
caso("VERDE - el doble registra lo que pasa por el",
     control.rutas(), ["/api/bot/loquesea"])

# ─── 8 (CONTROL NEGATIVO, D8): y la prueba tiene que poder dar ROJO. ────────
#     El modo de fallo que dejo vivo al defecto 1 fue una prueba incapaz de
#     fallar. Se comprueba que el comparador no es complaciente.
caso("ROJO  - el comparador sabe decir que no", ["/a"] == [], False, "")

print("")
todo_bien = True
for nombre, obtenido, esperado, detalle in casos:
    bien = obtenido == esperado
    if not bien:
        todo_bien = False
    print("  [%s] %-52s  %s" % ("PASA" if bien else "FALLA", nombre,
                                detalle if bien else "obtuve %r, esperaba %r"
                                % (obtenido, esperado)))
print("")
print("RESULTADO:", "los %d casos pasan" % len(casos) if todo_bien
      else "HAY CASOS QUE FALLAN")
sys.exit(0 if todo_bien else 1)
