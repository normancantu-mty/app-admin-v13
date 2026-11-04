# -*- coding: utf-8 -*-
"""Los grupos donde el bot ESCUCHA y no habla. 2026-11-03.

Escrito el 2026-11-03 por el ejecutor del Socio (bot ERP, fotos + grupo Equipo).

Norman mete a @ERPFresnilloBot en "Fresnillo - Equipo" para que el Socio LEA
todo lo que se dice ahi (`Socio/asistente/vigia_grupos.py` lee la tabla
`bitacora` por chat_id). En ese grupo el bot:
  - SI anota cada update en la bitacora (el handler del grupo -1 de
    `bot_gastos.main()` corre antes que este y no se toca);
  - NO procesa pedidos del ERP, NO contesta, NO pregunta "quien es?".
  - Excepcion: un mensaje que menciona al bot (@ERPFresnilloBot) o que contesta
    a un mensaje del bot (que solo existe si antes alguien lo menciono). Los
    botones tampoco se callan: solo existen en mensajes que el bot mando.

LA LISTA: `bot/grupos_silenciosos.json` (ignorado por git: es estado de esta
maquina, como `bot/comprobantes/`):

    {"chats": [{"chat_id": -100..., "titulo": "Fresnillo - Equipo", "desde": "..."}]}

Se edita a mano para agregar o quitar uno. Y se llena SOLA: el primer update
de un grupo cuyo titulo contiene "Equipo" (tipicamente, cuando lo agregan) lo
registra. Si Telegram convierte el grupo en supergrupo (cambia el chat_id), el
id nuevo tambien entra.
"""
import datetime as dt
import io
import json
import os
import threading
import unicodedata
from pathlib import Path

RAIZ = Path(__file__).resolve().parent
PALABRA = "equipo"
_candado = threading.Lock()
_cache = {"mtime": None, "ids": frozenset()}


def archivo():
    return Path(os.environ.get("BOT_GRUPOS_SILENCIOSOS") or (RAIZ / "grupos_silenciosos.json"))


def _leer():
    ruta = archivo()
    try:
        with io.open(ruta, encoding="utf-8") as f:
            datos = json.load(f)
    except (OSError, ValueError):
        return {"chats": []}
    if not isinstance(datos, dict) or not isinstance(datos.get("chats"), list):
        return {"chats": []}
    return datos


def ids():
    """Los chat_id silenciosos. Se relee solo si el archivo cambio."""
    ruta = archivo()
    try:
        mtime = ruta.stat().st_mtime
    except OSError:
        mtime = None
    if mtime != _cache["mtime"]:
        salida = set()
        for c in _leer()["chats"]:
            try:
                salida.add(int(c.get("chat_id") if isinstance(c, dict) else c))
            except (TypeError, ValueError):
                continue
        _cache.update(mtime=mtime, ids=frozenset(salida))
    return _cache["ids"]


def agregar(chat_id, titulo=None):
    """Registra un grupo silencioso. True si era nuevo."""
    chat_id = int(chat_id)
    with _candado:
        if chat_id in ids():
            return False
        datos = _leer()
        datos["chats"].append({"chat_id": chat_id, "titulo": titulo,
                               "desde": dt.datetime.now().isoformat(timespec="seconds")})
        ruta = archivo()
        ruta.parent.mkdir(parents=True, exist_ok=True)
        tmp = ruta.with_suffix(".tmp")
        with io.open(tmp, "w", encoding="utf-8") as f:
            json.dump(datos, f, ensure_ascii=False, indent=1)
        os.replace(str(tmp), str(ruta))
        _cache["mtime"] = None
    return True


def _plano(s):
    s = unicodedata.normalize("NFD", str(s or "").lower())
    return "".join(c for c in s if unicodedata.category(c) != "Mn")


def titulo_de_equipo(titulo):
    return PALABRA in _plano(titulo)


def le_hablan(mensaje, usuario_bot, id_bot=None):
    """El mensaje menciona al bot o le contesta a un mensaje del bot. **Pura.**"""
    if mensaje is None:
        return False
    usuario = str(usuario_bot or "").lstrip("@").lower()
    texto = str(getattr(mensaje, "text", None) or getattr(mensaje, "caption", None) or "").lower()
    if usuario and ("@" + usuario) in texto:
        return True
    respondido = getattr(mensaje, "reply_to_message", None)
    autor = getattr(respondido, "from_user", None) if respondido is not None else None
    if autor is not None and getattr(autor, "is_bot", False):
        if id_bot is not None and getattr(autor, "id", None) == id_bot:
            return True
        arroba = str(getattr(autor, "username", "") or "").lower()
        if not usuario or not arroba or arroba == usuario:
            return True
    return False


def decidir(update, usuario_bot, id_bot=None):
    """True si este update se CALLA (ya quedo en la bitacora y aqui se para).
    Registra el grupo si su titulo dice "Equipo". Nunca lanza."""
    try:
        chat = getattr(update, "effective_chat", None)
        if chat is None or getattr(chat, "type", None) not in ("group", "supergroup"):
            return False
        if getattr(update, "callback_query", None) is not None:
            return False
        cid = int(chat.id)
        silencioso = cid in ids()
        if not silencioso and titulo_de_equipo(getattr(chat, "title", None)):
            agregar(cid, getattr(chat, "title", None))
            silencioso = True
        if not silencioso:
            return False
        mensaje = getattr(update, "effective_message", None)
        nuevo = getattr(mensaje, "migrate_to_chat_id", None) if mensaje is not None else None
        if nuevo:
            agregar(int(nuevo), getattr(chat, "title", None))
        return not le_hablan(mensaje, usuario_bot, id_bot)
    except Exception:
        # Ante la duda en un grupo que ya era silencioso, callar es lo barato.
        try:
            return int(update.effective_chat.id) in ids()
        except Exception:
            return False
