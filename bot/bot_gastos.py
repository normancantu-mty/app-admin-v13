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
        [InlineKeyboardButton("Cancelar", callback_data="no:" + borrador_id)],
    ])


def _teclado_categorias(borrador_id):
    filas = [[InlineKeyboardButton(nombre, callback_data="setcat:" + borrador_id + ":" + nombre)]
             for nombre in CATEGORIAS]
    filas.append([InlineKeyboardButton("Ninguna (dejar sin categorizar)",
                                       callback_data="setcat:" + borrador_id + ":SIN_CATEGORIZAR")])
    return InlineKeyboardMarkup(filas)


# ===========================================================================
# EL CAMINO PRINCIPAL
# ===========================================================================

async def _proponer(update, texto, pendiente):
    """Del lenguaje natural al borrador sellado. Devuelve True si propuso."""
    chat = update.effective_chat.id

    ok, obj = await asyncio.to_thread(extraer, texto)
    if not ok:
        await update.effective_message.reply_text("No pude procesarlo: " + str(obj))
        return False

    # Slot filling: si el modelo dice que falta algo, se PREGUNTA. No se adivina.
    if obj.get("monto") in (None, "", 0) or not obj.get("descripcion"):
        falta = obj.get("falta") or "el monto"
        if falta == "esto no parece un gasto":
            await update.effective_message.reply_text(
                "Eso no lo lei como un gasto. Por ahora solo se capturar gastos: "
                "dime cuanto y en que fue.")
            return False
        pendiente[chat] = texto
        await update.effective_message.reply_text("Me falta " + str(falta) + ". Me lo dices?")
        return False

    estado, r = _post("/api/bot/gasto/proponer", {
        "telegram_id": chat,
        "propuesta": {
            "monto": obj.get("monto"),
            "categoria": obj.get("categoria"),
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
        # La propuesta cruda se guarda para poder cambiar UN campo sin volver a
        # llamar al modelo. Es memoria del proceso, no autoridad: la fila que se
        # escribe es la sellada en la base, no esta.
        "propuesta": {
            "monto": obj.get("monto"),
            "categoria": obj.get("categoria"),
            "descripcion": obj.get("descripcion"),
            "fecha": obj.get("fecha"),
        },
    }
    await update.effective_message.reply_text(
        r["mensaje"], reply_markup=_teclado_confirmar(r["borrador_id"]))
    return True


# Lo unico que el bot guarda en memoria: el ultimo borrador por chat, para poder
# mandar el sello al confirmar. **El payload NO vive aqui** — vive en la base, y
# por eso este proceso no puede alterarlo aunque tuviera un bug.
_memoria = {}
_pendiente = {}
_esperando_monto = {}


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
        await _reproponer(update, chat, {"monto": monto})
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

async def _confirmar(update, chat):
    dato = _memoria.get(chat)
    if not dato:
        await update.effective_message.reply_text("No tengo nada pendiente que escribir.")
        return
    estado, r = _post("/api/bot/gasto/confirmar", {
        "telegram_id": chat,
        "borrador_id": dato["borrador_id"],
        "sello": dato["sello"],
    })
    if estado == 200 and r.get("ok"):
        _memoria.pop(chat, None)
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
    propuesta.update(cambios)

    estado, r = _post("/api/bot/gasto/proponer",
                      {"telegram_id": chat, "propuesta": propuesta})
    if estado != 200 or not r.get("ok"):
        await update.effective_message.reply_text(r.get("error", "No pude reproponerlo."))
        return
    _memoria[chat] = {"borrador_id": r["borrador_id"], "sello": r["sello"], "propuesta": propuesta}
    await update.effective_message.reply_text(
        r["mensaje"], reply_markup=_teclado_confirmar(r["borrador_id"]))


async def manejar_boton(update, context):
    q = update.callback_query
    await q.answer()
    chat = q.message.chat.id
    partes = q.data.split(":", 2)
    accion = partes[0]

    if accion == "va":
        await _confirmar(update, chat)
    elif accion == "no":
        _memoria.pop(chat, None)
        await q.message.reply_text("Cancelado. No escribi nada.")
    elif accion == "cat":
        await q.message.reply_text("Cual es?", reply_markup=_teclado_categorias(partes[1]))
    elif accion == "setcat":
        nueva = partes[2] if len(partes) > 2 else None
        await _reproponer(update, chat, {"categoria": None if nueva == "SIN_CATEGORIZAR" else nueva})
    elif accion == "monto":
        _esperando_monto[chat] = True
        await q.message.reply_text("De cuanto fue? Solo el numero.")


async def comando_inicio(update, context):
    await update.message.reply_text(
        "Soy el capturador de gastos del ERP." + NL + NL
        + "Dime lo que gastaste como lo dirias en persona, por texto o nota de voz:" + NL
        + '  "gaste 340 de gasolina yendo a Zacatecas"' + NL + NL
        + "Te enseno la fila exacta antes de escribir nada. Nada entra sin tu VA.")


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
    app.add_handler(CallbackQueryHandler(manejar_boton))
    app.add_handler(MessageHandler(filters.VOICE, manejar_voz))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, manejar_texto))
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
