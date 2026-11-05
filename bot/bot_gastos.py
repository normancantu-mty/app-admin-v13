"""
bot_gastos.py — AG-01 Fase 1. El bot de captura de gastos del ERP.

Copia el patron de `Socio/asistente/telegram_socio.py` (long polling, candado de
instancia unica, un solo trabajador, latido). **No extiende aquel proceso**: es
otro bot, con otro token, otro publico y otro dominio.

LOS CINCO PASOS (D-E30), Y DONDE VIVE CADA UNO
----------------------------------------------
  1. Entra lenguaje natural (texto o nota de voz) ............ aqui
  2. El LLM emite UN objeto con intencion y campos ........... bot/enrutador.py
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
import contextlib
import contextvars
import datetime as dt
import functools
import json
import logging
import os
import re
import socket
import sys
import time
import urllib.request
import uuid
from pathlib import Path

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, MessageEntity, Update
from telegram.ext import (Application, BaseHandler, CallbackQueryHandler, CommandHandler,
                          ContextTypes, MessageHandler, TypeHandler, filters)
from telegram.request import HTTPXRequest
from telegram.error import BadRequest, NetworkError, TimedOut  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
# UNA sola llamada al modelo por mensaje, y sale de aqui. `extraer.py`,
# `extraer_abono.py` y `consultar.py` **siguen en el repo** -- nada se borra
# (regla 6) -- pero ya no los llama nadie: cada uno abre diciendolo en su
# primera linea. Mientras estuvieron cableados en paralelo con el enrutador, el
# mismo mensaje se podia leer de dos maneras distintas segun por donde entrara,
# y cual mandaba dependia del orden de unos `if`.
from enrutador import (  # noqa: E402
    CATEGORIAS_SEMILLA, CAUSA_LOGIN, FORMAS_DEL_MISMO, MAX_HECHOS, SOLO_EGRESOS, TIPOS_DE_HECHO,
    alias_de, enrutar, es_afirmacion_explicita)
import enrutador  # noqa: E402  2026-11-03: `_sin_secretos` y las causas del OCR
# Cazador F0 (2026-10-17): el codigo nuevo vive en modulos nuevos; aqui solo se
# enchufan. `bitacora` esta APAGADA hasta que `main()` la prende.
import bitacora  # noqa: E402
import lote_plantilla  # noqa: E402  Cazador F0 (WP-7a)
import lote_ciclo  # noqa: E402  Lote v2: aditivo 2, destilacion, muestra, temperatura
import voz_salida  # noqa: E402  Cazador F0 (WP-V)
import tope  # noqa: E402  Cazador F0 (item 6)
import comprobantes  # noqa: E402  2026-11-03: la foto de cada ticket
import grupos_silenciosos  # noqa: E402  2026-11-03: grupos donde el bot solo escucha
import ocr_ticket  # noqa: E402  2026-11-03: lectura del ticket con vision

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
# El unico cuyo clic escribe (2026-11-03). Lo que manda es el servidor
# (`esAprobador` en lib/bot-permisos.ts); aqui solo cambia el texto del aviso.
NORMAN_TELEGRAM_ID = 6571822622

class _TapaSecretos(logging.Filter):
    """Tapa el token de Telegram en CUALQUIER linea que pase por el log.

    No es hipotetico: el 2026-09-14 se conto el token **2,540 veces en claro**
    dentro de `bot_gastos.log` -- una por cada `getUpdates`, que `httpx` loguea
    con la URL completa, y la URL de Telegram LLEVA el token dentro. El archivo
    esta en `.gitignore`, asi que no se filtro a git; pero cualquiera a quien se
    le pase ese log para depurar se lleva el bot entero.

    Va como filtro y no solo callando a `httpx` porque el que calla a `httpx`
    depende de que nadie suba el nivel de vuelta. Esto tapa aunque eso pase.
    """

    def filter(self, record):
        try:
            msg = record.getMessage()
        except Exception:
            return True
        if TOKEN_TG and TOKEN_TG in msg:
            record.msg = msg.replace(TOKEN_TG, "<TOKEN>")
            record.args = ()
        return True


# ─── D46 (Fase 6): EL LOG SE PUEDE REDIRIGIR SIN EDITAR ESTE ARCHIVO ────────
#
# **El defecto que cierra, y no era cosmetico.** El `FileHandler` se instalaba
# sobre `bot_gastos.log` al IMPORTAR el modulo y sin interruptor, asi que
# cualquier prueba que hiciera `import bot_gastos` escribia en el log de
# PRODUCCION. Y `bot/decidir_reinicio.py` calcula `edad_log_min` con el `mtime`
# de ese archivo y reinicia el bot cuando pasa de `TOPE_LOG_MIN`: **correr la
# suite le reiniciaba el reloj al detector de cuelgue.** El auditor lo comprobo
# causandolo el 2026-09-19 -- el `mtime` de las 12:17:15 era suyo, el ultimo
# latido real del bot era de las 12:03:39. Un bot colgado durante una tanda de
# pruebas no se detectaba.
#
# Se llama `BOT_LOG` porque es lo que es y porque empata con las otras tres
# variables del bot (`BOT_API_TOKEN`, `BOT_GASTOS_TELEGRAM_TOKEN`, `ERP_API_URL`):
# prefijo `BOT_`, nombre de lo que apunta. **El default es el de siempre**, asi
# que ni el arranque ni el vigilante cambian de comportamiento.
# ─── D60 (Fase 7): EL MODO ENSAYO — un bot que NO PUEDE escribir ────────────
#
# **El defecto que cierra.** El bot y las pruebas comparten UNA base, la de
# produccion. Probarlo punta a punta era escribir dinero de verdad, y en la Fase
# 6 el auditor tuvo que doblar `/confirmar` a mano en cada arnes: la seguridad
# vivia en el criterio del que prueba, no en el codigo.
#
# `BOT_ENSAYO=1` (prefijo `BOT_`, como `BOT_LOG`). **Apagado por default**: el
# vigilante arranca el bot con `python bot/bot_gastos.py` y sin esta variable.
# Toda la decision vive en `decision_de_ensayo` + `_post`, no en cada
# `_confirmar_*`. Y el servidor pone el segundo candado (`lib/bot-ensayo.ts`).
VALORES_SI = ("1", "si", "true", "yes", "on")

AVISO_ENSAYO = "[ENSAYO — no escribo nada]"


def ensayo_activo(entorno=None):
    """¿Esta puesto `BOT_ENSAYO`? **Funcion pura.**"""
    if entorno is None:
        entorno = os.environ
    return str(entorno.get("BOT_ENSAYO") or "").strip().lower() in VALORES_SI


def ruta_del_log(entorno=None):
    """A que archivo escribe el log. **Funcion pura: no abre nada.**

    Se separa de la instalacion del handler para poder comprobar el default sin
    tocar el archivo de produccion -- que es, exactamente, el dano que esto
    existe para evitar.

    D60: un ensayo sin `BOT_LOG` escribe en `bot_gastos_ensayo.log`, no en el de
    produccion: el `mtime` de ese archivo es el reloj del detector de cuelgue
    (`decidir_reinicio.py`), y un ensayo no puede darle cuerda.
    """
    if entorno is None:
        entorno = os.environ
    dicho = str(entorno.get("BOT_LOG") or "").strip()
    if dicho:
        return Path(dicho)
    if ensayo_activo(entorno):
        return RAIZ / "bot_gastos_ensayo.log"
    return RAIZ / "bot_gastos.log"


RUTA_LOG = ruta_del_log()

_manejadores = [logging.FileHandler(RUTA_LOG, encoding="utf-8"),
                logging.StreamHandler()]
for _m in _manejadores:
    _m.addFilter(_TapaSecretos())

logging.basicConfig(
    format="%(asctime)s %(levelname)s %(message)s",
    level=logging.INFO,
    handlers=_manejadores,
)
# `httpx` en INFO escribia una linea por sondeo: **el 81% del log era ruido**
# (2,540 de 3,136 lineas), y ese ruido es justo el que llevaba el token. En
# WARNING se siguen viendo los fallos de red, que es lo unico que ahi servia.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)

log = logging.getLogger("bot_gastos")


ENSAYO = ensayo_activo()

# Las UNICAS rutas que el ensayo deja salir tal cual: las que solo leen
# (verificado el 2026-09-22: cero `insert/update/upsert/delete/rpc` en la ruta y
# en lo que importa). Es una lista de lo PERMITIDO, no de lo prohibido: una ruta
# nueva que nadie agrego aqui NO sale. Asi se colaron cuatro intenciones en
# `INTENCIONES_QUE_ESCRIBEN` en la Fase 6 (D42): por enumerar lo prohibido.
# Fase 8 (D77): `/api/bot/pendiente` solo lee (un `select` sobre
# `bot_borradores`, ninguna escritura): la rehidratacion funciona en ensayo.
RUTAS_SOLO_LECTURA = frozenset(("/api/bot/consulta", "/api/bot/catalogo",
                                "/api/bot/pendiente",
                                # Fase 9: quien es quien, y que espera el Aprobar.
                                "/api/bot/identidad", "/api/bot/aprobacion"))

# Las `proponer` salen, MARCADAS: el servidor calcula la propuesta real (precios,
# catalogo, cartera) y no escribe el borrador (`lib/bot-ensayo.ts`).
SUFIJO_PROPONER = "/proponer"


def decision_de_ensayo(ruta):
    """Que hace `_post` con `ruta` en modo ensayo. **Funcion pura.**

    - `"no_sale"`: todo lo que termina en `/confirmar` (escribe dinero), sin
      excepcion y ANTES que cualquier otra regla; `/cancelar`; y cualquier ruta
      que no este permitida abajo.
    - `"sale_marcada"`: `*/proponer` y las de solo lectura, con `x-bot-ensayo`.
    """
    limpia = str(ruta or "").split("?")[0].rstrip("/")
    if limpia.endswith("/confirmar"):
        return "no_sale"
    if limpia in RUTAS_SOLO_LECTURA or limpia.endswith(SUFIJO_PROPONER):
        return "sale_marcada"
    return "no_sale"


# Lo que el ensayo NO dejo salir: (ruta, cuerpo). Es la bitacora que se lee para
# saber que se HABRIA escrito.
no_salieron = []


def _respuesta_de_ensayo(ruta, cuerpo):
    """La respuesta sintetica de una ruta que no salio.

    `/cancelar` contesta ok: en ensayo el borrador nunca existio, asi que "ya no
    hay nada pendiente" es verdad. Todo lo demas contesta `ok: false` con el
    aviso: con `ok: true` el bot diria "Listo. Quedo escrita", que es justo la
    mentira que el modo ensayo existe para no decir.
    """
    no_salieron.append((ruta, cuerpo))
    log.warning("%s no salio: POST %s %s", AVISO_ENSAYO, ruta,
                json.dumps(cuerpo, ensure_ascii=False)[:300])
    if str(ruta).rstrip("/").endswith("/cancelar"):
        return 200, {"ok": True, "ensayo": True}
    return 200, {
        "ok": False,
        "ensayo": True,
        "ruta": ruta,
        "error": AVISO_ENSAYO + " Aqui habria llamado " + ruta
                 + ". No salio: no se escribio nada.",
    }


# 2026-11-04: las cuentas vivas de quien escribe. La web no se toca y ninguna ruta
# de lectura las da; `gasto/proponer` en ensayo es de solo lectura y si las trae.
RUTA_LEER_CUENTAS = "/api/bot/gasto/proponer?leer=cuentas"
TTL_CUENTAS = 600
_cuentas_leidas = {}


def _cuentas_vivas(chat):
    """`[{id, nombre}]` de esta persona. Si el servidor falla, lo ultimo que se supo
    o `[]`: **el bot no se cae por esto**, y sin lista trabaja como antes."""
    persona = _persona(chat)
    leidas = _cuentas_leidas.get(persona)
    if leidas and (time.time() - leidas[0]) < TTL_CUENTAS:
        return leidas[1]
    estado, r = _post(RUTA_LEER_CUENTAS, {
        "telegram_id": chat, "conservar_pendientes": True,
        "propuesta": {"monto": 1, "descripcion": "lectura de cuentas"}})
    crudas = r.get("cuentas") if estado == 200 and isinstance(r, dict) and r.get("ok") else None
    cuentas = [{"id": c["id"], "nombre": c.get("nombre")} for c in crudas or []
               if isinstance(c, dict) and c.get("id")]
    if cuentas:
        _cuentas_leidas[persona] = (time.time(), cuentas)
        return cuentas
    log.warning("no pude leer las cuentas vivas: %s", estado)
    return leidas[1] if leidas else []


def _post(ruta, cuerpo):
    """Llama a la app. Devuelve (status, objeto).

    D60: en ensayo, la decision de si la peticion sale se toma AQUI y solo
    aqui. Las que salen llevan `x-bot-ensayo: 1`, y a su `mensaje` se le
    antepone el aviso, para que ninguna propuesta de un ensayo se confunda con
    una del bot real.

    Fase 8 (D79), corregido el 2026-11-04: toda `proponer` sale con
    `conservar_pendientes: true`. Una propuesta nueva ya no cancela la pendiente:
    conviven, cada una con su VA.
    """
    cuerpo = _con_conservar(ruta, cuerpo)
    # Fase 9 (D94): la clave de RAM se separa AQUI, en un solo lugar, en
    # `telegram_id` (la persona) + `chat_id` (el grupo). En privado no cambia
    # nada: la clave es el mismo int de siempre y el cuerpo sale igual.
    clave = cuerpo.get("telegram_id") if isinstance(cuerpo, dict) else None
    cuerpo = _cuerpo_para_servidor(cuerpo)
    if ENSAYO:
        if decision_de_ensayo(ruta) == "no_sale":
            return _respuesta_de_ensayo(ruta, cuerpo)
    estado, r = _post_de_verdad(ruta, cuerpo)
    if ENSAYO and isinstance(r, dict) and isinstance(r.get("mensaje"), str):
        r["mensaje"] = AVISO_ENSAYO + "\n" + r["mensaje"]
    if ruta != RUTA_LEER_CUENTAS:
        _anotar_aprobacion(clave, r)
    return estado, r


def _con_conservar(ruta, cuerpo):
    """El cuerpo de una `proponer`, con `conservar_pendientes`. **Pura.**

    2026-11-04: hasta hoy el primer hecho de un mensaje nuevo salia sin la bandera
    y el servidor cancelaba lo pendiente (D79: dos pendientes hacian ambiguo un
    "va"). Norman dicto un gasto y 8 s despues un abono, el abono le cancelo el
    gasto, y el boton viejo contesto sobre el abono. Ahora conviven: la ambiguedad
    del "va" la resuelve `_varias_vivas`, no la perdida de una propuesta."""
    limpia = str(ruta or "").split("?")[0].rstrip("/")
    if not limpia.endswith(SUFIJO_PROPONER) or not isinstance(cuerpo, dict):
        return cuerpo
    return dict(cuerpo, conservar_pendientes=True)


def _post_de_verdad(ruta, cuerpo):
    """El unico lugar que habla HTTP con la app."""
    datos = json.dumps(cuerpo).encode("utf-8")
    cabeceras = {"Content-Type": "application/json", "x-bot-token": TOKEN_API}
    # La lectura de cuentas va SIEMPRE en ensayo: lee de verdad y no escribe nada.
    if ENSAYO or ruta == RUTA_LEER_CUENTAS:
        cabeceras["x-bot-ensayo"] = "1"
    pet = urllib.request.Request(
        API + ruta, data=datos, method="POST", headers=cabeceras,
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
# FASE 9 (D94) — LA IDENTIDAD ES LA PERSONA; EL CHAT VIAJA APARTE
# ===========================================================================
#
# Hasta la Fase 8 el bot mandaba el id del CHAT como `telegram_id`. En privado
# chat == persona (Telegram), asi que daba igual. En un grupo todos serian "el
# grupo", y el VA de Kevin confirmaria lo de Norman.
#
# LA CLAVE DE RAM (`chat` en todo este archivo): en privado, el int de siempre
# -- por eso las pruebas de chat privado no se tocan --; en un grupo, la tupla
# `(chat, persona)`, porque los borradores, la cola y lo que se esta esperando
# son de la PERSONA. El historial es de la conversacion: va por chat real
# (`_chat_de`), rotulado por nombre.
#
# `_post` parte la clave en `telegram_id` + `chat_id` (`_cuerpo_para_servidor`)
# y nada mas la toca: ningun `_proponer_*` tuvo que cambiar.

def _clave(chat_id, persona_id=None):
    chat_id = int(chat_id)
    persona_id = chat_id if persona_id is None else int(persona_id)
    return chat_id if chat_id == persona_id else (chat_id, persona_id)


def _en_grupo(clave):
    return isinstance(clave, (tuple, list))


def _persona(clave):
    return clave[1] if _en_grupo(clave) else clave


def _chat_de(clave):
    return clave[0] if _en_grupo(clave) else clave


def _clave_de(update):
    usuario = getattr(update, "effective_user", None)
    return _clave(update.effective_chat.id, getattr(usuario, "id", None))


def _cuerpo_para_servidor(cuerpo):
    """El cuerpo que ve el servidor. **Pura.** En grupo: `telegram_id` = la
    persona, `chat_id` = el grupo. En privado, intacto."""
    if not isinstance(cuerpo, dict) or not _en_grupo(cuerpo.get("telegram_id")):
        return cuerpo
    clave = cuerpo["telegram_id"]
    return dict(cuerpo, telegram_id=_persona(clave), chat_id=_chat_de(clave))


# Quien es cada persona (`/api/bot/identidad`, solo lectura). El que esta dado
# de alta se recuerda 10 min; el que no, 1 min (para que el registro se note
# pronto). Un ERP caido no se recuerda.
_identidades = {}
IDENTIDAD_TTL_S = 600


def _identidad_de(persona):
    ahora = time.time()
    guardada = _identidades.get(persona)
    if guardada:
        vida = IDENTIDAD_TTL_S if guardada[1].get("registrado") else 60
        if ahora - guardada[0] < vida:
            return guardada[1]
    estado, r = _post("/api/bot/identidad", {"telegram_id": int(persona)})
    if estado != 200 or not isinstance(r, dict) or not r.get("ok"):
        return None
    _identidades[persona] = (ahora, r)
    return r


def _nombre_de(persona):
    guardada = _identidades.get(persona)
    return (guardada[1].get("nombre") if guardada else None) or "alguien"


# D95: al desconocido se le pregunta UNA vez por grupo.
_ya_pregunte = set()
# D118/D119: cada "¿quien es?" que manda el bot, por (grupo, id del mensaje del
# bot) -> el miembro por quien pregunta. Asi Norman puede contestar A LA
# PREGUNTA del bot, y se registra al miembro del pendiente, no al autor del
# mensaje contestado (que es el bot). En RAM: si el bot se reinicia, se pierde
# y queda la ruta vieja (contestar al mensaje de la persona).
_preguntas_de_alta = {}


def _anotar_pregunta(enviado, chat_id, miembro):
    mensaje_id = getattr(enviado, "message_id", None)
    if mensaje_id is not None:
        _preguntas_de_alta[(int(chat_id), int(mensaje_id))] = int(miembro)


async def _puerta_de_grupo(update, clave):
    """En un grupo, solo se atiende a quien esta dado de alta. En privado no se
    mira nada aqui: el servidor ya contesta "no te tengo dado de alta"."""
    if not _en_grupo(clave):
        return True
    ident = await asyncio.to_thread(_identidad_de, _persona(clave))
    if ident is None:
        await update.effective_message.reply_text(
            "No pude revisar quien eres (el ERP no contesto). No hice nada.")
        return False
    if ident.get("registrado"):
        return True
    log.info("grupo %s: persona %s sin alta, no se procesa", _chat_de(clave), _persona(clave))
    # D119: esto corre ANTES del enrutador y del filtro de charla, asi que un
    # "hola" de un desconocido tambien dispara la pregunta (una vez).
    if clave not in _ya_pregunte:
        _ya_pregunte.add(clave)
        enviado = await update.effective_message.reply_text(
            "No te tengo registrado. Norman, ¿quien es?" + NL
            + "(Norman: contesta a su mensaje, o a este, con \"este es <nombre>\".)")
        _anotar_pregunta(enviado, _chat_de(clave), _persona(clave))
    return False


async def _puerta_de_privado(update, clave):
    """E2 (auditoria IA): en privado, antes de llamar al modelo con datos de la
    empresa (deudores, catalogo), se revisa el alta. En grupo no hace nada: ahi
    ya paso `_puerta_de_grupo`. Los comandos no pasan por aqui (no llaman al
    modelo; el servidor decide). El telegram_id queda en el log, que es de
    donde Norman lo saca para el alta (LEEME)."""
    if _en_grupo(clave):
        return True
    ident = await asyncio.to_thread(_identidad_de, _persona(clave))
    if ident is None:
        await update.effective_message.reply_text(
            "No pude revisar quien eres (el ERP no contesto). No hice nada.")
        return False
    if ident.get("registrado"):
        return True
    log.info("privado: persona %s sin alta, no se llama al modelo", _persona(clave))
    await update.effective_message.reply_text("No te tengo dado de alta. No hice nada.")
    return False


def _nombre_visible(usuario):
    """Como se ve alguien en Telegram: "Nombre Apellido (@usuario)". **Pura.**"""
    nombre = " ".join(p for p in (getattr(usuario, "first_name", None),
                                  getattr(usuario, "last_name", None)) if p)
    arroba = getattr(usuario, "username", None)
    if arroba:
        nombre = (nombre + " (@" + arroba + ")") if nombre else "@" + arroba
    return nombre or "esta persona"


async def manejar_entrada(update, context):
    """D118: alguien entra al grupo. Si no esta dado de alta, se pregunta YA
    quien es (sin esperar a que escriba), y la pregunta queda anotada para que
    Norman la conteste. Al que ya esta dado de alta no se le dice nada (lo mas
    simple: el grupo no se llena de saludos). Los bots, incluido este, se
    ignoran. Si el ERP no contesta, no se dice nada y no se marca: la puerta
    preguntara cuando escriba."""
    mensaje = update.effective_message
    chat = update.effective_chat
    if mensaje is None or chat is None:
        return
    for miembro in getattr(mensaje, "new_chat_members", None) or ():
        if getattr(miembro, "is_bot", False):
            continue
        clave = _clave(chat.id, miembro.id)
        if not _en_grupo(clave) or clave in _ya_pregunte:
            continue
        ident = await asyncio.to_thread(_identidad_de, int(miembro.id))
        if ident is None:
            log.warning("grupo %s: entro %s y el ERP no contesto la identidad",
                        chat.id, miembro.id)
            continue
        if ident.get("registrado"):
            continue
        _ya_pregunte.add(clave)
        log.info("grupo %s: entro %s sin alta, pregunto quien es", chat.id, miembro.id)
        nombre = _nombre_visible(miembro)
        enviado = await update.get_bot().send_message(
            chat.id, "Norman, ¿quien es " + nombre + "? Contestame a este mensaje con "
            "\"es <nombre>\".")
        _anotar_pregunta(enviado, chat.id, miembro.id)



def _con_puerta(comando):
    """FASE 11 (D109): los comandos pasan por la MISMA puerta de grupo que el
    texto, la voz y los botones. Hasta la Fase 10 ningun `comando_*` la llamaba:
    un desconocido que mandaba /cartera en un grupo llegaba al servidor (que
    daba 403) y nadie le preguntaba quien era. Defensa en profundidad: el
    servidor sigue decidiendo; esto hace que ni siquiera llegue. En privado la
    puerta no mira nada, asi que ahi no cambia nada."""
    @functools.wraps(comando)
    async def con_puerta(update, context):
        if not await _puerta_de_grupo(update, _clave_de(update)):
            return None
        # R1 (auditoria F0): procesado=true SOLO si el comando termino; si revienta,
        # la fila de la bitacora se queda procesado=false.
        r = await comando(update, context)
        await bitacora.marcar_procesado(update)
        return r
    con_puerta.con_puerta = True
    return con_puerta

def _rotulo_de_grupo(clave, texto, teclado=None):
    """D94: en un grupo cada propuesta dice quien la hizo y cada escritura quien
    la confirmo. **Pura.** En privado no cambia nada (las pruebas fijan los
    textos). Propuesta = lleva un boton VA; confirmacion = empieza "Listo."."""
    if not _en_grupo(clave) or not isinstance(texto, str):
        return texto
    nombre = _nombre_de(_persona(clave))
    datos = [b.callback_data or "" for fila in getattr(teclado, "inline_keyboard", None) or ()
             for b in fila]
    if any(d.split(":", 1)[0] in ACCIONES_VA for d in datos):
        return "Propuesto por " + nombre + NL + NL + texto
    if texto.startswith("Listo."):
        return texto + NL + "Confirmado por " + nombre + "."
    return texto


# ─── D97/D98: LO QUE ESPERA EL APROBAR DE NORMAN ────────────────────────────
# Un `confirmar` puede contestar `espera_aprobacion` (el VA de Kevin: no se
# escribio nada) o `pendiente_de_aprobacion` (el abono de un DST: entro
# PENDIENTE). `_post` lo anota aqui; al cerrar el turno `_avisar_aprobaciones`
# le manda a cada aprobador, por privado, el aviso con Aprobar / Rechazar.
_por_aprobar = []


def _anotar_aprobacion(clave, r):
    if not isinstance(r, dict) or not r.get("borrador_id"):
        return
    espera = bool(r.get("espera_aprobacion"))
    abono = bool(r.get("pendiente_de_aprobacion"))
    if not (espera or abono):
        return
    if espera and not r.get("error"):
        # `ok: false` + `error`: el camino de siempre de cada `_confirmar_*`
        # dice esto en vez de "No pude escribirlo".
        r["error"] = r.get("mensaje") or "No lo escribo todavia: espera el Aprobar de Norman."
    _por_aprobar.append({
        "clave": clave,
        "borrador_id": str(r["borrador_id"]),
        "avisar_a": list(r.get("avisar_a") or []),
        "mensaje": str(r.get("mensaje_aprobador") or "Hay algo esperando tu Aprobar."),
        "abono": abono and not espera,
    })
    if espera:
        try:
            comprobantes.anotar_espera(r["borrador_id"])
        except Exception as e:
            log.warning("no pude anotar la espera de %s: %s", r["borrador_id"], e)


def _teclado_aprobar(borrador_id, abono=False):
    si, no = ("apa", "rca") if abono else ("apr", "rch")
    return InlineKeyboardMarkup([[
        InlineKeyboardButton("Aprobar", callback_data=si + ":" + borrador_id),
        InlineKeyboardButton("Rechazar", callback_data=no + ":" + borrador_id),
    ]])


async def _avisar_aprobaciones(update):
    while _por_aprobar:
        p = _por_aprobar.pop(0)
        clave, bid = p["clave"], p["borrador_id"]
        mostrado = ""
        dato = _memoria.get(clave) if clave is not None else None
        if isinstance(dato, dict) and dato.get("borrador_id") == bid:
            if dato.get("mostrado"):
                mostrado = dato["mostrado"][1]
            if not p["abono"]:
                # Ya no esta PENDIENTE: sale del foco y del registro. Otro "va"
                # no la vuelve a mandar.
                _memoria.pop(clave, None)
        elif clave is not None:
            (_pendientes.get(clave) or {}).pop(bid, None)
        texto = p["mensaje"] + ((NL + NL + mostrado) if mostrado else "")
        avisados = 0
        for aprobador in p["avisar_a"]:
            try:
                await update.get_bot().send_message(
                    int(aprobador), texto, reply_markup=_teclado_aprobar(bid, p["abono"]))
                avisados += 1
            except Exception as e:
                log.warning("no pude avisarle al aprobador %s: %s", aprobador, e)
        log.info("por aprobar: borrador=%s abono=%s avisados=%d", bid, p["abono"], avisados)
        if not avisados:
            await update.effective_message.reply_text(
                "OJO: no le pude avisar a Norman por privado (tiene que escribirle /start "
                "al bot una vez). Lo tuyo sigue esperando su Aprobar.")


# Que `confirmar` escribe lo que espera, segun `payload.tipo` del borrador.
RUTA_CONFIRMAR_DE = {
    None: "/api/bot/gasto/confirmar",
    "gasto": "/api/bot/gasto/confirmar",
    "venta": "/api/bot/venta/confirmar",
    "abono": "/api/bot/abono/confirmar",
    "cotizacion": "/api/bot/cotizacion/confirmar",
    "lote": "/api/bot/lote/confirmar",
    "lote_agregar": "/api/bot/lote/confirmar",
    # Ronda 5 (B): el envasado diario (sin lote) se confirma por la misma ruta.
    "envasado_diario": "/api/bot/lote/confirmar",
    # Lote v2: aditivo 2 y destilacion (borrador `lote_etapa`, puerta de aprobacion).
    "lote_etapa": "/api/bot/lote/etapa/confirmar",
    "entrada_insumo": "/api/bot/inventario/confirmar",
    "conversion": "/api/bot/convertir/confirmar",
    "alta_entidad": "/api/bot/entidad/confirmar",
    "anulacion": "/api/bot/anular/confirmar",
    "alta_miembro": "/api/bot/miembro/confirmar",
    # FASE 11 (D112): la entrega de efectivo del DST se aprueba por el camino
    # generico (ESPERA_APROBACION -> Aprobar -> su confirmar con el sello).
    "entrega_efectivo": "/api/bot/entrega/confirmar",
    # 2026-11-03: alta de categoria/subcategoria.
    "alta_categoria": "/api/bot/categoria/confirmar",
}


async def _avisar_en(update, chat_id, texto, clave):
    """Avisa en el chat donde se propuso, si no es este mismo."""
    try:
        if chat_id is None or int(chat_id) == int(_chat_de(clave)):
            return
        await update.get_bot().send_message(int(chat_id), texto)
    except Exception as e:
        log.warning("no pude avisar en %s: %s", chat_id, e)


async def _boton_de_aprobacion(update, clave, q, accion, bid):
    """Aprobar / Rechazar (D97, D98). **Quien puede, lo decide el servidor**: aqui
    solo se enruta. `apr`: se lee lo que espera y se manda al `confirmar` de su
    tipo con el sello de siempre. `rch`: `/cancelar`. `apa`/`rca`: el abono
    pendiente de un DST, por la MISMA funcion que la pantalla."""
    try:
        await q.edit_message_reply_markup(reply_markup=None)
    except Exception:
        pass
    decir = update.effective_message.reply_text
    if accion in ("apa", "rca"):
        estado, r = _post("/api/bot/aprobacion/confirmar", {
            "telegram_id": clave, "borrador_id": bid,
            "accion": "aprobar" if accion == "apa" else "rechazar"})
        if estado != 200 or not r.get("ok"):
            await decir(r.get("error", "No pude procesarlo. No cambio nada."))
            return
        await decir(r.get("mensaje") or "Hecho.")
        await _avisar_en(update, r.get("chat_id"), r.get("mensaje") or "Norman ya lo vio.", clave)
        return
    if accion == "rch":
        estado, r = _post("/api/bot/cancelar", {"telegram_id": clave, "borrador_id": bid})
        if estado != 200 or not r.get("ok"):
            await decir(r.get("error", "No pude rechazarlo."))
            return
        try:
            comprobantes.anotar_rechazo(bid)
        except Exception as e:
            log.warning("no pude anotar el rechazo de %s: %s", bid, e)
        await decir("Rechazado. No se escribio nada.")
        # Fase 10 (D106): Norman o Kevin; el nombre lo da el servidor.
        quien = r.get("rechazado_por") or _nombre_de(_persona(clave))
        await _avisar_en(update, r.get("chat_id"),
                         quien + " rechazo lo que propusiste. No se escribio nada.", clave)
        return
    estado, r = _post("/api/bot/aprobacion", {"telegram_id": clave, "borrador_id": bid})
    if estado != 200 or not r.get("ok"):
        await decir(r.get("error", "No pude leer lo que espera tu Aprobar."))
        return
    ruta = RUTA_CONFIRMAR_DE.get(r.get("tipo"))
    if not ruta:
        await decir("No se como aprobar eso (" + str(r.get("tipo")) + "). No escribi nada.")
        return
    estado, r2 = _post(ruta, {"telegram_id": clave, "borrador_id": bid, "sello": r.get("sello")})
    log.info("aprobar: borrador=%s tipo=%s -> %s", bid, r.get("tipo"), estado)
    if estado != 200 or not r2.get("ok"):
        await decir(r2.get("error", "No pude escribirlo. No se escribio nada."))
        return
    # 2026-11-03: si lo aprobado traia foto, se liga a ESE borrador.
    pie = await asyncio.to_thread(_ligar_comprobante, bid, r2.get("id"))
    # D107: si la marca final fallo, quien aprobo lo sabe (no se repite).
    await decir("Aprobado. Quedo escrito." + pie
                + ((NL + str(r2["aviso_marca"])) if r2.get("aviso_marca") else ""))
    await _avisar_en(update, r.get("chat_id"),
                     "Aprobado por " + str(r.get("aprobador") or _nombre_de(_persona(clave)))
                     + ": lo que propuso " + str(r.get("autor") or "")
                     + " quedo escrito.", clave)
    ruta_imagen = r2.get("ruta_imagen")
    if ruta_imagen and r.get("chat_id") is not None:
        imagen = await asyncio.to_thread(_bajar, ruta_imagen)
        if imagen:
            try:
                await update.get_bot().send_photo(int(r["chat_id"]), photo=imagen, filename="ticket.png")
            except Exception as e:
                log.warning("no pude mandar el ticket aprobado: %s", e)


# ─── D95: NORMAN REGISTRA A CADA MIEMBRO ────────────────────────────────────
# Norman contesta al mensaje de alguien con "este es Gilberto" / "es Kevin" /
# "/registrar Gilberto". Solo se toma como registro si esa persona NO esta dada
# de alta (o si es `/registrar`): "es mucho" contestado a Kevin es charla.
_PATRON_REGISTRO = re.compile(r"^\s*(/registrar(@\w+)?|est[ea]\s+es|es)\b", re.I)


async def _quiza_registro(update, clave, texto):
    m = getattr(update, "message", None)
    respondido = getattr(m, "reply_to_message", None) if m is not None else None
    autor = getattr(respondido, "from_user", None)
    if autor is None:
        return False
    if getattr(autor, "is_bot", False):
        # D118/D119: se contesto a un "¿quien es?" del bot. El miembro es el
        # del pendiente; cualquier otro mensaje del bot no es un registro.
        miembro = _preguntas_de_alta.get(
            (int(_chat_de(clave)), getattr(respondido, "message_id", None)))
        if miembro is None:
            return False
    else:
        miembro = int(autor.id)
    if int(miembro) == int(_persona(clave)):
        return False
    if not _PATRON_REGISTRO.match(texto or ""):
        return False
    if not str(texto).lstrip().lower().startswith("/registrar"):
        ident = await asyncio.to_thread(_identidad_de, int(miembro))
        if ident is None or ident.get("registrado"):
            return False
    await _proponer_miembro(update, clave, int(miembro), texto)
    return True


async def _proponer_miembro(update, clave, miembro, texto, id_entidad=None):
    cuerpo = {"telegram_id": clave, "miembro_telegram_id": miembro, "texto": texto}
    if id_entidad:
        cuerpo["id_entidad"] = id_entidad
    estado, r = _post("/api/bot/miembro/proponer", cuerpo)
    if estado == 200 and r.get("hay_que_elegir"):
        opciones = r.get("opciones") or []
        _memoria[clave] = {"tipo": "miembro_eligiendo", "miembro": miembro, "texto": texto,
                           "opciones": opciones}
        filas = [[InlineKeyboardButton(
            str(o.get("nombre")) + (" (" + str(o.get("rol")) + ")" if o.get("rol") else ""),
            callback_data="mbe:" + str(i))] for i, o in enumerate(opciones)]
        await update.effective_message.reply_text(
            r.get("mensaje") or "¿De cual es?",
            reply_markup=_lista_de(clave, InlineKeyboardMarkup(filas)))
        return
    if estado != 200 or not r.get("ok"):
        await update.effective_message.reply_text(r.get("error", "No pude proponer el registro."))
        return
    _memoria[clave] = {"tipo": "alta_miembro", "borrador_id": r["borrador_id"],
                       "sello": r["sello"], "miembro": miembro}
    teclado = InlineKeyboardMarkup([
        [InlineKeyboardButton("VA, registralo", callback_data="vamb:" + r["borrador_id"])],
        [InlineKeyboardButton("Cancelar", callback_data="no:" + r["borrador_id"])],
    ])
    await _ensenar_propuesta(update, clave, r["mensaje"], teclado)


async def _confirmar_miembro(update, clave):
    dato = _memoria.get(clave)
    if not dato or dato.get("tipo") != "alta_miembro":
        await update.effective_message.reply_text("No tengo ningun registro pendiente.")
        return
    estado, r = _post("/api/bot/miembro/confirmar", {
        "telegram_id": clave, "borrador_id": dato["borrador_id"], "sello": dato["sello"]})
    log.info("alta de miembro: borrador=%s -> %s", dato["borrador_id"], estado)
    if estado != 200 or not r.get("ok"):
        await update.effective_message.reply_text(r.get("error", "No pude registrarlo."))
        return
    _memoria.pop(clave, None)
    miembro = dato.get("miembro")
    _identidades.pop(miembro, None)
    for k in [k for k in _ya_pregunte if _persona(k) == miembro]:
        _ya_pregunte.discard(k)
    for k in [k for k, v in _preguntas_de_alta.items() if v == miembro]:
        _preguntas_de_alta.pop(k, None)
    await update.effective_message.reply_text(r.get("mensaje") or "Listo. Quedo registrado.")


# ─── 2026-11-03: ALTA DE CATEGORIA / SUBCATEGORIA ───────────────────────────
async def _proponer_categoria(update, clave, cuerpo):
    estado, r = _post("/api/bot/categoria/proponer", cuerpo)
    if estado != 200 or not r.get("ok"):
        await update.effective_message.reply_text(r.get("error", "No pude proponer la categoria."))
        return
    _memoria[clave] = {"tipo": "alta_categoria", "borrador_id": r["borrador_id"], "sello": r["sello"]}
    teclado = InlineKeyboardMarkup([
        [InlineKeyboardButton("VA, agregala", callback_data="vacat:" + r["borrador_id"])],
        [InlineKeyboardButton("Cancelar", callback_data="no:" + r["borrador_id"])],
    ])
    await _ensenar_propuesta(update, clave, r["mensaje"], teclado)


async def _confirmar_categoria(update, clave):
    dato = _memoria.get(clave)
    if not dato or dato.get("tipo") != "alta_categoria":
        await update.effective_message.reply_text("No tengo ninguna categoria pendiente.")
        return
    estado, r = _post("/api/bot/categoria/confirmar", {
        "telegram_id": clave, "borrador_id": dato["borrador_id"], "sello": dato["sello"]})
    log.info("alta de categoria: borrador=%s -> %s", dato["borrador_id"], estado)
    if estado != 200 or not r.get("ok"):
        # `espera_aprobacion` (alguien del equipo): `_anotar_aprobacion` ya le
        # puso el texto "se lo mande a Norman" en `error`.
        await update.effective_message.reply_text(r.get("error", "No pude agregarla."))
        return
    _memoria.pop(clave, None)
    # La categoria nueva tiene que llegar al extractor YA, no en 10 minutos:
    # se caduca la lectura del catalogo y la siguiente frase la relee.
    global _productos_leidos_en
    _productos_leidos_en = 0.0
    texto = r.get("mensaje") or "Listo. Quedo agregada."
    if r.get("aviso_marca"):
        texto += NL + str(r["aviso_marca"])
    await update.effective_message.reply_text(_rotulo_de_grupo(clave, texto))


async def _contestar_texto_de_consulta(update, clave, r):
    """D96: lo que la tabla manda "por privado", en un grupo, va al chat privado
    de quien pregunto; en el grupo solo se dice que se mando."""
    if r.get("privado") and _en_grupo(clave):
        try:
            await update.get_bot().send_message(int(_persona(clave)), r["texto"])
            await update.effective_message.reply_text("Te lo mande por privado.")
        except Exception as e:
            log.warning("no pude mandar por privado a %s: %s", _persona(clave), e)
            await update.effective_message.reply_text(abreme_en_privado(update.get_bot()))
        return
    await update.effective_message.reply_text(r["texto"])


def _le_hablan_al_bot(update):
    """En un grupo, ¿el mensaje es para el bot? (lo contesta, o lo menciona)."""
    m = getattr(update, "message", None)
    if m is None:
        return True
    respondido = getattr(m, "reply_to_message", None)
    if respondido is not None and getattr(getattr(respondido, "from_user", None), "is_bot", False):
        return True
    try:
        usuario = update.get_bot().username
    except Exception:
        usuario = None
    return bool(usuario) and ("@" + usuario.lower()) in str(getattr(m, "text", "") or "").lower()


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


def _teclado_movimientos(opciones):
    """La lista de lo que se puede anular. **POR INDICE, y es D2.**

    *"Un movimiento que se va a anular NO se identifica NUNCA por texto libre."*
    El enrutador tiene PROHIBIDO decir cual: dictar "anula el gasto de mil
    pesos" habiendo dos gastos de mil pesos es exactamente como se anula la fila
    equivocada, y una anulacion equivocada no se deshace -- el contrato del
    ledger tiene una sola transicion.

    El indice apunta a la lista que el servidor acaba de declarar, igual que
    `setcta`, `setdeu` y `setcomp`. El uuid no viaja en el boton: no cabe en los
    64 bytes (ya reventó una vez, el 2026-09-12) y ademas un indice contra una
    lista cerrada del servidor no se puede apuntar a una fila que no este en
    ella.
    """
    filas = [[InlineKeyboardButton(
        o["etiqueta"], callback_data="setanu:" + str(i))]
        for i, o in enumerate(opciones)]
    filas.append([InlineKeyboardButton("Mejor no", callback_data="no:x")])
    return InlineKeyboardMarkup(filas)


def _teclado_confirmar_anulacion(borrador_id):
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("VA, anulalo", callback_data="vaan:" + borrador_id)],
        [InlineKeyboardButton("Cancelar", callback_data="no:" + borrador_id)],
    ])


def _teclado_confirmar_correccion(borrador_id):
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("VA, corrigelo", callback_data="vaan:" + borrador_id)],
        [InlineKeyboardButton("Cancelar", callback_data="no:" + borrador_id)],
    ])


def _teclado_campos_corregibles():
    """Que se le cambia. **Tres botones, y los tres hacen cosas distintas.**

    El concepto es una edicion de verdad (D6: es la unica columna que se edita);
    el monto y la categoria son anular-y-recapturar. Desde el celular se ven
    igual -- se pica y queda corregido -- y esa es justo la idea: la diferencia
    es del ledger, no de la persona.
    """
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("El monto", callback_data="setcorr:monto")],
        [InlineKeyboardButton("El concepto", callback_data="setcorr:desc")],
        [InlineKeyboardButton("La categoria", callback_data="setcorr:cat")],
        [InlineKeyboardButton("Mejor no", callback_data="no:x")],
    ])


def _teclado_alta(opciones):
    """Las listas cerradas del alta. **POR INDICE, igual que todo lo demas.**

    El servidor manda `{valor, etiqueta}` y aqui solo viaja el indice contra esa
    lista. El `valor` de una zona es `Zacatecas` o `Foraneo` -- texto exacto que
    va al CHECK de la base -- y mandarlo dentro del `callback_data` seria
    exponerlo a que alguien lo escriba a mano. Por indice no hay nada que
    escribir.
    """
    filas = [[InlineKeyboardButton(
        o.get("etiqueta", "?"), callback_data="setalta:" + str(i))]
        for i, o in enumerate(opciones)]
    filas.append([InlineKeyboardButton("Mejor no", callback_data="no:x")])
    return InlineKeyboardMarkup(filas)


def _teclado_confirmar_alta(borrador_id):
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("VA, dalo de alta", callback_data="vaalt:" + borrador_id)],
        [InlineKeyboardButton("Cancelar", callback_data="no:" + borrador_id)],
    ])


def _teclado_conversion(opciones):
    """La lista de cotizaciones a convertir, y las dos preguntas que siguen.

    El mismo teclado sirve para las tres porque las tres son lo mismo: una lista
    cerrada que declaro el servidor, escogida por indice. La etiqueta lleva el
    folio, la fecha y el total -- que es lo que una persona necesita para
    reconocer cual es -- y nada de eso viaja en el dato del boton.
    """
    filas = []
    for i, o in enumerate(opciones):
        texto = o.get("etiqueta", "?")
        if o.get("detalle"):
            texto = texto + " · " + str(o["detalle"])
        filas.append([InlineKeyboardButton(texto, callback_data="setcnv:" + str(i))])
    filas.append([InlineKeyboardButton("Mejor no", callback_data="no:x")])
    return InlineKeyboardMarkup(filas)


def _teclado_confirmar_conversion(borrador_id):
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("VA, hazla venta", callback_data="vacnv:" + borrador_id)],
        [InlineKeyboardButton("Cancelar", callback_data="no:" + borrador_id)],
    ])


def _cuenta_de_campos(campos):
    """Lo que el enrutador entendio de la cuenta, listo para la propuesta. **Pura.**"""
    c = {"id_cuenta": campos.get("cuenta_id"), "oida": campos.get("cuenta_oida"),
         "solo_paga": campos.get("cuenta_solo_paga")}
    return {k: v for k, v in c.items() if v}


def _sin_solo_egresos(chat, cuenta):
    """Una cuenta de solo egresos no recibe dinero: ni abono ni venta. El enrutador
    solo la filtra si el modelo dijo `sobre` (S9, y la venta de la segunda auditoria
    del 2026-11-04); aqui ya se sabe a que propuesta va el cambio."""
    if (cuenta or {}).get("id_cuenta") not in SOLO_EGRESOS:
        return cuenta
    return {"solo_paga": next((c.get("nombre") for c in _cuentas_vivas(chat)
                               if c.get("id") == cuenta["id_cuenta"]), "Esa cuenta")}


def _teclado_gasto(dato):
    """El teclado del gasto, con lo que el modelo dejo por resolver.

    Las sugeridas que no quedaron puestas van como boton (la primera ya esta en
    la propuesta). Si la cuenta falta **no hay VA**: primero se escoge."""
    bid = dato["borrador_id"]
    filas = list(_teclado_confirmar(bid).inline_keyboard)
    actual = (dato.get("propuesta") or {}).get("categoria")
    otras = [[InlineKeyboardButton(n, callback_data="setsug:%d:%s" % (i, bid))]
             for i, n in enumerate(dato.get("sugeridas") or []) if n != actual]
    # La foto que llego en vuelo no se leyo con este gasto: se puede despegar.
    quitar = ([[InlineKeyboardButton("Quitar la foto", callback_data="qf:" + bid)]]
              if dato.get("foto_de_vuelo") else [])
    if dato.get("cuenta_pendiente"):
        cuentas = list(_teclado_cuentas(dato.get("cuentas") or [], bid).inline_keyboard)
        return InlineKeyboardMarkup(cuentas + otras + [filas[1], filas[3]] + quitar)
    return InlineKeyboardMarkup(filas[:1] + otras + filas[1:] + quitar)


_PIE_DE_GASTO = re.compile(r"^\(la cuenta no la elige el modelo[^\n]*$", re.M)
_PIE_DE_ABONO = re.compile(r"^\(las cuentas no las elige el modelo[^\n]*$", re.M)
_LINEA_CUENTA = re.compile(r"^CUENTA:[^\n]*$", re.M)
_ENTRA_A = re.compile(r'y entra a "[^"\n]*"\.')
_CIERRE = "Contesta VA para escribirlo, o dime que cambio."
PIE_CUENTA_DICHA = "(la cuenta la dijiste tu; si esta mal la cambias con el boton)"


def _por_que_preguntamos(dato):
    if dato.get("cuenta_solo_paga"):
        return '"%s" solo paga, no recibe dinero. ' % dato["cuenta_solo_paga"]
    if dato.get("cuenta_oida"):
        return 'No encontre "%s" en tus cuentas. ' % dato["cuenta_oida"]
    return ""


def _mensaje_con_cuenta(dato, mensaje):
    """El texto del servidor, con la cuenta como de verdad quedo. **Pura.**

    El pie del servidor decia que la cuenta no la elige el modelo, y ya puede
    salir de lo dicho. Se reescribe aqui porque la web no se toca;
    `probar_clasificador.py` amarra estos textos contra los `lib/bot-*.ts`."""
    if dato.get("cuenta_pendiente"):
        duda = _por_que_preguntamos(dato)
        if dato.get("tipo") == "abono":
            mensaje = _ENTRA_A.sub("y entra a: cual? Escoge abajo.", mensaje)
        else:
            mensaje = _LINEA_CUENTA.sub("CUENTA:     cual? Escoge abajo.", mensaje)
        mensaje = _PIE_DE_GASTO.sub(duda.strip(), _PIE_DE_ABONO.sub(duda.strip(), mensaje))
        return mensaje.replace(_CIERRE, "Escoge la cuenta y te pongo el VA.")
    if dato.get("cuenta_dicha"):
        return _PIE_DE_GASTO.sub(PIE_CUENTA_DICHA, _PIE_DE_ABONO.sub(PIE_CUENTA_DICHA, mensaje))
    return mensaje


def _estado_de_cuenta(cuenta, cuentas):
    """Los campos del borrador que dicen como quedo la cuenta. **Pura.** Con una
    sola cuenta no hay nada que preguntar."""
    cuenta = cuenta or {}
    dicha = bool(cuenta.get("id_cuenta"))
    return {"cuenta_dicha": dicha, "cuenta_pendiente": not dicha and len(cuentas or []) > 1,
            "cuenta_oida": cuenta.get("oida"), "cuenta_solo_paga": cuenta.get("solo_paga")}


def _teclado_categorias(categorias, borrador_id=None):
    """Las categorias van POR INDICE, por la misma razon que cuentas y deudores.

    Lo que habia antes era "setcat:<uuid de borrador>:<nombre>": 44 bytes fijos
    mas el nombre, contra el tope de 64 de `callback_data`. Una categoria de mas
    de 20 caracteres tumbaba el teclado entero con Button_data_invalid -- y el
    usuario no veia un error, veia que el bot no contestaba. Paso de verdad el
    2026-09-12 11:22:15 (`bot_gastos.log`, desde la linea 312).

    El uuid tampoco hacia falta: el borrador vivo es el de `_memoria[chat]`, que
    es la unica autoridad que `_reproponer` consulta. Mandarlo por el boton solo
    gastaba bytes.

    El indice apunta a la lista que ESTE teclado ofrecio, que queda guardada en
    `_memoria[chat]["categorias_ofrecidas"]`: asi el boton no puede nombrar una
    categoria que el servidor no acabe de declarar viva.
    """
    # 2026-11-04: con borrador, el boton dice de cual propuesta es.
    cola = ":" + borrador_id if borrador_id else ""
    filas = [[InlineKeyboardButton(nombre, callback_data="setcat:" + str(i) + cola)]
             for i, nombre in enumerate(categorias)]
    # -1 es "ninguna". Va como indice y no como palabra para que el handler
    # tenga UN solo formato que interpretar.
    filas.append([InlineKeyboardButton("Ninguna (dejar sin categorizar)",
                                       callback_data="setcat:-1" + cola)])
    return InlineKeyboardMarkup(filas)


def _teclado_confirmar_abono(borrador_id, dato=None):
    """El mismo VA de la Fase 1, con los campos que de verdad se corrigen aqui.

    No hay "cambiar categoria" porque un abono no tiene: lo que se equivoca es
    el DEUDOR o el MONTO. La cuenta del deudor la resuelve el servidor y es una
    sola (medido el 2026-09-12); la que SI se escoge, desde el 2026-11-04, es a
    cual de las de la matriz entra. Si falta, **no hay VA**: primero se escoge.
    """
    dato = dato or {}
    cuentas = dato.get("cuentas") or []
    fijas = [[InlineKeyboardButton("Otro deudor", callback_data="deu:" + borrador_id),
              InlineKeyboardButton("Cambiar monto", callback_data="montoab:" + borrador_id)]]
    if dato.get("cuenta_pendiente"):
        filas = list(_teclado_cuentas(cuentas, borrador_id).inline_keyboard) + fijas
    else:
        filas = [[InlineKeyboardButton("VA, escribelo", callback_data="vaab:" + borrador_id)]] + fijas
        if len(cuentas) > 1:
            filas.append([InlineKeyboardButton("Cambiar cuenta", callback_data="cta:" + borrador_id)])
    filas.append([InlineKeyboardButton("Cancelar", callback_data="no:" + borrador_id)])
    return InlineKeyboardMarkup(filas)


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


def _teclado_cuentas(cuentas, borrador_id=None):
    """Las cuentas van POR INDICE, no por uuid.

    Dos razones, y las dos importan. La de bulto: `callback_data` topa en 64
    bytes y "setcta:<uuid de borrador>:<uuid de cuenta>" son 80. La de fondo:
    el indice solo puede apuntar a algo que el servidor ya declaro usable en
    esta propuesta, asi que el proceso del bot no tiene forma de nombrar una
    cuenta que no este en esa lista.

    2026-11-04: con `borrador_id` el boton apunta a SU propuesta ("setcta:<i>:<id>",
    45 bytes): con dos gastos dictados juntos, la pregunta de cuenta del primero
    ya no es el foco.
    """
    cola = ":" + borrador_id if borrador_id else ""
    filas = [[InlineKeyboardButton(c["nombre"], callback_data="setcta:" + str(i) + cola)]
             for i, c in enumerate(cuentas)]
    return InlineKeyboardMarkup(filas)



def _teclado_confirmar_venta(borrador_id):
    """El mismo VA de las Fases 1 y 2, con los campos que de verdad se corrigen
    en una venta.

    No hay "cambiar monto": **el monto de una venta no se dicta**, sale de
    `listas_precios` y de la cascada. Un boton para escribirlo a mano seria
    exactamente la puerta que la Fase 3 cierra. Lo que si se equivoca es el
    COMPRADOR (y con el, el precio, porque a un distribuidor no se le cobra
    lista) y la CUENTA donde entra el dinero.
    """
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("VA, escribelo", callback_data="vavt:" + borrador_id)],
        [InlineKeyboardButton("Otro comprador", callback_data="comp:" + borrador_id),
         InlineKeyboardButton("Cambiar cuenta", callback_data="cta:" + borrador_id)],
        [InlineKeyboardButton("Cancelar", callback_data="no:" + borrador_id)],
    ])


def _teclado_compradores(opciones, permite_publico=False):
    """Los compradores van POR INDICE, igual que deudores, cuentas y categorias.

    `pub` no es un indice sino una palabra de tres letras porque no apunta a
    ninguna fila: "Publico en General" es la AUSENCIA de comprador, la forma
    legitima y de siempre de una venta de mostrador. Meterlo como indice -1
    habria obligado a que la lista y la ausencia se leyeran igual.
    """
    filas = [[InlineKeyboardButton(
        o["nombre"] + " (" + str(o.get("rol") or "") + ")",
        callback_data="setcomp:" + str(i))] for i, o in enumerate(opciones)]
    if permite_publico:
        filas.append([InlineKeyboardButton("Publico en General",
                                           callback_data="setcomp:pub")])
    return InlineKeyboardMarkup(filas)


def _teclado_productos(opciones):
    """Un boton por producto, con su precio a la vista.

    El precio va en el boton a proposito: cuando el empate es ambiguo entre
    "Destilado Plata 250ml" y "Destilado Plata 50ml", los nombres se parecen y
    los precios no ($179 contra $69). Es el dato que de verdad distingue.
    """
    filas = [[InlineKeyboardButton(
        o["nombre"] + "  $" + ("{:,.2f}".format(float(o.get("precio") or 0))),
        callback_data="setprod:" + str(i))] for i, o in enumerate(opciones)]
    return InlineKeyboardMarkup(filas)


def _teclado_confirmar_lote(borrador_id):
    """El VA de un lote, con el unico campo que de verdad se corrige: el codigo.

    Aqui NO hay boton para cambiar litros, grados ni kilos. No es descuido: si
    el numero esta mal, lo que hay que hacer es dictarlo otra vez, porque un
    lote es un conjunto de mediciones y cambiar una sola desde un boton invita
    a "arreglar" la que no cuadra en vez de volver a medir. El codigo es lo
    unico que no se midio: se propuso.
    """
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("VA, escribelo", callback_data="valt:" + borrador_id)],
        [InlineKeyboardButton("Otro codigo", callback_data="cod:" + borrador_id)],
        [InlineKeyboardButton("Cancelar", callback_data="no:" + borrador_id)],
    ])


def _teclado_confirmar_entrada(borrador_id):
    """D92: el VA de una entrada de empaque. Sin campos que corregir: si la
    cantidad esta mal, se dice otra vez ("no, llegaron 400")."""
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("VA, escribelo", callback_data="vaent:" + borrador_id)],
        [InlineKeyboardButton("Cancelar", callback_data="no:" + borrador_id)],
    ])


def _teclado_insumos(opciones):
    """Un boton por insumo, con su unidad a la vista.

    La unidad va en el boton por la misma razon que el precio va en el de
    productos: es el dato que distingue. "8 de Chile Guajillo" puede ser kilos
    o piezas, y entre "Botella 750ml Vacia" (PIEZAS) y "Agua de proceso"
    (LITROS) la unidad dice mas que el nombre.
    """
    filas = [[InlineKeyboardButton(
        o["nombre"] + " (" + str(o.get("unidad") or "") + ")",
        callback_data="setins:" + str(i))] for i, o in enumerate(opciones)]
    return InlineKeyboardMarkup(filas)


def _teclado_formatos(opciones):
    """Un boton por formato de botella, con sus mililitros.

    Los tres formatos se llaman casi igual ("Destilado Plata 750ml", "250ml",
    "50ml"); los mililitros son lo que los separa, y ademas son exactamente lo
    que decide el rendimiento del lote.
    """
    filas = [[InlineKeyboardButton(
        o["nombre"] + "  " + str(int(float(o.get("ml") or 0))) + " ml",
        callback_data="setfmt:" + str(i))] for i, o in enumerate(opciones)]
    return InlineKeyboardMarkup(filas)


def _teclado_confirmar_cotizacion(borrador_id):
    """El VA de una cotizacion, con los dos campos que de verdad se corrigen.

    El CLIENTE, porque decide el precio igual que en una venta: a un
    distribuidor se le cotiza su costo y a un prospecto la lista, y equivocarse
    manda por escrito un precio que despues no se puede sostener. Y la
    VIGENCIA, porque es lo unico de la cotizacion que se negocia de palabra
    ("te lo respeto un mes") y el default de 15 dias no siempre es lo dicho.

    No hay boton de precio, por la misma razon que no lo hay en la venta: el
    precio sale de `listas_precios` y de la cascada, no de la boca.
    """
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("VA, guardala", callback_data="vact:" + borrador_id)],
        [InlineKeyboardButton("Otro cliente", callback_data="cli:" + borrador_id),
         InlineKeyboardButton("Cambiar vigencia", callback_data="vig:" + borrador_id)],
        [InlineKeyboardButton("Cancelar", callback_data="no:" + borrador_id)],
    ])


def _teclado_clientes(opciones, permite_prospecto=False, nombre_dicho=""):
    """Los clientes por indice, mas el boton que la venta NO tiene.

    "Es cliente nuevo" existe porque cotizar a alguien que todavia no compra es
    el caso NORMAL de una cotizacion. En una venta, un nombre fuera de la red es
    un error; aqui es un prospecto, y obligarlo a darse de alta como
    distribuidor antes de saber si va a comprar llenaria la red de nodos
    muertos.
    """
    filas = [[InlineKeyboardButton(
        o["nombre"] + " (" + str(o.get("rol") or "") + ")",
        callback_data="setcli:" + str(i))] for i, o in enumerate(opciones)]
    if permite_prospecto and nombre_dicho:
        filas.append([InlineKeyboardButton(
            "Es cliente nuevo: " + nombre_dicho[:40], callback_data="setcli:pros")])
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


async def _contestar_consulta(update, chat, consulta, filtro=None):
    """Fase 3. Devuelve True si contesto una consulta.

    EL MODELO NO VE NI UN NUMERO. Clasifica la intencion, el servidor lee la
    vista y **devuelve el texto ya formateado**; aqui solo se reenvia. Por eso
    una consulta no puede contestar una cifra inventada: no hay ningun punto del
    camino donde el LLM pueda escribirla.

    **La clasificacion ya viene hecha.** Hasta el 2026-09-19 esta funcion
    llamaba otra vez al modelo (`consultar.clasificar`) para decidir de que
    consulta se trataba: una segunda opinion sobre algo que el enrutador acababa
    de decidir. Y las dos opiniones ni siquiera hablaban el mismo idioma --
    `consultar.py` conocia SEIS consultas y el servidor contesta TRES
    (`lib/bot-consultas.ts`), asi que las otras tres viajaban hasta el endpoint
    nada mas para que las rechazara. Ahora la lista cerrada vive en un solo
    lugar (`CONSULTAS_QUE_CONTESTA`) y aqui llega ya normalizada.
    """
    if not consulta or consulta == "otra":
        return False

    estado, r = _post("/api/bot/consulta", {
        "telegram_id": chat,
        "consulta": consulta,
        "filtro": filtro,
    })
    # Se registra QUE se consulto y COMO salio, nunca la respuesta: el log ya
    # lleva el token del bot en cada linea de la libreria y no se le agregan
    # cifras del negocio. Sin esta linea, un uso real del bot no dejaba rastro
    # del lado de la maquina y no habia con que comprobarlo despues.
    log.info("consulta por voz/texto: %s filtro=%s -> %s", consulta, filtro, estado)
    if estado != 200 or not r.get("ok"):
        await update.effective_message.reply_text(
            r.get("error", "No pude consultarlo."))
        return True

    await _contestar_texto_de_consulta(update, chat, r)
    return True


# Los dos 422 de `app/api/bot/abono/proponer/route.ts` que hablan de la cuenta.
ERROR_CUENTA_DE_MATRIZ = "La cuenta de la matriz la escoge Norman"
ERROR_CUENTA_AJENA = "Esa cuenta no es tuya o esta vetada"


def _cerrar_preguntas_de_abono(chat, monto):
    """La lista de un abono por ese mismo monto queda contestada: su boton viejo ya
    no crea un segundo abono (D2, segunda auditoria del 2026-11-04). Un monto distinto
    es otro abono y su lista sigue viva (S5). El precio: dos abonos reales por el
    mismo monto, y el de la lista vieja se dicta otra vez; nada se escribe."""
    for pid, pregunta in list((_preguntas.get(chat) or {}).items()):
        if (pregunta.get("tipo") == "abono_eligiendo"
                and _mismo_monto((pregunta.get("propuesta") or {}).get("monto"), monto)):
            _preguntas[chat].pop(pid, None)
            if _apartado.get(chat) is pregunta:
                _apartado.pop(chat, None)


async def _proponer_abono(update, chat, propuesta, id_deudor=None, nombre=None, cuenta=None,
                          ya_avisado=False):
    """Fase 2. Devuelve True si propuso un abono (o si pidio elegir deudor).

    EL MODELO NO ELIGE A NADIE: el enrutador devuelve un NOMBRE y el servidor lo
    empata contra la cartera viva. Si hay mas de un candidato, o ninguno, vuelve
    con `hay_que_elegir` y lo resuelve un boton. Escribir dinero en la entidad
    equivocada no se corrige solo: hay que anular la fila y recapturar.

    **La propuesta SIEMPRE llega armada.** Antes esta funcion tenia dentro su
    propio extractor (`extraer_abono`), o sea una segunda lectura del mismo
    mensaje que el enrutador ya habia leido. El nombre del deudor que valia
    dependia de cual de las dos lecturas hubiera corrido, y eso en una funcion
    que mueve dinero de la cartera de alguien.
    """
    # El nombre llega por parametro. Si no hay, es porque el deudor ya quedo
    # resuelto por uuid (un boton) y el nombre ya no pinta nada.
    nombre_dicho = nombre

    cuerpo = {"telegram_id": chat, "propuesta": propuesta}
    if id_deudor:
        cuerpo["id_deudor"] = id_deudor
    else:
        cuerpo["deudor"] = nombre_dicho
    # 2026-11-04: la cuenta dicha. Un DST no la escoge (el servidor da 422): ahi se
    # propone sin ella, que es lo de siempre, y se dice.
    cuenta = dict(cuenta or {})
    if cuenta.get("id_cuenta"):
        cuerpo["id_cuenta"] = cuenta["id_cuenta"]
    cuerpo["contexto_bot"] = _contexto_para_base(cuenta, propuesta)

    estado, r = _post("/api/bot/abono/proponer", cuerpo)
    # Solo los dos errores que son de la CUENTA. Cualquier otro 422 (deudor, origen
    # igual a destino) se dice tal cual: reintentar sin cuenta tiraba la cuenta dicha
    # en silencio (auditoria 2026-11-04). Los textos son los de la ruta.
    error = str(r.get("error") or "") if estado == 422 and isinstance(r, dict) else ""
    if cuerpo.get("id_cuenta") and (ERROR_CUENTA_DE_MATRIZ in error or ERROR_CUENTA_AJENA in error):
        cuerpo.pop("id_cuenta")
        cuenta.pop("id_cuenta")
        if ERROR_CUENTA_AJENA in error:
            # La dijo y no es suya: se pregunta, no se escoge otra callando.
            cuenta["oida"] = cuenta.get("oida") or "esa cuenta"
        cuerpo["contexto_bot"] = _contexto_para_base(cuenta, propuesta)
        estado, r = _post("/api/bot/abono/proponer", cuerpo)
    _refrescar_deudores(r)
    log.info("abono propuesto: deudor=%s monto=%s -> %s",
             nombre_dicho or id_deudor, propuesta.get("monto"), estado)

    if estado == 200 and r.get("hay_que_elegir"):
        _cerrar_preguntas_de_abono(chat, propuesta.get("monto"))
        _memoria[chat] = {"tipo": "abono_eligiendo",
                          "opciones": r.get("opciones", list(_deudores)),
                          "propuesta": propuesta, "cuenta": cuenta}
        await update.effective_message.reply_text(
            r.get("mensaje", "Quien te pago?"),
            reply_markup=_lista_de(chat, _teclado_deudores(r.get("opciones", []))))
        return True

    if estado != 200 or not r.get("ok"):
        # 422 y 403 SI se dicen: llegamos aqui porque el extractor lo leyo como
        # abono, asi que callarse dejaria a la persona sin saber por que no paso
        # nada. Solo un "no es un abono" (arriba) sigue de largo a la consulta.
        await update.effective_message.reply_text(r.get("error", "No pude proponer el abono."))
        return True

    _cerrar_preguntas_de_abono(chat, propuesta.get("monto"))
    # S12, igual que el gasto: el mismo abono dictado dos veces no se agrega callando.
    # Se compara despues de proponer porque quien sabe que "Pepe" y "el de Pepe" son
    # la misma persona es el servidor. El borrador de sobra se apaga antes de ensenarlo.
    # Dentro de `_reemplazando` es un cambio a una propuesta, no un dictado nuevo.
    igual = None if ya_avisado or _reemplazo.get(chat) else next(
        (v for v in _pendientes_de(chat) if _mismo_abono(
            propuesta, r.get("id_deudor"), r.get("nombre_deudor") or nombre, v)), None)
    if igual is not None:
        _cancelar_en_base(chat, r["borrador_id"])
        await _preguntar_duplicado(update, chat, igual, "abono", {
            "propuesta": dict(propuesta), "cuenta": dict(cuenta),
            "abono": {"id_deudor": r.get("id_deudor"), "nombre": nombre}})
        return True
    # Una cuenta de solo egresos no recibe: ni se ofrece.
    cuentas = [c for c in r.get("cuentas") or [] if c.get("id") not in SOLO_EGRESOS]
    _memoria[chat] = dict({
        "tipo": "abono",
        "borrador_id": r["borrador_id"],
        "sello": r["sello"],
        "id_deudor": r.get("id_deudor"),
        "nombre_deudor": r.get("nombre_deudor"),
        "propuesta": propuesta,
        # La lista completa viaja con el borrador para que "Otro deudor" no
        # tenga que volver a preguntarle al servidor.
        "opciones": r.get("opciones", list(_deudores)),
        "cuentas": cuentas,
        "cuenta": cuenta,
    }, **_estado_de_cuenta(cuenta, cuentas))
    dato = _memoria.get(chat)
    await _ensenar_propuesta(update, chat, _mensaje_con_cuenta(dato, r["mensaje"]),
                             _teclado_confirmar_abono(r["borrador_id"], dato))
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


def _propuesta_de_abono(campos):
    """Los campos del enrutador, en la forma que espera `/api/bot/abono/proponer`.

    El deudor NO va aqui: viaja aparte porque el servidor lo empata contra la
    cartera viva y puede contestar con botones. Meterlo en la propuesta lo
    volveria un dato mas, y es el que decide a quien se le acredita el dinero.
    """
    campos = campos or {}
    return {
        "monto": campos.get("monto"),
        "metodo_pago": campos.get("metodo_pago"),
        "nota": campos.get("nota") or campos.get("descripcion"),
        "fecha": campos.get("fecha"),
    }


# Cuanto vive un borrador a medias. Media hora: lo suficiente para una
# conversacion que se interrumpe por una llamada, y poco para que el "500 de
# gasolina" del lunes contamine la primera frase del martes.
VIDA_DEL_BORRADOR = 1800


def _tomar_borrador_a_medias(chat):
    """Saca de `_memoria` los campos de una captura que quedo incompleta.

    **Ya NO se consume al leerlo (D28, 2026-09-19), y ese era un defecto.**
    Vivia exactamente una vuelta y solo 6 de las 12 intenciones lo volvian a
    guardar: `reporte` y `charla` no guardaban nada, asi que una captura a
    medias se perdia en cuanto el modelo leia un mensaje como conversacion.

    Lo que si se conserva del diseno viejo es la razon de que caducara: un
    borrador pegado para siempre contamina el dia siguiente. Se resuelve con el
    reloj, que es lo que se queria de verdad, y no borrandolo al primer vistazo.
    Ademas, cualquier `_proponer_*` que tenga exito PISA `_memoria[chat]`, asi
    que un borrador resuelto desaparece solo.
    """
    dato = _memoria.get(chat)
    if not isinstance(dato, dict) or dato.get("estado") != "incompleto":
        return None
    nacido = dato.get("nacido_en")
    if isinstance(nacido, (int, float)) and (time.time() - nacido) > VIDA_DEL_BORRADOR:
        _memoria.pop(chat, None)
        return None
    campos = dato.get("campos")
    return dict(campos) if isinstance(campos, dict) and campos else None


# El centinela de los teclados de lista ("Mejor no"): ahi todavia no hay
# borrador sellado que apagar, asi que el callback_data no lleva uuid.
_NO_HAY_BORRADOR = ("", "x")


def _catalogo_de_productos(chat):
    """Lo que se vende, leido del servidor. **D35.**

    El modelo extraia el nombre del producto A CIEGAS: `_pedazo_contexto` le
    mandaba el borrador, las categorias de gasto y los deudores, y **del
    catalogo nada**. El empate lo hacia despues un comparador literal de
    TypeScript, que se rompe con un espacio de mas -- "750 ml" contra
    "Destilado Plata 750ml". Al modelo, que con tres filas enfrente resuelve
    "las grandes" sin despeinarse, no se le preguntaba.

    Si el servidor no contesta se devuelve lo ultimo que se supo, o una lista
    vacia: **el bot no se cae por esto**. Sin catalogo el modelo trabaja como
    trabajaba antes y la red de TypeScript (`lib/bot-tamanos.ts`) sigue puesta.
    """
    global _productos, _productos_leidos_en
    ahora = time.time()
    if _productos and (ahora - _productos_leidos_en) < TTL_PRODUCTOS:
        return _productos
    estado, r = _post("/api/bot/catalogo", {"telegram_id": chat})
    if estado == 200 and r.get("ok"):
        # 2026-11-03 - UNA SOLA LISTA: el vocabulario de categorias de gasto
        # viene de `categorias_movimiento` en la misma lectura. Asi una
        # subcategoria agregada en el ERP llega al extractor en <= TTL_PRODUCTOS.
        _refrescar_catalogo(r)
    if estado == 200 and r.get("ok") and r.get("productos"):
        _productos = r["productos"]
        _productos_leidos_en = ahora
        log.info("catalogo leido: %s productos", len(_productos))
    elif not _productos:
        log.warning("no pude leer el catalogo de productos: %s", estado)
    return _productos


# Como se le dice a cada tipo de propuesta cuando hay que nombrarla en una frase.
_COMO_SE_LLAMA = {
    "gasto": "un gasto",
    "abono": "un abono",
    "venta": "una venta",
    "lote": "un lote",
    "cotizacion": "una cotizacion",
    "anulacion": "una anulacion",
    "correccion": "una correccion",
    "alta": "un alta",
    "conversion": "una conversion",
    "entrega_efectivo": "una entrega de efectivo",
    "entrega": "una entrega de efectivo",
    "categoria": "una categoria nueva",
    "alta_categoria": "una categoria nueva",
}


def _tipo_de(dato):
    """El tipo de un borrador del bot. El de gasto no lleva `tipo` (Fase 1)."""
    return str((dato or {}).get("tipo") or "gasto")


def _texto_plano(texto, tope=320):
    limpio = str(texto or "").replace(AVISO_ENSAYO, "")
    return " ".join(limpio.split())[:tope]


def _en_pantalla(chat, esperando=""):
    """Que tiene Norman enfrente ahora mismo. **D28, y D74 (Fase 8).**

    Fase 8: una linea POR PROPUESTA viva, con su CONTENIDO (el texto que Norman
    ve), no solo su tipo. Sin el contenido, "fue venta a concesion" no tenia
    contra que corregirse: el modelo sabia que habia "una venta" y no cual.
    Lo de abajo (pregunta con botones, captura a medias) sigue igual.

    Esta es la pieza que faltaba para el `sii`. `_tomar_borrador_a_medias` solo
    mira los borradores INCOMPLETOS, asi que cuando hay una propuesta COMPLETA
    esperando el "va" -- el caso normal -- el modelo recibia el mensaje pelado y
    un "sii" no tenia contra que interpretarse. Salia `charla`.

    **Sin historial largo, y es deliberado**: con el ultimo turno basta y es lo
    barato. `[Filtro: DOC02 -- YAGNI]`
    """
    if esperando:
        return "te acabo de preguntar: " + esperando
    renglones = []
    for vivo in _pendientes_de(chat):
        mostrado = vivo.get("mostrado")
        contenido = _texto_plano(mostrado[1]) if mostrado else ""
        if contenido and vivo.get("comprobante"):
            contenido = enrutador.dato_de_ticket(contenido)
        renglones.append("propuesta de " + _COMO_SE_LLAMA.get(_tipo_de(vivo), "captura")
                         + " esperando su VA" + (": " + contenido if contenido else ""))
    dato = _memoria.get(chat)
    if isinstance(dato, dict) and not dato.get("borrador_id"):
        tipo = str(dato.get("tipo") or "")
        if tipo.endswith("_eligiendo"):
            campo = str(dato.get("campo") or "cual")
            renglones.append("una pregunta con botones para escoger " + campo
                             + ", de " + _COMO_SE_LLAMA.get(tipo.split("_")[0], "una captura"))
        elif dato.get("estado") == "incompleto":
            renglones.append("una captura de "
                             + _COMO_SE_LLAMA.get(str(dato.get("intencion")), "algo")
                             + " a la que todavia le falta un dato")
    return "\n".join(renglones)


def _cancelar_de_verdad(chat, borrador_id):
    """Apaga el borrador en la BASE, no solo en la memoria de este proceso.

    **El defecto que cierra (2026-09-19).** `app/api/bot/cancelar/route.ts`
    estaba escrita, probada y bien — y **no la llamaba nadie**: `grep -rn
    "bot/cancelar"` sobre `.py` y `.ts` daba cero. Los dos "no" (el boton y el
    texto) hacian solo `_memoria.pop`, asi que la fila de `bot_borradores` se
    quedaba `PENDIENTE` para siempre. No truena —cada `proponer` cancela lo
    pendiente antes de insertar— **pero el rastro miente**: dice que hay un
    borrador vivo que nadie abandono.

    Las reglas, y cada una tapa una forma de fallar:

    - **D2 — sin `borrador_id` no se llama a la ruta y se contesta igual.** Un
      "no" suelto sin propuesta viva es normal. **Cancelar no puede fallarle
      nunca a la persona.**
    - **D3 — el texto no cambia**, salvo el 409: si el borrador ya estaba
      CONFIRMADO, *"no escribi nada"* es mentira y hay que decirlo.
    - **D4 — `_memoria` se limpia SIEMPRE**, pase lo que pase con la red. El
      orden es: primero la base, luego la memoria, luego la respuesta. Un fallo
      de red no puede dejar el estado local colgado.
    - **D5 — se registra.** Esta ruta solo borra logicamente, asi que es la que
      MAS lo necesita (la leccion de `E-244`: lo unico que no dejaba rastro era
      justo lo que no escribia filas). Van `borrador_id`, `telegram_id` y el
      estado devuelto. **Nunca el contenido del borrador.**

    Devuelve el texto que hay que contestarle a la persona.
    """
    texto = "Cancelado. No escribi nada."
    pregunta = dict.get(_memoria, chat)
    if not borrador_id and isinstance(pregunta, dict) and not pregunta.get("borrador_id"):
        texto = _texto_al_soltar(chat, pregunta)
    try:
        if borrador_id:
            estado, r = _post("/api/bot/cancelar", {
                "telegram_id": chat,
                "borrador_id": borrador_id,
            })
            log.info("cancelar: borrador=%s telegram=%s -> %s%s",
                     borrador_id, chat, estado,
                     " (ya estaba cancelado)" if r.get("ya_estaba") else "")
            if estado == 409:
                texto = ("Eso ya habia quedado escrito, asi que no lo cancele. "
                         "Si lo quieres deshacer, dime que lo anule.")
    finally:
        # El `finally` NO es adorno, y lo encontro una prueba, no una relectura:
        # sin el, un `_post` que revienta se lleva por delante el `pop` y deja
        # el borrador vivo en memoria. Norman ya dijo que no, y el siguiente
        # mensaje le contestaria sobre algo que el ya cancelo. Hoy `_post`
        # atrapa sus propias excepciones y devuelve (0, ...), asi que esto no
        # dispara en produccion -- pero **D4 dice SIEMPRE, y "siempre" no puede
        # depender de que otra funcion siga siendo amable.**
        #
        # Fase 8 (D79): con varias propuestas vivas, se apaga LA QUE SE NOMBRO.
        # Si no es la del foco, sale del registro y el foco se queda.
        # D92: cancelar tambien suelta el envasado que esperaba empaque, pero
        # cancelar OTRA propuesta no tiene por que tirarlo.
        cancelado = (_pendientes.get(chat) or {}).get(borrador_id) or {}
        if not borrador_id or _tipo_de(cancelado) in ("lote", "entrada_insumo"):
            _esperando_empaque.pop(chat, None)
        foco = _memoria.get(chat)
        foco_bid = foco.get("borrador_id") if isinstance(foco, dict) else ""
        if borrador_id:
            _soltar_esperas(chat, borrador_id)
        if borrador_id and borrador_id != foco_bid:
            (_pendientes.get(chat) or {}).pop(borrador_id, None)
        elif borrador_id or not foco_bid:
            _memoria.pop(chat, None)
        # Sin id y con una propuesta sellada en el foco no se toca nada: apagarla
        # solo en RAM dejaba la fila PENDIENTE y su VA muerto (auditoria, S7).
    return texto


def _texto_al_soltar(chat, pregunta):
    """Soltar una pregunta no cancela las propuestas que siguen vivas: el texto no
    puede dar a entender lo contrario (segunda auditoria del 2026-11-04)."""
    if pregunta.get("tipo") == "duplicado_eligiendo":
        igual = (_pendientes.get(chat) or {}).get(pregunta.get("igual"))
        # 2026-11-03: dicto el gasto y luego mando su ticket: la foto va con el dicho.
        pegada = igual and _adjuntar_comprobante(chat, igual.get("borrador_id"), pregunta.get("foto"))
        return "Va, no lo agregue." + (
            " Sigue pendiente " + _etiqueta_de(igual) + ", con su VA." if igual else "") + (
            " Le pegue la foto del ticket." if pegada else "")
    if _pendientes_de(chat):
        return ("Va, eso lo deje y no escribi nada. Lo que tenias pendiente sigue ahi, "
                "cada propuesta con su VA.")
    return "Cancelado. No escribi nada."


def _borrador_vivo(chat):
    """El id del borrador sellado que hay en pantalla ahora mismo, o "".

    Es la misma llave que lee `_confirmar_venta`. Se lee ANTES de limpiar la
    memoria, porque `_cancelar_de_verdad` la limpia.
    """
    dato = _memoria.get(chat)
    if not isinstance(dato, dict):
        return ""
    return str(dato.get("borrador_id") or "")


def _recordar_a_medias(chat, intencion, campos):
    """Lo que si se entendio, esperando la pieza que falta. **Sin sello.**

    Un borrador sellado significa "esto es exactamente lo que se va a escribir".
    Este no lleva sello y no puede llevarlo: todavia le falta un campo, asi que
    no hay nada que sellar. Esa ausencia es la que impide que `_confirmar` lo
    tome por bueno si alguien contesta "va" antes de tiempo.
    """
    _memoria[chat] = {
        "estado": "incompleto",
        "intencion": intencion,
        "campos": dict(campos or {}),
        "nacido_en": time.time(),
    }


# ===========================================================================
# AQUI VIVIA `_proponer()`, LA CASCADA VIEJA. 2026-09-19.
# ===========================================================================
#
# Era el camino de siempre: llamar a `extraer`, y si decia "esto no parece un
# gasto", intentar abono, y si tampoco, intentar consulta. Tres llamadas al
# modelo en fila para contestar una pregunta, y un mensaje de ayuda fijo para
# todo lo que no cayera en esas tres cajas.
#
# Se quedo de red de seguridad cuando entro el enrutador, y esa fue la decision
# equivocada. Una red que lee el mismo mensaje con OTRO prompt no es una red: es
# una segunda opinion que puede diferir de la primera, y que se activa
# precisamente cuando algo ya salio raro. El gasto que el enrutador entendio de
# una forma y la cascada de otra se escribe distinto segun cual corriera, y
# desde afuera las dos cosas se ven igual.
#
# **La red de verdad son los comandos**: `/stock`, `/cartera`, `/ventas` y
# `/abono` no pasan por ningun modelo, asi que siguen funcionando aunque el
# modelo este caido. Y si se cae con un gasto en la mano, lo que toca es
# decirlo, no adivinarlo con otro prompt.
#
# `bot/extraer.py`, `bot/extraer_abono.py` y `bot/consultar.py` siguen en el
# repo sin llamador (regla 6: nada se borra).
# ===========================================================================


# Lo unico que el bot guarda en memoria: el ultimo borrador por chat, para poder
# mandar el sello al confirmar. **El payload NO vive aqui** — vive en la base, y
# por eso este proceso no puede alterarlo aunque tuviera un bug.
class _Memoria(dict):
    """El FOCO por chat (lo que un "va" escrito confirmaria) + el registro.

    Fase 8 (D79): hasta hoy era un `dict` de un solo borrador por chat, y cada
    propuesta nueva pisaba la anterior. Ahora cada borrador SELLADO que entra
    aqui se anota tambien en `_pendientes[chat][borrador_id]`, y al sacarlo
    (`pop`, que es como TODOS los caminos lo sueltan al confirmar o cancelar)
    sale del registro y el foco vuelve a la propuesta viva mas reciente. Asi
    las 40 lineas que ya leen `_memoria[chat]` siguen leyendo "la de ahora".
    """

    def __setitem__(self, chat, dato):
        if isinstance(dato, dict):
            if dato.get("borrador_id") and dato.get("sello"):
                _registrar(chat, dato)
            else:
                # Una pregunta con botones sobre una propuesta viva (p. ej.
                # "Otro comprador" que vuelve con `hay_que_elegir`) hereda a
                # quien va a reemplazar cuando se selle. **Solo dentro de
                # `_reemplazando`**: una pregunta nueva no tiene a quien reemplazar.
                reemplaza = _reemplazo.get(chat)
                if reemplaza:
                    dato["_reemplaza"] = reemplaza
                if str(dato.get("tipo") or "").endswith("_eligiendo"):
                    _guardar_pregunta(chat, dato)
        dict.__setitem__(self, chat, dato)

    def pop(self, chat, *defecto):
        if not dict.__contains__(self, chat):
            return defecto[0] if defecto else None
        dato = dict.pop(self, chat)
        bid = dato.get("borrador_id") if isinstance(dato, dict) else None
        if bid:
            (_pendientes.get(chat) or {}).pop(bid, None)
        elif isinstance(dato, dict) and dato.get("_pid"):
            (_preguntas.get(chat) or {}).pop(dato["_pid"], None)
        siguiente = _apartado.pop(chat, None)
        if siguiente is None:
            vivos = _pendientes_de(chat)
            siguiente = vivos[-1] if vivos else None
        if siguiente is not None:
            dict.__setitem__(self, chat, siguiente)
        return dato


_memoria = _Memoria()
# Fase 8 (D79): los borradores SELLADOS vivos por chat, `{borrador_id: dato}`,
# en orden de llegada. Es lo que el boton VA de cada propuesta encuentra.
_pendientes = {}
# El foco a medias (pregunta o captura incompleta) que se aparto porque Norman
# toco el boton de OTRA propuesta. Vuelve al foco cuando esa se resuelve.
_apartado = {}
# 2026-11-04 (auditoria, S3/S4): aqui vivia `_modo_propuesta`, un modo global por
# chat que decidia si una propuesta sumaba o reemplazaba. Se quedaba colgado cuando
# un hecho no llegaba a sellarse, y lo que reemplazaba era "lo que hubiera en el
# foco". Ahora por defecto TODO se suma, y solo reemplaza quien lo declara por id.
# `chat -> borrador_id` que va a reemplazar la propuesta en curso. Solo existe
# dentro de `_reemplazando`: no puede quedarse colgado.
_reemplazo = {}
# Las preguntas con botones vivas: `chat -> {pid: dato}`. Aun no tienen borrador,
# pero sus botones si necesitan un dueno: sin el, el indice de una lista vieja se
# aplicaba a lo que hubiera en el foco.
_preguntas = {}
# `chat real -> {id del mensaje: borrador_id}`: que propuesta se ensenó en cada
# mensaje. Sirve para contestar a una propuesta aunque su mensaje no traiga teclado.
_mensajes = {}
TOPE_MENSAJES = 300
# Desde 2026-11-04 un mensaje nuevo no cancela nada y esto queda vacio; se conserva
# el aviso porque D49 sigue: lo que se apague solo, se dice.
_caidos = {}
# Los hechos de un mismo mensaje que esperan turno: {"hechos": [...], "en": t}.
_cola = {}
# Los chats que ya pidieron sus pendientes a la base despues de arrancar (D77).
_rehidratado = set()


def _pendientes_de(chat):
    """Los borradores sellados vivos de este chat, del mas viejo al mas nuevo.
    Caducan con `VIDA_DEL_BORRADOR`, igual que en el servidor (30 min)."""
    reg = _pendientes.get(chat) or {}
    ahora = time.time()
    for bid, dato in list(reg.items()):
        if ahora - float(dato.get("_sellado_en") or ahora) > VIDA_DEL_BORRADOR:
            reg.pop(bid, None)
    return list(reg.values())


def _cancelar_en_base(chat, borrador_id):
    """Apaga un borrador reemplazado. No toca la memoria (quien llama ya lo hizo)."""
    estado, _r = _post("/api/bot/cancelar", {"telegram_id": chat, "borrador_id": borrador_id})
    log.info("reemplazado: borrador=%s telegram=%s -> %s", borrador_id, chat, estado)


def _registrar(chat, dato):
    """Anota un borrador recien sellado. Dos casos, y el dato los distingue:

    - por defecto se SUMA (2026-11-04, Norman: conviven, cada una con su VA).
    - si esta dentro de `_reemplazando(chat, id)`, sustituye a ESE id y a ningun
      otro. La vieja se apaga en la base explicitamente, porque esta `proponer`
      salio conservando.

    Lo que hubiera en el foco no decide nada: era la causa comun de S3 y S4.
    """
    reg = _pendientes.setdefault(chat, {})
    bid = dato["borrador_id"]
    dato.setdefault("_sellado_en", time.time())
    reemplaza = _reemplazo.get(chat)
    if reemplaza and reemplaza != bid and reemplaza in reg:
        reg.pop(reemplaza, None)
        _soltar_esperas(chat, reemplaza)
        _cancelar_en_base(chat, reemplaza)
    reg[bid] = dato


@contextlib.contextmanager
def _reemplazando(chat, borrador_id):
    """Lo que se selle aqui dentro sustituye a `borrador_id`. Al salir, por la
    razon que sea (el `proponer` fallo, pregunto, reventó), no queda nada puesto."""
    previo = _reemplazo.get(chat)
    if borrador_id:
        _reemplazo[chat] = borrador_id
    try:
        yield
    finally:
        if previo:
            _reemplazo[chat] = previo
        else:
            _reemplazo.pop(chat, None)


def _soltar_esperas(chat, borrador_id):
    """Un borrador que se apaga se lleva lo que se esperaba por texto para el."""
    for espera in (_esperando_monto, _esperando_codigo, _esperando_vigencia):
        if espera.get(chat) == borrador_id:
            espera.pop(chat, None)


def _guardar_pregunta(chat, dato):
    """Le da su id a una pregunta con botones. Sus botones lo llevan (`_lista_de`)."""
    dato["_pid"] = "q" + uuid.uuid4().hex[:8]
    dato["_nacida_en"] = time.time()
    _preguntas.setdefault(chat, {})[dato["_pid"]] = dato


def _lista_de(chat, teclado):
    """Ata cada boton de una lista al objeto en el foco: su borrador o su pregunta.

    2026-11-04 (auditoria, S5): `setdeu:<i>` no decia de quien era, asi que el indice
    de una lista vieja se aplicaba a lo que hubiera en el foco. Se hace aqui y no en
    cada `_teclado_*` para que una lista nueva no se pueda olvidar. Con un uuid el
    `callback_data` mas largo (`setcomp:<i>:<uuid>`) no pasa de 48 bytes."""
    dato = dict.get(_memoria, chat)
    dueno = ""
    if isinstance(dato, dict):
        dueno = dato.get("borrador_id") or dato.get("_pid") or ""
    if not dueno:
        return teclado
    filas = []
    for fila in teclado.inline_keyboard:
        nueva = []
        for boton in fila:
            data = str(boton.callback_data or "")
            partes = data.split(":")
            if data == "no:x":
                data = "no:" + dueno if _PATRON_UUID.match(dueno) else "no:x:" + dueno
            elif partes[0] in _ACCIONES_DE_LISTA and len(partes) == 2:
                data = data + ":" + dueno
            nueva.append(InlineKeyboardButton(boton.text, callback_data=data))
        filas.append(nueva)
    return InlineKeyboardMarkup(filas)


def _soltar_foco(chat):
    """Deja el foco vacio SIN tocar el registro: el siguiente hecho de un
    mensaje no es un refinamiento del anterior, es otra propuesta."""
    dict.pop(_memoria, chat, None)


def _enfocar(chat, borrador_id):
    """El boton de una propuesta viva la pone en el foco. Devuelve True si pudo.

    Si el foco era una pregunta o una captura a medias, se aparta y vuelve
    cuando la propuesta tocada se resuelva."""
    reg = _pendientes.get(chat) or {}
    dato = reg.get(borrador_id)
    if dato is None:
        dato = _pregunta_viva(chat, borrador_id)
    if dato is None:
        return False
    foco = dict.get(_memoria, chat)
    if foco is dato or (isinstance(foco, dict) and foco.get("borrador_id")
                        and foco.get("borrador_id") == borrador_id):
        return True
    if isinstance(foco, dict) and not foco.get("borrador_id"):
        _apartado[chat] = foco
    dict.__setitem__(_memoria, chat, dato)
    return True


def _pregunta_viva(chat, pid):
    preguntas = _preguntas.get(chat) or {}
    dato = preguntas.get(pid)
    if dato is not None and time.time() - float(dato.get("_nacida_en") or 0) > VIDA_DEL_BORRADOR:
        preguntas.pop(pid, None)
        return None
    return dato


def _enfocar_pregunta(chat, tipo):
    """Pone en el foco la pregunta de ese tipo mas reciente. True si la habia."""
    for dato in reversed(list((_preguntas.get(chat) or {}).values())):
        if dato.get("tipo") == tipo:
            return _enfocar(chat, dato["_pid"])
    return False


def _rehidratar(chat):
    """D77: tras un reinicio, los borradores PENDIENTE de menos de 30 min vuelven.

    Una vez por chat y por proceso. Sin esto, el boton VA de una propuesta que
    sigue en la pantalla de Norman contestaba "no tengo nada pendiente" despues
    de cualquier reinicio del vigilante. Se trae lo que confirmar necesita
    (`borrador_id`, `sello`, tipo) y, en gasto y abono, el `contexto` con el que
    se propuso (`_restaurar_contexto`). Devuelve cuantos rehidrato.
    """
    if chat in _rehidratado:
        return 0
    if _pendientes.get(chat):
        _rehidratado.add(chat)
        return 0
    estado, r = _post("/api/bot/pendiente", {"telegram_id": chat})
    if estado != 200 or not isinstance(r, dict) or not r.get("ok"):
        log.warning("rehidratar: no pude leer lo pendiente de %s -> %s", chat, estado)
        return 0
    _rehidratado.add(chat)
    reg = _pendientes.setdefault(chat, {})
    ahora = time.time()
    for p in r.get("pendientes") or []:
        bid, sello, tipo = p.get("borrador_id"), p.get("sello"), p.get("tipo")
        if not bid or not sello or not tipo:
            continue
        dato = {"borrador_id": bid, "sello": sello, "rehidratado": True}
        if tipo != "gasto":
            dato["tipo"] = tipo
        if tipo in ("gasto", "abono"):
            _restaurar_contexto(chat, dato, p.get("contexto"))
        try:
            nacido = dt.datetime.fromisoformat(str(p.get("creado_en"))).timestamp()
        except ValueError:
            nacido = ahora
        dato["_sellado_en"] = nacido
        # La foto no viaja con el borrador: su lazo vive en el indice local. Sin
        # esto, tras un reinicio su descripcion volvia al enrutador sin marca y la
        # propuesta perdia el boton de quitar la foto.
        foto = comprobantes.de_borrador(bid)
        if foto:
            dato["comprobante"] = foto
            vuelo = comprobantes.foto_de_vuelo(bid)
            if vuelo:
                dato["foto_de_vuelo"] = vuelo
        reg[bid] = dato
    if reg and dict.get(_memoria, chat) is None:
        dict.__setitem__(_memoria, chat, list(reg.values())[-1])
    if reg:
        log.info("rehidrate %d borrador(es) de %s", len(reg), chat)
    return len(reg)


def _restaurar_contexto(chat, dato, contexto):
    """La cuenta de un gasto o abono rehidratado. **Lo que no se sabe, se pregunta.**

    2026-11-04 (auditoria, S1): el rehidratado perdia `cuenta_pendiente` y un "va"
    escribia la cuenta default, que nadie dijo. Ahora `bot_borradores` guarda con que
    se propuso. Un borrador de antes de este cambio no lo trae: se trata como
    pendiente, y como no tiene su `propuesta` no se puede volver a proponer.
    """
    abono = dato.get("tipo") == "abono"
    if not isinstance(contexto, dict) or not contexto:
        cuentas = [c for c in _cuentas_vivas(chat)
                   if not abono or c.get("id") not in SOLO_EGRESOS]
        # Con una sola cuenta no hay nada que preguntar. Con cero, tampoco se sabe.
        dato.update(_estado_de_cuenta({}, cuentas), cuentas=cuentas,
                    cuenta_pendiente=len(cuentas) != 1)
        return
    cuentas = [c for c in contexto.get("cuentas") or []
               if isinstance(c, dict) and not (abono and c.get("id") in SOLO_EGRESOS)]
    cuenta = contexto.get("cuenta") if isinstance(contexto.get("cuenta"), dict) else {}
    dato.update(_estado_de_cuenta(cuenta, cuentas), cuentas=cuentas, cuenta=dict(cuenta),
                id_cuenta=contexto.get("id_cuenta"))
    if isinstance(contexto.get("propuesta"), dict):
        dato["propuesta"] = dict(contexto["propuesta"])
    if abono:
        dato.update(id_deudor=contexto.get("id_deudor"), opciones=list(_deudores),
                    nombre_deudor=contexto.get("nombre_deudor"))
    else:
        dato.update(sugeridas=list(contexto.get("sugeridas") or []),
                    categorias=list(_catalogo))


def _contexto_para_base(cuenta, propuesta, sugeridas=None):
    """Lo que el servidor guarda junto al borrador para `_restaurar_contexto`.
    No entra al sello ni a la fila: si esto se pierde, se pregunta la cuenta."""
    return {"cuenta": dict(cuenta or {}), "propuesta": dict(propuesta or {}),
            "sugeridas": list(sugeridas or [])}


def _olvidar_chat(chat):
    """Todo el estado de conversacion de un chat, fuera. Lo usan las pruebas
    para que un caso no herede el registro del anterior."""
    for d in (_pendientes, _apartado, _preguntas, _reemplazo, _caidos, _cola,
              _historial, _eventos):
        d.pop(chat, None)
    _mensajes.pop(_chat_de(chat), None)
    _rehidratado.discard(chat)
    dict.pop(_memoria, chat, None)


# ── D73 (Fase 8): EL HISTORIAL CORTO DEL CHAT ──────────────────────────────
# "cuanto me debe aeropuerto" y despues cuatro veces "y la deuda?": el bot no
# sabia de quien se hablaba porque cada mensaje llegaba solo. Van los ultimos
# turnos, en RAM (se pierden al reiniciar, y esta bien: es contexto, no dato),
# y marcados como PASADO en el prompt (regla 21: de aqui no sale ningun monto).
HISTORIAL_TURNOS = 15
HISTORIAL_TTL_S = 1800
_historial = {}
_eventos = {}


# Hasta donde `_etiqueta_de` deja una descripcion.
LARGO_ETIQUETA = 24
# True mientras el bot habla de lo que leyo en un ticket (`_hablando_de_ticket`).
_texto_de_ticket = contextvars.ContextVar("texto_de_ticket", default=False)


@contextlib.contextmanager
def _hablando_de_ticket(si=True):
    marca = _texto_de_ticket.set(bool(si) or _texto_de_ticket.get())
    try:
        yield
    finally:
        _texto_de_ticket.reset(marca)


def _cita_un_ticket(chat, texto):
    """¿Cita una propuesta que salio de un ticket? Pasa fuera de ese turno, con
    `_etiqueta_de`, que RECORTA la descripcion: se compara contra lo recortado, y
    con los espacios como los deja `_texto_plano`."""
    for d in _pendientes_de(chat):
        detalle = _texto_plano(str((d.get("propuesta") or {}).get("descripcion") or "")[:LARGO_ETIQUETA])
        if d.get("comprobante") and detalle and detalle in texto:
            return True
    return False


def _anotar(chat, texto):
    """Lo que el bot le dijo a Norman en este turno, para el historial. Lo que
    viene de un ticket va marcado: de aqui vuelve a entrar al enrutador. La cita se
    busca ANTES del tope de 240: "Sigue pendiente" puede caer al final del mensaje."""
    de_ticket = _texto_de_ticket.get() or _cita_un_ticket(chat, _texto_plano(texto, 100000))
    texto = _texto_plano(texto, 240)
    if texto and de_ticket:
        texto = enrutador.dato_de_ticket(texto)
    if texto:
        _eventos.setdefault(_chat_de(chat), []).append(texto)


def _cerrar_turno(chat, dijo, ahora=None):
    ahora = time.time() if ahora is None else ahora
    real = _chat_de(chat)
    contesto = " / ".join(_eventos.pop(real, []))[:500]
    turnos = _historial.setdefault(real, [])
    # D100: en un grupo el turno lleva QUIEN lo dijo; en privado es Norman.
    if _en_grupo(chat):
        turnos.append((ahora, str(dijo or ""), contesto, _nombre_de(_persona(chat))))
    else:
        turnos.append((ahora, str(dijo or ""), contesto))
    _podar_historial(real, ahora)


def _podar_historial(chat, ahora=None):
    ahora = time.time() if ahora is None else ahora
    real = _chat_de(chat)
    turnos = [t for t in _historial.get(real, []) if ahora - t[0] <= HISTORIAL_TTL_S]
    _historial[real] = turnos[-HISTORIAL_TURNOS:]
    return _historial[real]


def historial_para_el_modelo(chat, ahora=None):
    """[(hace_min, dijo, contesto)], del mas viejo al mas nuevo. **Pura salvo el
    reloj.** Es lo que recibe `enrutar(historial=...)`."""
    ahora = time.time() if ahora is None else ahora
    return [((ahora - t[0]) / 60.0,) + tuple(t[1:])
            for t in _podar_historial(chat, ahora)]


class _MensajeQueAnota:
    """El mensaje de Telegram, pero cada `reply_text` queda en el historial.

    Cazador F0 (WP-V): y si toca (`voz_salida.debe_hablar`: le hablaron en audio,
    o es una ronda del cazador; un "Listo." nunca), sale tambien en AUDIO con el
    mismo texto, y en el grupo la primera linea es la mencion real de quien
    hablo. Si el audio falla, el texto ya salio: se registra y se sigue.
    """

    def __init__(self, mensaje, chat, por_voz=False, usuario=None):
        self._mensaje = mensaje
        self._chat = chat
        self._por_voz = por_voz
        self._usuario = usuario

    async def reply_text(self, texto, *a, **k):
        texto = _rotulo_de_grupo(self._chat, texto, k.get("reply_markup"))
        habla = isinstance(texto, str) and voz_salida.debe_hablar(self._por_voz, texto)
        dicho = texto
        if habla and _en_grupo(self._chat) and "parse_mode" not in k and "entities" not in k:
            m = voz_salida.mencion(self._usuario)
            if m:
                linea, entidad = m
                texto = linea + NL + texto
                if entidad:
                    k["entities"] = [MessageEntity(type=MessageEntity.TEXT_MENTION, offset=0,
                                                   length=entidad["length"], user=self._usuario)]
        _anotar(self._chat, texto)
        enviado = await self._mensaje.reply_text(texto, *a, **k)
        if habla:
            await _hablar(self._mensaje, self._chat, dicho)
        return enviado

    def __getattr__(self, nombre):
        return getattr(self._mensaje, nombre)


async def _hablar(mensaje, chat, texto):
    """WP-V: el mismo texto, en nota de voz (edge-tts Dalia -> OGG/OPUS)."""
    try:
        destino = Path(os.environ.get("BOT_VOZ_DIR") or (Path(__file__).resolve().parent / "_audios" / "_salida"))
        destino = destino / ("r_%s_%d.ogg" % (str(chat).replace(":", "_").replace("-", "m"), int(time.time() * 1000)))
        ogg = await asyncio.to_thread(voz_salida.texto_a_voz, texto, destino)
        with open(str(ogg), "rb") as f:
            datos = f.read()
        await _mandar_voz(mensaje, datos)
        log.info("voz de salida: %s (%d bytes)", ogg.name, len(datos))
    except Exception as e:  # el texto ya salio; el audio es extra
        log.warning("voz de salida: no pude mandar el audio (%s): %s", type(e).__name__, e)


# Lote v2 (arreglo a): la voz de salida moria con TimedOut a los ~8.8 s porque
# `reply_voice` usaba el read_timeout por defecto de PTB (5 s): Telegram tarda
# en CONTESTAR despues de recibir el archivo. Timeouts explicitos y UN
# reintento. OJO: si el primer intento si llego y solo se perdio la respuesta,
# el reintento manda el audio dos veces (preferible a no mandarlo).
TIMEOUTS_VOZ = {"read_timeout": 60, "write_timeout": 60, "connect_timeout": 15, "pool_timeout": 15}
REINTENTOS_VOZ = 1
MEDIA_WRITE_TIMEOUT = 60  # el default de PTB 22.8 es 20 s


async def _mandar_voz(mensaje, datos):
    for intento in range(REINTENTOS_VOZ + 1):
        try:
            return await mensaje.reply_voice(voice=datos, **TIMEOUTS_VOZ)
        except (TimedOut, NetworkError) as e:
            # En PTB, BadRequest ES un NetworkError: ese no se arregla reintentando.
            if intento >= REINTENTOS_VOZ or isinstance(e, BadRequest):
                raise
            log.warning("voz de salida: intento %d fallo (%s); reintento", intento + 1, type(e).__name__)
            await asyncio.sleep(1)


class _UpdateQueAnota:
    """`update` envuelto: lo que se contesta por `effective_message` o
    `message` se anota. Todo lo demas pasa tal cual.
    WP-V: `por_voz` -- la persona hablo en audio, asi que se le contesta en audio."""

    def __init__(self, update, chat, por_voz=False):
        self._update = update
        self._chat = chat
        self._por_voz = por_voz

    def _usuario(self):
        q = getattr(self._update, "callback_query", None)
        return getattr(q, "from_user", None) if q is not None else getattr(self._update, "effective_user", None)

    @property
    def effective_message(self):
        return _MensajeQueAnota(self._update.effective_message, self._chat, self._por_voz, self._usuario())

    @property
    def message(self):
        m = self._update.message
        return _MensajeQueAnota(m, self._chat, self._por_voz, self._usuario()) if m is not None else None

    def __getattr__(self, nombre):
        return getattr(self._update, nombre)


# AQUI VIVIA `_pendiente`, y lo sustituye el borrador a medias de `_memoria`.
# Guardaba el TEXTO literal de la vuelta anterior y lo pegaba con un ". " al de
# la siguiente, para que el modelo volviera a leer las dos frases juntas. O sea
# que cada vuelta re-extraia todo desde cero y podia cambiar de opinion sobre un
# campo que nadie habia vuelto a mencionar: contestar "de gasolina" despues de
# "gaste 340" podia acabar en un monto distinto, porque el modelo leia una frase
# nueva y no un hueco que llenar. Ahora lo que sobrevive entre vueltas son los
# CAMPOS ya extraidos (`estado='incompleto'`, y **sin sello**, que es lo que los
# distingue de un borrador de verdad), y el mensaje nuevo solo los completa.
_esperando_monto = {}
# Igual que `_esperando_monto`, pero para el codigo de un lote: el boton
# "Otro codigo" abre la captura y el siguiente texto ES el codigo, sin pasar
# por el modelo.
_esperando_codigo = {}
# Igual, pero para la vigencia de una cotizacion: el boton "Cambiar
# vigencia" abre la captura y el siguiente texto ES el numero de dias.
_esperando_vigencia = {}
# Fase 5. Que campo se esta corrigiendo de un movimiento ya escrito: "monto" o
# "desc". El siguiente texto ES el valor nuevo y **no pasa por el modelo**, por
# la misma razon que `_esperando_monto`: re-extraer la frase entera le daria al
# modelo licencia para cambiar campos que nadie toco -- y aqui lo que se toca es
# una fila que ya existe.
_esperando_correccion = {}
# Fase 5, Paso 5. Que dato del alta se esta esperando por texto: "nombre",
# "email" o el nombre de una columna de comision. El siguiente mensaje ES ese
# dato y **no pasa por el modelo**: volver a extraer la frase entera le daria
# licencia para cambiar la zona o el rol que ya se escogieron con boton, que son
# justo los dos que D9 saco del lenguaje natural a proposito.
_esperando_alta = {}
# Fase 9 (D92). Un envasado que se bloqueo por falta de empaque: la peticion
# del lote (tal cual se mando) y el envasado ya resuelto (ids) que devolvio el
# servidor. El siguiente texto ES la respuesta a "que paso? cuanto hay?" y **no
# pasa por el modelo**: se manda a `/api/bot/inventario/proponer`, que la lee
# contra los insumos de ESE envasado. Al confirmar la entrada, el envasado se
# vuelve a proponer solo.
_esperando_empaque = {}
# Las categorias que el servidor reporto en la ultima propuesta. Arranca con las
# del diccionario local y se actualiza sola: **la autoridad es la base**, esto
# es solo para que el extractor tenga el vocabulario completo la proxima vez.
_catalogo = list(CATEGORIAS_SEMILLA)
# Lo que se vende. **Arranca vacio y NO hay semilla local, a proposito**: un id
# de producto escrito en este archivo seria una segunda fuente de verdad que
# caduca sin avisar, y un id caducado que el modelo copiara se convertiria en un
# 422 ("ese producto ya no esta en el catalogo"), que es peor que el defecto que
# esto arregla. Los ids salen de la base o no salen.
_productos = []
_productos_leidos_en = 0.0
# Diez minutos. El catalogo son tres botellas y cambia una vez al ano; el TTL
# existe para que un alta nueva aparezca sola, no porque haga falta frescura.
TTL_PRODUCTOS = 600
# Los nombres de la cartera viva (Fase 2). Arranca VACIO a proposito: no hay
# una lista local de deudores que pudiera caducar. Hasta la primera respuesta
# del servidor, el extractor trabaja sin vocabulario y el servidor empata igual.
_deudores = []


# ─── D48 (Fase 6): EL BOT NO PROMETE NADA QUE VAYA A HACER DESPUES ──────────
#
# **Este es el peor defecto de toda la Fase 5, y no lo encontro una prueba: lo
# encontro Norman.** Transcripcion del 2026-09-19, textual:
#
#   Norman: tienes pensado Aplicar el envio como un gasto?
#   Bot:    Si, el envio se captura como gasto en Logistica_Envios, y no importa
#           en que orden lo hagas.
#   Bot:    Listo. Quedo escrita.
#   Norman: Y luego el gasto?, No lo has escrito o si?
#
# Medido contra `finanzas_ledger`: **no hay ninguna fila de $45.** El modelo
# estaba describiendo un sistema que creia conocer. No hay una sola linea en
# este repo que encole un gasto para escribirlo despues.
#
# ─── POR QUE NO BASTA CON ARREGLARLO EN EL PROMPT ───────────────────────────
# La regla 16 de `enrutador.py` se lo prohibe, y esa regla es la mitad correcta.
# Pero **un prompt se puede desobedecer y esto no.** Es el mismo criterio con el
# que ya se recorta `respuesta` a una linea y se valida `intencion` contra la
# lista cerrada: lo que viene del modelo se revisa aqui.
#
# ─── LA INVARIANTE QUE LO HACE BARATO ───────────────────────────────────────
# `respuesta` --el texto que REDACTA el modelo-- solo llega a pantalla por dos
# caminos, y **los dos son caminos donde no se escribio nada**: la guarda de
# confianza y `_responder_natural`. Las confirmaciones de verdad ("Listo. Quedo
# escrita") las redacta Python con cadenas fijas y no pasan por aqui.
#
# Asi que cualquier compromiso que aparezca en este texto es falso POR
# CONSTRUCCION, y no hay que adivinar si se cumplio: no se cumplio.
# **El presente de primera persona NO entra, y lo decidio una prueba.** La
# alternativa 3 decia `(lo|la|los|las) (capturo|registro|...)`, y eso mordia de
# mas: *"Ese gasto no lo he escrito. Dimelo y lo capturo."* --que es EXACTAMENTE
# la respuesta correcta-- quedaba reemplazada por `SIN_COLA`. "Lo capturo" no es
# una promesa: es un ofrecimiento en presente, y el bot lo cumple en el mismo
# turno. Lo que promete es el FUTURO (`lo capturare`, `voy a capturar`) o el
# aplazamiento (`ahorita lo`, `despues`). Un filtro que se come la respuesta
# buena no protege nada: solo cambia un defecto por otro.
_PROMESA = re.compile(
    r"\bse (captura|registra|guarda|escribe|aplica|anota|mete)n?\b"
    r"|\bqued(a|an) (registrad|guardad|escrit|capturad|anotad|aplicad)"
    r"|\b(lo|la|los|las) (capturare|registrare|escribire|guardare|aplicare|anotare|metere)\b"
    r"|\bvoy a (capturar|registrar|escribir|guardar|aplicar|anotar|meter)\b"
    r"|\bahorita (lo|la|los|las)\b"
    r"|\bno importa en que orden\b",
    re.IGNORECASE)

# Lo que se dice en su lugar. **Es la respuesta correcta mientras no exista una
# cola de verdad**: no lo hizo, y hay que dictarlo aparte.
SIN_COLA = ("Eso no lo he escrito, y no lo dejo encolado para despues: no tengo "
            "donde. Dictamelo aparte y lo capturo en el momento.")


def _sin_promesas(texto):
    """Devuelve el texto del modelo, o `SIN_COLA` si prometio algo.

    Se REEMPLAZA en vez de recortar: la promesa no es un adorno sobre una
    respuesta buena, es toda la respuesta, y dejarla a medias diria lo mismo.
    """
    limpio = str(texto or "").strip()
    if limpio and _PROMESA.search(limpio):
        log.warning("el modelo prometio una escritura futura; lo reemplace: %r", limpio)
        return SIN_COLA
    return limpio


# ─── D49 (Fase 6) -> D79 (Fase 8) ───────────────────────────────────────────
# Aqui vivian `_frase_de_hecho_suelto` y `_avisar_hecho_suelto`: el segundo
# hecho de un mensaje se DECIA ("tambien oi un gasto de $45, ese no lo
# escribi"). Norman pidio lo otro: que se proponga, cada uno con su VA. Desde la
# Fase 8 el enrutador devuelve la lista `hechos` y `_enrutar_y_despachar`
# propone uno por uno (`_despachar_hechos`), asi que no queda nada que avisar.
# Lo que si sigue diciendose: los hechos que pasan del tope (`MAX_HECHOS`) y los
# que se quedan en cola por una pregunta.


# ─── D50 (Fase 6): "EL MISMO CLIENTE" ───────────────────────────────────────
#
# Transcripcion del 2026-09-19:
#
#   Norman: Olvidalo, ahora cotizame por favor para **el mismo cliente** 35
#           grandes, 43 chicas y 25 mini.
#   Bot:    No tengo a "el mismo cliente" en la red. Es alguno de estos, o es
#           cliente nuevo?
#
# Tres mensajes antes habia cotizado a Aeropuerto. **El bot tenia el dato y lo
# tiro.**
#
# ─── EL VENCIMIENTO, Y POR QUE UNA HORA ─────────────────────────────────────
# Una cotizacion se dicta en minutos; una hora cubre de sobra una conversacion
# que se interrumpe por una llamada. Y es corto para lo que importa: que
# "el mismo cliente" del martes en la manana NO herede al Aeropuerto del lunes.
# Es el mismo criterio de `VIDA_DEL_BORRADOR` (media hora), con el doble de
# holgura porque aqui no hay dinero en juego todavia -- una cotizacion se
# ensena, se sella y se confirma antes de existir.
VIDA_DEL_CLIENTE = 3600

# Las formas de decir "ese, el de hace rato". **No incluye pronombres sueltos**
# ("el", "ella"): un "para el" suelto dentro de otra frase empataria de mas, y
# resolver callado un cliente equivocado manda la cotizacion al distribuidor que
# no era -- que es peor que preguntar.
_DICE_EL_MISMO = re.compile(
    r"^\s*(a|para|al|con)?\s*(el|la|los|las)?\s*mism[oa]s?"
    r"(\s+(cliente|distribuidor|local|lugar|de (antes|hace rato|siempre)))?\s*$"
    r"|^\s*(el|la)\s+(de\s+)?(antes|anterior|de hace rato)\s*$"
    r"|^\s*(a|para|con)\s+(el|ella|ellos|ellas)\s*$",
    re.IGNORECASE)

_ultimo_cliente = {}


def _dice_el_mismo(dicho):
    """True si el texto es una referencia al cliente anterior, no un nombre.

    D65 (Fase 7): las formas que el PROMPT le pide copiar al modelo
    (`FORMAS_DEL_MISMO`, regla 19) empatan SIEMPRE, salgan o no de la expresion
    regular: el productor y el consumidor leen la misma tupla.
    """
    limpio = str(dicho or "").strip()
    if not limpio:
        return False
    return limpio.lower() in FORMAS_DEL_MISMO or bool(_DICE_EL_MISMO.match(limpio))


def _recordar_cliente(chat, nombre):
    nombre = str(nombre or "").strip()
    if nombre:
        _ultimo_cliente[chat] = {"nombre": nombre, "en": time.time()}


def _cliente_recordado(chat):
    """El ultimo cliente cotizado en este chat, si no ha caducado."""
    dato = _ultimo_cliente.get(chat)
    if not isinstance(dato, dict):
        return ""
    if (time.time() - float(dato.get("en") or 0)) > VIDA_DEL_CLIENTE:
        _ultimo_cliente.pop(chat, None)
        return ""
    return str(dato.get("nombre") or "")


async def _responder_natural(update, ruta):
    """Contesta hablando cuando no hay nada que escribir todavia.

    Este es el reemplazo del mensaje de ayuda fijo que Norman llamo "muy
    cuadrado". La diferencia no es el tono: es que aqui el bot DICE QUE
    ENTENDIO. Un bot que contesta "no te entendi" cuando si entendio la mitad
    entrena a la gente a no volver a intentarlo.
    """
    intencion = ruta.get("intencion")
    # D27: **el modelo redacta, Python despacha.** El contrato del enrutador
    # gano un campo `respuesta` -- que DECIRLE a Norman, en segunda persona,
    # una linea -- y aqui se usa en vez de la cadena fija. No es reescribir el
    # bot: es un campo mas en un JSON que el modelo ya devolvia, y la misma
    # unica llamada al modelo.
    #
    # **Lo que NO cambia:** las confirmaciones de dinero, los montos y los
    # botones siguen siendo texto de Python. El modelo redacta la conversacion,
    # nunca la cifra.
    redactada = _sin_promesas(ruta.get("respuesta"))

    # `entendido` NO SALE A PANTALLA. NUNCA. (D26, 2026-09-19)
    # Es telemetria: `enrutador.py` se lo pide al modelo como "frase MUY corta
    # de lo que si entendiste", o sea el modelo reportandose a si mismo, EN
    # TERCERA PERSONA, *sobre* Norman. Publicarlo crudo produjo, literal:
    #   "anula el movimiento anterior" -> "quiere anular el movimiento anterior"
    #   "sii"                          -> "solo dijo que si, sin decir a que"
    # El bot no le hablaba a Norman: lo narraba ante un tercero que no existe.
    # Ademas la regla 3 del prompt del propio enrutador prohibe el eco
    # ("NUNCA le repitas de vuelta lo que ya entendiste. El ya lo dijo") y el
    # Python lo hacia igual, cinco veces.
    if intencion == "venta":
        # Desde la Fase 3 las ventas SI se guardan: aqui solo se llega si el
        # camino de la venta no logro proponer nada. Decirle "esa va por el POS"
        # seria mentirle sobre lo que el bot sabe hacer.
        aviso = "Dimela otra vez diciendo que producto y cuantas piezas."
    elif intencion == "lote":
        # Desde la Fase 3.3 los lotes SI se guardan. Aqui solo se llega si el
        # camino del lote no logro proponer nada.
        aviso = ("Dimelo otra vez diciendo cuanto chile entro y cuantos litros "
                 "y grados salieron.")
    elif intencion == "cotizacion":
        # Desde la Fase 4 las cotizaciones SI se guardan. Aqui solo se llega si
        # el camino de la cotizacion no logro proponer nada.
        aviso = "Dimela otra vez diciendo que producto y cuantas piezas."
    elif intencion == "reporte":
        aviso = "Todavia no tengo el reporte del dia. Por ahora: /ventas, /stock o /cartera."
    elif intencion == "consulta":
        aviso = ("Eso todavia no lo se consultar. Hoy puedo: inventario (cuantas botellas quedan), "
                 "gastos del mes, cartera, ventas, produccion y precios.")
    else:
        # Aqui caen `charla` y el "no entendi", que son justo los dos caminos
        # donde una cadena fija se siente un formulario. Si el modelo redacto
        # algo, habla el modelo.
        aviso = redactada or "No te entendi. Dime que hiciste o que quieres saber."

    await update.effective_message.reply_text(aviso)


def _propuesta_de_gasto(campos, catalogo):
    """Traduce los campos del enrutador al objeto que espera el servidor.

    La unica decision real es categoria contra categoria_nueva: si el nombre ya
    existe en el catalogo va como existente, y si no, como nueva. Se decide
    aqui y no en el prompt porque el catalogo es un hecho y no una opinion, y
    porque el servidor rechaza una "nueva" que ya existia.
    """
    categoria = campos.get("categoria")
    nombre = str(categoria).strip() if categoria else ""
    existente = None
    for c in catalogo:
        if str(c).strip().lower() == nombre.lower():
            existente = c
            break
    # El proveedor no tiene columna: va en el concepto si no venia ya ahi.
    descripcion, proveedor = campos.get("descripcion"), campos.get("proveedor")
    if proveedor and str(proveedor).lower() not in str(descripcion or "").lower():
        descripcion = "%s (%s)" % (descripcion, proveedor) if descripcion else proveedor
    return {
        "monto": campos.get("monto"),
        "categoria": existente,
        "categoria_nueva": None if (existente or not nombre) else nombre,
        "descripcion": descripcion,
        "fecha": campos.get("fecha"),
    }


async def _ensenar_gasto(update, chat, mensaje):
    dato = _memoria.get(chat)
    await _ensenar_propuesta(update, chat, _mensaje_con_cuenta(dato, mensaje), _teclado_gasto(dato))


def _mismo_monto(a, b):
    try:
        return float(a) == float(b)
    except (TypeError, ValueError):
        return False


def _dia_de(propuesta):
    """El dia de una propuesta. Sin fecha es hoy: es lo que entiende el enrutador
    (`dt.date.today()`) y lo que pone el servidor."""
    return str(propuesta.get("fecha") or dt.date.today().isoformat())[:10]


def _sin_ruido(x):
    return " ".join(str(x or "").lower().split())


def _mismo_gasto(propuesta, viva):
    """True si la propuesta viva parece ser este mismo gasto. Un falso positivo
    cuesta una pregunta; un falso negativo, escribirlo dos veces."""
    if _tipo_de(viva) != "gasto":
        return False
    otra = viva.get("propuesta") or {}
    if not _mismo_monto(otra.get("monto"), propuesta.get("monto")):
        return False
    if _dia_de(otra) != _dia_de(propuesta):
        return False
    a, b = _sin_ruido(propuesta.get("descripcion")), _sin_ruido(otra.get("descripcion"))
    return bool(a and b and (a in b or b in a))


def _mismo_abono(propuesta, id_deudor, nombre, viva):
    """Lo mismo para un abono: mismo monto, mismo dia y mismo deudor. El deudor se
    compara por uuid si los dos lo traen; si no, por el nombre dicho."""
    if _tipo_de(viva) != "abono":
        return False
    otra = viva.get("propuesta") or {}
    if not _mismo_monto(otra.get("monto"), propuesta.get("monto")):
        return False
    if _dia_de(otra) != _dia_de(propuesta):
        return False
    if id_deudor and viva.get("id_deudor"):
        return id_deudor == viva["id_deudor"]
    a, b = _sin_ruido(nombre), _sin_ruido(viva.get("nombre_deudor"))
    return bool(a and b and (a in b or b in a))


async def _preguntar_duplicado(update, chat, igual, que, dato):
    """Ya hay una viva que parece esta: no se agrega sin preguntar (S12)."""
    _memoria[chat] = dict(dato, tipo="duplicado_eligiendo", igual=igual["borrador_id"])
    await update.effective_message.reply_text(
        "Ya tengo pendiente " + _etiqueta_de(igual) + ", y esto parece lo mismo. "
        "No lo agregue. Es otro " + que + "?",
        reply_markup=_lista_de(chat, InlineKeyboardMarkup([
            [InlineKeyboardButton("Si, es otro: agregalo", callback_data="dup:si")],
            [InlineKeyboardButton("Es el mismo", callback_data="no:x")]])))


async def _proponer_gasto_directo(update, chat, propuesta, cuenta=None, sugeridas=None,
                                  ya_avisado=False, foto=None, de_vuelo=False):
    """Propone un gasto cuyos campos ya vienen resueltos por el enrutador.

    Es el mismo destino que `_proponer` -- la puerta sellada del servidor --
    pero sin volver a llamar al modelo, porque el enrutador ya leyo el mensaje.
    Ahorrar esa llamada es lo que hace que el bot conteste rapido, y la
    velocidad es parte de lo que Norman pidio: "Telegram tiene que ser lo mas
    conciso posible".

    `foto` es la que se pega a este borrador; nunca se toma sola de la cola en
    vuelo (lo decide `_foto_para_lo_dictado`). `de_vuelo` dice que no se leyo con
    este gasto: la propuesta lo avisa y trae el boton para despegarla.
    """
    igual = None if ya_avisado else next(
        (v for v in _pendientes_de(chat) if _mismo_gasto(propuesta, v)), None)
    if igual is not None:
        # S12: dos VA sobre lo mismo escriben dos filas. Se avisa ANTES de agregarlo.
        _sacar_de_vuelo(chat, foto)
        await _preguntar_duplicado(update, chat, igual, "gasto", {
            "propuesta": dict(propuesta), "cuenta": dict(cuenta or {}),
            "sugeridas": list(sugeridas or []), "foto": foto, "de_vuelo": de_vuelo})
        return True
    cuerpo = {"telegram_id": chat, "propuesta": propuesta,
              "contexto_bot": _contexto_para_base(cuenta, propuesta, sugeridas)}
    if (cuenta or {}).get("id_cuenta"):
        cuerpo["id_cuenta"] = cuenta["id_cuenta"]
    estado, r = _post("/api/bot/gasto/proponer", cuerpo)
    if estado != 200 or not r.get("ok"):
        await update.effective_message.reply_text(r.get("error", "No pude proponerlo."))
        return False

    cuentas = r.get("cuentas", [])
    _memoria[chat] = dict({
        "borrador_id": r["borrador_id"],
        "sello": r["sello"],
        "cuentas": cuentas,
        "id_cuenta": r.get("id_cuenta"),
        "categorias": r.get("categorias", list(_catalogo)),
        "propuesta": dict(propuesta),
        "sugeridas": list(sugeridas or []),
        "cuenta": dict(cuenta or {}),
    }, **_estado_de_cuenta(cuenta, cuentas))
    _refrescar_catalogo(r)
    mensaje = r["mensaje"]
    _sacar_de_vuelo(chat, foto)
    if _adjuntar_comprobante(chat, r["borrador_id"], foto, de_vuelo):
        mensaje = str(mensaje) + NL + NL + _pie_de_propuesta(1)
        if de_vuelo:
            mensaje += " Si no es de este gasto, toca Quitar la foto."
    await _ensenar_gasto(update, chat, mensaje)
    return True




# ===========================================================================
# FASE 3 — LA VENTA. El bot CAPTURA; el ERP cobra.
# ===========================================================================

def _bajar(ruta):
    """Baja un archivo de la app con el token del bot. Devuelve bytes o None.

    **La imagen del comprobante no se puede mandar como URL.** `sendPhoto` con
    una URL hace que los servidores de Telegram vayan a pedirla, y ellos no
    llevan el `x-bot-token`: recibirian un 401. Asi que el proceso la baja aqui
    y la sube como archivo. De paso, el comprobante nunca queda accesible desde
    fuera de esta maquina.
    """
    pet = urllib.request.Request(API + ruta, headers={"x-bot-token": TOKEN_API})
    try:
        with urllib.request.urlopen(pet, timeout=30) as r:
            return r.read()
    except Exception as e:
        log.warning("no pude bajar %s: %s", ruta, e)
        return None


def _renglones_de(campos):
    """Los renglones que dijo el enrutador, en la forma que espera la ruta.

    El enrutador devuelve `productos` como lista de `{producto, cantidad}`. Se
    acepta tambien la forma suelta (`producto` + `cantidad`) porque un mensaje
    de un solo renglon a veces sale asi. **La cantidad que falta es 1**: "vendi
    una plata de 750" y "vendi plata de 750" son la misma frase, y suponer 1 es
    el unico numero que no puede sorprender a nadie — se ensena antes del "va".
    """
    crudos = campos.get("productos")
    if not isinstance(crudos, list) or not crudos:
        if campos.get("producto"):
            crudos = [{"producto": campos.get("producto"),
                       "cantidad": campos.get("cantidad")}]
        else:
            return []
    renglones = []
    for c in crudos:
        if not isinstance(c, dict):
            # Una lista de puros nombres tambien se entiende.
            renglones.append({"producto": str(c), "cantidad": 1})
            continue
        cantidad = c.get("cantidad")
        try:
            cantidad = int(float(cantidad))
        except (TypeError, ValueError):
            cantidad = 1
        if cantidad <= 0:
            cantidad = 1
        # D36: el `id_producto` que escogio el modelo DE LA LISTA CERRADA. La
        # ruta lo sigue validando contra el catalogo leido de la base en ese
        # momento (422 si no esta), asi que esto no afloja nada: el modelo
        # ESCOGE de una lista, no INVENTA un producto.
        renglon = {"producto": c.get("producto") or c.get("nombre"),
                   "cantidad": cantidad}
        id_producto = str(c.get("id_producto") or "").strip()
        if id_producto:
            renglon["id_producto"] = id_producto
        renglones.append(renglon)
    # Un renglon con id vale aunque el nombre venga vacio: el id es el dato
    # fuerte y el nombre solo servia para buscarlo.
    return [r for r in renglones if r.get("producto") or r.get("id_producto")]


async def _proponer_venta(update, chat, peticion):
    """Manda la peticion a `/api/bot/venta/proponer` y ensena lo que salga.

    Devuelve True si atendio la venta (haya propuesto o haya preguntado).

    **La peticion completa se guarda en memoria.** Cuando un producto o el
    comprador salen ambiguos, el boton no manda un dato suelto: parcha ESTA
    peticion y se vuelve a proponer entera. Asi una venta de tres renglones con
    dos ambiguos se resuelve en dos botones, sin volver a dictarla y sin que el
    modelo vuelva a tocar nada.
    """
    peticion = dict(peticion)
    peticion["telegram_id"] = chat

    estado, r = _post("/api/bot/venta/proponer", peticion)
    log.info("venta propuesta: %s renglones -> %s",
             len(peticion.get("productos") or []), estado)

    if estado == 200 and r.get("hay_que_elegir"):
        campo = r.get("campo")
        opciones = r.get("opciones") or []
        _memoria[chat] = {
            "tipo": "venta_eligiendo",
            "peticion": peticion,
            "campo": campo,
            "indice": r.get("indice"),
            "opciones": opciones,
            "permite_publico": bool(r.get("permite_publico")),
        }
        if campo == "producto":
            teclado = _teclado_productos(opciones)
        else:
            teclado = _teclado_compradores(opciones, bool(r.get("permite_publico")))
        await update.effective_message.reply_text(
            r.get("mensaje", "Cual es?"), reply_markup=_lista_de(chat, teclado))
        return True

    if estado != 200 or not r.get("ok"):
        # 422 y 403 SI se dicen: llegamos aqui porque el enrutador lo leyo como
        # venta, y callarse dejaria a la persona sin saber por que no paso nada.
        await update.effective_message.reply_text(r.get("error", "No pude proponer la venta."))
        return True

    _memoria[chat] = {
        "tipo": "venta",
        "borrador_id": r["borrador_id"],
        "sello": r["sello"],
        "peticion": peticion,
        # Una cuenta de solo egresos no recibe: ni se ofrece (igual que en el abono).
        "cuentas": [c for c in r.get("cuentas") or [] if c.get("id") not in SOLO_EGRESOS],
        "id_cuenta": r.get("id_cuenta"),
        # La lista completa viaja con el borrador para que "Otro comprador" no
        # tenga que volver a preguntarle al servidor.
        "compradores": r.get("opciones") or [],
    }
    await _ensenar_propuesta(
        update, chat, r["mensaje"], _teclado_confirmar_venta(r["borrador_id"]))
    return True


async def _confirmar_venta(update, chat):
    """El "va" de una venta. Aqui tampoco hay LLM, y no puede haberlo: solo
    viajan `{telegram_id, borrador_id, sello}`. Ninguna fila."""
    dato = _memoria.get(chat)
    if not dato or dato.get("tipo") != "venta":
        await update.effective_message.reply_text("No tengo ninguna venta pendiente que escribir.")
        return
    estado, r = _post("/api/bot/venta/confirmar", {
        "telegram_id": chat,
        "borrador_id": dato["borrador_id"],
        "sello": dato["sello"],
    })
    log.info("venta confirmada: borrador=%s -> %s ticket=%s",
             dato["borrador_id"], estado, r.get("ticket_id"))

    if estado != 200 or not r.get("ok"):
        await update.effective_message.reply_text(r.get("error", "No pude escribir la venta."))
        return

    _memoria.pop(chat, None)
    if r.get("condicion_pago") == "CONCESION":
        aviso = "Listo. Quedo a deber " + "{:,.2f}".format(float(r.get("total") or 0)) + "."
    else:
        aviso = "Listo. Quedo escrita."
    await update.effective_message.reply_text(aviso)

    # ── FASE 1b: el comprobante llega solo ──────────────────────────────────
    # Va DESPUES del aviso y sin condicionarlo: la venta ya esta escrita, asi
    # que si la imagen falla no se puede deshacer nada y callarse la escritura
    # seria peor que quedarse sin foto. Por eso el fallo se dice aparte.
    ruta = r.get("ruta_imagen")
    if not ruta:
        return
    imagen = await asyncio.to_thread(_bajar, ruta)
    if not imagen:
        await update.effective_message.reply_text(
            "La venta quedo escrita; el comprobante no lo pude generar.")
        return
    try:
        await update.effective_message.reply_photo(
            photo=imagen, filename="ticket.png")
    except Exception as e:
        log.warning("no pude mandar el comprobante: %s", e)
        await update.effective_message.reply_text(
            "La venta quedo escrita; el comprobante no se pudo enviar.")



def _peticion_de_lote(campos):
    """Traduce los campos del enrutador a lo que espera `/api/bot/lote/proponer`.

    El enrutador devuelve `kg_chile` como campo suelto porque asi se dicta
    ("meti ocho kilos de chile"), pero la ruta trabaja contra el catalogo, asi
    que se convierte en un renglon de insumo como cualquier otro. Si el modelo
    ya puso el chile en `insumos`, el suelto NO se agrega: el servidor suma los
    repetidos —porque `lote_entradas` no deja dos filas del mismo insumo— y
    sumarlo aqui duplicaria los kilos sin que nadie lo pidiera.

    `botellas` sale sin formato a proposito. No se completa con 750 porque sea
    el mas comun: el formato decide cuantos mililitros salieron del lote, y la
    ruta pregunta cual es.
    """
    insumos = []
    crudos = campos.get("insumos")
    if isinstance(crudos, list):
        for c in crudos:
            if not isinstance(c, dict):
                continue
            nombre = c.get("insumo") or c.get("nombre")
            if nombre:
                insumos.append({"insumo": nombre, "cantidad": c.get("cantidad")})

    kg = campos.get("kg_chile")
    ya_hay_chile = any("chile" in str(i.get("insumo")).lower() for i in insumos)
    if kg not in (None, "", 0) and not ya_hay_chile:
        insumos.append({"insumo": "chile-guajillo", "cantidad": kg})

    tandas = []
    for t in (campos.get("tandas") or []):
        if isinstance(t, dict) and t.get("litros") not in (None, ""):
            tandas.append({"litros": t.get("litros"), "grado": t.get("grado")})

    envasado = []
    botellas = campos.get("botellas")
    if botellas not in (None, "", 0):
        linea = {"botellas": botellas}
        if campos.get("formato"):
            linea["formato"] = campos.get("formato")
        envasado.append(linea)

    propuesta = {"tandas": tandas}
    for campo in ("codigo_lote", "dias_fermentacion", "horas_fermentacion", "fecha_inicio",
                  "brix_chile", "brix_final"):
        if campos.get(campo) not in (None, ""):
            propuesta[campo] = campos.get(campo)

    return {"insumos": insumos, "envasado": envasado, "propuesta": propuesta}


def _lote_es_de_otro_camino(campos):
    """Lote v2, ronda 2 (H1). True si lo que leyo el modelo NO es abrir un lote
    nuevo: trae `codigo_lote` dictado ("agregale 5 kilos de ing-az al lote
    L-12-10.1") o algun insumo que no es de la plantilla (chile o aditivo 1).
    Entonces va al camino F0/D81 de `_proponer_lote`, que agrega al existente."""
    if campos.get("codigo_lote") not in (None, ""):
        return True
    propios = (str(lote_plantilla.plantilla().get("aditivo_1_sku") or "ing-az").lower(),)
    for c in (campos.get("insumos") or []):
        if not isinstance(c, dict):
            continue
        nombre = str(c.get("insumo") or c.get("nombre") or "").strip().lower()
        if nombre and "chile" not in nombre and nombre not in propios:
            return True
    return False


async def _proponer_lote(update, chat, peticion, auto=False):
    """Manda la peticion a `/api/bot/lote/proponer` y ensena lo que salga.

    Devuelve True si atendio el lote (haya propuesto o haya preguntado).

    Igual que en la venta, **la peticion completa se guarda en memoria**: los
    botones parchan ESTA peticion y se vuelve a proponer entera, sin que el
    modelo vuelva a tocar nada. Un lote con dos insumos ambiguos se resuelve en
    dos botones sin volver a dictarlo.
    """
    peticion = dict(peticion)
    peticion["telegram_id"] = chat

    estado, r = _post("/api/bot/lote/proponer", peticion)
    log.info("lote propuesto: %s insumos, %s envasado -> %s",
             len(peticion.get("insumos") or []),
             len(peticion.get("envasado") or []), estado)

    if estado == 200 and r.get("hay_que_elegir"):
        campo = r.get("campo")
        opciones = r.get("opciones") or []
        _memoria[chat] = {
            "tipo": "lote_eligiendo",
            "peticion": peticion,
            "campo": campo,
            "indice": r.get("indice"),
            "opciones": opciones,
        }
        teclado = _teclado_insumos(opciones) if campo == "insumo" else _teclado_formatos(opciones)
        await update.effective_message.reply_text(
            r.get("mensaje", "Cual es?"), reply_markup=_lista_de(chat, teclado))
        return True

    if estado == 200 and r.get("falta_empaque"):
        # D92: no hay propuesta ni VA. Se dice que falta y se pregunta que paso;
        # la respuesta la recoge `_manejar_texto` sin pasar por el modelo.
        _esperando_empaque[chat] = {
            "peticion": peticion,
            "envasado": r.get("envasado") or [],
        }
        await update.effective_message.reply_text(
            r.get("mensaje", "Me falta empaque registrado. Que paso?"))
        return True

    # Ronda 5 (B, Norman 2026-10-19): se RETIRO "envasado sin lote ofrece
    # abrirlo" (WP-7a). El envasado es diario y se registra sin lote.

    if estado != 200 or not r.get("ok"):
        # El 403 de "esto es de la matriz" y el 422 de un grado imposible SI se
        # dicen: llegamos aqui porque el enrutador lo leyo como lote, y callarse
        # dejaria a la persona creyendo que se guardo.
        await update.effective_message.reply_text(r.get("error", "No pude proponer el lote."))
        return True

    _memoria[chat] = {
        "tipo": "lote",
        "borrador_id": r["borrador_id"],
        "sello": r["sello"],
        "peticion": peticion,
        "codigo_lote": r.get("codigo_lote"),
    }
    if auto:
        # Lote v2: la persona YA confirmo el resumen de la plantilla (todo + la
        # fecha de hoy). No se le pide otro VA: se confirma de una vez. La
        # puerta de aprobacion del servidor sigue igual (TRABAJADOR espera).
        _memoria[chat]["mostrado"] = (r["borrador_id"], r["mensaje"], None)
        await _confirmar_lote(update, chat)
        return True
    await _ensenar_propuesta(
        update, chat, r["mensaje"], _teclado_confirmar_lote(r["borrador_id"]))
    return True


def _codigo_nuevo_lote():
    """Lote v2: el codigo L-DD-MM.N que le toca hoy (sincrona: va en un hilo)."""
    return lote_ciclo.codigo_nuevo(_post)


async def _confirmar_plantilla_lote(update, chat):
    """Lote v2: el Confirmar del resumen de la plantilla. Nada salio antes."""
    codigo = await asyncio.to_thread(_codigo_nuevo_lote)
    estado, campos, notas = lote_plantilla.preparar_confirmacion(chat, codigo)
    if estado is None:
        await update.effective_message.reply_text(campos)
        return
    if estado == "reconfirmar":
        await update.effective_message.reply_text(
            "Otro lote de hoy ya tomo ese codigo. Le toca " + str(codigo) + ". Revisalo otra vez:")
        await lote_plantilla.ensenar_resumen(update, campos)
        return
    peticion = _peticion_de_lote(campos)
    if notas:
        peticion["propuesta"]["notas"] = notas
    await _proponer_lote(update, chat, peticion, auto=True)


async def _confirmar_etapa_lote(update, chat):
    await lote_ciclo.confirmar_etapa(update, chat, _post, _memoria)


async def _confirmar_lote(update, chat):
    """El "va" de un lote. Viajan `{telegram_id, borrador_id, sello}` y nada mas.

    El resumen que se manda despues NO lo arma este archivo: viene en `mensaje`,
    y la ruta lo saco de `v_lote_rendimiento` DESPUES de escribir. Es la misma
    fila que Norman va a ver en la pantalla, no una copia calculada aparte
    (D-198).
    """
    dato = _memoria.get(chat)
    if not dato or dato.get("tipo") != "lote":
        await update.effective_message.reply_text("No tengo ningun lote pendiente que escribir.")
        return

    estado, r = _post("/api/bot/lote/confirmar", {
        "telegram_id": chat,
        "borrador_id": dato["borrador_id"],
        "sello": dato["sello"],
    })
    log.info("lote confirmado: borrador=%s -> %s id=%s",
             dato["borrador_id"], estado, r.get("id_lote"))

    if estado != 200 or not r.get("ok"):
        await update.effective_message.reply_text(r.get("error", "No pude escribir el lote."))
        return

    _memoria.pop(chat, None)
    if r.get("envasado_diario"):
        # Ronda 6 (auditoria r5): un envasado diario no es "el lote ." vacio;
        # el servidor ya dice "Listo. Envasado del dd/mm/aaaa: N de NNN ml".
        await update.effective_message.reply_text(
            r.get("mensaje") or "Listo. Quedo el envasado del dia, sin lote.")
        return
    aviso = "Listo. Quedo el lote " + str(r.get("codigo_lote") or "") + "."
    resumen = r.get("mensaje")
    if resumen:
        aviso = aviso + "\n\n" + resumen
    await update.effective_message.reply_text(aviso)

async def _proponer_entrada(update, chat, texto):
    """D92: la respuesta a "que paso? cuanto hay?" -> propuesta de entrada.

    Si el servidor no la entiende, lo dice y **se sigue esperando**: el
    envasado no se pierde por una frase mal dicha. Un "no"/"cancela" ya lo
    atrapo `_manejar_texto` antes de llegar aqui.
    """
    pendiente = _esperando_empaque.get(chat) or {}
    estado, r = _post("/api/bot/inventario/proponer", {
        "telegram_id": chat,
        "texto": texto,
        "envasado": pendiente.get("envasado") or [],
    })
    log.info("entrada de empaque propuesta -> %s ok=%s", estado, r.get("ok"))
    if estado == 200 and r.get("no_entendi"):
        await update.effective_message.reply_text(r.get("mensaje", "No te entendi."))
        return
    if estado != 200 or not r.get("ok"):
        _esperando_empaque.pop(chat, None)
        await update.effective_message.reply_text(
            r.get("error", "No pude proponer la entrada."))
        return
    _memoria[chat] = {
        "tipo": "entrada_insumo",
        "borrador_id": r["borrador_id"],
        "sello": r["sello"],
        "peticion_lote": pendiente.get("peticion"),
    }
    await _ensenar_propuesta(
        update, chat, r["mensaje"], _teclado_confirmar_entrada(r["borrador_id"]))


async def _confirmar_entrada(update, chat):
    """El VA de una entrada de empaque; despues, el envasado otra vez."""
    dato = _memoria.get(chat)
    if not dato or dato.get("tipo") != "entrada_insumo":
        await update.effective_message.reply_text("No tengo ninguna entrada pendiente que escribir.")
        return
    estado, r = _post("/api/bot/inventario/confirmar", {
        "telegram_id": chat,
        "borrador_id": dato["borrador_id"],
        "sello": dato["sello"],
    })
    log.info("entrada de empaque confirmada: borrador=%s -> %s filas=%s",
             dato["borrador_id"], estado, r.get("filas_inventario"))
    if estado != 200 or not r.get("ok"):
        await update.effective_message.reply_text(r.get("error", "No pude escribirlo."))
        return
    _memoria.pop(chat, None)
    _esperando_empaque.pop(chat, None)
    await update.effective_message.reply_text("Listo. " + str(r.get("mensaje") or ""))
    peticion = dato.get("peticion_lote")
    if not peticion:
        # Tras un reinicio la peticion del lote no sobrevive (vive en RAM).
        await update.effective_message.reply_text(
            "Ya no tengo el envasado que estaba esperando. Dictamelo otra vez.")
        return
    await _proponer_lote(update, chat, peticion)

# ===========================================================================
# FASE 4 - LA COTIZACION. Un precio por escrito que todavia no es una venta.
# ===========================================================================

# Los renglones de la ultima cotizacion propuesta en cada chat. Es lo que se
# vuelve a escalar cuando Norman pide un TOTAL en vez de cantidades (D51).
_ultima_cotizacion = {}

# Arriba de esto no se escala por chat: es el mismo tope que la venta y que la
# cotizacion (`TOPE_VENTA` en `lib/bot-venta.ts`). El servidor lo vuelve a
# aplicar -- esto solo evita el viaje.
TOPE_OBJETIVO = 500000


def _objetivo_que_no_sirve(campos):
    """El `monto_objetivo` que SI vino pero no se puede usar, tal cual; o None.

    D67 (Fase 7): `_monto_objetivo` devuelve 0 igual para "no lo pidio" que para
    "pidio -500", y la cotizacion salia sin escalar sin decir por que. Esto es
    la otra mitad: lo que vino y se tira, se dice. Ausente o vacio -> None.
    """
    crudo = campos.get("monto_objetivo")
    if crudo is None or (isinstance(crudo, str) and not crudo.strip()):
        return None
    return None if _monto_objetivo(campos) else str(crudo).strip()


def _monto_objetivo(campos):
    """El total al que Norman quiere acercar la cotizacion, o 0. **D51.**

    Devuelve 0 ante cualquier cosa rara en vez de lanzar: si el modelo manda
    basura aqui, el camino correcto es cotizar como siempre, no reventar.
    """
    crudo = campos.get("monto_objetivo")
    if crudo in (None, ""):
        return 0
    try:
        valor = float(str(crudo).replace("$", "").replace(",", "").strip())
    except (TypeError, ValueError):
        return 0
    if not (valor > 0) or valor > TOPE_OBJETIVO:
        return 0
    return valor


# ─── D55 (Fase 6): EL DESCUENTO VIAJA, NO SE CALCULA ────────────────────────
#
# Norman: *"en ocasiones vamos a poner promociones, mi pregunta es si las
# podemos meter por medio de este bot. Eso si me interesa."*
#
# Este proceso **no hace ni una cuenta**: recoge lo que `_normaliza_descuento`
# dejo pasar en `enrutador.py` y lo manda tal cual. Quien multiplica, quien
# resta y quien topa es la ruta (`lib/bot-descuento.ts` desde
# `venta/proponer` y `cotizacion/proponer`), y esta reparticion es la misma que
# ya rige el precio: **el bot dice cuanto, el servidor dice cuanto cuesta.**
def _descuento_dictado(campos):
    """El descuento que viene en los campos, o `None`."""
    dicho = campos.get("descuento")
    return dicho if isinstance(dicho, dict) and dicho else None


def _peticion_de_cotizacion(campos):
    """Traduce los campos del enrutador a lo que espera `/api/bot/cotizacion/proponer`.

    Los renglones se leen con `_renglones_de`, el mismo de la venta: una
    cotizacion y una venta dicen los productos exactamente igual, y dos lectores
    distintos del mismo "dos de 750" acabarian entendiendo cosas distintas.
    """
    peticion = {"productos": _renglones_de(campos), "propuesta": {}}
    cliente = campos.get("cliente") or campos.get("comprador")
    if cliente:
        peticion["cliente"] = cliente
    if campos.get("vigencia_dias") not in (None, ""):
        peticion["propuesta"]["vigencia_dias"] = campos.get("vigencia_dias")
    if campos.get("notas"):
        peticion["propuesta"]["notas"] = campos.get("notas")
    descuento = _descuento_dictado(campos)
    if descuento:
        peticion["propuesta"]["descuento"] = descuento
    return peticion


async def _proponer_cotizacion(update, chat, peticion):
    """Manda la peticion a `/api/bot/cotizacion/proponer` y ensena lo que salga.

    Devuelve True si atendio la cotizacion (haya propuesto o haya preguntado).
    Mismo patron que la venta y el lote: la peticion completa se guarda y los
    botones la parchan.
    """
    peticion = dict(peticion)
    peticion["telegram_id"] = chat

    estado, r = _post("/api/bot/cotizacion/proponer", peticion)
    log.info("cotizacion propuesta: %s renglones -> %s",
             len(peticion.get("productos") or []), estado)

    if estado == 200 and r.get("hay_que_elegir"):
        campo = r.get("campo")
        opciones = r.get("opciones") or []
        _memoria[chat] = {
            "tipo": "cotizacion_eligiendo",
            "peticion": peticion,
            "campo": campo,
            "indice": r.get("indice"),
            "opciones": opciones,
            "permite_prospecto": bool(r.get("permite_prospecto")),
            "nombre_dicho": r.get("nombre_dicho") or "",
        }
        if campo == "producto":
            teclado = _teclado_productos(opciones)
        else:
            teclado = _teclado_clientes(opciones, bool(r.get("permite_prospecto")),
                                        r.get("nombre_dicho") or "")
        await update.effective_message.reply_text(
            r.get("mensaje", "Cual es?"), reply_markup=_lista_de(chat, teclado))
        return True

    if estado != 200 or not r.get("ok"):
        await update.effective_message.reply_text(
            r.get("error", "No pude armar la cotizacion."))
        return True

    # D50/D51: lo que hace falta para entender el mensaje SIGUIENTE. El cliente,
    # para que "el mismo cliente" no vuelva a preguntarse; los renglones, para
    # que "una de unos 15 mil" tenga que escalar. Las dos cosas las tenia el bot
    # el 2026-09-19 y las dos las tiro.
    _recordar_cliente(chat, r.get("para_quien"))
    _ultima_cotizacion[chat] = [dict(x) for x in (peticion.get("productos") or [])]

    _memoria[chat] = {
        "tipo": "cotizacion",
        "borrador_id": r["borrador_id"],
        "sello": r["sello"],
        "peticion": peticion,
        "para_quien": r.get("para_quien"),
        # La lista completa viaja con el borrador para que "Otro cliente" no
        # tenga que volver a preguntarle al servidor.
        "clientes": r.get("clientes") or [],
    }
    await _ensenar_propuesta(
        update, chat, r["mensaje"], _teclado_confirmar_cotizacion(r["borrador_id"]))
    return True


async def _confirmar_cotizacion(update, chat):
    """El "va" de una cotizacion. Viajan `{telegram_id, borrador_id, sello}`.

    Igual que la venta, el documento llega solo despues (Fase 1b). Y por la
    misma razon se manda DESPUES del aviso y sin condicionarlo: la cotizacion ya
    quedo guardada, asi que un fallo de la imagen no se puede deshacer y
    callarse la escritura seria peor que quedarse sin foto.
    """
    dato = _memoria.get(chat)
    if not dato or dato.get("tipo") != "cotizacion":
        await update.effective_message.reply_text(
            "No tengo ninguna cotizacion pendiente que guardar.")
        return

    estado, r = _post("/api/bot/cotizacion/confirmar", {
        "telegram_id": chat,
        "borrador_id": dato["borrador_id"],
        "sello": dato["sello"],
    })
    log.info("cotizacion confirmada: borrador=%s -> %s folio=%s",
             dato["borrador_id"], estado, r.get("folio"))

    if estado != 200 or not r.get("ok"):
        await update.effective_message.reply_text(
            r.get("error", "No pude guardar la cotizacion."))
        return

    _memoria.pop(chat, None)
    await update.effective_message.reply_text(r.get("mensaje", "Listo."))

    ruta = r.get("ruta_imagen")
    if not ruta:
        return
    imagen = await asyncio.to_thread(_bajar, ruta)
    if not imagen:
        await update.effective_message.reply_text(
            "La cotizacion quedo guardada; el documento no lo pude generar.")
        return
    try:
        await update.effective_message.reply_photo(
            photo=imagen, filename="cotizacion.png")
    except Exception as e:
        log.warning("no pude mandar la cotizacion: %s", e)
        await update.effective_message.reply_text(
            "La cotizacion quedo guardada; el documento no se pudo enviar.")


def _recaptura_con(valores, campo, nuevo):
    """La fila corregida: la de siempre con UN campo cambiado.

    **La fecha se conserva**, y es la parte que importa. Una correccion que
    reescribe la fila con la fecha de HOY mueve el gasto de mes -- y de paso se
    regala ventana de edicion, porque la ventana se cuenta desde
    `fecha_movimiento`. Por eso `mensajeDeRecaptura` la ensena antes del "va":
    para que se pueda cazar ahi y no en el corte.

    2026-11-04: va el instante entero. `[:10]` era el dia en UTC: un gasto de las 21:00
    en Mexico ya es manana en UTC, y al corregirlo se iba al dia siguiente. Antes lo
    tapaba de casualidad que `new Date('AAAA-MM-DD')` restaba ese mismo dia.
    """
    valores = valores or {}
    propuesta = {
        "monto": valores.get("monto"),
        "categoria": valores.get("categoria"),
        "descripcion": valores.get("descripcion"),
        "fecha": valores.get("fecha") or None,
    }
    propuesta[campo] = nuevo
    return propuesta


async def _proponer_correccion_de_campo(update, chat, campo, nuevo):
    """Despacha la correccion de UN campo por el camino que le toca.

    El concepto es la unica columna que se EDITA de verdad (D6), y encima tiene
    que volver a pasar por el filtro fiscal en el servidor porque
    `v_pasivo_fiscal` lee ese texto. El monto y la categoria no se editan: se
    anula la fila y se escribe otra, en un solo "va".
    """
    dato = _memoria.get(chat) or {}
    elegido = dato.get("elegido") or {}
    if not elegido:
        await update.effective_message.reply_text(
            "Ya no tengo ese movimiento. Dime otra vez que quieres corregir.")
        return
    cuerpo = {
        "telegram_id": chat,
        "tabla": elegido.get("tabla"),
        "id_movimiento": elegido.get("id"),
    }
    if campo == "descripcion":
        cuerpo["modo"] = "editar_descripcion"
        cuerpo["descripcion_nueva"] = nuevo
    else:
        cuerpo["modo"] = "recapturar"
        cuerpo["recaptura"] = _recaptura_con(elegido.get("valores"), campo, nuevo)
    await _proponer_anulacion(update, chat, cuerpo, accion="corregir")


async def _proponer_alta(update, chat, cuerpo):
    """Paso 5. El alta de un distribuidor o un local, una pregunta a la vez.

    Este endpoint contesta VARIAS veces antes de dar un borrador, y cada
    respuesta resuelve UN hueco. Hay tres formas de respuesta y se distinguen
    solas:

      · `hay_que_elegir` con `opciones` .. lista cerrada -> botones.
      · `campo` sin `opciones` .......... hace falta un texto -> se pregunta y
                                          el siguiente mensaje ES la respuesta.
      · `borrador_id` ................... ya esta todo -> se ensena y se sella.

    El cuerpo se acumula en `_memoria[chat]["peticion"]` y se vuelve a mandar
    entero en cada vuelta. No se guarda a medias en el servidor: mientras no
    haya borrador, no hay nada escrito en ningun lado.
    """
    estado, r = _post("/api/bot/entidad/proponer", cuerpo)
    log.info("alta propuesta: campo=%s -> %s", r.get("campo"), estado)

    if estado != 200:
        await update.effective_message.reply_text(
            r.get("error", "No pude prepararlo. No cree nada."))
        return True

    # --- Hace falta escoger de una lista cerrada ---------------------------
    if r.get("hay_que_elegir"):
        opciones = r.get("opciones") or []
        if not opciones:
            await update.effective_message.reply_text(r.get("mensaje", "No hay de donde escoger."))
            return True
        _memoria[chat] = {"tipo": "alta_eligiendo",
                          "campo": r.get("campo"),
                          "peticion": dict(cuerpo),
                          "opciones": opciones}
        await update.effective_message.reply_text(
            r.get("mensaje", "Cual?"), reply_markup=_lista_de(chat, _teclado_alta(opciones)))
        return True

    # --- Hace falta un texto ----------------------------------------------
    if r.get("campo") and not r.get("borrador_id"):
        _memoria[chat] = {"tipo": "alta_eligiendo",
                          "campo": r.get("campo"),
                          "peticion": dict(cuerpo),
                          "opciones": []}
        _esperando_alta[chat] = r.get("campo")
        await update.effective_message.reply_text(r.get("mensaje", "Que dato falta?"))
        return True

    if not r.get("ok") or not r.get("borrador_id"):
        await update.effective_message.reply_text(
            r.get("error", "No pude prepararlo. No cree nada."))
        return True

    _memoria[chat] = {"tipo": "alta",
                      "borrador_id": r["borrador_id"],
                      "sello": r["sello"],
                      "peticion": dict(cuerpo)}
    await _ensenar_propuesta(
        update, chat, r["mensaje"], _teclado_confirmar_alta(r["borrador_id"]))
    return True


async def _confirmar_alta(update, chat):
    """El "va" del alta. Viajan `{telegram_id, borrador_id, sello}` y nada mas.

    La contrasena viene en la RESPUESTA, no en el borrador: se genera al crear
    la cuenta y se ensena una vez. Por eso este mensaje no se puede volver a
    pedir -- y por eso se manda tal cual lo mando el servidor, sin recortarlo.
    """
    dato = _memoria.get(chat)
    if not dato or dato.get("tipo") != "alta":
        await update.effective_message.reply_text("No tengo ninguna alta pendiente.")
        return
    estado, r = _post("/api/bot/entidad/confirmar", {
        "telegram_id": chat,
        "borrador_id": dato["borrador_id"],
        "sello": dato["sello"],
    })
    log.info("alta confirmada: borrador=%s -> %s", dato["borrador_id"], estado)
    if estado == 200 and r.get("ok"):
        _memoria.pop(chat, None)
        _esperando_alta.pop(chat, None)
        await update.effective_message.reply_text(r.get("mensaje", "Listo, quedo dado de alta."))
    else:
        await update.effective_message.reply_text(r.get("error", "No pude darlo de alta."))


async def _proponer_conversion(update, chat, cuerpo):
    """Paso 6. Volver venta una cotizacion que ya existe.

    Misma mecanica que el alta: el endpoint pregunta lo que la cotizacion no
    sabe -- cual es, de contado o a consignacion, y a que cuenta entra -- y cada
    respuesta se acumula en el cuerpo.
    """
    estado, r = _post("/api/bot/convertir/proponer", cuerpo)
    log.info("conversion propuesta: campo=%s -> %s", r.get("campo"), estado)

    if estado == 200 and r.get("hay_que_elegir"):
        opciones = r.get("opciones") or []
        if not opciones:
            await update.effective_message.reply_text(r.get("mensaje", "No hay de donde escoger."))
            return True
        _memoria[chat] = {"tipo": "conversion_eligiendo",
                          "campo": r.get("campo"),
                          "peticion": dict(cuerpo),
                          "opciones": opciones}
        await update.effective_message.reply_text(
            r.get("mensaje", "Cual?"), reply_markup=_lista_de(chat, _teclado_conversion(opciones)))
        return True

    if estado != 200 or not r.get("ok"):
        mensaje = r.get("error", "No pude prepararlo. No escribi nada.")
        # Fuera de los 7 dias la cotizacion puede seguir siendo buena para el
        # cliente: lo que caduco es cerrarla a ciegas. Se dice la salida en vez
        # de dejar a la persona en un callejon.
        if r.get("ofrecer_recotizar"):
            mensaje = mensaje + NL + NL + 'Si quieres te la recotizo con los precios de hoy: dime "cotizale otra vez".'
        await update.effective_message.reply_text(mensaje)
        return True

    _memoria[chat] = {"tipo": "conversion",
                      "borrador_id": r["borrador_id"],
                      "sello": r["sello"],
                      "folio": r.get("folio"),
                      "peticion": dict(cuerpo)}
    await _ensenar_propuesta(
        update, chat, r["mensaje"], _teclado_confirmar_conversion(r["borrador_id"]))
    return True


async def _confirmar_conversion(update, chat):
    """El "va" de una conversion. Escribe la venta Y marca la cotizacion."""
    dato = _memoria.get(chat)
    if not dato or dato.get("tipo") != "conversion":
        await update.effective_message.reply_text("No tengo ninguna cotizacion pendiente de cerrar.")
        return
    estado, r = _post("/api/bot/convertir/confirmar", {
        "telegram_id": chat,
        "borrador_id": dato["borrador_id"],
        "sello": dato["sello"],
    })
    log.info("conversion confirmada: borrador=%s -> %s", dato["borrador_id"], estado)
    if estado == 200 and r.get("ok"):
        _memoria.pop(chat, None)
        await update.effective_message.reply_text(r.get("mensaje", "Listo, quedo vendida."))
    else:
        await update.effective_message.reply_text(r.get("error", "No pude convertirla."))


async def _proponer_anulacion(update, chat, cuerpo, accion="anular"):
    """Fase 5. La lista, o la propuesta sellada de lo que se va a tocar.

    Devuelve True si contesto algo. `accion` es lo que Norman pidio -- anular o
    corregir -- y solo sirve para saber que preguntar despues de que escoja la
    fila; lo que de verdad se va a hacer lo decide el `modo` que viaja al
    servidor y queda dentro del sello.
    """
    # `accion` viaja SOLO para que el servidor escoja el verbo de la pregunta:
    # con /corregir la lista decia "Cual anulo?", que es justo la palabra que
    # nadie quiere leer cuando lo que pidio fue arreglar un concepto. Lo que de
    # verdad se escribe lo decide `modo`, que va dentro del sello.
    cuerpo = dict(cuerpo)
    cuerpo["accion"] = accion
    estado, r = _post("/api/bot/anular/proponer", cuerpo)
    # D34: **cuando no hay modo, el log dice que no hay modo.** Decia
    # `modo=anular` con el valor por defecto puesto encima, y el primer paso
    # -- el que solo pide la lista de movimientos -- NO lleva modo. Esa linea
    # hizo creer a una auditoria que pedir una correccion proponia una
    # anulacion. No lo hace. Pero el log afirmo algo que no paso, que es la
    # misma clase de defecto que dejo correr 24 horas al proceso viejo: una
    # linea verdadera en su literal y falsa en lo que cualquiera concluye.
    log.info("anulacion propuesta: accion=%s modo=%s -> %s",
             accion, cuerpo.get("modo") or "(sin modo: solo la lista)", estado)

    if estado == 200 and r.get("hay_que_elegir"):
        opciones = r.get("opciones") or []
        if not opciones:
            await update.effective_message.reply_text(r.get("mensaje", "No encontre nada."))
            return True
        _memoria[chat] = {"tipo": "anulacion_eligiendo",
                          "accion": accion,
                          "opciones": opciones}
        await update.effective_message.reply_text(
            r.get("mensaje", "Cual?"), reply_markup=_lista_de(chat, _teclado_movimientos(opciones)))
        return True

    if estado != 200 or not r.get("ok"):
        await update.effective_message.reply_text(
            r.get("error", "No pude prepararlo. No toque nada."))
        return True

    _memoria[chat] = {
        "tipo": "anulacion",
        "accion": accion,
        "borrador_id": r["borrador_id"],
        "sello": r["sello"],
        "modo": r.get("modo") or "anular",
        "peticion": dict(cuerpo),
        "valores": r.get("valores"),
    }
    teclado = (_teclado_confirmar_anulacion(r["borrador_id"]) if accion == "anular"
               else _teclado_confirmar_correccion(r["borrador_id"]))
    await _ensenar_propuesta(update, chat, r["mensaje"], teclado)
    return True


async def _confirmar_anulacion(update, chat):
    """El "va" de una anulacion o de una correccion.

    Aqui tampoco hay LLM y no puede haberlo: viajan `{telegram_id, borrador_id,
    sello}` y nada mas. Cual fila se toca lo dice el borrador sellado.
    """
    dato = _memoria.get(chat)
    if not dato or dato.get("tipo") != "anulacion":
        await update.effective_message.reply_text("No tengo nada pendiente que anular.")
        return
    estado, r = _post("/api/bot/anular/confirmar", {
        "telegram_id": chat,
        "borrador_id": dato["borrador_id"],
        "sello": dato["sello"],
    })
    log.info("anulacion confirmada: borrador=%s modo=%s -> %s",
             dato["borrador_id"], dato.get("modo"), estado)
    if estado == 200 and r.get("ok"):
        _memoria.pop(chat, None)
        modo = r.get("modo") or "anular"
        if modo == "recapturar":
            await update.effective_message.reply_text(
                "Listo. Anule la vieja y escribi la corregida.")
        elif modo == "editar_descripcion":
            await update.effective_message.reply_text("Listo. Le cambie el concepto.")
        elif r.get("idTicket"):
            await update.effective_message.reply_text(
                "Listo. Quedo anulada la venta completa y el stock se devolvio.")
        else:
            await update.effective_message.reply_text("Listo. Quedo anulado.")
    else:
        await update.effective_message.reply_text(r.get("error", "No pude anularlo."))


# Las que ESCRIBEN. Sobre estas, dudar tiene precio: una fila de dinero o de
# inventario que despues hay que anular. Sobre `consulta`, `reporte` y `charla`
# una lectura equivocada se vuelve a preguntar y ya.
#
# ─── COMO SE MANTIENE SINCRONIZADA (D42, Fase 6) ─────────────────────────────
# **Esta lista tenia cinco y las que escriben eran nueve.** Faltaban `anular`,
# `corregir`, `alta` y `convertir`: las cuatro de la Fase 5, agregadas al
# despacho sin agregarse aqui. Con `confianza: baja` las cuatro esquivaban la
# guarda, y el auditor lo ejercito una por una el 2026-09-19.
#
# **La regla, en una linea: si el bloque `if intencion == "X"` de
# `_enrutar_y_despachar` llama a un `_proponer_*` o a `_confirmar`, entonces "X"
# va en esta tupla.** Lo que NO va: `consulta`, `reporte`, `charla` (solo leen)
# y `cancelar` (apaga un borrador que todavia no es una fila -- bloquearlo
# dejaria vivo lo que Norman acaba de rechazar, que es el fallo caro al reves).
#
# Y no se queda en la buena voluntad: `bot/probar_confianza.py` recorre las diez
# y falla en rojo si alguna escribe con `confianza: baja`.
INTENCIONES_QUE_ESCRIBEN = (
    "gasto", "abono", "venta", "lote", "cotizacion",
    # Fase 5. Escriben igual que las de arriba, aunque la fila la elija un boton.
    "anular", "corregir", "alta", "convertir",
    # 2026-11-03: agregar categoria/subcategoria (propone; escribe el clic de Norman).
    "categoria",
    # Y la que de verdad aprieta el gatillo: `confirmar` es el paso que convierte
    # el borrador sellado en INSERT. El sello protege el CONTENIDO -- el monto es
    # el que Norman vio en pantalla -- pero no protege el DISPARADOR.
    "confirmar",
)

# De estas se guarda lo que se alcanzo a entender para fundirlo con la respuesta.
# Las otras (`confirmar`, `anular`, `corregir`, `convertir`) **no traen campos
# que valga la pena recordar, y pisar `_memoria` con ellas seria un defecto**:
# ahi vive la propuesta sellada que esta en pantalla, y sobreescribirla con un
# borrador vacio la mataria justo cuando Norman iba a decir que va.
INTENCIONES_CON_BORRADOR = ("gasto", "abono", "venta", "lote", "cotizacion", "alta")


ETIQUETAS_DE_NOTA = ("lote", "persona", "cliente", "tema")


async def _guardar_nota(update, chat, campos):
    """Cazador F0 (WP-9a): "el lote 7 salio mas picoso" -> bitacora, y nada mas.

    El mensaje YA esta en la bitacora (lo anoto `bitacora.anotar_update` antes
    de llegar aqui); la nota solo le pone etiquetas a ESA fila, para poder
    buscarla despues por lote, persona o cliente. **Cero movimientos:** no hay
    `_post` a ninguna ruta del ERP, ni borrador, ni VA. Respuesta corta.
    """
    etiquetas = {"tipo": "nota"}
    for k in ETIQUETAS_DE_NOTA:
        v = campos.get(k)
        if v not in (None, "", [], {}):
            etiquetas[k] = str(v).strip()[:80]
    clave = bitacora.clave_de_update(update)
    guardada = bool(clave) and await asyncio.to_thread(bitacora.etiquetar, clave, etiquetas)
    log.info("nota: clave=%s etiquetas=%s -> %s", clave, etiquetas, guardada)
    sobre = ", ".join(str(etiquetas[k]) for k in ("lote", "persona", "cliente") if k in etiquetas)
    await update.effective_message.reply_text(
        ("Anotado" + (" (" + sobre + ")" if sobre else "") + ".") if guardada
        else "Lo tengo en el registro, pero no pude etiquetarlo; queda para revisarse.")


# ─── Cazador F0 (item 6): EL TOPE DE LA SUSCRIPCION ──────────────────────────
# Mientras `_pausa_hasta` este en el futuro, el modelo NO se llama: se contesta
# la hora y el mensaje se queda en la bitacora con `procesado=false`
# (`bitacora.EN_PAUSA`). Al volver, el primer mensaje avisa cuantos quedaron.
# En RAM: si el bot se reinicia en pausa, el primer mensaje vuelve a probar.
_pausa = {"hasta": None, "guardados": 0}


async def _en_pausa(update, hasta=None):
    """True si el bot esta en pausa (o acaba de entrar): contesta y encola."""
    if hasta is not None:
        _pausa["hasta"] = hasta
        log.warning("tope de la suscripcion: en pausa hasta %s", hasta)
    h = _pausa["hasta"]
    if h is None:
        return False
    if dt.datetime.now() >= h:
        _pausa["hasta"] = None
        if _pausa["guardados"]:
            n, _pausa["guardados"] = _pausa["guardados"], 0
            await update.effective_message.reply_text(
                "Ya regrese. %d mensaje%s de la pausa quedaron guardados sin procesar; "
                "repitemelos si siguen vigentes." % (n, "" if n == 1 else "s"))
        return False
    clave = bitacora.clave_de_update(update)
    if clave:
        bitacora.EN_PAUSA.add(clave)
    _pausa["guardados"] += 1
    await update.effective_message.reply_text(tope.texto_pausa(h))
    return True


def aviso_modelo_caido(error):
    """Lo que se le dice en el mismo chat cuando el modelo falla. **Pura.**"""
    comandos = ("Si corre prisa, /stock, /cartera, /ventas y /abono no pasan por el "
                "modelo y siguen funcionando.")
    if getattr(error, "causa", None) == CAUSA_LOGIN:
        return ("No pude leer ese mensaje: se vencio el login de Claude en la PC. "
                "Norman: hay que correr `claude login` ahi. No escribi nada y el mensaje "
                "quedo guardado sin procesar; cuando vuelva, dimelo otra vez. " + comandos)
    return ("No pude leer ese mensaje: se me cayo el modelo. No escribi nada y quedo "
            "guardado sin procesar. Dimelo otra vez. " + comandos)


async def _enrutar_y_despachar(update, chat, texto, esperando=""):
    """Ronda 5 (decision de Norman, 2026-10-19): la gente NO dicta temperatura;
    sale SOLO de Open-Meteo. Ya no hay interceptor de temperatura antes del
    modelo: si la mencionan con una plantilla o una etapa abierta, va a sus
    notas (`lote_plantilla` / `lote_ciclo`); si no, el mensaje sigue entero su
    camino normal."""
    await _enrutar_y_despachar_mensaje(update, chat, texto, esperando)


async def _enrutar_y_despachar_mensaje(update, chat, texto, esperando=""):
    """UNA llamada al modelo decide que quiso decir Norman, y se despacha.

    Antes esto era una cascada de tres intentos EN FILA -- gasto, abono,
    consulta -- asi que una pregunta pagaba tres llamadas al modelo antes de
    contestarse, y todo lo que no cayera en esas tres cajas terminaba en un
    mensaje de ayuda fijo.

    Ahora la intencion se decide una vez. Y como el enrutador ya extrajo los
    campos, un gasto completo tambien se resuelve en UNA llamada: antes era
    una, ahora sigue siendo una, y todo lo demas bajo de tres a una.

    **Y ya no hay cascada detras.** Se habia quedado de red cuando entro el
    enrutador, y era la decision equivocada: una red que vuelve a leer el mismo
    mensaje con OTRO prompt no es una red, es una segunda opinion -- y se activa
    justo cuando algo ya salio raro. La red de verdad son los comandos, que no
    pasan por ningun modelo y por lo tanto siguen de pie aunque el modelo no.

    El segundo argumento de `enrutar` es el BORRADOR A MEDIAS. Hasta el
    2026-09-19 era un `None` literal: el enrutador tenia sitio para los campos
    que ya se sabian y el bot nunca se los mandaba, asi que una captura a medias
    volvia a empezar de cero en cada vuelta.
    """
    # Auditoria IA 2026-10-17, E2 (item #4, aprobado 2026-10-19): PRIMERO
    # autorizacion, DESPUES datos. En privado `_puerta_de_grupo` deja pasar a
    # todos ("el servidor ya contesta"), pero el enrutador corre ANTES del
    # servidor y lleva al contexto la lista de deudores y el catalogo; en
    # `charla` el modelo redacta la respuesta. Un desconocido que encontrara el
    # bot por su nombre llegaba al modelo con la cartera adentro. Ahora, si no
    # esta dado de alta, se contesta fijo y no se llama al modelo.
    if not await _puerta_de_privado(update, chat):
        return

    # Cazador F0 (WP-7a): "hoy empezamos lote" y las respuestas a la plantilla
    # se leen SIN modelo (`bot/plantillas/lote.yaml`). Si el mensaje no es de
    # la plantilla, `atender` devuelve False y sigue el camino de siempre.
    if not esperando and await lote_ciclo.atender(update, chat, texto, _confirmar_etapa_lote, post=_post):
        return
    if not esperando and await lote_plantilla.atender(update, chat, texto, _proponer_lote, _peticion_de_lote,
                                                      codigo_nuevo=_codigo_nuevo_lote,
                                                      confirmar=_confirmar_plantilla_lote):
        return
    if await _en_pausa(update):
        return
    a_medias = _tomar_borrador_a_medias(chat)
    productos = await asyncio.to_thread(_catalogo_de_productos, chat)
    # D73 (Fase 8): el historial corto del chat viaja marcado como pasado.
    # D100 (Fase 9): en un grupo, el modelo sabe QUIEN le escribe.
    extra = {"hablante": _nombre_de(_persona(chat))} if _en_grupo(chat) else {}
    extra["cuentas"] = await asyncio.to_thread(_cuentas_vivas, chat)
    ok, ruta = await asyncio.to_thread(
        enrutar, texto, a_medias, list(_catalogo),
        _nombres_deudores(), productos, _en_pantalla(chat, esperando),
        historial_para_el_modelo(chat), **extra)

    if not ok and isinstance(ruta, tope.Tope):
        await _en_pausa(update, ruta.hasta)
        return
    if not ok:
        log.warning("el enrutador fallo: %s", ruta)
        # 2026-11-04: el fallo NO cuenta como atendido. `procesado` se queda en
        # false (la misma cola de la pausa) y el aviso dice lo que paso. Antes
        # `manejar_voz` lo marcaba `true` y la voz de las 10:02 se perdio.
        clave = bitacora.clave_de_update(update)
        if clave:
            bitacora.EN_PAUSA.add(clave)
        await update.effective_message.reply_text(aviso_modelo_caido(ruta))
        return

    # D33: **el texto crudo, junto a su enrutamiento.** Hasta hoy el log
    # guardaba la decision y nunca el mensaje, asi que no se podia construir un
    # conjunto de prueba a partir de la historia: la historia no existia. Sin
    # esto, "?comprende?" no se puede medir ni hoy ni dentro de un mes. Es su
    # bot, su maquina y sus propios mensajes.
    hechos = _hechos_de(ruta)
    log.info("enrutado como %s (confianza %s) | dijo: %r | entendido: %r | hechos: %s",
             ruta.get("intencion"), ruta.get("confianza"), texto,
             ruta.get("entendido"), [h.get("intencion") for h in hechos])
    intencion = ruta.get("intencion")
    campos = ruta.get("campos") or {}
    # Fase 9: en un grupo la gente platica entre si. La charla que no es para el
    # bot (ni lo contesta ni lo menciona) no se contesta.
    if _en_grupo(chat) and intencion == "charla" and not _le_hablan_al_bot(update):
        log.info("grupo %s: charla entre personas, no contesto", _chat_de(chat))
        return
    if reclama_ticket(texto, ruta):
        log.info("pedido de ticket que escapo de pide_ticket: %r", texto)
        await _mostrar_ticket(update, chat, texto)
        return
    if niega_tickets(texto, ruta):
        log.info("el modelo nego los tickets, corrijo: %r", ruta.get("respuesta"))
        await update.effective_message.reply_text(AVISO_SI_HAY_TICKETS)
        return

    # ── D30: LA CONFIANZA DEJA DE CALCULARSE PARA TIRARSE ───────────────────
    # `enrutador.py` la calcula y el unico lector era el log: **cero `if` sobre
    # `confianza` en todo el repo**. Con `baja`, el bot adivinaba y ejecutaba
    # igual -- una propuesta de DINERO REAL en pantalla con la misma cara que
    # si estuviera seguro, y el unico que supo que dudo fue el archivo de log.
    # **Preguntar bien es comprension; adivinar callado es lo contrario.**
    #
    # El borrador se guarda, asi que la respuesta se funde con lo que ya se
    # entendio en vez de empezar de cero.
    # ── D41 (Fase 6): LA GUARDA VA ARRIBA DEL DESPACHO, NO EN MEDIO ─────────
    # Este bloque estaba VEINTITRES LINEAS MAS ABAJO, debajo de los despachos de
    # `confirmar` y `cancelar`, **y los dos despachaban con `return`**. O sea que
    # la guarda existia y `confirmar` nunca llegaba a ella: un mensaje que el
    # modelo clasificara `confirmar` con `confianza: baja` disparaba el INSERT.
    #
    # No era un defecto de logica sino de COLOCACION, y por eso ninguna lectura
    # del `if` lo encontraba: el `if` estaba bien escrito y jamas se evaluaba.
    # Ahora nada se despacha antes de que la confianza se haya mirado.
    #
    # ── D63 (Fase 7): `confirmar` EXIGE `alta`, Y UN "SI" EXPLICITO ─────────
    # La guarda de abajo solo bloquea `baja`, y `media` no significaba nada:
    # medido el 2026-09-22 con el modelo real, 8 de 10 respuestas ambiguas
    # ("ok pues", "sale", "ahi va", "mmm va") salian `confirmar` con `alta`.
    # Proponer con `media` cuesta una pantalla; CONFIRMAR con `media` es una
    # fila de dinero que Norman no decidio. Por eso aqui van DOS llaves: lo que
    # dice el modelo (`alta`, regla 20) y lo que el bot comprueba solo, con la
    # MISMA lista (`es_afirmacion_explicita`). Con el PROMPT nuevo el modelo
    # todavia dio `alta` a "va pues?" y "ps va": la segunda llave es la que los
    # para. Las otras intenciones que escriben conservan la guarda de `baja`.
    if intencion == "confirmar" and not (
            ruta.get("confianza") == "alta" and es_afirmacion_explicita(texto)):
        log.info("confirmar con confianza %s sobre %r: pido el VA explicito",
                 ruta.get("confianza"), texto)
        await _pedir_va_explicito(update, chat)
        return

    # Fase 8: los HECHOS llevan su propia guarda, uno por uno
    # (`_despachar_hecho`): que el segundo dude no frena al primero.
    if (ruta.get("confianza") == "baja" and intencion in INTENCIONES_QUE_ESCRIBEN
            and not hechos):
        # Solo las que traen campos dejan borrador. Pisar `_memoria` con un
        # `confirmar` vacio mataria la propuesta sellada que esta en pantalla.
        if intencion in INTENCIONES_CON_BORRADOR:
            _recordar_a_medias(chat, intencion, campos)
        log.info("confianza baja sobre %s: pregunto antes de proponer", intencion)
        await update.effective_message.reply_text(
            ruta.get("pregunta")
            or _sin_promesas(ruta.get("respuesta"))
            or ("No acabo de entenderte, y esto escribe "
                + _COMO_SE_LLAMA.get(intencion, "un movimiento")
                + ". Me lo dices de otra forma?"))
        return

    # ── D28/D29: EL "SI" Y EL "NO" DE LO QUE HAY EN PANTALLA ────────────────
    # La lista literal de `manejar_texto` se queda -- cuesta cero llamadas al
    # modelo y es el camino rapido -- pero ya no es el unico. "ok", "sale",
    # "va pues", "andale", "ya quedo" y "simon" llegan hasta aqui, y ahora el
    # modelo los resuelve CON LA PROPUESTA A LA VISTA en vez de degradarlos a
    # charla. Esa es, exacta, la escena del "sii" del 2026-09-19.
    if intencion == "confirmar":
        await _confirmar(update, chat)
        return

    if intencion == "cancelar":
        # D40: "No nada olvidalo" tiene que CANCELAR de verdad. En la
        # transcripcion del 2026-09-19 el bot contesto el eco de `entendido`
        # ("quiere cancelar lo que estaba diciendo") **y ademas no cancelo
        # nada**: el mensaje siguiente cayo dentro de la misma cotizacion a
        # medias. Se entendio la intencion y no se ejecuto.
        #
        # **`cancelar` a proposito NO esta en `INTENCIONES_QUE_ESCRIBEN`**: no
        # escribe ninguna fila, apaga un borrador. Bloquearlo por dudar dejaria
        # vivo justo lo que Norman acaba de rechazar.
        lote_plantilla.olvidar(chat)  # WP-7a
        await _cancelar_lo_dicho(update, chat)
        return

    if intencion == "ajustar":
        await _ajustar(update, chat, ruta)
        return

    if intencion == "nota":
        await _guardar_nota(update, chat, campos)
        return

    if hechos:
        await _despachar_hechos(update, chat, ruta, hechos, completando=a_medias is not None)
        return

    if intencion == "anular":
        # FASE 5. El enrutador NO dice cual: lo dice la persona, con un boton,
        # contra una lista que arma el servidor (D2).
        await _proponer_anulacion(update, chat, {"telegram_id": chat}, accion="anular")
        return

    if intencion == "corregir":
        # FASE 5. Misma lista; lo que cambia es la pregunta de despues. Y
        # "corregir" casi nunca acaba en un UPDATE: acaba en anular y volver a
        # escribir, en un solo "va" (D6).
        await _proponer_anulacion(update, chat, {"telegram_id": chat}, accion="corregir")
        return

    if intencion == "alta":
        # PASO 5. El nombre es lo unico que el modelo aporta; la zona y el rol
        # NUNCA (D9), y las comisiones se preguntan una por una segun el rol.
        # Si ni el nombre vino, se pregunta por el y ya.
        nombre = (campos.get("nombre") or "").strip()
        if not nombre:
            _recordar_a_medias(chat, "alta", campos)
            await update.effective_message.reply_text(
                ruta.get("pregunta") or "Como se llama?")
            return
        peticion = {"telegram_id": chat, "nombre": nombre}
        if campos.get("email"):
            peticion["email"] = campos.get("email")
        if campos.get("telefono"):
            peticion["telefono"] = campos.get("telefono")
        await _proponer_alta(update, chat, peticion)
        return

    if intencion == "categoria":
        # 2026-11-03. El modelo solo aporta los dos nombres; la regla (que no
        # se repita, que una categoria nueva no dispare el pasivo fiscal) la
        # aplica el servidor, igual que en la pantalla.
        cat = str(campos.get("categoria") or "").strip()
        sub = str(campos.get("subcategoria") or "").strip()
        if not cat or not sub:
            _recordar_a_medias(chat, "categoria", campos)
            await update.effective_message.reply_text(
                ruta.get("pregunta") or ("En que categoria, y como se llama la subcategoria nueva?"
                                         if not cat else "Como se llama la subcategoria nueva?"))
            return
        tipo = "INGRESO" if str(campos.get("tipo") or "").upper() == "INGRESO" else "EGRESO"
        await _proponer_categoria(update, chat, {"telegram_id": chat, "tipo": tipo,
                                                 "categoria": cat, "subcategoria": sub})
        return

    if intencion == "convertir":
        # PASO 6. El folio, si lo dijo, solo sirve para no ensenar la lista; y
        # aun asi la fila se busca por id, no por folio dictado. Si no lo dijo,
        # se ensena la lista con botones, que es lo normal.
        await _proponer_conversion(update, chat, {"telegram_id": chat})
        return

    if intencion == "consulta":
        # `ruta["consulta"]` en vez de volver a clasificar con el modelo. Y el
        # filtro tal cual: quien lo prueba contra el producto y contra el punto
        # de venta es el servidor, no este proceso.
        if await _contestar_consulta(update, chat, ruta.get("consulta"), ruta.get("filtro")):
            return
        await _responder_natural(update, ruta)
        return

    await _responder_natural(update, ruta)




def _hechos_de(ruta):
    """La lista de hechos de una ruta. Si viene de un enrutador anterior a la
    Fase 8 (sin `hechos`), el hecho de arriba es una lista de uno."""
    hechos = ruta.get("hechos")
    if isinstance(hechos, list):
        return [h for h in hechos if isinstance(h, dict)]
    if ruta.get("intencion") in TIPOS_DE_HECHO:
        return [{"intencion": ruta.get("intencion"), "campos": ruta.get("campos") or {},
                 "faltantes": ruta.get("faltantes") or [], "pregunta": ruta.get("pregunta"),
                 "confianza": ruta.get("confianza")}]
    return []


def _esperando_respuesta(chat):
    """True si el bot le hizo una pregunta a Norman y la respuesta no ha llegado:
    una captura a medias, una lista con botones, o un dato por texto."""
    foco = dict.get(_memoria, chat)
    if isinstance(foco, dict) and not foco.get("borrador_id") and (
            foco.get("estado") == "incompleto"
            or str(foco.get("tipo") or "").endswith("_eligiendo")):
        return True
    return any(chat in d for d in (_esperando_monto, _esperando_codigo,
                                   _esperando_vigencia, _esperando_correccion,
                                   _esperando_alta, _esperando_empaque))


def _nombres_de_hechos(hechos):
    return ", ".join(_COMO_SE_LLAMA.get(str(h.get("intencion")), "algo") for h in hechos)


async def _despachar_hechos(update, chat, ruta, hechos, completando=False):
    """D79: CADA hecho del mensaje con su propia propuesta, su borrador y su VA.

    Los completos van primero (salen de una vez); los que traen `faltantes`
    despues, y de esos se pregunta UNA cosa a la vez: en cuanto el bot queda
    esperando una respuesta, lo que falta se queda en `_cola[chat]` y sigue
    solo cuando la respuesta llega (`_seguir_cola`).

    Un mensaje NUEVO (no la respuesta a una pregunta) suelta la cola del
    anterior, y lo dice. Su propuesta se suma a las que esperan VA (2026-11-04).
    """
    vieja = _cola.pop(chat, None)
    vigente = bool(vieja and (time.time() - vieja.get("en", 0)) <= VIDA_DEL_BORRADOR
                   and vieja.get("hechos"))
    restantes = []
    if vigente and completando:
        restantes = list(vieja["hechos"])
    elif vigente:
        await update.effective_message.reply_text(
            "Lo que quedaba por capturar (" + _nombres_de_hechos(vieja["hechos"])
            + ") lo deje: no lo escribi. Si va, dimelo otra vez.")

    # Completos primero; el orden de los incompletos es el dictado.
    ordenados = ([h for h in hechos if not h.get("faltantes")]
                 + [h for h in hechos if h.get("faltantes")])
    # La captura a medias (o la pregunta con botones) que habia en el foco ya
    # la leyo el modelo junto con este mensaje: el hecho nuevo la sustituye.
    foco = dict.get(_memoria, chat)
    if isinstance(foco, dict) and not foco.get("borrador_id"):
        _soltar_foco(chat)
    await _despachar_lista(update, chat, ordenados + restantes, ruta)

    de_mas = int(ruta.get("hechos_de_mas") or 0)
    if de_mas:
        await update.effective_message.reply_text(
            "Me dictaste mas de %d cosas en un mensaje. %s no la(s) tome: no las "
            "escribi. Dimelas aparte." % (MAX_HECHOS, "La ultima" if de_mas == 1
                                          else "Las ultimas %d" % de_mas))
    elif len(hechos) >= MAX_HECHOS:
        # El modelo tambien conoce el tope y a veces recorta EL: grabado el
        # 2026-09-22, seis gastos dictados salieron cinco y `hechos_de_mas` en 0
        # (la renta solo aparecia en su `respuesta`, que aqui no sale). El bot
        # no puede saber si hubo un sexto, asi que dice el tope.
        await update.effective_message.reply_text(
            "Tome %d cosas de ese mensaje, que es el tope. Si dictaste mas, esas no "
            "las tome ni las escribi: dimelas aparte." % MAX_HECHOS)


async def _despachar_lista(update, chat, hechos, ruta=None):
    for i, hecho in enumerate(hechos):
        if i > 0 and _esperando_respuesta(chat):
            _cola[chat] = {"hechos": list(hechos[i:]), "en": time.time()}
            await update.effective_message.reply_text(
                "Despues de eso sigo con " + _nombres_de_hechos(hechos[i:]) + ".")
            return
        foco = dict.get(_memoria, chat)
        if isinstance(foco, dict) and foco.get("borrador_id"):
            # La propuesta anterior se queda en el registro con su VA; el foco
            # se suelta para que la siguiente no se lea como su reemplazo.
            _soltar_foco(chat)
        await _despachar_hecho(update, chat, hecho, ruta if i == 0 else None)
    # Al terminar, el foco es la propuesta viva mas reciente.
    if dict.get(_memoria, chat) is None:
        vivos = _pendientes_de(chat)
        if vivos:
            dict.__setitem__(_memoria, chat, vivos[-1])


# Lo que sale de la cola se dicto ANTES: no es el gasto que la foto esta esperando.
_desde_cola = contextvars.ContextVar("desde_cola", default=False)


async def _seguir_cola(update, chat):
    """Si quedaron hechos en cola y el bot ya no espera respuesta, siguen."""
    cola = _cola.get(chat)
    if not cola:
        return
    if (time.time() - cola.get("en", 0)) > VIDA_DEL_BORRADOR:
        _cola.pop(chat, None)
        return
    if _esperando_respuesta(chat):
        return
    _cola.pop(chat, None)
    marca = _desde_cola.set(True)
    try:
        await _despachar_lista(update, chat, list(cola.get("hechos") or []), None)
    finally:
        _desde_cola.reset(marca)


async def _despachar_hecho(update, chat, hecho, ruta=None):
    """UN hecho: el mismo codigo por intencion de siempre (Fases 1 a 7).

    `ruta` solo viaja con el primer hecho: su `respuesta` la redacto el modelo
    para el mensaje entero, y repetirla en el segundo seria decirla dos veces.
    """
    intencion = hecho.get("intencion")
    campos = hecho.get("campos") or {}
    pregunta = hecho.get("pregunta")
    ruta = dict(ruta or {}, intencion=intencion)
    if hecho.get("confianza") == "baja":
        if intencion in INTENCIONES_CON_BORRADOR:
            _recordar_a_medias(chat, intencion, campos)
        log.info("confianza baja sobre %s: pregunto antes de proponer", intencion)
        await update.effective_message.reply_text(
            pregunta
            or _sin_promesas(ruta.get("respuesta"))
            or ("No acabo de entenderte, y esto escribe "
                + _COMO_SE_LLAMA.get(intencion, "un movimiento")
                + ". Me lo dices de otra forma?"))
        return

    if intencion == "gasto":
        # Si al enrutador le falto lo indispensable, se PREGUNTA una sola cosa
        # y se guarda el texto para juntarlo con la respuesta. Nada se inventa.
        if not campos.get("monto") or not campos.get("descripcion"):
            _recordar_a_medias(chat, "gasto", campos)
            await update.effective_message.reply_text(
                pregunta or "Cuanto fue?")
            return
        foto = _foto_para_lo_dictado(chat)
        await _proponer_gasto_directo(update, chat, _propuesta_de_gasto(campos, _catalogo),
                                      _cuenta_de_campos(campos), campos.get("categorias_sugeridas"),
                                      foto=foto, de_vuelo=bool(foto))
        return

    if intencion == "abono":
        # Lo indispensable de un abono es CUANTO. Por el deudor no se pregunta
        # aqui: el servidor lo empata contra la cartera viva y, si duda, manda
        # botones. Preguntar un nombre que se acaba de decir es de las cosas que
        # hacen que un bot se sienta cuadrado.
        if not campos.get("monto"):
            _recordar_a_medias(chat, "abono", campos)
            await update.effective_message.reply_text(
                pregunta or "De cuanto fue el abono?")
            return
        if await _proponer_abono(update, chat, _propuesta_de_abono(campos),
                                 nombre=campos.get("deudor"), cuenta=_cuenta_de_campos(campos)):
            return
        await _responder_natural(update, ruta)
        return

    if intencion == "venta":
        # FASE 3. Lo indispensable de una venta es QUE se vendio; el comprador
        # vacio en CONTADO es "publico en general", que es una venta legitima y
        # de todos los dias, asi que no se pregunta por el.
        renglones = _renglones_de(campos)
        if not renglones:
            _recordar_a_medias(chat, "venta", campos)
            await update.effective_message.reply_text(
                pregunta or "Que vendiste?")
            return
        peticion = {
            "productos": renglones,
            "propuesta": {
                "condicion_pago": campos.get("condicion_pago"),
                # Lo que dijo de monto NO se escribe: la ruta lo compara contra
                # el precio de lista y avisa si no cuadran. Ver `lib/bot-venta.ts`.
                "monto": campos.get("monto"),
            },
        }
        # D55: el descuento dictado. Va en `propuesta` y no en el cuerpo por la
        # misma razon que `monto`: es lo que DIJO la persona, no lo que el
        # servidor resolvio, y la ruta lo trata como tal.
        descuento = _descuento_dictado(campos)
        if descuento:
            peticion["propuesta"]["descuento"] = descuento
        if campos.get("comprador"):
            peticion["comprador"] = campos.get("comprador")
        if await _proponer_venta(update, chat, peticion):
            # D49: **la escena exacta del 2026-09-19.** La venta de $599 quedo
            # propuesta; el envio de $45 se decia aqui en vez de perderse.
            return
        await _responder_natural(update, ruta)
        return

    if intencion == "lote":
        # FASE 3.3. Lo indispensable de un lote es que algo haya entrado o
        # salido; el codigo lo propone el servidor y la fecha es hoy, asi que
        # por ninguno de los dos se pregunta.
        # Cazador F0 (WP-7a): si habia una plantilla a medias, lo que ya se
        # sabia se junta con lo que dijo el modelo (el modelo manda).
        notas_plantilla = ""
        # Ronda 5 (B): un ENVASADO es diario y no se liga al lote: no se junta
        # con una plantilla a medias (que sigue viva) ni abre una. Va solo al
        # servidor, que lo registra sin lote (el codigo dicho va a la nota).
        envasa = campos.get("botellas") not in (None, "", 0)
        viva = None if envasa else lote_plantilla.sesion(chat)
        if viva:
            campos = dict(lote_plantilla.campos_para_peticion(viva), **{
                k: v for k, v in campos.items() if v not in (None, "", [], {})})
            notas_plantilla = lote_plantilla.notas_de(viva)
            lote_plantilla.olvidar(chat)
        peticion = _peticion_de_lote(campos)
        if notas_plantilla:
            peticion["propuesta"]["notas"] = notas_plantilla
        if (viva or not _lote_es_de_otro_camino(campos)) \
                and not peticion["propuesta"]["tandas"] and not peticion["envasado"]:
            # Lote v2: ABRIR un lote (produccion) pasa por la plantilla: lo que
            # el modelo leyo la llena, se pregunta lo que falte y sale el
            # resumen con la fecha y Confirmar / Corregir. Nada se propone antes.
            # Ronda 2 (H1): con codigo de lote dictado o con insumos que no son
            # los de la plantilla, NO es un lote nuevo: va al camino F0/D81
            # (`_proponer_lote`: agregar a un lote existente), como en 24d1cbd.
            _recordar_a_medias(chat, "lote", campos)
            de_plantilla = {k: v for k, v in campos.items()
                            if k in lote_plantilla.NOMBRES_DE_CAMPO and v not in (None, "", [], {})}
            await lote_plantilla.atender(update, chat, "", _proponer_lote, _peticion_de_lote,
                                         desde_enrutador=de_plantilla,
                                         codigo_nuevo=_codigo_nuevo_lote,
                                         confirmar=_confirmar_plantilla_lote)
            return
        if await _proponer_lote(update, chat, peticion):
            return
        await _responder_natural(update, ruta)
        return

    if intencion == "cotizacion":
        # FASE 4. Lo indispensable es QUE se cotiza. Por el cliente no se
        # pregunta aqui: el servidor lo pregunta con botones, y entre ellos va
        # "es cliente nuevo", que es el caso normal de una cotizacion.
        peticion = _peticion_de_cotizacion(campos)

        # ── D51: LA COTIZACION POR MONTO OBJETIVO ───────────────────────────
        # *"ahora quiere una cotizacion cuyo total sea lo mas cercano a 15,000
        # pesos, manteniendo una proporcion semejante"* -> *"Que le cotizo?"*,
        # dos veces, la segunda ya con *"nose tu dimelo, haz las cuentas"*
        # enfrente. Norman creyo que habia sido exigente. No lo fue: los tres
        # precios estaban en la cotizacion que el bot acababa de emitir y la
        # operacion es una regla de tres.
        #
        # **Las cantidades las escala el SERVIDOR con los precios del catalogo**
        # (`escalarAObjetivo` en `lib/bot-cotizacion.ts`). Aqui solo se recupera
        # de que cotizacion se esta hablando. El modelo no pone ni un precio ni
        # una cantidad: pone el numero que Norman dijo, y ya.
        objetivo = _monto_objetivo(campos)
        # D67 (Fase 7): un objetivo que VINO y no sirve (0, negativo, texto) ya
        # no se tira callado. Se habla de la cotizacion anterior igual que con
        # uno bueno, asi que se reusa -- sin escalar -- y se DICE. Y el aviso no
        # promete lo que no va a pasar (regla 16): si no hay nada que cotizar,
        # no dice "te cotizo".
        malo = _objetivo_que_no_sirve(campos)
        if (objetivo or malo is not None) and not peticion["productos"]:
            anteriores = _ultima_cotizacion.get(chat)
            if anteriores:
                peticion["productos"] = [dict(p) for p in anteriores]
        if malo is not None:
            await update.effective_message.reply_text(
                "No entendi el monto objetivo (" + malo + ")."
                + (" Te cotizo sin escalar, o dime el monto." if peticion["productos"]
                   else " Dime el monto."))
        if objetivo and peticion["productos"]:
            peticion["objetivo"] = objetivo

        # ── D50: "EL MISMO CLIENTE" ─────────────────────────────────────────
        # Y cuando se resuelve por memoria, SE DICE. Resolver callado un cliente
        # equivocado manda la cotizacion al distribuidor que no era.
        aviso_cliente = ""
        recordado = _cliente_recordado(chat)
        if _dice_el_mismo(peticion.get("cliente")) and recordado:
            peticion["cliente"] = recordado
            aviso_cliente = "Para " + recordado + " (el ultimo que cotizaste)."
        elif objetivo and not peticion.get("cliente") and recordado:
            # Reescalar la cotizacion anterior es seguir hablando del MISMO
            # cliente. Preguntar por el aqui seria volver a pedir un dato que se
            # acaba de dar, que es de lo que Norman se queja cuando dice
            # "cuadrado". Se dice igual: nada se resuelve callado.
            peticion["cliente"] = recordado
            aviso_cliente = "Para " + recordado + " (el ultimo que cotizaste)."

        if not peticion["productos"]:
            _recordar_a_medias(chat, "cotizacion", campos)
            await update.effective_message.reply_text(
                pregunta or "Que le cotizo?")
            return
        if aviso_cliente:
            await update.effective_message.reply_text(aviso_cliente)
        if await _proponer_cotizacion(update, chat, peticion):
            return
        await _responder_natural(update, ruta)
        return

    await _responder_natural(update, ruta)


def _vacio(valor):
    return valor is None or valor == "" or valor == [] or valor == {}


async def _ajustar(update, chat, ruta, blanco_id=None):
    """D74: una correccion a lo que esta EN PANTALLA se SUMA, no empieza de cero.

    "fue venta a concesion" despues de proponer una venta: se toma la peticion
    de ESA propuesta, se le cambian SOLO los campos que dijo, y se vuelve a
    proponer. La propuesta vieja se apaga (`_reemplazando`). **El modelo no
    reescribe la venta: dice que campo cambia.**

    2026-11-04 (auditoria, S10): con dos o mas candidatas y sin reply no se toma la
    del foco: se pregunta cual, y el cambio espera en la pregunta. `blanco_id` es la
    respuesta a esa pregunta.
    """
    campos = dict(ruta.get("campos") or {})
    if ruta.get("confianza") == "baja":
        await update.effective_message.reply_text(
            ruta.get("pregunta") or "Que le cambio, exactamente?")
        return
    sobre = str(campos.pop("sobre", "") or "").strip().lower()
    # 2026-11-04: si contesta a una propuesta, el cambio es para esa.
    if await _contesta_a_muerta(update, chat):
        return
    candidatas = [d for d in _pendientes_de(chat) if not sobre or _tipo_de(d) == sobre]
    foco = _memoria.get(chat)
    nombrado = blanco_id or _borrador_del_reply(update, chat)
    blanco = (_pendientes.get(chat) or {}).get(nombrado)
    # La misma guarda que el "va" y el "no": contestar a un mensaje que no se ata a
    # ninguna propuesta no se lleva a la unica viva (T18, segunda auditoria).
    a_ciegas = not blanco_id and (nombrado == _ES_LA_PREGUNTA_CUAL
                                  or _contesta_a_ninguna(update, chat))
    if blanco is None and len(candidatas) == 1 and not a_ciegas:
        blanco = candidatas[0]
    if blanco is None and (len(candidatas) >= 2 or (candidatas and a_ciegas)):
        await _preguntar_cual_ajuste(update, chat, ruta, candidatas)
        return
    if blanco is None:
        if isinstance(foco, dict) and foco.get("estado") == "incompleto":
            # Una captura a medias: el cambio se suma a lo que ya se sabia.
            juntos = dict(foco.get("campos") or {})
            juntos.update({k: v for k, v in campos.items() if not _vacio(v)})
            _soltar_foco(chat)
            await _despachar_lista(update, chat, [{
                "intencion": foco.get("intencion"), "campos": juntos,
                "faltantes": [], "pregunta": None, "confianza": "alta"}], ruta)
            return
        await update.effective_message.reply_text(
            "No tengo ninguna propuesta viva a la que cambiarle eso. Dictamela completa.")
        return

    _enfocar(chat, blanco["borrador_id"])
    if blanco.get("rehidratado") and "propuesta" not in blanco:
        await update.effective_message.reply_text(
            "Esa propuesta la recupere de la base despues de un reinicio y no tengo "
            "su detalle para cambiarla. Cancelala y dictamela otra vez.")
        return
    with _reemplazando(chat, blanco["borrador_id"]):
        await _aplicar_ajuste(update, chat, blanco, campos)


async def _preguntar_cual_ajuste(update, chat, ruta, candidatas):
    """Dos o mas a las que les podria tocar el cambio: ninguna se toca a ciegas."""
    _memoria[chat] = {"tipo": "ajuste_eligiendo", "ruta": dict(ruta)}
    pid = dict.get(_memoria, chat)["_pid"]
    filas = [[InlineKeyboardButton(r[:60], callback_data="setaj:" + d["borrador_id"] + ":" + pid)]
             for d, r in zip(candidatas, _rotulos(candidatas))]
    filas.append([InlineKeyboardButton("Mejor no", callback_data="no:x:" + pid)])
    await update.effective_message.reply_text(
        "Tengo %d propuestas a las que les podria tocar ese cambio. A cual se lo hago?"
        % len(candidatas) if len(candidatas) > 1 else
        "No se a que propuesta contestas. Tengo esta esperando: se lo hago a ella?",
        reply_markup=InlineKeyboardMarkup(filas))


async def _aplicar_ajuste(update, chat, blanco, campos):
    tipo = _tipo_de(blanco)
    if tipo == "venta":
        peticion = dict(blanco.get("peticion") or {})
        propuesta = dict(peticion.get("propuesta") or {})
        for llave in ("condicion_pago", "monto"):
            if not _vacio(campos.get(llave)):
                propuesta[llave] = campos[llave]
        descuento = _descuento_dictado(campos)
        if descuento:
            propuesta["descuento"] = descuento
        peticion["propuesta"] = propuesta
        renglones = _renglones_de(campos)
        if renglones:
            peticion["productos"] = renglones
        if campos.get("comprador"):
            for llave in ("id_comprador", "publico"):
                peticion.pop(llave, None)
            peticion["comprador"] = campos["comprador"]
        cuenta = _sin_solo_egresos(chat, _cuenta_de_campos(campos))
        if cuenta.get("id_cuenta"):
            peticion["id_cuenta"] = cuenta["id_cuenta"]
        await _proponer_venta(update, chat, peticion)
        if cuenta and not cuenta.get("id_cuenta"):
            await update.effective_message.reply_text(
                "La cuenta no la cambie: " + _por_que_preguntamos({
                    "cuenta_oida": cuenta.get("oida"), "cuenta_solo_paga": cuenta.get("solo_paga")})
                + "Escogela con el boton Cambiar cuenta.")
    elif tipo == "gasto":
        cambios = {k: campos[k] for k in ("monto", "descripcion", "fecha")
                   if not _vacio(campos.get(k))}
        if campos.get("categoria"):
            p = _propuesta_de_gasto({"categoria": campos["categoria"]}, _catalogo)
            cambios["categoria"] = p["categoria"]
            cambios["categoria_nueva"] = p["categoria_nueva"]
        ajuste = {"propuesta": cambios}
        if campos.get("categorias_sugeridas"):
            ajuste["sugeridas"] = campos["categorias_sugeridas"]
        cuenta = _cuenta_de_campos(campos)
        if cuenta.get("id_cuenta"):
            ajuste["id_cuenta"] = cuenta["id_cuenta"]
        elif cuenta:
            ajuste["cuenta_duda"] = cuenta
        await _reproponer(update, chat, ajuste)
    elif tipo == "abono":
        propuesta = dict(blanco.get("propuesta") or {})
        for llave in ("monto", "metodo_pago", "fecha"):
            if not _vacio(campos.get(llave)):
                propuesta[llave] = campos[llave]
        cuenta = _sin_solo_egresos(chat, _cuenta_de_campos(campos) or blanco.get("cuenta") or {})
        if campos.get("deudor"):
            await _proponer_abono(update, chat, propuesta, nombre=campos["deudor"], cuenta=cuenta)
        else:
            await _proponer_abono(update, chat, propuesta, id_deudor=blanco.get("id_deudor"),
                                  cuenta=cuenta)
    elif tipo == "cotizacion":
        peticion = dict(blanco.get("peticion") or {})
        nueva = _peticion_de_cotizacion(campos)
        if nueva["productos"]:
            peticion["productos"] = nueva["productos"]
        if nueva.get("cliente"):
            for llave in ("id_comprador", "prospecto"):
                peticion.pop(llave, None)
            peticion["cliente"] = nueva["cliente"]
        propuesta = dict(peticion.get("propuesta") or {})
        propuesta.update(nueva["propuesta"])
        peticion["propuesta"] = propuesta
        await _proponer_cotizacion(update, chat, peticion)
    else:
        await update.effective_message.reply_text(
            "Eso no lo puedo cambiar asi. Cancela la propuesta y dictamela otra vez.")


async def manejar_texto(update, context):
    chat = _clave_de(update)
    texto = (update.message.text or "").strip()
    if not await _puerta_de_grupo(update, chat):
        return
    update = _UpdateQueAnota(update, chat)
    await asyncio.to_thread(_rehidratar, chat)
    try:
        if not await _quiza_registro(update, chat, texto):
            await _manejar_texto(update, chat, texto)
        # R1 (auditoria F0): procesado=true SOLO si el handler termino. Si revienta,
        # la fila se queda procesado=false (en la cola), no en el finally.
        await bitacora.marcar_procesado(update)
        await _seguir_cola(update, chat)
        await _avisar_aprobaciones(update)
    finally:
        _cerrar_turno(chat, texto)


async def _enfocar_espera(update, chat, espera):
    """Pone en el foco el borrador al que le corresponde el valor que acaba de
    llegar. Si ya no vive, lo dice y devuelve False: el valor no cae en otro."""
    if not isinstance(espera, str) or _enfocar(chat, espera):
        return True
    await update.effective_message.reply_text(YA_NO_ACTIVA)
    return False


async def _manejar_texto(update, chat, texto):
    # "va" escrito, no solo el boton: el usuario ocasional contesta como habla.
    if texto.lower() in ("va", "si", "sí", "correcto", "asi es", "dale"):
        await _confirmar(update, chat)
        return
    if texto.lower() in ("no", "cancela", "cancelar"):
        # D1: por texto el id no viene en la mano. Sale de la propuesta viva,
        # y se lee ANTES de que `_cancelar_de_verdad` limpie la memoria.
        await _cancelar_lo_dicho(update, chat)
        return

    # Corrigiendo el monto de una propuesta viva: entra el numero y se
    # repropone con ese campo cambiado. **No pasa por el modelo.**
    espera = _esperando_monto.pop(chat, False)
    if espera:
        limpio = texto.replace("$", "").replace(",", "").replace("pesos", "").strip()
        try:
            monto = float(limpio)
        except ValueError:
            # D31: **se ENRUTA en vez de regañar.** Estando en un estado
            # `_esperando_*` el modelo quedaba apagado y el bot era un
            # formulario: contestar "mejor cancela" a "De cuanto era? Solo el
            # numero" respondia "No lo lei como numero. Solo la cifra, por
            # favor." Eso es exactamente lo "cuadrado", y con nombre propio.
            # El camino rapido sigue existiendo para cuando el texto SI es el
            # dato; lo que cambia es el fallo.
            await update.message.chat.send_action("typing")
            await _enrutar_y_despachar(update, chat, texto,
                                       esperando="de cuanto era, solo el numero")
            return
        # 2026-11-04 (auditoria, S2): el valor cae en el borrador del boton que lo
        # pidio, no en lo que este en el foco cuando llegue.
        if not await _enfocar_espera(update, chat, espera):
            return
        dato = _memoria.get(chat) or {}
        if dato.get("tipo") == "abono":
            propuesta = dict(dato.get("propuesta") or {})
            propuesta["monto"] = monto
            # Se repropone con el MISMO deudor ya resuelto (por uuid), no con el
            # nombre: cambiar el monto no puede cambiar a quien se le abona.
            with _reemplazando(chat, dato.get("borrador_id")):
                await _proponer_abono(update, chat, propuesta,
                                      id_deudor=dato.get("id_deudor"), cuenta=dato.get("cuenta"))
            return
        await _reproponer(update, chat, {"propuesta": {"monto": monto}})
        return

    # Contestando una pregunta del alta: el correo, o una comision. **No pasa
    # por el modelo**, por la misma razon que el monto: si la frase se volviera
    # a extraer, el modelo podria "corregir" la zona o el rol que ya se
    # escogieron con boton, y esos dos salieron del lenguaje natural a proposito.
    campo_alta = _esperando_alta.pop(chat, None)
    if campo_alta:
        foco = _memoria.get(chat) or {}
        if foco.get("tipo") != "alta_eligiendo" and not _enfocar_pregunta(chat, "alta_eligiendo"):
            await update.message.reply_text("Ya no tengo esa alta. Empecemos otra vez.")
            return
        dato = _memoria.get(chat) or {}
        peticion = dict(dato.get("peticion") or {})
        peticion["telegram_id"] = chat
        if campo_alta.startswith("comision"):
            comisiones = dict(peticion.get("comisiones") or {})
            comisiones[campo_alta] = texto.replace("%", "").strip()
            peticion["comisiones"] = comisiones
        else:
            peticion[campo_alta] = texto.strip()
        await _proponer_alta(update, chat, peticion)
        return

    # Corrigiendo un movimiento YA ESCRITO: entra el valor nuevo y se propone
    # la correccion. **Tampoco pasa por el modelo.**
    cual = _esperando_correccion.pop(chat, None)
    if cual and (_memoria.get(chat) or {}).get("tipo") != "correccion_eligiendo":
        _enfocar_pregunta(chat, "correccion_eligiendo")
    if cual == "monto":
        limpio = texto.replace("$", "").replace(",", "").replace("pesos", "").strip()
        try:
            monto = float(limpio)
        except ValueError:
            # D31, igual que arriba: si no es el dato, se enruta.
            await update.message.chat.send_action("typing")
            await _enrutar_y_despachar(update, chat, texto,
                                       esperando="de cuanto era el movimiento que estas corrigiendo")
            return
        await _proponer_correccion_de_campo(update, chat, "monto", monto)
        return
    if cual == "desc":
        await _proponer_correccion_de_campo(update, chat, "descripcion", texto.strip())
        return

    # Cambiando el codigo de un lote vivo: entra el texto y se repropone con
    # ese campo cambiado. **Tampoco pasa por el modelo.**
    espera = _esperando_codigo.pop(chat, False)
    if espera:
        if not await _enfocar_espera(update, chat, espera):
            return
        dato = _memoria.get(chat) or {}
        peticion = dict(dato.get("peticion") or {})
        if not peticion:
            await update.message.reply_text("Ya no tengo ese lote. Dictamelo otra vez.")
            return
        propuesta = dict(peticion.get("propuesta") or {})
        propuesta["codigo_lote"] = texto.strip()
        peticion["propuesta"] = propuesta
        with _reemplazando(chat, dato.get("borrador_id")):
            await _proponer_lote(update, chat, peticion)
        return

    # Cambiando la vigencia de una cotizacion viva. **Tampoco pasa por el
    # modelo.** El tope de dias lo pone el servidor, no esta linea.
    espera = _esperando_vigencia.pop(chat, False)
    if espera:
        digitos = "".join(c for c in texto if c.isdigit())
        dias = int(digitos) if digitos else 0
        if dias <= 0:
            # D31, igual que el monto.
            await update.message.chat.send_action("typing")
            await _enrutar_y_despachar(update, chat, texto,
                                       esperando="cuantos dias de vigencia le pongo a la cotizacion")
            return
        if not await _enfocar_espera(update, chat, espera):
            return
        dato = _memoria.get(chat) or {}
        peticion = dict(dato.get("peticion") or {})
        if not peticion:
            await update.message.reply_text(
                "Ya no tengo esa cotizacion. Dictamela otra vez.")
            return
        propuesta = dict(peticion.get("propuesta") or {})
        propuesta["vigencia_dias"] = dias
        peticion["propuesta"] = propuesta
        with _reemplazando(chat, dato.get("borrador_id")):
            await _proponer_cotizacion(update, chat, peticion)
        return

    # D92: contestando "que paso con el empaque?". **No pasa por el modelo.**
    # Con la entrada ya propuesta, un texto nuevo ("no, llegaron 400") la
    # vuelve a proponer: sigue siendo la respuesta a la misma pregunta.
    foco_empaque = _memoria.get(chat) or {}
    if chat in _esperando_empaque and (not foco_empaque.get("borrador_id")
                                       or foco_empaque.get("tipo") == "entrada_insumo"):
        with _reemplazando(chat, foco_empaque.get("borrador_id")):
            await _proponer_entrada(update, chat, texto)
        return

    # 2026-11-03: "muestrame el ticket de la gasolina". No pasa por el modelo.
    if pide_ticket(texto) and (not _en_grupo(chat) or _MENCIONA_TICKET.search(comprobantes.plano(texto))):
        await _mostrar_ticket(update, chat, texto)
        return

    # Si veniamos preguntando un dato que faltaba, quien lo recoge es el
    # enrutador con el borrador a medias. Aqui ya no se pegan frases.
    await update.message.chat.send_action("typing")
    await _enrutar_y_despachar(update, chat, texto)


# 2026-10-21 (E-612, medido en bitacora + log): dos notas de voz de Norman
# (09:04 y 14:29) NO tuvieron respuesta. `get_file`/`download_to_drive` iban
# con el read_timeout por defecto de PTB (5 s); Telegram tardo mas, salto
# TimedOut, el manejador de errores lo clasifico "transitorio" y callo. La
# nota se perdio en silencio; Norman pregunto "Estas ahi?" en el grupo. Aqui:
# timeouts explicitos, UN reintento, y si no baja se le dice.
TIMEOUTS_DESCARGA = {"read_timeout": 60, "write_timeout": 60, "connect_timeout": 15, "pool_timeout": 15}
REINTENTOS_DESCARGA = 1
AVISO_VOZ_NO_BAJO = "No pude bajar tu nota de voz (Telegram no la entrego a tiempo). Mandala otra vez, o escribemelo."
# PTB atiende los mensajes en fila: una transcripcion colgada calla al bot entero.
TOPE_TRANSCRIPCION = 240
AVISO_VOZ_NO_TRANSCRIBIO = "No alcance a transcribir tu nota de voz. Mandala otra vez, o escribemelo."


async def _bajar_voz(bot, file_id, destino):
    """True si la nota quedo en `destino`. Solo reintenta errores de red."""
    for intento in range(REINTENTOS_DESCARGA + 1):
        try:
            archivo = await bot.get_file(file_id, **TIMEOUTS_DESCARGA)
            await archivo.download_to_drive(str(destino), **TIMEOUTS_DESCARGA)
            return True
        except BadRequest as e:  # es subclase de NetworkError: va ANTES, y no se reintenta
            log.warning("nota de voz: no se pudo bajar (%s): %s", type(e).__name__, e)
            return False
        except (NetworkError, TimedOut) as e:
            log.warning("nota de voz: intento %d de bajarla fallo (%s)", intento + 1, type(e).__name__)
        except Exception as e:
            log.warning("nota de voz: no se pudo bajar (%s): %s", type(e).__name__, e)
            return False
    return False


async def manejar_voz(update, context):
    chat = _clave_de(update)
    if not await _puerta_de_grupo(update, chat):
        return
    AUDIOS.mkdir(parents=True, exist_ok=True)
    destino = AUDIOS / ("tg_" + dt.datetime.now().strftime("%Y%m%d_%H%M%S") + ".ogg")
    if not await _bajar_voz(context.bot, update.message.voice.file_id, destino):
        await update.message.reply_text(AVISO_VOZ_NO_BAJO)
        return

    await update.message.chat.send_action("typing")
    from transcribir_nota import transcribir
    # El vocabulario VIVO: lo que el servidor ya declaro en esta sesion. Sin
    # esto Whisper llega a un nombre propio de la cartera sin haberlo oido
    # nunca. La lista se arma aqui y no en el transcriptor porque la autoridad
    # sobre que existe es del servidor, no del proceso del bot.
    # 2026-11-04: las cuentas y sus alias van PRIMERO y siempre, no solo si ya
    # habia una propuesta: son lo que Whisper deforma, y el vocabulario tiene tope.
    vocab = []
    for c in await asyncio.to_thread(_cuentas_vivas, chat):
        vocab += [c.get("nombre")] + alias_de(c)
    vocab += list(_catalogo)
    vocab += [d.get("nombre") for d in (_deudores or []) if isinstance(d, dict)]
    try:
        ok, texto = await asyncio.wait_for(asyncio.to_thread(transcribir, str(destino), [v for v in vocab if v]), TOPE_TRANSCRIPCION)
    except asyncio.TimeoutError:
        log.warning("nota de voz: la transcripcion paso de %d s", TOPE_TRANSCRIPCION)
        await update.message.reply_text(AVISO_VOZ_NO_TRANSCRIBIO)
        return
    if not ok:
        await update.message.reply_text(str(texto))
        return
    # Cazador F0 (WP-2a): la transcripcion, a la bitacora ANTES de procesarla.
    fila_tx = bitacora.fila_de_transcripcion(update.message, texto)
    await asyncio.to_thread(bitacora.anotar, fila_tx)
    await update.message.reply_text('Te entendi: "' + texto + '"')
    update = _UpdateQueAnota(update, chat, por_voz=True)  # WP-V: hablo en audio
    await asyncio.to_thread(_rehidratar, chat)

    # 1.b. **La voz entra por el mismo sitio que el texto.** Hasta el
    # 2026-09-19 esta linea llamaba a `_proponer`, o sea a la cascada vieja: una
    # nota de voz NUNCA llegaba al enrutador. Dictar "cotizale 20 cajas a
    # Delirio" no cotizaba nada -- se intentaba leer como gasto, fallaba; como
    # abono, fallaba; y contestaba el mensaje de ayuda. Todo lo que las fases 3 y
    # 4 agregaron existia solo para quien escribiera, y Norman dicta.
    try:
        # 2026-11-03: Norman dicta. "Muestrame el ticket" por voz es lo mismo que
        # por texto, y tampoco pasa por el modelo.
        if pide_ticket(texto) and (not _en_grupo(chat) or _MENCIONA_TICKET.search(comprobantes.plano(texto))):
            await _mostrar_ticket(update, chat, texto)
        else:
            await _enrutar_y_despachar(update, chat, texto)
        # R1 (auditoria F0): procesado=true SOLO si el handler termino. Si revienta,
        # la fila se queda procesado=false (en la cola), no en el finally.
        # Lote v2 (c): tambien la fila `:transcripcion`, que se quedaba en false.
        await bitacora.marcar_procesado(update, extra=[fila_tx.get("clave")])
        await _seguir_cola(update, chat)
        # Lote v2: un "confirmar" dictado de un TRABAJADOR tambien avisa al aprobador.
        await _avisar_aprobaciones(update)
    finally:
        _cerrar_turno(chat, texto)


# ===========================================================================
# 2026-11-03 -- LA FOTO DEL TICKET DE COMPRA (ejecutor del Socio, fotos).
# ===========================================================================
#
# Norman, por voz: "empezar a ponerle foto del ticket de compra, para tener todo
# en control, agregar al ERP las fotos... se puede hacer un OCR para leer toda
# la imagen, y en cuanto te pidamos que factures algo, pues ya lo facturas".
#
# El camino: foto -> se GUARDA en disco ya (`comprobantes.guardar_foto`) -> se
# lee con vision (`ocr_ticket.leer`, el mismo `claude -p` de minimo privilegio)
# -> el bot dice lo que leyo (texto armado por el codigo) -> propone el gasto
# por la MISMA puerta sellada que el texto (`_proponer_gasto_directo`) -> solo
# el clic de Norman lo escribe -> al escribirse, la foto queda ligada al
# `id_movimiento` (`_ligar_comprobante`), venga el clic por el VA de Norman o
# por su Aprobar a lo de otro.
#
# Los campos para pedir la factura despues (RFC, folio, URL de facturacion...)
# viajan en el indice local y, al ligarse, a la tabla `comprobantes_gasto`; la
# foto se comprime y va al bucket privado `tickets_gasto`. El disco queda de
# respaldo. `COMPROBANTES_EN_SUPABASE=0` apaga la subida.
COMPROBANTES_EN_SUPABASE = os.environ.get("COMPROBANTES_EN_SUPABASE", "1").strip().lower() in VALORES_SI
BOT_USUARIO_TG = os.environ.get("BOT_USUARIO_TG", "ERPFresnilloBot")
AVISO_FOTO_NO_BAJO = "No pude bajar tu foto (Telegram no la entrego a tiempo). Mandala otra vez."
AVISO_FOTO_EN_PAUSA = "La foto quedo guardada. Cuando regrese, mandala otra vez y la leo."
TOPE_FOTO = 10 * 1024 * 1024
VIDA_COMPROBANTE_EN_VUELO = 600
REINTENTOS_POR_SUBIDA = 5
# La foto normal va POR ID: `_proponer_gasto_directo(..., foto=clave)` la pega al
# borrador que acaba de sellar. Esto es solo para los TRES casos donde el gasto
# todavia no existe: el modelo no pudo leerla, no se leyo el total, o el ERP
# rechazo la propuesta. {clave de chat: [(clave de la foto, cuando), ...]}, la mas
# vieja primero, porque cada foto espera su propio gasto y la segunda no borra a
# la primera. Dura 10 minutos y la toma UN solo gasto, y solo uno DICTADO por esa
# misma persona (`_foto_para_lo_dictado`). La clave de chat ya separa a la gente
# dentro de un grupo. La propuesta lo dice antes del VA y trae "Quitar la foto".
_comprobante_en_vuelo = {}


def abreme_en_privado(bot=None):
    """El texto para quien nunca abrio chat privado con el bot (Telegram no deja
    que un bot le escriba primero a nadie). Sin cifras: va en el grupo."""
    try:
        usuario = getattr(bot, "username", None) or BOT_USUARIO_TG
    except Exception:  # PTB: un Bot sin initialize() lanza RuntimeError aqui
        usuario = BOT_USUARIO_TG
    return "\u00c1breme en privado una vez (t.me/" + str(usuario) + ") y me lo vuelves a pedir."


def aviso_ocr_fallo(error):
    """Lo que se dice en el chat cuando el modelo no leyo la foto. **Pura.**

    El texto del error NO sale aqui: es salida del CLI, y este mensaje tambien
    llega a un grupo. Ese texto, ya sin secretos, va al log y al indice."""
    causa = getattr(error, "causa", None)
    if causa == CAUSA_LOGIN:
        motivo = "se vencio el login de Claude en la PC. Norman: hay que correr `claude login` ahi."
    elif causa == enrutador.CAUSA_TIEMPO:
        motivo = "el modelo tardo demasiado."
    else:
        motivo = "se me cayo el modelo."
    return ("No pude leer el ticket: " + motivo + " La foto quedo guardada: dime el gasto "
            "en texto y se la pego.")


async def _bajar_foto(bot, file_id):
    """Los bytes de la foto, o None. Misma politica que la voz (E-612):
    timeouts explicitos y UN reintento de red."""
    for intento in range(REINTENTOS_DESCARGA + 1):
        try:
            archivo = await bot.get_file(file_id, **TIMEOUTS_DESCARGA)
            return bytes(await archivo.download_as_bytearray(**TIMEOUTS_DESCARGA))
        except BadRequest as e:  # subclase de NetworkError: va ANTES, y no se reintenta
            log.warning("foto: no se pudo bajar (%s): %s", type(e).__name__, e)
            return None
        except (NetworkError, TimedOut) as e:
            log.warning("foto: intento %d de bajarla fallo (%s)", intento + 1, type(e).__name__)
        except Exception as e:
            log.warning("foto: no se pudo bajar (%s): %s", type(e).__name__, e)
            return None
    return None


def _foto_del_mensaje(mensaje):
    """(file_id, file_unique_id, mime) de la foto MAS GRANDE, o de una imagen
    mandada como archivo (JPG/PNG/WEBP). None si no hay imagen. **Pura.**"""
    fotos = getattr(mensaje, "photo", None) or ()
    if fotos:
        f = fotos[-1]
        return f.file_id, getattr(f, "file_unique_id", None), "image/jpeg"
    doc = getattr(mensaje, "document", None)
    mime = str(getattr(doc, "mime_type", "") or "").lower()
    if doc is not None and mime in comprobantes.EXTENSION:
        return doc.file_id, getattr(doc, "file_unique_id", None), mime
    return None


def _pie_de_propuesta(fotos):
    return "Va con la foto del ticket." if fotos == 1 else "Va con las %d fotos del ticket." % fotos


def _foto_a_vuelo(chat, clave_foto, primero=False):
    """La foto se queda esperando su gasto. `primero`: la que el bot acaba de
    pedir que le completen ("cuanto fue?") va antes que las que ya esperaban."""
    _sacar_de_vuelo(chat, clave_foto)
    fotos = _comprobante_en_vuelo.setdefault(chat, [])
    fotos.insert(0 if primero else len(fotos), (clave_foto, time.time()))


def _foto_en_vuelo(chat):
    """La clave de la foto que lleva mas tiempo esperando su gasto en este chat, o
    None. No la saca: la saca quien de verdad la pegue a un borrador."""
    ahora = time.time()
    vivas = [f for f in _comprobante_en_vuelo.get(chat) or []
             if ahora - f[1] <= VIDA_COMPROBANTE_EN_VUELO]
    if not vivas:
        _comprobante_en_vuelo.pop(chat, None)
        return None
    _comprobante_en_vuelo[chat] = vivas
    return vivas[0][0]


def _sacar_de_vuelo(chat, clave_foto):
    """Saca ESA foto y ninguna otra."""
    quedan = [f for f in _comprobante_en_vuelo.get(chat) or [] if f[0] != clave_foto]
    if quedan:
        _comprobante_en_vuelo[chat] = quedan
    else:
        _comprobante_en_vuelo.pop(chat, None)


def _foto_para_lo_dictado(chat):
    """La foto que le toca a un gasto que esta persona acaba de dictar. Un hecho
    que sale de la cola se dicto antes de la foto: ese no se la lleva."""
    return None if _desde_cola.get() else _foto_en_vuelo(chat)


def _adjuntar_comprobante(chat, borrador_id, clave_foto, de_vuelo=False):
    """Pega la foto a ESE borrador (por id, nunca al foco). Devuelve la clave de
    la foto o None. Escribe solo en el indice LOCAL: el ERP no se toca hasta el
    clic."""
    if not clave_foto or not borrador_id:
        return None
    for dato in ((_pendientes.get(chat) or {}).get(borrador_id), dict.get(_memoria, chat)):
        if isinstance(dato, dict) and dato.get("borrador_id") == borrador_id:
            dato["comprobante"] = clave_foto
            if de_vuelo:
                dato["foto_de_vuelo"] = clave_foto
    try:
        comprobantes.anotar_borrador(clave_foto, borrador_id, de_vuelo)
    except Exception as e:
        log.warning("no pude anotar la foto %s con el borrador %s: %s", clave_foto, borrador_id, e)
        return None
    return clave_foto


async def _quitar_foto(update, chat, borrador_id):
    """Despega de la propuesta la foto que le llego en vuelo. La foto no se borra
    (es un ticket guardado) y no vuelve a volar: no se la lleva el gasto que sigue.
    Lee el indice y no la RAM: el boton sobrevive a un reinicio del bot."""
    clave = await asyncio.to_thread(comprobantes.foto_de_vuelo, borrador_id)
    if not clave:
        await update.effective_message.reply_text("Esa propuesta ya no trae foto por quitar.")
        return
    await asyncio.to_thread(comprobantes.despegar, clave, borrador_id)
    for dato in ((_pendientes.get(chat) or {}).get(borrador_id), dict.get(_memoria, chat)):
        if isinstance(dato, dict) and dato.get("borrador_id") == borrador_id:
            dato.pop("foto_de_vuelo", None)
            dato.pop("comprobante", None)
            mostrado = dato.get("mostrado")
            if mostrado:
                dato["mostrado"] = (mostrado[0], str(mostrado[1]).split(NL + NL + "Va con ")[0],
                                    _teclado_gasto(dato))
    await update.effective_message.reply_text(
        "Quite la foto de esta propuesta. Sigue guardada y este VA ya no la liga.")


def _subir_comprobante(clave_foto):
    """Con la bandera puesta: sube la foto ligada al ERP. Si falla, se queda en
    disco y `bot/subir_comprobantes.py` la sube despues. Nunca lanza. Cada fallo
    se cuenta: `pendientes_de_subir` pone atras a las que no suben."""
    try:
        cuerpo = comprobantes.cuerpo_para_subir(clave_foto)
        if cuerpo is None:
            error = "sin archivo o sin movimiento"
        else:
            estado, r = _post("/api/bot/comprobante/subir", cuerpo)
            if estado == 200 and isinstance(r, dict) and r.get("ok"):
                comprobantes.anotar_subido(clave_foto, r.get("ruta"))
                return True
            error = "%s: %s" % (estado, (r or {}).get("error"))
    except Exception as e:
        error = repr(e)
    log.warning("foto %s: no se subio: %s", clave_foto, enrutador._sin_secretos(error))
    try:
        comprobantes.anotar_fallo_subida(clave_foto, error)
    except Exception as e:
        log.warning("foto %s: no pude contar el fallo: %s", clave_foto, e)
    return False


def _ligar_comprobante(borrador_id, id_movimiento):
    """El gasto YA se escribio (clic de Norman): su foto, si traia, queda ligada
    al movimiento y se sube. Devuelve la frase para el mensaje de "Listo" ("" si
    no traia foto). Nunca lanza: el gasto ya esta escrito y eso no se deshace por
    un archivo."""
    try:
        fotos = comprobantes.ligar(borrador_id, id_movimiento)
    except Exception as e:
        log.warning("no pude ligar la foto del borrador %s: %s", borrador_id, e)
        return ""
    if not fotos:
        return ""
    log.info("fotos %s ligadas al movimiento %s", fotos, id_movimiento)
    pie = (" La foto del ticket quedo ligada al movimiento." if len(fotos) == 1
           else " Las %d fotos del ticket quedaron ligadas al movimiento." % len(fotos))
    if not COMPROBANTES_EN_SUPABASE:
        return pie
    if not all([_subir_comprobante(c) for c in fotos]):
        return pie + " No subio al ERP todavia: quedo en la PC y se reintenta."
    # Esta si subio, asi que el ERP esta de pie: se sube lo que quedo atras.
    for atrasada in comprobantes.pendientes_de_subir()[:REINTENTOS_POR_SUBIDA]:
        _subir_comprobante(atrasada)
    return pie


async def manejar_foto(update, context):
    """La foto de un ticket, en privado o en grupo, con o sin texto."""
    chat = _clave_de(update)
    if not await _puerta_de_grupo(update, chat):
        return
    if not await _puerta_de_privado(update, chat):
        return
    mensaje = update.message
    texto = str(getattr(mensaje, "caption", None) or "").strip()
    foto = _foto_del_mensaje(mensaje)
    if foto is None:
        await mensaje.reply_text("Esa imagen no la puedo leer. Mandala como foto (JPG o PNG).")
        return
    datos = await _bajar_foto(context.bot, foto[0])
    if not datos:
        await mensaje.reply_text(AVISO_FOTO_NO_BAJO)
        return
    if len(datos) > TOPE_FOTO:
        await mensaje.reply_text("Esa foto pesa mas de 10 MB. Mandala mas chica.")
        return
    update = _UpdateQueAnota(update, chat)
    try:
        # Revisar si ya existe depende del ERP; guardar la foto, no. Si la revision
        # falla, la foto se guarda: un aviso de duplicado perdido se corrige, un
        # ticket perdido no.
        try:
            previas = await asyncio.to_thread(comprobantes.previas, comprobantes.huella(datos), foto[1])
            if await _ticket_ya_existe(update, chat, previas):
                await bitacora.marcar_procesado(update)
                return
            for r in previas:
                _sacar_de_vuelo(_clave(r["chat_id"], r["telegram_id"]), r["clave"])
        except Exception as e:
            log.warning("foto: no pude revisar si ya existia: %s", enrutador._sin_secretos(repr(e)))
        clave_foto = await asyncio.to_thread(
            comprobantes.guardar_foto, datos, foto[2], _persona(chat), _chat_de(chat),
            texto or None, foto[1])
        log.info("foto %s de %s en %s (%d bytes)", clave_foto, _persona(chat), _chat_de(chat), len(datos))
        await asyncio.to_thread(_rehidratar, chat)
        with _hablando_de_ticket():
            await _leer_y_proponer_ticket(update, chat, clave_foto, datos, foto[2], texto)
        await bitacora.marcar_procesado(update)
        await _seguir_cola(update, chat)
        await _avisar_aprobaciones(update)
    finally:
        _cerrar_turno(chat, "[mando la foto de un ticket]" + ((" " + texto) if texto else ""))


async def _ticket_ya_existe(update, chat, previas):
    """True si esta misma foto ya se escribio o ya espera su VA o su Aprobar, y lo
    dice. Sin esto el mismo ticket mandado por otra persona, o despues de aprobado,
    eran dos gastos con dos VA. Sin cifras: esto tambien llega a un grupo. Una foto
    que no se leyo, que se cancelo o que se rechazo no cuenta: se vuelve a procesar."""
    for r in previas:
        tid = r["telegram_id"]
        await asyncio.to_thread(_identidad_de, tid)
        quien = "tu" if int(tid) == int(_persona(chat)) else _nombre_de(tid)
        if r.get("id_movimiento"):
            await update.effective_message.reply_text(
                "Ese ticket ya quedo escrito en el ERP (lo mando " + quien + "). No propuse nada. "
                "Si lo anularon, dictamelo en texto.")
            return True
        clave = _clave(r["chat_id"], tid)
        await asyncio.to_thread(_rehidratar, clave)
        vivos = set(d.get("borrador_id") for d in _pendientes_de(clave))
        if r.get("espera") or vivos.intersection(r.get("borradores") or ()):
            await update.effective_message.reply_text(
                "Ese ticket ya esta propuesto (lo mando " + quien + ") y sigue esperando su VA "
                "o el Aprobar de Norman. No lo agregue.")
            return True
    return False


async def _escribiendo(update):
    """El "escribiendo..." es cortesia: un TimedOut aqui no se traga la foto, que
    es como se perdieron las notas de voz de E-612. Solo se anota."""
    try:
        await update.effective_message.chat.send_action("typing")
    except Exception as e:
        log.warning("foto: send_action fallo (%s): %s", type(e).__name__, e)


async def _leer_y_proponer_ticket(update, chat, clave_foto, datos, mime, texto):
    decir = update.effective_message.reply_text
    # El modelo no se llama en pausa: es la misma regla del texto y la voz.
    if await _en_pausa(update):
        await decir(AVISO_FOTO_EN_PAUSA)
        return
    await _escribiendo(update)
    # El vocabulario vivo de categorias (categorias_movimiento), como el texto.
    await asyncio.to_thread(_catalogo_de_productos, chat)
    ok, t = await asyncio.to_thread(ocr_ticket.leer, datos, mime, texto, list(_catalogo))
    if not ok:
        await asyncio.to_thread(comprobantes.anotar_error, clave_foto, t)
        log.warning("foto %s: no se pudo leer: %s", clave_foto, enrutador._sin_secretos(t))
        if isinstance(t, tope.Tope):
            await _en_pausa(update, t.hasta)
            await decir(AVISO_FOTO_EN_PAUSA)
            return
        _foto_a_vuelo(chat, clave_foto)
        await decir(aviso_ocr_fallo(t))
        return
    await asyncio.to_thread(comprobantes.anotar_ocr, clave_foto, t)
    log.info("foto %s: es_ticket=%s monto=%s dudas=%d instrucciones=%s", clave_foto,
             t.get("es_ticket"), t.get("monto"), len(t.get("dudas") or []),
             t.get("trae_instrucciones"))
    if not t.get("es_ticket"):
        if _en_grupo(chat):
            return  # una foto cualquiera en el grupo no merece respuesta
        await decir("Esa foto no parece un ticket de compra. La guarde, pero no propuse "
                    "nada. Si es un gasto, dimelo en texto.")
        return
    await decir(ocr_ticket.resumen(t))
    if t.get("monto") is None:
        _foto_a_vuelo(chat, clave_foto, primero=True)
        _recordar_a_medias(chat, "gasto", {
            "descripcion": ocr_ticket.descripcion_para_el_ledger(t),
            "fecha": t.get("fecha"), "categoria": t.get("categoria"), "_de_ticket": True})
        await decir("No lei el total. Cuanto fue?")
        return
    if not await _proponer_gasto_directo(update, chat, ocr_ticket.propuesta_de_gasto(t),
                                         foto=clave_foto):
        _foto_a_vuelo(chat, clave_foto)


# El mensaje tiene que ABRIR con el pedido y seguir de inmediato con el ticket.
# La auditoria tumbo la version que buscaba las dos palabras en cualquier lugar: 9
# de 11 frases perdian su gasto ("gaste 340 de gasolina, quiero subir el ticket").
# La re-auditoria tumbo la lista corta de verbos: 12 de 19 pedidos reales caian al
# enrutador, y el modelo NEGABA tener la funcion. Y 7 capturas se tragaban: abrian
# con verbo de pedir ("mandame el ticket del diesel 1500 pesos efectivo").
_PIDE_TICKET = re.compile(
    r"^(?:(?:oye|hey|hola|buenas|este|bot|porfa|por favor|a ver)[, ]+)*"
    r"(?:muestrame|muestra|ensename|ensena|mandame|manda|pasame|pasa|reenviame|reenvia|enviame|envia"
    r"|dame|regresame|devuelveme|ver|quiero ver|quiero|necesito ver|necesito|ocupo|busca|buscame|dejame ver|a ver"
    r"|donde esta|donde estan|donde quedo|donde quedaron|tienes|me (?:muestras|ensenas|mandas|pasas|reenvias|envias|das)"
    r"|(?:me )?(?:puedes|podrias) (?:mostrar|ensenar|mandar|pasar|reenviar|enviar|buscar)(?:me)?)"
    r"\s+(?:(?:el|la|los|las|ese|esa|esos|este|esta|estos|mi|mis|ultimo|ultima|ultimos|todos|todas|otra vez)\s+)*"
    r"(?:foto\s+(?:del?\s+)?(?:(?:el|la|ese|este)\s+)?)?"
    r"(?:tickets?|comprobantes?|fotos?)\b(.*)$", re.S)
_OTRA_INTENCION = re.compile(
    r"\b(?:y|e|pero|como|gaste|gastamos|pague|pagamos|compre|compramos|registra\w*|anota\w*"
    r"|sube|subir|alta|factura\w*|saldo|cartera|stock|debe\w*|cuanto|cuantos|vend\w*"
    r"|fue|son|era|costo|salio|pago|cargue|cargo|meti|puse|efectivo|pesos|deposito|abono)\b"
    r"|\ba\s+\w+|\ben la (?:manana|tarde|noche)\b")
_CORTESIA = ("porfa", "por favor", "plis", "please", "gracias", "bot")
# "..., el de ayer": lo que sigue a la coma todavia dice cual ticket.
# "el ticket de 12345 pesos" busca por monto: ese "pesos" no es una captura. El de
# "el ticket de la gasolina 500 pesos" si: ahi el monto no viene justo despues.
_MONTO_BUSCADO = re.compile(r"^\s*(?:de|por)\s+\$?[\d.,]+\s+pesos\b")
_ACLARA_CUAL = re.compile(r"^(?:(?:el|la|los|las)\s+)?(?:de|del|ultimo|ultima)\b")


def _sigue_siendo_el_pedido(trozo):
    return not trozo or trozo in _CORTESIA or bool(_ACLARA_CUAL.match(trozo))


def pide_ticket(texto):
    """"muestrame el ticket del gasto de gasolina". **Pura.** No pasa por el
    modelo: buscar una foto no necesita criterio, y asi tampoco cambia el PROMPT.

    True SOLO si el mensaje no trae otra intencion: un gasto tragado aqui se pierde.
    En la duda es False y lo lee el enrutador. Un pedido que escape de aqui no se
    queda en la negativa del modelo: lo recoge `reclama_ticket`."""
    plano = comprobantes.plano(texto).strip(" \t\r\n¿¡")
    encontrado = _PIDE_TICKET.match(plano)
    if not encontrado:
        return False
    resto = encontrado.group(1)
    # La coma de "1,500" y el punto de "99.50" no separan nada.
    trozos = [t.strip() for t in re.split(r"[;:?!]+|[,.](?!\d)", resto)]
    if not all(_sigue_siendo_el_pedido(t) for t in trozos[1:]):
        return False
    return not _OTRA_INTENCION.search(_MONTO_BUSCADO.sub("", resto))


# Lo que escapa de `pide_ticket` llega al modelo, y el PROMPT no sabe de tickets:
# medido con el enrutador real, 9 de 12 formas contestaban "No puedo mostrarte
# tickets" o "No guardo tickets". "Se va al modelo" no era una salida segura.
_MENCIONA_TICKET = re.compile(r"\b(?:tickets?|comprobantes?)\b")
_VE_TICKET = re.compile(
    r"\b(?:muestrame|muestra|mostrar\w*|ensename|ensena|ensenar\w*|dame|mandame|pasame|reenviame"
    r"|regresame|devuelveme|veo|ver|busca|buscame|cual|donde|recuerdas|tienes)\b")
_PREGUNTA_AL_ERP = re.compile(r"\b(?:cuanto|cuantos|cuantas|saldo|cartera|debe\w*|stock|vend\w*)\b")
_NIEGA_TICKETS = re.compile(r"\bno (?:puedo|tengo|guardo|manejo|llevo|hay|cuento)\b[^.?!]{0,50}\b(?:tickets?|comprobantes?|fotos?)\b")
AVISO_SI_HAY_TICKETS = ("Si guardo las fotos de los tickets. Pidemelas con el monto, el proveedor "
                        "o el folio: \"muestrame el ticket de la gasolina\".")


def reclama_ticket(texto, ruta):
    """El modelo no tomo accion sobre un mensaje de tickets y si pide verlo. **Pura.**"""
    plano = comprobantes.plano(texto)
    return bool(_sin_hechos_de_ticket(plano, ruta) and _VE_TICKET.search(plano)
                and not _PREGUNTA_AL_ERP.search(plano))


def niega_tickets(texto, ruta):
    """El modelo dice que no hay tickets: es falso, y no lo va a decir el bot. **Pura.**"""
    return bool(_sin_hechos_de_ticket(comprobantes.plano(texto), ruta)
                and _NIEGA_TICKETS.search(comprobantes.plano(ruta.get("respuesta"))))


def _sin_hechos_de_ticket(plano, ruta):
    return (ruta.get("intencion") in ("charla", "consulta") and ruta.get("consulta") != "gastos" and not _hechos_de(ruta)
            and bool(_MENCIONA_TICKET.search(plano)))



def _pie_de_ticket(r):
    t = r.get("ticket") or {}
    f = t.get("factura") or {}
    piezas = []
    if f.get("folio"):
        piezas.append("Ticket " + str(f["folio"]))
    piezas.append(str(t.get("proveedor") or "proveedor sin leer"))
    if t.get("fecha"):
        piezas.append(str(t["fecha"]))
    if isinstance(t.get("monto"), (int, float)):
        piezas.append("$" + format(t["monto"], ",.2f"))
    lineas = [" | ".join(piezas)]
    if r.get("id_movimiento"):
        lineas.append("Ligado al movimiento " + str(r["id_movimiento"]))
    else:
        lineas.append("Todavia sin escribir en el ERP (no tiene el clic de Norman).")
    if f.get("rfc_emisor"):
        lineas.append("RFC " + str(f["rfc_emisor"]))
    if f.get("url_facturacion") and not t.get("trae_instrucciones"):
        lineas.append("Facturar en: " + str(f["url_facturacion"]))
    return NL.join(lineas)


async def _mostrar_ticket(update, chat, texto):
    """Reenvia la foto del ticket que mejor casa con `texto`. Solo la Matriz
    (ADMIN): los gastos son suyos. En grupo, por privado (trae cifras)."""
    decir = update.effective_message.reply_text
    ident = await asyncio.to_thread(_identidad_de, _persona(chat))
    if ident is None:
        await decir("No pude revisar quien eres (el ERP no contesto). No hice nada.")
        return
    if not ident.get("registrado"):
        await decir("No te tengo dado de alta. No hice nada.")
        return
    if ident.get("rol") != "ADMIN":
        await decir("Los tickets de gastos solo los ve la Matriz.")
        return
    encontrados, terminos = await asyncio.to_thread(comprobantes.buscar, texto)
    encontrados = [(p, r) for p, r in encontrados
                   if (r.get("ticket") or {}).get("es_ticket") or r.get("error")]
    if not encontrados:
        await decir("No encontre ese ticket. Dime el folio, el monto o el proveedor."
                    if terminos else "Todavia no tengo ningun ticket guardado.")
        return
    puntos, r = encontrados[0]
    pie = _pie_de_ticket(r)
    # Un ticket largo son varias fotos del mismo movimiento: van todas.
    hermanas = [x for _p, x in encontrados[1:]
                if r.get("id_movimiento") and x.get("id_movimiento") == r["id_movimiento"]]
    otros = [x for p, x in encontrados[1:]
             if p == puntos and not any(x is h for h in hermanas)][:4] if terminos else []
    if otros:
        pie += NL + NL + "Hay otros parecidos: " + "; ".join(
            _pie_de_ticket(x).split(NL)[0] for x in otros) + ". Dime el folio."
    destino = int(_persona(chat)) if _en_grupo(chat) else int(_chat_de(chat))
    for foto, leyenda in [(r, pie)] + [(h, _pie_de_ticket(h)) for h in hermanas]:
        ruta = comprobantes.ruta_de(foto)
        try:
            with open(ruta, "rb") as fh:
                datos = fh.read()
        except Exception as e:
            log.warning("ticket %s: no pude leer el archivo: %s", foto.get("clave"), e)
            await decir("Tengo el ticket anotado pero no encuentro la foto en disco.")
            return
        try:
            await update.get_bot().send_photo(destino, photo=datos, caption=leyenda[:1000],
                                              filename=foto.get("archivo") or "ticket.jpg")
        except Exception as e:
            log.warning("ticket %s: no lo pude mandar a %s: %s", foto.get("clave"), destino, e)
            if _en_grupo(chat):
                await decir(abreme_en_privado(update.get_bot()))
            else:
                await decir("No pude mandarte la foto del ticket. Intenta otra vez.")
            return
        log.info("ticket %s mandado a %s", foto.get("clave"), destino)
    if _en_grupo(chat):
        await decir("Te lo mande por privado.")


# ===========================================================================
# 2026-11-03 -- GRUPOS SILENCIOSOS ("Fresnillo - Equipo"): el bot escucha y
# no habla. La lista y la regla viven en `grupos_silenciosos.py`.
# ===========================================================================
def _datos_del_bot(update):
    try:
        bot = update.get_bot()
    except Exception:
        return BOT_USUARIO_TG, None
    try:
        usuario = bot.username
    except Exception:
        usuario = None
    try:
        id_bot = bot.id
    except Exception:
        id_bot = None
    return usuario or BOT_USUARIO_TG, id_bot


def debe_callar(update):
    usuario, id_bot = _datos_del_bot(update)
    return grupos_silenciosos.decidir(update, usuario, id_bot)


async def _callar(update, context):
    chat = getattr(update, "effective_chat", None)
    log.info("grupo silencioso %s: update anotado en la bitacora, no se procesa",
             getattr(chat, "id", None))


class _Silencio(BaseHandler):
    """El PRIMER handler del grupo 0 de `main()`. La bitacora (grupo -1) ya
    anoto el update; si el chat es silencioso, este lo atiende sin hacer nada y,
    como en un grupo de PTB solo corre el primer handler que acepta, ningun otro
    (texto, voz, foto, comandos, entrada de miembros) lo ve."""

    def __init__(self):
        super().__init__(_callar)

    def check_update(self, update):
        if not isinstance(update, Update):
            return None
        return True if debe_callar(update) else None


# ===========================================================================
# PASO 5 — confirmar. Aqui no hay LLM, y no puede haberlo.
# ===========================================================================

async def _falta_la_cuenta(update, dato):
    """True si esta propuesta aun no sabe su cuenta, y ya se le dijo a la persona.
    La misma puerta para el "va" escrito y para el boton: un boton viejo no la salta."""
    if not dato.get("cuenta_pendiente"):
        return False
    if dato.get("rehidratado") and ("propuesta" not in dato or not dato.get("cuentas")):
        # S1: un borrador de antes de guardar el contexto, tras un reinicio. La
        # cuenta nunca se dijo, y sin su propuesta no se puede volver a proponer.
        await update.effective_message.reply_text(
            "Esa propuesta la recupere despues de un reinicio y no se de que cuenta "
            "es. No escribi nada. Cancelala y dictamela otra vez diciendo la cuenta.")
        return True
    await update.effective_message.reply_text(
        _por_que_preguntamos(dato) + "De cual cuenta? Escoge una.",
        reply_markup=_teclado_cuentas(dato.get("cuentas") or [], dato.get("borrador_id")))
    return True


async def _confirmar_abono(update, chat):
    """El "va" de un abono. Aqui tampoco hay LLM, y no puede haberlo: solo
    viajan `{telegram_id, borrador_id, sello}`."""
    dato = _memoria.get(chat)
    if not dato or dato.get("tipo") != "abono":
        await update.effective_message.reply_text("No tengo ningun abono pendiente que escribir.")
        return
    if await _falta_la_cuenta(update, dato):
        return
    estado, r = _post("/api/bot/abono/confirmar", {
        "telegram_id": chat,
        "borrador_id": dato["borrador_id"],
        "sello": dato["sello"],
    })
    log.info("abono confirmado: borrador=%s -> %s filas=%s",
             dato["borrador_id"], estado, r.get("filas_escritas"))
    if estado == 200 and r.get("ok") and r.get("pendiente_de_aprobacion"):
        # D97: entro como ABONO_PENDIENTE; el aviso a Norman sale al cerrar el turno.
        _memoria.pop(chat, None)
        await update.effective_message.reply_text(
            r.get("mensaje") or "Registrado. Queda PENDIENTE hasta que Norman lo apruebe.")
    elif estado == 200 and r.get("ok"):
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


# ─── FASE 11 (D112): LA ENTREGA DE EFECTIVO DEL DISTRIBUIDOR ────────────────
# El DST cobra de contado y despues entrega ese efectivo a la matriz. NO es un
# abono de concesion. Quien puede registrar la de quien lo decide el servidor
# (`lib/bot-entrega.ts` decidirEntrega): aqui solo se enruta, como el abono.

def _teclado_confirmar_entrega(borrador_id):
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("VA, registrala", callback_data="vaet:" + borrador_id)],
        [InlineKeyboardButton("Cancelar", callback_data="no:" + borrador_id)],
    ])


def _teclado_entregadores(opciones):
    """Por INDICE, como los deudores: el boton solo apunta a la lista cerrada
    que el servidor acaba de declarar."""
    filas = [[InlineKeyboardButton(
        str(o.get("nombre")) + (" (" + str(o.get("rol")) + ")" if o.get("rol") else ""),
        callback_data="setet:" + str(i))] for i, o in enumerate(opciones)]
    filas.append([InlineKeyboardButton("Mejor no", callback_data="no:x")])
    return InlineKeyboardMarkup(filas)


async def _proponer_entrega(update, chat, monto, nombre=None, id_entidad=None):
    cuerpo = {"telegram_id": chat, "monto": monto}
    if id_entidad:
        cuerpo["id_entidad"] = id_entidad
    elif nombre:
        cuerpo["entidad"] = nombre
    estado, r = _post("/api/bot/entrega/proponer", cuerpo)
    log.info("entrega propuesta: entidad=%s monto=%s -> %s", nombre or id_entidad, monto, estado)
    if estado == 200 and r.get("hay_que_elegir"):
        opciones = r.get("opciones") or []
        _memoria[chat] = {"tipo": "entrega_eligiendo", "monto": monto, "opciones": opciones}
        await update.effective_message.reply_text(
            r.get("mensaje") or "De quien es la entrega?",
            reply_markup=_lista_de(chat, _teclado_entregadores(opciones)))
        return
    if estado != 200 or not r.get("ok"):
        await update.effective_message.reply_text(r.get("error", "No pude proponer la entrega."))
        return
    _memoria[chat] = {"tipo": "entrega_efectivo", "borrador_id": r["borrador_id"],
                      "sello": r["sello"], "id_entidad": r.get("id_entidad"), "monto": monto}
    await _ensenar_propuesta(update, chat, r["mensaje"], _teclado_confirmar_entrega(r["borrador_id"]))


async def _confirmar_entrega(update, chat):
    """El VA de una entrega. Solo viajan `{telegram_id, borrador_id, sello}`.
    Si es de un DST (o de Kevin), el servidor contesta `espera_aprobacion` y
    `_post` ya lo anoto para avisarle a quien aprueba."""
    dato = _memoria.get(chat)
    if not dato or dato.get("tipo") != "entrega_efectivo":
        await update.effective_message.reply_text("No tengo ninguna entrega pendiente que escribir.")
        return
    estado, r = _post("/api/bot/entrega/confirmar", {
        "telegram_id": chat,
        "borrador_id": dato["borrador_id"],
        "sello": dato["sello"],
    })
    log.info("entrega confirmada: borrador=%s -> %s filas=%s",
             dato["borrador_id"], estado, r.get("filas_escritas"))
    if estado == 200 and r.get("ok"):
        _memoria.pop(chat, None)
        texto = r.get("mensaje") or "Listo. Quedo registrada la entrega."
        if r.get("aviso_marca"):
            texto += NL + str(r["aviso_marca"])
        await update.effective_message.reply_text(texto)
    else:
        await update.effective_message.reply_text(r.get("error", "No pude registrar la entrega."))


async def _ensenar_propuesta(update, chat, mensaje, teclado):
    """Ensena una propuesta sellada y la deja guardada JUNTO A SU BORRADOR.

    D63 (Fase 7): si despues Norman contesta algo que no es un "si" explicito,
    el bot la vuelve a ensenar tal cual, con sus botones, en vez de escribir.
    Se guarda con el `borrador_id` para que una propuesta vieja nunca se
    ensene como si fuera la de ahora.
    """
    dato = _memoria.get(chat)
    if isinstance(dato, dict) and dato.get("borrador_id"):
        dato["mostrado"] = (dato["borrador_id"], mensaje, teclado)
    with _hablando_de_ticket(isinstance(dato, dict) and dato.get("comprobante")):
        enviado = await update.effective_message.reply_text(mensaje, reply_markup=teclado)
    if isinstance(dato, dict) and dato.get("borrador_id"):
        _anotar_mensaje(chat, enviado, dato["borrador_id"])
    caidos = _caidos.pop(chat, None)
    if caidos:
        # D79: el mensaje nuevo cancelo lo que estaba esperando su VA. Se DICE:
        # una propuesta que desaparece callada es el silencio de D49.
        nombres = ", ".join(_COMO_SE_LLAMA.get(_tipo_de(d), "una propuesta") for d in caidos)
        await update.effective_message.reply_text(
            "La propuesta anterior (" + nombres + ") la cancele: no le diste VA. "
            "Si la querias, dictamela otra vez.")


async def _pedir_va_explicito(update, chat):
    """D63: `confirmar` sin un "si" explicito NO llama la ruta. Vuelve a ensenar
    la propuesta y pide el VA. El boton VA no pasa por el modelo: sigue igual."""
    if await _varias_vivas(update, chat):
        return
    dato = _memoria.get(chat)
    if not isinstance(dato, dict):
        await update.effective_message.reply_text("No tengo nada pendiente que escribir.")
        return
    if not dato.get("borrador_id"):
        await update.effective_message.reply_text(
            "Todavia no hay nada listo para escribir. Contestame lo que te pregunte.")
        return
    mostrado = dato.get("mostrado")
    if mostrado and mostrado[0] == dato.get("borrador_id"):
        enviado = await update.effective_message.reply_text(
            "No me quedo claro si es un si, y esto escribe. Te la vuelvo a "
            "ensenar:\n\n" + mostrado[1] + "\n\nToca VA o escribe va.",
            reply_markup=mostrado[2])
        _anotar_mensaje(chat, enviado, dato["borrador_id"])
        return
    await update.effective_message.reply_text(
        "No me quedo claro si es un si, y esto escribe "
        + _COMO_SE_LLAMA.get(str(dato.get("tipo") or ""), "un movimiento")
        + ". Toca VA en la propuesta de arriba o escribe va.")


YA_NO_ACTIVA = ("Esa propuesta ya no esta activa (se cancelo, se escribio o se reemplazo). "
                "No cambie nada.")


# El mensaje contestado es la pregunta "cual": trae VARIAS propuestas.
_ES_LA_PREGUNTA_CUAL = "?"
_PATRON_PREGUNTA = re.compile(r"^q[0-9a-f]{8}$")


def _anotar_mensaje(chat, enviado, valor):
    """Que objeto se ensena en ese mensaje. En RAM: tras un reinicio queda el teclado."""
    mensaje_id = getattr(enviado, "message_id", None)
    if mensaje_id is None:
        return
    mapa = _mensajes.setdefault(_chat_de(chat), {})
    mapa[mensaje_id] = valor
    while len(mapa) > TOPE_MENSAJES:
        mapa.pop(next(iter(mapa)))


def _borrador_del_reply(update, chat=None):
    """El id del objeto al que contesta este mensaje, "" o `_ES_LA_PREGUNTA_CUAL`.

    2026-11-04 (auditoria, S13 y S6): primero el id del mensaje contestado, que
    resuelve aunque el mensaje ya no traiga teclado; despues el teclado, que sobrevive
    a un reinicio. Un teclado con VARIOS ids es la pregunta "cual": antes se tomaba
    el primero, y un "va" a la pregunta escribia esa propuesta."""
    m = getattr(update, "effective_message", None)
    respondido = getattr(m, "reply_to_message", None)
    if respondido is None:
        return ""
    if chat is not None:
        conocido = (_mensajes.get(_chat_de(chat)) or {}).get(getattr(respondido, "message_id", None))
        if conocido:
            return conocido
    teclado = getattr(getattr(respondido, "reply_markup", None), "inline_keyboard", None)
    ids = []
    for fila in teclado or ():
        for boton in fila:
            partes = str(getattr(boton, "callback_data", "") or "").split(":")
            if partes[0] in ("apr", "rch", "apa", "rca"):
                return ""
            ultimo = partes[-1]
            if (_PATRON_UUID.match(ultimo) or _PATRON_PREGUNTA.match(ultimo)) and ultimo not in ids:
                ids.append(ultimo)
    if len(ids) > 1:
        return _ES_LA_PREGUNTA_CUAL
    return ids[0] if ids else ""


def _contesta_a_ninguna(update, chat):
    """True si contesta a un mensaje que no se puede atar a ninguna propuesta. El
    `va` no escribe: se pregunta cual, aunque solo haya una viva."""
    m = getattr(update, "effective_message", None)
    respondido = getattr(m, "reply_to_message", None)
    if respondido is None or _borrador_del_reply(update, chat):
        return False
    teclado = getattr(getattr(respondido, "reply_markup", None), "inline_keyboard", None)
    return not any(str(getattr(b, "callback_data", "") or "").split(":")[0] in ("apr", "rch", "apa", "rca")
                   for fila in teclado or () for b in fila)


async def _contesta_a_muerta(update, chat):
    """Si el mensaje contesta a una propuesta, la pone en el foco. Si esa ya no
    esta viva lo dice y devuelve True: un "va" a una propuesta muerta no se lo
    lleva la que este viva."""
    bid = _borrador_del_reply(update, chat)
    if not bid or bid == _ES_LA_PREGUNTA_CUAL or _enfocar(chat, bid):
        return False
    foco = _memoria.get(chat)
    if isinstance(foco, dict) and foco.get("borrador_id") == bid:
        return False
    await update.effective_message.reply_text(_boton_ajeno(chat, "va", bid) or YA_NO_ACTIVA)
    return True


def _etiqueta_de(dato):
    """Como se nombra una propuesta en la pregunta de cual: con monto y concepto.
    Si no los tiene a la mano, la primera linea que se le ensenó."""
    propuesta = dato.get("propuesta") if isinstance(dato.get("propuesta"), dict) else {}
    peticion = dato.get("peticion") if isinstance(dato.get("peticion"), dict) else {}
    monto = propuesta.get("monto") or dato.get("monto")
    detalle = str(propuesta.get("descripcion") or dato.get("nombre_deudor") or propuesta.get("nota")
                  or peticion.get("comprador") or peticion.get("cliente") or dato.get("para_quien")
                  or dato.get("folio") or "")[:LARGO_ETIQUETA]
    if not monto and not detalle and dato.get("mostrado"):
        lineas = [x for x in _texto_plano(dato["mostrado"][1], 60).split(". ") if x]
        detalle = lineas[0][:36] if lineas else ""
    trozos = [_COMO_SE_LLAMA.get(_tipo_de(dato), "una propuesta"), "$%s" % monto if monto else "", detalle]
    return " ".join(x for x in trozos if x)


def _rotulos(vivos):
    """Las etiquetas de varias propuestas, sin dos iguales: dos rotulos iguales son
    una pregunta que no se puede contestar."""
    vistos = {}
    salida = []
    for d in vivos:
        rotulo = _etiqueta_de(d)
        vistos[rotulo] = vistos.get(rotulo, 0) + 1
        salida.append(rotulo if vistos[rotulo] == 1 else "%s (%da)" % (rotulo, vistos[rotulo]))
    return salida


async def _varias_vivas(update, chat):
    """D79: con DOS o mas propuestas vivas, un "va" escrito no dice cual.

    2026-11-04: vale para la del mensaje al que contesta. Sin reply no se adivina:
    se pregunta cual, con un boton por propuesta. Con UNA, esto no dice nada y el
    "va" escrito funciona como siempre (y D63 sigue exigiendo un si explicito).
    Devuelve True si contesto.
    """
    if await _contesta_a_muerta(update, chat):
        return True
    reply = _borrador_del_reply(update, chat)
    if reply and reply != _ES_LA_PREGUNTA_CUAL:
        return False
    vivos = _pendientes_de(chat)
    obligada = reply == _ES_LA_PREGUNTA_CUAL or _contesta_a_ninguna(update, chat)
    if len(vivos) < 2 and not (obligada and vivos):
        return False
    await _preguntar_cual(update, chat, vivos, "VA: ", "va:",
                          "Tengo %s esperando: %s. Con un va escrito no se cual: toca "
                          "la que va, o contesta va al mensaje de esa propuesta.")
    return True


async def _preguntar_cual(update, chat, vivos, prefijo, accion, texto):
    """Un boton por propuesta, con rotulos que se distinguen."""
    rotulos = _rotulos(vivos)
    filas = [[InlineKeyboardButton((prefijo + r)[:60], callback_data=accion + d["borrador_id"])]
             for d, r in zip(vivos, rotulos)]
    enviado = await update.effective_message.reply_text(
        texto % ("1 propuesta" if len(vivos) == 1 else "%d propuestas" % len(vivos),
                 ", ".join(rotulos)),
        reply_markup=InlineKeyboardMarkup(filas))
    _anotar_mensaje(chat, enviado, _ES_LA_PREGUNTA_CUAL)


async def _cancelar_lo_dicho(update, chat):
    """El "no" escrito o dictado. Si contesta a una propuesta, apaga ESA.

    2026-11-04 (encargo de Norman, "que los trate de forma independiente", auditoria
    S7): con dos o mas y sin reply antes se apagaban todas (`_cancelar_todo`, D79).
    Ahora se pregunta cual. Si lo que esta en el foco es una pregunta, el "no" es
    para ella: las propuestas no se tocan."""
    if await _contesta_a_muerta(update, chat):
        return
    reply = _borrador_del_reply(update, chat)
    nombrada = bool(reply) and reply != _ES_LA_PREGUNTA_CUAL
    foco = dict.get(_memoria, chat)
    es_pregunta = isinstance(foco, dict) and not foco.get("borrador_id")
    vivos = _pendientes_de(chat)
    if not nombrada and not (es_pregunta and reply != _ES_LA_PREGUNTA_CUAL) and (
            len(vivos) >= 2 or (vivos and (reply or _contesta_a_ninguna(update, chat)))):
        await _preguntar_cual(update, chat, vivos, "Cancelar: ", "no:",
                              "Tengo %s esperando: %s. No apago ninguna a ciegas: "
                              "toca la que cancelo.")
        return
    await update.effective_message.reply_text(_cancelar_de_verdad(chat, _borrador_vivo(chat)))


async def _confirmar(update, chat, por_boton=False):
    if not por_boton and await _varias_vivas(update, chat):
        return
    dato = _memoria.get(chat)
    if (not por_boton and isinstance(dato, dict) and not dato.get("borrador_id")
            and _pendientes_de(chat)):
        # Una propuesta lista y otra a la que le falta un dato: el "va" escrito
        # no se lo lleva la que esta lista a escondidas.
        await update.effective_message.reply_text(
            "La propuesta de arriba se escribe con su boton VA. A la otra todavia "
            "le falta un dato: contestame lo que te pregunte.")
        return
    if not dato:
        await update.effective_message.reply_text("No tengo nada pendiente que escribir.")
        return
    # Un borrador a medias NO se confirma, y este es el candado que lo impide.
    # Comparte casilla con los borradores de verdad, pero no tiene sello -- y
    # sin sello no hay nada que mandar al servidor. Un "va" adelantado se
    # contesta diciendo que falta, no escribiendo una fila incompleta.
    if dato.get("estado") == "incompleto":
        await update.effective_message.reply_text(
            "Todavia me falta un dato para poder escribirlo. Contestame lo que te pregunte.")
        return
    # 2026-11-04: si se pregunto la cuenta, el "va" no escribe la de default.
    if await _falta_la_cuenta(update, dato):
        return
    # Un "va" escrito vale para lo que este pendiente, sea gasto o abono: la
    # persona contesta como habla y no tiene por que saber que hay dos caminos.
    if dato.get("tipo") == "abono":
        await _confirmar_abono(update, chat)
        return
    # D112: sin esta rama un "va" escrito caia al camino de gasto.
    if dato.get("tipo") == "entrega_efectivo":
        await _confirmar_entrega(update, chat)
        return
    if dato.get("tipo") == "entrega_eligiendo":
        await update.effective_message.reply_text(
            "Primero dime de quien es la entrega, con uno de los botones.")
        return
    if dato.get("tipo") == "anulacion":
        await _confirmar_anulacion(update, chat)
        return
    if dato.get("tipo") == "anulacion_eligiendo":
        await update.effective_message.reply_text(
            "Primero dime cual, con uno de los botones.")
        return
    if dato.get("tipo") == "correccion_eligiendo":
        await update.effective_message.reply_text(
            "Primero dime que le cambio, con uno de los botones.")
        return
    if dato.get("tipo") == "alta":
        await _confirmar_alta(update, chat)
        return
    if dato.get("tipo") == "alta_miembro":
        await _confirmar_miembro(update, chat)
        return
    if dato.get("tipo") == "alta_categoria":
        await _confirmar_categoria(update, chat)
        return
    if dato.get("tipo") == "miembro_eligiendo":
        await update.effective_message.reply_text(
            "Primero dime de cual es, con uno de los botones.")
        return
    if dato.get("tipo") == "alta_eligiendo":
        await update.effective_message.reply_text(
            "Todavia me falta un dato del alta. Contestame lo que te pregunte.")
        return
    if dato.get("tipo") == "conversion":
        await _confirmar_conversion(update, chat)
        return
    if dato.get("tipo") == "conversion_eligiendo":
        await update.effective_message.reply_text(
            "Primero dime cual, con uno de los botones.")
        return
    if dato.get("tipo") == "venta":
        await _confirmar_venta(update, chat)
        return
    if dato.get("tipo") == "lote":
        await _confirmar_lote(update, chat)
        return
    if dato.get("tipo") == "entrada_insumo":
        await _confirmar_entrada(update, chat)
        return
    if dato.get("tipo") == "cotizacion":
        await _confirmar_cotizacion(update, chat)
        return
    if dato.get("tipo") == "cotizacion_eligiendo":
        pendiente = ("que producto" if dato.get("campo") == "producto"
                     else "a quien se la cotizo")
        await update.effective_message.reply_text(
            "Primero dime " + pendiente + ", con uno de los botones.")
        return
    if dato.get("tipo") == "lote_eligiendo":
        pendiente = "el insumo" if dato.get("campo") == "insumo" else "el formato de las botellas"
        await update.effective_message.reply_text(
            "Primero dime " + pendiente + ", con uno de los botones.")
        return
    if dato.get("tipo") == "venta_eligiendo":
        pendiente = "el producto" if dato.get("campo") == "producto" else "el comprador"
        await update.effective_message.reply_text(
            "Primero dime " + pendiente + ", con uno de los botones.")
        return
    if dato.get("tipo") == "abono_eligiendo":
        await update.effective_message.reply_text(
            "Primero dime de quien fue el pago, con uno de los botones.")
        return
    if not dato.get("borrador_id"):
        await update.effective_message.reply_text("Primero escoge con uno de los botones.")
        return
    if dato.get("tipo") == "lote_etapa":
        # Rehidratada: el resumen de la etapa vivia en RAM, pero el borrador sellado
        # esta completo. Sin esta rama caia a `gasto/confirmar`.
        estado, r = _post(RUTA_CONFIRMAR_DE["lote_etapa"], {
            "telegram_id": chat, "borrador_id": dato["borrador_id"], "sello": dato["sello"]})
        if estado == 200 and r.get("ok"):
            _memoria.pop(chat, None)
            await update.effective_message.reply_text(r.get("mensaje") or "Listo.")
        else:
            await update.effective_message.reply_text(r.get("error", "No pude escribirlo."))
        return
    estado, r = _post("/api/bot/gasto/confirmar", {
        "telegram_id": chat,
        "borrador_id": dato["borrador_id"],
        "sello": dato["sello"],
    })
    if estado == 200 and r.get("ok"):
        _memoria.pop(chat, None)
        # 2026-11-03: el clic ya escribio; la foto se liga a ESE borrador.
        pie = await asyncio.to_thread(_ligar_comprobante, dato.get("borrador_id"), r.get("id"))
        creada = r.get("categoria_creada")
        if creada:
            if creada not in _catalogo:
                _catalogo.append(creada)
            await update.effective_message.reply_text(
                "Listo. Quedo escrito, y la categoria " + str(creada) +
                " quedo creada: desde ahora la uso sola." + pie)
        else:
            await update.effective_message.reply_text("Listo. Quedo escrito." + pie)
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
    # Lo que el modelo dejo por resolver sobrevive a cualquier otro cambio. Una cuenta
    # que se dijo y no casa con ninguna (S8) no deja la anterior callada: vuelve a
    # preguntarse.
    duda = cambios.get("cuenta_duda") or {}
    if cambios.get("id_cuenta"):
        cuenta = {"id_cuenta": cambios["id_cuenta"]}
    elif duda:
        cuenta = dict(duda)
    elif dato.get("cuenta_dicha"):
        cuenta = {"id_cuenta": dato.get("id_cuenta")}
    else:
        cuenta = {"oida": dato.get("cuenta_oida"), "solo_paga": dato.get("cuenta_solo_paga")}
    sugeridas = cambios.get("sugeridas", dato.get("sugeridas") or [])

    cuerpo = {"telegram_id": chat, "propuesta": propuesta,
              "contexto_bot": _contexto_para_base(
                  {k: v for k, v in cuenta.items() if v}, propuesta, sugeridas)}
    if id_cuenta:
        cuerpo["id_cuenta"] = id_cuenta
    estado, r = _post("/api/bot/gasto/proponer", cuerpo)
    if estado != 200 or not r.get("ok"):
        await update.effective_message.reply_text(r.get("error", "No pude reproponerlo."))
        return
    cuentas = r.get("cuentas", dato.get("cuentas", []))
    # Cambiar de cuenta (o cualquier otro campo) reemplaza SIEMPRE a su propio
    # borrador: el VA viejo ya no debe poder escribir (S3).
    with _reemplazando(chat, dato.get("borrador_id")):
        _memoria[chat] = dict({
            "borrador_id": r["borrador_id"],
            "sello": r["sello"],
            "propuesta": propuesta,
            "cuentas": cuentas,
            "id_cuenta": r.get("id_cuenta"),
            "categorias": r.get("categorias", list(_catalogo)),
            "sugeridas": sugeridas,
            "cuenta": {k: v for k, v in cuenta.items() if v},
        }, **_estado_de_cuenta(cuenta, cuentas))
    _refrescar_catalogo(r)
    # 2026-11-03: el borrador nuevo sustituye al viejo, y se lleva su foto.
    mensaje = r["mensaje"]
    vuelo = comprobantes.foto_de_vuelo(dato.get("borrador_id"))
    pegadas = [c for c in comprobantes.fotos_de_borrador(dato.get("borrador_id"))
               if _adjuntar_comprobante(chat, r["borrador_id"], c, c == vuelo)]
    if pegadas:
        mensaje = str(mensaje) + NL + NL + _pie_de_propuesta(len(pegadas))
    await _ensenar_gasto(update, chat, mensaje)


# Los botones que ESCRIBEN. El `borrador_id` que traen es el de la propuesta
# que Norman vio; si ya no esta viva, NO se confirma lo que haya en el foco.
ACCIONES_VA = ("va", "vaan", "vaalt", "vacnv", "vaab", "vavt", "valt", "vact", "vaent", "vamb", "vaet",
               "vacat")
# Los botones de una lista: `<accion>:<i>:<dueno>`, donde el dueno es un borrador o
# una pregunta (`_lista_de`). Sin dueno el indice no significa nada.
_ACCIONES_DE_LISTA = ("setdeu", "setcomp", "setcli", "setprod", "setins", "setfmt", "setalta",
                      "setcnv", "setanu", "setcorr", "setet", "mbe", "setcat", "dup")
# Los que vuelven a proponer lo mismo con un dato cambiado: sustituyen a su borrador.
_ACCIONES_QUE_REEMPLAZAN = ("setcta", "setsug", "setcat", "setdeu", "setcomp", "setcli",
                            "setprod", "setins", "setfmt", "setalta", "setcnv")


_PATRON_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


def _dueno_en_el_grupo(clave, borrador_id):
    """En un grupo, la PERSONA (otra que quien apreta) cuya propuesta viva es
    `borrador_id`, o None. **Pura salvo por leer la RAM.**"""
    if not _en_grupo(clave):
        return None
    for k, reg in list(_pendientes.items()):
        if not _en_grupo(k) or _chat_de(k) != _chat_de(clave) or _persona(k) == _persona(clave):
            continue
        foco = dict.get(_memoria, k)
        if borrador_id in (reg or {}) or (isinstance(foco, dict) and foco.get("borrador_id") == borrador_id):
            return _persona(k)
    return None


def _boton_ajeno(clave, accion, arg):
    """El texto que se le dice a quien apreta el boton de una propuesta que no
    es suya, o "" si el boton si es suyo (o no es de una propuesta). **Solo
    lee la RAM.** Nunca escribe: el clic ajeno no llega al servidor."""
    if not _en_grupo(clave) or not _PATRON_UUID.match(str(arg or "")):
        return ""
    if arg in (_pendientes.get(clave) or {}):
        return ""
    foco = dict.get(_memoria, clave)
    if isinstance(foco, dict) and foco.get("borrador_id") == arg:
        return ""
    dueno = _dueno_en_el_grupo(clave, arg)
    if dueno is None:
        if accion in ACCIONES_VA or accion == "no":
            return ("Ese boton no es de una propuesta tuya (o ya caduco). Tu clic no escribio nada. "
                    "Lo que el bot escribe, lo escribe el clic de Norman.")
        return ""
    nombre = _nombre_de(dueno)
    if int(_persona(clave)) == NORMAN_TELEGRAM_ID:
        return ("Esa propuesta es de " + nombre + ". Cuando " + nombre + " le de VA, te llega "
                "por privado el Aprobar; ese clic es el que la escribe. Este no escribio nada.")
    return ("Esa propuesta es de " + nombre + ": solo " + nombre + " le da VA, y solo el Aprobar "
            "de Norman la escribe. Tu clic no escribio nada.")


async def manejar_boton(update, context):
    q = update.callback_query
    await q.answer()
    chat = _clave(q.message.chat.id, getattr(getattr(q, "from_user", None), "id", None))
    partes = q.data.split(":", 2)
    accion = partes[0]
    if not await _puerta_de_grupo(update, chat):
        return
    update = _UpdateQueAnota(update, chat)
    await asyncio.to_thread(_rehidratar, chat)
    try:
        await _manejar_boton(update, chat, q, partes, accion)
        # R1 (auditoria F0): procesado=true SOLO si el handler termino. Si revienta,
        # la fila se queda procesado=false (en la cola), no en el finally.
        await bitacora.marcar_procesado(update)
        await _seguir_cola(update, chat)
        await _avisar_aprobaciones(update)
    finally:
        _cerrar_turno(chat, "[toco el boton " + accion + "]")


async def _boton_de_lote_v2(update, chat, partes, accion):
    """Lote v2. Los botones del ciclo: no traen borrador (el lote o la sesion
    viven en la plantilla / en la base), asi que van ANTES del foco."""
    arg = partes[1] if len(partes) > 1 else ""
    if accion == "ltok":
        await _confirmar_plantilla_lote(update, chat)
    elif accion == "ltcor":
        await lote_plantilla.corregir(update, chat)
    elif accion == "ltec":
        await _confirmar_etapa_lote(update, chat)
    elif accion == "ltecc":
        s = lote_ciclo.sesion(chat)
        if not s:
            await update.effective_message.reply_text("Ya no tengo esa etapa a medias. Dictamela otra vez.")
        else:
            await lote_ciclo.abrir_etapa(update, chat, s["etapa"], s["codigo"])
    elif accion == "ltad2":
        await lote_ciclo.abrir_etapa(update, chat, "aditivo_2", arg)
    elif accion == "ltdes":
        await lote_ciclo.abrir_etapa(update, chat, "destilacion", arg)
    elif accion == "ltmu":
        # Auditoria 2026-11-03 (hallazgo 6): este boton escribe (lote_etapas) y
        # no trae borrador, asi que la guardia de boton ajeno no lo veia. Solo
        # el clic de Norman lo anota; el servidor lo vuelve a exigir.
        if int(_persona(chat)) != NORMAN_TELEGRAM_ID:
            log.info("boton ajeno: %s apreto ltmu (muestra) en %s", _persona(chat), _chat_de(chat))
            await update.effective_message.reply_text(
                "La muestra guardada la anota el clic de Norman. Tu clic no escribio nada.")
        else:
            await lote_ciclo.muestra_guardada(update, chat, _post, arg)
    else:
        return False
    return True


async def _manejar_boton(update, chat, q, partes, accion):
    # D79: el boton trae el `borrador_id` de SU propuesta. Si esta viva, pasa
    # al foco (y lo que hubiera a medias se aparta); si es un VA de una que ya
    # no esta viva, no se escribe nada: el foco es OTRA propuesta.
    if accion in ("apr", "rch", "apa", "rca"):
        await _boton_de_aprobacion(update, chat, q, accion, partes[1] if len(partes) > 1 else "")
        return
    # 2026-11-03 (equipo en el grupo): el boton de la propuesta de OTRO no hace
    # nada, y se dice por que. El servidor ya lo cerraba ("Ese borrador no es
    # tuyo", 403); esto evita que llegue y le explica a quien apreto.
    # Las de lista traen el indice primero y su dueno en tercer lugar.
    de_propuesta = (accion in ("setcta", "setsug", "no") + _ACCIONES_DE_LISTA) and len(partes) > 2
    aviso_ajeno = _boton_ajeno(chat, accion, partes[2] if de_propuesta else (partes[1] if len(partes) > 1 else ""))
    if aviso_ajeno:
        log.info("boton ajeno: %s apreto %s de otra persona en %s", _persona(chat), accion, _chat_de(chat))
        await update.effective_message.reply_text(aviso_ajeno)
        return
    if await _boton_de_lote_v2(update, chat, partes, accion):
        return
    if de_propuesta and not _enfocar(chat, partes[2]):
        await update.effective_message.reply_text(YA_NO_ACTIVA)
        return
    if accion in _ACCIONES_DE_LISTA and not de_propuesta:
        # Una lista de antes de que los botones llevaran dueno: su indice no se puede
        # atar a nada (S5), y aplicarlo al foco es justo el defecto.
        await update.effective_message.reply_text(YA_NO_ACTIVA)
        return
    bid = partes[1] if len(partes) > 1 else ""
    if bid and bid not in _NO_HAY_BORRADOR and not _enfocar(chat, bid):
        # 2026-11-04: TODO boton valida su borrador, no solo el VA. "Cambiar cuenta"
        # de un gasto ya cancelado leia el foco, que era un abono, y contestaba
        # "Solo tienes una cuenta": falso, y sobre otra propuesta. El "no" pasa
        # porque lo resuelve el servidor por id (y dice si ya estaba escrito).
        foco = _memoria.get(chat)
        foco_bid = foco.get("borrador_id") if isinstance(foco, dict) else ""
        # Un VA sin nada en el foco cae a `_confirmar`, que dice que no hay pendiente.
        # Con algo a medias en el foco tampoco es de ese: lo apagado se dice apagado.
        es_propuesta = (bool(_PATRON_UUID.match(str(bid))) and accion != "no"
                        and accion not in ACCIONES_VA)
        if foco_bid != bid and (es_propuesta or (accion in ACCIONES_VA and foco)):
            await update.effective_message.reply_text(YA_NO_ACTIVA)
            return

    foco = dict.get(_memoria, chat)
    foco = foco if isinstance(foco, dict) else {}
    blanco = ""
    if accion in _ACCIONES_QUE_REEMPLAZAN:
        blanco = foco.get("borrador_id") or foco.get("_reemplaza") or ""
    with _reemplazando(chat, blanco):
        await _accion_de_boton(update, chat, partes, accion)
    # Una pregunta contestada ya no vive: su lista vieja contesta YA_NO_ACTIVA.
    pid = foco.get("_pid")
    if pid and dict.get(_memoria, chat) is not foco:
        (_preguntas.get(chat) or {}).pop(pid, None)


async def _accion_de_boton(update, chat, partes, accion):
    if accion == "qf":
        await _quitar_foto(update, chat, partes[1] if len(partes) > 1 else "")
        return
    if accion == "vamb":
        await _confirmar_miembro(update, chat)
        return
    if accion == "vacat":
        await _confirmar_categoria(update, chat)
        return
    if accion == "mbe":
        dato = _memoria.get(chat) or {}
        try:
            elegida = (dato.get("opciones") or [])[int(partes[1])]
        except (ValueError, IndexError, TypeError):
            await update.effective_message.reply_text("Esa opcion ya no esta. Vuelve a contestarle con \"este es ...\".")
            return
        await _proponer_miembro(update, chat, dato.get("miembro"), dato.get("texto") or "", elegida.get("id"))
        return
    if accion == "abrlt":
        # Ronda 5 (B): un boton viejo de "Abrir lote nuevo" ya no abre nada.
        await update.effective_message.reply_text(
            "Ya no abro lotes desde un envasado: el envasado se registra solo, sin lote. Dictamelo otra vez.")
        return
    if accion == "valt":
        await _confirmar_lote(update, chat)
    elif accion == "vaent":
        await _confirmar_entrada(update, chat)
    elif accion == "cod":
        _esperando_codigo[chat] = _borrador_vivo(chat) or True
        await update.effective_message.reply_text("Que codigo le pongo?")
    elif accion == "setins":
        dato = _memoria.get(chat) or {}
        peticion = dict(dato.get("peticion") or {})
        opciones = dato.get("opciones") or []
        lineas = [dict(x) for x in (peticion.get("insumos") or [])]
        try:
            elegido = opciones[int(partes[1])]
            lineas[int(dato.get("indice"))]["id_insumo"] = elegido["id"]
        except (ValueError, IndexError, TypeError):
            await update.effective_message.reply_text("Ese insumo ya no esta en la lista. Dictamelo otra vez.")
            return
        peticion["insumos"] = lineas
        await _proponer_lote(update, chat, peticion)
    elif accion == "setfmt":
        dato = _memoria.get(chat) or {}
        peticion = dict(dato.get("peticion") or {})
        opciones = dato.get("opciones") or []
        lineas = [dict(x) for x in (peticion.get("envasado") or [])]
        try:
            elegido = opciones[int(partes[1])]
            lineas[int(dato.get("indice"))]["id_producto"] = elegido["id"]
        except (ValueError, IndexError, TypeError):
            await update.effective_message.reply_text("Ese formato ya no esta en la lista. Dictamelo otra vez.")
            return
        peticion["envasado"] = lineas
        await _proponer_lote(update, chat, peticion)
    elif accion == "vact":
        await _confirmar_cotizacion(update, chat)
    elif accion == "cli":
        # "Otro cliente": la lista COMPLETA que mando el servidor la ultima
        # vez. Sin boton de prospecto: para cotizarle a alguien que no esta en
        # la red hay que decir su nombre, y eso se dicta, no se escoge.
        dato = _memoria.get(chat) or {}
        opciones = dato.get("clientes") or []
        if not opciones:
            await update.effective_message.reply_text(
                "Dictamela otra vez diciendo a quien se la cotizo.")
        else:
            await update.effective_message.reply_text(
                "A quien?", reply_markup=_lista_de(chat, _teclado_clientes(opciones)))
    elif accion == "vig":
        _esperando_vigencia[chat] = _borrador_vivo(chat) or True
        await update.effective_message.reply_text("Cuantos dias se la respeto? Solo el numero.")
    elif accion == "setcli":
        dato = _memoria.get(chat) or {}
        peticion = dict(dato.get("peticion") or {})
        if not peticion:
            await update.effective_message.reply_text("Ya no tengo esa cotizacion. Dictamela otra vez.")
            return
        peticion.pop("cliente", None)
        peticion.pop("id_comprador", None)
        peticion.pop("prospecto", None)
        if partes[1] == "pros":
            # El nombre del prospecto es el que se DIJO, guardado por el
            # servidor en la pregunta. El boton no lo lleva: no cabe en los 64
            # bytes de `callback_data` y ademas se reescribiria a mano.
            nombre = dato.get("nombre_dicho") or ""
            if not nombre:
                await update.effective_message.reply_text("No me quedo el nombre. Dictamela otra vez.")
                return
            peticion["prospecto"] = nombre
        else:
            opciones = dato.get("opciones") or dato.get("clientes") or []
            try:
                elegido = opciones[int(partes[1])]
            except (ValueError, IndexError, TypeError):
                await update.effective_message.reply_text("Ese ya no esta en la lista. Dictamela otra vez.")
                return
            peticion["id_comprador"] = elegido["id"]
        await _proponer_cotizacion(update, chat, peticion)
    elif accion == "vavt":
        await _confirmar_venta(update, chat)
    elif accion == "comp":
        # "Otro comprador": se vuelve a preguntar con la lista COMPLETA que el
        # servidor mando la ultima vez. Es la correccion que de verdad importa
        # en una venta, porque el comprador decide el precio.
        dato = _memoria.get(chat) or {}
        opciones = dato.get("compradores") or []
        if not opciones:
            await update.effective_message.reply_text("Dictamela otra vez diciendo a quien se la vendiste.")
        else:
            peticion = dato.get("peticion") or {}
            publico = str(peticion.get("propuesta", {}).get("condicion_pago") or "").upper() != "CONCESION"
            await update.effective_message.reply_text(
                "A quien?", reply_markup=_lista_de(chat, _teclado_compradores(opciones, publico)))
    elif accion == "setcomp":
        dato = _memoria.get(chat) or {}
        peticion = dict(dato.get("peticion") or {})
        if not peticion:
            await update.effective_message.reply_text("Ya no tengo esa venta. Dictamela otra vez.")
            return
        peticion.pop("comprador", None)
        peticion.pop("id_comprador", None)
        peticion.pop("publico", None)
        if partes[1] == "pub":
            peticion["publico"] = True
        else:
            opciones = dato.get("opciones") or dato.get("compradores") or []
            try:
                elegido = opciones[int(partes[1])]
            except (ValueError, IndexError, TypeError):
                await update.effective_message.reply_text("Ese ya no esta en la lista. Dictamela otra vez.")
                return
            peticion["id_comprador"] = elegido["id"]
        await _proponer_venta(update, chat, peticion)
    elif accion == "setprod":
        dato = _memoria.get(chat) or {}
        peticion = dict(dato.get("peticion") or {})
        opciones = dato.get("opciones") or []
        renglones = [dict(x) for x in (peticion.get("productos") or [])]
        try:
            elegido = opciones[int(partes[1])]
            indice = int(dato.get("indice"))
            renglones[indice]["id_producto"] = elegido["id"]
        except (ValueError, IndexError, TypeError):
            await update.effective_message.reply_text("Ese producto ya no esta en la lista. Dictamela otra vez.")
            return
        peticion["productos"] = renglones
        await _proponer_venta(update, chat, peticion)
    elif accion == "vaan":
        await _confirmar_anulacion(update, chat)
    elif accion == "vaalt":
        await _confirmar_alta(update, chat)
    elif accion == "setalta":
        dato = _memoria.get(chat) or {}
        opciones = dato.get("opciones") or []
        campo = dato.get("campo")
        try:
            elegido = opciones[int(partes[1])]
        except (ValueError, IndexError, TypeError):
            # El indice solo significa algo contra la lista que se ofrecio.
            await update.effective_message.reply_text("Ese ya no esta en la lista. Empecemos otra vez.")
            return
        peticion = dict(dato.get("peticion") or {})
        peticion["telegram_id"] = chat
        valor = elegido.get("valor")
        if campo == "duplicado":
            if valor != "si":
                _memoria.pop(chat, None)
                await update.effective_message.reply_text("Va, no lo creo. No escribi nada.")
                return
            # La persona ya vio con quien se parece y dijo que es otro. La
            # bandera la pone el BOT, nunca el modelo: es un consentimiento, no
            # un dato extraido de una frase.
            peticion["aun_con_parecidas"] = True
        elif campo and campo.startswith("comision"):
            comisiones = dict(peticion.get("comisiones") or {})
            comisiones[campo] = valor
            peticion["comisiones"] = comisiones
        elif campo:
            peticion[campo] = valor
        await _proponer_alta(update, chat, peticion)
    elif accion == "vacnv":
        await _confirmar_conversion(update, chat)
    elif accion == "setcnv":
        dato = _memoria.get(chat) or {}
        opciones = dato.get("opciones") or []
        campo = dato.get("campo")
        try:
            elegido = opciones[int(partes[1])]
        except (ValueError, IndexError, TypeError):
            await update.effective_message.reply_text("Esa ya no esta en la lista. Pidemela otra vez.")
            return
        peticion = dict(dato.get("peticion") or {})
        peticion["telegram_id"] = chat
        if campo == "cotizacion":
            peticion["id_cotizacion"] = elegido.get("id")
        elif campo == "condicion_pago":
            peticion["condicion_pago"] = elegido.get("valor")
        elif campo == "cuenta":
            peticion["id_cuenta_destino"] = elegido.get("valor")
        await _proponer_conversion(update, chat, peticion)
    elif accion == "setanu":
        dato = _memoria.get(chat) or {}
        opciones = dato.get("opciones") or []
        try:
            elegido = opciones[int(partes[1])]
        except (ValueError, IndexError, TypeError):
            # El indice solo significa algo contra la lista que se ofrecio. Si
            # ya no esta, NO se adivina: se vuelve a pedir la lista.
            await update.effective_message.reply_text("Ese ya no esta en la lista. Pidemela otra vez.")
            return
        if dato.get("accion") == "corregir":
            if not elegido.get("valores"):
                await update.effective_message.reply_text(
                    "Ese no se corrige: es un movimiento de inventario y el stock se "
                    "replaya desde el ledger entero. Lo puedo anular y lo recapturas.")
                return
            if elegido.get("arrastra_venta"):
                await update.effective_message.reply_text(
                    "Ese renglon es de una venta y su concepto lleva el folio dentro. "
                    "Lo puedo anular entero, pero no reescribirlo.")
                return
            _memoria[chat] = {"tipo": "correccion_eligiendo",
                              "accion": "corregir",
                              "elegido": elegido,
                              "opciones": opciones}
            await update.effective_message.reply_text(
                "Que le cambio?" + NL + elegido.get("detalle", ""),
                reply_markup=_lista_de(chat, _teclado_campos_corregibles()))
            return
        await _proponer_anulacion(update, chat, {
            "telegram_id": chat,
            "tabla": elegido.get("tabla"),
            "id_movimiento": elegido.get("id"),
            "modo": "anular",
        }, accion="anular")
    elif accion == "setcorr":
        dato = _memoria.get(chat) or {}
        if dato.get("tipo") != "correccion_eligiendo":
            await update.effective_message.reply_text("Ya no tengo ese movimiento. Dimelo otra vez.")
            return
        cual = partes[1]
        if cual == "monto":
            _esperando_correccion[chat] = "monto"
            await update.effective_message.reply_text("De cuanto era? Solo el numero.")
        elif cual == "desc":
            _esperando_correccion[chat] = "desc"
            await update.effective_message.reply_text("Como le pongo?")
        else:
            # La categoria reusa el teclado de siempre. La lista que se ofrece
            # se guarda EXACTA, porque el indice del boton solo significa algo
            # contra ella y no contra lo que el catalogo diga despues.
            vivas = list(_catalogo)
            dato["categorias_ofrecidas"] = vivas
            await update.effective_message.reply_text(
                "Cual es?", reply_markup=_lista_de(chat, _teclado_categorias(vivas)))
    elif accion == "vaab":
        await _confirmar_abono(update, chat)
    elif accion == "vaet":
        await _confirmar_entrega(update, chat)
    elif accion == "setet":
        # D112: el DST de la entrega, por INDICE contra la lista que el
        # servidor acaba de declarar (misma razon que `setdeu`).
        dato = _memoria.get(chat) or {}
        if dato.get("tipo") != "entrega_eligiendo":
            await update.effective_message.reply_text("Ya no tengo esa entrega. Dictamela otra vez.")
            return
        try:
            elegido = (dato.get("opciones") or [])[int(partes[1])]
        except (ValueError, IndexError, TypeError):
            await update.effective_message.reply_text("Ese ya no esta en la lista. Dictamela otra vez.")
            return
        await _proponer_entrega(update, chat, dato.get("monto"),
                                id_entidad=elegido.get("id_entidad"))
    elif accion == "deu":
        # "Otro deudor": se vuelve a preguntar con la lista COMPLETA que el
        # servidor mando la ultima vez.
        dato = _memoria.get(chat) or {}
        opciones = dato.get("opciones") or []
        if not opciones:
            await update.effective_message.reply_text("Dictamelo otra vez diciendo de quien fue el pago.")
        else:
            await update.effective_message.reply_text(
                "De quien fue?", reply_markup=_lista_de(chat, _teclado_deudores(opciones)))
    elif accion == "setdeu":
        dato = _memoria.get(chat) or {}
        opciones = dato.get("opciones") or []
        try:
            elegido = opciones[int(partes[1])]
        except (ValueError, IndexError, TypeError):
            await update.effective_message.reply_text("Ese ya no esta en la lista. Dictamelo otra vez.")
            return
        if not dato.get("propuesta"):
            await update.effective_message.reply_text("Ya no tengo ese abono. Dictamelo otra vez.")
            return
        await _proponer_abono(update, chat, dato.get("propuesta"),
                              id_deudor=elegido["id_entidad"], cuenta=dato.get("cuenta"))
    elif accion == "dup":
        dato = _memoria.get(chat) or {}
        if dato.get("tipo") != "duplicado_eligiendo":
            await update.effective_message.reply_text(YA_NO_ACTIVA)
            return
        if dato.get("abono"):
            await _proponer_abono(update, chat, dato["propuesta"],
                                  id_deudor=dato["abono"].get("id_deudor"),
                                  nombre=dato["abono"].get("nombre"),
                                  cuenta=dato.get("cuenta"), ya_avisado=True)
            return
        await _proponer_gasto_directo(update, chat, dato["propuesta"], dato.get("cuenta"),
                                      dato.get("sugeridas"), ya_avisado=True,
                                      foto=dato.get("foto"), de_vuelo=bool(dato.get("de_vuelo")))
    elif accion == "setaj":
        # Contesta a "a cual se lo hago?": el cambio esperaba en la pregunta.
        pregunta = (_preguntas.get(chat) or {}).pop(partes[2] if len(partes) > 2 else "", None)
        if not pregunta:
            await update.effective_message.reply_text(YA_NO_ACTIVA)
            return
        if _apartado.get(chat) is pregunta:
            _apartado.pop(chat, None)
        await _ajustar(update, chat, pregunta["ruta"], blanco_id=partes[1])
    elif accion == "montoab":
        _esperando_monto[chat] = _borrador_vivo(chat) or True
        await update.effective_message.reply_text("De cuanto fue el abono? Solo el numero.")
    elif accion == "va":
        await _confirmar(update, chat, por_boton=True)
    elif accion == "no":
        # D1: el boton YA trae el id -- `callback_data` es `"no:" + borrador_id`
        # en los ocho teclados de confirmacion. El unico sin uuid es el "Mejor
        # no" de las listas (`no:x`), que es el centinela.
        crudo = partes[1] if len(partes) > 1 else ""
        if crudo in _NO_HAY_BORRADOR:
            # `no:x:<pregunta>` ya la puso en el foco. Un `no:x` suelto (un teclado de
            # antes de este cambio) se trata como el "no" escrito: cancela en la base,
            # y solo si se sabe cual. Antes apagaba el foco solo en RAM (S7).
            await _cancelar_lo_dicho(update, chat)
            return
        await update.effective_message.reply_text(_cancelar_de_verdad(chat, crudo))
    elif accion == "cat":
        dato = _memoria.get(chat)
        if not dato:
            await update.effective_message.reply_text("Ya no tengo ese borrador. Dictamelo otra vez.")
            return
        vivas = dato.get("categorias") or list(_catalogo)
        # Se guarda la lista EXACTA que se ofrecio: el indice del boton solo
        # significa algo contra ella, no contra lo que el catalogo diga despues.
        dato["categorias_ofrecidas"] = list(vivas)
        await update.effective_message.reply_text(
            "Cual es?", reply_markup=_teclado_categorias(vivas, dato.get("borrador_id")))
    elif accion == "setcat":
        dato = _memoria.get(chat) or {}
        ofrecidas = dato.get("categorias_ofrecidas") or dato.get("categorias") or []
        # El teclado de categorias es el mismo para capturar y para corregir,
        # pero el camino NO. Sin esta bifurcacion, cambiarle la categoria a un
        # movimiento ya escrito lo volveria a proponer como un gasto NUEVO: dos
        # filas donde deberia haber una corregida.
        if dato.get("tipo") == "correccion_eligiendo":
            try:
                i = int(partes[1])
            except (ValueError, IndexError, TypeError):
                await update.effective_message.reply_text("No entendi ese boton. Dimelo otra vez.")
                return
            try:
                nueva = None if i == -1 else ofrecidas[i]
            except IndexError:
                await update.effective_message.reply_text("Esa categoria ya no esta en la lista.")
                return
            if not nueva:
                await update.effective_message.reply_text("Para corregir la categoria tienes que escoger una.")
                return
            await _proponer_correccion_de_campo(update, chat, "categoria", nueva)
            return
        try:
            i = int(partes[1])
        except (ValueError, IndexError, TypeError):
            await update.effective_message.reply_text("No entendi ese boton. Dictamelo otra vez.")
            return
        if i == -1:
            nueva = None
        else:
            try:
                nueva = ofrecidas[i]
            except IndexError:
                await update.effective_message.reply_text("Esa categoria ya no esta en la lista. Dictamelo otra vez.")
                return
        await _reproponer(update, chat, {"propuesta": {"categoria": nueva}})
    elif accion == "monto":
        _esperando_monto[chat] = _borrador_vivo(chat) or True
        await update.effective_message.reply_text("De cuanto fue? Solo el numero.")
    elif accion == "cta":
        dato = _memoria.get(chat) or {}
        cuentas = dato.get("cuentas") or []
        if "cuentas" not in dato:
            # Rehidratada tras un reinicio: no se sabe cuantas hay, y decir "una"
            # seria inventarlo.
            await update.effective_message.reply_text(
                "Esa propuesta la recupere de la base despues de un reinicio y no tengo "
                "su detalle para cambiarle la cuenta. Dale VA asi o cancelala y dictamela otra vez.")
        elif len(cuentas) < 2:
            await update.effective_message.reply_text("Solo tienes una cuenta dada de alta; no hay a cual cambiar.")
        else:
            await update.effective_message.reply_text(
                "Contra cual?", reply_markup=_teclado_cuentas(cuentas, dato.get("borrador_id")))
    elif accion == "setcta":
        dato = _memoria.get(chat) or {}
        cuentas = dato.get("cuentas") or []
        try:
            elegida = cuentas[int(partes[1])]
        except (ValueError, IndexError, TypeError):
            await update.effective_message.reply_text("Esa cuenta ya no esta en la lista. Dictamelo otra vez.")
            return
        # Las dos fases comparten el boton de cuenta, pero NO la ruta que
        # repropone. Sin esta bifurcacion, cambiarle la cuenta a una venta la
        # volveria a proponer como gasto: el peor error posible en este archivo.
        if dato.get("tipo") == "venta":
            peticion = dict(dato.get("peticion") or {})
            peticion["id_cuenta"] = elegida["id"]
            await _proponer_venta(update, chat, peticion)
            return
        # Y al abono igual: sin esto se volveria a proponer como gasto.
        if dato.get("tipo") == "abono":
            if not dato.get("propuesta"):
                await update.effective_message.reply_text(
                    "Esa propuesta la recupere despues de un reinicio y no tengo su detalle "
                    "para cambiarle la cuenta. No escribi nada. Cancelala y dictamela otra vez.")
                return
            await _proponer_abono(update, chat, dato.get("propuesta"), id_deudor=dato.get("id_deudor"),
                                  cuenta={"id_cuenta": elegida["id"]})
            return
        await _reproponer(update, chat, {"id_cuenta": elegida["id"]})
    elif accion == "setsug":
        dato = _memoria.get(chat) or {}
        try:
            nueva = (dato.get("sugeridas") or [])[int(partes[1])]
        except (ValueError, IndexError, TypeError):
            await update.effective_message.reply_text("Esa categoria ya no esta en la lista. Dictamelo otra vez.")
            return
        await _reproponer(update, chat, {"propuesta": {"categoria": nueva, "categoria_nueva": None}})


async def _consulta_directa(update, consulta, filtro=None):
    """Los comandos /stock /cartera /ventas: la consulta SIN pasar por el modelo.

    Existe por latencia, no por seguridad: el camino de lenguaje natural paga
    DOS llamadas al modelo (una para descartar el gasto y otra para clasificar
    la pregunta). Lo que se usa a diario no tiene por que pagar eso, y ademas
    un comando escrito no se puede clasificar mal.
    """
    chat = _clave_de(update)
    await update.effective_message.chat.send_action("typing")
    estado, r = _post("/api/bot/consulta", {
        "telegram_id": chat, "consulta": consulta, "filtro": filtro,
    })
    log.info("comando /%s filtro=%s -> %s", consulta, filtro, estado)
    if estado != 200 or not r.get("ok"):
        await update.effective_message.reply_text(r.get("error", "No pude consultarlo."))
        return
    await _contestar_texto_de_consulta(update, chat, r)


@_con_puerta
async def comando_ticket(update, context):
    """/ticket <folio, monto o proveedor>: reenvia la foto del ticket."""
    await _mostrar_ticket(update, _clave_de(update), " ".join(context.args or []))


@_con_puerta
async def comando_stock(update, context):
    await _consulta_directa(update, "stock", " ".join(context.args or []).strip() or None)


@_con_puerta
async def comando_cartera(update, context):
    await _consulta_directa(update, "cartera")


@_con_puerta
async def comando_precios(update, context):
    await _consulta_directa(update, "precios", " ".join(context.args or []).strip() or None)


@_con_puerta
async def comando_registrar(update, context):
    """/registrar <nombre>, contestando al mensaje de la persona (D95)."""
    chat = _clave_de(update)
    texto = (update.message.text or "").strip() if update.message else ""
    if not await _quiza_registro(update, chat, texto):
        await update.effective_message.reply_text(
            "Se usa contestando al mensaje de la persona: /registrar Gilberto")


@_con_puerta
async def comando_ventas(update, context):
    await _consulta_directa(update, "ventas")


@_con_puerta
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
    chat = _clave_de(update)
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
    await _proponer_abono(update, chat,
                          {"monto": monto, "metodo_pago": None,
                           "nota": None, "fecha": None},
                          nombre=nombre)


@_con_puerta
async def comando_entrega(update, context):
    """`/entrega <monto> [nombre]` — FASE 11 (D112). El DST entrega a la matriz
    el efectivo que cobro de contado. Sin modelo, por la misma razon que /abono.

    El monto es el PRIMER token; lo de despues, de quien (solo la matriz lo
    dice: un DST sin nombre habla de si mismo, y con el nombre de otro el
    servidor le contesta que no). El servidor decide quien puede y si espera.
    """
    chat = _clave_de(update)
    args = list(context.args or [])
    if not args:
        await update.effective_message.reply_text(
            "Se usa asi: /entrega 3000" + NL
            + "(Norman o Kevin: /entrega 3000 Gilberto)")
        return
    crudo = args[0].replace("$", "").replace(",", "")
    try:
        monto = float(crudo)
    except ValueError:
        await update.effective_message.reply_text(
            "No lei \"" + args[0] + "\" como monto. El primer dato tiene que ser el numero.")
        return
    nombre = " ".join(args[1:]).strip() or None
    await update.effective_message.chat.send_action("typing")
    await _proponer_entrega(update, chat, monto, nombre=nombre)


@_con_puerta
async def comando_anular(update, context):
    """/anular — la lista, sin pasar por el modelo. Igual que /stock.

    Existe por latencia y por confianza, no por seguridad: el camino de lenguaje
    natural paga una llamada al modelo para decidir que "cancela el gasto de
    ayer" es una anulacion y no un gasto. Lo que se usa a diario no tiene por que
    pagar eso, y ademas un comando escrito no se puede clasificar mal -- que en
    este camino importa mas que en los otros, porque leer "anula" como "gasto"
    escribe una fila de dinero que nadie pidio.

    No anula nada: ofrece la lista. Lo que anula es el "va".
    """
    chat = _clave_de(update)
    await update.effective_message.chat.send_action("typing")
    await _proponer_anulacion(update, chat, {"telegram_id": chat}, accion="anular")


@_con_puerta
async def comando_corregir(update, context):
    """/corregir — la misma lista, y despues se pregunta que campo."""
    chat = _clave_de(update)
    await update.effective_message.chat.send_action("typing")
    await _proponer_anulacion(update, chat, {"telegram_id": chat}, accion="corregir")


@_con_puerta
async def comando_alta(update, context):
    """/alta — el alta sin pasar por el modelo. Misma razon que /anular.

    Empieza preguntando el nombre, porque es lo unico que el modelo aportaba en
    este camino. Todo lo demas ya iba por boton.
    """
    chat = _clave_de(update)
    _memoria[chat] = {"tipo": "alta_eligiendo", "campo": "nombre",
                      "peticion": {"telegram_id": chat}, "opciones": []}
    _esperando_alta[chat] = "nombre"
    await update.effective_message.reply_text(
        "Va. Como se llama el distribuidor o el local?")


@_con_puerta
async def comando_convertir(update, context):
    """/convertir — la lista de cotizaciones abiertas, sin modelo."""
    chat = _clave_de(update)
    await update.effective_message.chat.send_action("typing")
    await _proponer_conversion(update, chat, {"telegram_id": chat})


@_con_puerta
async def comando_inicio(update, context):
    await update.message.reply_text(
        "Soy el bot del ERP. Capturo y consulto." + NL + NL
        + "PARA CAPTURAR, dime lo que gastaste como lo dirias en persona, por"
          " texto o nota de voz:" + NL
        + '  "gaste 340 de gasolina yendo a Zacatecas"' + NL
        + "Te enseno la fila exacta antes de escribir nada. Nada entra sin tu VA." + NL
        + "O mandame la FOTO del ticket: la leo y te propongo el gasto. Queda ligada al"
          " movimiento; \"muestrame el ticket de la gasolina\" o /ticket 500 te la regresa."
        + NL + NL
        + "PARA CONSULTAR:" + NL
        + "  /stock            que hay, y donde" + NL
        + "  /stock chile 750  solo de un producto, o de un punto de venta" + NL
        + "  /cartera          quien debe, cuanto, y desde cuando" + NL
        + "  /ventas           los ultimos 6 meses" + NL + NL
        + "PARA REGISTRAR UN PAGO QUE TE HICIERON:" + NL
        + "  /abono Gilberto 5000   o dilo hablando: \"me deposito Gilberto 5 mil\"" + NL
        + "Te enseno a que pedidos se aplica ANTES de escribir nada." + NL
        + "  /entrega 3000     el efectivo que cobraste de contado y ya le entregaste"
          " a la matriz (no es abono de concesion)" + NL
        + "Tambien puedes preguntarlo hablando: \"cuanto me debe Delirio\"." + NL + NL
        + "PARA DESHACER O CORREGIR ALGO QUE YA QUEDO ESCRITO:" + NL
        + "  /anular           te enseno los ultimos y escoges con un boton" + NL
        + "  /corregir         igual, y despues te pregunto que le cambio" + NL
        + "Nunca te voy a pedir que me digas cual de oido: siempre lo escoges de"
          " una lista." + NL + NL
        + "Los numeros salen de las vistas del ERP, nunca del modelo.")


async def manejar_no_autorizado(update, context):
    # Un telegram_id sin alta no escribe y tampoco averigua nada del sistema.
    log.warning("mensaje de chat no dado de alta: %s", update.effective_chat.id)


def _version_cargada():
    """La fecha del `.py` mas nuevo de `bot/`, tal como estaba AL ARRANCAR.

    **Python carga el modulo al arrancar; editar el `.py` no cambia el proceso.**
    Esto se calcula una sola vez, en el momento del arranque, asi que si alguien
    edita el codigo mientras el bot corre, este numero se queda con la version
    que de verdad esta en memoria -- que es justo el dato que faltaba.
    """
    mas_nuevo = 0.0
    for archivo in Path(__file__).parent.glob("*.py"):
        try:
            mas_nuevo = max(mas_nuevo, archivo.stat().st_mtime)
        except OSError:
            continue
    return mas_nuevo


# Se fija al importar, no al latir. Ver `_version_cargada`.
ARRANCADO_EN = time.time()
VERSION_CARGADA = _version_cargada()


async def _latir(app):
    """El latido. Su valor es el silencio: sin lineas durante mas de 15 min, el
    bot esta colgado aunque el proceso siga en la lista de tareas (E-25).

    ─── D22, 2026-09-19: EL LATIDO DEJA DE MENTIR ──────────────────────────────

    El 2026-09-18 a las 10:44 arranco un proceso. El 2026-09-19 a las 09:49 se
    edito `bot_gastos.py` con toda la Fase 5 dentro. **El bot siguio sirviendo el
    codigo de antes durante 24 horas**, y en ese rato escribio noventa y seis
    latidos diciendo *"vivo, 0 borradores en memoria"*. Cada uno era **verdadero**.

    Norman corrio su prueba de cinco minutos y el bot contesto disparates:
    `/anular` no dejo ni una linea en el log (para ese proceso el comando no
    existia), y *"anula el movimiento anterior"* salio como charla. No era un
    defecto de la Fase 5: **era que la Fase 5 nunca se cargo.**

    *"Vivo"* sin decir QUE VERSION esta viva es lo que dejo pasar esto. Desde hoy
    el latido publica la hora de arranque y la fecha del `.py` mas nuevo que
    cargo, que es lo que el vigilante compara.
    """
    while True:
        await asyncio.sleep(INTERVALO_LATIDO)
        log.info(
            "latido: vivo, %d borrador(es) en memoria | arranque %s | codigo %s",
            max(len(_memoria), sum(len(v) for v in _pendientes.values())),
            dt.datetime.fromtimestamp(ARRANCADO_EN).strftime("%Y-%m-%d %H:%M:%S"),
            dt.datetime.fromtimestamp(VERSION_CARGADA).strftime("%Y-%m-%d %H:%M:%S"),
        )
        # Lote v2: el ciclo del lote cuelga del latido (recordatorios UNA vez,
        # reclamados en la base; temperatura de Open-Meteo con reintento).
        try:
            await lote_ciclo.tick(app.bot, _post)
        except Exception as e:  # el latido no se cae por el ciclo
            log.warning("ciclo del lote: %s: %s", type(e).__name__, e)


async def _al_arrancar(app):
    app.create_task(_latir(app))
    # Cazador F0 (WP-2a): vaciar la cola local, avisar si hubo apagon > 12 h, y
    # reintentar cada minuto lo que no se pudo escribir.
    bitacora.configurar(api=API, token=TOKEN_API, ensayo=ENSAYO)
    await bitacora.al_arrancar(app)
    app.create_task(bitacora.reintentar_cada_tanto())


def _candado():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", PUERTO_CANDADO))
    except OSError:
        print("Ya hay otra instancia del bot de gastos corriendo. Salgo.")
        sys.exit(1)
    return s


async def manejar_error(update, context):
    """Sin esto, python-telegram-bot escribe *"No error handlers are
    registered"* y vuelca un traceback de 30 lineas por cada hipo de la red.

    El 2026-09-12 hubo 9 de esos, todos por `Bad Gateway` o `ReadError` de
    api.telegram.org -- transitorios, que la libreria ya reintenta sola. El
    traceback no aportaba nada y enterraba lo que si importaba.

    **Y la mitad que de verdad cuenta:** si el error salta a medio encargo, el
    usuario se queda mirando una pantalla que no contesta. Aqui al menos se le
    dice, que es lo unico peor que fallar: fallar en silencio.
    """
    err = context.error
    transitorio = isinstance(err, (NetworkError, TimedOut))
    if transitorio:
        log.warning("red inestable con Telegram (%s). La libreria reintenta.",
                    type(err).__name__)
        return
    log.error("error no atendido: %s", err, exc_info=err)
    try:
        if isinstance(update, Update) and update.effective_message:
            await update.effective_message.reply_text(
                "Algo se me rompio aqui adentro y NO escribi nada. "
                "Vuelve a dictarmelo, porfa.")
    except Exception:
        pass


def main():
    if not TOKEN_TG:
        print("Falta BOT_GASTOS_TELEGRAM_TOKEN. Ver bot/LEEME.md")
        sys.exit(1)
    if not TOKEN_API or len(TOKEN_API) < 24:
        print("Falta BOT_API_TOKEN (minimo 24 caracteres). Ver bot/LEEME.md")
        sys.exit(1)

    candado = _candado()  # noqa: F841 - vive hasta que muere el proceso
    if ENSAYO:
        log.warning("%s BOT_ENSAYO puesto: ninguna ruta /confirmar sale, los "
                    "borradores no se guardan. Log: %s", AVISO_ENSAYO, RUTA_LOG)
    log.info("arrancando bot de gastos contra %s | codigo del %s", API,
             dt.datetime.fromtimestamp(VERSION_CARGADA).strftime("%Y-%m-%d %H:%M:%S"))

    # Cazador F0 (WP-2a): el bot que anota en la bitacora todo lo que dice. Los
    # dos `HTTPXRequest` son los MISMOS defaults del builder (256 conexiones para
    # mandar, 1 para getUpdates): pasar un bot propio no debe cambiar la red.
    # La bitacora se ENCIENDE en `_al_arrancar` (post_init), que solo corre con
    # el polling de verdad: una prueba que llama a main() con una app falsa la
    # deja apagada y no escribe a ninguna API.
    bot = bitacora.clase_bot()(
        TOKEN_TG,
        request=HTTPXRequest(connection_pool_size=256, media_write_timeout=MEDIA_WRITE_TIMEOUT),
        get_updates_request=HTTPXRequest(connection_pool_size=1))
    app = Application.builder().bot(bot).post_init(_al_arrancar).build()
    # Grupo -1: corre ANTES que cualquier otro handler y no corta la cadena.
    # Todo mensaje (texto, voz, boton, edicion) queda escrito antes de procesarse.
    app.add_handler(TypeHandler(Update, bitacora.anotar_update), group=-1)
    # 2026-11-03: grupos silenciosos. Va PRIMERO en el grupo 0: lo que acepta aqui
    # ya quedo en la bitacora y no lo ve ningun otro handler.
    app.add_handler(_Silencio())
    app.add_handler(CommandHandler("start", comando_inicio))
    app.add_handler(CommandHandler("stock", comando_stock))
    app.add_handler(CommandHandler("cartera", comando_cartera))
    app.add_handler(CommandHandler("precios", comando_precios))
    app.add_handler(CommandHandler("registrar", comando_registrar))
    app.add_handler(CommandHandler("ventas", comando_ventas))
    app.add_handler(CommandHandler("abono", comando_abono))
    app.add_handler(CommandHandler("entrega", comando_entrega))
    app.add_handler(CommandHandler("anular", comando_anular))
    app.add_handler(CommandHandler("corregir", comando_corregir))
    app.add_handler(CommandHandler("alta", comando_alta))
    app.add_handler(CommandHandler("convertir", comando_convertir))
    app.add_handler(CommandHandler("ticket", comando_ticket))
    app.add_handler(CallbackQueryHandler(manejar_boton))
    app.add_handler(MessageHandler(filters.VOICE, manejar_voz))
    # Solo mensajes nuevos: editar el pie llega como `edited_message`, y ahi
    # `update.message` es None y la foto ya se atendio cuando llego.
    app.add_handler(MessageHandler((filters.PHOTO | filters.Document.IMAGE) & filters.UpdateType.MESSAGE,
                                   manejar_foto))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, manejar_texto))
    app.add_handler(MessageHandler(filters.StatusUpdate.NEW_CHAT_MEMBERS, manejar_entrada))
    app.add_error_handler(manejar_error)
    # drop_pending_updates=False (el default, ahora explicito): lo que Telegram
    # guardo mientras el bot estaba apagado se procesa al arrancar (WP-2a).
    app.run_polling(allowed_updates=Update.ALL_TYPES, drop_pending_updates=False)


if __name__ == "__main__":
    main()
