# -*- coding: utf-8 -*-
"""Cazador F0 - WP-V: la VOZ DE SALIDA del bot, y a quien va dirigida.

Escrito el 2026-10-17 por el ejecutor B del Socio.

`texto_a_voz()` es una COPIA (no un import cruzado) de
`Documents/Claude/Socio/asistente/hablar.py` (2026-08-06/16): edge-tts con la voz
es-MX-DaliaNeural y ffmpeg a OGG/OPUS, que es lo unico que `sendVoice` acepta
como nota de voz. Se quito el motor sapi: el bot no lo usa.

Cuando hay audio (`debe_hablar`), regla del plan v3 (WP-V):
  - si te hablaron en audio -> audio + el mismo texto;
  - si es una ronda/pregunta del cazador (la plantilla del lote) -> audio + texto;
  - un "registrado" (Listo., Aprobado., Anotado...) -> SOLO texto;
  - interruptor `BOT_AUDIO_SIEMPRE=1`: audio en todo.
En el grupo, la primera linea es la MENCION real de quien hablo (`@usuario`, o
`text_mention` si no tiene usuario), para que le llegue el aviso.

Es sincrona a proposito (como hablar.py): se llama con `asyncio.to_thread`.
"""
import asyncio
import os
import re
import shutil
import subprocess
from pathlib import Path

VOZ_DEFAULT = "es-MX-DaliaNeural"      # femenina, mexicana (hablar.py, 2026-08-16)
VELOCIDAD = "+10%"
_SI = ("1", "si", "true", "yes", "on")

# Lo que es un "registrado": va solo en texto.
_REGISTRO = re.compile(r"^\s*(?:✅|listo\b|aprobado\b|anotado\b|quedo escrito\b)", re.IGNORECASE)
# Las rondas/preguntas del cazador (hoy: la plantilla del lote, bot/lote_plantilla.py).
_RONDA = re.compile(r"^\s*(?:me falta:|lote nuevo\. contestame)", re.IGNORECASE | re.MULTILINE)


def audio_siempre():
    return str(os.environ.get("BOT_AUDIO_SIEMPRE", "")).strip().lower() in _SI


def es_registro(texto):
    return bool(_REGISTRO.search(str(texto or "")))


def es_ronda(texto):
    return bool(_RONDA.search(str(texto or "")))


def debe_hablar(por_voz, texto, siempre=None):
    """True si este mensaje del bot va tambien en audio. **Pura.**"""
    if not str(texto or "").strip():
        return False
    if audio_siempre() if siempre is None else siempre:
        return True
    if es_registro(texto):
        return False
    return bool(por_voz) or es_ronda(texto)


def largo_utf16(texto):
    """Telegram mide `offset`/`length` de las entidades en unidades UTF-16."""
    return len(str(texto).encode("utf-16-le")) // 2


def mencion(usuario):
    """La primera linea en el grupo. Devuelve (texto, entidad) con entidad =
    None si basta el @usuario (Telegram lo vuelve mencion solo), o un dict
    {type, offset, length} para un `text_mention` (quien no tiene @usuario).
    None si no hay a quien mencionar."""
    if usuario is None or getattr(usuario, "is_bot", False):
        return None
    alias = getattr(usuario, "username", None)
    if alias:
        return "@" + str(alias), None
    nombre = " ".join(x for x in (getattr(usuario, "first_name", None), getattr(usuario, "last_name", None)) if x)
    nombre = nombre.strip() or "tu"
    return nombre, {"type": "text_mention", "offset": 0, "length": largo_utf16(nombre)}


# ─── copia de hablar.py ──────────────────────────────────────────────────────

def limpiar_markdown(texto):
    """Quita lo que no se debe leer en voz alta. Un TTS leyendo tablas es inservible."""
    t = str(texto or "")
    t = re.sub(r"```.*?```", " ", t, flags=re.S)
    t = re.sub(r"^\s*\|.*$", "", t, flags=re.M)
    t = re.sub(r"^\s{0,3}#{1,6}\s*", "", t, flags=re.M)
    t = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", t)
    t = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", t)
    t = re.sub(r"[*_`>#]+", "", t)
    t = re.sub(r"^\s*[-–—]\s*$", "", t, flags=re.M)
    t = re.sub(u"[✅⚠️⬜⛔]", " ", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    t = re.sub(r"[ \t]{2,}", " ", t)
    return t.strip()


async def _edge(texto, destino, voz, velocidad):
    import edge_tts  # requirements.txt; si falta, truena aqui y el texto ya salio
    await edge_tts.Communicate(texto, voz, rate=velocidad).save(str(destino))


def _a_ogg_opus(origen, destino):
    """32 kbps mono a 48 kHz, lo que usa el propio cliente de Telegram (hablar.py)."""
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("Falta ffmpeg en el PATH; sin el no hay OGG/OPUS para sendVoice.")
    destino.parent.mkdir(parents=True, exist_ok=True)
    r = subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", str(origen),
         "-c:a", "libopus", "-b:a", "32k", "-ar", "48000", "-ac", "1", str(destino)],
        capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0 or not destino.exists():
        raise RuntimeError("ffmpeg fallo convirtiendo a ogg/opus: " + r.stderr[-300:])
    return destino


def texto_a_voz(texto, destino, voz=VOZ_DEFAULT, velocidad=VELOCIDAD):
    """Texto -> OGG/OPUS listo para `sendVoice`. Devuelve la ruta escrita."""
    destino = Path(destino)
    destino.parent.mkdir(parents=True, exist_ok=True)
    texto = limpiar_markdown(texto)
    if not texto:
        raise ValueError("El texto quedo vacio despues de limpiar_markdown().")
    crudo = destino.with_suffix(".mp3")
    asyncio.run(_edge(texto, crudo, voz, velocidad))
    if not crudo.exists():
        raise RuntimeError("edge-tts no dejo archivo en " + str(crudo))
    final = _a_ogg_opus(crudo, destino.with_suffix(".ogg"))
    try:
        crudo.unlink()
    except OSError:
        pass
    return final
