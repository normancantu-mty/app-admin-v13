# -*- coding: utf-8 -*-
"""Cazador F0 · WP-2a — LA BITACORA: que ningun mensaje se pierda.

Escrito el 2026-10-17 por el ejecutor B del Socio.

QUE HACE
--------
Escribe en `public.bitacora` (via `POST /api/bot/bitacora`, la misma API y el
mismo `x-bot-token` que el resto del bot: el bot no tiene credenciales de
Supabase, a proposito) **antes** de que el mensaje se procese:

  · todo mensaje de grupo y de privado          -> origen grupo | privado | voz
  · cada transcripcion de voz                   -> origen voz, con `transcripcion`
  · cada respuesta del bot                      -> origen bot (`procesado=true`)

Si la API no contesta, la fila va a una COLA LOCAL (`.jsonl`) y se reintenta:
al siguiente mensaje que si se pueda escribir, cada `INTERVALO_REINTENTO_S` y al
arrancar. La `clave` es idempotente (`tg:<chat>:<mensaje>:<origen>`) y la base
hace `ON CONFLICT (clave) DO NOTHING`, asi que un reintento nunca duplica.

Lo que NO hace: decidir nada. No llama al modelo, no lee el ERP. Si esta caido,
el bot sigue como siempre; lo unico que cambia es que la fila espera en disco.

EN ENSAYO (`BOT_ENSAYO=1`) no escribe en ningun lado: un ensayo no deja rastro
en la base de produccion (D60), y el conjunto de oro corre en ensayo.

POR QUE UN MODULO Y NO CODIGO EN `bot_gastos.py`
------------------------------------------------
Decision de Norman (2026-10-17): el codigo nuevo nace en modulos nuevos y el
monolito solo se toca para enchufarlos. Los enchufes son tres: un handler en el
grupo -1 de python-telegram-bot (corre ANTES que todos), la transcripcion en
`manejar_voz` y un `ExtBot` que anota lo que sale (`BotQueAnota`).
"""

import datetime as dt
import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

log = logging.getLogger("bot_gastos.bitacora")

RAIZ = Path(__file__).resolve().parent
# `bot/_audios/` ya esta en .gitignore: la cola no se commitea nunca.
DIRECTORIO = Path(os.environ.get("BOT_BITACORA_DIR") or (RAIZ / "_audios" / "_bitacora"))
RUTA = "/api/bot/bitacora"
INTERVALO_REINTENTO_S = 60
TIMEOUT_S = 6
# El apagon a partir del cual se le avisa a Norman al arrancar (plan v3, WP-2a).
APAGON_AVISO_H = 12
TOPE_LOTE = 50

_VALORES_SI = ("1", "si", "true", "yes", "on")

_candado = threading.Lock()
_config = {
    "api": os.environ.get("ERP_API_URL", "http://localhost:3000").rstrip("/"),
    "token": os.environ.get("BOT_API_TOKEN", ""),
    "ensayo": str(os.environ.get("BOT_ENSAYO") or "").strip().lower() in _VALORES_SI,
    "enviar": None,   # se dobla en las pruebas: f(cuerpo) -> (status, objeto)
    # APAGADA al importar. Solo `bot_gastos.main()` la prende (o una prueba con
    # su propio `enviar` y su propio directorio). Sin esto, cualquier prueba que
    # haga `import bot_gastos` escribiria en la bitacora de PRODUCCION -- el
    # mismo defecto que D46 cerro para el log.
    "activa": False,
}


def configurar(api=None, token=None, ensayo=None, enviar=None, directorio=None, activa=True):
    """Lo llama `bot_gastos.main()` (mismo API, token y ensayo) y las pruebas."""
    global DIRECTORIO
    _config["activa"] = bool(activa)
    if api is not None:
        _config["api"] = str(api).rstrip("/")
    if token is not None:
        _config["token"] = token
    if ensayo is not None:
        _config["ensayo"] = bool(ensayo)
    _config["enviar"] = enviar
    if directorio is not None:
        DIRECTORIO = Path(directorio)


def ruta_cola():
    return DIRECTORIO / "pendiente.jsonl"


def ruta_estado():
    return DIRECTORIO / "estado.json"


# ─── LO PURO ────────────────────────────────────────────────────────────────

def clave_de(chat_id, mensaje_id, origen):
    """La clave idempotente. **Pura.** Un mismo mensaje de Telegram y un mismo
    origen dan siempre la misma clave: el reintento y la redelivery de Telegram
    no duplican."""
    return "tg:%s:%s:%s" % (chat_id, mensaje_id, origen)


def origen_de_chat(chat_tipo, es_voz=False):
    """grupo | privado | voz. **Pura.**"""
    if es_voz:
        return "voz"
    return "privado" if str(chat_tipo or "") == "private" else "grupo"


def _fecha(mensaje):
    f = getattr(mensaje, "date", None)
    if isinstance(f, dt.datetime):
        return f.isoformat()
    return dt.datetime.now(dt.timezone.utc).isoformat()


def _persona(usuario):
    if usuario is None:
        return None
    nombre = " ".join(p for p in (getattr(usuario, "first_name", None),
                                  getattr(usuario, "last_name", None)) if p)
    arroba = getattr(usuario, "username", None)
    if arroba:
        nombre = (nombre + " (@" + arroba + ")") if nombre else "@" + arroba
    return nombre or None


def fila_de_entrada(mensaje, usuario=None):
    """La fila de un mensaje que LLEGA. **Pura** (solo lee atributos). `None` si
    no hay nada que guardar (un update sin mensaje: un boton, un cambio de
    estado sin texto)."""
    if mensaje is None:
        return None
    chat = getattr(mensaje, "chat", None)
    chat_id = getattr(chat, "id", None) if chat is not None else getattr(mensaje, "chat_id", None)
    chat_tipo = getattr(chat, "type", None) if chat is not None else None
    voz = getattr(mensaje, "voice", None) or getattr(mensaje, "audio", None)
    texto = getattr(mensaje, "text", None) or getattr(mensaje, "caption", None)
    adjunto = None
    if voz is not None:
        adjunto = getattr(voz, "file_id", None)
    else:
        for tipo in ("document", "photo", "video", "video_note"):
            a = getattr(mensaje, tipo, None)
            if a:
                a = a[-1] if isinstance(a, (list, tuple)) else a
                adjunto = getattr(a, "file_id", None)
                break
    if not texto and voz is None and adjunto is None:
        return None
    usuario = usuario if usuario is not None else getattr(mensaje, "from_user", None)
    origen = origen_de_chat(chat_tipo, es_voz=voz is not None)
    responde = getattr(mensaje, "reply_to_message", None)
    mensaje_id = getattr(mensaje, "message_id", None)
    return {
        "clave": clave_de(chat_id, mensaje_id, origen),
        "origen": origen,
        "chat_id": chat_id,
        "chat_tipo": chat_tipo,
        "telegram_id": getattr(usuario, "id", None),
        "persona": _persona(usuario),
        "mensaje_id": mensaje_id,
        "fecha": _fecha(mensaje),
        "texto": texto,
        "adjunto_ref": adjunto,
        "respuesta_a": getattr(responde, "message_id", None) if responde is not None else None,
        "procesado": False,
    }


def fila_de_transcripcion(mensaje, transcripcion):
    """La transcripcion de una nota de voz: SU PROPIA fila (`:transcripcion`),
    porque la de la nota ya se escribio antes de transcribir y es solo-agregar."""
    base = fila_de_entrada(mensaje) or {}
    chat = getattr(mensaje, "chat", None)
    chat_id = getattr(chat, "id", None)
    mensaje_id = getattr(mensaje, "message_id", None)
    base.update({
        "clave": clave_de(chat_id, mensaje_id, "voz") + ":transcripcion",
        "origen": "voz",
        "texto": None,
        "transcripcion": str(transcripcion or ""),
    })
    return base


def fila_de_salida(chat_id, mensaje_enviado, texto, respuesta_a=None, adjunto_ref=None):
    """Lo que dice el bot. `procesado=true`: no es algo que haya que atender."""
    mensaje_id = getattr(mensaje_enviado, "message_id", None)
    if mensaje_id is None:
        mensaje_id = "x%d" % int(time.time() * 1000)
    chat = getattr(mensaje_enviado, "chat", None)
    return {
        "clave": clave_de(chat_id, mensaje_id, "bot"),
        "origen": "bot",
        "chat_id": chat_id,
        "chat_tipo": getattr(chat, "type", None) if chat is not None else None,
        "telegram_id": None,
        "persona": "bot",
        "mensaje_id": mensaje_id if isinstance(mensaje_id, int) else None,
        "fecha": dt.datetime.now(dt.timezone.utc).isoformat(),
        "texto": texto,
        "adjunto_ref": adjunto_ref,
        "respuesta_a": respuesta_a,
        "procesado": True,
    }


def apagon_horas(ultimo_visto, ahora=None):
    """Horas desde lo ultimo que se escribio. **Pura.** `None` si nunca."""
    if not ultimo_visto:
        return None
    ahora = time.time() if ahora is None else ahora
    return max(0.0, (ahora - float(ultimo_visto)) / 3600.0)


def hay_que_avisar_apagon(ultimo_visto, ahora=None, umbral_h=APAGON_AVISO_H):
    h = apagon_horas(ultimo_visto, ahora)
    return h is not None and h > umbral_h


# ─── LO QUE TOCA RED Y DISCO ────────────────────────────────────────────────

def _enviar_de_verdad(cuerpo):
    datos = json.dumps(cuerpo, ensure_ascii=False, default=str).encode("utf-8")
    pet = urllib.request.Request(
        _config["api"] + RUTA, data=datos, method="POST",
        headers={"Content-Type": "application/json", "x-bot-token": _config["token"]})
    try:
        with urllib.request.urlopen(pet, timeout=TIMEOUT_S) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8"))
        except Exception:
            return e.code, {"error": "error %s" % e.code}
    except Exception as e:
        return 0, {"error": str(e)}


def _enviar(cuerpo):
    f = _config.get("enviar") or _enviar_de_verdad
    try:
        return f(cuerpo)
    except Exception as e:  # una prueba o la red; nunca revienta al bot
        return 0, {"error": str(e)}


def _a_la_cola(operacion):
    DIRECTORIO.mkdir(parents=True, exist_ok=True)
    with open(ruta_cola(), "a", encoding="utf-8") as f:
        f.write(json.dumps(operacion, ensure_ascii=False, default=str) + "\n")


def _leer_cola():
    try:
        with open(ruta_cola(), encoding="utf-8") as f:
            lineas = [l for l in f.read().splitlines() if l.strip()]
    except FileNotFoundError:
        return []
    ops = []
    for l in lineas:
        try:
            ops.append(json.loads(l))
        except json.JSONDecodeError:
            log.error("bitacora: linea ilegible en la cola, se conserva aparte: %r", l[:200])
            with open(DIRECTORIO / "ilegibles.jsonl", "a", encoding="utf-8") as g:
                g.write(l + "\n")
    return ops


def _reescribir_cola(ops):
    if not ops:
        try:
            ruta_cola().unlink()
        except FileNotFoundError:
            pass
        return
    temporal = ruta_cola().with_suffix(".tmp")
    with open(temporal, "w", encoding="utf-8") as f:
        for op in ops:
            f.write(json.dumps(op, ensure_ascii=False, default=str) + "\n")
    os.replace(temporal, ruta_cola())


def _marcar_visto(ahora=None):
    try:
        DIRECTORIO.mkdir(parents=True, exist_ok=True)
        estado = leer_estado()
        estado["ultimo_visto"] = time.time() if ahora is None else ahora
        temporal = ruta_estado().with_suffix(".tmp")
        with open(temporal, "w", encoding="utf-8") as f:
            json.dump(estado, f)
        os.replace(temporal, ruta_estado())
    except OSError as e:
        log.warning("bitacora: no pude guardar el estado: %s", e)


def leer_estado():
    try:
        with open(ruta_estado(), encoding="utf-8") as f:
            d = json.load(f)
            return d if isinstance(d, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def _mandar_operacion(op):
    """True si la API la acepto. Las operaciones son las de la ruta."""
    estado, r = _enviar(op)
    return estado == 200 and isinstance(r, dict) and r.get("ok") is True


def _inerte():
    return _config["ensayo"] or not _config["activa"]


def reintentar():
    """Vacia la cola en orden. Devuelve (enviadas, quedan). Se detiene en el
    primer fallo: el orden importa (una etiqueta despues de su fila)."""
    if _inerte():
        return 0, 0
    with _candado:
        ops = _leer_cola()
        if not ops:
            return 0, 0
        enviadas = 0
        # Las `anotar` seguidas viajan juntas, de 50 en 50.
        i = 0
        while i < len(ops):
            op = ops[i]
            if op.get("accion") == "anotar":
                j = i
                filas = []
                while j < len(ops) and ops[j].get("accion") == "anotar" and len(filas) < TOPE_LOTE:
                    filas.extend(ops[j].get("filas") or [])
                    j += 1
                if not _mandar_operacion({"accion": "anotar", "filas": filas[:TOPE_LOTE]}):
                    break
                enviadas += j - i
                i = j
            else:
                if not _mandar_operacion(op):
                    break
                enviadas += 1
                i += 1
        _reescribir_cola(ops[i:])
        if enviadas:
            log.info("bitacora: reintento, %d operacion(es) escritas, quedan %d",
                     enviadas, len(ops) - i)
            _marcar_visto()
        return enviadas, len(ops) - i


def _operar(op):
    """Manda una operacion; si no sale, a la cola. Nunca lanza. True si salio."""
    if _inerte():
        return True
    try:
        if ruta_cola().exists():
            # Lo viejo primero: si la cola no se vacia, lo nuevo se forma detras.
            _, quedan = reintentar()
            if quedan:
                with _candado:
                    _a_la_cola(op)
                return False
        if _mandar_operacion(op):
            if op.get("accion") == "anotar":
                _marcar_visto()
            return True
        log.warning("bitacora: la API no la acepto; va a la cola local (%s)", op.get("accion"))
        with _candado:
            _a_la_cola(op)
        return False
    except Exception as e:  # disco lleno, etc. Lo ultimo que se hace es callar.
        log.error("bitacora: no pude ni encolar (%s): %s", op.get("accion"), e)
        return False


def anotar(fila):
    if not fila:
        return False
    return _operar({"accion": "anotar", "filas": [fila]})


def etiquetar(clave, etiquetas):
    limpias = {k: v for k, v in (etiquetas or {}).items() if v not in (None, "")}
    if not clave or not limpias:
        return False
    return _operar({"accion": "etiquetar", "clave": clave, "etiquetas": limpias})


def marcar(claves, procesado=True):
    claves = [c for c in (claves or []) if c]
    if not claves:
        return False
    return _operar({"accion": "marcar", "claves": claves, "procesado": bool(procesado)})


def pendientes(limite=50):
    """Lo que espera proceso (`procesado=false`). Solo lectura; [] si falla."""
    if _inerte():
        return []
    estado, r = _enviar({"accion": "pendientes", "limite": int(limite)})
    if estado == 200 and isinstance(r, dict) and r.get("ok"):
        return list(r.get("filas") or [])
    return []


def normans():
    """Los telegram_id a quienes se avisa un apagon (Norman: ADMIN sin marca).
    Sale de la base, no de una constante en este archivo."""
    if _inerte():
        return []
    estado, r = _enviar({"accion": "norman"})
    if estado == 200 and isinstance(r, dict) and r.get("ok"):
        return [int(x) for x in (r.get("telegram_ids") or [])]
    return []


# ─── EL BOT QUE ANOTA LO QUE DICE ───────────────────────────────────────────

def _clase_bot_que_anota():
    """Un `ExtBot` cuyos `send_message` / `send_voice` / `edit_message_text`
    anotan en la bitacora lo que salio. **Es el unico enchufe de salida**: todo
    `reply_text` del monolito termina en `send_message`."""
    from telegram.ext import ExtBot

    class BotQueAnota(ExtBot):
        async def send_message(self, chat_id, text, *a, **k):
            enviado = await super().send_message(chat_id, text, *a, **k)
            await _anotar_salida(chat_id, enviado, text, k)
            return enviado

        async def send_voice(self, chat_id, voice, *a, **k):
            enviado = await super().send_voice(chat_id, voice, *a, **k)
            texto = k.get("caption") or "[audio]"
            await _anotar_salida(chat_id, enviado, texto, k, adjunto="voz")
            return enviado

        async def edit_message_text(self, text, *a, **k):
            enviado = await super().edit_message_text(text, *a, **k)
            chat_id = k.get("chat_id") or getattr(getattr(enviado, "chat", None), "id", None)
            await _anotar_salida(chat_id, None, text, k, adjunto="edicion")
            return enviado

    return BotQueAnota


async def _anotar_salida(chat_id, enviado, texto, kwargs, adjunto=None):
    import asyncio
    try:
        responde = None
        rp = kwargs.get("reply_parameters")
        if rp is not None:
            responde = getattr(rp, "message_id", None)
        responde = responde or kwargs.get("reply_to_message_id")
        fila = fila_de_salida(chat_id, enviado, texto, respuesta_a=responde, adjunto_ref=adjunto)
        await asyncio.to_thread(anotar, fila)
    except Exception as e:
        log.error("bitacora: no pude anotar la salida: %s", e)


def clase_bot():
    return _clase_bot_que_anota()


# ─── LOS ENCHUFES DEL BOT ───────────────────────────────────────────────────

def clave_de_update(update):
    """La clave con la que `anotar_update` guardo este update. **Pura.** `None`
    si no guardo nada. La usan `marcar` (procesado) y la NOTA (etiquetas)."""
    fila = fila_de_update(update)
    return fila.get("clave") if fila else None


def fila_de_update(update):
    """La fila de CUALQUIER update que trae algo dicho. **Pura.** Un boton
    (callback) se guarda como `[boton] <data>`: es una decision de la persona,
    y sin esto el VA de un lote no quedaria en el documento."""
    q = getattr(update, "callback_query", None)
    if q is not None:
        m = getattr(q, "message", None)
        chat = getattr(m, "chat", None)
        chat_id = getattr(chat, "id", None)
        origen = origen_de_chat(getattr(chat, "type", None))
        usuario = getattr(q, "from_user", None)
        return {
            "clave": clave_de(chat_id, "cb" + str(getattr(q, "id", "")), origen),
            "origen": origen,
            "chat_id": chat_id,
            "chat_tipo": getattr(chat, "type", None),
            "telegram_id": getattr(usuario, "id", None),
            "persona": _persona(usuario),
            "mensaje_id": None,
            "fecha": dt.datetime.now(dt.timezone.utc).isoformat(),
            "texto": "[boton] " + str(getattr(q, "data", "") or ""),
            "respuesta_a": getattr(m, "message_id", None),
            "procesado": False,
        }
    editado = getattr(update, "edited_message", None)
    mensaje = editado or getattr(update, "message", None) or getattr(update, "channel_post", None)
    fila = fila_de_entrada(mensaje, getattr(update, "effective_user", None))
    if fila and editado is not None:
        # La edicion es otra cosa dicha: su propia fila (la primera no se pisa).
        fila["clave"] = fila["clave"] + ":editado:" + str(
            int(getattr(editado, "edit_date", None).timestamp())
            if isinstance(getattr(editado, "edit_date", None), dt.datetime) else int(time.time()))
    return fila


async def anotar_update(update, context=None):
    """Handler del grupo -1 de python-telegram-bot: corre ANTES que todos los
    demas y no corta la cadena. Escribe y sigue; si no pudo, la fila queda en
    la cola local."""
    import asyncio
    try:
        fila = fila_de_update(update)
        if fila:
            await asyncio.to_thread(anotar, fila)
    except Exception as e:
        log.error("bitacora: no pude anotar la entrada: %s", e)


# Las claves que NO se marcan procesadas aunque el handler termine: el tope de
# la suscripcion las deja aqui (se quedan `procesado=false`, en la cola).
EN_PAUSA = set()


async def marcar_procesado(update, extra=()):
    """Al terminar de atender un mensaje. Lo que quedo en pausa no se marca.

    `extra` (Lote v2, 2026-10-19): otras claves del MISMO mensaje que tambien se
    atendieron. Hoy, la fila `:transcripcion` de una nota de voz: se quedaba
    `procesado=false` para siempre porque aqui solo se marcaba la de la nota
    (bitacora id 3, humo del 2026-10-19). Si el mensaje quedo en pausa, no se
    marca ninguna."""
    import asyncio
    clave = clave_de_update(update)
    if not clave or clave in EN_PAUSA:
        return
    claves = [clave] + [c for c in (extra or ()) if c and c not in EN_PAUSA and c != clave]
    try:
        await asyncio.to_thread(marcar, claves, True)
    except Exception as e:
        log.error("bitacora: no pude marcar procesado: %s", e)


def texto_apagon(horas, pendientes_de_telegram=None):
    """El aviso a Norman. **Pura.**"""
    t = "Estuve apagado unas %d h. Lo que Telegram me guardo ya lo estoy procesando" % int(round(horas))
    t += ("; Telegram solo guarda 24 h, lo de antes no me llego." if horas > 24 else ".")
    return t


async def al_arrancar(app, ahora=None):
    """Al arrancar: vaciar la cola local y, si el apagon fue > 12 h, avisar a
    Norman por privado. Los updates que Telegram guardo los procesa
    `run_polling(drop_pending_updates=False)` solo: pasan por `anotar_update`
    como cualquier otro."""
    import asyncio
    if _inerte():
        return
    try:
        await asyncio.to_thread(reintentar)
    except Exception as e:
        log.error("bitacora: reintento al arrancar fallo: %s", e)
    ultimo = leer_estado().get("ultimo_visto")
    if not hay_que_avisar_apagon(ultimo, ahora):
        return
    horas = apagon_horas(ultimo, ahora)
    log.warning("bitacora: apagon de %.1f h; aviso a Norman", horas)
    ids = await asyncio.to_thread(normans)
    for tid in ids:
        try:
            await app.bot.send_message(tid, texto_apagon(horas))
        except Exception as e:
            log.warning("bitacora: no pude avisarle del apagon a %s: %s", tid, e)
    # Que el aviso no se repita en el siguiente arranque.
    _marcar_visto(ahora)


async def reintentar_cada_tanto(intervalo=INTERVALO_REINTENTO_S):
    """Cada minuto: vacia la cola si hay, y anota "sigo vivo". Lo segundo es lo
    que distingue un APAGON de una noche sin mensajes: sin el, un domingo
    callado se leeria como 12 h de bot muerto."""
    import asyncio
    while True:
        await asyncio.sleep(intervalo)
        if _inerte():
            continue
        _marcar_visto()
        if ruta_cola().exists():
            try:
                await asyncio.to_thread(reintentar)
            except Exception as e:
                log.error("bitacora: reintento fallo: %s", e)
