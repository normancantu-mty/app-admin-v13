# -*- coding: utf-8 -*-
"""Cazador F0 - WP-7a + Lote v2: EL LOTE POR PLANTILLA, por la tuberia real del bot.

Escrito el 2026-10-17 por el ejecutor B del Socio. Reescrito el 2026-10-19 por
el ejecutor del Socio (lote v2): la plantilla nueva (kilos y tipo de chile,
Brix chile, kilos aditivo 1, Brix final; sin dias ni tandas), el codigo
L-DD-MM.N en la cabecera y el resumen con la fecha y Confirmar / Corregir.

Mete mensajes por `manejar_texto` -> despacho -> `reply_text`, y los botones
por `_manejar_boton` real, con `_post` DOBLADO (lo que contestaria la ruta) y
`enrutar` DOBLADO y CONTADO. Mide:

  1. La plantilla sale encabezada por el codigo de hoy, con las 4 preguntas
     nuevas; despues pregunta solo lo que falta (<=4); al final, el resumen con
     TODO + la fecha de hoy, y NADA se propone antes de Confirmar. Confirmar
     propone y confirma (aditivo 1 por SKU opaco, Brix, codigo, notas).
  2. Numeradas en un mensaje; "confirmar" dicho tambien confirma.
  3. "luego": pendiente, preguntado una vez, anotado en notas.
  4. Rango fuera de lo normal: avisa (texto legible) y NO bloquea.
  5. Corregir: dice lo capturado, corrige por numero, vuelve a ensenar.
  6. El codigo: .2 si ya hay uno hoy; si otro lo toma antes de Confirmar, no
     se escribe un codigo distinto del que se enseno: se reensena.
  7. Disparadores nuevos (empecemos/empezemos/iniciemos/arranquemos).
  8. El modelo dice `lote`: entra a la plantilla, no propone sin Confirmar.
  9. CONTROLES: dinero y "va" con plantilla viva SI van al modelo; "cancela"
     la suelta; sin el disparador no hay plantilla (la prueba puede fallar).
 10. Envasado sin lote abierto: oferta y boton (de F0, sin cambios).

Corre con:  python bot/probar_plantilla.py
"""
import asyncio
import os
import re
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("BOT_LOG", os.path.join(tempfile.gettempdir(), "probar_bot.log"))

import bot_gastos as B  # noqa: E402
# E2 (auditoria IA 2026-10-17): estas pruebas no son de la puerta de privado
# (esa se prueba en probar_minimo_privilegio.py); aqui el chat privado es de
# alguien dado de alta.
async def _alta_ok(update, clave):
    return True
B._puerta_de_privado = _alta_ok
import lote_plantilla as P  # noqa: E402

CHAT = 987650017
UUID = "0c1b3f2a-9d44-4e7b-8a10-6f5c2d9e7b31"
PROPONER = "/api/bot/lote/proponer"
casos = []


def caso(nombre, obtenido, esperado):
    casos.append((nombre, obtenido, esperado))


class MensajeFalso(object):
    def __init__(self, chat_id, texto="", dichos=None):
        self.chat = type("Chat", (), {"id": chat_id, "type": "private"})()
        self.chat.send_action = self._nada
        self.text = texto
        self.dichos = dichos if dichos is not None else []
        self.teclados = []

    async def _nada(self, *a, **kw):
        return None

    async def reply_text(self, texto, **kw):
        self.dichos.append(str(texto))
        self.teclados.append(kw.get("reply_markup"))
        return None


class UpdateDeTexto(object):
    def __init__(self, chat_id, texto, dichos=None):
        self.message = MensajeFalso(chat_id, texto, dichos)

    @property
    def effective_message(self):
        return self.message

    @property
    def effective_chat(self):
        return self.message.chat


class PostDoble(object):
    def __init__(self, respuestas_lote=None):
        self.llamadas = []
        self.respuestas_lote = list(respuestas_lote or [])
        self.codigos = []
        self.confirmados = 0

    def __call__(self, ruta, cuerpo):
        self.llamadas.append((ruta, cuerpo))
        if ruta == "/api/bot/catalogo":
            return 200, {"ok": True, "productos": []}
        if ruta == "/api/bot/lote/ciclo" and cuerpo.get("accion") == "temperatura":
            self.temperaturas = getattr(self, "temperaturas", 0) + 1
            return 200, {"ok": True}
        if ruta == "/api/bot/lote/ciclo" and cuerpo.get("accion") == "leer":
            return 200, {"ok": True, "lotes": [], "admins": [], "temperaturas": [], "codigos": list(self.codigos)}
        if ruta == PROPONER:
            if self.respuestas_lote:
                return self.respuestas_lote.pop(0)
            cod = (cuerpo.get("propuesta") or {}).get("codigo_lote") or "L-1017"
            return 200, {"ok": True, "borrador_id": UUID, "sello": "s" * 64,
                         "codigo_lote": cod, "mensaje": "Lote %s (propuesta)" % cod}
        if ruta == "/api/bot/lote/confirmar":
            self.confirmados += 1
            return 200, {"ok": True, "id_lote": "id-1", "codigo_lote": "L-x", "mensaje": "resumen"}
        return 200, {"ok": True}

    def lotes(self):
        return [c for r, c in self.llamadas if r == PROPONER]


class Modelo(object):
    """`enrutar` doblado: cuenta cuantas veces se le llama."""

    def __init__(self, ruta=None):
        self.veces = 0
        self.ruta = ruta or {"intencion": "charla", "confianza": "alta", "campos": {},
                             "respuesta": "ok"}

    def __call__(self, *a, **kw):
        self.veces += 1
        return True, dict(self.ruta)


def limpiar():
    B._olvidar_chat(CHAT)
    dict.pop(B._memoria, CHAT, None)
    P.olvidar(CHAT)


def conversar(mensajes, modelo=None, doble=None):
    """Mensajes en fila por `manejar_texto`. Devuelve (dichos, doble, modelo)."""
    limpiar()
    modelo = modelo or Modelo()
    doble = doble or PostDoble()
    dichos = []
    orig = B.enrutar, B._post
    B.enrutar, B._post = modelo, doble
    try:
        for m in mensajes:
            asyncio.run(B.manejar_texto(UpdateDeTexto(CHAT, m, dichos), None))
    finally:
        B.enrutar, B._post = orig
    return dichos, doble, modelo


def kilos(pet):
    for i in pet.get("insumos") or []:
        if "chile" in str(i.get("insumo")):
            return i.get("cantidad")
    return None


def numeradas(texto):
    return len(re.findall(r"(?m)^\s*\d+\.\s", texto))


HOY_TXT = P.fecha_para_persona(P.hoy_local())
HOY_COD = P.codigo_siguiente([], P.hoy_local())          # L-DD-MM.1 de hoy


def boton(accion, doble, dichos=None):
    """Toca un boton por `_manejar_boton` real, con `_post` doblado."""
    u = UpdateDeTexto(CHAT, "", dichos)
    orig = B._post
    B._post = doble
    try:
        asyncio.run(B._manejar_boton(u, CHAT, None, [accion, "x"], accion))
    finally:
        B._post = orig
    return u.message.dichos


def seguir(texto, doble, dichos, modelo=None):
    orig = B.enrutar, B._post
    B.enrutar, B._post = (modelo or Modelo()), doble
    try:
        asyncio.run(B.manejar_texto(UpdateDeTexto(CHAT, texto, dichos), None))
    finally:
        B.enrutar, B._post = orig


def aditivo(pet):
    for i in pet.get("insumos") or []:
        # Fase 7: el SKU del YAML (mosto-1 en produccion), en GRAMOS (la unidad
        # del catalogo; Norman 2026-11-07: "quiero que sean 180 gramos").
        if i.get("insumo") == B.lote_plantilla.plantilla().get("aditivo_1_sku"):
            assert i.get("unidad") == "g", i
            return i.get("cantidad")
    return None


# ─── 1. la plantilla nueva, en tres mensajes, y el Confirmar ────────────────
dichos, doble, modelo = conversar(["empecemos", "40 kilos de chile guajillo",
                                   "brix chile 12, 3 kilos de aditivo, brix final 18"])
caso("1. 'empecemos' abre la plantilla SIN modelo", modelo.veces, 0)
caso("1. la plantilla va encabezada por el codigo L-DD-MM.N de hoy", dichos[0].split("\n")[0], HOY_COD)
caso("1. ... con las 4 preguntas nuevas, numeradas",
     [l for l in dichos[0].split("\n") if re.match(r"^\d\. ", l)],
     ["1. Kilos de chile y tipo de chile", "2. Brix chile", "3. Gramos de aditivo 1", "4. Brix final"])
caso("1. ... sin dias de fermentacion ni tandas",
     ("dias" in dichos[0].lower(), "tanda" in dichos[0].lower()), (False, False))
caso("1. luego pregunta SOLO lo que falta (<=4)", (dichos[1].startswith("Me falta:"), numeradas(dichos[1])), (True, 3))
res = dichos[-1]
caso("1. al final: el resumen con TODO y la fecha de hoy",
     (HOY_COD in res, ("Fecha: %s (hoy)" % HOY_TXT) in res, "Kilos de chile: 40 kg" in res, "Tipo de chile: guajillo" in res,
      "Brix chile: 12" in res, "Aditivo 1: 3000 g" in res, "Brix final: 18" in res), (True,) * 7)
caso("1. ... y NADA se propuso antes de Confirmar", len(doble.lotes()), 0)
caso("1. ... ninguna respuesta con mas de 4 numeradas", max(numeradas(d) for d in dichos) <= 4, True)
boton("ltok", doble, dichos)
lotes = doble.lotes()
pet = lotes[-1] if lotes else {}
caso("1. Confirmar: UNA propuesta", len(lotes), 1)
caso("1. ... kilos de chile y aditivo 1 por SKU opaco ('3 kilos' DICHOS -> 3000 g)", (kilos(pet), aditivo(pet)), (40, 3000))
caso("1. ... Brix chile y final", ((pet.get("propuesta") or {}).get("brix_chile"), (pet.get("propuesta") or {}).get("brix_final")),
     (12, 18))
caso("1. ... el codigo que se enseno", (pet.get("propuesta") or {}).get("codigo_lote"), HOY_COD)
# Ronda 5 (C): guajillo es un tipo CONOCIDO: va por su SKU, no a notas.
caso("1. ... guajillo va por su SKU (chile-guajillo), no a notas",
     ([i.get("insumo") for i in pet.get("insumos") or [] if "chile" in str(i.get("insumo"))],
      "guajillo" in ((pet.get("propuesta") or {}).get("notas") or "")), (["chile-guajillo"], False))
caso("1. ... y se confirma sin pedir otro VA", doble.confirmados, 1)
caso("1. ... y lo dice", dichos[-1].startswith("Listo. Quedo el lote"), True)
caso("1. ... la sesion se cerro", P.activa(CHAT), False)

# --- 1b. RONDA 2: el aviso de guajillo y "a 24 grados" a notas (recuperada) --
caso("1b. guajillo: SIN el aviso de catalogo", any("unico en catalogo" in d for d in dichos), False)
# Ronda 5 (C): un chile que no es guajillo ni guajon se AVISA y se PREGUNTA una vez.
dichos, doble, modelo = conversar(["empecemos", "40 kilos de chile jalapeno, brix chile 12, 3 kilos de aditivo, brix final 18",
                                   "lo dejamos a 24 grados"])
caso("1b. jalapeno: avisa y pregunta cual (guajillo, guajon o mezcla)",
     sum("Solo uso guajillo, guajon o una mezcla" in d for d in dichos), 1)
caso("1b. ... sin proponer nada todavia", len(doble.lotes()), 0)
caso("1b. ... si no lo aclaran: el resumen avisa que los kilos se cargan a chile-guajillo",
     "los kilos se cargan a chile-guajillo: el tipo 'jalapeno' no es guajillo ni guajon" in dichos[-1], True)
caso("1b. 'a 24 grados' NO se adivina: a notas, visible en el resumen",
     "24 grados (no dijeron si es temperatura o alcohol)" in dichos[-1], True)
caso("1b. ... y NO se guarda como temperatura del cuarto", getattr(doble, "temperaturas", 0), 0)
boton("ltok", doble, dichos)
pet = (doble.lotes() or [{}])[-1]
caso("1b. ... y viaja en las notas del lote", "24 grados" in (pet.get("propuesta", {}).get("notas") or ""), True)
caso("1b. ... los kilos van a chile-guajillo y el tipo dicho a notas",
     ([i.get("insumo") for i in pet.get("insumos") or [] if "chile" in str(i.get("insumo"))],
      "jalapeno" in (pet.get("propuesta", {}).get("notas") or "")), (["chile-guajillo"], True))

# 1c. Ronda 5 (C): a la pregunta contestan 'guajon' -> chile-guajon, sin aviso.
dichos, doble, modelo = conversar(["empecemos", "40 kilos de chile jalapeno, brix chile 12, 3 kilos de aditivo, brix final 18",
                                   "guajon"])
caso("1c. contestan 'guajon': el resumen sin el aviso de guajillo",
     ("Tipo de chile: guajon" in dichos[-1], "se cargan a chile-guajillo" in dichos[-1]), (True, False))
boton("ltok", doble, dichos)
pet = (doble.lotes() or [{}])[-1]
caso("1c. ... los kilos van a chile-guajon",
     [(i.get("insumo"), i.get("cantidad")) for i in pet.get("insumos") or [] if "chile" in str(i.get("insumo"))],
     [("chile-guajon", 40)])

# 1d. Ronda 5 (C): la MEZCLA, dos renglones de insumo.
dichos, doble, modelo = conversar(["empecemos", "30 kg guajillo y 10 kg guajon, brix chile 12, 3 kilos de aditivo, brix final 18"])
caso("1d. mezcla: el resumen ensena los dos chiles, total 40, sin aviso",
     ("chile guajillo: 30 kg" in dichos[-1], "chile guajon: 10 kg" in dichos[-1], "Kilos de chile: 40 kg" in dichos[-1],
      "se cargan a chile-guajillo" in dichos[-1], "Solo uso guajillo" in "".join(dichos)), (True, True, True, False, False))
boton("ltok", doble, dichos)
pet = (doble.lotes() or [{}])[-1]
caso("1d. ... dos renglones de insumo por SKU",
     sorted((i.get("insumo"), i.get("cantidad")) for i in pet.get("insumos") or [] if "chile" in str(i.get("insumo"))),
     [("chile-guajillo", 30), ("chile-guajon", 10)])
caso("1d. ... y el aditivo 1 sigue", aditivo(pet), 3000)

# ─── 2. numeradas en un mensaje; "confirmar" dicho ──────────────────────────
dichos, doble, modelo = conversar(["dame la plantilla del lote", "1. 35 guajon 2. 11.5 3. 2.5 4. 17", "confirmar"])
pet = (doble.lotes() or [{}])[-1]
caso("2. numeradas: todo de una", (kilos(pet), aditivo(pet), pet.get("propuesta", {}).get("brix_chile"),
                                   pet.get("propuesta", {}).get("brix_final")), (35, 2.5, 11.5, 17))

# Fase 7 (2026-11-07): el aditivo 1 se pregunta EN GRAMOS (unidad del catalogo).
# Un numero solo = gramos; la unidad dicha se respeta. Ninguna conversion callada.
P_ = B.lote_plantilla
C_AD1 = P_._campo("aditivo_1")
caso("2b. el YAML pregunta el aditivo 1 en gramos", (C_AD1["unidad"], "gramos" in C_AD1["pregunta"]), ("g", True))
caso("2b. el rango acepta una receta de 8 g y una de 8 kg (solo avisa)",
     (C_AD1["rango"][0] <= 8 <= C_AD1["rango"][1], C_AD1["rango"][0] <= 8000 <= C_AD1["rango"][1]), (True, True))
caso("2b. numeradas '3. 8' -> 8 g", P_.leer("1. 35 guajon 2. 11.5 3. 8 4. 17", [["kg_chile", "tipo_chile"], ["brix_chile"],
                                                                                   ["aditivo_1"], ["brix_final"]])["campos"]["aditivo_1"], 8)
caso("2b. numeradas '3. 8 kg' -> 8000 g", P_.leer("1. 35 guajon 2. 11.5 3. 8 kg 4. 17", [["kg_chile", "tipo_chile"], ["brix_chile"],
                                                                                        ["aditivo_1"], ["brix_final"]])["campos"]["aditivo_1"], 8000)
caso("2b. solo '8' a la pregunta del aditivo -> 8 g", P_.leer("8", [["aditivo_1"]])["campos"].get("aditivo_1"), 8)
caso("2b. '800 g de aditivo' -> 800", P_.leer("800 g de aditivo")["campos"].get("aditivo_1"), 800)
caso("2b. '1.5 kilos de aditivo' -> 1500", P_.leer("1.5 kilos de aditivo")["campos"].get("aditivo_1"), 1500)
caso("2b. CONTROL: '40 kilos de chile' sigue en kg (40), no en gramos",
     P_.leer("40 kilos de chile")["campos"].get("kg_chile"), 40)
caso("2b. peticion: el aditivo va con la unidad del campo",
     [i for i in P_.campos_para_peticion({"campos": {"aditivo_1": 8}, "codigo": None})["insumos"]],
     [{"insumo": "mosto-1", "cantidad": 8, "unidad": "g"}])
caso("2. ... 'confirmar' (dicho o por voz) confirma", doble.confirmados, 1)
caso("2. ... guajon por su SKU", [i.get("insumo") for i in pet.get("insumos") or [] if "chile" in str(i.get("insumo"))],
     ["chile-guajon"])

# ─── 3. "luego": pendiente, se pregunta UNA vez ─────────────────────────────
dichos, doble, modelo = conversar(["empezamos lote nuevo", "40 kilos de chile", "luego"])
caso("3. 'luego': resumen con lo pendiente", ("Brix chile: pendiente" in dichos[-1], "Brix final: pendiente" in dichos[-1]),
     (True, True))
boton("ltok", doble, dichos)
pet = (doble.lotes() or [{}])[-1]
caso("3. ... y queda anotado en notas", "pendiente" in (pet.get("propuesta", {}).get("notas") or ""), True)

# ─── 4. rango: avisa, no bloquea ────────────────────────────────────────────
dichos, doble, modelo = conversar(["empezamos lote nuevo", "1500 kilos de chile, brix chile 12, 3 kilos de aditivo, brix final 18"])
caso("4. fuera de rango: avisa", any("Ojo" in d and "1500" in d for d in dichos), True)
caso("4. ... el aviso es legible", any("Kilos de chile = 1500 kg se sale de lo normal (1 a 1000)" in d for d in dichos), True)
boton("ltok", doble, dichos)
caso("4. ... y NO bloquea: propone con 1500", kilos((doble.lotes() or [{}])[-1]), 1500)

# ─── 5. Corregir ────────────────────────────────────────────────────────────
dichos, doble, modelo = conversar(["empecemos", "40 kilos de chile, brix chile 12, 3 kilos de aditivo, brix final 18"])
boton("ltcor", doble, dichos)
caso("5. Corregir: dice que hay y pide el numero", ("Que corrijo?" in dichos[-1], "2. Brix chile: 12" in dichos[-1]), (True, True))
seguir("2. 13", doble, dichos)
caso("5. ... vuelve a ensenar el resumen corregido", ("Brix chile: 13" in dichos[-1], "Nada se guarda" in dichos[-1]), (True, True))
caso("5. ... sin proponer", len(doble.lotes()), 0)
boton("ltok", doble, dichos)
caso("5. Confirmar usa lo corregido", (doble.lotes() or [{}])[-1].get("propuesta", {}).get("brix_chile"), 13)

# ─── 6. el codigo: .2 con uno hoy; otro lo toma antes del Confirmar ─────────
doble = PostDoble()
doble.codigos = [HOY_COD]
dichos, doble, modelo = conversar(["empecemos"], doble=doble)
cod2 = P.codigo_siguiente([HOY_COD], P.hoy_local())
caso("6. con un lote hoy, la plantilla dice .2", dichos[0].split("\n")[0], cod2)
seguir("40 kilos de chile, brix chile 12, 3 kilos de aditivo, brix final 18", doble, dichos)
doble.codigos = [HOY_COD, cod2]            # otro chat confirmo el .2 en medio
boton("ltok", doble, dichos)
cod3 = P.codigo_siguiente([HOY_COD, cod2], P.hoy_local())
caso("6. el codigo se tomo en medio: NO escribe, ensena el nuevo", (len(doble.lotes()), cod3 in dichos[-1]), (0, True))
boton("ltok", doble, dichos)
caso("6. ... y al confirmar otra vez va con el nuevo", (doble.lotes() or [{}])[-1].get("propuesta", {}).get("codigo_lote"), cod3)

# ─── 7. disparadores nuevos ─────────────────────────────────────────────────
for t in ("empecemos", "Empezemos!", "iniciemos", "arranquemos", "arranquemos lote", "iniciemos el lote",
          "empecemos un lote", "hoy empecemos"):
    caso("7. disparador %r" % t, P.es_disparador(P._plano(t)), True)
for t in ("empecemos a vender", "iniciemos la cotizacion de Delirio"):
    caso("7. CONTROL %r no abre la plantilla" % t, P.es_disparador(P._plano(t)), False)

# ─── 8. el modelo dice `lote` -> la plantilla (nunca propone sin Confirmar) ─
modelo = Modelo({"intencion": "lote", "confianza": "alta", "campos": {}, "respuesta": ""})
dichos, doble, _m = conversar(["manana le metemos chile al lote"], modelo=modelo)
caso("8. lote sin datos (modelo): manda la plantilla", bool(dichos) and "1. Kilos de chile" in dichos[-1], True)
modelo = Modelo({"intencion": "lote", "confianza": "alta", "campos": {"kg_chile": 40}, "respuesta": ""})
dichos, doble, _m = conversar(["metimos 40 kilos de chile al lote de hoy"], modelo=modelo)
caso("8. lote con kilos (modelo): pregunta lo que falta, no propone",
     (dichos[-1].startswith("Me falta:"), len(doble.lotes())), (True, 0))

# ─── 9. CONTROLES: lo que NO es de la plantilla va al modelo ────────────────
for texto in ("pague 300 de gasolina", "va"):
    limpiar()
    modelo, doble, dichos = Modelo(), PostDoble(), []
    orig = B.enrutar, B._post
    B.enrutar, B._post = modelo, doble
    try:
        asyncio.run(B.manejar_texto(UpdateDeTexto(CHAT, "empezamos lote nuevo", dichos), None))
        asyncio.run(B.manejar_texto(UpdateDeTexto(CHAT, texto, dichos), None))
    finally:
        B.enrutar, B._post = orig
    if texto == "va":
        caso("9. CONTROL con plantilla a medias, 'va' no lo consume la plantilla",
             (P.leer(texto, [["kg_chile"]])["consumio"], len(doble.lotes()), len(dichos)), (False, 0, 2))
    else:
        caso("9. CONTROL con plantilla viva, %r va al modelo" % texto, modelo.veces, 1)
    caso("9. ... y la plantilla sigue viva", P.activa(CHAT), True)

modelo = Modelo({"intencion": "cancelar", "confianza": "alta", "campos": {}, "respuesta": ""})
dichos, doble, _m = conversar(["empezamos lote nuevo", "cancela eso"], modelo=modelo)
caso("9. CONTROL 'cancela' suelta la plantilla", P.activa(CHAT), False)

# CONTROL negativo: sin el disparador, la conversacion 1 NO llega al resumen.
original = P.es_disparador
P.es_disparador = lambda t: False
try:
    dichos, doble, modelo = conversar(["empecemos", "40 kilos de chile guajillo"])
finally:
    P.es_disparador = original
caso("CONTROL sin disparador no hay plantilla (la prueba puede fallar)",
     any(HOY_COD in d for d in dichos), False)

# ─── 10. Ronda 5 (B): el envasado es diario y NO se liga al lote ─────────────
# Se retiro "envasado sin lote ofrece abrirlo" (WP-7a). Va al modelo y de ahi
# al servidor como envasado; nunca abre, pide ni se junta con un lote.
modelo = Modelo({"intencion": "lote", "confianza": "alta",
                 "campos": {"botellas": 40, "formato": "250", "codigo_lote": "L-12-10.1"}, "respuesta": ""})
dichos, doble, _m = conversar(["envasamos 40 chicas hoy del L-12-10.1"], modelo=modelo)
lotes = doble.lotes()
caso("10. envasado: va al modelo (la plantilla no lo toma)", modelo.veces, 1)
caso("10. ... UNA peticion, con el envasado y sin abrir_lote_nuevo",
     (len(lotes), bool((lotes or [{}])[-1].get("envasado")), (lotes or [{}])[-1].get("abrir_lote_nuevo")), (1, True, None))
caso("10. ... sin campos de plantilla (insumos)", (lotes or [{}])[-1].get("insumos") or [], [])
caso("10. ... no abrio plantilla ni espera boton de abrir lote",
     (P.activa(CHAT), (B._memoria.get(CHAT) or {}).get("tipo") == "lote_ofrecer_abrir",
      any("Abro un lote nuevo" in d for d in dichos)), (False, False, False))

# 10b. con una plantilla A MEDIAS: el envasado no se le mete y la plantilla sigue viva
dichos, doble, _m = conversar(["empecemos", "40 kilos de chile guajillo", "envasamos 40 chicas hoy"], modelo=modelo)
lotes = doble.lotes()
caso("10b. plantilla a medias + envasado: el envasado va solo al servidor",
     (len(lotes), bool((lotes or [{}])[-1].get("envasado")), (lotes or [{}])[-1].get("insumos") or []), (1, True, []))
caso("10b. ... y la plantilla sigue viva con sus 40 kg", (P.activa(CHAT), (P.sesion(CHAT) or {}).get("campos", {}).get("kg_chile")),
     (True, 40))

# 10d. un envasado que el lector de la plantilla SI consumiria ('18 kilos' ->
# kilos de chile) con la plantilla abierta: el envasado no entra a la plantilla.
modelo = Modelo({"intencion": "lote", "confianza": "alta", "campos": {"botellas": 18, "formato": "750"}, "respuesta": ""})
dichos, doble, _m = conversar(["empecemos", "envasamos 18 kilos"], modelo=modelo)
caso("10d. 'envasamos 18 kilos' con la plantilla abierta: NO son kilos de chile, va al modelo",
     (((P.sesion(CHAT) or {}).get("campos") or {}).get("kg_chile"), modelo.veces, P.activa(CHAT)), (None, 1, True))

# 10c. un boton viejo de "Abrir lote nuevo" ya no abre nada ni re-propone
B._memoria[CHAT] = {"tipo": "lote_ofrecer_abrir", "peticion": {"envasado": [{"formato": "250", "botellas": 40}]}}
doble = PostDoble()
dichos = []
u = UpdateDeTexto(CHAT, "", dichos)
orig = B._post
B._post = doble
try:
    asyncio.run(B._manejar_boton(u, CHAT, None, ["abrlt", "x"], "abrlt"))
finally:
    B._post = orig
caso("10c. boton viejo abrlt: no re-propone", len(doble.lotes()), 0)
caso("10c. ... y lo dice", any("Ya no abro lotes desde un envasado" in d for d in dichos), True)


# --- 11. RONDA 6 (auditoria r5, 5): mezcla SIN kilos por tipo ---------------
# No se carga entera a guajillo en silencio: se pregunta cuantos de cada uno;
# "mitad" reparte 50/50 y se ensena en el resumen antes de Confirmar.
dichos, doble, modelo = conversar(["empecemos", "40 kilos de guajillo y guajon, brix chile 12, 3 kilos de aditivo, brix final 18"])
caso("11. '40 kilos de guajillo y guajon': pregunta cuantos de cada uno",
     "Cuantos kilos de cada uno" in dichos[-1], True)
caso("11. ... sin resumen ni propuesta todavia", (any("Revisa el lote" in d for d in dichos), len(doble.lotes())), (False, 0))
seguir("30 kg guajillo y 10 kg guajon", doble, dichos)
caso("11. ... contestan los kilos: el resumen con los dos chiles",
     ("chile guajillo: 30 kg" in dichos[-1], "chile guajon: 10 kg" in dichos[-1]), (True, True))
boton("ltok", doble, dichos)
pet = (doble.lotes() or [{}])[-1]
caso("11. ... dos renglones por SKU",
     sorted((i.get("insumo"), i.get("cantidad")) for i in pet.get("insumos") or [] if "chile" in str(i.get("insumo"))),
     [("chile-guajillo", 30), ("chile-guajon", 10)])
dichos, doble, modelo = conversar(["empecemos", "40 kilos de guajillo y guajon, brix chile 12, 3 kilos de aditivo, brix final 18",
                                   "mitad y mitad"])
caso("11. contestan 'mitad y mitad': 20 y 20 en el resumen, visible antes de Confirmar",
     ("chile guajillo: 20 kg" in dichos[-1], "chile guajon: 20 kg" in dichos[-1], "mitad" in dichos[-1].lower()),
     (True, True, True))
dichos, doble, modelo = conversar(["empecemos", "mitad guajillo mitad guajon, 40 kilos, brix chile 12, 3 kilos de aditivo, brix final 18"])
caso("11. 'mitad guajillo mitad guajon, 40 kilos': reparte 50/50 sin preguntar",
     ("chile guajillo: 20 kg" in dichos[-1], "chile guajon: 20 kg" in dichos[-1], "Cuantos kilos de cada uno" in "".join(dichos)),
     (True, True, False))
boton("ltok", doble, dichos)
pet = (doble.lotes() or [{}])[-1]
caso("11. ... y confirma dos renglones de 20",
     sorted((i.get("insumo"), i.get("cantidad")) for i in pet.get("insumos") or [] if "chile" in str(i.get("insumo"))),
     [("chile-guajillo", 20), ("chile-guajon", 20)])
dichos, doble, modelo = conversar(["empecemos", "40 kilos de chile guajillo, brix chile 12, 3 kilos de aditivo, brix final 18"])
caso("11. CONTROL un solo chile: no pregunta reparto", "Cuantos kilos de cada uno" in "".join(dichos), False)

# --- 12. RONDA 6 (auditoria r5, 2): confirmar un envasado diario -------------
limpiar()
dichos = []
u = UpdateDeTexto(CHAT, "", dichos)
B._memoria[CHAT] = {"tipo": "lote", "borrador_id": UUID, "sello": "s" * 64}
orig = B._post
B._post = lambda ruta, cuerpo: (200, {"ok": True, "envasado_diario": True, "filas_inventario": 2,
                                      "mensaje": "Listo. Envasado del 19/10/2026: 40 de 750 ml (sin lote); 2 movimientos de inventario."})
try:
    asyncio.run(B._confirmar_lote(u, CHAT))
finally:
    B._post = orig
caso("12. confirmar envasado diario: NO dice 'Quedo el lote'", any("Quedo el lote" in d for d in dichos), False)
caso("12. ... dice el envasado del dia", any(d.startswith("Listo. Envasado del 19/10/2026: 40 de 750 ml") for d in dichos), True)

# ─── RESULTADO ──────────────────────────────────────────────────────────────
limpiar()
fallos = [(n, o, e) for n, o, e in casos if o != e]
for n, o, e in casos:
    print(("ok   " if o == e else "FALLA") + "  " + n + ("" if o == e else "  -> obtuve %r, esperaba %r" % (o, e)))
if fallos:
    print("RESULTADO: %d de %d casos FALLAN" % (len(fallos), len(casos)))
    sys.exit(1)
print("RESULTADO: los %d casos pasan" % len(casos))
