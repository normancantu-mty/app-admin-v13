# -*- coding: utf-8 -*-
"""Suscripciones: la pregunta de cada mes y el comando /suscripciones.

Escrito el 2026-11-09 por el Socio (ejecutor). Norman, por voz: "crea una nueva
categoria que se llame Suscripciones y que me pregunte cada mes si ya se
aprobaron, si ya se hicieron".

  * `tick(bot, post)` cuelga del latido de 15 min del bot (igual que
    `lote_ciclo.tick`). Pide al servidor las preguntas que tocan HOY, RECLAMA
    cada una en la base (la fila `suscripcion_meses (id, mes)`: gana UNA vez) y
    solo entonces la manda, **solo al chat privado de Norman**. Un reinicio no
    la repite: el estado vive en la base, no aqui. Si el envio a Telegram falla,
    la suelta (`soltar`) y el siguiente latido la reintenta.
  * Botones: "Ya se pago" -> tarjeta con el monto del catalogo y [Registrar]
    [Otro monto]; "Todavia no" -> vuelve a preguntar en 3 dias; "Ya no la
    tengo" -> la suscripcion queda inactiva (se reactiva en el ERP).
  * Lo unico que vive en RAM es "estoy esperando el monto que vas a escribir"
    (`esperando`). Si el bot se reinicia a media espera, se pierde la espera,
    no el mes: la pregunta sigue en /suscripciones como pendiente.

Ronda 2 (auditoria 2026-11-09):
  * Tras mandar la pregunta se avisa `entregado` con el message_id. Una
    PREGUNTADA sin ese id y de hace 6+ h (el bot murio entre el reclamo y el
    envio) el servidor la ofrece UNA vez mas ('reenvio').
  * El servidor tambien ofrece los "Todavia no" de meses ANTERIORES: los
    botones llevan el mes de la fila, no el de hoy.
  * Si ya hay un egreso de Suscripciones de ese mes que la menciona (capturado
    en la web o como gasto del bot): [Es este: ligarlo] (`suslg`, no escribe
    egreso) / [No, registrar otro] (`susnv`). Lo que sigue a "registrar otro"
    lleva la marca `:n` en el boton (o en `esperando`) y paga con `forzar_nuevo`.
  * El monto esperado tambien llega por NOTA DE VOZ: `bot_gastos` llama a
    `atender_texto` desde `_enrutar_y_despachar`, por donde entra la voz.

El servidor vuelve a exigir que quien escribe sea Norman; aqui se filtra antes
para no mandar nada.

`post(ruta, cuerpo)` es SINCRONA (la del bot) y se inyecta: asi se prueba.
"""
import asyncio
import logging
import re

from telegram import InlineKeyboardButton, InlineKeyboardMarkup

log = logging.getLogger("bot_gastos")

RUTA = "/api/bot/suscripciones"

# El mismo numero que `bot_gastos.NORMAN_TELEGRAM_ID` y `lib/bot-permisos.ts`.
# Aqui se repite para no importar bot_gastos (import circular); probar_suscripciones
# verifica que los dos coincidan.
NORMAN_TELEGRAM_ID = 6571822622

ACCIONES = ("suspg", "susok", "susmt", "susno", "susbj", "suslg", "susnv")

YA_SE_PAGO = "Ya se pagó"
TODAVIA_NO = "Todavía no"
YA_NO_LA_TENGO = "Ya no la tengo"
REGISTRAR_OTRO = "No, registrar otro"

# chat -> (id_suscripcion, mes, forzar_nuevo): Norman toco "Otro monto" (o es
# USD) y falta el numero. `forzar_nuevo` = ya dijo "registrar otro".
esperando = {}


def _persona(chat):
    return chat[1] if isinstance(chat, (tuple, list)) else chat


def es_norman(chat):
    try:
        return int(_persona(chat)) == int(NORMAN_TELEGRAM_ID)
    except (TypeError, ValueError):
        return False


def teclado_pregunta(id_sus, mes):
    base = "%d:%s" % (int(id_sus), mes)
    return InlineKeyboardMarkup([
        [InlineKeyboardButton(YA_SE_PAGO, callback_data="suspg:" + base)],
        [InlineKeyboardButton(TODAVIA_NO, callback_data="susno:" + base),
         InlineKeyboardButton(YA_NO_LA_TENGO, callback_data="susbj:" + base)],
    ])


def teclado_registrar(id_sus, mes, monto, monto_texto, forzar=False):
    base = "%d:%s" % (int(id_sus), mes)
    marca = ":n" if forzar else ""
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("Registrar " + monto_texto, callback_data="susok:%s:%.2f%s" % (base, float(monto), marca))],
        [InlineKeyboardButton("Otro monto", callback_data="susmt:" + base + marca)],
    ])


def teclado_candidatos(id_sus, mes, candidatos):
    """[Es este: ligarlo] por egreso que ya la menciona + [No, registrar otro]."""
    base = "%d:%s" % (int(id_sus), mes)
    filas = []
    for c in (candidatos or [])[:3]:
        try:
            datos = "suslg:%s:%s" % (base, str(c["id"]))
        except (KeyError, TypeError):
            continue
        if len(datos.encode("utf-8")) > 64:
            continue
        etiqueta = "Es este: ligarlo"
        if len(candidatos) > 1:
            etiqueta += " (%s %s)" % (c.get("monto_texto", ""), c.get("fecha", ""))
        filas.append([InlineKeyboardButton(etiqueta, callback_data=datos)])
    filas.append([InlineKeyboardButton(REGISTRAR_OTRO, callback_data="susnv:" + base)])
    return InlineKeyboardMarkup(filas)


def texto_candidatos(nombre, mes, candidatos):
    lineas = ["Ya hay un egreso de Suscripciones de %s que menciona %s:" % (mes, nombre)]
    for c in (candidatos or [])[:3]:
        lineas.append("\u2022 %s del %s \u2014 %s" % (c.get("monto_texto", ""), c.get("fecha", ""), c.get("descripcion", "")))
    lineas.append("\u00bfEs ese el pago? Si lo ligo, no escribo otro egreso.")
    return "\n".join(lineas)


def teclado_pendientes(pendientes):
    filas = []
    for p in pendientes or []:
        try:
            datos = "suspg:%d:%s" % (int(p["id"]), p["mes"])
        except (KeyError, TypeError, ValueError):
            continue
        filas.append([InlineKeyboardButton(YA_SE_PAGO + ": " + str(p.get("nombre", ""))[:40], callback_data=datos)])
    return InlineKeyboardMarkup(filas) if filas else None


_PALABRAS_DE_MONEDA = re.compile(r"\b(pesos|peso|mxn|m\.n\.|mn)\b")


def leer_monto(texto):
    """'$3,800.50 pesos' -> 3800.5. None si no es un numero. **Pura.**

    Ronda 2: acepta como lo dicta Whisper y como se escribe rapido: "480.",
    "480 MXN.", "$480", "$ 480", "480 pesos.", "4,100.50", y "480,50" (coma
    decimal). Lo que no es SOLO un monto sigue siendo None."""
    t = str(texto or "").lower().replace("$", " ")
    t = _PALABRAS_DE_MONEDA.sub(" ", t)
    t = t.strip().rstrip(".!\u00a1?\u00bf ").strip()
    t = re.sub(r"\s+", "", t)
    if re.fullmatch(r"\d{1,3}(,\d{3})+(\.\d{1,2})?", t):
        t = t.replace(",", "")
    elif re.fullmatch(r"\d+,\d{1,2}", t):
        t = t.replace(",", ".")
    if not re.fullmatch(r"\d+(\.\d{1,2})?", t):
        return None
    n = float(t)
    return n if n > 0 else None


async def _llamar(post, cuerpo):
    estado, r = await asyncio.to_thread(post, RUTA, cuerpo)
    return estado, (r if isinstance(r, dict) else {})


# ── el latido ────────────────────────────────────────────────────────────────

async def tick(bot, post):
    """Una vuelta: devuelve cuantas preguntas salieron."""
    estado, r = await _llamar(post, {"accion": "leer"})
    if estado != 200 or not r.get("ok"):
        log.warning("suscripciones: no pude leer (%s): %s", estado, r.get("error"))
        return 0
    enviadas = 0
    for p in r.get("preguntas") or []:
        try:
            id_sus, mes, tipo = int(p["id_suscripcion"]), str(p["mes"]), str(p["tipo"])
        except (KeyError, TypeError, ValueError):
            continue
        est, rr = await _llamar(post, {"accion": "reclamar", "id_suscripcion": id_sus, "mes": mes, "tipo": tipo})
        if est != 200 or not rr.get("reclamado"):
            continue  # otro latido (u otro proceso) ya la mando
        try:
            # SOLO a Norman, por privado: el destino no lo decide el servidor.
            msg = await bot.send_message(NORMAN_TELEGRAM_ID, p.get("texto") or ("Suscripcion " + mes),
                                         reply_markup=teclado_pregunta(id_sus, mes))
            enviadas += 1
            log.info("suscripciones: pregunta %s %s (%s) enviada", id_sus, mes, tipo)
        except Exception as e:
            log.warning("suscripciones: no salio la pregunta %s %s: %s: %s", id_sus, mes, type(e).__name__, e)
            await _llamar(post, {"accion": "soltar", "id_suscripcion": id_sus, "mes": mes})
            continue
        # Constancia de que SI salio. Sin ella, a las 6 h el servidor la ofrece
        # UNA vez mas (por si el bot murio entre el reclamo y el envio).
        id_mensaje = getattr(msg, "message_id", None)
        if isinstance(id_mensaje, int):
            try:
                await _llamar(post, {"accion": "entregado", "id_suscripcion": id_sus, "mes": mes, "id_mensaje": id_mensaje})
            except Exception as e:
                log.warning("suscripciones: no pude marcar entregada %s %s: %s", id_sus, mes, e)
    return enviadas


# ── los botones ──────────────────────────────────────────────────────────────

async def atender_boton(update, chat, datos, post):
    """True si el boton era de suscripciones (lo haya resuelto o no)."""
    partes = str(datos or "").split(":")
    accion = partes[0]
    if accion not in ACCIONES:
        return False
    responder = update.effective_message.reply_text
    if not es_norman(chat):
        log.info("boton ajeno: %s apreto %s (suscripciones)", _persona(chat), accion)
        await responder("Las suscripciones las marca Norman. Tu clic no escribio nada.")
        return True
    try:
        id_sus, mes = int(partes[1]), partes[2]
    except (IndexError, ValueError):
        await responder("Ese boton ya no sirve. Usa /suscripciones.")
        return True
    base = {"telegram_id": chat, "id_suscripcion": id_sus, "mes": mes}

    if accion in ("suspg", "susnv"):
        # "susnv" = "No, registrar otro": la misma propuesta sin candidatos, y
        # todo lo que siga lleva forzar_nuevo.
        await _proponer(responder, post, base, chat, accion == "susnv")
    elif accion == "suslg":
        if len(partes) < 4 or not partes[3]:
            await responder("Ese boton ya no sirve. Usa /suscripciones.")
            return True
        est, r = await _llamar(post, dict(base, accion="ligar", id_movimiento=partes[3]))
        await responder(r.get("texto") or r.get("error", "No pude ligarla."))
    elif accion == "susok":
        try:
            monto = float(partes[3])
        except (IndexError, ValueError):
            await responder("Ese boton ya no sirve. Usa /suscripciones.")
            return True
        await _pagar(responder, post, base, monto, forzar=len(partes) > 4 and partes[4] == "n")
    elif accion == "susmt":
        esperando[chat] = (id_sus, mes, len(partes) > 3 and partes[3] == "n")
        await responder("\u00bfDe cuanto fue? Solo el numero, en pesos.")
    elif accion == "susno":
        est, r = await _llamar(post, dict(base, accion="posponer"))
        await responder(r.get("texto") or r.get("error", "No pude posponerla."))
    elif accion == "susbj":
        est, r = await _llamar(post, dict(base, accion="baja"))
        await responder(r.get("texto") or r.get("error", "No pude darla de baja."))
    return True


async def _proponer(responder, post, base, chat, forzar):
    cuerpo = dict(base, accion="proponer_pago")
    if forzar:
        cuerpo["ignorar_candidatos"] = True
    id_sus, mes = base["id_suscripcion"], base["mes"]
    est, r = await _llamar(post, cuerpo)
    if est != 200 or not r.get("ok"):
        await responder(r.get("error", "No pude leerla."))
    elif r.get("ya_pagada"):
        await responder("La de %s de %s ya estaba registrada como pagada." % (r.get("nombre", ""), mes))
    elif r.get("candidatos"):
        await responder(texto_candidatos(r.get("nombre", ""), mes, r["candidatos"]),
                        reply_markup=teclado_candidatos(id_sus, mes, r["candidatos"]))
    elif r.get("pide_pesos"):
        esperando[chat] = (id_sus, mes, bool(forzar))
        await responder("%s esta en %s. \u00bfCuantos PESOS se cobraron? Solo el numero."
                        % (r.get("nombre", ""), r.get("monto_catalogo", "USD")))
    else:
        texto = ("Registro %s de %s como egreso Suscripciones, cuenta %s."
                 % (r["monto_texto"], r.get("nombre", ""), r.get("cuenta", "")))
        if r.get("aviso_cuenta"):
            texto += "\n" + r["aviso_cuenta"]
        await responder(texto, reply_markup=teclado_registrar(id_sus, mes, r["monto"], r["monto_texto"], forzar=forzar))


async def _pagar(responder, post, base, monto, forzar=False):
    cuerpo = dict(base, accion="pagar", monto=round(float(monto), 2))
    if forzar:
        cuerpo["forzar_nuevo"] = True
    est, r = await _llamar(post, cuerpo)
    if est == 200 and r.get("ok"):
        await responder(r.get("texto") or "Registrado.")
    elif r.get("duplicado_posible") and r.get("candidatos"):
        # Aparecio un egreso que ya la menciona entre la tarjeta y el toque.
        await responder(texto_candidatos(r.get("nombre", ""), base["mes"], r["candidatos"]),
                        reply_markup=teclado_candidatos(base["id_suscripcion"], base["mes"], r["candidatos"]))
    else:
        await responder(r.get("error", "No pude registrarla."))


# ── el monto escrito ─────────────────────────────────────────────────────────

async def atender_texto(update, chat, texto, post):
    """True si el texto era el monto que se estaba esperando (o lo cancelo).
    Cualquier otra cosa suelta la espera y sigue el camino normal del bot."""
    pend = esperando.pop(chat, None)
    if not pend:
        return False
    responder = update.effective_message.reply_text
    if str(texto or "").strip().lower() in ("no", "cancela", "cancelar"):
        await responder("Va, no registro nada. Sigue pendiente en /suscripciones.")
        return True
    monto = leer_monto(texto)
    if monto is None:
        return False
    id_sus, mes = pend[0], pend[1]
    forzar = bool(pend[2]) if len(pend) > 2 else False
    await _pagar(responder, post, {"telegram_id": chat, "id_suscripcion": id_sus, "mes": mes}, monto, forzar=forzar)
    return True


# ── /suscripciones ───────────────────────────────────────────────────────────

def respuesta_de_lista(estado, r, en_grupo):
    """(texto, teclado, r) del comando. **Pura.** Los botones solo en privado."""
    if estado != 200 or not isinstance(r, dict) or not r.get("ok"):
        return (r or {}).get("error", "No pude consultarlo.") if isinstance(r, dict) else "No pude consultarlo.", None, None
    teclado = None if en_grupo else teclado_pendientes(r.get("pendientes"))
    return r.get("texto", ""), teclado, r
