# -*- coding: utf-8 -*-
"""FASE 9 (D92) — SIN EMPAQUE, EL BOT PREGUNTA; LA RESPUESTA ENTRA CON VA; Y EL
ENVASADO VUELVE SOLO.

Como `probar_cancelar.py`: NO lee el codigo. Importa `bot_gastos`, le pone un
DOBLE a `_post` y ejercita el flujo entero:

1. `/api/bot/lote/proponer` contesta `falta_empaque` -> el bot dice el mensaje,
   NO deja propuesta viva, y queda esperando la respuesta.
2. "llegaron 500 botellas de 750" -> va a `/api/bot/inventario/proponer` (sin
   modelo) con el envasado resuelto; propuesta con boton VA (`vaent:`).
3. El VA (sacado del teclado, como lo ve Telegram) -> `/api/bot/inventario/
   confirmar` con borrador y sello, y DESPUES el mismo lote otra vez.
CONTROLES: "no" suelta la espera sin proponer nada; una frase que el servidor
no entiende sigue esperando; si el confirmar no escribe (ensayo), el envasado
NO se vuelve a proponer; un lote con empaque no deja espera.

Mutacion (ver `_avance_fase9`): quitar la rama `falta_empaque` de
`_proponer_lote` -> rojo.

Corre con:  python bot/probar_empaque.py      (sin red, sin modelo)
"""
import asyncio
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault(
    "BOT_LOG", os.path.join(tempfile.gettempdir(), "probar_bot.log"))

import bot_gastos as B  # noqa: E402

CHAT = 987654321
casos = []


def caso(nombre, obtenido, esperado):
    casos.append((nombre, obtenido, esperado))


class PostDoble(object):
    """`respuestas`: ruta -> lista de (estado, objeto), se consumen en orden."""

    def __init__(self, respuestas):
        self.llamadas = []
        self.respuestas = {k: list(v) for k, v in respuestas.items()}

    def __call__(self, ruta, cuerpo):
        self.llamadas.append((ruta, cuerpo))
        cola = self.respuestas.get(ruta) or [(200, {"ok": True})]
        return cola.pop(0) if len(cola) > 1 else cola[0]

    def rutas(self):
        return [r for r, _ in self.llamadas]

    def cuerpo_de(self, ruta):
        for r, c in self.llamadas:
            if r == ruta:
                return c
        return None


class ChatFalso(object):
    id = CHAT

    async def send_action(self, _a):
        return None


# Si el texto se fuera al MODELO (la mutacion), aqui queda anotado en vez de
# llamar a `claude -p`.
al_modelo = []


async def _enrutar_falso(update, chat, texto, **kw):
    al_modelo.append(texto)

B._enrutar_y_despachar = _enrutar_falso


class MensajeFalso(object):
    def __init__(self):
        self.chat = ChatFalso()
        self.dichos = []
        self.teclados = []

    async def reply_text(self, texto, **kw):
        self.dichos.append(texto)
        self.teclados.append(kw.get("reply_markup"))

    async def send_action(self, _a):
        return None


class UpdateFalso(object):
    def __init__(self):
        self.message = MensajeFalso()

    @property
    def effective_message(self):
        return self.message

    @property
    def effective_chat(self):
        return self.message.chat


def boton(teclado, etiqueta):
    for fila in teclado.inline_keyboard:
        for b in fila:
            if b.text == etiqueta:
                return b.callback_data
    raise AssertionError("no hay boton %r" % etiqueta)


def limpiar():
    for d in (B._memoria, B._esperando_empaque, B._pendientes):
        d.pop(CHAT, None)


def correr(doble, corutina):
    original = B._post
    B._post = doble
    try:
        asyncio.run(corutina)
    finally:
        B._post = original


PETICION = {"insumos": [], "envasado": [{"formato": "750", "botellas": 24}], "propuesta": {}}
RESUELTO = [{"id_producto": "c1000000-0000-0000-0000-000000000001", "botellas": 24}]
FALTA = (200, {"ok": False, "falta_empaque": True, "envasado": RESUELTO,
               "faltantes": [{"nombre": "Corcho", "falta": 18}],
               "mensaje": "Para envasar 24 de Destilado Plata 750ml me falta empaque registrado:\n..."
                          "Que paso: llego una compra, o ya lo tenias y no esta capturado?"})
LOTE_OK = (200, {"ok": True, "borrador_id": "b-lote", "sello": "s-lote",
                 "codigo_lote": "L-1", "mensaje": "Esto es lo que voy a escribir... AL LOTE L-1"})
ENTRADA_OK = (200, {"ok": True, "borrador_id": "b-ent", "sello": "s-ent",
                    "mensaje": "ENTRA AL INVENTARIO DE LA MATRIZ:\n   +500 Botella 750ml Vacía"})


async def flujo(u, doble_ref):
    await B._proponer_lote(u, CHAT, PETICION)
    doble_ref["tras_proponer"] = (CHAT in B._esperando_empaque,
                                  bool((B._memoria.get(CHAT) or {}).get("borrador_id")))
    await B._manejar_texto(u, CHAT, "llegaron 500 botellas de 750")
    teclado = u.message.teclados[-1]
    if teclado is None:
        return  # no hubo propuesta de entrada: los casos de abajo lo dicen
    datos = boton(teclado, "VA, escribelo")
    partes = datos.split(":", 2)
    await B._manejar_boton(u, CHAT, None, partes, partes[0])


# ═══ 1-3. EL FLUJO ENTERO ════════════════════════════════════════════════════
limpiar()
doble = PostDoble({
    "/api/bot/lote/proponer": [FALTA, LOTE_OK],
    "/api/bot/inventario/proponer": [ENTRADA_OK],
    "/api/bot/inventario/confirmar": [(200, {"ok": True, "filas_inventario": 1,
                                              "mensaje": "Entraron 1 insumo al inventario de la matriz."})],
})
u = UpdateFalso()
ref = {}
correr(doble, flujo(u, ref))
caso("1. falta empaque: queda esperando y SIN propuesta viva", ref.get("tras_proponer"), (True, False))
caso("1. el bot dice lo que falta y pregunta que paso",
     "Que paso" in (u.message.dichos[0] if u.message.dichos else ""), True)
cuerpo = doble.cuerpo_de("/api/bot/inventario/proponer") or {}
caso("2. la respuesta NO fue al modelo", al_modelo, [])
caso("2. la respuesta va a inventario/proponer, sin modelo, tal cual",
     (cuerpo.get("texto"), cuerpo.get("envasado")), ("llegaron 500 botellas de 750", RESUELTO))
caso("3. el VA confirma con borrador y sello",
     {k: (doble.cuerpo_de("/api/bot/inventario/confirmar") or {}).get(k) for k in ("borrador_id", "sello")},
     {"borrador_id": "b-ent", "sello": "s-ent"})
caso("3. y DESPUES el mismo envasado se vuelve a proponer",
     doble.rutas(), ["/api/bot/lote/proponer", "/api/bot/inventario/proponer",
                     "/api/bot/inventario/confirmar", "/api/bot/lote/proponer"])
caso("3. la segunda propuesta del lote es la MISMA peticion",
     {k: v for k, v in (doble.llamadas[-1][1] or {}).items() if k in ("envasado", "insumos")},
     {"envasado": PETICION["envasado"], "insumos": []})
caso("3. ya no espera empaque, y el foco es el lote nuevo",
     (CHAT in B._esperando_empaque, (B._memoria.get(CHAT) or {}).get("tipo")), (False, "lote"))

# ═══ CONTROL: "no" suelta la espera ══════════════════════════════════════════
limpiar()
doble = PostDoble({"/api/bot/lote/proponer": [FALTA]})
u = UpdateFalso()


async def con_no(u):
    await B._proponer_lote(u, CHAT, PETICION)
    await B._manejar_texto(u, CHAT, "no")

correr(doble, con_no(u))
caso("CONTROL: 'no' suelta la espera y no propone entrada",
     (CHAT in B._esperando_empaque, "/api/bot/inventario/proponer" in doble.rutas()), (False, False))

# ═══ CONTROL: lo que el servidor no entiende sigue esperando ════════════════
limpiar()
doble = PostDoble({"/api/bot/lote/proponer": [FALTA],
                   "/api/bot/inventario/proponer": [(200, {"ok": False, "no_entendi": True,
                                                           "mensaje": "No se a cual insumo va"})]})
u = UpdateFalso()


async def no_entiende(u):
    await B._proponer_lote(u, CHAT, PETICION)
    await B._manejar_texto(u, CHAT, "llegaron 50 bolsas")

correr(doble, no_entiende(u))
caso("CONTROL: frase no entendida -> lo dice y SIGUE esperando",
     (CHAT in B._esperando_empaque, u.message.dichos[-1]), (True, "No se a cual insumo va"))

# ═══ CONTROL: si el confirmar no escribe (ensayo), NO se retoma el envasado ═
limpiar()
doble = PostDoble({
    "/api/bot/lote/proponer": [FALTA, LOTE_OK],
    "/api/bot/inventario/proponer": [ENTRADA_OK],
    "/api/bot/inventario/confirmar": [(200, {"ok": False, "ensayo": True,
                                              "error": B.AVISO_ENSAYO + " no salio"})],
})
u = UpdateFalso()
correr(doble, flujo(u, {}))
caso("CONTROL ensayo: confirmar no escribio -> el lote NO se vuelve a proponer",
     doble.rutas().count("/api/bot/lote/proponer"), 1)

# ═══ CONTROL: con empaque, no hay espera ════════════════════════════════════
limpiar()
doble = PostDoble({"/api/bot/lote/proponer": [LOTE_OK]})
u = UpdateFalso()
correr(doble, B._proponer_lote(u, CHAT, PETICION))
caso("CONTROL: lote con empaque -> propuesta viva, sin espera",
     (CHAT in B._esperando_empaque, (B._memoria.get(CHAT) or {}).get("borrador_id")), (False, "b-lote"))
caso("CONTROL: la espera cuenta como 'esperando respuesta' (no se mezcla con otro hecho)",
     (B._esperando_empaque.__setitem__(CHAT, {}) or B._esperando_respuesta(CHAT)), True)
limpiar()

todo_bien = True
for nombre, obtenido, esperado in casos:
    bien = obtenido == esperado
    todo_bien = todo_bien and bien
    print("  [%s] %-70s %s" % ("PASA" if bien else "FALLA", nombre,
                               "" if bien else "obtuve %r, esperaba %r" % (obtenido, esperado)))
print("")
print("RESULTADO:", "los %d casos pasan" % len(casos) if todo_bien else "HAY CASOS QUE FALLAN")
sys.exit(0 if todo_bien else 1)
