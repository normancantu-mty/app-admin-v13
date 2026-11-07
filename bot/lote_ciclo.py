# -*- coding: utf-8 -*-
"""Lote v2 - EL CICLO DEL LOTE: aditivo 2, reposo, destilacion, muestra y la
temperatura de la fermentacion.

Escrito el 2026-10-19 por el ejecutor del Socio (lote v2).

Todo lo que se puede configurar vive en `bot/plantillas/lote.yaml` (dias del
ciclo, rangos, textos, ubicacion). Aqui solo la mecanica:

  * `tick(...)` cuelga del latido de 15 min del bot. Lee el ciclo del servidor
    (`/api/bot/lote/ciclo`, accion `leer`), completa la temperatura que falte
    (Open-Meteo) y manda los recordatorios que ya tocan.
  * Cada recordatorio sale UNA vez: antes de mandarlo se RECLAMA en la base
    (`lote_recordatorios`, INSERT ... ON CONFLICT DO NOTHING). El estado no
    vive en la RAM del bot: un reinicio no lo repite. (Y si el envio falla
    despues del reclamo, ese recordatorio se pierde: "a lo mas una vez".)
  * Las ETAPAS (aditivo 2, destilacion) se capturan en el chat, se ensenan con
    TODO + la fecha de hoy y botones Confirmar / Corregir, y solo con
    Confirmar salen al servidor (proponer + confirmar, con la puerta de
    aprobacion: lo del TRABAJADOR espera el Aprobar).
  * La temperatura es la del AIRE DE FUERA en Fresnillo (Open-Meteo, gratis,
    sin llave): un PROXY SIN ANCLAR de la temperatura del mosto. Si la API
    falla, el lote no se entera: el dia queda sin fila y se reintenta en el
    siguiente latido.

El reloj (`ahora`) y la red (`post`, `abrir`) se inyectan: asi se prueba.
"""
import asyncio
import datetime as dt
import json
import logging
import re
import time
import urllib.parse
import urllib.request

import lote_plantilla

log = logging.getLogger("bot_gastos")

RUTA_CICLO = "/api/bot/lote/ciclo"
RUTA_ETAPA_PROPONER = "/api/bot/lote/etapa/proponer"
RUTA_ETAPA_CONFIRMAR = "/api/bot/lote/etapa/confirmar"

_etapas = {}  # chat -> sesion de captura de una etapa (solo la captura; el estado del ciclo esta en la base)
# Ronda 3 (R2-C): (id_lote, tipo) que SI salio por Telegram pero cuyo POST
# `entregado` fallo. El siguiente latido no lo reenvia: solo reintenta marcarlo.
# Vive en RAM a proposito (ver `marcar_entregado`).
_sin_marcar = set()


# ── configuracion ───────────────────────────────────────────────────────────

def cfg():
    return lote_plantilla.plantilla()


def _ciclo():
    c = dict(cfg().get("ciclo") or {})
    c.setdefault("aditivo_2_dia", 3)
    c.setdefault("reposo_dias", 3)
    c.setdefault("muestra_horas", 24)
    c.setdefault("hora_recordatorios", 8)
    c.setdefault("ventana_dias", 45)
    c.setdefault("intentos_recordatorio", 3)
    return c


def zona():
    horas = float(((cfg().get("ubicacion") or {}).get("utc_offset_horas")) or -6)
    return dt.timezone(dt.timedelta(hours=horas))


def ahora_local(ahora=None):
    ahora = ahora or dt.datetime.now(dt.timezone.utc)
    if ahora.tzinfo is None:
        ahora = ahora.replace(tzinfo=dt.timezone.utc)
    return ahora.astimezone(zona())


def _fecha(s):
    return dt.date(int(s[0:4]), int(s[5:7]), int(s[8:10]))


def _instante(s):
    """Un timestamptz de PostgREST ('2026-10-19T15:00:00.123+00:00' o 'Z')."""
    s = str(s or "").strip().replace("Z", "+00:00")
    if not s:
        return None
    m = re.match(r"^(.*?)(\.\d+)?([+-]\d\d:\d\d)?$", s)
    base = m.group(1) if m else s
    tz = (m.group(3) if m else None) or "+00:00"
    try:
        return dt.datetime.fromisoformat(base + tz)
    except ValueError:
        return None


def _texto(clave, **k):
    plantillas = cfg().get("textos") or {}
    return str(plantillas.get(clave, clave)).format(**k)


# ── el codigo del lote ──────────────────────────────────────────────────────

def codigo_nuevo(post, ahora=None):
    """El codigo que le toca HOY al siguiente lote, contra los codigos que ya
    existen en la base (formato del YAML). Sin red: el N sale 1."""
    codigos = []
    try:
        estado, r = post(RUTA_CICLO, {"accion": "leer", "ventana_dias": 1})
        if estado == 200 and isinstance(r, dict) and r.get("ok"):
            codigos = list(r.get("codigos") or [])
    except Exception as e:
        log.warning("ciclo: no pude leer los codigos de lote: %s", e)
    return lote_plantilla.codigo_siguiente(codigos, ahora_local(ahora).date())


# ── los recordatorios (PURO) ────────────────────────────────────────────────

def _etapa(lote, nombre):
    for e in lote.get("etapas") or []:
        if e.get("etapa") == nombre:
            return e
    return None


def _recordatorio(lote, tipo):
    for r in lote.get("recordatorios") or []:
        if r.get("tipo") == tipo:
            return r
    return None


def _cerrado(lote, tipo, tope):
    """El recordatorio ya no toca: salio a alguien (`entregado_en`) o se agoto
    el tope de reclamos. Una fila sin `entregado_en` en la respuesta (ruta
    vieja) cuenta como entregada: no se adivina un reintento."""
    r = _recordatorio(lote, tipo)
    if r is None:
        return False
    if "entregado_en" not in r or r.get("entregado_en"):
        return True
    return int(r.get("intentos") or 1) >= int(tope)


def _reintento(lote, tipo):
    """{'intentos': n} si hay un reclamo sin entregar (para el compare-and-swap)."""
    r = _recordatorio(lote, tipo)
    if r is None:
        return {}
    return {"intentos": int(r.get("intentos") or 1)}


def recordatorios_debidos(lotes, ahora, ciclo=None):
    """Que recordatorios tocan YA. **Pura**: `ahora` se inyecta.

    Devuelve [(lote, tipo, extra)] con tipo en aditivo_2 | destilar | muestra |
    muestra_2. Lo ya reclamado en la base (`recordatorios`) no vuelve a salir.
      - aditivo_2: D + aditivo_2_dia desde la produccion, sin aditivo 2 aun.
      - destilar:  reposo_dias despues del aditivo 2, sin destilacion aun.
      - muestra:   hay destilacion y nadie dijo "Ya la guarde" (normalmente se
                   reclama al confirmar la destilacion; esto es la red).
      - muestra_2: muestra_horas despues del primero, sin "Ya la guarde". UNA vez.
    Ninguno antes de `hora_recordatorios` (hora local), salvo la primera
    muestra (red de la que sale al confirmar la destilacion). Ronda 2: el
    muestra_2 tambien espera la hora. Un reclamo que no salio a nadie vuelve a
    tocar hasta `intentos_recordatorio` (extra['intentos'] = el n del reclamo).
    """
    c = ciclo or _ciclo()
    tope = int(c.get("intentos_recordatorio") or 3)
    local = ahora_local(ahora)
    hoy = local.date()
    temprano = local.hour < int(c["hora_recordatorios"])
    salida = []
    for lote in lotes or []:
        if not lote.get("fecha_inicio"):
            continue
        inicio = _fecha(lote["fecha_inicio"])
        ad2, des, mue = _etapa(lote, "aditivo_2"), _etapa(lote, "destilacion"), _etapa(lote, "muestra")
        if (not temprano and ad2 is None and des is None and not _cerrado(lote, "aditivo_2", tope)
                and (hoy - inicio).days >= int(c["aditivo_2_dia"])):
            salida.append((lote, "aditivo_2", dict(_reintento(lote, "aditivo_2"), dia=(hoy - inicio).days)))
        if (not temprano and ad2 is not None and des is None and not _cerrado(lote, "destilar", tope)
                and ad2.get("fecha") and (hoy - _fecha(ad2["fecha"])).days >= int(c["reposo_dias"])):
            salida.append((lote, "destilar", dict(_reintento(lote, "destilar"), dias=(hoy - _fecha(ad2["fecha"])).days)))
        if des is not None and mue is None:
            primero = _recordatorio(lote, "muestra")
            if not _cerrado(lote, "muestra", tope):
                # Ronda 3: la PRIMERA (red de la del confirmar) sale a cualquier
                # hora; el REINTENTO de una que no salio espera la hora del YAML.
                if not (temprano and primero is not None):
                    salida.append((lote, "muestra", _reintento(lote, "muestra")))
            elif primero and not temprano and not _cerrado(lote, "muestra_2", tope):
                enviado = _instante(primero.get("enviado_en"))
                if enviado and (ahora_local(ahora) - enviado) >= dt.timedelta(hours=float(c["muestra_horas"])):
                    salida.append((lote, "muestra_2", _reintento(lote, "muestra_2")))
    return salida


def destinatarios(lote, admins, tipo=None):
    """A quien: quien ABRIO el lote + los ADMIN (y, para la muestra, quien
    registro la destilacion). Sin repetidos, en ese orden."""
    ids = []
    for t in [lote.get("abrio_telegram_id")] + list(admins or []):
        if t not in (None, "") and int(t) not in ids:
            ids.append(int(t))
    if tipo in ("muestra", "muestra_2"):
        des = _etapa(lote, "destilacion") or {}
        t = des.get("telegram_id")
        if t not in (None, "") and int(t) not in ids:
            ids.append(int(t))
    return ids


def mensaje_de(lote, tipo, extra):
    codigo = lote.get("codigo_lote")
    if tipo == "aditivo_2":
        return _texto("aditivo_2_recordatorio", codigo=codigo, dia=extra.get("dia", ""))
    if tipo == "destilar":
        return _texto("destilar_recordatorio", codigo=codigo, dias=extra.get("dias", ""))
    if tipo == "muestra":
        return _texto("muestra", codigo=codigo)
    return _texto("muestra_2", codigo=codigo)


def boton_de(lote, tipo):
    """(etiqueta, callback_data). El codigo viaja en el boton: cabe en 64 bytes."""
    if tipo == "aditivo_2":
        return "Registrar aditivo 2", "ltad2:" + str(lote.get("codigo_lote"))
    if tipo == "destilar":
        return "Registrar destilacion", "ltdes:" + str(lote.get("codigo_lote"))
    return "Ya la guarde", "ltmu:" + str(lote.get("id"))


def _teclado(etiqueta, data):
    from telegram import InlineKeyboardButton, InlineKeyboardMarkup
    return InlineKeyboardMarkup([[InlineKeyboardButton(etiqueta, callback_data=data)]])


# ── la temperatura ──────────────────────────────────────────────────────────

def de_open_meteo(respuesta, fuente=None, latitud=None, longitud=None):
    """La respuesta de Open-Meteo -> dias {fecha, fuente, t_min, t_max, t_prom}.
    **Pura.** Un dia con algun valor nulo no se devuelve (no se inventa)."""
    fuente = fuente or (cfg().get("temperatura") or {}).get("fuente") or "open-meteo exterior"
    d = (respuesta or {}).get("daily") or {}
    dias = []
    for i, fecha in enumerate(d.get("time") or []):
        try:
            tmin = d["temperature_2m_min"][i]
            tmax = d["temperature_2m_max"][i]
            tprom = d["temperature_2m_mean"][i]
        except (KeyError, IndexError):
            continue
        if None in (tmin, tmax, tprom):
            continue
        dias.append({"fecha": fecha, "fuente": fuente, "t_min": float(tmin), "t_max": float(tmax),
                     "t_prom": float(tprom), "latitud": latitud, "longitud": longitud})
    return dias


def _abrir_de_verdad(url, timeout):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def temperaturas(desde, hasta, latitud=None, longitud=None, abrir=None):
    """Min / max / promedio POR DIA, de `desde` a `hasta` (date o 'AAAA-MM-DD'),
    en Fresnillo (YAML). Una llamada a Open-Meteo. Lanza si la red falla."""
    u = cfg().get("ubicacion") or {}
    t = cfg().get("temperatura") or {}
    lat = float(latitud if latitud is not None else u.get("latitud"))
    lon = float(longitud if longitud is not None else u.get("longitud"))
    params = {
        "latitude": lat, "longitude": lon,
        "daily": "temperature_2m_max,temperature_2m_min,temperature_2m_mean",
        "timezone": u.get("zona") or "America/Mexico_City",
        "start_date": str(desde), "end_date": str(hasta),
    }
    url = (t.get("url") or "https://api.open-meteo.com/v1/forecast") + "?" + urllib.parse.urlencode(params)
    datos = (abrir or _abrir_de_verdad)(url, float(t.get("timeout_segundos") or 20))
    return de_open_meteo(datos, latitud=lat, longitud=lon)


def dias_que_faltan(lotes, existentes, hoy, fuente=None):
    """Los dias de fermentacion sin fila de temperatura de `fuente`. **Pura.**
    Por lote: de la produccion al dia de la destilacion (o a AYER, si sigue
    fermentando: solo dias completos)."""
    fuente = fuente or (cfg().get("temperatura") or {}).get("fuente") or "open-meteo exterior"
    tengo = {e.get("fecha") for e in existentes or [] if e.get("fuente") == fuente}
    faltan = set()
    ayer = hoy - dt.timedelta(days=1)
    for lote in lotes or []:
        if not lote.get("fecha_inicio"):
            continue
        inicio = _fecha(lote["fecha_inicio"])
        des = _etapa(lote, "destilacion")
        fin = min(_fecha(des["fecha"]), ayer) if des and des.get("fecha") else ayer
        d = inicio
        while d <= fin:
            if d.isoformat() not in tengo:
                faltan.add(d.isoformat())
            d += dt.timedelta(days=1)
    return sorted(faltan)


def completar_temperatura(post, lotes, existentes, hoy, abrir=None):
    """Pide a Open-Meteo lo que falta y lo guarda. Devuelve (guardados, pendientes).
    Si la API o el guardado fallan: (0, len(faltan)); se reintenta solo en el
    siguiente latido porque el dia sigue sin fila."""
    faltan = dias_que_faltan(lotes, existentes, hoy)
    if not faltan:
        return 0, 0
    try:
        dias = temperaturas(faltan[0], faltan[-1], abrir=abrir)
    except Exception as e:
        log.warning("ciclo: Open-Meteo fallo (%s): %s. Quedan %d dia(s) pendientes; reintento en el siguiente latido.",
                    type(e).__name__, e, len(faltan))
        return 0, len(faltan)
    dias = [d for d in dias if d["fecha"] in set(faltan)]
    if not dias:
        return 0, len(faltan)
    estado, r = post(RUTA_CICLO, {"accion": "temperatura", "dias": dias})
    if estado != 200 or not (isinstance(r, dict) and r.get("ok")):
        log.warning("ciclo: no pude guardar la temperatura (%s): %s", estado, (r or {}).get("error"))
        return 0, len(faltan)
    log.info("ciclo: temperatura guardada (%d dia(s), proxy exterior sin anclar)", len(dias))
    return len(dias), len(faltan) - len(dias)


# ── el latido ───────────────────────────────────────────────────────────────

def reclamar(post, id_lote, tipo, intentos=None):
    """Sin `intentos`: el primer reclamo (INSERT ON CONFLICT DO NOTHING). Con
    `intentos`: el reintento de uno que no salio (compare-and-swap)."""
    if intentos:
        cuerpo = {"accion": "reintentar", "id_lote": id_lote, "tipo": tipo, "intentos": int(intentos)}
    else:
        cuerpo = {"accion": "reclamar", "id_lote": id_lote, "tipo": tipo}
    estado, r = post(RUTA_CICLO, cuerpo)
    return estado == 200 and isinstance(r, dict) and r.get("reclamado") is True


def entregado(post, id_lote, tipo):
    try:
        estado, r = post(RUTA_CICLO, {"accion": "entregado", "id_lote": id_lote, "tipo": tipo})
    except Exception as e:
        estado, r = None, {"error": str(e)}
    if not (estado == 200 and isinstance(r, dict) and r.get("ok")):
        log.warning("ciclo: no pude marcar entregado %s del lote %s (%s)", tipo, id_lote, estado)
        return False
    return True


def marcar_entregado(post, id_lote, tipo):
    """Ronda 3 (R2-C): `entregado` DESPUES de un envio que si salio. Si el POST
    falla, (id_lote, tipo) queda en `_sin_marcar` y el siguiente latido solo
    reintenta la marca, sin reenviar. Se eligio RAM y no la base porque lo que
    fallo ES la base: no hay donde escribir la marca. El hueco que queda: si el
    bot se reinicia antes de que la base vuelva, ese recordatorio puede salir
    una segunda vez (duplicar antes que callar, como la voz)."""
    if entregado(post, id_lote, tipo):
        _sin_marcar.discard((id_lote, tipo))
        return True
    _sin_marcar.add((id_lote, tipo))
    return False


async def tick(bot, post, ahora=None, abrir=None):
    """Una vuelta del ciclo. `post(ruta, cuerpo)` es SINCRONA (la del bot); se
    corre en un hilo. Devuelve lo que hizo, para el log y las pruebas."""
    hecho = {"leidos": 0, "enviados": [], "temperatura": (0, 0), "error": None}
    estado, r = await asyncio.to_thread(post, RUTA_CICLO, {"accion": "leer", "ventana_dias": _ciclo()["ventana_dias"]})
    if estado != 200 or not (isinstance(r, dict) and r.get("ok")):
        hecho["error"] = "no pude leer el ciclo (%s)" % estado
        log.warning("ciclo: %s", hecho["error"])
        return hecho
    lotes, admins = list(r.get("lotes") or []), list(r.get("admins") or [])
    hecho["leidos"] = len(lotes)
    local = ahora_local(ahora)
    hecho["temperatura"] = await asyncio.to_thread(
        completar_temperatura, post, lotes, r.get("temperaturas") or [], local.date(), abrir)
    tope = int(_ciclo().get("intentos_recordatorio") or 3)
    hecho["sin_entregar"] = []
    hecho["solo_marcados"] = []
    for lote, tipo, extra in recordatorios_debidos(lotes, ahora):
        if (lote["id"], tipo) in _sin_marcar:
            # Ya salio; lo que fallo fue la marca. Se reintenta SOLO la marca.
            await asyncio.to_thread(marcar_entregado, post, lote["id"], tipo)
            hecho["solo_marcados"].append((lote.get("codigo_lote"), tipo))
            continue
        if not await asyncio.to_thread(reclamar, post, lote["id"], tipo, extra.get("intentos")):
            continue  # otro latido (u otro proceso) ya lo mando o lo reintenta
        texto = mensaje_de(lote, tipo, extra)
        etiqueta, data = boton_de(lote, tipo)
        salio = 0
        for tid in destinatarios(lote, admins, tipo):
            try:
                await bot.send_message(int(tid), texto, reply_markup=_teclado(etiqueta, data))
                hecho["enviados"].append((lote.get("codigo_lote"), tipo, int(tid)))
                salio += 1
            except Exception as e:
                log.warning("ciclo: no pude mandar %s del lote %s a %s: %s", tipo, lote.get("codigo_lote"), tid, e)
        if salio:
            await asyncio.to_thread(marcar_entregado, post, lote["id"], tipo)
        else:
            # Ronda 2: reclamado pero no salio a nadie. Queda entregado_en NULL
            # en la base y el siguiente latido lo reintenta, hasta el tope.
            n = int(extra.get("intentos") or 0) + 1
            hecho["sin_entregar"].append((lote.get("codigo_lote"), tipo, n))
            log.warning("ciclo: %s del lote %s no salio a nadie (intento %d de %d)%s", tipo,
                        lote.get("codigo_lote"), n, tope, "; se reintenta en el siguiente latido" if n < tope else "; NO se reintenta mas")
    if hecho["enviados"]:
        log.info("ciclo: recordatorios enviados: %s", hecho["enviados"])
    return hecho


# ── la captura de una etapa ─────────────────────────────────────────────────

def _plano(t):
    return lote_plantilla._plano(t)


def _num(s):
    return lote_plantilla._num(s)


def _bonito(n):
    try:
        f = float(n)
    except (TypeError, ValueError):
        return str(n)
    return str(int(f)) if f.is_integer() else str(f)


def sesion(chat):
    s = _etapas.get(chat)
    if not s:
        return None
    if time.time() - s["nacido_en"] > 60 * float(cfg().get("vida_minutos", 30)):
        _etapas.pop(chat, None)
        return None
    return s


def olvidar(chat):
    _etapas.pop(chat, None)


def pregunta_de(etapa, codigo):
    return _texto("aditivo_2_pregunta" if etapa == "aditivo_2" else "destilacion_pregunta", codigo=codigo)


def empezar(chat, etapa, codigo):
    _etapas[chat] = {"etapa": etapa, "codigo": codigo, "cantidad": None, "unidad": None, "sin_unidad": None,
                     "n": None, "garrafas": [], "notas": [],
                     "modo": "captura", "nacido_en": time.time()}
    return _etapas[chat]


_PAR = re.compile(
    r"(\d+(?:[.,]\d+)?)\s*(?:kg|kgs|kilos?|kilogramos?)\s*(?:a|al|con|de|,|y|/|-)?\s*(?:un\s+)?"
    r"(\d+(?:[.,]\d+)?)\s*(?:%|por\s*ciento|grados?|de\s+alcohol)")
_PAR_BARRA = re.compile(r"(\d+(?:[.,]\d+)?)\s*/\s*(\d+(?:[.,]\d+)?)")
_CUANTAS = re.compile(r"(\d+)\s*garraf")


def leer_garrafas(texto):
    """'3 garrafas: 18.5 kg 52%, 17 kg 48%' -> (3, [(18.5, 52), (17, 48)]). **Pura.**"""
    t = sin_codigo(texto)
    n = _CUANTAS.search(t)
    pares = [(_num(a), _num(b)) for a, b in _PAR.findall(t)]
    if not pares:
        pares = [(_num(a), _num(b)) for a, b in _PAR_BARRA.findall(t)]
    return (int(n.group(1)) if n else None), pares


_CODIGO = re.compile(r"\b(l-?\d{1,2}-\d{1,2}\.\d{1,3}|l-?\d{3,5})\b")
_KG_CON_UNIDAD = re.compile(r"(\d+(?:[.,]\d+)?)\s*(?:kg|kgs|kilos?|kilogramos?)\b")
# Fase 7A (2026-11-07): el aditivo 2 se lleva en GRAMOS en el catalogo. Se lee
# la masa CON su unidad; un numero pelon no se adivina (se pregunta g o kg).
_MASA = re.compile(r"(\d+(?:[.,]\d+)?)\s*(kg|kgs|kilos?|kilogramos?|g|gr|grs|gramos?)\b")
_SOLO_UNIDAD = re.compile(r"^\W*(?:son\s+|en\s+|fueron\s+)?(kg|kgs|kilos?|kilogramos?|g|gr|grs|gramos?)\W*$")


def sin_codigo(texto):
    """El texto sin el codigo de lote (sus digitos no son kilos)."""
    return _CODIGO.sub(" ", _plano(texto))


def leer_kg(texto, con_unidad=False):
    t = sin_codigo(texto)
    m = _KG_CON_UNIDAD.search(t) or (None if con_unidad else re.search(r"(\d+(?:[.,]\d+)?)", t))
    return _num(m.group(1)) if m else None


def _corta(u):
    return "kg" if u.startswith("k") else "g"


def leer_masa(texto, con_unidad=False):
    """'800 g' -> (800, 'g'); '1.5 kilos' -> (1.5, 'kg'); '4' -> (4, None)
    (o (None, None) si `con_unidad`). **Pura.**"""
    t = sin_codigo(texto)
    m = _MASA.search(t)
    if m:
        return _num(m.group(1)), _corta(m.group(2))
    if con_unidad:
        return None, None
    m = re.search(r"(\d+(?:[.,]\d+)?)", t)
    return (_num(m.group(1)), None) if m else (None, None)


def solo_unidad(texto):
    """'gramos' / 'son kilos' -> 'g' / 'kg'; otra cosa -> None. **Pura.**"""
    m = _SOLO_UNIDAD.match(_plano(texto))
    return _corta(m.group(1)) if m else None


def en_kg(cantidad, unidad):
    return cantidad / 1000.0 if unidad == "g" else cantidad


def avisos(s):
    e = (cfg().get("etapas") or {}).get(s["etapa"]) or {}
    out = []
    if s["etapa"] == "aditivo_2" and s.get("cantidad") is not None:
        # El rango del YAML esta en KILOS (es fisico); lo dicho en g se compara en kg.
        a, b = e.get("rango_kg") or [0.01, 200]
        kg = en_kg(s["cantidad"], s.get("unidad"))
        if not (a <= kg <= b):
            out.append("Ojo: %s %s de aditivo 2 se sale de lo normal (%s a %s kg). Lo dejo asi; si es error, corrigelo."
                       % (_bonito(s["cantidad"]), s.get("unidad") or "kg", a, b))
    if s["etapa"] == "destilacion":
        pa, pb = e.get("rango_peso_kg") or [0.1, 60]
        aa, ab = e.get("rango_alcohol") or [0, 80]
        for i, (peso, grado) in enumerate(s["garrafas"], 1):
            if not (pa <= peso <= pb):
                out.append("Ojo: la garrafa %d pesa %s kg (lo normal: %s a %s). Lo dejo asi." % (i, peso, pa, pb))
            if not (aa <= grado <= ab):
                out.append("Ojo: la garrafa %d tiene %s%% (lo normal: %s a %s). Lo dejo asi." % (i, grado, aa, ab))
    return out


def resumen(s, hoy=None):
    """EL mensaje de confirmacion de la etapa: todo + la fecha de hoy."""
    hoy = hoy or ahora_local().date()
    nombre = "ADITIVO 2" if s["etapa"] == "aditivo_2" else "DESTILACION"
    lineas = ["Revisa antes de guardarlo:", "", "LOTE %s - %s" % (s["codigo"], nombre),
              "Fecha: %s (hoy)" % lote_plantilla.fecha_para_persona(hoy)]
    if s["etapa"] == "aditivo_2":
        lineas.append("Aditivo 2: %s %s" % (_bonito(s["cantidad"]), s.get("unidad") or "kg"))
    else:
        lineas.append("Garrafas: %d" % len(s["garrafas"]))
        for i, (peso, grado) in enumerate(s["garrafas"], 1):
            lineas.append("   Garrafa %d: %s kg a %s%%" % (i, peso, grado))
    if s.get("notas"):
        lineas.append("Notas: " + "; ".join(s["notas"])[:300])
    if s.get("aviso_envasado"):
        lineas += ["", AVISO_ENVASADO]
    lineas += ["", "Nada se guarda hasta que confirmes."]
    return "\n".join(lineas)


AVISO_ENVASADO = "El envasado dimelo aparte (no lo anote): es diario y no se liga al lote."


def _teclado_resumen():
    from telegram import InlineKeyboardButton, InlineKeyboardMarkup
    return InlineKeyboardMarkup([[
        InlineKeyboardButton("Confirmar", callback_data="ltec:x"),
        InlineKeyboardButton("Corregir", callback_data="ltecc:x"),
    ]])


async def abrir_etapa(update, chat, etapa, codigo):
    empezar(chat, etapa, codigo)
    await update.effective_message.reply_text(pregunta_de(etapa, codigo))


async def _ensenar(update, s):
    s["modo"] = "resumen"
    s["nacido_en"] = time.time()
    await update.effective_message.reply_text("\n".join(avisos(s) + [resumen(s)]), reply_markup=_teclado_resumen())


def sin_muletillas(texto):
    """El texto (plano) sin las muletillas del YAML (`etapas.muletillas`:
    "que crees", "sabes que", "como quedamos", "oye"), que no son pregunta ni
    dato: "¿Que crees? Ya destilamos el L-.." se lee como "Ya destilamos el L-..".
    **Pura.**"""
    t = _plano(texto)
    for p in ((cfg().get("etapas") or {}).get("muletillas") or []):
        t = re.sub(p, " ", t)
    return t


def no_abre_etapa(texto):
    """True si el mensaje es un envasado o una pregunta (YAML
    `etapas.no_abren_etapa`) Y no trae datos de etapa (YAML
    `etapas.datos_de_etapa`: garrafas, kg, %). Ronda 4: solo se consulta para
    los `disparadores_con_codigo`; los anclados al inicio no la miran. **Pura.**"""
    t = sin_muletillas(texto)
    e = cfg().get("etapas") or {}
    datos = e.get("datos_de_etapa")
    if datos and re.search(datos, t):
        return False
    if es_envasado(t):
        return True
    return any(re.search(p, t) for p in (e.get("no_abren_etapa") or []))


def es_envasado(texto):
    """Ronda 5 (B, decision de Norman 2026-10-19): el ENVASADO de botellas es
    diario e independiente del lote; nunca abre ni pide un lote (ni plantilla
    ni etapa). YAML `envasado_diario`. **Pura.**"""
    t = _plano(texto)
    return any(re.search(p, t) for p in (cfg().get("envasado_diario") or []))


def _disparo(texto):
    """'aditivo 2 del lote L-19-10.1' / 'destilamos el L-19-10.1' -> (etapa, codigo|None)."""
    t = sin_muletillas(texto)
    m = _CODIGO.search(t)
    cod = m.group(1).upper() if m else None
    if cod and not cod.startswith("L-"):
        cod = "L-" + cod[1:]
    # Ronda 3 (R2-B) / ronda 4 / ronda 5 (B): un ENVASADO ("envasamos 40 de 750
    # del L-.. que destilamos el viernes"; es diario y no se liga al lote) o una PREGUNTA ("cuanto aditivo 2 lleva el
    # L-..?") no abren la etapa POR CODIGO EN MEDIO; los disparadores anclados
    # al inicio ("ya destilamos el L-..., salieron 2 garrafas, lo anotas?") y
    # los mensajes con datos de etapa si la abren. YAML `etapas.no_abren_etapa`.
    excluido = no_abre_etapa(texto)
    for etapa in ("aditivo_2", "destilacion"):
        e = (cfg().get("etapas") or {}).get(etapa) or {}
        for patron in e.get("disparadores") or []:
            if re.search(patron, t):
                return etapa, cod
        # Ronda 2 (H1): en CUALQUIER parte del mensaje, pero solo con un
        # codigo L- en el mismo mensaje ("le pusimos 4 kilos de aditivo 2 al
        # L-12-10.1"). Sin codigo no: "aditivo 2" suelto puede ser otra cosa.
        if cod and not excluido:
            for patron in e.get("disparadores_con_codigo") or []:
                if re.search(patron, t):
                    return etapa, cod
    return None, None


def temperatura_dicha(texto):
    """Ronda 5 (decision de Norman, 2026-10-19): la gente NO dicta temperatura;
    la temperatura sale SOLO de Open-Meteo. Si el mensaje menciona una, NO se
    guarda como temperatura: se devuelve (nota, texto_sin_el_tramo) para que
    vaya a las NOTAS de la sesion (plantilla o etapa) y sus numeros no se lean
    como kilos, Brix ni garrafas. Sin mencion: (None, texto). **Pura.**
    Los patrones son los del extra `temperatura_dicha` del YAML (los mismos que
    usa la plantilla)."""
    extra = next((e for e in (cfg().get("extras") or []) if e.get("nombre") == "temperatura_dicha"), None)
    if not extra:
        return None, texto
    t = _plano(texto)
    notas = []

    def quitar(m):
        notas.append(extra.get("nota", "{t}").format(m.group(1).strip(), t=m.group(0).strip()))
        return " "

    for patron in extra.get("patrones") or []:
        t = re.sub(patron, quitar, t)
    if not notas:
        return None, texto
    return "; ".join(notas), re.sub(r"\s+", " ", t).strip(" ,;.")


def _solo_relleno(texto):
    """True si al texto no le queda nada que decir (sin numeros, solo relleno)."""
    relleno = set((cfg().get("relleno") or "").split()) | {"cuarto", "ambiente", "estaba", "esta", "hay", "marca"}
    return not re.search(r"\d", texto) and all(w in relleno for w in re.findall(r"[a-z]+", _plano(texto)))


async def atender(update, chat, texto, confirmar=None, post=None):
    """El texto de una etapa en captura. True si lo atendio.
    Ronda 5: la temperatura dicha NO se guarda como temperatura (sale de
    Open-Meteo): si hay etapa en captura, va a las notas de la etapa y el resto
    del mensaje sigue (`temperatura_dicha`). Sin sesion, el mensaje sigue entero
    su camino. `post` queda por compatibilidad."""
    s = sesion(chat)
    t = _plano(texto)
    nota, sin = temperatura_dicha(texto)
    if s is None:
        etapa, codigo = _disparo(texto)
        if not etapa:
            return False
        if not codigo:
            await update.effective_message.reply_text(
                "De cual lote? Dimelo con el codigo, por ejemplo: %s L-19-10.1"
                % ("aditivo 2" if etapa == "aditivo_2" else "destilacion"))
            return True
        s = empezar(chat, etapa, codigo)
        if nota:
            s["notas"].append(nota)
        # Ronda 6 (auditoria r5): un envasado en el mismo mensaje ("ya destilamos
        # el L-.. y envasamos 40 de 750") no se pierde callado: no se anota en la
        # etapa (es diario, va aparte) y se AVISA en la pregunta y en el resumen.
        if es_envasado(texto):
            s["aviso_envasado"] = True
        # Si el mismo mensaje ya trae los datos, se usan; si no, se pregunta.
        if not await _capturar(update, s, sin, primera=True):
            await update.effective_message.reply_text(
                pregunta_de(etapa, codigo) + ("\n\n" + AVISO_ENVASADO if s.get("aviso_envasado") else ""))
        return True
    if nota:
        s["notas"].append(nota)
        if await _capturar(update, s, sin):
            return True
        if _solo_relleno(sin):
            await update.effective_message.reply_text(
                "Lo anoto en las notas de la etapa: %s. La temperatura se toma sola de Open-Meteo." % nota)
            return True
        return False
    if s["modo"] == "resumen":
        if lote_plantilla._SI.match(t) and confirmar is not None:
            await confirmar(update, chat)
            return True
        if lote_plantilla._CORREGIR.match(t):
            await abrir_etapa(update, chat, s["etapa"], s["codigo"])
            return True
    return await _capturar(update, s, texto)


async def _capturar(update, s, texto, primera=False):
    """Mete el texto en la etapa. False si no traia nada de la etapa."""
    if s["etapa"] == "aditivo_2":
        cantidad, unidad = leer_masa(texto, con_unidad=primera)
        if cantidad is None:
            # "gramos" despues de un numero pelon: completa la cantidad pendiente.
            u = solo_unidad(texto) if s.get("sin_unidad") is not None else None
            if u is None:
                return False
            cantidad, unidad = s["sin_unidad"], u
        if unidad is None:
            s["sin_unidad"] = cantidad
            s["modo"] = "captura"
            await update.effective_message.reply_text(
                _texto("aditivo_2_unidad", cantidad=_bonito(cantidad), codigo=s["codigo"]))
            return True
        s["cantidad"], s["unidad"], s["sin_unidad"] = cantidad, unidad, None
        await _ensenar(update, s)
        return True
    n, pares = leer_garrafas(texto)
    if n is None and not pares:
        return False
    if n is not None:
        s["n"] = n
    s["garrafas"].extend((float(p), float(g)) for p, g in pares if p is not None and g is not None)
    tope = int(((cfg().get("etapas") or {}).get("destilacion") or {}).get("tope_garrafas") or 50)
    s["garrafas"] = s["garrafas"][:tope]
    falta = (s["n"] or 0) - len(s["garrafas"])
    if not s["garrafas"] or falta > 0:
        s["modo"] = "captura"
        desde = len(s["garrafas"]) + 1
        hasta = s["n"] or desde
        await update.effective_message.reply_text(
            "Me falta%s: el peso (kg) y el %% de alcohol de la garrafa %s%s. Todo en un mensaje, por ejemplo: 17 kg 48%%"
            % ("n" if hasta > desde else "", desde, ("" if hasta == desde else " a la %d" % hasta)))
        return True
    if s["n"] is not None and len(s["garrafas"]) > s["n"]:
        s["n"] = len(s["garrafas"])
    await _ensenar(update, s)
    return True


def cuerpo_de_propuesta(s, chat):
    cuerpo = {"telegram_id": chat, "codigo_lote": s["codigo"], "etapa": s["etapa"]}
    if s["etapa"] == "aditivo_2":
        # Fase 7A: lo dicho con su unidad; el servidor lo pasa a la del catalogo.
        cuerpo["cantidad"] = s["cantidad"]
        cuerpo["unidad"] = s.get("unidad") or "kg"
        cuerpo["insumo_sku"] = cfg().get("aditivo_2_sku") or "aditivo-2"
    else:
        cuerpo["garrafas"] = [{"peso_kg": p, "grado_alcohol": g} for p, g in s["garrafas"]]
    if s.get("notas"):
        cuerpo["notas"] = "; ".join(s["notas"])[:500]
    return cuerpo


async def confirmar_etapa(update, chat, post, memoria=None):
    """Confirmar: proponer + confirmar en el servidor. Devuelve la respuesta del
    confirmar (o None). `post` es SINCRONA. `memoria` (el `_memoria` del bot)
    recibe la propuesta para que el aviso al aprobador la lleve."""
    s = sesion(chat)
    decir = update.effective_message.reply_text
    if not s or s.get("modo") != "resumen":
        await decir("No tengo ninguna etapa de lote por confirmar.")
        return None
    texto_resumen = resumen(s)
    estado, r = await asyncio.to_thread(post, RUTA_ETAPA_PROPONER, cuerpo_de_propuesta(s, chat))
    if estado != 200 or not r.get("ok"):
        olvidar(chat)
        await decir(r.get("error", "No pude proponerlo. No se escribio nada."))
        return None
    olvidar(chat)
    if memoria is not None:
        memoria[chat] = {"tipo": "lote_etapa", "borrador_id": r["borrador_id"], "sello": r["sello"],
                         "mostrado": (r["borrador_id"], texto_resumen, None)}
    estado, r2 = await asyncio.to_thread(post, RUTA_ETAPA_CONFIRMAR, {
        "telegram_id": chat, "borrador_id": r["borrador_id"], "sello": r["sello"]})
    if estado != 200 or not r2.get("ok"):
        if memoria is not None and not r2.get("espera_aprobacion"):
            memoria.pop(chat, None)
        await decir(r2.get("error", "No pude escribirlo. No se escribio nada."))
        return r2
    if memoria is not None:
        memoria.pop(chat, None)
    await decir(r2.get("mensaje") or "Listo.")
    if r2.get("etapa") == "destilacion" and r2.get("id_lote"):
        await pedir_muestra(update, post, r2["id_lote"], r2.get("codigo_lote") or s["codigo"])
    return r2


async def pedir_muestra(update, post, id_lote, codigo):
    """Al confirmar la destilacion: "guarda una muestra" con su boton. Se
    reclama en la base: si el latido ya la mando, no sale dos veces."""
    if not await asyncio.to_thread(reclamar, post, id_lote, "muestra"):
        return False
    lote = {"id": id_lote, "codigo_lote": codigo}
    etiqueta, data = boton_de(lote, "muestra")
    await update.effective_message.reply_text(mensaje_de(lote, "muestra", {}), reply_markup=_teclado(etiqueta, data))
    await asyncio.to_thread(marcar_entregado, post, id_lote, "muestra")
    return True


async def muestra_guardada(update, chat, post, id_lote):
    estado, r = await asyncio.to_thread(post, RUTA_CICLO, {"accion": "muestra", "telegram_id": chat, "id_lote": id_lote})
    await update.effective_message.reply_text(
        (r or {}).get("mensaje") if estado == 200 and (r or {}).get("ok") else (r or {}).get("error", "No pude anotarlo."))
    return estado == 200 and bool((r or {}).get("ok"))
