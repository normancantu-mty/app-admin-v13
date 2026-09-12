"""
bot_gastos.py — AG-01 Fase 1. El bot de captura de gastos del ERP.

Copia el patron de `Socio/asistente/telegram_socio.py` (long polling, candado de
instancia unica, un solo trabajador, latido). **No extiende aquel proceso**: es
otro bot, con otro token, otro publico y otro dominio.

LOS CINCO PASOS (D-E30), Y DONDE VIVE CADA UNO
----------------------------------------------
  1. Entra lenguaje natural (texto o nota de voz) ............ aqui
  2. El LLM emite UN objeto de cuatro campos ................. bot/extraer.py
  3. Se propone una fila y se SELLA .......................... POST /api/bot/gasto/proponer
  4. La persona confirma o corrige UN CAMPO .................. aqui
  5. Se escribe el objeto exacto, verificando el sello ....... POST /api/bot/gasto/confirmar

Entre el paso 4 y el 5 **no hay ninguna llamada al modelo**, y no es cuestion de
disciplina: al confirmar solo se mandan `{telegram_id, borrador_id, sello}`. No
hay ningun campo que el modelo pudiera tocar aunque el codigo quisiera.

LA CORRECCION ES POR CAMPO, NO POR FRASE
----------------------------------------
El plan decia "corrige en lenguaje normal y se vuelve al paso 2", o sea
re-extraer todo. Dos ecosistemas coinciden en lo contrario (ver
`INVESTIGACION_previa_bot_telegram_2026-09-12.md`): el patron chino de captura
por voz edita el CAMPO, y el patron ruso AI-Gateway insiste en que el valor lo
ponga el sistema y no la pluma del modelo. Corregir la frase entera le da al
modelo licencia para cambiar campos que nadie pidio cambiar.
"""

import asyncio
import datetime as dt
import json
import logging
import os
import socket
import sys
import urllib.request
from pathlib import Path

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.ext import (Application, CallbackQueryHandler, CommandHandler,
                          ContextTypes, MessageHandler, filters)

sys.path.insert(0, str(Path(__file__).resolve().parent))
from extraer import CATEGORIAS, extraer  # noqa: E402
from consultar import clasificar  # noqa: E402
from extraer_abono import extraer_abono  # noqa: E402

NL = chr(10)
RAIZ = Path(__file__).resolve().parent
AUDIOS = RAIZ / "_audios"

# Mismo candado que el bot del Socio, en otro puerto: bind() en loopback es la
# primitiva mas barata de instancia unica y se libera sola cuando muere el proceso.
PUERTO_CANDADO = 47312
INTERVALO_LATIDO = 15 * 60

API = os.environ.get("ERP_API_URL", "http://localhost:3000").rstrip("/")
TOKEN_API = os.environ.get("BOT_API_TOKEN", "")
TOKEN_TG = os.environ.get("BOT_GASTOS_TELEGRAM_TOKEN", "")

logging.basicConfig(
    format="%(asctime)s %(levelname)s %(message)s",
    level=logging.INFO,
    handlers=[logging.FileHandler(RAIZ / "bot_gastos.log", encoding="utf-8"),
              logging.StreamHandler()],
)
log = logging.getLogger("bot_gastos")


def _post(ruta, cuerpo):
    """Llama a la app. Devuelve (status, objeto)."""
    datos = json.dumps(cuerpo).encode("utf-8")
    pet = urllib.request.Request(
        API + ruta, data=datos, method="POST",
        headers={"Content-Type": "application/json", "x-bot-token": TOKEN_API},
    )
    try:
        with urllib.request.urlopen(pet, timeout=30) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8"))
        except Exception:
            return e.code, {"error": "error " + str(e.code)}
    except Exception as e:
        return 0, {"error": "no pude hablarle al ERP: " + str(e)}


# ===========================================================================
# EL TECLADO — la confirmacion, y la correccion por campo
# ===========================================================================

def _teclado_confirmar(borrador_id):
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("VA, escribelo", callback_data="va:" + borrador_id)],
        [InlineKeyboardButton("Cambiar categoria", callback_data="cat:" + borrador_id),
         InlineKeyboardButton("Cambiar monto", callback_data="monto:" + borrador_id)],
        [InlineKeyboardButton("Cambiar cuenta", callback_data="cta:" + borrador_id)],
        [InlineKeyboardButton("Cancelar", callback_data="no:" + borrador_id)],
    ])


def _teclado_categorias(borrador_id, categorias=None):
    filas = [[InlineKeyboardButton(nombre, callback_data="setcat:" + borrador_id + ":" + nombre)]
             for nombre in (categorias or CATEGORIAS)]
    filas.append([InlineKeyboardButton("Ninguna (dejar sin categorizar)",
                                       callback_data="setcat:" + borrador_id + ":SIN_CATEGORIZAR")])
    return InlineKeyboardMarkup(filas)


def _teclado_confirmar_abono(borrador_id):
    """El mismo VA de la Fase 1, con los campos que de verdad se corrigen aqui.

    No hay "cambiar categoria" porque un abono no tiene: lo que se equivoca es
    el DEUDOR o el MONTO. Y no hay "cambiar cuenta" del deudor porque esa la
    resuelve el servidor y es una sola (medido el 2026-09-12).
    """
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("VA, escribelo", callback_data="vaab:" + borrador_id)],
        [InlineKeyboardButton("Otro deudor", callback_data="deu:" + borrador_id),
         InlineKeyboardButton("Cambiar monto", callback_data="montoab:" + borrador_id)],
        [InlineKeyboardButton("Cancelar", callback_data="no:" + borrador_id)],
    ])


def _teclado_deudores(opciones):
    """Los deudores van POR INDICE, por la misma razon que las cuentas.

    `callback_data` topa en 64 bytes, y el indice solo puede apuntar a algo que
    el servidor acaba de declarar como candidato: el proceso del bot no tiene
    forma de nombrar una entidad que no este en esa lista.
    """
    filas = [[InlineKeyboardButton(
        o["nombre"] + " (" + o["rol"] + ")",
        callback_data="setdeu:" + str(i))] for i, o in enumerate(opciones)]
    return InlineKeyboardMarkup(filas)


def _teclado_cuentas(cuentas):
    """Las cuentas van POR INDICE, no por uuid.

    Dos razones, y las dos importan. La de bulto: `callback_data` topa en 64
    bytes y "setcta:<uuid de borrador>:<uuid de cuenta>" son 80. La de fondo:
    el indice solo puede apuntar a algo que el servidor ya declaro usable en
    esta propuesta, asi que el proceso del bot no tiene forma de nombrar una
    cuenta que no este en esa lista.
    """
    filas = [[InlineKeyboardButton(c["nombre"], callback_data="setcta:" + str(i))]
             for i, c in enumerate(cuentas)]
    return InlineKeyboardMarkup(filas)


# ===========================================================================
# EL CAMINO PRINCIPAL
# ===========================================================================

def _refrescar_catalogo(respuesta):
    """El catalogo del proceso se pone al dia con lo que dijo el servidor.

    **La base manda.** Esto existe solo para que el extractor conozca las
    categorias creadas con el uso; si se desincroniza, lo peor que pasa es que
    el modelo proponga como nueva una que ya existe, y la puerta del servidor
    la rechaza sin escribir nada.
    """
    global _catalogo
    vivas = respuesta.get("categorias")
    if isinstance(vivas, list) and vivas:
        _catalogo = list(vivas)


async def _contestar_consulta(update, chat, texto):
    """Fase 3. Devuelve True si contesto una consulta.

    EL MODELO NO VE NI UN NUMERO. Clasifica la intencion, el servidor lee la
    vista y **devuelve el texto ya formateado**; aqui solo se reenvia. Por eso
    una consulta no puede contestar una cifra inventada: no hay ningun punto del
    camino donde el LLM pueda escribirla.
    """
    ok, obj = await asyncio.to_thread(clasificar, texto)
    if not ok or not obj.get("consulta"):
        return False

    estado, r = _post("/api/bot/consulta", {
        "telegram_id": chat,
        "consulta": obj["consulta"],
        "filtro": obj.get("filtro"),
    })
    # Se registra QUE se consulto y COMO salio, nunca la respuesta: el log ya
    # lleva el token del bot en cada linea de la libreria y no se le agregan
    # cifras del negocio. Sin esta linea, un uso real del bot no dejaba rastro
    # del lado de la maquina y no habia con que comprobarlo despues.
    log.info("consulta por voz/texto: %s filtro=%s -> %s",
             obj["consulta"], obj.get("filtro"), estado)
    if estado != 200 or not r.get("ok"):
        await update.effective_message.reply_text(
            r.get("error", "No pude consultarlo."))
        return True

    await update.effective_message.reply_text(r["texto"])
    return True


async def _proponer_abono(update, chat, texto, id_deudor=None, propuesta=None, nombre=None):
    """Fase 2. Devuelve True si propuso un abono (o si pidio elegir deudor).

    EL MODELO NO ELIGE A NADIE: devuelve un NOMBRE y el servidor lo empata
    contra la cartera viva. Si hay mas de un candidato, o ninguno, vuelve con
    `hay_que_elegir` y lo resuelve un boton. Escribir dinero en la entidad
    equivocada no se corrige solo: hay que anular la fila y recapturar.
    """
    if propuesta is None:
        ok, obj = await asyncio.to_thread(extraer_abono, texto, _nombres_deudores())
        if not ok:
            return False
        if obj.get("falta") == "esto no parece un abono":
            return False
        if obj.get("monto") in (None, "", 0):
            # Falta el monto: se PREGUNTA. Un abono a medias no se adivina, y
            # tampoco se deja caer al camino de la consulta.
            _pendiente[chat] = texto
            await update.effective_message.reply_text(
                "Me falta " + str(obj.get("falta") or "de cuanto fue") + ". Me lo dices?")
            return True
        propuesta = {
            "monto": obj.get("monto"),
            "metodo_pago": obj.get("metodo_pago"),
            "nota": obj.get("nota"),
            "fecha": obj.get("fecha"),
        }
        nombre_dicho = obj.get("deudor")
    else:
        # Cuando la propuesta viene armada (comando directo, o correccion de
        # monto) el nombre llega por parametro. Si tampoco hay, es porque ya se
        # resolvio el deudor por uuid.
        nombre_dicho = nombre

    cuerpo = {"telegram_id": chat, "propuesta": propuesta}
    if id_deudor:
        cuerpo["id_deudor"] = id_deudor
    else:
        cuerpo["deudor"] = nombre_dicho

    estado, r = _post("/api/bot/abono/proponer", cuerpo)
    _refrescar_deudores(r)
    log.info("abono propuesto: deudor=%s monto=%s -> %s",
             nombre_dicho or id_deudor, propuesta.get("monto"), estado)

    if estado == 200 and r.get("hay_que_elegir"):
        _memoria[chat] = {"tipo": "abono_eligiendo",
                          "opciones": r.get("opciones", list(_deudores)),
                          "propuesta": propuesta}
        await update.effective_message.reply_text(
            r.get("mensaje", "Quien te pago?"),
            reply_markup=_teclado_deudores(r.get("opciones", [])))
        return True

    if estado != 200 or not r.get("ok"):
        # 422 y 403 SI se dicen: llegamos aqui porque el extractor lo leyo como
        # abono, asi que callarse dejaria a la persona sin saber por que no paso
        # nada. Solo un "no es un abono" (arriba) sigue de largo a la consulta.
        await update.effective_message.reply_text(r.get("error", "No pude proponer el abono."))
        return True

    _memoria[chat] = {
        "tipo": "abono",
        "borrador_id": r["borrador_id"],
        "sello": r["sello"],
        "id_deudor": r.get("id_deudor"),
        "propuesta": propuesta,
        # La lista completa viaja con el borrador para que "Otro deudor" no
        # tenga que volver a preguntarle al servidor.
        "opciones": r.get("opciones", list(_deudores)),
    }
    await update.effective_message.reply_text(
        r["mensaje"], reply_markup=_teclado_confirmar_abono(r["borrador_id"]))
    return True


def _refrescar_deudores(respuesta):
    """La cartera viva que reporto el servidor, para dos usos.

    Vocabulario para el extractor (solo los NOMBRES) y la lista de "otro
    deudor". **La base manda**: el servidor vuelve a empatar contra su propia
    lista en cada peticion, asi que esto no es autoridad, es comodidad.
    """
    global _deudores
    vivos = respuesta.get("opciones")
    if isinstance(vivos, list) and vivos:
        _deudores = list(vivos)


def _nombres_deudores():
    return [d.get("nombre") for d in _deudores if isinstance(d, dict) and d.get("nombre")]


async def _proponer(update, texto, pendiente):
    """Del lenguaje natural al borrador sellado. Devuelve True si propuso."""
    chat = update.effective_chat.id

    ok, obj = await asyncio.to_thread(extraer, texto, list(_catalogo))
    if not ok:
        await update.effective_message.reply_text("No pude procesarlo: " + str(obj))
        return False

    # Slot filling: si el modelo dice que falta algo, se PREGUNTA. No se adivina.
    if obj.get("monto") in (None, "", 0) or not obj.get("descripcion"):
        falta = obj.get("falta") or "el monto"
        if falta == "esto no parece un gasto":
            # AG-04 Fase 3. **Este es el unico punto donde entra una consulta**,
            # y entra DESPUES de descartar el gasto, no antes. El orden importa:
            # si se preguntara primero "es una consulta?", un gasto mal dictado
            # podria contestarse como pregunta y no quedar registrado. Al reves,
            # lo peor que pasa es que una pregunta se intente leer como gasto y
            # el extractor la rechace, que es justo lo que acaba de ocurrir.
            # AG-02 Fase 2. **El abono va ANTES que la consulta y DESPUES que
            # el gasto**, y el orden no es arbitrario: los dos primeros
            # ESCRIBEN, y una escritura que se pierde no deja rastro de que se
            # perdio. Si una pregunta se intenta leer como abono, el extractor
            # la rechaza y seguimos; al reves, un pago dictado se habria
            # contestado como si fuera una consulta de cartera.
            # El costo es latencia: una pregunta en lenguaje natural paga tres
            # llamadas al modelo. Por eso existen /cartera, /stock y /abono.
            if await _proponer_abono(update, chat, texto):
                return False
            if await _contestar_consulta(update, chat, texto):
                return False
            await update.effective_message.reply_text(
                "Eso no lo lei como un gasto ni como una pregunta que sepa contestar. "
                "Para capturar: dime cuanto y en que fue. "
                "Para preguntar: stock, cartera (quien debe) o ventas.")
            return False
        pendiente[chat] = texto
        await update.effective_message.reply_text("Me falta " + str(falta) + ". Me lo dices?")
        return False

    estado, r = _post("/api/bot/gasto/proponer", {
        "telegram_id": chat,
        "propuesta": {
            "monto": obj.get("monto"),
            "categoria": obj.get("categoria"),
            "categoria_nueva": obj.get("categoria_nueva"),
            "descripcion": obj.get("descripcion"),
            "fecha": obj.get("fecha"),
        },
    })
    if estado != 200 or not r.get("ok"):
        await update.effective_message.reply_text(r.get("error", "No pude proponerlo."))
        return False

    _memoria[chat] = {
        "borrador_id": r["borrador_id"],
        "sello": r["sello"],
        "cuentas": r.get("cuentas", []),
        "id_cuenta": r.get("id_cuenta"),
        "categorias": r.get("categorias", list(_catalogo)),
        # La propuesta cruda se guarda para poder cambiar UN campo sin volver a
        # llamar al modelo. Es memoria del proceso, no autoridad: la fila que se
        # escribe es la sellada en la base, no esta.
        "propuesta": {
            "monto": obj.get("monto"),
            "categoria": obj.get("categoria"),
            "categoria_nueva": obj.get("categoria_nueva"),
            "descripcion": obj.get("descripcion"),
            "fecha": obj.get("fecha"),
        },
    }
    _refrescar_catalogo(r)
    await update.effective_message.reply_text(
        r["mensaje"], reply_markup=_teclado_confirmar(r["borrador_id"]))
    return True


# Lo unico que el bot guarda en memoria: el ultimo borrador por chat, para poder
# mandar el sello al confirmar. **El payload NO vive aqui** — vive en la base, y
# por eso este proceso no puede alterarlo aunque tuviera un bug.
_memoria = {}
_pendiente = {}
_esperando_monto = {}
# Las categorias que el servidor reporto en la ultima propuesta. Arranca con las
# del diccionario local y se actualiza sola: **la autoridad es la base**, esto
# es solo para que el extractor tenga el vocabulario completo la proxima vez.
_catalogo = list(CATEGORIAS)
# Los nombres de la cartera viva (Fase 2). Arranca VACIO a proposito: no hay
# una lista local de deudores que pudiera caducar. Hasta la primera respuesta
# del servidor, el extractor trabaja sin vocabulario y el servidor empata igual.
_deudores = []


async def manejar_texto(update, context):
    chat = update.effective_chat.id
    texto = (update.message.text or "").strip()

    # "va" escrito, no solo el boton: el usuario ocasional contesta como habla.
    if texto.lower() in ("va", "si", "sí", "correcto", "asi es", "dale"):
        await _confirmar(update, chat)
        return
    if texto.lower() in ("no", "cancela", "cancelar"):
        _memoria.pop(chat, None)
        await update.message.reply_text("Cancelado. No escribi nada.")
        return

    # Corrigiendo el monto de una propuesta viva: entra el numero y se
    # repropone con ese campo cambiado. **No pasa por el modelo.**
    if _esperando_monto.pop(chat, False):
        limpio = texto.replace("$", "").replace(",", "").replace("pesos", "").strip()
        try:
            monto = float(limpio)
        except ValueError:
            _esperando_monto[chat] = True
            await update.message.reply_text("No lo lei como numero. Solo la cifra, por favor.")
            return
        dato = _memoria.get(chat) or {}
        if dato.get("tipo") == "abono":
            propuesta = dict(dato.get("propuesta") or {})
            propuesta["monto"] = monto
            # Se repropone con el MISMO deudor ya resuelto (por uuid), no con el
            # nombre: cambiar el monto no puede cambiar a quien se le abona.
            await _proponer_abono(update, chat, texto,
                                  id_deudor=dato.get("id_deudor"), propuesta=propuesta)
            return
        await _reproponer(update, chat, {"propuesta": {"monto": monto}})
        return

    # Si veniamos preguntando un dato que faltaba, se junta con lo anterior.
    anterior = _pendiente.pop(chat, None)
    if anterior:
        texto = anterior + ". " + texto

    await update.message.chat.send_action("typing")
    await _proponer(update, texto, _pendiente)


async def manejar_voz(update, context):
    chat = update.effective_chat.id
    AUDIOS.mkdir(parents=True, exist_ok=True)
    archivo = await context.bot.get_file(update.message.voice.file_id)
    destino = AUDIOS / ("tg_" + dt.datetime.now().strftime("%Y%m%d_%H%M%S") + ".ogg")
    await archivo.download_to_drive(str(destino))

    await update.message.chat.send_action("typing")
    from transcribir_nota import transcribir
    ok, texto = await asyncio.to_thread(transcribir, str(destino))
    if not ok:
        await update.message.reply_text(str(texto))
        return
    await update.message.reply_text('Te entendi: "' + texto + '"')

    anterior = _pendiente.pop(chat, None)
    if anterior:
        texto = anterior + ". " + texto
    await _proponer(update, texto, _pendiente)


# ===========================================================================
# PASO 5 — confirmar. Aqui no hay LLM, y no puede haberlo.
# ===========================================================================

async def _confirmar_abono(update, chat):
    """El "va" de un abono. Aqui tampoco hay LLM, y no puede haberlo: solo
    viajan `{telegram_id, borrador_id, sello}`."""
    dato = _memoria.get(chat)
    if not dato or dato.get("tipo") != "abono":
        await update.effective_message.reply_text("No tengo ningun abono pendiente que escribir.")
        return
    estado, r = _post("/api/bot/abono/confirmar", {
        "telegram_id": chat,
        "borrador_id": dato["borrador_id"],
        "sello": dato["sello"],
    })
    log.info("abono confirmado: borrador=%s -> %s filas=%s",
             dato["borrador_id"], estado, r.get("filas_escritas"))
    if estado == 200 and r.get("ok"):
        _memoria.pop(chat, None)
        cubiertos = r.get("pedidos_cubiertos") or 0
        sobrante = r.get("sobrante") or 0
        detalle = "Listo. Quedo registrado"
        if cubiertos:
            detalle += " y cubre " + str(cubiertos) + " pedido(s)"
        if sobrante:
            detalle += "; " + ("{:,.2f}".format(sobrante)) + " quedaron a cuenta"
        await update.effective_message.reply_text(detalle + ".")
    else:
        await update.effective_message.reply_text(r.get("error", "No pude escribir el abono."))


async def _confirmar(update, chat):
    dato = _memoria.get(chat)
    if not dato:
        await update.effective_message.reply_text("No tengo nada pendiente que escribir.")
        return
    # Un "va" escrito vale para lo que este pendiente, sea gasto o abono: la
    # persona contesta como habla y no tiene por que saber que hay dos caminos.
    if dato.get("tipo") == "abono":
        await _confirmar_abono(update, chat)
        return
    if dato.get("tipo") == "abono_eligiendo":
        await update.effective_message.reply_text(
            "Primero dime de quien fue el pago, con uno de los botones.")
        return
    estado, r = _post("/api/bot/gasto/confirmar", {
        "telegram_id": chat,
        "borrador_id": dato["borrador_id"],
        "sello": dato["sello"],
    })
    if estado == 200 and r.get("ok"):
        _memoria.pop(chat, None)
        creada = r.get("categoria_creada")
        if creada:
            if creada not in _catalogo:
                _catalogo.append(creada)
            await update.effective_message.reply_text(
                "Listo. Quedo escrito, y la categoria " + str(creada) +
                " quedo creada: desde ahora la uso sola.")
        else:
            await update.effective_message.reply_text("Listo. Quedo escrito.")
    else:
        await update.effective_message.reply_text(r.get("error", "No pude escribirlo."))


async def _reproponer(update, chat, cambios):
    """Vuelve a proponer con UN campo cambiado. **Sin pasar por el LLM.**

    Es la diferencia entre corregir el campo y corregir la frase: re-extraer
    todo le daria al modelo licencia para cambiar campos que nadie toco.
    """
    dato = _memoria.get(chat)
    if not dato or "propuesta" not in dato:
        await update.effective_message.reply_text("Ya no tengo esa propuesta. Dictamelo otra vez.")
        return
    propuesta = dict(dato["propuesta"])
    propuesta.update(cambios.get("propuesta", {}))
    id_cuenta = cambios.get("id_cuenta", dato.get("id_cuenta"))

    cuerpo = {"telegram_id": chat, "propuesta": propuesta}
    if id_cuenta:
        cuerpo["id_cuenta"] = id_cuenta
    estado, r = _post("/api/bot/gasto/proponer", cuerpo)
    if estado != 200 or not r.get("ok"):
        await update.effective_message.reply_text(r.get("error", "No pude reproponerlo."))
        return
    _memoria[chat] = {
        "borrador_id": r["borrador_id"],
        "sello": r["sello"],
        "propuesta": propuesta,
        "cuentas": r.get("cuentas", dato.get("cuentas", [])),
        "id_cuenta": r.get("id_cuenta"),
        "categorias": r.get("categorias", list(_catalogo)),
    }
    _refrescar_catalogo(r)
    await update.effective_message.reply_text(
        r["mensaje"], reply_markup=_teclado_confirmar(r["borrador_id"]))


async def manejar_boton(update, context):
    q = update.callback_query
    await q.answer()
    chat = q.message.chat.id
    partes = q.data.split(":", 2)
    accion = partes[0]

    if accion == "vaab":
        await _confirmar_abono(update, chat)
    elif accion == "deu":
        # "Otro deudor": se vuelve a preguntar con la lista COMPLETA que el
        # servidor mando la ultima vez.
        dato = _memoria.get(chat) or {}
        opciones = dato.get("opciones") or []
        if not opciones:
            await q.message.reply_text("Dictamelo otra vez diciendo de quien fue el pago.")
        else:
            await q.message.reply_text("De quien fue?", reply_markup=_teclado_deudores(opciones))
    elif accion == "setdeu":
        dato = _memoria.get(chat) or {}
        opciones = dato.get("opciones") or []
        try:
            elegido = opciones[int(partes[1])]
        except (ValueError, IndexError, TypeError):
            await q.message.reply_text("Ese ya no esta en la lista. Dictamelo otra vez.")
            return
        await _proponer_abono(update, chat, "", id_deudor=elegido["id_entidad"],
                              propuesta=dato.get("propuesta"))
    elif accion == "montoab":
        _esperando_monto[chat] = True
        await q.message.reply_text("De cuanto fue el abono? Solo el numero.")
    elif accion == "va":
        await _confirmar(update, chat)
    elif accion == "no":
        _memoria.pop(chat, None)
        await q.message.reply_text("Cancelado. No escribi nada.")
    elif accion == "cat":
        vivas = (_memoria.get(chat) or {}).get("categorias") or list(_catalogo)
        await q.message.reply_text(
            "Cual es?", reply_markup=_teclado_categorias(partes[1], vivas))
    elif accion == "setcat":
        nueva = partes[2] if len(partes) > 2 else None
        await _reproponer(
            update, chat,
            {"propuesta": {"categoria": None if nueva == "SIN_CATEGORIZAR" else nueva}})
    elif accion == "monto":
        _esperando_monto[chat] = True
        await q.message.reply_text("De cuanto fue? Solo el numero.")
    elif accion == "cta":
        dato = _memoria.get(chat) or {}
        cuentas = dato.get("cuentas") or []
        if len(cuentas) < 2:
            await q.message.reply_text("Solo tienes una cuenta dada de alta; no hay a cual cambiar.")
        else:
            await q.message.reply_text("Contra cual?", reply_markup=_teclado_cuentas(cuentas))
    elif accion == "setcta":
        dato = _memoria.get(chat) or {}
        cuentas = dato.get("cuentas") or []
        try:
            elegida = cuentas[int(partes[1])]
        except (ValueError, IndexError, TypeError):
            await q.message.reply_text("Esa cuenta ya no esta en la lista. Dictamelo otra vez.")
            return
        await _reproponer(update, chat, {"id_cuenta": elegida["id"]})


async def _consulta_directa(update, consulta, filtro=None):
    """Los comandos /stock /cartera /ventas: la consulta SIN pasar por el modelo.

    Existe por latencia, no por seguridad: el camino de lenguaje natural paga
    DOS llamadas al modelo (una para descartar el gasto y otra para clasificar
    la pregunta). Lo que se usa a diario no tiene por que pagar eso, y ademas
    un comando escrito no se puede clasificar mal.
    """
    chat = update.effective_chat.id
    await update.effective_message.chat.send_action("typing")
    estado, r = _post("/api/bot/consulta", {
        "telegram_id": chat, "consulta": consulta, "filtro": filtro,
    })
    log.info("comando /%s filtro=%s -> %s", consulta, filtro, estado)
    if estado != 200 or not r.get("ok"):
        await update.effective_message.reply_text(r.get("error", "No pude consultarlo."))
        return
    await update.effective_message.reply_text(r["texto"])


async def comando_stock(update, context):
    await _consulta_directa(update, "stock", " ".join(context.args or []).strip() or None)


async def comando_cartera(update, context):
    await _consulta_directa(update, "cartera")


async def comando_ventas(update, context):
    await _consulta_directa(update, "ventas")


async def comando_abono(update, context):
    """`/abono <nombre> <monto>` — la cobranza SIN pasar por el modelo.

    Existe por la misma razon que /stock y /cartera: latencia. El camino de
    lenguaje natural paga DOS llamadas al modelo antes de llegar aqui (una para
    descartar el gasto, otra para leer el abono), y lo que se usa a diario no
    tiene por que pagar eso. Ademas un comando escrito no se puede clasificar
    mal — y aqui una clasificacion mala mueve dinero.

    El monto es el ULTIMO token; todo lo anterior es el nombre. El servidor
    sigue empatando el nombre contra la cartera y sigue preguntando si hay duda:
    este atajo se salta el modelo, **no las defensas**.
    """
    chat = update.effective_chat.id
    args = list(context.args or [])
    if len(args) < 2:
        await update.effective_message.reply_text(
            "Se usa asi: /abono Gilberto 5000" + NL
            + "(el ultimo numero es el monto; lo de antes, de quien fue el pago)")
        return
    crudo = args[-1].replace("$", "").replace(",", "")
    try:
        monto = float(crudo)
    except ValueError:
        await update.effective_message.reply_text(
            "No lei \"" + args[-1] + "\" como monto. El ultimo dato tiene que ser el numero.")
        return
    nombre = " ".join(args[:-1]).strip()
    await update.effective_message.chat.send_action("typing")
    # El nombre no se resuelve aqui: viaja al servidor como se tecleo, y el
    # servidor lo empata o pregunta. Es el mismo camino que el de la voz.
    await _proponer_abono(update, chat, nombre, nombre=nombre,
                          propuesta={"monto": monto, "metodo_pago": None,
                                     "nota": None, "fecha": None})


async def comando_inicio(update, context):
    await update.message.reply_text(
        "Soy el bot del ERP. Capturo y consulto." + NL + NL
        + "PARA CAPTURAR, dime lo que gastaste como lo dirias en persona, por"
          " texto o nota de voz:" + NL
        + '  "gaste 340 de gasolina yendo a Zacatecas"' + NL
        + "Te enseno la fila exacta antes de escribir nada. Nada entra sin tu VA." + NL + NL
        + "PARA CONSULTAR:" + NL
        + "  /stock            que hay, y donde" + NL
        + "  /stock chile 750  solo de un producto, o de un punto de venta" + NL
        + "  /cartera          quien debe, cuanto, y desde cuando" + NL
        + "  /ventas           los ultimos 6 meses" + NL + NL
        + "PARA REGISTRAR UN PAGO QUE TE HICIERON:" + NL
        + "  /abono Gilberto 5000   o dilo hablando: \"me deposito Gilberto 5 mil\"" + NL
        + "Te enseno a que pedidos se aplica ANTES de escribir nada." + NL
        + "Tambien puedes preguntarlo hablando: \"cuanto me debe Delirio\"." + NL + NL
        + "Los numeros salen de las vistas del ERP, nunca del modelo.")


async def manejar_no_autorizado(update, context):
    # Un telegram_id sin alta no escribe y tampoco averigua nada del sistema.
    log.warning("mensaje de chat no dado de alta: %s", update.effective_chat.id)


async def _latir(app):
    """El latido. Su valor es el silencio: sin lineas durante mas de 15 min, el
    bot esta colgado aunque el proceso siga en la lista de tareas (E-25)."""
    while True:
        await asyncio.sleep(INTERVALO_LATIDO)
        log.info("latido: vivo, %d borrador(es) en memoria", len(_memoria))


async def _al_arrancar(app):
    app.create_task(_latir(app))


def _candado():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", PUERTO_CANDADO))
    except OSError:
        print("Ya hay otra instancia del bot de gastos corriendo. Salgo.")
        sys.exit(1)
    return s


def main():
    if not TOKEN_TG:
        print("Falta BOT_GASTOS_TELEGRAM_TOKEN. Ver bot/LEEME.md")
        sys.exit(1)
    if not TOKEN_API or len(TOKEN_API) < 24:
        print("Falta BOT_API_TOKEN (minimo 24 caracteres). Ver bot/LEEME.md")
        sys.exit(1)

    candado = _candado()  # noqa: F841 - vive hasta que muere el proceso
    log.info("arrancando bot de gastos contra %s", API)

    app = Application.builder().token(TOKEN_TG).post_init(_al_arrancar).build()
    app.add_handler(CommandHandler("start", comando_inicio))
    app.add_handler(CommandHandler("stock", comando_stock))
    app.add_handler(CommandHandler("cartera", comando_cartera))
    app.add_handler(CommandHandler("ventas", comando_ventas))
    app.add_handler(CommandHandler("abono", comando_abono))
    app.add_handler(CallbackQueryHandler(manejar_boton))
    app.add_handler(MessageHandler(filters.VOICE, manejar_voz))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, manejar_texto))
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
