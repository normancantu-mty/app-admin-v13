# -*- coding: utf-8 -*-
"""Cazador F0 (item 6): el TOPE de la suscripcion.

Escrito el 2026-10-17 por el ejecutor B del Socio.

El motor es `claude -p` con la suscripcion de Norman (plan v3, D1: sin API).
Cuando la suscripcion llega a su limite de sesion, `claude -p` no devuelve el
JSON del enrutador sino un aviso ("You've hit your limit · resets 3pm", o el
formato viejo "Claude AI usage limit reached|<epoch>"). Antes eso caia en el
"se me cayo el modelo, dimelo otra vez": el bot pedia repetir algo que iba a
fallar igual durante horas.

`detectar()` reconoce el aviso y devuelve un `Tope`: un `str` (asi todo el
codigo que trata el error como texto sigue igual) con `.hasta`, la hora local
en que se vuelve a intentar. Si el aviso no trae hora, se pausa
`PAUSA_SIN_HORA_MIN` minutos: es la hora en que EL BOT reintenta, no una
promesa de cuando se libera la suscripcion.

Las frases salen del propio binario de Claude Code instalado (2026-10-17:
"You've hit your limit", "Usage limit reached", "session limit") y del formato
viejo con epoch. **No se ha visto un tope real en este bot**: si el texto
cambia, `detectar()` devuelve None y el bot cae al mensaje de siempre (no se
cuelga, solo no dice la hora).
"""
import datetime as dt
import re

PAUSA_SIN_HORA_MIN = 30

_FRASES = re.compile(
    r"(?:hit your (?:session |usage |weekly |5-hour )?limit"
    r"|(?:usage|session|5-hour|weekly) limit (?:reached|hit)"
    r"|claude ai usage limit reached"
    r"|out of (?:extra )?usage)",
    re.IGNORECASE)
_EPOCH = re.compile(r"limit reached\|(\d{10})\b", re.IGNORECASE)
_HORA = re.compile(r"resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?\s*m?\b", re.IGNORECASE)


class Tope(str):
    """El error de tope: se comporta como el texto del error, y trae `.hasta`."""

    def __new__(cls, texto, hasta):
        obj = str.__new__(cls, texto)
        obj.hasta = hasta
        return obj


def _hora_de(texto, ahora):
    m = _EPOCH.search(texto)
    if m:
        return dt.datetime.fromtimestamp(int(m.group(1)))
    m = _HORA.search(texto)
    if not m:
        return None
    h, minuto, ap = int(m.group(1)), int(m.group(2) or 0), (m.group(3) or "").lower()
    if ap == "p" and h < 12:
        h += 12
    elif ap == "a" and h == 12:
        h = 0
    if h > 23 or minuto > 59:
        return None
    hasta = ahora.replace(hour=h, minute=minuto, second=0, microsecond=0)
    if hasta <= ahora:
        hasta += dt.timedelta(days=1)
    return hasta


def detectar(stdout="", stderr="", ahora=None):
    """Un `Tope` si la salida de `claude -p` es el aviso de limite; si no, None. **Pura salvo el reloj.**"""
    texto = "%s\n%s" % (stdout or "", stderr or "")
    if not _FRASES.search(texto):
        return None
    ahora = ahora or dt.datetime.now()
    hasta = _hora_de(texto, ahora) or (ahora + dt.timedelta(minutes=PAUSA_SIN_HORA_MIN))
    return Tope("tope de la suscripcion: " + " ".join(texto.split())[:200], hasta)


def texto_pausa(hasta):
    """Lo que contesta el bot. **Pura.**"""
    return "Estoy en pausa hasta las %s; ya lo guardé." % hasta.strftime("%H:%M")
